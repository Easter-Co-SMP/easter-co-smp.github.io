#!/usr/bin/env python3
"""Re-vendor e-server's terrain renderer into this repository, mechanically.

Why this file exists
--------------------
The public map's renderer is owned by e-server (`/root/e-server/core/minecraft_map.py`,
`minecraft_map_data.py`, `minecraft_nbt.py`). The atlas pipeline has to run that same
renderer with no e-server process, no `/opt/minecraft` layout and no local Minecraft
server, so the three modules are copied here. A copy that nobody can check is a fork that
drifts silently, so the copy is *generated*: this script is the only thing allowed to
write the vendored files, it applies exactly the substitutions below, and it records the
upstream hash of every file it read. `scripts/atlas/renderer/VENDORED.json` is the record.

`tests/test_atlas_renderer_vendor.py` re-runs this script into a temporary directory and
fails when the committed copies differ from what it produces, and independently fails when
the upstream files on this machine no longer hash to the recorded values. Either way the
failure says "re-vendor deliberately", which is the whole point: drift must be a decision
somebody made, never an accident that shows up as subtly different tiles.

Usage:
    python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --write
    python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --output DIR

The substitutions are exact literals and each one must occur exactly once in its file, so
an upstream edit that moves or reshapes any of them fails this script instead of producing
a half-patched module.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
DEFAULT_UPSTREAM = Path("/root/e-server")
MANIFEST = HERE / "VENDORED.json"

#: Vendored file name -> the upstream path inside the e-server checkout.
SOURCES = {
    "minecraft_map.py": "core/minecraft_map.py",
    "minecraft_map_data.py": "core/minecraft_map_data.py",
    "minecraft_nbt.py": "core/minecraft_nbt.py",
    # A fourth, beyond the three the ticket names: `minecraft_map_data.patrol_groups()` does
    # `from core.map_zones import read_document` at call time, so without this the marker
    # reader raises ModuleNotFoundError on the second NPC roster it sees.
    "map_zones.py": "core/map_zones.py",
}

#: Every substitution, as (file, upstream literal, vendored literal, why).
#:
#: The rules: the world tree and the server root become environment-overridable, the tile
#: cache is keyed on the world root's *path* instead of its inode, and the three modules
#: import each other relatively because here they are a package. Nothing else changes, so
#: a re-vendor is provably "upstream plus this list".
SUBSTITUTIONS = (
    (
        "minecraft_map.py",
        'from core.minecraft_nbt import parse',
        'from .minecraft_nbt import parse',
        "these three modules are a package inside the pipeline, not e-server's core/",
    ),
    (
        "minecraft_map.py",
        'WORLD = Path("/opt/minecraft/server/world")',
        'WORLD = Path(os.environ.get("ATLAS_WORLD_ROOT") or "/opt/minecraft/server/world")',
        "the pipeline renders an extracted snapshot, not the live world tree",
    ),
    (
        "minecraft_map.py",
        'CACHE = Path("/var/cache/e-server/minecraft-map")',
        'CACHE = Path(os.environ.get("ATLAS_TILE_CACHE") or "/var/cache/e-server/minecraft-map")',
        "a GitHub runner has no /var/cache/e-server and no writable parent to create one in",
    ),
    (
        "minecraft_map.py",
        '    world_id=str(WORLD.stat().st_ino)',
        '    world_id=str(WORLD.resolve())',
        "the cache must be keyed on the world ROOT, not its inode: a fresh extraction of the "
        "same snapshot changes the inode and would throw the cache away every run",
    ),
    (
        "minecraft_map.py",
        'NAVY_PATROL_JAVA = Path("/opt/minecraft/navy-mod/src/main/java/com/easter/navy/NavyPatrol.java")',
        'NAVY_PATROL_JAVA = Path(os.environ.get("ATLAS_NAVY_PATROL_JAVA")\n'
        '                       or "/opt/minecraft/navy-mod/src/main/java/com/easter/navy/NavyPatrol.java")',
        "the safe-zone box is read from the mod's source, which the pipeline does not carry; "
        "an unreadable box draws no border and says so, which is the upstream behaviour",
    ),
    (
        "minecraft_map_data.py",
        'from core.minecraft_nbt import parse',
        'from .minecraft_nbt import parse',
        "the same package-relative import as minecraft_map.py",
    ),
    (
        "minecraft_map_data.py",
        'SERVER = Path("/opt/minecraft/server")',
        'SERVER = Path(os.environ.get("ATLAS_SERVER_ROOT") or "/opt/minecraft/server")',
        "every other path in this module is derived from SERVER, so one override moves the "
        "whole reader onto an extracted snapshot",
    ),
    (
        "minecraft_map_data.py",
        'CACHE = Path("/var/cache/e-server/minecraft-map")',
        'CACHE = Path(os.environ.get("ATLAS_TILE_CACHE") or "/var/cache/e-server/minecraft-map")',
        "this module's last-known position store lives under CACHE; the pipeline points it at "
        "the store the capture carries, because a runner has no /var/cache/e-server",
    ),
    (
        "minecraft_map_data.py",
        '        from core.map_zones import read_document',
        '        from .map_zones import read_document',
        "same package-relative import: map_zones.py is vendored beside this module",
    ),
    (
        "minecraft_nbt.py",
        'WORLD = "/opt/minecraft/server/world"',
        'WORLD = os.environ.get("ATLAS_WORLD_ROOT") or "/opt/minecraft/server/world"',
        "this module's CLI is the only user of WORLD; keep it pointed at the same root",
    ),
)

HEADER = """# VENDORED -- do not edit by hand.
#
# Copied from e-server's {upstream} by scripts/atlas/renderer/vendor.py, which is the only
# writer of this file. Upstream sha256 {upstream_sha256}.
# Re-vendor with `python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --write`;
# tests/test_atlas_renderer_vendor.py fails when this copy and that script disagree.
"""


class VendorError(RuntimeError):
    """An upstream file no longer has the shape this script knows how to patch."""


def vendored_text(name, source, upstream_sha256):
    """Apply the documented substitutions for one file. Raises rather than half-patching."""
    text = source
    for filename, before, after, _why in SUBSTITUTIONS:
        if filename != name:
            continue
        count = text.count(before)
        if count != 1:
            raise VendorError(
                f"{name}: expected exactly one occurrence of {before!r}, found {count}. "
                "Upstream changed shape: read the change and update SUBSTITUTIONS "
                "deliberately before re-vendoring.")
        text = text.replace(before, after)
    return HEADER.format(upstream=SOURCES[name], upstream_sha256=upstream_sha256) + text


def build(upstream_root):
    """Return {filename: (text, upstream_sha256)} for every vendored module."""
    upstream_root = Path(upstream_root)
    built = {}
    for name, relative in SOURCES.items():
        path = upstream_root / relative
        try:
            raw = path.read_bytes()
        except OSError as error:
            raise VendorError(f"cannot read upstream {path}: {error}") from error
        digest = hashlib.sha256(raw).hexdigest()
        built[name] = (vendored_text(name, raw.decode("utf8"), digest), digest)
    return built


def manifest_for(built):
    return {
        "schema": 1,
        "note": "Generated by scripts/atlas/renderer/vendor.py. Upstream is e-server; "
                "re-vendoring is a deliberate act, and this file is what makes an "
                "undeliberate one fail.",
        "substitutions": [
            {"file": name, "upstream": before, "vendored": after, "why": why}
            for name, before, after, why in SUBSTITUTIONS
        ],
        "files": {
            name: {"upstream": SOURCES[name], "upstream_sha256": digest}
            for name, (_text, digest) in sorted(built.items())
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM,
                        help="e-server checkout to copy from (read-only)")
    parser.add_argument("--output", type=Path, default=None,
                        help="write the modules here instead of over the committed copies")
    parser.add_argument("--write", action="store_true",
                        help="write into scripts/atlas/renderer/ and update VENDORED.json")
    parser.add_argument("--check", action="store_true",
                        help="exit 1 if the committed copies are not what this would write")
    args = parser.parse_args(argv)
    if not (args.write or args.check or args.output):
        parser.error("choose --write, --check or --output")

    try:
        built = build(args.upstream)
    except VendorError as error:
        print(f"vendor: {error}", file=sys.stderr)
        return 2

    target = args.output or HERE
    if args.write:
        target.mkdir(parents=True, exist_ok=True)
        for name, (text, _digest) in built.items():
            path = target / name
            path.write_text(text, encoding="utf8", newline="\n")
            print(f"vendor: wrote {path.relative_to(REPO_ROOT)}")
        MANIFEST.write_text(json.dumps(manifest_for(built), indent=2) + "\n",
                            encoding="utf8", newline="\n")
        print(f"vendor: wrote {MANIFEST.relative_to(REPO_ROOT)}")
        return 0

    stale = []
    for name, (text, _digest) in built.items():
        path = target / name
        current = path.read_text(encoding="utf8") if path.exists() else None
        if current != text:
            stale.append(name)
    if args.output:
        # --output only reports what it would write; the caller (a test) reads the files.
        target.mkdir(parents=True, exist_ok=True)
        for name, (text, _digest) in built.items():
            (target / name).write_text(text, encoding="utf8", newline="\n")
        return 0
    if stale:
        print("vendor: committed copies are not upstream plus the documented substitutions: "
              + ", ".join(stale), file=sys.stderr)
        return 1
    print("vendor: committed copies match upstream plus the documented substitutions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
