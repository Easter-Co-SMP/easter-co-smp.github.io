"""The publisher, against a real HTTP server that speaks the Git Data API.

No GitHub, no token, no network beyond loopback -- but the transport is real: real urllib,
real JSON, real base64 blobs, real status codes. That matters, because the two things most
likely to be wrong in a publisher are the shape of a request and what it does with a refusal,
and neither shows up when the client object is mocked.
"""
from __future__ import annotations

import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
import urllib.parse

from scripts.atlas import contract, publish


def blob_sha(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode("ascii") + data).hexdigest()


class FakeGitHub:
    """The smallest GitHub that can accept a commit: refs, trees, blobs, commits."""

    def __init__(self, files=None):
        self.trees = {"tree-root": dict(files or {})}
        self.head = "commit-root"
        self.commits = []
        self.blobs = {}
        self.requests = []          # (method, path, body)
        self.refuse_fast_forward = 0
        self.force_seen = []
        self._counter = 0
        self.token = "test-token"

    # ── the handler's hooks ──────────────────────────────────────────────────────────
    def handle(self, method, path, body, headers):
        url = urllib.parse.urlsplit(path)
        route = url.path
        if headers.get("Authorization") != f"Bearer {self.token}":
            return 401, {"message": "Bad credentials"}
        self.requests.append((method, route, body))
        if method == "GET" and route.endswith("/git/ref/heads/main"):
            return 200, {"object": {"sha": self.head}}
        if method == "GET" and "/git/commits/" in route:
            return 200, {"tree": {"sha": "tree-root"}}
        if method == "GET" and "/git/trees/" in route:
            tree = self.trees.get(route.rsplit("/", 1)[-1], {})
            return 200, {"tree": [{"path": path, "type": "blob", "mode": "100644", "sha": digest}
                                  for path, digest in sorted(tree.items())]}
        if method == "POST" and route.endswith("/git/blobs"):
            data = __import__("base64").b64decode(body["content"])
            digest = blob_sha(data)
            self.blobs[digest] = data
            return 201, {"sha": digest}
        if method == "POST" and route.endswith("/git/trees"):
            tree = dict(self.trees.get(body["base_tree"], {}))
            for entry in body["tree"]:
                if entry.get("sha") is None:
                    tree.pop(entry["path"], None)
                else:
                    tree[entry["path"]] = entry["sha"]
            self._counter += 1
            name = f"tree-{self._counter}"
            self.trees[name] = tree
            return 201, {"sha": name}
        if method == "POST" and route.endswith("/git/commits"):
            self._counter += 1
            sha = f"commit-{self._counter}"
            files = dict(self.trees[body["tree"]])
            previous = dict(self.trees.get("tree-root", {}))
            changed = sorted(path for path, digest in files.items()
                             if previous.get(path) != digest)
            changed += sorted(path for path in previous if path not in files)
            self.commits.append({"sha": sha, "message": body["message"],
                                 "tree": body["tree"], "parents": body["parents"],
                                 "files": files, "changed": changed})
            return 201, {"sha": sha}
        if method == "PATCH" and "/git/refs/heads/" in route:
            self.force_seen.append(body.get("force"))
            if self.refuse_fast_forward:
                self.refuse_fast_forward -= 1
                return 422, {"message": "Update is not a fast forward"}
            self.head = body["sha"]
            self.trees["tree-root"] = dict(self.commits[-1]["files"])
            return 200, {"object": {"sha": self.head}}
        return 404, {"message": f"no route for {method} {route}"}


def serve(fake):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _handle(self, method):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            body = json.loads(raw.decode("utf8")) if raw else None
            status, payload = fake.handle(method, self.path, body, dict(self.headers))
            data = json.dumps(payload).encode("utf8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PATCH(self):
            self._handle("PATCH")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGitHub()
        self.server, self.thread = serve(self.fake)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.api = publish.GitHubAPI("test-token", "owner/repo",
                                     api_root=f"http://127.0.0.1:{self.server.server_port}",
                                     log=lambda _line: None)
        import tempfile
        from pathlib import Path
        self.staging = Path(self.addCleanup and tempfile.mkdtemp())
        self.addCleanup(__import__("shutil").rmtree, self.staging, True)

    def half(self, files, paths=None, delete=(), message="Publish the atlas", name="map"):
        from pathlib import Path
        for relative, payload in files.items():
            target = Path(self.staging) / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload if isinstance(payload, bytes) else payload.encode())
        paths = paths or tuple(sorted({"site/data/world.json"}))
        return publish.Half(name=name, paths=paths, staging=Path(self.staging),
                            message=message, delete=tuple(delete))

    # ── the happy path ───────────────────────────────────────────────────────────────
    def test_one_commit_for_a_whole_set_of_files(self):
        half = self.half({"site/data/world.json": '{"schema":1}',
                          "site/data/tiles/0/0.png": b"\x89PNG\r\n\x1a\nA",
                          "site/data/tiles/0/1.png": b"\x89PNG\r\n\x1a\nB"},
                         paths=("site/data/world.json", "site/data/tiles"))
        result = publish.publish(self.api, half, log=lambda _line: None)
        self.assertTrue(result.committed)
        self.assertEqual(len(self.fake.commits), 1)
        self.assertEqual(result.uploaded, 3)
        self.assertEqual(set(self.fake.commits[0]["files"]), {
            "site/data/world.json", "site/data/tiles/0/0.png", "site/data/tiles/0/1.png"})
        # A fast-forward, never a force.
        self.assertEqual(self.fake.force_seen, [False])

    def test_unchanged_bytes_are_never_uploaded_again(self):
        half = self.half({"site/data/world.json": '{"schema":1}'})
        publish.publish(self.api, half, log=lambda _line: None)
        blobs_after_first = len(self.fake.blobs)
        second = publish.publish(self.api, half, log=lambda _line: None)
        self.assertFalse(second.committed)
        self.assertEqual(second.reused, 1)
        self.assertEqual(len(self.fake.blobs), blobs_after_first)
        self.assertEqual(len(self.fake.commits), 1, "an unchanged half made a second commit")
        self.assertIn("already published", second.line)

    def test_a_changed_tile_uploads_only_that_tile(self):
        publish.publish(self.api, self.half(
            {"site/data/world.json": '{"schema":1}', "site/data/tiles/0/0.png": b"A"},
            paths=("site/data/world.json", "site/data/tiles")), log=lambda _line: None)
        result = publish.publish(self.api, self.half(
            {"site/data/world.json": '{"schema":1}', "site/data/tiles/0/0.png": b"B"},
            paths=("site/data/world.json", "site/data/tiles")), log=lambda _line: None)
        self.assertTrue(result.committed)
        self.assertEqual(result.uploaded, 1)
        self.assertEqual(result.reused, 1)

    def test_a_removed_tile_leaves_the_published_tree(self):
        publish.publish(self.api, self.half(
            {"site/data/tiles/0/0.png": b"A", "site/data/tiles/0/1.png": b"B"},
            paths=("site/data/tiles",)), log=lambda _line: None)
        result = publish.publish(self.api, self.half(
            {"site/data/tiles/0/0.png": b"A"}, paths=("site/data/tiles",),
            delete=("site/data/tiles/0/1.png",)), log=lambda _line: None)
        self.assertTrue(result.committed)
        self.assertEqual(result.deleted, 1)
        self.assertNotIn("site/data/tiles/0/1.png", self.fake.commits[-1]["files"])

    # ── refusals ────────────────────────────────────────────────────────────────────
    def test_a_path_outside_the_generated_tree_is_refused_before_any_request(self):
        half = self.half({"desktop/main.cjs": "// not generated"},
                         paths=("desktop/main.cjs",))
        with self.assertRaises(publish.RefusedPath):
            publish.publish(self.api, half, log=lambda _line: None)
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.fake.commits, [])

    def test_a_deletion_outside_the_generated_tree_is_refused(self):
        half = self.half({"site/data/world.json": '{"schema":1}'},
                         delete=("site/index.html",))
        with self.assertRaises(publish.RefusedPath):
            publish.publish(self.api, half, log=lambda _line: None)
        self.assertEqual(self.fake.requests, [])

    def test_a_missing_staged_file_is_a_named_failure(self):
        half = publish.Half(name="map", paths=("site/data/world.json",),
                            staging=self.staging, message="x")
        with self.assertRaises(publish.PublishError):
            publish.publish(self.api, half, log=lambda _line: None)

    def test_a_refused_fast_forward_is_retried_on_the_new_head_and_never_forced(self):
        self.fake.refuse_fast_forward = 1
        result = publish.publish(self.api, self.half({"site/data/world.json": "{}x"}),
                                 attempts=3, sleep=lambda _s: None, log=lambda _line: None)
        self.assertTrue(result.committed)
        self.assertEqual(result.attempts, 2)
        self.assertEqual(self.fake.force_seen, [False, False])
        self.assertNotIn(True, self.fake.force_seen)

    def test_a_token_is_required(self):
        with self.assertRaises(publish.PublishError):
            publish.GitHubAPI("", "owner/repo")

    def test_a_bad_token_reports_the_response(self):
        api = publish.GitHubAPI("wrong", "owner/repo",
                                api_root=f"http://127.0.0.1:{self.server.server_port}",
                                log=lambda _line: None)
        with self.assertRaises(publish.PublishError) as caught:
            publish.publish(api, self.half({"site/data/world.json": "{}"}), log=lambda _line: None)
        self.assertIn("401", str(caught.exception))

    def test_the_two_halves_are_two_commits(self):
        map_half = self.half({"site/data/world.json": "{}", "site/data/tiles/0/0.png": b"A"},
                             paths=("site/data/world.json", "site/data/tiles"),
                             message=contract.MAP_COMMIT_MESSAGE.format(snapshot_day="2026-10-23"))
        client_half = self.half({"site/data/client.json": "{}",
                                 "site/downloads/easter-navy.jar": b"jar"},
                                paths=("site/data/client.json", "site/downloads"),
                                message=contract.CLIENT_COMMIT_MESSAGE, name="client")
        first = publish.publish(self.api, map_half, log=lambda _line: None)
        second = publish.publish(self.api, client_half, log=lambda _line: None)
        self.assertTrue(first.committed)
        self.assertTrue(second.committed)
        self.assertEqual(len(self.fake.commits), 2)
        self.assertIn("Publish the atlas terrain for 2026-10-23", self.fake.commits[0]["message"])
        self.assertEqual(self.fake.commits[1]["message"], contract.CLIENT_COMMIT_MESSAGE)
        # Each commit *changes* only its own half's paths, which is what makes them
        # independent rather than two copies of one publication.
        self.assertEqual(self.fake.commits[0]["changed"], ["site/data/tiles/0/0.png",
                                                           "site/data/world.json"])
        self.assertEqual(self.fake.commits[1]["changed"], ["site/data/client.json",
                                                           "site/downloads/easter-navy.jar"])


if __name__ == "__main__":
    unittest.main()
