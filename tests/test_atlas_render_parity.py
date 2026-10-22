"""The renderer, replayed against the last published snapshot: the same bytes, from a copy.

This is the test that makes "the map does not change when it moves into the cloud" a
measurement rather than a hope. It takes a handful of region files out of the live world tree,
copies them into a world tree of its own, renders them through the vendored renderer with the
world root overridden, and compares each PNG with the tile the site already publishes.

It needs Pillow and a world tree, so on a fresh runner it skips and says why. Locally, and on
this machine, it is the proof.

`ATLAS_WORLD_ROOT` points it at a world tree; `ATLAS_PARITY_TILES` sets how many published
tiles to replay (default 6, `all` for all 66).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest

try:
    import PIL  # noqa: F401
    HAVE_PILLOW = True
except ImportError:  # pragma: no cover - the skip below is the report
    HAVE_PILLOW = False

from scripts.atlas import render, renderer
from tests.atlas_stubs import REPO_ROOT

WORLD_ROOT = Path(os.environ.get("ATLAS_WORLD_ROOT") or "/opt/minecraft/server/world")
TILE_LIMIT = os.environ.get("ATLAS_PARITY_TILES", "6")
PUBLISHED = REPO_ROOT / "site/data"


#: The tile the exporter writes for a region whose chunks are all partial: a transparent
#: 256x256 square. 34 of the 66 published tiles are this, so a parity test that picked tiles
#: at random could "match" while proving nothing. Those are excluded deliberately.
BLANK_VERSION = "3c6c50f94ab35e9f96c772731fe6b7950048179bc81b8ab0396cc1edbde89163"


def published_tiles(limit):
    """Published tiles that carry real terrain, largest region first."""
    document = json.loads((PUBLISHED / "world.json").read_text(encoding="utf8"))
    rows = sorted((tile["x"], tile["z"]) for tile in document["tiles"]
                  if tile["version"] != BLANK_VERSION)
    if limit != "all":
        rows = rows[:int(limit)]
    return rows


def region_dir(world_root):
    modern = Path(world_root) / "dimensions/minecraft/overworld/region"
    return modern if modern.is_dir() else Path(world_root) / "region"


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed, so the renderer cannot run here")
class ReplayTests(unittest.TestCase):
    """Render published regions through the vendored code and compare the bytes."""

    @classmethod
    def setUpClass(cls):
        if not region_dir(WORLD_ROOT).is_dir():
            raise unittest.SkipTest(f"no world tree at {WORLD_ROOT}; set ATLAS_WORLD_ROOT")
        cls.temporary = tempfile.mkdtemp(prefix="atlas-parity-")
        cls.addClassCleanup(shutil.rmtree, cls.temporary, True)
        # A world tree of our own: the point is that the renderer reads an OVERRIDDEN root,
        # not the live one.
        cls.world = Path(cls.temporary) / "world"
        (cls.world / "dimensions/minecraft/overworld/region").mkdir(parents=True)
        shutil.copyfile(WORLD_ROOT / "level.dat", cls.world / "level.dat")
        cls.wanted = published_tiles(TILE_LIMIT)
        for x, z in cls.wanted:
            source = region_dir(WORLD_ROOT) / f"r.{x}.{z}.mca"
            if not source.is_file():
                continue
            shutil.copyfile(source, cls.world / "dimensions/minecraft/overworld/region"
                            / source.name)
        cls.out = Path(cls.temporary) / "tiles"
        started = time.monotonic()
        cls.result = render.render_all(_Snapshot(cls.world), cls.out, workers=1,
                                       log=lambda _line: None)
        cls.wall = time.monotonic() - started

    def test_at_least_five_published_tiles_are_reproduced_byte_for_byte(self):
        matched, differed, missing = 0, [], []
        for tile in self.result.tiles:
            published = PUBLISHED / f"tiles/{tile.x}/{tile.z}.png"
            if not published.is_file():
                missing.append((tile.x, tile.z))
                continue
            if hashlib.sha256(published.read_bytes()).hexdigest() == tile.version:
                matched += 1
            else:
                differed.append((tile.x, tile.z))
        self.assertEqual(differed, [], f"{len(differed)} tile(s) differ from the published map: "
                                      f"{differed[:5]}")
        self.assertEqual(missing, [], "the published map has no tile for a region we rendered")
        self.assertGreaterEqual(matched, 5,
                                f"only {matched} published tile(s) matched; the replay is not "
                                "proving anything")
        self.assertEqual(matched, len(self.result.tiles),
                         f"{matched} of {len(self.result.tiles)} rendered tiles matched")

    def test_the_replay_is_measured_and_reported(self):
        result = self.result
        self.assertGreater(result.regions_rendered, 0)
        self.assertGreater(result.cpu_seconds, 0)
        self.assertLessEqual(result.wall_seconds, self.wall + 1)
        # The numbers go into the submission, so name them in the failure message too.
        print(f"\n[parity] {result.regions_rendered} region(s) replayed in "
              f"{result.wall_seconds:.1f}s wall, {result.cpu_seconds:.1f}s CPU, "
              f"{result.mean_seconds:.3f}s per tile, {result.workers} worker(s)")

    def test_every_replayed_tile_came_from_saved_chunks(self):
        """The inverse of a hollow pass: a blank tile would match and prove nothing."""
        self.assertTrue(self.result.tiles)
        for tile in self.result.tiles:
            self.assertGreater(tile.completed, 0,
                               f"r.{tile.x}.{tile.z} rendered no full chunk, so its tile proves "
                               "nothing about the renderer")
            self.assertNotEqual(tile.version, BLANK_VERSION,
                                f"r.{tile.x}.{tile.z} is the blank tile")

    def test_a_second_run_reuses_the_cache_and_produces_the_same_bytes(self):
        again = render.render_all(_Snapshot(self.world), self.out, workers=1,
                                  log=lambda _line: None)
        first = {(tile.x, tile.z): tile.version for tile in self.result.tiles}
        second = {(tile.x, tile.z): tile.version for tile in again.tiles}
        self.assertEqual(first, second)
        self.assertLess(again.cpu_seconds, self.result.cpu_seconds,
                        "a warm cache did not make the second render cheaper")


class ParallelRenderTests(unittest.TestCase):
    """The parallel path is the one that ships, so it is the one that must run in a test.

    It has already hidden a real defect: on Python 3.14 `forkserver` is the default start
    method, a forkserver child re-imports `__main__`, and the pool died with
    `ConnectionResetError` before rendering anything. `render.pool_context()` pins `fork` for
    exactly that reason, and this test would fail without it.
    """

    @unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed, so the renderer cannot run here")
    def test_two_processes_render_the_same_bytes_as_one(self):
        if not region_dir(WORLD_ROOT).is_dir():
            self.skipTest(f"no world tree at {WORLD_ROOT}")
        with tempfile.TemporaryDirectory() as temporary:
            world = Path(temporary) / "world"
            (world / "dimensions/minecraft/overworld/region").mkdir(parents=True)
            shutil.copyfile(WORLD_ROOT / "level.dat", world / "level.dat")
            wanted = published_tiles(2)
            for x, z in wanted:
                source = region_dir(WORLD_ROOT) / f"r.{x}.{z}.mca"
                shutil.copyfile(source, world / "dimensions/minecraft/overworld/region"
                                / source.name)
            snapshot = _Snapshot(world)
            serial = render.render_all(snapshot, Path(temporary) / "serial", workers=1,
                                       log=lambda _line: None)
            parallel = render.render_all(snapshot, Path(temporary) / "parallel", workers=2,
                                         log=lambda _line: None)
            self.assertEqual(parallel.workers, 2)
            self.assertEqual(
                {(tile.x, tile.z): tile.version for tile in serial.tiles},
                {(tile.x, tile.z): tile.version for tile in parallel.tiles},
                "two worker processes produced different tiles than one did")
            self.assertEqual(len(parallel.tiles), len(wanted))

    def test_the_pool_context_is_fork_where_fork_exists(self):
        context = render.pool_context()
        if os.name != "posix":
            self.assertIsNone(context)
        else:
            self.assertEqual(context.get_start_method(), "fork",
                             "the pool must not re-import the caller's __main__")


class CacheKeyTests(unittest.TestCase):
    """The cache is keyed on the world root, not its inode: that is the whole point."""

    @unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
    def test_two_roots_at_the_same_path_hit_one_cache_even_after_a_reextract(self):
        if not region_dir(WORLD_ROOT).is_dir():
            self.skipTest(f"no world tree at {WORLD_ROOT}")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "world"
            region = root / "dimensions/minecraft/overworld/region"
            region.mkdir(parents=True)
            x, z = published_tiles(1)[0]
            source = region_dir(WORLD_ROOT) / f"r.{x}.{z}.mca"
            shutil.copy2(source, region / source.name)
            cache = Path(temporary) / "cache"

            modules = renderer.use(world_root=root, tile_cache=cache)
            modules.terrain.metadata()
            first, first_report = modules.terrain.tile(x, z)
            first_bytes = Path(first).read_bytes()

            # A fresh extraction of the same snapshot at the same path: a new file with a new
            # inode, identical content and preserved mtime -- exactly what unpacking the same
            # tarball again produces.
            shutil.rmtree(root)
            region.mkdir(parents=True)
            shutil.copy2(source, region / source.name)
            modules = renderer.use(world_root=root, tile_cache=cache)
            second, second_report = modules.terrain.tile(x, z)
            self.assertEqual(first_bytes, Path(second).read_bytes())
            # One cache directory for one world root: the key is the root's path, so the new
            # inode did not throw the cached tile away.
            self.assertEqual(Path(first), Path(second))
            self.assertEqual(first_report["region_mtime_ns"], second_report["region_mtime_ns"])

    @unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
    def test_two_different_roots_do_not_share_a_cache_entry(self):
        if not region_dir(WORLD_ROOT).is_dir():
            self.skipTest(f"no world tree at {WORLD_ROOT}")
        x, z = published_tiles(1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            folders = []
            for name in ("a", "b"):
                root = Path(temporary) / name / "world"
                region = root / "dimensions/minecraft/overworld/region"
                region.mkdir(parents=True)
                source = region_dir(WORLD_ROOT) / f"r.{x}.{z}.mca"
                shutil.copyfile(source, region / source.name)
                modules = renderer.use(world_root=root, tile_cache=Path(temporary) / "cache")
                path, _report = modules.terrain.tile(x, z)
                folders.append(Path(path).parent)
            self.assertNotEqual(folders[0], folders[1],
                                "two world roots shared one cache key")


class _Snapshot:
    """The two attributes `render_all` needs from a capture."""

    def __init__(self, world_root):
        self.world_root = Path(world_root)
        self.region_dir = region_dir(world_root)


if __name__ == "__main__":
    unittest.main()
