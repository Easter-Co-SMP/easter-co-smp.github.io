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


def public_marker(row, now):
    """Build a NEW, narrow record. Never copy arbitrary private fields into the export."""
    if row.get('kind') not in ('ship', 'npc'):
        return None
    if any(type(row.get(axis)) not in (float, int) or not math.isfinite(row[axis]) for axis in ('x', 'z')):
        return None
    at = row.get('read_at')
    age = row.get('age_seconds')
    observed = None
    if type(at) in (int, float) and math.isfinite(at) and type(age) in (int, float) and math.isfinite(age):
        observed = datetime.fromtimestamp(min(now.timestamp(), max(0, at - max(0, age))), timezone.utc).isoformat()
    faction = row.get('faction')
    if faction not in ('navy', 'citizen', 'criminal', 'pirate', 'prisoner'):
        faction = 'citizen' if row.get('npc_kind') == 'villager' else 'other'
    marker = {
        'id': hashlib.sha256((row['kind'] + ':' + str(row.get('id', ''))).encode()).hexdigest()[:20],
        'kind': row['kind'], 'name': str(row.get('name') or ('Ship' if row['kind'] == 'ship' else 'NPC'))[:120],
        'x': round(row['x'], 2), 'z': round(row['z'], 2), 'faction': faction, 'observed_at': observed,
    }
    if row.get('icon') in ('navy_ship', 'guard_patrol'):
        marker['icon'] = row['icon']
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
