# VENDORED -- do not edit by hand.
#
# Copied from e-server's core/minecraft_map.py by scripts/atlas/renderer/vendor.py, which is the only
# writer of this file. Upstream sha256 b90f6a98594e1d4ef110f300d1b156210d487326bbecc66db64291a442d3b1f3.
# Re-vendor with `python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --write`;
# tests/test_atlas_renderer_vendor.py fails when this copy and that script disagree.
"""Read-only surface tiles from saved Overworld Anvil chunks; never generate terrain."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import threading
import time
import zlib
from PIL import Image
from .minecraft_nbt import parse

WORLD = Path(os.environ.get("ATLAS_WORLD_ROOT") or "/opt/minecraft/server/world")
CACHE = Path(os.environ.get("ATLAS_TILE_CACHE") or "/var/cache/e-server/minecraft-map")
REGION_NAME = re.compile(r"r\.(-?\d+)\.(-?\d+)\.mca$")
_LOCK = threading.Semaphore(2)
AIR = {"minecraft:air", "minecraft:cave_air", "minecraft:void_air"}
#: How hard `tile()` tries to catch a region between writes before it gives up and serves
#: the most recent complete render instead.  Measured on the live world: a region a player
#: stands in has its mtime move every ~8s while a render costs ~2.5s, so two or three
#: attempts catch a stable window; the budget stops a pathological world from holding a
#: request open indefinitely.  A stale-but-real tile always beats an error square.
RACE_ATTEMPTS = 4
RACE_SLEEP_SECONDS = 0.4
RACE_BUDGET_SECONDS = 12.0

#: The mod's whole-zone safe-zone box, read from source rather than copied.  The live
#: reader for players, ships and NPCs is `core/minecraft_map_data.py`; this is the one map
#: fact that module does not own, because its authority is Java source, not a world save.
NAVY_PATROL_JAVA = Path(os.environ.get("ATLAS_NAVY_PATROL_JAVA")
                       or "/opt/minecraft/navy-mod/src/main/java/com/easter/navy/NavyPatrol.java")
#: `int NAME = <literal>;` -- one constant per match.  `VILLAGE_MIN_X` cannot match a
#: `MIN_X` search because `_ZONE_CONSTANT` anchors on a word boundary in FRONT of the name
#: too, and `VILLAGE_MIN_X` has `_` there, which is a word character.
_ZONE_CONSTANT = re.compile(
    r"\b(MIN_X|MAX_X|MIN_Z|MAX_Z)\s*=\s*([0-9()+\-*/\s]+?)\s*;")
_SAFE_ZONE_CACHE = {"stamp": None, "value": None}
_SAFE_ZONE_LOCK = threading.Lock()

def parse_zone_box(text):
    """Extract the whole-zone box from `NavyPatrol.java` source.  Pure; raises on failure.

    Raises rather than returning a guess: the caller must not be able to turn
    "I could not read the boundary" into "here is a boundary".
    """
    if text is None:
        raise ValueError("no source text")
    found = {}
    for name, expression in _ZONE_CONSTANT.findall(text):
        if name in found:
            raise ValueError(f"{name} declared more than once")
        try:
            found[name] = int(eval(expression, {"__builtins__": {}}, {}))  # noqa: S307
        except Exception as exc:
            raise ValueError(f"{name} = {expression!r} is not an int expression") from exc
    missing = [n for n in ("MIN_X", "MAX_X", "MIN_Z", "MAX_Z") if n not in found]
    if missing:
        raise ValueError("missing constants: " + ", ".join(missing))
    if found["MIN_X"] > found["MAX_X"] or found["MIN_Z"] > found["MAX_Z"]:
        raise ValueError("zone box is inverted: " + repr(found))
    return found

def safe_zone():
    """The spawn-island safe-zone box, read from the mod's own constants at render time.

    THE MOD IS THE AUTHORITY: `NavyPatrol.MIN_X/MAX_X/MIN_Z/MAX_Z` (the ZONE box that
    `NavyPatrol.inZone` tests against -- NOT the inner `VILLAGE_MIN_*` garrison box).
    Reading it live is deliberate.  A second copy of these numbers in e-server would drift
    the moment the island moves, and a border drawn in the wrong place is worse than no
    border: it is a claim about where players are safe.

    The box is INCLUSIVE at both ends, exactly as `inZone` is (`x <= MAX_X + 1` admits
    block coordinate MAX_X).  We return the block coordinates, and the renderer offsets
    the MAX edges by one block when it converts blocks to pixels.

    Returns a dict, or None when the source cannot be read or parsed -- in which case the
    caller draws NOTHING and says so.  Never returns a guessed box.
    """
    path = NAVY_PATROL_JAVA
    try:
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
    except OSError as exc:
        _log_zone_failure(f"cannot stat {path}: {exc}")
        return None
    with _SAFE_ZONE_LOCK:
        if _SAFE_ZONE_CACHE["stamp"] == stamp and _SAFE_ZONE_CACHE["value"] is not None:
            return _SAFE_ZONE_CACHE["value"]
    try:
        box = parse_zone_box(path.read_text(encoding="utf8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        _log_zone_failure(f"cannot read safe-zone constants from {path}: {exc}")
        return None
    result = {"source": str(path), **box,
              "inclusive_max": True,
              "note": "Whole-zone box (NavyPatrol.MIN_X..MAX_Z). MAX edges are inclusive block coordinates."}
    with _SAFE_ZONE_LOCK:
        _SAFE_ZONE_CACHE["stamp"] = stamp
        _SAFE_ZONE_CACHE["value"] = result
    return result

def _log_zone_failure(message):
    """Fail loudly: a missing safe-zone boundary must be visible in the log, not silent."""
    print(f"[minecraft-map] SAFE ZONE UNAVAILABLE -- drawing no border: {message}", flush=True)

def region_dir():
    modern = WORLD / "dimensions/minecraft/overworld/region"
    return modern if modern.exists() else WORLD / "region"

def regions():
    rows = []
    for p in region_dir().glob("r.*.*.mca"):
        match = REGION_NAME.fullmatch(p.name)
        if not match:
            continue
        try:
            st = p.stat()
            with p.open("rb") as stream:
                header = stream.read(4096)
            if len(header) != 4096:
                continue
            count = sum(bool(int.from_bytes(header[i:i+3],"big")) for i in range(0,4096,4))
            if count:
                rows.append({"x":int(match[1]),"z":int(match[2]),"slots":count,
                             "version":str(st.st_mtime_ns)+"-"+str(st.st_size)})
        except OSError:
            continue
    return rows

def metadata():
    rows = regions()
    center = [-624,-192]
    try:
        level = parse(gzip.decompress((WORLD/"level.dat").read_bytes())).get("Data",{})
        spawn = level.get("spawn",{})
        pos = spawn.get("pos")
        if pos:
            center = [pos[0],pos[2]]
        elif "SpawnX" in level:
            center = [level["SpawnX"],level["SpawnZ"]]
    except (OSError, ValueError, EOFError, IndexError, struct.error):
        pass
    return {"regions":rows,"center":center,"region_blocks":512,"pixel_blocks":2,
            "saved_chunk_slots":sum(r["slots"] for r in rows),
            "checked_at":time.time(),"coverage":"Saved fully generated chunks, not tracked player exploration."}

def read_chunk(stream, entry):
    offset = int.from_bytes(entry[:3],"big")
    if not offset:
        return None
    stream.seek(offset*4096)
    length_bytes=stream.read(4)
    if len(length_bytes)!=4:
        raise ValueError("Incomplete chunk length")
    length=struct.unpack(">I",length_bytes)[0]
    if length<1 or length>16*1024*1024:
        raise ValueError("Invalid chunk length")
    compression=stream.read(1)[0]
    if compression & 128:
        raise ValueError("External chunk data is not supported")
    raw=stream.read(length-1)
    if len(raw)!=length-1:
        raise ValueError("Chunk write in progress")
    if compression==1:
        raw=gzip.decompress(raw)
    elif compression==2:
        raw=zlib.decompress(raw)
    elif compression!=3:
        raise ValueError("Unsupported compression")
    return parse(raw)

def block(section, x, y, z):
    bs=section.get("block_states",{})
    palette=bs.get("palette",[])
    if not palette:
        return "minecraft:air"
    if len(palette)==1:
        return palette[0]["Name"]
    bits=max(4,(len(palette)-1).bit_length())
    per=64//bits
    index=(y*16+z)*16+x
    packed=bs.get("data",[])
    if index//per >= len(packed):
        raise ValueError("Incomplete block palette")
    slot=((packed[index//per]&0xffffffffffffffff)>>((index%per)*bits))&((1<<bits)-1)
    if slot>=len(palette):
        raise ValueError("Invalid palette index")
    return palette[slot]["Name"]

def surface(chunk, x, z):
    for section in sorted(chunk.get("sections",[]), key=lambda s:s["Y"], reverse=True):
        palette=section.get("block_states",{}).get("palette",[])
        if not palette or all(p["Name"] in AIR for p in palette):
            continue
        for y in range(15,-1,-1):
            name=block(section,x,y,z)
            if name not in AIR:
                return name,section["Y"]*16+y
    return None

def color(name, height):
    bare=name.split(":")[-1]
    if "water" in bare or bare in ("kelp","kelp_plant","seagrass","tall_seagrass"):
        rgb=(35,91,126)
    elif "lava" in bare:
        rgb=(235,108,38)
    elif any(v in bare for v in ("snow","ice","quartz")):
        rgb=(209,223,226)
    elif any(v in bare for v in ("leaves","grass","moss","fern","vine")):
        rgb=(72,113,64)
    elif any(v in bare for v in ("sand","end_stone")):
        rgb=(198,180,128)
    elif any(v in bare for v in ("log","wood","planks","dirt","mud","path")):
        rgb=(129,103,72)
    elif any(v in bare for v in ("stone","brick","gravel","ore","concrete")):
        rgb=(126,137,138)
    else:
        rgb=(151,140,114)
    shade=max(.72,min(1.25,1+(height-64)*.003))
    return tuple(min(255,int(c*shade)) for c in rgb)+(255,)

def render_region(path):
    image=Image.new("RGBA",(256,256),(0,0,0,0))
    pixels=image.load()
    completed=failed=0
    with path.open("rb") as stream:
        header=stream.read(4096)
        if len(header)!=4096:
            raise ValueError("Incomplete region header")
        for i in range(1024):
            if not int.from_bytes(header[i*4:i*4+3],"big"):
                continue
            try:
                chunk=read_chunk(stream,header[i*4:i*4+4])
                if chunk.get("Status") not in ("full","minecraft:full"):
                    continue
                # Buffer each chunk; malformed writes cannot leave half a chunk visible.
                patch=[]
                for z in range(1,16,2):
                    for x in range(1,16,2):
                        top=surface(chunk,x,z)
                        if top:
                            patch.append((x//2,z//2,color(*top)))
                for x,z,rgb in patch:
                    pixels[(i%32)*8+x,(i//32)*8+z]=rgb
                completed+=1
            except (ValueError, IndexError, KeyError, EOFError, struct.error, zlib.error):
                failed+=1
    out=io.BytesIO()
    image.save(out,"PNG")
    return out.getvalue(),completed,failed

def tile(rx,rz):
    path=region_dir()/f"r.{rx}.{rz}.mca"
    if not path.is_file():
        raise FileNotFoundError("No saved region")
    st=path.stat()
    world_id=str(WORLD.resolve())
    key=hashlib.sha256((str(path.resolve())+world_id).encode()).hexdigest()[:16]
    folder=CACHE/key
    target=folder/f"{st.st_mtime_ns}-{st.st_size}.png"
    report=target.with_suffix(".json")
    # A tile cached for exactly this region state is always the best answer, and serving it
    # here is what keeps a region that is being written from costing a render per request.
    if target.exists() and report.exists():
        return target,json.loads(report.read_text())
    # A region is ALWAYS being written while a player stands in it (measured: mtime moved
    # every ~8s, a render takes ~2.5s), so the tile for a player's OWN chunk is the one
    # that used to fail -- and a 503 becomes an empty outlined square with no image in it.
    # The guard stays, because a mid-write read can tear a region; what changes is that a
    # write is now TOLERATED instead of turned into an error.  Attempts are cheap once the
    # tile is cached; this loop is the price of correctness on a live world.
    deadline=time.monotonic()+RACE_BUDGET_SECONDS
    for attempt in range(1,RACE_ATTEMPTS+1):
        before=path.stat()
        png,complete,failed=render_region(path)
        after=path.stat()
        if after.st_mtime_ns==before.st_mtime_ns and after.st_size==before.st_size:
            return _store(folder,path,after,png,complete,failed,stale=False,attempts=attempt)
        # The region moved under the render.  A complete-but-older tile always beats an
        # error square, so fall back to the most recent render we finished rather than
        # raising -- but say plainly that it is stale.
        previous=_last_complete(folder,target)
        if previous is not None:
            return _store(folder,path,after,png,complete,failed,stale=True,attempts=attempt,
                          fallback=previous)
        if time.monotonic()>=deadline:
            break
        time.sleep(RACE_SLEEP_SECONDS)
    # Nothing settled and there is no earlier render to fall back on.  This is the only
    # case that still raises, and the API turns it into 503.
    raise RuntimeError("Region is being saved; retry shortly")

def _last_complete(folder,target):
    """The newest finished render in the cache, or None.  Used as the stale fallback."""
    best=None
    for old in folder.glob("*.png"):
        if old==target:
            continue
        try:
            stamp=int(old.stem.split("-")[0])
        except (ValueError,IndexError):
            continue
        if best is None or stamp>best[0]:
            best=(stamp,old)
    return None if best is None else best[1]

def _store(folder,path,stat_now,png,complete,failed,stale,attempts,fallback=None):
    key=f"{stat_now.st_mtime_ns}-{stat_now.st_size}"
    target=folder/f"{key}.png"
    report=target.with_suffix(".json")
    with _LOCK:
        if target.exists() and report.exists():
            return target,json.loads(report.read_text())
        folder.mkdir(parents=True,exist_ok=True)
        temporary=target.with_suffix(".tmp-"+str(threading.get_ident()))
        temporary.write_bytes(png)
        os.replace(temporary,target)
        details={"completed":complete,"unreadable":failed,"stale":bool(stale),
                 "attempts":attempts,"region_mtime_ns":stat_now.st_mtime_ns,
                 "region_size":stat_now.st_size}
        if stale and fallback is not None:
            details["fallback"]=fallback.name
        report.write_text(json.dumps(details))
        if not stale:
            # Only a settled render may evict a settled render.
            for old in folder.glob("*.png"):
                if old!=target and old!=fallback:
                    old.unlink(missing_ok=True)
                    old.with_suffix(".json").unlink(missing_ok=True)
        return target,details
