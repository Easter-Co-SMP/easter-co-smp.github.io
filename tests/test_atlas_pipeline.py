"""The whole pipeline against fakes: the run the workflow performs, on a runner-shaped call.

Four fakes (S3, EC2, SSM, GitHub) and a throwaway copy of the published tree; no AWS call, no
GitHub call, no network, no Docker. What is proven here is the pipeline's own behaviour -- the
order of the three questions, what it does when nothing changed, the stop on every failure,
the two independent commits, and the pointer that only advances after a publication. What is
NOT proven here is the renderer (that is `tests/test_atlas_render_parity.py`, against the real
world tree) and the AWS/GitHub wire (that is the workflow's first real run).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts.atlas import cli, contract, host, publish, render
from scripts.atlas.config import Settings
from tests.atlas_stubs import (RecordingGitHub, StubEC2, StubS3, StubSSM, make_capture, make_repo,
                              published_client, seed_client_state)

CAPTURED_AT = "2026-10-22T04:30:00Z"


def pointer_document(ec2, **overrides):
    document = {
        "schema": 1, "snapshot_id": "s1", "captured_at": "2026-10-22T04:30:00+00:00",
        "published_at": "2026-10-22T04:40:00Z", "instance_id": ec2.instance_id,
        "launch_time": "2026-10-20T09:00:00+00:00",
        "state_transition_at": "2026-10-22T04:31:00+00:00",
        "state_transition_reason": "User initiated (2026-10-22 04:31:00 GMT)",
        "tar_key": contract.SNAPSHOT_KEY, "tar_sha256": "a" * 64, "tar_bytes": 100,
        "region_files": 2, "nonempty_regions": 2, "tiles": 2,
        "position_source": "test", "source": "github-actions",
    }
    document.update(overrides)
    return document


class PipelineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.mkdtemp(prefix="atlas-pipeline-")
        self.addCleanup(__import__("shutil").rmtree, temporary, True)
        self.root = Path(temporary)
        self.repo = make_repo(self.root)
        self.workdir = self.root / "work"
        self.workdir.mkdir()
        # The client half's resolution cache, seeded from the published manifest: on a runner
        # it is filled by Modrinth, here by the document itself, so the test needs no network.
        seed_client_state(self.workdir / "client", published_client(self.repo))

        self.ec2 = StubEC2(transition_reason="User initiated (2026-10-22 04:31:00 GMT)")
        self.s3 = StubS3()
        self.ssm = StubSSM()
        self.github = RecordingGitHub()
        self.logs = []
        self.tar, self.sidecar = make_capture(self.root / "capture", captured_at=CAPTURED_AT)

        def snapshot_ran(_text):
            self.s3.objects[contract.SNAPSHOT_KEY] = self.tar.read_bytes()
            self.s3.objects[contract.SIDECAR_KEY] = json.dumps(self.sidecar).encode()

        self.ssm.hooks["atlas snapshot"] = snapshot_ran
        self.settings = Settings.from_env(
            {"ATLAS_BUCKET": "atlas-bucket", "ATLAS_INSTANCE_ID": self.ec2.instance_id,
             "ATLAS_START_TIMEOUT": "1", "ATLAS_READY_TIMEOUT": "1",
             "ATLAS_SNAPSHOT_TIMEOUT": "1", "ATLAS_RENDER_WORKERS": "1"},
            repo_root=self.repo)
        self.world_before = (self.repo / "site/data/world.json").read_bytes()

    # ── the renderer is proven elsewhere; here it is a controlled stub ───────────────
    def fake_render(self, tiles=None, fail=False):
        tiles = tiles or [render.TileResult(x=-25, z=7, version="", bytes=0, completed=1,
                                           unreadable=0, stale=False, seconds=0.1),
                          render.TileResult(x=0, z=0, version="", bytes=0, completed=2,
                                            unreadable=0, stale=False, seconds=0.2)]

        def render_all(snapshot, out_dir, workers=1, log=print, pool_factory=None):
            if fail:
                raise render.RenderError("refusing to publish a partial map: r.0.0 unreadable")
            out = Path(out_dir)
            written = []
            for tile in tiles:
                path = out / str(tile.x) / f"{tile.z}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                blob = b"\x89PNG\r\n\x1a\n" + bytes([abs(tile.x) % 251, abs(tile.z) % 251])
                path.write_bytes(blob)
                written.append(render.TileResult(x=tile.x, z=tile.z,
                                                 version=hashlib.sha256(blob).hexdigest(),
                                                 bytes=len(blob), completed=tile.completed,
                                                 unreadable=0, stale=False,
                                                 seconds=tile.seconds))
            log(f"atlas: rendered {len(written)} tiles (stub)")
            return render.RenderResult(tiles=written, regions_considered=len(written),
                                       regions_rendered=len(written), empty_regions=0,
                                       wall_seconds=0.3,
                                       cpu_seconds=sum(t.seconds for t in written),
                                       workers=workers)

        return mock.patch.object(render, "render_all", render_all), mock.patch.object(
            render, "coverage_metadata",
            lambda snapshot, cache: {"center": [-625, -247], "saved_chunk_slots": 31023})

    def run_pipeline(self, **kwargs):
        renderer_patch, coverage_patch = self.fake_render(
            fail=kwargs.pop("render_fails", False))
        with renderer_patch, coverage_patch:
            return cli.run(self.settings, ec2=self.ec2, s3=self.s3, ssm=self.ssm,
                           github=self.github, log=self.logs.append, workdir=self.workdir,
                           **kwargs)

    # ── question one: nothing changed, so nothing happens ───────────────────────────
    def test_an_unchanged_world_takes_no_action_at_all(self):
        self.s3.objects[contract.POINTER_KEY] = json.dumps(pointer_document(self.ec2)).encode()
        summary = self.run_pipeline()
        self.assertEqual(summary.map_action, "unchanged")
        self.assertEqual(self.ec2.count("start_instances"), 0)
        self.assertEqual(self.ec2.count("stop_instances"), 0)
        self.assertEqual(self.ssm.count("send_command"), 0)
        self.assertEqual([call for call in self.s3.names() if call == "put_object"], [])
        self.assertEqual(self.github.commit_count, 0)
        self.assertFalse(summary.pointer_written)
        self.assertEqual(summary.failures, [])

    def test_the_reuse_line_names_the_compared_fields_and_the_published_day(self):
        self.s3.objects[contract.POINTER_KEY] = json.dumps(pointer_document(self.ec2)).encode()
        summary = self.run_pipeline()
        reuse = [line for line in self.logs if line.startswith("atlas: map reuse")]
        self.assertEqual(len(reuse), 1, f"expected exactly one reuse line, got {reuse}")
        line = reuse[0]
        self.assertIn("snapshot_day 2026-10-19", line)
        self.assertIn("field=launch_time", line)
        self.assertIn("field=state_transition_reason", line)
        self.assertEqual(line, summary.map_line)

    def test_the_reuse_path_leaves_world_json_byte_for_byte_identical(self):
        self.s3.objects[contract.POINTER_KEY] = json.dumps(pointer_document(self.ec2)).encode()
        before = {path: path.read_bytes()
                  for path in sorted((self.repo / "site/data").rglob("*")) if path.is_file()}
        self.run_pipeline()
        after = {path: path.read_bytes()
                 for path in sorted((self.repo / "site/data").rglob("*")) if path.is_file()}
        self.assertEqual(before, after)
        self.assertEqual((self.repo / "site/data/world.json").read_bytes(), self.world_before)

    def test_a_running_host_defers_without_capturing_or_stopping(self):
        self.s3.objects[contract.POINTER_KEY] = json.dumps(pointer_document(self.ec2)).encode()
        self.ec2.state = "running"
        summary = self.run_pipeline()
        self.assertEqual(summary.map_action, "defer")
        self.assertEqual(self.ec2.count("stop_instances"), 0)
        self.assertEqual(self.ssm.count("send_command"), 0)
        self.assertTrue(any("map deferred" in line for line in self.logs))

    # ── question two: a real capture, and the pointer after the commit ──────────────
    def test_a_capture_publishes_the_map_half_and_advances_the_pointer(self):
        summary = self.run_pipeline()
        self.assertEqual(summary.map_action, "captured")
        self.assertEqual(self.ec2.count("start_instances"), 1)
        self.assertEqual(self.ec2.count("stop_instances"), 1)
        self.assertTrue(summary.map_committed)
        self.assertTrue(summary.pointer_written)
        self.assertEqual(summary.tiles, 2)
        # The map commit carries the document and the tiles, under generated paths only.
        map_commit = self.github.commits[0]
        self.assertIn("site/data/world.json", map_commit["changed"])
        self.assertTrue(any(path.endswith(".png") for path in map_commit["changed"]))
        for path in map_commit["changed"]:
            self.assertTrue(path.startswith("site/data/"), path)
        document = json.loads((self.repo / "site/data/world.json").read_text())
        self.assertEqual(document["captured_at"], "2026-10-22T04:30:00+00:00")
        self.assertEqual(document["snapshot_day"], "2026-10-22")
        self.assertEqual(len(document["tiles"]), 2)
        pointer = json.loads(self.s3.objects[contract.POINTER_KEY])
        self.assertEqual(set(pointer), set(contract.POINTER_KEYS))
        self.assertEqual(pointer["captured_at"], "2026-10-22T04:30:00Z")
        self.assertEqual(pointer["tiles"], 2)
        # Nothing claims a capture newer than the snapshot it came from: the pointer, the
        # document and the host's sidecar all name the same instant, and it is the capture's.
        self.assertEqual(document["captured_at"], "2026-10-22T04:30:00+00:00")
        self.assertEqual(pointer["position_source"], document["position_source"])
        # Every published tile is the tile the render produced, checked against its own bytes.
        for tile in document["tiles"]:
            published = self.repo / f"site/data/tiles/{tile['x']}/{tile['z']}.png"
            self.assertEqual(hashlib.sha256(published.read_bytes()).hexdigest(), tile["version"])

    def test_a_failed_map_publication_leaves_the_pointer_where_it_was(self):
        def refuse(*_args, **_kwargs):
            raise publish.PublishError("PATCH /git/refs/heads/main -> HTTP 422")
        with mock.patch.object(publish, "publish", refuse):
            summary = self.run_pipeline()
        self.assertFalse(summary.pointer_written)
        self.assertTrue(summary.failures)
        # And the host was still stopped: a publication failure is not a reason to leave the
        # production server running.
        self.assertEqual(self.ec2.count("stop_instances"), 1)

    def test_a_render_failure_stops_the_host_and_publishes_nothing(self):
        summary = self.run_pipeline(render_fails=True)
        self.assertTrue(summary.failures)
        self.assertIn("partial map", " ".join(summary.failures))
        self.assertEqual(self.ec2.count("stop_instances"), 1)
        self.assertFalse(summary.pointer_written)
        self.assertFalse(any(commit for commit in self.github.commits
                             if any(path.startswith("site/data/world.json")
                                    for path in commit["changed"])))
        self.assertEqual((self.repo / "site/data/world.json").read_bytes(), self.world_before)

    def test_a_host_that_cannot_be_read_fails_the_map_half_and_stops_nothing(self):
        self.ec2.failures["describe_instances"] = RuntimeError("throttled")
        summary = self.run_pipeline()
        self.assertTrue(summary.failures)
        self.assertIn("throttled", " ".join(summary.failures))
        self.assertEqual(self.ec2.count("start_instances"), 0)
        self.assertEqual(self.ec2.count("stop_instances"), 0)

    # ── question three, and the client half's independence ─────────────────────────
    def test_the_client_half_publishes_even_when_the_map_captures_nothing(self):
        self.s3.objects[contract.POINTER_KEY] = json.dumps(pointer_document(self.ec2)).encode()
        # Make the published client half stale in one field, so rebuilding it differs.
        document = published_client(self.repo)
        document["deployment"] = {"schema": 1, "serverAddress": "old.example:25565"}
        (self.repo / "site/data/client.json").write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf8")
        summary = self.run_pipeline()
        self.assertEqual(summary.map_action, "unchanged")
        self.assertFalse(summary.map_committed)
        self.assertTrue(summary.client_committed)
        self.assertEqual(self.github.commit_count, 1)
        commit = self.github.commits[0]
        self.assertEqual(commit["message"], contract.CLIENT_COMMIT_MESSAGE)
        self.assertIn("site/data/client.json", commit["changed"])
        for path in commit["changed"]:
            self.assertTrue(path.startswith(("site/data/client.json", "site/downloads/")), path)
        # The map half was not touched by the client publication.
        self.assertEqual((self.repo / "site/data/world.json").read_bytes(), self.world_before)

    def test_the_client_half_is_unchanged_when_nothing_upstream_moved(self):
        before = (self.repo / "site/data/client.json").read_bytes()
        jar_before = (self.repo / "site/downloads/easter-navy.jar").read_bytes()
        summary = self.run_pipeline()
        self.assertFalse(summary.client_committed)
        self.assertEqual(summary.client_changed, [])
        self.assertEqual(self.github.commit_count, 1,
                         "only the map half should have committed")
        self.assertEqual((self.repo / "site/data/client.json").read_bytes(), before)
        self.assertEqual((self.repo / "site/downloads/easter-navy.jar").read_bytes(), jar_before)

    def test_a_broken_client_half_does_not_stop_the_map_half(self):
        def explode(*_args, **_kwargs):
            raise RuntimeError("Modrinth could not confirm fabric-api")
        with mock.patch.object(cli.client, "build", explode):
            summary = self.run_pipeline()
        self.assertTrue(any("client half" in failure for failure in summary.failures))
        self.assertEqual(summary.map_action, "captured")
        self.assertTrue(summary.map_committed)

    # ── the two halves are two commits, in one run ──────────────────────────────────
    def test_one_run_makes_one_commit_per_changed_half(self):
        document = published_client(self.repo)
        document["deployment"] = {"schema": 1, "serverAddress": "old.example:25565"}
        (self.repo / "site/data/client.json").write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf8")
        summary = self.run_pipeline()
        self.assertTrue(summary.client_committed)
        self.assertTrue(summary.map_committed)
        self.assertEqual(self.github.commit_count, 2)
        self.assertEqual(self.github.commits[0]["message"], contract.CLIENT_COMMIT_MESSAGE)
        self.assertTrue(self.github.commits[1]["message"].startswith(
            "Publish the atlas terrain for "))
        self.assertNotEqual(self.github.commits[0]["changed"], self.github.commits[1]["changed"])


if __name__ == "__main__":
    unittest.main()
