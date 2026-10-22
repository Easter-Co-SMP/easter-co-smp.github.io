"""Build the published atlas document: `site/data/world.json`.

The document's shape is frozen by `scripts/validate.py` and by the site's own reader, so this
module has one job -- put the right values in those twelve fields and refuse to invent any
of them. Three of the fields do not come from terrain at all:

* `regions` come from the game's own region-rules document, captured verbatim on the host;
* `markers` come from the mod's roster files plus the last-known position store, read through
  the vendored `minecraft_map_data` -- the same reader e-server uses, not a second opinion;
* `unlocated_markers` counts the rows that arrived without a position.

**The honesty rule.** A capture can arrive without those sources (they are optional in the
snapshot contract). When it does, this module carries the last published values forward and
says so in `position_source`, which is the one published field that describes where marker
positions came from. It never invents a position, never moves `observed_at`, and never writes
a `captured_at` newer than the capture it was built from. With `ATLAS_MARKERS=refuse` it
refuses instead and publishes nothing.

`captured_at` is always the capture's own instant, never the runner's clock, so a snapshot
rendered twice produces the same document twice.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import os

from . import contract, renderer

#: The site's own zone, which decides the public `snapshot_day`. Same value as
#: `scripts/export_world.py:ZONE`; a check in tests/test_atlas_contract.py keeps them equal.
ZONE = ZoneInfo("America/New_York")

#: The marker categories the public map may contain, and the icons a marker may carry. These
#: are imported from the exporter rather than restated, so there is one allowlist in the
#: repository and not two that can disagree.
from scripts.export_world import (ICON_BY_KIND, PUBLIC_MARKER_ICONS,  # noqa: E402
                                 PUBLIC_MARKER_KINDS, SavedPositions, public_marker,
                                 public_regions)

MARKER_KEYS = frozenset({"id", "kind", "name", "x", "z", "observed_at", "icon"})

CAPTURE_POSITION_SOURCE = (
    "Last observed ships and NPCs, read from the capture taken {captured_at}. "
    "Player records are excluded at export.")
CARRIED_POSITION_SOURCE = (
    "Last observed ships and NPCs, carried from the {published_at} snapshot because the "
    "capture of {captured_at} carried no position store. Player records are excluded at "
    "export.")


class WorldDocumentError(RuntimeError):
    """The document is not fit to publish."""


@dataclass
class Markers:
    rows: list
    unlocated: int
    position_source: str
    carried: bool
    rows_read: int


def _utc(value):
    moment = value if isinstance(value, datetime) else datetime.fromisoformat(
        str(value).replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _point_zones_at(snapshot):
    """Tell the game's own zone reader where this capture's rules are (or that there are none).

    `core/map_zones.py` reads `E_SERVER_MAP_ZONES`, so pointing it at the captured document
    means the patrol names and the region polygons come from the game's own file, validated by
    the game's own `validate_zones`, instead of from a second reader written here.
    """
    path = snapshot.optional(contract.CAPTURE_ZONES)
    # A path that does not exist is the documented "no rules captured" state: the reader
    # raises OSError, its own caller already handles that, and `load_zones` below refuses
    # only when a document is present AND unreadable.
    os.environ["E_SERVER_MAP_ZONES"] = str(path or (snapshot.root / "no-map-zones.json"))
    return path


def load_zones(snapshot):
    """The captured region-rules document, or None when the capture carried none.

    Present-but-invalid is a refusal: a region polygon in the wrong place is a claim about
    where players are safe. Absent is not an error -- it is a capture that did not carry the
    file, which the caller may carry forward from the published document and label.
    """
    path = _point_zones_at(snapshot)
    if path is None:
        return None
    modules = renderer.use_records(server_root=snapshot.server_root,
                                   tile_cache=snapshot.cache_dir)
    try:
        document, _digest = modules.zones.read_document(path)
    except (OSError, ValueError, TypeError) as error:
        raise WorldDocumentError(f"the captured region rules {path.name} are not valid: "
                                 f"{error}") from error
    for zone in document["zones"]:
        extra = set(zone) - set(contract.REGION_KEYS)
        if extra:
            raise WorldDocumentError("a captured region row carries fields the public map "
                                     f"never publishes: {sorted(extra)}")
    return document


def read_records(snapshot, captured_at):
    """Ship and NPC rows from the capture, with no console and no invention.

    Uses the vendored reader e-server uses, with `SavedPositions` (the exporter's own class
    for exactly this: "have the existing readers use their last-known stores, without console
    I/O"). Positions come from the capture's last-known store when it carries one.
    """
    _point_zones_at(snapshot)
    modules = renderer.use_records(server_root=snapshot.server_root,
                                   tile_cache=snapshot.cache_dir)
    records = modules.records
    positions = SavedPositions()
    ships, ship_note = records.ship_records(positions)
    npcs, npc_note = records.npc_records(positions)
    instant = _utc(captured_at)
    markers = []
    for row in list(ships) + list(npcs):
        clean = public_marker(row, instant)
        if clean is not None:
            markers.append(clean)
    rows = len(ships) + len(npcs)
    return markers, rows, {"ships": ship_note, "npcs": npc_note}


def resolve_markers(snapshot, captured_at, previous_document, policy="carry", log=print):
    """Captured markers when the capture can produce them; otherwise the published ones."""
    markers, rows, notes = read_records(snapshot, captured_at)
    if markers:
        return Markers(rows=markers, unlocated=max(0, rows - len(markers)),
                       position_source=CAPTURE_POSITION_SOURCE.format(
                           captured_at=snapshot.captured_at),
                       carried=False, rows_read=rows)
    if policy == "refuse":
        raise WorldDocumentError(
            f"the capture read {rows} marker row(s) and placed none of them, and "
            "ATLAS_MARKERS=refuse. Publishing this document would erase the markers the site "
            "already shows.")
    previous = previous_document or {}
    if previous.get("markers"):
        problems = main_problems(notes)
        log(f"atlas: the capture placed none of {rows} marker row(s)"
            + (f" ({problems})" if problems else "")
            + f"; carrying the {len(previous['markers'])} published markers forward from "
              f"{previous.get('captured_at')} and saying so in position_source")
        return Markers(rows=previous["markers"],
                       unlocated=int(previous.get("unlocated_markers") or 0),
                       position_source=CARRIED_POSITION_SOURCE.format(
                           published_at=previous.get("captured_at"),
                           captured_at=snapshot.captured_at),
                       carried=True, rows_read=rows)
    raise WorldDocumentError(
        f"the capture placed no marker and there is no published document to carry: "
        f"{rows} row(s) read, notes {json.dumps(notes, sort_keys=True)}")


def main_problems(notes):
    """The readable half of the marker reader's provenance: one sentence, not a dict dump."""
    problems = [entry["problem"] for entry in notes.values() if entry.get("problem")]
    if not problems:
        return ""
    joined = "; ".join(str(problem) for problem in problems)
    return joined if len(joined) <= 300 else joined[:297] + "..."


def resolve_regions(snapshot, previous_document, policy="carry", log=print):
    """Captured region polygons, validated; otherwise the published ones, labelled."""
    document = load_zones(snapshot)
    if document is not None:
        return public_regions(document)
    if policy == "refuse":
        raise WorldDocumentError(
            "the capture carries no region-rules document (capture/map-zones.json) and "
            "ATLAS_MARKERS=refuse. Publishing this document would erase every region polygon "
            "the site already shows.")
    previous = previous_document or {}
    if previous.get("regions"):
        log(f"atlas: the capture carries no region-rules document; carrying the "
            f"{len(previous['regions'])} published regions forward")
        return previous["regions"]
    raise WorldDocumentError("the capture carries no region rules and there is no published "
                             "document to carry them from")


def build(*, tiles, coverage, captured_at, previous_document, snapshot, policy="carry",
          log=print):
    """Assemble the twelve published fields. Pure apart from the log line."""
    instant = _utc(captured_at)
    day = instant.astimezone(ZONE).date()
    previous_day = (previous_document or {}).get("snapshot_day")
    gap = 0
    if previous_day:
        try:
            gap = max(0, (day - datetime.fromisoformat(previous_day).date()).days - 1)
        except ValueError:
            gap = 0
    markers = resolve_markers(snapshot, captured_at, previous_document, policy=policy, log=log)
    regions = resolve_regions(snapshot, previous_document, policy=policy, log=log)
    document = {
        "schema": 1,
        "captured_at": instant.isoformat(),
        "snapshot_day": day.isoformat(),
        "missed_days": gap,
        "center": list(coverage.get("center") or [-624, -192]),
        "region_blocks": 512,
        "saved_chunk_slots": int(coverage.get("saved_chunk_slots") or 0),
        "tiles": [{"x": tile.x, "z": tile.z, "version": tile.version}
                  for tile in sorted(tiles, key=lambda t: (t.x, t.z))],
        "regions": regions,
        "markers": sorted(markers.rows, key=lambda row: row["id"]),
        "unlocated_markers": markers.unlocated,
        "position_source": markers.position_source,
    }
    validate(document)
    return document


def validate(document):
    """Refuse anything the site's validator would refuse, with a sentence that says what."""
    if set(document) != set(contract.WORLD_KEYS):
        missing = set(contract.WORLD_KEYS) - set(document)
        extra = set(document) - set(contract.WORLD_KEYS)
        raise WorldDocumentError(
            f"world document fields do not match the published set "
            f"(missing {sorted(missing)}, unexpected {sorted(extra)})")
    if document["schema"] != 1:
        raise WorldDocumentError("world document schema must be 1")
    instant = _utc(document["captured_at"])
    if instant > datetime.now(timezone.utc):
        raise WorldDocumentError(
            f"captured_at {document['captured_at']} is in the future; a document may never "
            "claim a newer capture than the snapshot it came from")
    if datetime.fromisoformat(document["snapshot_day"]).date() != instant.astimezone(ZONE).date():
        raise WorldDocumentError("snapshot_day is not the capture instant in the site's zone")
    versions = set()
    for tile in document["tiles"]:
        if set(tile) != {"x", "z", "version"}:
            raise WorldDocumentError("a tile row must carry exactly x, z and version")
        if not (isinstance(tile["x"], int) and isinstance(tile["z"], int)):
            raise WorldDocumentError("tile coordinates must be integers")
        version = tile["version"]
        if not isinstance(version, str) or len(version) != 64:
            raise WorldDocumentError(f"tile {tile['x']},{tile['z']} has no sha256 version")
        versions.add((tile["x"], tile["z"]))
    if len(versions) != len(document["tiles"]):
        raise WorldDocumentError("the tile list repeats a coordinate")
    for region in document["regions"]:
        if not isinstance(region, dict) or set(region) != set(contract.REGION_KEYS):
            raise WorldDocumentError("a region row does not have exactly the ten published "
                                     "fields")
    kinds = set()
    for marker in document["markers"]:
        if not isinstance(marker, dict):
            raise WorldDocumentError("a marker is not an object")
        extra = set(marker) - MARKER_KEYS
        if extra:
            # 'faction' lands here, which is the point: player factions are private.
            raise WorldDocumentError(f"a marker carries private or unknown fields: "
                                     f"{sorted(extra)}")
        if marker.get("kind") not in PUBLIC_MARKER_KINDS:
            raise WorldDocumentError(f"marker kind {marker.get('kind')!r} is not public")
        if marker.get("icon") not in (None, *PUBLIC_MARKER_ICONS):
            raise WorldDocumentError(f"marker icon {marker.get('icon')!r} is not public")
        if marker.get("icon") != ICON_BY_KIND.get(marker.get("kind")):
            raise WorldDocumentError("a marker's icon does not match its public category")
        for axis in ("x", "z"):
            if not isinstance(marker.get(axis), (int, float)):
                raise WorldDocumentError(f"a marker has no numeric {axis}")
        kinds.add(marker["kind"])
    if marker_factions(document["markers"]):
        raise WorldDocumentError("a marker carries a faction; player factions never publish")
    if int(document["unlocated_markers"]) < 0:
        raise WorldDocumentError("unlocated_markers cannot be negative")
    if not isinstance(document["position_source"], str) or not document["position_source"]:
        raise WorldDocumentError("position_source must say where positions came from")
    return document


def marker_factions(markers):
    """Any marker key or value that smells of a player faction. Belt and braces."""
    for marker in markers:
        for forbidden in ("faction", "owner", "player", "uuid"):
            if forbidden in marker:
                return True
    return False


def write(document, path):
    """Write the document the way the repository's exporter writes JSON: sorted, indented."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True,
                                allow_nan=False) + "\n", encoding="utf8", newline="\n")
    return path
