"""The scheduled run: notice a new bundle, verify it, commit each half on its own.

Run as `python -m scripts.atlas` on a GitHub runner by `.github/workflows/atlas.yml`. It holds
no AWS credential and no secret: the bundle is public and read over plain HTTPS, and the commit
uses the workflow's own `GITHUB_TOKEN`. That is not a preference -- GitHub OIDC is denied in
this account (measured 2026-10-22: `iam:CreateOpenIDConnectProvider` refused by an organisation
SCP), so the workflow cannot hold an AWS credential at all.

The reuse semantics, kept from the reference implementation on `fix/pages-split` (2c1c035):
when the bundle's `snapshot_day` is not later than the day the checkout already serves, this run
prints exactly one line naming what it compared and the published day, commits nothing, and
leaves `site/data/world.json` byte-for-byte unchanged. Nothing anywhere records a fresher
capture than the snapshot it came from.

The two halves are committed independently, client first: the client half has nothing to do with
the world, and from 2026-10-19 to 2026-10-22 a dead map capture froze it for three days, so its
commit cannot sit behind the map half's success.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

if __package__ in (None, ""):  # `python scripts/atlas/cli.py` should work too
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.atlas import bundle, contract, publish  # noqa: E402
from scripts.atlas.config import ConfigError, Settings  # noqa: E402


class RunSummary:
    """What the run did, in terms a log line and a test can both read."""

    def __init__(self):
        self.fetched = False
        self.taken_at = ""
        self.map_action = ""          # committed | reused | absent | failed | would-commit
        self.client_action = ""
        self.map_line = ""
        self.client_line = ""
        self.failures = []

    def as_dict(self):
        return {"fetched": self.fetched, "takenAt": self.taken_at,
                "map": self.map_action, "client": self.client_action,
                "failures": self.failures}


def run(settings, *, api=None, log=print, halves=("client", "map"), dry_run=False,
        fetcher=None):
    """Fetch, verify, then commit each half in its own failure domain."""
    summary = RunSummary()
    fetcher = fetcher or bundle.read
    try:
        fetched = fetcher(settings, log=log)
    except bundle.NothingPublishedYet as error:
        # Not a failure: the pipeline has not published anything yet. Said in one line, with
        # nothing committed and nothing recorded as broken.
        log(f"atlas: nothing to do -- no bundle has been published yet ({error})")
        return summary
    except bundle.BundleError as error:
        summary.failures.append(f"fetch: {error}")
        log(f"atlas: FAILED to fetch the bundle: {error}")
        return summary
    summary.fetched = True
    summary.taken_at = fetched.taken_at
    try:
        newer, why = bundle.is_newer(fetched, settings.repo_root)
    except bundle.BundleError as error:
        summary.failures.append(f"bundle: {error}")
        log(f"atlas: FAILED to read the bundle: {error}")
        return summary
    if not newer:
        summary.map_action = "reused" if fetched.map is not None else "absent"
        summary.client_action = "reused" if fetched.client is not None else "absent"
        summary.map_line = (
            f"atlas: nothing to publish -- the published site already carries this bundle; "
            f"the published snapshot stands (snapshot_day "
            f"{bundle.published_day(settings.repo_root)}), bundle takenAt "
            f"{fetched.taken_at}: {why}")
        log(summary.map_line)
        return summary

    api = api or publish.GitHubAPI(settings.github_token, settings.repository, log=log)
    for name in halves:
        half = getattr(fetched, name)
        if half is None:
            setattr(summary, f"{name}_action", "absent")
            continue
        try:
            written = bundle.apply(fetched, settings.repo_root, only=name, log=log)
            if dry_run:
                setattr(summary, f"{name}_action", "would-commit")
                line = f"atlas: {name} half: would commit {len(written)} path(s) (dry run)"
            else:
                result = _commit(api, settings, name, fetched, log=log)
                setattr(summary, f"{name}_action", "committed" if result.committed else "reused")
                line = result.line
        except Exception as error:  # noqa: BLE001 - this half's own failure domain
            summary.failures.append(f"{name} half: {error}")
            setattr(summary, f"{name}_action", "failed")
            line = f"atlas: {name} half FAILED: {error}"
        setattr(summary, f"{name}_line", line)
        log(line)
    return summary


def _commit(api, settings, name, fetched, log=print):
    paths = contract.CLIENT_PATHS if name == "client" else contract.MAP_PATHS
    message = (contract.CLIENT_COMMIT_MESSAGE if name == "client"
               else contract.MAP_COMMIT_MESSAGE.format(snapshot_day=fetched.snapshot_day))
    half = publish.Half(name=name, paths=paths, staging=Path(settings.repo_root),
                        message=message)
    return publish.publish(api, half, branch=settings.branch, log=log)


def main(argv=None, environ=None, log=print):
    parser = argparse.ArgumentParser(
        prog="python -m scripts.atlas",
        description="Publish the atlas bundle the AWS half left in the bucket.")
    parser.add_argument("--client-only", action="store_true")
    parser.add_argument("--map-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and verify, and say what would be committed")
    parser.add_argument("--summary", type=Path, default=None)
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
    summary = run(settings, log=log, halves=halves, dry_run=args.dry_run)
    if args.summary:
        args.summary.write_text(json.dumps(summary.as_dict(), indent=2) + "\n", encoding="utf8")
    log("atlas: summary " + json.dumps(summary.as_dict(), sort_keys=True))
    return 1 if summary.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
