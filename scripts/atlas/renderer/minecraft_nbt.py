# VENDORED -- do not edit by hand.
#
# Copied from e-server's core/minecraft_nbt.py by scripts/atlas/renderer/vendor.py, which is the only
# writer of this file. Upstream sha256 eff00ec8d5bc7a81c527e6ac71b2af06f283a14728cc978cd0c55e1c2927d9ba.
# Re-vendor with `python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --write`;
# tests/test_atlas_renderer_vendor.py fails when this copy and that script disagree.
#!/usr/bin/env python3
"""Minimal Minecraft NBT / Anvil reader -- no third-party libs on this box.

Built 2026-10-08 to answer one question the paused server refuses to: *what is the
ground Y at the spawn island?* `if block` / entity selectors do not evaluate while
the server is paused (see NOTES.md), so the save file is the only source of truth.
That Y decides whether `/trigger reset`'s `spawnpoint` drops the player or lands them.

Usage:
    nbtpeek.py level                 -> level.dat top-level keys + spawn position
    nbtpeek.py col <x> <z>           -> ground Y at world x,z from the chunk heightmap
    nbtpeek.py keys <region> <cx> <cz>
"""
import os
import struct

WORLD = os.environ.get("ATLAS_WORLD_ROOT") or "/opt/minecraft/server/world"
# 26.2 layout: every dimension lives under dimensions/<namespace>/<path>/, so the
# overworld regions are NOT in world/region/ (that is the pre-1.21 location).
REGION = os.path.join(WORLD, "dimensions", "minecraft", "overworld", "region")


class Reader:
    def __init__(self, buf):
        self.b = buf
        self.i = 0

    def u(self, n, fmt):
        v = struct.unpack_from(">" + fmt, self.b, self.i)[0]
        self.i += n
        return v

    def byte(self):
        return self.u(1, "b")

    def short(self):
        return self.u(2, "h")

    def ushort(self):
        return self.u(2, "H")

    def int(self):
        return self.u(4, "i")

    def long(self):
        return self.u(8, "q")

    def float(self):
        return self.u(4, "f")

    def double(self):
        return self.u(8, "d")

    def string(self):
        n = self.ushort()
        s = self.b[self.i:self.i + n].decode("utf8", "replace")
        self.i += n
        return s

    def payload(self, t):
        if t == 0:
            return None
        if t == 1:
            return self.byte()
        if t == 2:
            return self.short()
        if t == 3:
            return self.int()
        if t == 4:
            return self.long()
        if t == 5:
            return self.float()
        if t == 6:
            return self.double()
        if t == 7:
            n = self.int()
            v = self.b[self.i:self.i + n]
            self.i += n
            return v
        if t == 8:
            return self.string()
        if t == 9:
            et = self.byte()
            n = self.int()
            return [self.payload(et) for _ in range(n)]
        if t == 10:
            out = {}
            while True:
                tt = self.byte()
                if tt == 0:
                    return out
                name = self.string()
                out[name] = self.payload(tt)
        if t == 11:
            n = self.int()
            return [self.int() for _ in range(n)]
        if t == 12:
            n = self.int()
            return [self.long() for _ in range(n)]
        raise ValueError("unknown tag type %d at %d" % (t, self.i))


def parse(data):
    r = Reader(data)
    t = r.byte()
    if t != 10:
        raise ValueError("root is not a compound (type %d)" % t)
    r.string()
    return r.payload(10)
