#!/usr/bin/env python3
"""The whole pipeline, against fakes, printing exactly what a real run prints.

This is the runner-shaped invocation with no runner: `python -m scripts.atlas` cannot run here
(it would build real boto3 clients), so this script builds the same fakes the tests use, hands
them to `scripts.atlas.cli.run`, and prints the log. Two runs, in this order:

1. a capture: change detection says the world may have changed, so the host is woken, the
   committed snapshot script is sent over SSM, the upload is confirmed, the tiles are rendered,
   the instance is stopped, the map half commits, and the pointer advances;
2. the run after it: the pointer now matches EC2, so nothing is started, nothing is sent,
   nothing is uploaded and nothing is committed -- only one line, saying what it compared.

The renderer is replaced by a stub here (it is proven against the real world tree in
`tests/test_atlas_render_parity.py`), because this script's job is to show the pipeline's own
behaviour end to end.

    python tests/atlas_demo.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.atlas import cli, contract, render  # noqa: E402
from tests.atlas_stubs import (RecordingGitHub, StubEC2, StubS3, StubSSM, make_capture,  # noqa: E402
                              make_repo, published_client, seed_client_state)


def stub_render(regions):
    """A tile per region, with the version the published document will carry."""

    def render_all(snapshot, out_dir, workers=1, log=print, pool_factory=None):
        out = Path(out_dir)
        tiles = []
        for x, z in regions:
            blob = b"\x89PNG\r\n\x1a\n" + f"{x}:{z}".encode() * 8
            path = out / str(x) / f"{z}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
            tiles.append(render.TileResult(x=x, z=z, version=hashlib.sha256(blob).hexdigest(),
                                           bytes=len(blob), completed=1024, unreadable=0,
                                           stale=False, seconds=0.4))
        log(f"atlas: rendered {len(tiles)} tiles from {len(tiles)} region files in 1.6s "
            f"with {workers} worker(s)")
        return render.RenderResult(tiles=tiles, regions_considered=len(tiles),
                                   regions_rendered=len(tiles), empty_regions=0,
                                   wall_seconds=1.6, cpu_seconds=len(tiles) * 0.4,
                                   workers=workers)

    return render_all


def main():
    temporary = Path(tempfile.mkdtemp(prefix="atlas-demo-"))
    repo = make_repo(temporary)
    workdir = temporary / "work"
    workdir.mkdir()
    seed_client_state(workdir / "client", published_client(repo))

    ec2 = StubEC2(transition_reason="User initiated (2026-10-20 09:00:00 GMT)",
                  launch_time="2026-10-20T09:00:00+00:00")
    s3 = StubS3()
    ssm = StubSSM()
    github = RecordingGitHub()
    tar, sidecar = make_capture(temporary / "capture", regions=[(-25, 7), (-2, -2), (0, 0)])

    def snapshot_ran(_text):
        s3.objects[contract.SNAPSHOT_KEY] = tar.read_bytes()
        s3.objects[contract.SIDECAR_KEY] = json.dumps(sidecar).encode()

    ssm.hooks["atlas snapshot"] = snapshot_ran

    from scripts.atlas.config import Settings
    settings = Settings.from_env(
        {"ATLAS_BUCKET": "atlas-bucket", "ATLAS_INSTANCE_ID": ec2.instance_id,
         "ATLAS_RENDER_WORKERS": "4"}, repo_root=repo)

    render.render_all = stub_render([(-25, 7), (-2, -2), (0, 0)])
    render.coverage_metadata = lambda snapshot, cache: {"center": [-625, -247],
                                                        "saved_chunk_slots": 31023}

    def show(label, summary):
        print(f"\n--- {label} ---")
        print(json.dumps(summary.as_dict(), indent=2, sort_keys=True))

    print("=== run 1: the world may have changed, so it is captured ===")
    first = cli.run(settings, ec2=ec2, s3=s3, ssm=ssm, github=github, log=print,
                    workdir=workdir)
    show("run 1 summary", first)
    print(f"\nEC2 calls:   {ec2.names()}")
    print(f"SSM calls:   {ssm.names()}")
    print(f"S3 calls:    {s3.names()}")
    print(f"commits:     {github.messages()}")
    for commit in github.commits:
        print(f"  {commit['changed']}")

    pointer = json.loads(s3.objects[contract.POINTER_KEY])
    print("\npointer written after the commit:")
    print(json.dumps({key: pointer[key] for key in
                      ("snapshot_id", "captured_at", "launch_time", "state_transition_at",
                       "tiles", "position_source")}, indent=2))

    print("\n=== run 2: the pointer now matches EC2, so nothing happens ===")
    ec2.calls.clear()
    ssm.calls.clear()
    s3.calls.clear()
    github.calls.clear()
    commits_before = github.commit_count
    second = cli.run(settings, ec2=ec2, s3=s3, ssm=ssm, github=github, log=print,
                     workdir=workdir)
    show("run 2 summary", second)
    print(f"\nEC2 calls:   {ec2.names()}")
    print(f"SSM calls:   {ssm.names()}")
    print(f"S3 calls:    {s3.names()}")
    print(f"commits:     {github.commit_count - commits_before}")
    print(f"world.json unchanged: "
          f"{(repo / 'site/data/world.json').read_bytes()[:40]!r}")
    return 0 if not first.failures and not second.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
