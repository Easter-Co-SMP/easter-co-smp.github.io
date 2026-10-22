"""The pipeline, in the order the ticket asks for: changed? capture? publish?

Run as `python -m scripts.atlas` on a GitHub runner. Every external system is passed in, so
the whole thing runs against stubs in `tests/test_atlas_pipeline.py` and against the real
APIs in the workflow with no code difference between the two.

The order, and why it is this order:

1. **The client half.** It does not depend on the world at all, and from 2026-10-19 to
   2026-10-22 a dead map capture took it down with it, so it publishes first, in its own
   failure domain, as its own commit.
2. **Question one: has the world changed?** Two reads (the pointer, one `DescribeInstances`)
   and no action. Unchanged prints exactly one line naming what was compared and the
   published `snapshot_day`, and this run makes no other call at all.
3. **Question two: capture.** Wake, wait for the server to be genuinely ready, run the
   committed snapshot script over SSM, confirm the upload, render, build the document, and
   see the instance stopped again on every exit path. The pointer advances only after the
   publication succeeded, so a failed publication does not lose a capture.
4. **Question three: publish the map half** -- only when those bytes differ from what is
   published.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

if __package__ in (None, ""):  # `python scripts/atlas/cli.py` should work too
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.atlas import capture as capture_module  # noqa: E402
from scripts.atlas import change, client, contract, host, publish, render, worldjson  # noqa: E402
from scripts.atlas.config import ConfigError, Settings  # noqa: E402


@dataclass
class RunSummary:
    """What happened, in terms a log and a test can both read."""

    client_committed: bool = False
    client_changed: list = field(default_factory=list)
    client_line: str = ""
    map_action: str = ""            # unchanged | deferred | captured | forced | skipped
    map_line: str = ""
    map_committed: bool = False
    pointer_written: bool = False
    tiles: int = 0
    render_wall_seconds: float = 0.0
    failures: list = field(default_factory=list)

    def as_dict(self):
        return {
            "client_committed": self.client_committed,
            "client_changed": self.client_changed,
            "map_action": self.map_action,
            "map_committed": self.map_committed,
            "pointer_written": self.pointer_written,
            "tiles": self.tiles,
            "render_wall_seconds": round(self.render_wall_seconds, 1),
            "failures": self.failures,
        }


def _utcnow():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Pipeline:
    """One run. Holds the settings and the four clients; every method is a small step."""

    def __init__(self, settings, *, ec2, s3, ssm, github, log=print, dry_run=False,
                 force_capture=False):
        self.settings = settings
        self.force_capture = force_capture
        self.ec2 = ec2
        self.s3 = s3
        self.ssm = ssm
        self.github = github
        self.log = log
        self.dry_run = dry_run
        self.summary = RunSummary()

    # ── the two halves ───────────────────────────────────────────────────────────────
    def publish_client_half(self, workdir):
        self.summary.map_action = self.summary.map_action or ""
        try:
            built = client.build(self.settings.repo_root, workdir / "client", log=self.log)
            self.summary.client_changed = list(built.changed)
            if not built.has_changes:
                self.summary.client_line = f"atlas: client half: {built.note}"
                self.log(self.summary.client_line)
                return
            _composed_check(self.settings.repo_root, workdir / "client", "client")
            client.publish_files(workdir / "client", self.settings.repo_root, built.staged)
            if self.dry_run:
                self.summary.client_line = (f"atlas: client half: would commit "
                                            f"{len(built.changed)} path(s) (dry run)")
                self.log(self.summary.client_line)
                return
            half = publish.Half(name="client", paths=contract.CLIENT_PATHS,
                                staging=Path(self.settings.repo_root),
                                message=contract.CLIENT_COMMIT_MESSAGE)
            result = publish.publish(self.github, half, log=self.log)
            self.summary.client_committed = result.committed
            self.summary.client_line = result.line
        except Exception as error:  # noqa: BLE001 - this half's own failure domain
            self.summary.failures.append(f"client half: {error}")
            self.log(f"atlas: client half FAILED: {error}")

    def publish_map_half(self, workdir):
        try:
            self._map_half(workdir)
        except Exception as error:  # noqa: BLE001 - this half's own failure domain
            self.summary.failures.append(f"map half: {error}")
            self.log(f"atlas: map half FAILED: {error}")

    # ── the three questions ──────────────────────────────────────────────────────────
    def _map_half(self, workdir):
        force_capture = self.force_capture
        decision = change.detect(self.ec2, self.s3, self.settings)
        self.summary.map_action = decision.action
        if decision.action == "unchanged" and not force_capture:
            published_day = _published_day(self.settings.repo_root)
            self.summary.map_line = (
                f"atlas: map reuse -- the published snapshot stands (snapshot_day "
                f"{published_day}); nothing was captured: {decision.line}")
            self.log(self.summary.map_line)
            return
        if decision.action == "defer" and not force_capture:
            self.summary.map_line = (
                f"atlas: map deferred -- nothing captured and nothing stopped: {decision.line}")
            self.log(self.summary.map_line)
            return

        self.log(f"atlas: {decision.line}")
        facts = host.HostCapture(self.ec2, self.ssm, self.s3, self.settings,
                                 log=self.log).capture()
        snapshot = capture_module.open_snapshot(self.s3, self.settings, workdir / "snapshot",
                                                log=self.log)
        staging = workdir / "map"
        rendered = render.render_all(snapshot, staging / "site/data/tiles",
                                     workers=self.settings.render_workers, log=self.log)
        coverage = render.coverage_metadata(snapshot, snapshot.cache_dir)
        document = worldjson.build(tiles=rendered.tiles, coverage=coverage,
                                  captured_at=snapshot.captured_at,
                                  previous_document=_published_document(self.settings.repo_root),
                                  snapshot=snapshot, policy=self.settings.marker_policy,
                                  log=self.log)
        worldjson.write(document, staging / "site/data/world.json")
        self.summary.tiles = len(document["tiles"])
        self.summary.render_wall_seconds = rendered.wall_seconds
        self.log(f"atlas: built the world document for {document['snapshot_day']} with "
                 f"{len(document['tiles'])} tile(s), {len(document['regions'])} region(s) and "
                 f"{len(document['markers'])} marker(s)")
        _composed_check(self.settings.repo_root, staging, "map")

        changed = _apply_map(self.settings.repo_root, staging, log=self.log)
        half = publish.Half(name="map", paths=contract.MAP_PATHS,
                            staging=staging,
                            message=contract.MAP_COMMIT_MESSAGE.format(
                                snapshot_id=contract.snapshot_id(
                                    snapshot.captured_at, facts.launch_time or "unknown")),
                            delete=tuple(changed["delete"]))
        if self.dry_run:
            self.summary.map_line = (f"atlas: map half: would commit {len(changed['write'])} "
                                     "path(s) (dry run)")
            self.log(self.summary.map_line)
            return
        result = publish.publish(self.github, half, log=self.log)
        self.summary.map_committed = result.committed
        self.summary.map_line = result.line
        self.summary.map_action = "forced" if force_capture else "captured"
        self._advance_pointer(facts, snapshot, document)

    def _advance_pointer(self, facts, snapshot, document):
        """Record the capture, after the publication. Never before: a lost capture is
        recoverable, a pointer that skips a capture is not."""
        pointer = contract.pointer_document(
            captured_at=snapshot.captured_at,
            published_at=_utcnow(),
            instance_id=facts.instance_id,
            launch_time=facts.launch_time,
            state_transition_at=facts.state_transition_at,
            state_transition_reason=facts.state_transition_reason,
            tar_key=self.settings.snapshot_key,
            tar_sha256=snapshot.tar_sha256,
            tar_bytes=facts.tar_bytes or snapshot.sidecar.get("tar_bytes") or 0,
            region_files=int(snapshot.manifest.get("region_files")
                             or snapshot.sidecar.get("region_files") or 0),
            nonempty_regions=len(document["tiles"]),
            tiles=len(document["tiles"]),
            position_source=document["position_source"],
        )
        self.s3.put_object(Bucket=self.settings.bucket, Key=self.settings.pointer_key,
                           Body=json.dumps(pointer, indent=2).encode("utf8"),
                           ContentType="application/json")
        self.summary.pointer_written = True
        self.log(f"atlas: pointer advanced at s3://{self.settings.bucket}/"
                 f"{self.settings.pointer_key} for capture {pointer['snapshot_id']} "
                 "(the next run compares against these EC2 facts)")


def run(settings, *, ec2, s3, ssm, github, log=print, force_capture=False,
        halves=("client", "map"), dry_run=False, workdir=None):
    """The whole pipeline. Returns the summary; a failed half is in `summary.failures`."""
    pipeline = Pipeline(settings, ec2=ec2, s3=s3, ssm=ssm, github=github, log=log,
                        dry_run=dry_run, force_capture=force_capture)
    temporary = None
    if workdir is None:
        temporary = tempfile.TemporaryDirectory(prefix="atlas-")
        workdir = Path(temporary.name)
    workdir = Path(workdir)
    try:
        if "client" in halves:
            pipeline.publish_client_half(workdir)
        else:
            pipeline.summary.map_action = "skipped"
        if "map" in halves:
            pipeline.publish_map_half(workdir)
    finally:
        if temporary is not None:
            temporary.cleanup()
    return pipeline.summary


def _published_document(repo_root):
    try:
        return json.loads((Path(repo_root) / "site/data/world.json").read_text(encoding="utf8"))
    except (OSError, ValueError):
        return None


def _published_day(repo_root):
    document = _published_document(repo_root)
    return None if document is None else document.get("snapshot_day")


def _composed_check(repo_root, staging, half):
    """Run the repository's own validator over both halves: the staged one and the published one.

    A green pipeline that publishes something `scripts/validate.py` refuses would fail the
    site gate afterwards, so the gate runs here, on the exact bytes about to be committed.
    The other half is taken from the checkout, which is what the publication will leave in
    place, so the pair being validated is the pair that will exist.
    """
    from scripts.validate import validate_data  # noqa: PLC0415 - keep the import off the module path

    repo_root, staging = Path(repo_root), Path(staging)
    with tempfile.TemporaryDirectory(prefix="atlas-check-") as temporary:
        root = Path(temporary) / "site"
        (root / "data").mkdir(parents=True)
        if half == "map":
            sources = [("data/world.json", staging / "site/data/world.json"),
                       ("data/tiles", staging / "site/data/tiles"),
                       ("data/client.json", repo_root / "site/data/client.json"),
                       ("downloads", repo_root / "site/downloads")]
        else:
            sources = [("data/world.json", repo_root / "site/data/world.json"),
                       ("data/tiles", repo_root / "site/data/tiles"),
                       ("data/client.json", staging / "data/client.json"),
                       ("downloads", staging / "downloads")]
        for relative, source in sources:
            target = root / relative
            if not source.exists():
                raise worldjson.WorldDocumentError(
                    f"cannot validate the {half} half: {source} does not exist")
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        validate_data(root)


def _apply_map(repo_root, staging, log=print):
    """Copy the staged map half into the checkout; report what changed and what is stale."""
    repo_root, staging = Path(repo_root), Path(staging)
    written, delete = [], []
    for relative in ("site/data/world.json", "site/data/tiles"):
        source, target = staging / relative, repo_root / relative
        if not source.exists():
            raise worldjson.WorldDocumentError(f"the staged map half is missing {source}")
        if source.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(source, target)
            written.extend(f"{relative}/{path.relative_to(target).as_posix()}"
                           for path in sorted(target.rglob("*")) if path.is_file())
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            written.append(relative)
    wanted = {f"site/data/tiles/{path.parent.name}/{path.name}"
              for path in (staging / "site/data/tiles").glob("*/*.png")}
    published_tiles = repo_root / "site/data/tiles"
    if published_tiles.exists():
        for path in sorted(published_tiles.glob("*/*.png")):
            relative = f"site/data/tiles/{path.parent.name}/{path.name}"
            if relative not in wanted:
                path.unlink()
                delete.append(relative)
    log(f"atlas: map half applied to the checkout: {len(written)} path(s) written"
        + (f", {len(delete)} stale tile(s) removed" if delete else ""))
    return {"write": written, "delete": delete}


def build_clients(settings):
    """The real AWS clients; imported here so tests never need boto3 installed."""
    import boto3  # noqa: PLC0415 - only a real run needs the SDK

    session = boto3.session.Session(region_name=settings.region)
    return (session.client("ec2"), session.client("s3"), session.client("ssm"))


def main(argv=None, environ=None, log=print):
    parser = argparse.ArgumentParser(
        prog="python -m scripts.atlas",
        description="Publish the atlas: the client manifest, then the world if EC2 says it "
                    "changed.")
    parser.add_argument("--client-only", action="store_true", help="publish only the client half")
    parser.add_argument("--map-only", action="store_true", help="publish only the map half")
    parser.add_argument("--force-capture", action="store_true",
                        help="capture even when change detection says the world is unchanged")
    parser.add_argument("--dry-run", action="store_true",
                        help="do everything except commit and advance the pointer")
    parser.add_argument("--summary", type=Path, default=None,
                        help="write the run summary as JSON to this path")
    args = parser.parse_args(argv)
    environ = os.environ if environ is None else environ

    halves = ("client", "map")
    if args.client_only:
        halves = ("client",)
    if args.map_only:
        halves = ("map",)

    try:
        settings = Settings.from_env(environ)
    except ConfigError as error:
        log(f"atlas: FAILED before any work: {error}")
        return 2

    try:
        github = publish.GitHubAPI((environ.get("ATLAS_GITHUB_TOKEN") or "").strip(),
                                   _slug_from(environ),
                                   api_root=(environ.get("ATLAS_GITHUB_API")
                                             or publish.API_ROOT).strip(),
                                   log=log)
    except publish.PublishError as error:
        log(f"atlas: FAILED: {error}")
        return 2

    try:
        ec2, s3, ssm = build_clients(settings)
    except Exception as error:  # noqa: BLE001 - no credentials is a named refusal
        log(f"atlas: FAILED: the AWS clients could not be built: {error}")
        return 2

    summary = run(settings, ec2=ec2, s3=s3, ssm=ssm, github=github, log=log,
                  force_capture=args.force_capture, halves=halves, dry_run=args.dry_run)
    if args.summary:
        args.summary.write_text(json.dumps(summary.as_dict(), indent=2) + "\n", encoding="utf8")
    log("atlas: summary " + json.dumps(summary.as_dict(), sort_keys=True))
    return 1 if summary.failures else 0


def _slug_from(environ):
    slug = (environ.get("GITHUB_REPOSITORY") or "").strip()
    if not slug or slug.count("/") != 1:
        raise publish.PublishError(
            "GITHUB_REPOSITORY is not set to owner/repo; the GitHub API needs it")
    return slug


if __name__ == "__main__":
    raise SystemExit(main())
