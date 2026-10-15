"""Validate the public payload, local links, and deployment size before publishing."""
from __future__ import annotations
import hashlib
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit, unquote

MARKER_KEYS = {'id', 'kind', 'name', 'x', 'z', 'faction', 'observed_at', 'icon'}
WORLD_KEYS = {'schema', 'captured_at', 'snapshot_day', 'missed_days', 'center', 'region_blocks',
              'saved_chunk_slots', 'tiles', 'regions', 'markers', 'unlocated_markers', 'position_source'}
REGION_KEYS = {'id', 'name', 'short_name', 'points', 'pvp_protection', 'pve_protection', 'edit_protection',
               'navy_controlled', 'guard_patrols', 'navy_patrols'}


def validate_data(root):
    root = Path(root)
    world = json.loads((root / 'data/world.json').read_text())
    assert set(world) == WORLD_KEYS, 'Unexpected world fields'
    assert world['schema'] == 1 and world['tiles'], 'Empty or unsupported world'
    assert len(world['center']) == 2 and all(type(n) in (int, float) and math.isfinite(n) for n in world['center'])
    expected = set()
    for tile in world['tiles']:
        assert set(tile) == {'x', 'z', 'version'}
        assert type(tile['x']) is int and type(tile['z']) is int
        assert re.fullmatch('[a-f0-9]{64}', tile['version'])
        path = root / f"data/tiles/{tile['x']}/{tile['z']}.png"
        assert path.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), f'Not a PNG: {path}'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == tile['version'], f'Tile checksum mismatch: {path}'
        assert path not in expected, 'Duplicate tile'
        expected.add(path)
    assert set((root / 'data/tiles').rglob('*.png')) == expected, 'Orphan tiles'
    for region in world['regions']:
        assert set(region) == REGION_KEYS, 'Unexpected region fields'
        assert len(region['points']) >= 3
        assert all(len(p) == 2 and all(type(n) in (int, float) and math.isfinite(n) for n in p) for p in region['points'])
    for marker in world['markers']:
        assert set(marker) <= MARKER_KEYS, 'Private or unexpected marker fields'
        assert marker['kind'] in ('ship', 'npc'), 'Player record refused'
        assert all(type(marker[a]) in (int, float) and math.isfinite(marker[a]) for a in ('x', 'z'))
        assert re.fullmatch('[a-f0-9]{20}', marker['id']), 'Raw entity ID refused'
    client = json.loads((root / 'data/client.json').read_text())
    assert set(client) == {'minecraft', 'mod', 'dependencies'}
    assert hashlib.sha256((root / 'downloads/easter-navy.jar').read_bytes()).hexdigest() == client['mod']['sha256']
    assert all(urlsplit(d['url']).scheme == 'https' for d in client['dependencies'])
    return world


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('href', 'src') and value:
                self.links.append(value)


def validate_site(root):
    root = Path(root).resolve()
    world = validate_data(root)
    for page in root.rglob('*.html'):
        parser = Links()
        parser.feed(page.read_text())
        for link in parser.links:
            url = urlsplit(link)
            if url.scheme or url.netloc or not url.path:
                continue
            target = (root / unquote(url.path.lstrip('/'))) if url.path.startswith('/') else page.parent / unquote(url.path)
            target = target.resolve()
            assert target.is_relative_to(root), f'Link leaves public root: {link}'
            assert target.exists(), f'Broken local link in {page.name}: {link}'
            if target.is_dir():
                assert (target / 'index.html').exists()
    files = [p for p in root.rglob('*') if p.is_file()]
    assert sum(p.stat().st_size for p in files) < 900 * 1024 * 1024, 'Site approaches the Pages size limit'
    assert not any(p.name.startswith('.env') or p.suffix in ('.db', '.sqlite3', '.mca', '.dat') for p in files), 'Private source data in site'
    print(f'Public site validated: {len(world["tiles"])} tiles, {len(world["markers"])} non-player markers, {len(files)} files')


if __name__ == '__main__':
    validate_site(Path(sys.argv[1] if len(sys.argv) > 1 else 'site'))
