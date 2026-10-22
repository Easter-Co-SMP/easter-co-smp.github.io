# VENDORED -- do not edit by hand.
#
# Copied from e-server's core/minecraft_map_data.py by scripts/atlas/renderer/vendor.py, which is the only
# writer of this file. Upstream sha256 1eca11de080e727c33823a17808acd0fe7f3a20d8058375c0a36a43d5a02b40d.
# Re-vendor with `python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --write`;
# tests/test_atlas_renderer_vendor.py fails when this copy and that script disagree.
"""ONE reader for every live world fact the map shows, with the source and age attached.

Why this module exists (2026-10-14 hardening rewrite)
-----------------------------------------------------
`/minecraft/map-editor` used to show terrain only, so it had no way to be wrong about anything
but pixels.  It now shows players, ships and named NPCs, and those facts have **two**
possible sources that can disagree:

* **live**  -- ``api.minecraft_ctl.send_console`` drives the running server's console FIFO
  and returns what the command printed.  True right now; unavailable when a chunk is not
  loaded, when the command is rejected, when the console does not answer, or when the
  server is stopped (``send_console`` raises immediately with ENXIO there, deliberately).
* **saved** -- world files on disk (``world/players/data/<uuid>.dat``, ``usercache.json``,
  ``world/data/minecraft/scoreboard.dat``).  Always available while the file is; up to the
  world save interval old.  Measured 2026-10-14: a player ``.dat`` went 17:24:01 ->
  17:29:03, so ~5 minutes is the honest bound.

The defect this module exists to prevent is a fact that two sources feed *silently*: the
reader picks one, and nothing in the answer says which.  So:

**Every record says which source answered and how old that answer is.**  A record carries
exactly one value.  ``source`` says where it came from, and ``age_seconds``/``stale`` say
how much to trust it.  There is no field that means "live and saved blended".

Single source of truth per fact
-------------------------------
======================================  =========================  ======================
fact                                     authority                  source label
======================================  =========================  ======================
player name                             ``usercache.json``         saved
player faction                          ``status_code`` objective   saved
player level                            ``XpLevel`` in the .dat     saved
player online/offline                   ``list`` console command    live
player current position                 console ``data get entity`` live, else saved
player log-off point                    the .dat                    saved
which ships exist                       ``easter-fleet-ships.json`` saved
ship position                           console by UUID             live, else last known
which named NPCs exist                   the mod's roster files     saved
NPC position                            console by UUID             live, else last known
terrain pixels                          region ``.mca`` files       saved
======================================  =========================  ======================

Faction is **never** re-derived from other objectives.  ``status_code`` is the displayed,
client-visible statement of a player's state and is present for every known player
(verified: Owen and Hannah both 1).  ``faction``/``criminal`` are not consulted at all --
a second opinion here is exactly the duplicate-answer defect the rewrite is against.

Absence is a STATE, not an error and not a zero
-----------------------------------------------
An entity in an unloaded chunk answers ``No entity was found`` from the console.  That is
verified, not assumed: the six registered ships sit 300-600 blocks from the only player, so
every query for them returns exactly that.  Such a record is ``state="not_loaded"`` with its
last known reading and that reading's age -- it is never drawn as if current and never
reported as an error.  The same rule covers a missing ``.dat``, a torn file, a console that
does not answer inside the wait window, a rejected command, and a stopped server.

An unreadable fact is reported unavailable rather than guessed.  A registry file that
cannot be parsed yields zero entities and an ``unavailable`` note on the layer, because a
wrong ship list is worse than an empty one.
"""
from __future__ import annotations

import copy
import gzip
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .minecraft_nbt import parse

SERVER = Path(os.environ.get("ATLAS_SERVER_ROOT") or "/opt/minecraft/server")
WORLD = SERVER / "world"
REGION_DIR = WORLD / "dimensions/minecraft/overworld/region"
USERCACHE = SERVER / "usercache.json"
SCOREBOARD = WORLD / "data/minecraft/scoreboard.dat"
PLAYER_DATA = WORLD / "players/data"
FLEET = SERVER / "config/easter-fleet-ships.json"
CACHE = Path(os.environ.get("ATLAS_TILE_CACHE") or "/var/cache/e-server/minecraft-map")
LAST_KNOWN = CACHE / "map-last-known.json"

#: Named-NPC rosters, written by the mod.  Each is the authority for *which* named NPCs
#: exist; positions always come from the live console.
NPC_ROSTERS = (
    ("villager", SERVER / "config/easter-navy-villagers.txt", "name_first"),
    ("islander", SERVER / "config/easter-navy-islanders.txt", "uuid_first"),
    ("sailor", SERVER / "config/easter-navy-garrison.txt", "uuid_only"),
    ("region_guard", SERVER / "config/easter-region-guards.json", "region_json"),
    ("wildlife", SERVER / "config/easter-navy-wildlife.txt", "uuid_only"),
)

#: Named-wildlife is the one layer that is off unless a human asks for it: it would put
#: every island animal on the map.
DEFAULT_OFF_LAYERS = frozenset({"wildlife"})

#: The world saves about every 5 minutes (measured 2026-10-14), so a saved reading stops
#: being a claim about *now* once it is older than that.
SAVED_STALE_AFTER = 300.0

#: Faction codes, and only these.  From the ``status_code`` objective.
FACTION_BY_CODE = {1: "navy", 2: "citizen", 3: "criminal", 4: "pirate", 5: "prisoner"}
#: Owen's colours, verbatim: blue navy, white citizen, yellow criminal, red pirate,
#: grey prisoner.  Unknown is deliberately NOT grey -- grey is a real faction here.
FACTION_COLOR = {
    "navy": "#4a7dff", "citizen": "#ffffff", "criminal": "#f2d13c",
    "pirate": "#e23b2e", "prisoner": "#9aa0a6", "unknown": "#c07ad6",
}

_POS_LINE = re.compile(r"\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]")
_LIST_ONLINE = re.compile(r"There are (\d+) of a max of \d+ players online:\s*(.*)$")
_UUID_INT = re.compile(r"\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]")
_KNOWN = re.compile(r"^\s*(?:the user\s+)?([A-Za-z0-9_]{1,16})\s*$")

#: Serialises writes to the last-known store; reads tolerate a missing/partial file.
_STORE_LOCK = threading.Lock()


# ── provenance helpers ────────────────────────────────────────────────────────────

def provenance(source: str, read_at: float, data_age: float | None,
               ago: str = "") -> dict:
    """The three fields every record must carry, in one place so they cannot drift.

    ``age_seconds`` is the age of the *data*, not of this HTTP response:
      * ``live``  age 0 -- the console was read as the request was served
      * ``saved`` age is the source file's mtime age, or the age of the last live
        reading we still hold
    ``stale`` has no default.  A record whose age cannot be established is marked stale,
    because "we do not know how old this is" is a defect, and calling it fresh hides it.
    """
    if data_age is None:
        return {"source": source, "read_at": read_at, "age_seconds": None,
                "stale": True, "age_unknown": True, "age": ago or "age unknown"}
    return {"source": source, "read_at": read_at, "age_seconds": round(float(data_age), 1),
            "stale": bool(data_age > SAVED_STALE_AFTER), "age_unknown": False,
            "age": ago or age_label(data_age)}


def age_label(seconds: float) -> str:
    if seconds < 2:
        return "now"
    if seconds < 90:
        return "%d seconds ago" % round(seconds)
    if seconds < 5400:
        return "%d minutes ago" % round(seconds / 60)
    if seconds < 172800:
        return "%d hours ago" % round(seconds / 3600)
    return "%d days ago" % round(seconds / 86400)


def mtime_age(path: Path) -> float | None:
    """Age of a file's last write, or ``None`` when it cannot be stat'd."""
    try:
        return max(0.0, time.time() - path.stat().st_mtime)
    except OSError:
        return None


def _record(kind: str, name: str, uid: str, state: str, age_fields: dict,
            detail: str, **extra) -> dict:
    """One map marker.  ``x``/``y``/``z`` are None whenever the state has no position."""
    out = {"kind": kind, "name": name, "id": uid, "state": state,
           "x": None, "y": None, "z": None, "detail": detail}
    out.update(extra)
    out.update(age_fields)
    return out


def _point(rec: dict, position, age_fields: dict):
    if position:
        rec["x"], rec["y"], rec["z"] = position
    rec.update(age_fields)
    return rec


# ── the live console ──────────────────────────────────────────────────────────────

class Console:
    """One poll's worth of console reads, counted, with every failure turned into a state.

    The console costs ~1 second per query (measured), so this class exists to make the
    calls visible and bounded rather than to be clever: a poll spends a handful, never
    hundreds, and the count is reported to the client so the cost is checkable.

    Multiple reads run concurrently (each ~1 s wall clock) but the number in flight is
    capped by a semaphore, because they all serialise on one server main thread anyway.
    """

    def __init__(self, wait: float = 1.5, limit: int = 10):
        self.wait = wait
        self.limit = limit
        self.calls = 0
        # THE CONSOLE IS NOT REENTRANT AND MUST NOT BE READ CONCURRENTLY.
        #
        # `send_console` captures its log offset when it starts and returns everything appended
        # after it, so two overlapping reads BOTH receive every reply and each takes the first
        # line it can parse. Measured on the live world 2026-10-14: three serialised reads
        # returned Zuri, Jim and Beth correctly, while the same three WITHOUT serialisation all
        # returned all three replies -- and `position()` then attributed Zuri's coordinates to
        # nine different NPCs. The map drew a confident lie.
        #
        # `_gate` USED TO BE `Semaphore(limit)`, i.e. TEN PERMITS. It was named and commented as
        # if it serialised the console, and it did not: it allowed ten reads at once, which is
        # exactly the case that corrupts. A semaphore is the right shape for bounding a resource
        # you may share; a console read is not shareable. This is a plain Lock now.
        #
        # The cost is real and measured: each read is a ~1s round trip, so the wall-clock cost
        # of a poll is now roughly one second per query. That is the honest price of correctness
        # here, and it is bounded by the poll interval rather than by concurrency.
        self._gate = threading.Lock()
        self._lock = threading.Lock()

    def _run(self, command: str) -> tuple[bool, list[str], str | None, float]:
        """Returns ``(ok, lines, problem, age_seconds)``.  Never raises."""
        from api.minecraft_ctl import send_console
        started = time.time()
        with self._gate:
            try:
                result = send_console(command, self.wait)
            except Exception as exc:  # ENXIO, timeout, rejected, missing FIFO
                return False, [], _console_problem(exc), 0.0
        lines = list(result.get("output") or [])
        age = max(0.0, time.time() - started - self.wait)
        return True, lines, None, age

    def online_players(self) -> tuple[list[str], dict]:
        """The server's own answer for who is on right now.  One query for everybody."""
        with self._lock:
            self.calls += 1
        ok, lines, problem, age = self._run("list")
        if not ok:
            return [], provenance("live", time.time(), None) | {"problem": problem}
        for line in lines:
            match = _LIST_ONLINE.search(line)
            if match:
                names = [p.strip() for p in match.group(2).split(",") if p.strip()]
                return names, provenance("live", time.time(), age, "now")
        # A `list` that printed nothing recognisable is not an empty server, it is an
        # unread answer.  Say so rather than reporting nobody online.
        return [], provenance("live", time.time(), None) | {"problem": "unreadable list output"}

    def position(self, selector: str) -> tuple[str, tuple | None, dict]:
        """Live position of one entity, or one of the absence states.

        ``selector`` may be a player name or an entity UUID; both are verified to work.
        ``selector`` is validated before it reaches the console -- it is interpolated into
        a server command, so it must not be able to carry a second one.

        The age of the *entity's* position here is the age of the console read.  Absence is
        a live fact ("the server says it is not there") with no age of its own, so its
        timestamps live on ``absence_*`` and the position reading is supplied by the caller
        -- otherwise a fresh "not loaded" would be told to the client as an untimed fact.
        """
        if not re.fullmatch(r"[A-Za-z0-9_]{1,16}|[0-9a-fA-F-]{36}", selector):
            return "rejected", None, {
                "absence_provenance": provenance("live", time.time(), None),
                "absence_age_known": False,
                "problem": "selector refused before it reached the console"}
        with self._lock:
            self.calls += 1
        # ONE QUERY, AND THE REPLY IS OURS BECAUSE CONSOLE READS ARE SERIALISED BY `_gate`.
        #
        # An earlier revision of this method bracketed the query with a `say <nonce>` marker and
        # believed only the line after it. That was unnecessary: instrumenting `_run` on the live
        # server showed each call receives ONLY its own reply, and adding the marker made the
        # common case return "unanswered" (the marker never lands in the same window as the
        # answer, because `send_console` collapses newlines and cannot carry two commands).
        # The real defect was never here -- it was that `_gate` was a Semaphore, and the damage
        # it did is preserved in the last-known cache. Keep this simple.
        ok, lines, problem, age = self._run("data get entity %s Pos" % selector)
        if not ok:
            state = "server_stopped" if problem == "server not running" else "unanswered"
            return state, None, {"absence_provenance": provenance("live", time.time(), None),
                                 "absence_age_known": False, "problem": problem}
        for line in lines:
            if "No entity was found" in line:
                return "not_loaded", None, {
                    "absence_provenance": provenance("live", time.time(), age, "now"),
                    "absence_age_known": True}
            match = _POS_LINE.search(line)
            if match:
                return "loaded", tuple(round(float(g), 2) for g in match.groups()), \
                    provenance("live", time.time(), age, "now")
        return "unanswered", None, {
            "absence_provenance": provenance("live", time.time(), None),
            "absence_age_known": False,
            "problem": "console printed nothing we could read"}

    def positions(self, selectors: list[str]) -> dict[str, tuple[str, tuple | None, dict]]:
        """The same, for many selectors at once.

        The console serialises on one server thread, so this is about wall clock, not
        throughput: a poll must finish well inside its interval.  Measured 2026-10-14:
        18 sequential reads took ~27s (over Owen's 20s interval); concurrent reads with
        this cap bring the same poll in under the interval.
        """
        if not selectors:
            return {}
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(self.limit, len(selectors))) as pool:
            results = list(pool.map(self.position, selectors))
        return dict(zip(selectors, results))


def _console_problem(exc: Exception) -> str:
    """Turn a console failure into the REASON, because the reason is what the map shows.

    "The server is stopped" and "the server did not answer" are different facts about the
    world, and collapsing them loses the thing a reader actually needs.
    """
    text = str(exc)
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == getattr(os, "ENXIO", 6):
        return "server not running"
    if isinstance(exc, RuntimeError) and "FIFO missing" in text:
        # send_console says exactly this when /run/minecraft/console is gone, i.e. the
        # service is not up.  Without this branch a stopped server reports itself as mere
        # silence ("console printed nothing"), which is a different and misleading state.
        return "server not running"
    if "not running" in text or "ENXIO" in text:
        return "server not running"
    if isinstance(exc, TimeoutError):
        return "console did not answer in time"
    return text or exc.__class__.__name__


# ── saved world facts ─────────────────────────────────────────────────────────────

def _nbt(path: Path) -> dict:
    """Parse a gzipped NBT file, tolerating the torn/half-written case."""
    try:
        with path.open("rb") as fh:
            return parse(gzip.decompress(fh.read()))
    except (OSError, EOFError, ValueError, gzip.BadGzipFile) as exc:
        raise ValueError("unreadable %s: %s" % (path.name, exc)) from exc


def player_names() -> dict[str, str]:
    """``uuid -> name`` from ``usercache.json``.  Empty dict if it cannot be read."""
    try:
        rows = json.loads(USERCACHE.read_text())
    except (OSError, ValueError):
        return {}
    return {str(r.get("uuid", "")).lower(): str(r.get("name", "")) for r in rows if r.get("uuid")}


def faction_codes() -> tuple[dict[str, int], dict]:
    """``player name -> status_code`` plus the provenance of that mapping.

    Read from the ``status_code`` objective in the scoreboard.  ``status_code`` is used and
    no other objective is: it is the displayed statement of a player's state, so consulting
    ``faction`` or ``criminal`` as well would be a second opinion about one fact.
    """
    age = mtime_age(SCOREBOARD)
    prov = provenance("saved", time.time(), age)
    try:
        data = _nbt(SCOREBOARD).get("data", {})
    except ValueError as exc:
        return {}, prov | {"problem": str(exc)}
    if not any(o.get("Name") == "status_code" for o in data.get("Objectives", [])):
        return {}, prov | {"problem": "no status_code objective in scoreboard.dat"}
    codes = {}
    for entry in data.get("PlayerScores", []):
        if entry.get("Objective") != "status_code":
            continue
        score = entry.get("Score")
        if isinstance(score, int):
            codes[str(entry.get("Name", ""))] = score
    return codes, prov | {"records": len(codes)}


def _uuid_from_ints(values) -> str:
    hexes = "".join("%08x" % (int(v) & 0xFFFFFFFF) for v in values)
    return "%s-%s-%s-%s-%s" % (hexes[:8], hexes[8:12], hexes[12:16], hexes[16:20], hexes[20:])


def player_facts() -> tuple[dict[str, dict], dict]:
    """``uuid -> {name, x, y, z, health, level, game_mode}`` from the saved player files.

    The level is ``XpLevel`` -- the number the game itself shows above the hotbar.  It is
    taken from here and nowhere else; the pack's ``xp_level`` objective and
    ``players/stats/<uuid>.json`` are deliberately not consulted, because one fact with
    three readings is the defect this module is meant to prevent.
    """
    out = {}
    problems = []
    try:
        files = sorted(PLAYER_DATA.glob("*.dat"))
    except OSError as exc:
        return {}, provenance("saved", time.time(), None) | {"problem": str(exc)}
    newest = None
    for path in files:
        uid = path.stem.lower()
        try:
            data = _nbt(path)
        except ValueError as exc:
            problems.append(str(exc))
            continue
        pos = data.get("Pos")
        age = mtime_age(path)
        if age is not None:
            newest = age if newest is None else min(newest, age)
        out[uid] = {
            "name": "",
            "x": round(float(pos[0]), 2) if pos else None,
            "y": round(float(pos[1]), 2) if pos else None,
            "z": round(float(pos[2]), 2) if pos else None,
            "health": data.get("Health"),
            "level": data.get("XpLevel"),
            "game_mode": data.get("playerGameType"),
            "dimension": data.get("Dimension"),
            "file_age": age,
        }
    prov = provenance("saved", time.time(), newest)
    if problems:
        prov = prov | {"problem": "; ".join(problems)}
    return out, prov


def player_records(console: Console) -> tuple[list[dict], dict]:
    """Every player the world knows about, each with a live/saved provenance.

    A player is an ``online`` marker (live position) or a ``logoff`` point (saved position,
    with the age of the file that holds it).  Those are two different visual states on
    purpose: someone who logged out hours ago is not where they are now.
    """
    saved, saved_prov = player_facts()
    names = player_names()
    codes, faction_prov = faction_codes()
    online, online_prov = console.online_players()
    online_lower = {n.lower() for n in online}
    saved_names = {uid: (names.get(uid) or facts.get("name") or uid)
                   for uid, facts in saved.items()}
    live_names = [saved_names[uid] for uid in saved if saved_names[uid].lower() in online_lower]
    live_names += [n for n in online if n.lower() not in {v.lower() for v in saved_names.values()}]
    reads = console.positions(live_names)

    records = []
    for uid, facts in sorted(saved.items(), key=lambda kv: saved_names[kv[0]].lower()):
        name = saved_names[uid]
        code = codes.get(name)
        faction = FACTION_BY_CODE.get(code, "unknown")
        base = {"faction": faction, "faction_code": code, "level": facts.get("level"),
                "health": facts.get("health"), "dimension": facts.get("dimension"),
                "color": FACTION_COLOR[faction]}
        if name.lower() in online_lower:
            state, position, live = reads.get(name, ("unanswered", None, {}))
            if state == "loaded":
                records.append(_record("player", name, uid, "online", live, "Online now",
                                       **base) | {"x": position[0], "y": position[1],
                                                  "z": position[2]})
            else:
                # Online but no live position: either the chunk is not loaded (absence is a
                # state, so show the last saved reading and its age, never as current), or
                # the console could not answer at all.  Both are labelled, neither is an error.
                detail = {"not_loaded": "Online, chunk not loaded",
                          "server_stopped": "Online, server is stopping",
                          "unanswered": "Online, console did not answer",
                          "rejected": "Online, command was refused",
                          }.get(state, "Online, live read failed")
                records.append(_absent("player", name, uid, state, detail, live,
                                       fallback=((facts["x"], facts["y"], facts["z"]),
                                                 facts.get("file_age")), **base))
        else:
            records.append(_point(
                _record("player", name, uid, "logoff", {}, "Logged off - log-off point",
                        **base),
                (facts["x"], facts["y"], facts["z"]),
                prov_with_position_age(saved_prov, facts.get("file_age"))))

    known = {n.lower() for n in names.values()}
    for name in online:
        if name.lower() in known:
            continue
        # Online but never saved: still a live fact, and the honest answer is to show it
        # with no faction, because no status_code exists for a name we have no uuid for.
        state, position, live = reads.get(name, ("unanswered", None, {}))
        row = _record("player", name, "", state if state != "loaded" else "online", live,
                      "Online now (no saved record)", faction="unknown", faction_code=None,
                      level=None, health=None, dimension=None, color=FACTION_COLOR["unknown"])
        if position:
            row["x"], row["y"], row["z"] = position
        records.append(row)

    prov = {
        "online": online_prov,
        "saved_players": saved_prov,
        "faction": faction_prov,
        "source": "live" if online_prov.get("age_seconds") is not None else "saved",
        "detail": "%d online (live console), %d saved player file(s)" % (len(online), len(saved)),
    }
    return records, prov


def prov_with_position_age(prov: dict, file_age) -> dict:
    """A saved record's age is the age of the file that holds the position."""
    if file_age is None:
        return prov
    out = dict(prov)
    out["age_seconds"] = round(float(file_age), 1)
    out["stale"] = bool(file_age > SAVED_STALE_AFTER)
    out["age"] = age_label(file_age)
    out["position_age_seconds"] = round(float(file_age), 1)
    return out


# ── the last-known store ──────────────────────────────────────────────────────────

def read_last_known() -> dict:
    try:
        data = json.loads(LAST_KNOWN.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def record_last_known(kind: str, uid: str, position, when: float) -> None:
    """Remember where a ship/NPC was, so "not loaded" can show a real last reading.

    This store is the memory that makes ``not_loaded`` informative instead of empty.  It
    is written only from live readings, so everything in it is a fact that was true when
    it was taken, and it always carries that instant.
    """
    with _STORE_LOCK:
        data = read_last_known()
        data["%s:%s" % (kind, uid)] = {"x": position[0], "y": position[1], "z": position[2],
                                       "at": when}
        LAST_KNOWN.parent.mkdir(parents=True, exist_ok=True)
        temporary = LAST_KNOWN.with_suffix(".tmp-%d" % os.getpid())
        temporary.write_text(json.dumps(data, indent=0, sort_keys=True))
        os.replace(temporary, LAST_KNOWN)


def last_known(kind: str, uid: str) -> tuple[tuple | None, float | None]:
    entry = read_last_known().get("%s:%s" % (kind, uid))
    if not isinstance(entry, dict) or entry.get("x") is None:
        return None, None
    age = max(0.0, time.time() - float(entry.get("at") or 0))
    return (entry["x"], entry["y"], entry["z"]), age


def _absent(kind: str, name: str, uid: str, state: str, detail: str,
            absence: dict, fallback=None, **extra) -> dict:
    """An entity we could not read live: last known reading + that reading's age.

    Two separate facts, each stamped honestly:
      * the **absence** ("the server says it is not there") is a live fact, whose own age
        is ``absence_age_seconds``;
      * the **position** is a saved fact, whose age is ``age_seconds``.

    ``fallback`` is ``(position, age_seconds)`` from a saved source when one exists -- a
    player's own ``.dat`` file, whose mtime is a real measurement.  Ships and NPCs have no
    such file, so they use the last-known store instead.  With neither, there is no
    position and no age for one: ``age_seconds`` stays null and ``stale`` is true, because
    "we do not know how old this is" is a defect and calling it fresh would hide it.
    """
    absence_fields = {"absence_source": (absence.get("absence_provenance") or {}).get(
                          "source", "live"),
                      "absence_age_seconds": ((absence.get("absence_provenance") or {}).get(
                          "age_seconds") if absence.get("absence_age_known") else None)}
    if "problem" in absence:
        absence_fields["problem"] = absence["problem"]
    if fallback is not None and fallback[0] is not None:
        position, age = fallback
    else:
        position, age = last_known(kind, uid)
    # The record is a POSITION marker, so `source`/`age_seconds`/`stale` describe the
    # position being drawn.  The absence is stamped separately, so "the server says it is
    # not there right now" and "this is where it last was, 400s ago" can never be confused.
    if position is None:
        base = _record(kind, name, uid, state, provenance("saved", time.time(), None),
                       detail + "; no earlier reading on file", **extra)
    else:
        base = _point(_record(kind, name, uid, state, provenance("saved", time.time(), age),
                              detail + "; position is the last reading we hold", **extra),
                      position, provenance("saved", time.time(), age))
    # Applied LAST, so the position's provenance is never overwritten by the absence's.
    base.update(absence_fields)
    return base


# ── ships ─────────────────────────────────────────────────────────────────────────

def fleet() -> tuple[list[dict], dict]:
    """The fleet registry: the authority for *which* hulls exist."""
    age = mtime_age(FLEET)
    prov = provenance("saved", time.time(), age)
    try:
        rows = json.loads(FLEET.read_text())
    except (OSError, ValueError) as exc:
        return [], prov | {"problem": "cannot read fleet registry: %s" % exc}
    if not isinstance(rows, list):
        return [], prov | {"problem": "fleet registry is not a list"}
    ships = []
    for row in rows:
        uid = str(row.get("id", "")).strip()
        if not uid:
            continue
        ships.append({"id": uid, "kind": row.get("kind", "ship"),
                      "name": row.get("name") or row.get("kind", "ship").split(":")[-1],
                      "owner": row.get("owner") or "",
                      "crew": len(row.get("crew") or []) + len(row.get("defenders") or []),
                      "navy_patrol": bool(row.get("navyPatrol")),
                      "patrol_region": row.get("patrolRegion") or ""})
    return ships, prov | {"records": len(ships)}


def ship_records(console: Console) -> tuple[list[dict], dict]:
    """Every hull in the registry, read live by UUID.

    One query per hull, not one query for all hulls: ``data get entity`` refuses a
    multi-entity selector ("Only one entity is allowed, but the provided selector allows
    more than one" -- verified against the live server), so a batch read of positions by
    UUID is not available.  The queries therefore run CONCURRENTLY, so six hulls cost one
    query's wall clock rather than six.
    """
    ships, prov = fleet()
    reads = console.positions([ship["id"] for ship in ships])
    records = []
    for ship in ships:
        patrol = {"navy_patrol": ship["navy_patrol"],
                  "patrol_region": ship["patrol_region"]}
        if ship["navy_patrol"]:
            patrol.update(color=FACTION_COLOR["navy"], faction="navy", icon="navy_ship")
        state, position, live = reads.get(ship["id"], ("unanswered", None, {}))
        if state == "loaded":
            record_last_known("ship", ship["id"], position, time.time())
            records.append(_record("ship", ship["name"], ship["id"], "loaded", live,
                                   ("Navy patrol · %d crew · %s" % (ship["crew"], ship["patrol_region"]))
                                   if ship["navy_patrol"] else "Hull in a loaded chunk", x=position[0], y=position[1],
                                   z=position[2], ship_kind=ship["kind"],
                                   crew=ship["crew"], **patrol))
        else:
            detail = {"not_loaded": "Hull's chunk is not loaded",
                      "server_stopped": "Server is stopped",
                      "unanswered": "Console did not answer",
                      "rejected": "Command was refused",
                      }.get(state, "Live read failed")
            records.append(_absent("ship", ship["name"], ship["id"], state, detail, live,
                                   ship_kind=ship["kind"], crew=ship["crew"], **patrol))
    live_count = sum(1 for r in records if r.get("state") == "loaded")
    if live_count:
        prov["age_seconds"], prov["stale"], prov["age"] = 0.0, False, "now"
    return records, prov | {"registry_age_seconds": prov.get("age_seconds"),
                            "live_readings": live_count,
                            "not_loaded": sum(1 for r in records
                                              if r.get("state") == "not_loaded")}


# ── named NPCs ───────────────────────────────────────────────────────────────────

def _roster(path: Path, layout: str) -> tuple[list[dict], str | None]:
    try:
        text = path.read_text()
    except OSError as exc:
        return [], "cannot read %s: %s" % (path.name, exc)
    rows = []
    if layout == 'region_json':
        try:
            data=json.loads(text)
            if not isinstance(data,dict) or any(not isinstance(value,str) for value in data.values()):
                raise ValueError('Expected UUID-to-region assignments')
            return [{'name':'Guard '+str(uid)[:8],'id':str(uid).lower(),'region':region} for uid,region in data.items()],None
        except (ValueError,TypeError) as exc:
            return [],'cannot read %s: %s'%(path.name,exc)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if layout == "name_first" and len(parts) >= 2:
            rows.append({"name": parts[0], "id": parts[1].lower()})
        elif layout == "uuid_first" and len(parts) >= 2:
            rows.append({"name": parts[1], "id": parts[0].lower()})
        elif layout == "uuid_only" and len(parts[0]) == 36:
            rows.append({"name": "", "id": parts[0].lower()})
    return rows, None


def npc_records(console: Console, layers: set[str] | None = None) -> tuple[list[dict], dict]:
    """Every named NPC from the mod's roster files, read live by UUID.

    ``layers`` names the default-off layers to switch ON.  ``wildlife`` is the one such
    layer: it would put every island animal on the map, so it is off unless a human asks.
    """
    on = set(layers or set())
    active = {kind for kind, _, _ in NPC_ROSTERS} - set(DEFAULT_OFF_LAYERS) | on
    records, problems, roster_prov = [], [], {}
    wanted = []
    for kind, path, layout in NPC_ROSTERS:
        if kind not in active:
            continue
        rows, problem = _roster(path, layout)
        roster_prov[kind] = provenance("saved", time.time(), mtime_age(path))
        if problem:
            problems.append(problem)
            continue
        for row in rows:
            wanted.append((kind, row))
    reads = console.positions([row["id"] for _, row in wanted])
    for kind, row in wanted:
        name = row["name"] or "%s %s" % (kind, row["id"][:8])
        state, position, live = reads.get(row["id"], ("unanswered", None, {}))
        if state == "loaded":
            record_last_known("npc", row["id"], position, time.time())
            records.append(_record("npc", name, row["id"], "loaded", live,
                                   "Named %s, loaded chunk" % kind, npc_kind=kind,
                                   x=position[0], y=position[1], z=position[2],
                                   patrol_region=row.get("region", "spawn-island" if kind == "sailor" else "")))
        else:
            detail = {"not_loaded": "Named %s, chunk not loaded" % kind,
                      "server_stopped": "Server is stopped",
                      "unanswered": "Console did not answer",
                      "rejected": "Command was refused"}.get(state, "Live read failed")
            records.append(_absent("npc", name, row["id"], state, detail, live, npc_kind=kind,
                                   patrol_region=row.get("region", "spawn-island" if kind == "sailor" else "")))
    records = patrol_groups(records)
    prov = {"rosters": roster_prov, "layers_on": sorted(active)}
    if problems:
        prov["problem"] = "; ".join(problems)
    # Every layer failed to yield a record: the timestamp on this layer is not known.
    prov |= provenance("saved", time.time(),
                       None if not roster_prov else min(
                           (v.get("age_seconds") if v.get("age_seconds") is not None else 0)
                           for v in roster_prov.values()))
    return records, prov


def patrol_groups(records: list[dict]) -> list[dict]:
    """One marker per assigned land unit; crew remain represented by their ship.

    Region guards currently form one unit per region; each island watch soldier
    is its own unit. Group by stable assignments, never by temporary proximity.
    A partially loaded unit shows its loaded members' centre and explicit coverage.
    """
    units: dict[str, list[dict]] = {}
    result = []
    try:
        from .map_zones import read_document
        names = {r["id"]: r["name"] for r in read_document()[0]["zones"]}
    except (OSError, ValueError, TypeError, KeyError):
        names = {}
    for row in records:
        if row.get("npc_kind") == "sailor":
            result.append(row | {"color": FACTION_COLOR["navy"], "faction": "navy",
                                 "icon": "navy_unit", "members": 1})
            continue
        if row.get("npc_kind") not in {"sailor", "region_guard"}:
            result.append(row)
            continue
        units.setdefault(row["patrol_region"], []).append(row)
    for region, members in units.items():
        uid = "navy-land:" + region
        name = "Navy land patrol — " + names.get(region, region.replace("-", " ").title())
        loaded = [r for r in members if r["state"] == "loaded"]
        extra = dict(npc_kind="navy_patrol", patrol_region=region, icon="navy_unit",
                     color=FACTION_COLOR["navy"], faction="navy", members=len(members), loaded_members=len(loaded))
        if loaded:
            position = tuple(sum(r[axis] for r in loaded) / len(loaded) for axis in ("x", "y", "z"))
            stamp = min(r.get("read_at", time.time()) for r in loaded)
            record_last_known("npc", uid, position, stamp)
            result.append(_record("npc", name, uid, "loaded",
                                  provenance("live", stamp, max(0, time.time()-stamp)),
                                  "%d/%d members loaded · unit centre" % (len(loaded), len(members)),
                                  x=position[0], y=position[1], z=position[2], **extra))
        else:
            result.append(_absent("npc", name, uid, members[0]["state"],
                                  "No unit members loaded · last observed unit centre",
                                  {"absence_provenance": {
                                      "source": members[0].get("absence_source", "live"),
                                      "age_seconds": members[0].get("absence_age_seconds")},
                                   "absence_age_known": members[0].get("absence_age_seconds") is not None}, **extra))
    return result




# ── the layer the API serves ─────────────────────────────────────────────────────

def _collect(wait: float = 1.5, layers: set[str] | None = None) -> dict:
    """Gather every layer.  EXPENSIVE: one console round trip per entity, ~1.5s each.

    Callers go through `snapshot()`, which caches and coalesces this.  Do not call this
    directly from a request handler.
    """
    started = time.time()
    console = Console(wait=wait)
    players, players_prov = player_records(console)
    ships, ships_prov = ship_records(console)
    npcs, npcs_prov = npc_records(console, layers)

    records = {
        "players": players,
        "ships": ships,
        "npcs": npcs,
    }
    counts = {k: len(v) for k, v in records.items()}
    concerns = []
    if console.calls and players_prov.get("online", {}).get("problem"):
        concerns.append("live console: " + str(players_prov["online"]["problem"]))
    for label, prov in (("players", players_prov), ("ships", ships_prov), ("npcs", npcs_prov)):
        if prov.get("problem"):
            concerns.append("%s: %s" % (label, prov["problem"]))

    return {
        "collected_at": started,
        "collected_at_iso": datetime.fromtimestamp(started, timezone.utc).isoformat(),
        "duration_seconds": round(time.time() - started, 2),
        "console_queries": console.calls,
        "counts": counts,
        "records": records,
        "provenance": {"players": players_prov, "ships": ships_prov, "npcs": npcs_prov},
        "layers": {"on": sorted({"players", "ships", "npcs"}
                                | ((layers or set()) & DEFAULT_OFF_LAYERS)),
                   "default_off": sorted(DEFAULT_OFF_LAYERS)},
        "concerns": concerns,
        "stale": any(r.get("stale") for rows in records.values() for r in rows),
    }


# ── one collection serves every poller ───────────────────────────────────────────

SNAPSHOT_MAX_AGE_SECONDS = 5.0

_snapshot_cache: dict[tuple, tuple[float, dict]] = {}
_snapshot_flight = threading.Condition()
_snapshot_collecting = False


def snapshot(wait: float = 1.5, layers: set[str] | None = None,
             max_age: float = SNAPSHOT_MAX_AGE_SECONDS) -> dict:
    """Everything the map draws, with one provenance stamp per record.

    This is the only reader the API and the tests call.  The client never reads a world
    file and never forms its own view of a fact this function already answers.

    A collection costs one console round trip per entity -- 19 queries at ~1.5s each, so
    ~29s wall clock now that `Console._gate` serialises reads.  It is cached for
    `max_age` and COALESCED, because without either a second poller does not get a second
    opinion, it gets a second queue position: both browsers would read the console ~29s
    apart and the map would hand one of them a view that was already stale when gathered.
    One collection per `max_age` serves every caller, and a caller arriving mid-collection
    waits for that one instead of starting a rival read of a console that can only answer
    one query at a time.

    The result carries `served_from_cache` and `snapshot_age_seconds`, so a caller can
    always tell how old the view it was handed actually is.  Cached values are
    deep-copied on the way out: no caller may mutate the cached fact.
    """
    global _snapshot_collecting
    key = (round(wait, 3), tuple(sorted(layers or ())))
    deadline = time.monotonic() + max_age

    def served(entry, collecting_note: str | None = None) -> dict:
        view = copy.deepcopy(entry[1])
        view["served_from_cache"] = True
        view["snapshot_age_seconds"] = round(time.monotonic() - entry[0], 2)
        if collecting_note:
            view["concerns"] = list(view.get("concerns") or []) + [collecting_note]
        return view

    with _snapshot_flight:
        while True:
            entry = _snapshot_cache.get(key)
            if entry is not None and (time.monotonic() - entry[0]) < max_age:
                return served(entry)
            if _snapshot_collecting:
                # Somebody is collecting.  Wait for THEIR result rather than starting a
                # rival read.  Spurious wakeups are fine: the loop re-tests.
                remaining = deadline - time.monotonic()
                if remaining > 0 and _snapshot_flight.wait(timeout=remaining):
                    continue
                if entry is not None:
                    # The collector outlasted this caller's patience.  A stale view beats
                    # no map, but the caller is told the view is being refreshed.
                    return served(entry, "a snapshot collection is still running")
                if remaining > 0:
                    continue  # spurious wakeup with nothing cached yet: keep waiting
            if not _snapshot_collecting:
                _snapshot_collecting = True
                break

    # We own the collection.  `_collect` runs OUTSIDE the condition's lock so waiters can
    # still acquire it and observe that a collection is in flight.
    try:
        view = _collect(wait, layers)
    except BaseException:
        with _snapshot_flight:
            _snapshot_collecting = False
            _snapshot_flight.notify_all()
        raise

    view["served_from_cache"] = False
    view["snapshot_age_seconds"] = 0.0
    with _snapshot_flight:
        _snapshot_cache[key] = (time.monotonic(), copy.deepcopy(view))
        _snapshot_collecting = False
        _snapshot_flight.notify_all()
    return view


def clear_snapshot_cache() -> None:
    """Drop the cached view.  For tests and for callers that know the world just changed."""
    with _snapshot_flight:
        _snapshot_cache.clear()
