"""Saved-terrain public export. No player reader, console commands, or world writes."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
from pathlib import Path
import shutil
import sys
import zipfile
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/New_York')

#: The only marker kinds the public map publishes, and the only ones its key lists.
#: Player factions (navy, citizen, criminal, pirate, prisoner) are read by the private
#: household map and must never be re-added here: player records are not exported.
PUBLIC_MARKER_KINDS = ('ship', 'sea_patrol', 'land_patrol', 'villager', 'mob')

#: The only icons a public marker may carry. They name what the map draws -- a hull, a
#: patrol ship, or a guard -- not the roster or faction a row came from, so no private
#: icon name is copied out even when it matches.
PUBLIC_MARKER_ICONS = ('hull', 'navy_ship', 'navy_unit-guard')
#: The drawing each published category uses. Villagers and mobs are plain dots.
ICON_BY_KIND = {'ship': 'hull', 'sea_patrol': 'navy_ship', 'land_patrol': 'navy_unit-guard'}

#: NPC roster kinds that are a land patrol. 'navy_patrol' is set explicitly for the
#: patrols derived from regions in core/minecraft_map_data.npc_records.
#: 'guard_patrol' is kept as an icon alias for a guard roster that arrives without a kind.
PATROL_NPC_KINDS = frozenset({'sailor', 'region_guard', 'navy_patrol'})
PATROL_ICONS = frozenset({'guard_patrol'})
WILDLIFE_NPC_KINDS = frozenset({'wildlife'})
DEPENDENCIES = {
    'fabric-api': 'https://modrinth.com/mod/fabric-api',
    'shippy-ships': 'https://modrinth.com/mod/shippy-ships',
    'ingeniumapi': 'https://modrinth.com/project/ingeniumapi',
    'tectonic': 'https://modrinth.com/project/tectonic',
    'lithostitched': 'https://modrinth.com/project/lithostitched',
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + '\n')


def public_marker_kind(row):
    """One of PUBLIC_MARKER_KINDS, or None for a row the public map must not show.

    A hull the fleet registry marks as a navy patrol is published as a sea patrol; every
    other hull is published as a ship. NPC rows are published by what their roster says
    they are: garrison, region-guard and region-derived patrols, wildlife, or a
    villager/islander. A private faction is not a public category, so it is never
    consulted here.
    """
    if row.get('kind') == 'ship':
        return 'sea_patrol' if row.get('navy_patrol') is True else 'ship'
    if row.get('kind') != 'npc':
        return None
    npc_kind, icon = row.get('npc_kind'), row.get('icon')
    if npc_kind in PATROL_NPC_KINDS or icon in PATROL_ICONS:
        return 'land_patrol'
    if npc_kind in WILDLIFE_NPC_KINDS:
        return 'mob'
    return 'villager'


def public_marker(row, now):
    """Build a NEW, narrow record. Never copy arbitrary private fields into the export."""
    kind = public_marker_kind(row)
    if kind is None:
        return None
    if any(type(row.get(axis)) not in (float, int) or not math.isfinite(row[axis]) for axis in ('x', 'z')):
        return None
    at = row.get('read_at')
    age = row.get('age_seconds')
    observed = None
    if type(at) in (int, float) and math.isfinite(at) and type(age) in (int, float) and math.isfinite(age):
        observed = datetime.fromtimestamp(min(now.timestamp(), max(0, at - max(0, age))), timezone.utc).isoformat()
    marker = {
        'id': hashlib.sha256((row['kind'] + ':' + str(row.get('id', ''))).encode()).hexdigest()[:20],
        'kind': kind, 'name': str(row.get('name') or ('Ship' if row['kind'] == 'ship' else 'NPC'))[:120],
        'x': round(row['x'], 2), 'z': round(row['z'], 2), 'observed_at': observed,
    }
    icon = ICON_BY_KIND.get(kind)
    if icon:
        marker['icon'] = icon
    return marker


class SavedPositions:
    """Have the existing readers use their last-known ship/NPC stores, without console I/O.

    A separate console poll can interleave with private map reads. Public daily exports
    instead preserve each saved observation's own timestamp and never claim to be live.
    """
    def positions(self, selectors):
        return {ident: ('not_loaded', None, {'absence_age_known': False}) for ident in selectors}


def public_regions(doc):
    result = []
    for zone in doc['zones']:
        result.append({key: zone[key] for key in (
            'id', 'name', 'short_name', 'points', 'pvp_protection', 'pve_protection',
            'edit_protection', 'navy_controlled', 'guard_patrols', 'navy_patrols')})
    # The smallest overlapping region supplies the hover name, as on the private map.
    result.sort(key=lambda r: abs(sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(r['points'], r['points'][1:]+r['points'][:1]))))
    return result


def export_client(destination, download_module):
    """Only our custom mod is redistributed. Dependencies link to their publishers."""
    mods = {}
    for path in download_module._mods():
        with zipfile.ZipFile(path) as jar:
            try:
                meta = json.loads(jar.read('fabric.mod.json'))
            except KeyError:
                continue
        mods[meta['id']] = (path, meta)
    custom, meta = mods['easter-navy']
    target = destination / 'downloads/easter-navy.jar'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(custom, target)
    # Fail a changing build rather than publish a mismatched JAR and checksum.
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if hashlib.sha256(custom.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Custom mod changed during export; retry')
    minecraft = download_module.facts.stack().split(' · ', 1)[0].removeprefix('MC ')
    client = {
        'minecraft': minecraft,
        'mod': {'name': meta['name'], 'version': meta['version'], 'sha256': digest,
                'bytes': target.stat().st_size, 'url': 'downloads/easter-navy.jar'},
        'dependencies': [{'id': ident, 'name': mods[ident][1]['name'], 'version': mods[ident][1]['version'], 'url': url}
                         for ident, url in DEPENDENCIES.items()],
    }
    write_json(destination / 'data/client.json', client)


def export_snapshot(destination, source_root=Path('/root/e-server'), now=None, previous_day=None):
    """Stage a complete export before touching the publishing checkout."""
    now = now or datetime.now(timezone.utc)
    destination = Path(destination)
    sys.path.insert(0, str(source_root))
    terrain = importlib.import_module('core.minecraft_map')
    entities = importlib.import_module('core.minecraft_map_data')
    zones = importlib.import_module('core.map_zones')
    downloads = importlib.import_module('api.minecraft_download')
    coverage = terrain.metadata()
    if not coverage['regions']:
        raise RuntimeError('No saved terrain; refusing to erase the published world')
    tiles = []
    for index, region in enumerate(sorted(coverage['regions'], key=lambda r: (r['x'], r['z']))):
        path, report = terrain.tile(region['x'], region['z'])
        if report.get('unreadable'):
            raise RuntimeError('Terrain is being saved; retry rather than archive partial chunks')
        blob = path.read_bytes()
        target = destination / f"data/tiles/{region['x']}/{region['z']}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        tiles.append({'x': region['x'], 'z': region['z'], 'version': hashlib.sha256(blob).hexdigest()})
        if (index + 1) % 10 == 0:
            print(f'Rendered {index + 1}/{len(coverage["regions"])} saved tiles', flush=True)
    positions = SavedPositions()
    ships, _ = entities.ship_records(positions)
    npcs, _ = entities.npc_records(positions)
    markers = [clean for row in ships + npcs if (clean := public_marker(row, now)) is not None]
    day = now.astimezone(ZONE).date()
    gap = max(0, (day - datetime.fromisoformat(previous_day).date()).days - 1) if previous_day else 0
    snapshot = {
        'schema': 1, 'captured_at': now.astimezone(timezone.utc).isoformat(), 'snapshot_day': day.isoformat(),
        'missed_days': gap, 'center': coverage['center'], 'region_blocks': 512,
        'saved_chunk_slots': coverage['saved_chunk_slots'], 'tiles': tiles,
        'regions': public_regions(zones.read_document()[0]), 'markers': sorted(markers, key=lambda r: r['id']),
        'unlocated_markers': len(ships) + len(npcs) - len(markers),
        'position_source': 'Last observed ships and NPCs. Player records are excluded at export.',
    }
    write_json(destination / 'data/world.json', snapshot)
    export_client(destination, downloads)
    print(f'Exported {len(tiles)} tiles, {len(snapshot["regions"])} regions and {len(markers)} non-player markers', flush=True)
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--source-root', type=Path, default=Path('/root/e-server'))
    args = parser.parse_args()
    export_snapshot(args.destination, args.source_root)


if __name__ == '__main__':
    main()
