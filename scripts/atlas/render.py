"""Render the snapshot's regions into tiles, in parallel processes.

One region costs about 0.8 s of CPU on average and up to 3.3 s for the biggest one, and the
live world has 66 non-empty regions, so the serial whole set is under a minute here and
several minutes on a two-vCPU box. It is done in separate processes rather than threads
because the renderer is pure Python: a thread would hold the GIL through every chunk parse,
and the module's own semaphore would cap it at two anyway.

Each worker gets its own tile cache directory, so the cache is never a lock between
processes, and the cache is keyed on the world root rather than its inode (see `vendor.py`),
so a re-extracted snapshot of the same content reuses it instead of re-rendering everything.

What is written: one PNG per non-empty region, at `data/tiles/<x>/<z>.png`, exactly the
layout the site already serves, plus a report per tile. A region with any unreadable chunk
fails the whole render: 65 good tiles and one partial one is a public map with a hole in it,
and `scripts/export_world.py` refuses that case for the same reason.
"""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
import hashlib
import multiprocessing
import os
from pathlib import Path
import time

from . import renderer


class RenderError(RuntimeError):
    """A region could not be rendered into a tile the pipeline is willing to publish."""


@dataclass
class TileResult:
    x: int
    z: int
    version: str
    bytes: int
    completed: int
    unreadable: int
    stale: bool
    seconds: float


@dataclass
class RenderResult:
    tiles: list = field(default_factory=list)
    regions_considered: int = 0
    regions_rendered: int = 0
    empty_regions: int = 0
    wall_seconds: float = 0.0
    cpu_seconds: float = 0.0
    workers: int = 1

    @property
    def mean_seconds(self):
        return 0.0 if not self.regions_rendered else self.cpu_seconds / self.regions_rendered


def pool_context():
    """An explicit `fork` context on POSIX, so the workers never re-import `__main__`.

    Python 3.14 made `forkserver` the default on Linux and 3.13 still forks, and a forkserver
    child re-imports the main module: a caller whose entry point is not guarded by
    `if __name__ == "__main__"` then dies with `ConnectionResetError` instead of rendering.
    Nothing here needs to re-import anything -- the worker lives in this package -- so asking
    for `fork` explicitly makes the same code behave the same way on both versions. Windows is
    not a target: the workflow runs on `ubuntu-latest`.
    """
    try:
        return multiprocessing.get_context("fork")
    except ValueError:  # pragma: no cover - non-POSIX
        return None


def _render_one(args):
    """Render one region in a worker process and write its tile. Module level for pickling."""
    world_root, cache_dir, region_dir, x, z, out_dir = args
    modules = renderer.use(world_root=world_root, tile_cache=cache_dir)
    terrain = modules.terrain
    started = time.monotonic()
    path, report = terrain.tile(x, z)
    blob = Path(path).read_bytes()
    target = Path(out_dir) / str(x) / f"{z}.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(blob)
    return {
        "x": x, "z": z, "version": hashlib.sha256(blob).hexdigest(), "bytes": len(blob),
        "completed": int(report.get("completed") or 0),
        "unreadable": int(report.get("unreadable") or 0),
        "stale": bool(report.get("stale")),
        "seconds": time.monotonic() - started,
    }


def render_all(snapshot, out_dir, workers=4, log=print, pool_factory=None):
    """Render every non-empty region of the snapshot into `out_dir`/tiles."""
    world_root = Path(snapshot.world_root)
    out_dir = Path(out_dir)
    modules = renderer.use(world_root=world_root, tile_cache=out_dir.parent / "cache-parent")
    terrain = modules.terrain
    coverage = terrain.metadata()
    regions = sorted(coverage.get("regions") or [], key=lambda r: (r["x"], r["z"]))
    if not regions:
        raise RenderError("the snapshot has no saved chunks; refusing to publish an empty map")

    work = []
    for region in regions:
        work.append((str(world_root), str(out_dir.parent / "cache" / f"w{region['x']}_{region['z']}"),
                     str(snapshot.region_dir), region["x"], region["z"], str(out_dir)))
    started = time.monotonic()
    results = []
    if workers <= 1 or len(work) == 1:
        for item in work:
            results.append(_render_one(item))
    else:
        context = pool_context()
        if pool_factory is None:
            def factory(**kwargs):
                return ProcessPoolExecutor(**kwargs) if context is None else ProcessPoolExecutor(
                    mp_context=context, **kwargs)
        else:
            factory = pool_factory
        with factory(max_workers=workers) as pool:
            for index, result in enumerate(pool.map(_render_one, work, chunksize=1), start=1):
                results.append(result)
                if log and index % 10 == 0:
                    log(f"atlas: rendered {index}/{len(work)} tiles")
    wall = time.monotonic() - started

    tiles, failures = [], []
    for result in results:
        if result["unreadable"]:
            failures.append(f"r.{result['x']}.{result['z']} has {result['unreadable']} unreadable "
                            "chunk(s)")
        if result["stale"]:
            failures.append(f"r.{result['x']}.{result['z']} was still being written while it was "
                            "rendered, which cannot happen on an uploaded snapshot")
        # A region with a saved chunk always gets a tile, even when every chunk in it is a
        # partial one and the tile comes out empty. That is what the exporter publishes today
        # (66 tiles for 66 regions, 34 of them blank), and dropping them would silently change
        # the published artifact on a world that did not change.
        tiles.append(TileResult(**result))
    if failures:
        raise RenderError("refusing to publish a partial map: " + "; ".join(failures[:5]))
    if not tiles:
        raise RenderError("no region produced a tile; refusing to publish an empty map")

    report = RenderResult(
        tiles=tiles, regions_considered=len(work), regions_rendered=len(tiles),
        empty_regions=len(work) - len(tiles), wall_seconds=wall,
        cpu_seconds=sum(t.seconds for t in tiles), workers=workers,
    )
    log(f"atlas: rendered {report.regions_rendered} tiles from {report.regions_considered} "
        f"region files ({report.empty_regions} empty) in {report.wall_seconds:.1f}s with "
        f"{report.workers} worker(s); {report.cpu_seconds:.1f} CPU-seconds, "
        f"{report.mean_seconds:.3f}s per tile")
    return report


def coverage_metadata(snapshot, cache_dir):
    """`center` and `saved_chunk_slots` for the document, read from the snapshot itself."""
    modules = renderer.use(world_root=snapshot.world_root, tile_cache=cache_dir)
    return modules.terrain.metadata()


def tile_paths(out_dir):
    """Every tile on disk, as (x, z, Path), for a caller that did not just render them."""
    rows = []
    for path in sorted(Path(out_dir).glob("*/*.png")):
        try:
            rows.append((int(path.parent.name), int(path.stem), path))
        except ValueError:
            continue
    return rows
