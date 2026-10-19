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

# Running this file directly puts scripts/ on sys.path, not the repository root.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.export_world import DEPENDENCIES, PUBLIC_MARKER_ICONS, PUBLIC_MARKER_KINDS, chunk_version, visual_files, validate_deployment

#: 'kind' is a public marker category, never a row type or a player faction. A payload
#: carrying 'faction' is refused outright rather than rewritten. Older snapshots in the
#: archive may predate this allowlist; only validate_data on the payload being published
#: has to hold.
MARKER_KEYS = {'id', 'kind', 'name', 'x', 'z', 'observed_at', 'icon'}
WORLD_KEYS = {'schema', 'captured_at', 'snapshot_day', 'missed_days', 'center', 'region_blocks',
              'saved_chunk_slots', 'tiles', 'regions', 'markers', 'unlocated_markers', 'position_source'}
REGION_KEYS = {'id', 'name', 'short_name', 'points', 'pvp_protection', 'pve_protection', 'edit_protection',
               'navy_controlled', 'guard_patrols', 'navy_patrols'}

#: The published client manifest: the flat fields every shipped launcher already reads, plus
#: the chunk list from doc/launcher-states.md. Both describe the same client, so a chunk list
#: that disagrees with the flat fields is refused rather than published as a second truth.
CLIENT_KEYS = {'minecraft', 'mod', 'dependencies', 'fabric', 'chunks', 'deployment'}
MOD_KEYS = {'name', 'version', 'sha256', 'bytes', 'url'}
DEPENDENCY_KEYS = {'id', 'name', 'version', 'url'}
CHUNK_KEYS = {'id', 'name', 'optional', 'immutable', 'version', 'files', 'fabric', 'java'}
PACKAGE_FILE_KEYS = {'id', 'name', 'version', 'path', 'url', 'hash', 'size'}
PINNED_CHUNKS = {'base': (False, True), 'graphics': (True, False), 'visuals': (False, True)}
#: A packaged file may be served from our own relative tree or from its publisher over https.
#: Nothing else: an http:// URL or an absolute local path is refused.
HASH_PATTERN = re.compile('sha(256|512):[a-f0-9]+')
HASH_LENGTHS = {'sha256': 64, 'sha512': 128}


def valid_hash(value):
    return (type(value) is str and HASH_PATTERN.fullmatch(value) is not None
            and len(value.split(':', 1)[1]) == HASH_LENGTHS[value.split(':', 1)[0]])


def published_url_ok(value, flat_mod_url):
    if value == flat_mod_url and not urlsplit(value).scheme:
        return True
    return urlsplit(value).scheme == 'https'


def validate_packages(client, mod_id, dependency_ids):
    """Refuse a chunk list that contradicts the flat fields or cannot be downloaded.

    Every shipped launcher, old and new, reads this one file. The chunks and the flat fields
    describe the same client, so a disagreement between them is a publishing error, not a
    preference, and it is refused here rather than shipped.
    """
    packages = client['chunks']
    assert type(packages) is list and packages, 'A chunk list must be a non-empty list'
    chunks, files, listed = {}, {}, set()
    for chunk in packages:
        assert type(chunk) is dict and set(chunk) == CHUNK_KEYS, 'Unexpected chunk fields'
        ident, name, version = chunk['id'], chunk['name'], chunk['version']
        assert type(ident) is str and re.fullmatch('[a-z][a-z0-9_-]{0,40}', ident), 'Invalid chunk id'
        assert ident not in chunks, f'Duplicated chunk id: {ident}'
        assert type(name) is str and name, f'Chunk {ident} has no name'
        assert type(chunk['optional']) is bool, f'Chunk {ident} optional must be a boolean'
        assert type(chunk['immutable']) is bool, f'Chunk {ident} immutable must be a boolean'
        assert type(version) is str and version, f'Chunk {ident} has no version'
        if ident in PINNED_CHUNKS:
            optional, immutable = PINNED_CHUNKS[ident]
            assert chunk['optional'] is optional, f'Chunk {ident} optional must be {optional}'
            assert chunk['immutable'] is immutable, f'Chunk {ident} immutable must be {immutable}'
        if ident == 'base':
            # The frozen game identity: the launcher proves nothing changed from this.
            assert chunk['fabric'] == client.get('fabric') and client.get('fabric'), \
                'Base chunk fabric differs from the manifest Fabric loader'
            assert type(chunk['java']) is int and chunk['java'] > 0, 'Base chunk has no Java version'
            assert client['minecraft'] in chunk['name'], \
                f"Base chunk name does not state the manifest Minecraft version {client['minecraft']}"
        entries = chunk['files']
        assert type(entries) is list and entries, f'Chunk {ident} has no files'
        # A chunk version must be a function of its content. Our own mod jar lives in the base
        # chunk and is updated while Minecraft stays frozen, so an identity such as '26.2'
        # would leave a mod update invisible and a client would skip the chunk permanently.
        assert chunk['version'] == chunk_version(chunk), \
            f"Chunk {ident} version is not the digest of the files it publishes"
        for entry in entries:
            assert type(entry) is dict and set(entry) == PACKAGE_FILE_KEYS, \
                f'Unexpected file fields in chunk {ident}'
            path, url = entry['path'], entry['url']
            assert type(path) is str and path
            assert not path.startswith('/') and '\\' not in path and ':' not in path, \
                f'Absolute or private path refused: {path}'
            assert published_url_ok(url, client['mod'].get('url')), f'Insecure or foreign URL refused: {url}'
            assert urlsplit(url).scheme != 'http', f'Plain http download refused: {url}'
            assert valid_hash(entry['hash']), f"File {path} has no valid hex sha256 or sha512 hash"
            assert type(entry['size']) is int and entry['size'] > 0, f'File {path} has no size'
            assert path not in files, f'File {path} is published more than once'
            files[path] = (ident, entry)
        chunks[ident] = chunk
    # The flat fields must survive verbatim and stay consistent with the chunks, so no
    # launcher -- old or new -- can be handed two contradictory descriptions of one client.
    mod_url = client['mod'].get('url', 'downloads/easter-navy.jar')
    assert mod_url in files, 'The custom mod jar is missing from the chunks'
    mod_chunk, mod_entry = files[mod_url]
    assert mod_entry['hash'] == 'sha256:' + client['mod']['sha256'], 'Mod chunk hash disagrees with the manifest'
    assert mod_entry['size'] == client['mod']['bytes'], 'Mod chunk size disagrees with the manifest'
    assert mod_entry['version'] == client['mod']['version'], 'Mod chunk version disagrees with the manifest'
    assert mod_entry['id'] == mod_id, 'Mod chunk id disagrees with the published jar'
    assert mod_chunk == 'base', 'The required client mod belongs to the base chunk'
    for dependency in client['dependencies']:
        assert dependency['id'] in dependency_ids, f"Unpinned dependency id: {dependency['id']}"
        # The launcher saves a jar under the project's own id, so a dependency is found by
        # its id, not by a publisher file name the upstream is free to change.
        matching = [path for path, (chunk_id, entry) in files.items() if entry['id'] == dependency['id']]
        assert len(matching) == 1, f"Dependency {dependency['id']} is missing from the chunks"
        chunk_id, entry = files[matching[0]]
        assert entry['version'] == dependency['version'], \
            f"Dependency {dependency['id']} chunk version disagrees with the manifest"
        assert chunk_id == 'base' or chunks[chunk_id]['optional'], \
            f"Dependency {dependency['id']} must be in the required base chunk"
        listed.add(chunk_id)
    assert 'base' in listed, 'Every pinned dependency must be part of the required base chunk'
    for ident, chunk in chunks.items():
        if ident in PINNED_CHUNKS and not PINNED_CHUNKS[ident][1]:
            continue  # an optional chunk is published only when it has real content
        assert chunk['files'], f'Chunk {ident} has no files'
    # No omissions and no substitutions in what the launcher must install: the required
    # chunks are exactly the client the flat fields describe, so the two cannot drift into
    # two different clients. An optional chunk may carry extras of its own.
    assert {entry['id'] for path, (chunk_id, entry) in files.items() if chunk_id == 'base'} \
        == {mod_id, *[d['id'] for d in client['dependencies']]}, \
        'The required chunk files do not match the manifest mod and dependencies'
    approved_visuals = visual_files(client['minecraft'])
    if 'visuals' in chunks:
        assert chunks['visuals']['files'] == approved_visuals['always'], 'Unreviewed visual content'
    foliage = [entry for chunk in packages for entry in chunk['files']
               if entry['id'] == 'grassier-grass']
    if foliage:
        assert foliage == approved_visuals['shaders'], 'Unreviewed foliage content'
        assert all(entry in chunks.get('graphics', {}).get('files', []) for entry in foliage)
    # Only exact, reviewed public visual artifacts bypass the broad word scan: the
    # official FA Player Extension name is public product metadata, not player data.
    approved = approved_visuals['always'] + approved_visuals['shaders']
    flattened = json.dumps([{**chunk, 'files': [entry for entry in chunk['files']
                                             if entry not in approved]} for chunk in packages])
    for forbidden in ('/home/', '/root/', '/opt/', 'player', 'faction', 'token', 'password', 'secret'):
        assert forbidden not in flattened, f'Private detail in the chunk list: {forbidden}'


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
        assert marker['kind'] in PUBLIC_MARKER_KINDS, 'Player-facing or unknown marker kind refused'
        assert marker.get('icon') in (None, *PUBLIC_MARKER_ICONS), 'Unexpected marker icon'
        assert all(type(marker[a]) in (int, float) and math.isfinite(marker[a]) for a in ('x', 'z'))
        assert re.fullmatch('[a-f0-9]{20}', marker['id']), 'Raw entity ID refused'
    client = json.loads((root / 'data/client.json').read_text())
    assert set(client) <= CLIENT_KEYS and {'minecraft', 'mod', 'dependencies'} <= set(client), \
        'Unexpected client manifest fields'
    if 'deployment' in client:
        validate_deployment(client['deployment'])
    assert {'version', 'sha256'} <= set(client['mod']) <= MOD_KEYS, 'Unexpected client mod fields'
    assert hashlib.sha256((root / 'downloads/easter-navy.jar').read_bytes()).hexdigest() == client['mod']['sha256'], \
        'The published custom mod jar does not match the manifest checksum'
    assert client['mod'].get('url', 'downloads/easter-navy.jar') == 'downloads/easter-navy.jar', \
        'Unexpected custom mod location'
    assert all(urlsplit(d['url']).scheme == 'https' for d in client['dependencies'])
    assert all(set(d) == DEPENDENCY_KEYS for d in client['dependencies']), 'Unexpected dependency fields'
    # Absent chunks mean a manifest from before chunking: still valid, because a launcher
    # already installed on a machine reads only the flat fields above.
    if 'chunks' in client:
        validate_packages(client, 'easter-navy', set(DEPENDENCIES))
    else:
        assert client.get('fabric') is None, 'A Fabric pin without a chunk list describes nothing'
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
