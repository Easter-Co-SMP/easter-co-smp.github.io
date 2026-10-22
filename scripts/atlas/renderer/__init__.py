"""The atlas pipeline's vendored copy of e-server's terrain renderer.

Three modules live here, copied from `/root/e-server/core/` by `vendor.py` and never edited
by hand: `minecraft_map.py` (saved region -> 256x256 PNG tile), `minecraft_map_data.py`
(ship and NPC records from the mod's own roster files and the last-known position store)
and `minecraft_nbt.py` (a minimal NBT reader). `VENDORED.json` records the upstream hash of
each one and the exact substitutions this repository applies.

Everything the pipeline needs to change about them is one of two things: where the world
tree is, and where the tile cache is. Both are roots, set with `use()` / `use_records()`
below (or with the same environment variables in a render subprocess).

The modules read their paths at import time -- `minecraft_map_data` derives eight constants
from `SERVER` -- so a change of root reimports them rather than trying to patch each
constant. That keeps the upstream derivation the single place where paths are computed.

The two loaders are separate on purpose: reading markers needs only the standard library,
while rendering needs Pillow, so a document can be built from a capture on a machine with no
imaging library installed.
"""
from __future__ import annotations

import importlib
import os
from pathlib import Path
import sys
import types

#: Environment variables the vendored modules read (see `vendor.py` for why each exists).
WORLD_ROOT_VAR = "ATLAS_WORLD_ROOT"
SERVER_ROOT_VAR = "ATLAS_SERVER_ROOT"
TILE_CACHE_VAR = "ATLAS_TILE_CACHE"
NAVY_JAVA_VAR = "ATLAS_NAVY_PATROL_JAVA"

_RECORD_MODULES = ("minecraft_nbt", "map_zones", "minecraft_map_data")
_ALL_MODULES = ("minecraft_nbt", "map_zones", "minecraft_map_data", "minecraft_map")
_loaded_roots = None


def _apply(world_root=None, server_root=None, tile_cache=None, navy_patrol_java=None):
    """Set the environment the vendored modules read, and reload them if a root moved."""
    global _loaded_roots
    wanted = {
        WORLD_ROOT_VAR: None if world_root is None else str(Path(world_root)),
        SERVER_ROOT_VAR: None if server_root is None else str(Path(server_root)),
        TILE_CACHE_VAR: None if tile_cache is None else str(Path(tile_cache)),
        NAVY_JAVA_VAR: None if navy_patrol_java is None else str(Path(navy_patrol_java)),
    }
    for variable, value in wanted.items():
        if value is not None:
            os.environ[variable] = value
    roots = tuple(os.environ.get(variable) for variable in wanted)
    if _loaded_roots is not None and roots != _loaded_roots:
        # Reload only the modules already in memory. Importing `minecraft_map` here would pull
        # in Pillow, which the marker reader does not need and a document build must not
        # require: with no Pillow installed, reloading what is loaded keeps the two loaders
        # genuinely independent.
        for name in _ALL_MODULES:
            module = sys.modules.get(f"{__name__}.{name}")
            if module is not None:
                importlib.reload(module)
    _loaded_roots = roots


def use(world_root=None, server_root=None, tile_cache=None, navy_patrol_java=None):
    """Point the vendored renderer at a world tree and return all three modules.

    Returns a namespace with `terrain` (minecraft_map), `records` (minecraft_map_data) and
    `nbt` (minecraft_nbt). Needs Pillow, because `terrain` does.
    """
    _apply(world_root, server_root, tile_cache, navy_patrol_java)
    return types.SimpleNamespace(
        terrain=importlib.import_module(".minecraft_map", __name__),
        records=importlib.import_module(".minecraft_map_data", __name__),
        nbt=importlib.import_module(".minecraft_nbt", __name__),
    )


def use_records(server_root=None, tile_cache=None):
    """Point only the marker reader, which needs no imaging library."""
    _apply(None, server_root, tile_cache, None)
    return types.SimpleNamespace(
        records=importlib.import_module(".minecraft_map_data", __name__),
        zones=importlib.import_module(".map_zones", __name__),
        nbt=importlib.import_module(".minecraft_nbt", __name__),
    )
