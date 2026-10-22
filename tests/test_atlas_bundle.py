"""The thin committer, against a real HTTP server that serves a real bundle.

No AWS and no network beyond loopback, but the transport is real: urllib, real zip bytes, real
status codes. What is proven here is this half's whole job -- see one bundle, refuse a bad one,
commit each half on its own, and say in one line when there is nothing to do.

The bundle in these tests is built in the shape the Lambda publishes (see
`easter-co-cloud/pipeline/atlas/bundle.py`), so the wire between the two repositories is what is
being tested, not a fixture invented on this side.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
import zipfile

from scripts.atlas import bundle, cli, contract
from scripts.atlas.config import Settings
from tests.atlas_github_stub import RecordingGitHub


def site_data():
    """The published tree in this checkout: the fixture every test starts from."""
    root = Path(__file__).resolve().parents[1]
    return root / "site"


def build_bundle(destination, *, document=None, tiles=None, client=None, jar=None,
                 snapshot_day="2026-10-23", taken_at="20261023T043000Z",
                 captured_at="2026-10-23T04:30:00+00:00", extra_member=None,
                 bad_world_hash=False, carry_map=True):
    """A publish document plus its zip, exactly as the AWS half writes them."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    site = site_data()
    world = document or json.loads((site / "data/world.json").read_text(encoding="utf8"))
    world = dict(world, snapshot_day=snapshot_day, captured_at=captured_at)
    tiles = tiles if tiles is not None else [(t["x"], t["z"]) for t in world["tiles"]]
    entries = {"data/world.json": json.dumps(world, indent=2, sort_keys=True).encode()}
    for x, z in tiles:
        source = site / f"data/tiles/{x}/{z}.png"
        if source.is_file():
            entries[f"data/tiles/{x}/{z}.png"] = source.read_bytes()
    client_half = None
    if client is not None:
        entries["data/client.json"] = json.dumps(client, indent=2, sort_keys=True).encode()
        files = []
        for name, blob in (jar or {}).items():
            entries[f"downloads/{name}"] = blob
            files.append({"path": f"downloads/{name}",
                          "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob)})
        client_half = {"document": client, "files": files}
    if extra_member:
        entries[extra_member[0]] = extra_member[1]
    zip_path = destination / f"tiles-{taken_at}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(entries):
            archive.writestr(name, entries[name])
    blob = zip_path.read_bytes()
    world_digest = hashlib.sha256(entries["data/world.json"]).hexdigest()
    if bad_world_hash:
        world_digest = "0" * 64
    map_half = None
    if carry_map:
        map_half = {"zip": f"publish/{zip_path.name}",
                    "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob),
                    "world_sha256": world_digest,
                    "world_bytes": len(entries["data/world.json"]), "tiles": len(tiles)}
    if client_half is not None:
        # Both halves travel in one zip, so whichever row exists names those bytes.
        zip_sha = hashlib.sha256(blob).hexdigest()
        client_half = dict(client_half, zip=f"publish/{zip_path.name}", sha256=zip_sha,
                           bytes=len(blob))
    document_out = {"schema": 1, "takenAt": taken_at, "snapshot_day": snapshot_day,
                    "captured_at": captured_at, "map": map_half, "client": client_half}
    return document_out, zip_path


def serve_files(directory):
    """A tiny static server: exactly the two objects a bundle is."""
    directory = Path(directory)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            name = self.path.lstrip("/")
            path = directory / name
            if not path.is_file():
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class BundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.mkdtemp(prefix="atlas-site-")
        self.addCleanup(shutil.rmtree, temporary, True)
        self.root = Path(temporary)
        # A throwaway copy of the published tree: these tests write to it.
        self.repo = self.root / "repo"
        (self.repo / "site").mkdir(parents=True)
        shutil.copytree(site_data() / "data", self.repo / "site/data")
        shutil.copytree(site_data() / "downloads", self.repo / "site/downloads")
        self.served = self.root / "served"
        self.served.mkdir()
        self.server = None
        self.logs = []

    def url(self):
        if self.server is None:
            self.server = serve_files(self.served)
            self.addCleanup(self.server.server_close)
            self.addCleanup(self.server.shutdown)
        return f"http://127.0.0.1:{self.server.server_port}"

    def publish(self, document, zip_path, name="latest.json"):
        if self.server is None:
            self.url()
        (self.served / name).write_text(json.dumps(document, indent=2))
        if zip_path is not None:
            shutil.copyfile(zip_path, self.served / zip_path.name)
        return f"{self.url()}/{name}"

    def settings(self, url):
        return Settings(publish_url=url, repository="owner/repo", github_token="test-token",
                        repo_root=self.repo, timeout_seconds=20)

    def fetcher(self, document, zip_path):
        url = self.publish(document, zip_path)
        settings = self.settings(url)

        def fetch(_settings, log=print):
            return bundle.read(settings, log=log)
        return fetch, settings

    # ── the reuse path: one line and nothing else ───────────────────────────────────
    def test_an_older_or_equal_snapshot_day_publishes_nothing(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-10-19")
        fetch, settings = self.fetcher(document, zip_path)
        before = (self.repo / "site/data/world.json").read_bytes()
        github = RecordingGitHub()
        summary = cli.run(settings, api=github, log=self.logs.append, fetcher=fetch)
        reuse = [line for line in self.logs if "nothing to publish" in line]
        self.assertEqual(len(reuse), 1, f"expected exactly one reuse line, got {self.logs}")
        self.assertIn("snapshot_day 2026-10-19", reuse[0])
        self.assertEqual(github.commits, [], "the reuse path committed something")
        self.assertEqual((self.repo / "site/data/world.json").read_bytes(), before)
        self.assertEqual(summary.map_action, "reused")
        self.assertEqual(summary.failures, [])

    def test_a_newer_snapshot_day_is_committed_and_the_world_document_is_rewritten(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-11-30")
        fetch, settings = self.fetcher(document, zip_path)
        github = RecordingGitHub()
        summary = cli.run(settings, api=github, log=self.logs.append, fetcher=fetch)
        self.assertEqual(summary.failures, [])
        self.assertEqual(summary.map_action, "committed")
        published = json.loads((self.repo / "site/data/world.json").read_text())
        self.assertEqual(published["snapshot_day"], "2026-11-30")
        self.assertEqual(len(github.commits), 1)
        self.assertIn("2026-11-30", github.commits[0]["message"])
        for path in github.commits[0]["changed"]:
            self.assertTrue(path.startswith("site/data/"), path)

    # ── two independent halves ─────────────────────────────────────────────────────
    def test_a_client_only_bundle_commits_the_client_half_alone(self):
        client = json.loads((site_data() / "data/client.json").read_text(encoding="utf8"))
        client = dict(client, deployment={"schema": 1, "serverAddress": "new.example:25565"})
        jar = {"easter-navy.jar": (site_data() / "downloads/easter-navy.jar").read_bytes()}
        document, zip_path = build_bundle(self.root / "b", client=client, jar=jar,
                                          carry_map=False)
        fetch, settings = self.fetcher(document, zip_path)
        github = RecordingGitHub()
        summary = cli.run(settings, api=github, log=self.logs.append, fetcher=fetch)
        self.assertEqual(summary.failures, [])
        self.assertEqual(summary.map_action, "absent")
        self.assertEqual(summary.client_action, "committed")
        self.assertEqual(len(github.commits), 1)
        self.assertEqual(github.commits[0]["message"], contract.CLIENT_COMMIT_MESSAGE)
        for path in github.commits[0]["changed"]:
            self.assertTrue(path.startswith(("site/data/client.json", "site/downloads/")), path)
        published_client = json.loads((self.repo / "site/data/client.json").read_text())
        self.assertEqual(published_client["deployment"]["serverAddress"], "new.example:25565")

    def test_a_map_bundle_that_also_carries_the_client_half_is_two_commits(self):
        client = json.loads((site_data() / "data/client.json").read_text(encoding="utf8"))
        client = dict(client, deployment={"schema": 1, "serverAddress": "two.example:25565"})
        jar = {"easter-navy.jar": (site_data() / "downloads/easter-navy.jar").read_bytes()}
        document, zip_path = build_bundle(self.root / "b", client=client, jar=jar,
                                         snapshot_day="2026-11-30")
        fetch, settings = self.fetcher(document, zip_path)
        github = RecordingGitHub()
        summary = cli.run(settings, api=github, log=self.logs.append, fetcher=fetch)
        self.assertEqual(summary.failures, [])
        self.assertEqual(len(github.commits), 2)
        self.assertEqual(github.commits[0]["message"], contract.CLIENT_COMMIT_MESSAGE)
        self.assertTrue(github.commits[1]["message"].startswith("Publish the atlas terrain"))
        for path in github.commits[0]["changed"]:
            self.assertTrue(path.startswith(("site/data/client.json", "site/downloads/")), path)
        for path in github.commits[1]["changed"]:
            self.assertTrue(path.startswith(("site/data/world.json", "site/data/tiles/")), path)

    def test_a_failing_client_half_does_not_stop_the_map_half(self):
        def explode(*_args, **_kwargs):
            raise RuntimeError("client publication refused")
        client = json.loads((site_data() / "data/client.json").read_text(encoding="utf8"))
        document, zip_path = build_bundle(self.root / "b",
                                         client=dict(client, deployment={
                                             "schema": 1, "serverAddress": "x.example:25565"}),
                                         jar={"easter-navy.jar":
                                              (site_data() / "downloads/easter-navy.jar").read_bytes()},
                                         snapshot_day="2026-11-30")
        fetch, settings = self.fetcher(document, zip_path)
        github = RecordingGitHub()
        original = bundle.apply

        def apply(fetched, repo_root, log=print, only=None):
            if only == "client":
                explode()
            return original(fetched, repo_root, log=log, only=only)

        bundle.apply, keep = apply, bundle.apply
        try:
            summary = cli.run(settings, api=github, log=self.logs.append, fetcher=fetch)
        finally:
            bundle.apply = keep
        self.assertTrue(any("client half" in failure for failure in summary.failures))
        self.assertEqual(summary.map_action, "committed")
        self.assertEqual(len(github.commits), 1)
        self.assertIn("2026-11-30", github.commits[0]["message"])

    # ── refusals ───────────────────────────────────────────────────────────────────
    def test_a_bundle_that_does_not_hash_to_its_document_is_refused(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-11-30")
        document["map"]["sha256"] = "f" * 64
        fetch, settings = self.fetcher(document, zip_path)
        github = RecordingGitHub()
        before = (self.repo / "site/data/world.json").read_bytes()
        summary = cli.run(settings, api=github, log=self.logs.append, fetcher=fetch)
        self.assertTrue(summary.failures)
        self.assertIn("hashes to", summary.failures[0])
        self.assertEqual(github.commits, [])
        self.assertEqual((self.repo / "site/data/world.json").read_bytes(), before)

    def test_a_world_document_that_disagrees_with_the_document_is_refused(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-11-30",
                                          bad_world_hash=True)
        fetch, settings = self.fetcher(document, zip_path)
        with self.assertRaises(bundle.BundleError) as caught:
            fetch(settings, log=self.logs.append)
        self.assertIn("world document", str(caught.exception))

    def test_a_member_outside_the_generated_paths_is_refused(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-11-30",
                                          extra_member=("scripts/sync.py", b"# not generated"))
        fetch, settings = self.fetcher(document, zip_path)
        with self.assertRaises(bundle.BundleError) as caught:
            fetch(settings, log=self.logs.append)
        self.assertIn("not a generated path", str(caught.exception))

    def test_a_traversing_member_is_refused(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-11-30",
                                          extra_member=("data/../../escape.png", b"x"))
        fetch, settings = self.fetcher(document, zip_path)
        with self.assertRaises(bundle.BundleError) as caught:
            fetch(settings, log=self.logs.append)
        self.assertIn("absolute or traversing", str(caught.exception))

    def test_a_document_from_another_shape_is_refused(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-11-30")
        document["surprise"] = True
        fetch, settings = self.fetcher(document, zip_path)
        with self.assertRaises(bundle.BundleError) as caught:
            fetch(settings, log=self.logs.append)
        self.assertIn("outside the contract", str(caught.exception))

    def test_a_document_with_neither_half_is_refused(self):
        document, zip_path = build_bundle(self.root / "b", snapshot_day="2026-11-30",
                                          carry_map=False)
        fetch, settings = self.fetcher(document, zip_path)
        with self.assertRaises(bundle.BundleError) as caught:
            fetch(settings, log=self.logs.append)
        self.assertIn("neither half", str(caught.exception))

    def test_an_unreachable_publish_url_is_a_named_failure(self):
        settings = Settings(publish_url="http://127.0.0.1:9/nothing.json",
                            repository="owner/repo", github_token="t",
                            repo_root=self.repo, timeout_seconds=5)
        summary = cli.run(settings, api=RecordingGitHub(), log=self.logs.append)
        self.assertTrue(summary.failures)
        self.assertIn("GET", summary.failures[0])

    def test_a_config_without_a_token_or_an_https_url_is_refused_before_any_fetch(self):
        from scripts.atlas.config import ConfigError
        with self.assertRaises(ConfigError):
            Settings.from_env({"GITHUB_REPOSITORY": "owner/repo",
                               "ATLAS_GITHUB_TOKEN": "t",
                               "ATLAS_PUBLISH_URL": "http://plain.example/latest.json"},
                              repo_root=self.repo)
        with self.assertRaises(ConfigError):
            Settings.from_env({"GITHUB_REPOSITORY": "owner/repo",
                               "ATLAS_PUBLISH_URL": "https://public.example/latest.json"},
                              repo_root=self.repo)


if __name__ == "__main__":
    unittest.main()
