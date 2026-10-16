import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import zipfile

from scripts.export_world import (FABRIC_FALLBACK, MANIFEST_KEYS, PUBLIC_MARKER_KINDS, chunk_version,
                                  declared_fabric, export_client, fetch_modrinth_versions, manifest_text,
                                  modrinth_resolver, packages, parse_modrinth_files, public_marker,
                                  public_marker_kind, read_resolution_state, resolve_dependencies,
                                  resolved_pins, write_json, DEPENDENCIES, ZONE)
from scripts.sync import publish
from scripts.validate import validate_data, MARKER_KEYS

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=')
NOW = datetime(2026, 10, 15, 14, tzinfo=timezone.utc)
SHA512 = 'ab' * 64


def modrinth_release(ident, version, minecraft='26.2', loaders=('fabric',), digest=SHA512, size=1024,
                     primary=True, filename=None, url=None, host='cdn.modrinth.com'):
    """One fixture version record, shaped exactly as the publisher's API returns it."""
    filename = filename or f'{ident}-{version}.jar'
    return {'version_number': version, 'game_versions': [minecraft], 'loaders': list(loaders),
            'files': [{'primary': primary, 'filename': filename, 'size': size,
                       'url': url or f'https://{host}/data/AAAA/versions/BBBB/{filename}',
                       'hashes': {'sha512': digest, 'sha1': 'c' * 40}}]}


def fixture_resolver(dependencies, releases=None, calls=None):
    """A resolver that answers from fixtures, so tests never touch the publisher's network.

    It reports a dependency it cannot answer for the way the real resolver does: the whole
    resolution fails, naming the dependency, rather than quietly dropping it.
    """
    def resolve(entries, wanted, minecraft):
        resolved, failures = {}, []
        for ident, version in wanted:
            if calls is not None:
                calls.append(ident)
            try:
                if releases is not None and ident in releases:
                    resolved[ident] = {'version': version, 'fetched_at': NOW.isoformat(),
                                       **parse_modrinth_files(releases[ident], ident, version, minecraft)}
                else:
                    resolved[ident] = {'version': version, 'fetched_at': NOW.isoformat(),
                                       'name': f'{ident}-{version}.jar', 'size': 1024,
                                       'url': f'https://cdn.modrinth.com/data/{ident}/{version}/{ident}-{version}.jar',
                                       'hash': 'sha512:' + SHA512}
            except ValueError as error:
                failures.append(f'{ident} {version}: {error}')
        if failures:
            raise RuntimeError('Modrinth could not confirm ' + '; '.join(failures))
        return resolved
    return resolve


def fixture_mod_jar(root, ident='easter-navy'):
    """The one local jar the exporter redistributes, staged where the exporter expects it."""
    target = Path(root) / f'downloads/{ident}.jar'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'own-mod-fixture')
    return target


def fixture_export(root, source=None, now=NOW, previous_day=None, markers=None, client=None):
    root = Path(root)
    path = root / 'data/tiles/0/0.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PNG)
    day = now.astimezone(ZONE).date()
    write_json(root / 'data/world.json', {
        'schema': 1, 'captured_at': now.isoformat(), 'snapshot_day': day.isoformat(),
        'missed_days': max(0, (day - datetime.fromisoformat(previous_day).date()).days - 1) if previous_day else 0,
        'center': [0, 0], 'region_blocks': 512, 'saved_chunk_slots': 1,
        'tiles': [{'x': 0, 'z': 0, 'version': hashlib.sha256(PNG).hexdigest()}],
        'regions': [], 'markers': list(markers or []), 'unlocated_markers': 0, 'position_source': 'Saved non-player records',
    })
    target = fixture_mod_jar(root)
    write_json(root / 'data/client.json', client if client is not None else {
        'minecraft': '26.2', 'mod': {'version': 'test', 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}, 'dependencies': [],
    })


def fixture_package_files(root, dependencies=None):
    """The file entries a chunk list needs to describe the flat fixture client exactly."""
    dependencies = DEPENDENCIES if dependencies is None else dependencies
    target = fixture_mod_jar(root)
    entries = [{'id': 'easter-navy', 'name': 'Easter Co. client', 'version': 'test',
                'path': 'downloads/easter-navy.jar', 'url': 'downloads/easter-navy.jar',
                'hash': 'sha256:' + hashlib.sha256(target.read_bytes()).hexdigest(),
                'size': target.stat().st_size}]
    for ident in dependencies:
        entries.append({'id': ident, 'name': ident, 'version': '1.0.0', 'path': f'{ident}-1.0.0.jar',
                        'url': f'https://cdn.modrinth.com/data/{ident}/1.0.0/{ident}-1.0.0.jar',
                        'hash': 'sha512:' + SHA512, 'size': 2048})
    return entries


def chunked_client(root, chunks=None, dependencies=None):
    """A flat manifest plus a consistent chunk list: the shape the exporter publishes."""
    dependencies = DEPENDENCIES if dependencies is None else dependencies
    files = fixture_package_files(root, dependencies)
    chunks = chunks if chunks is not None else [{
        'id': 'base', 'name': 'Minecraft 26.2 game, libraries and required mods', 'optional': False,
        'immutable': True, 'version': '26.2', 'fabric': '0.19.5', 'java': 25,
        'files': sorted(files, key=lambda entry: entry['path']),
    }]
    for chunk in chunks:
        if chunk['files']:
            chunk['version'] = chunk_version(chunk)  # the same content digest the exporter publishes
    mod = next(f for f in files if f['path'] == 'downloads/easter-navy.jar')
    return {
        'minecraft': '26.2', 'fabric': '0.19.5',
        'mod': {'name': 'Easter Co. client', 'version': mod['version'], 'sha256': mod['hash'].split(':', 1)[1],
                'bytes': mod['size'], 'url': mod['url']},
        'dependencies': [{'id': ident, 'name': ident, 'version': '1.0.0',
                          'url': DEPENDENCIES[ident]} for ident in dependencies],
        'chunks': chunks,
    }


def run_git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=True).stdout.strip()


class PublicMarkerCategoryTests(unittest.TestCase):
    """The public map key has exactly four marker categories, and player factions are not among them."""

    def row(self, **updates):
        return {'kind': 'npc', 'id': 'entity', 'name': 'Name', 'x': 1, 'z': 2,
                'read_at': NOW.timestamp(), 'age_seconds': 60} | updates

    def test_public_categories_are_exactly_the_five_published_kinds(self):
        self.assertEqual(PUBLIC_MARKER_KINDS, ('ship', 'sea_patrol', 'land_patrol', 'villager', 'mob'))

    def test_a_hull_without_the_patrol_flag_is_a_ship(self):
        for navy_patrol in (False, None):
            with self.subTest(navy_patrol=navy_patrol):
                marker = public_marker(self.row(kind='ship', name='The Falcon', navy_patrol=navy_patrol), NOW)
                self.assertEqual(marker['kind'], 'ship')
                self.assertEqual(marker['icon'], 'hull')

    def test_a_hull_the_registry_marks_as_a_navy_patrol_is_a_sea_patrol(self):
        marker = public_marker(self.row(kind='ship', name='Navy Patrol - Easter', navy_patrol=True,
                                       patrol_region='easter-isle', faction='navy', icon='navy_ship'), NOW)
        self.assertEqual(marker['kind'], 'sea_patrol')
        self.assertEqual(marker['icon'], 'navy_ship')
        self.assertNotIn('faction', marker)

    def test_patrol_rosters_and_the_region_patrol_kind_are_land_patrols(self):
        for npc_kind in ('sailor', 'region_guard', 'navy_patrol'):
            with self.subTest(npc_kind=npc_kind):
                marker = public_marker(self.row(npc_kind=npc_kind, icon='navy_unit'), NOW)
                self.assertEqual(marker['kind'], 'land_patrol')
                self.assertEqual(marker['icon'], 'navy_unit-guard')

    def test_guard_patrol_icon_alone_makes_a_row_a_land_patrol(self):
        self.assertEqual(public_marker_kind(self.row(npc_kind=None, icon='guard_patrol')), 'land_patrol')

    def test_wildlife_roster_is_a_mob(self):
        marker = public_marker(self.row(npc_kind='wildlife', name='Cow'), NOW)
        self.assertEqual(marker['kind'], 'mob')
        self.assertNotIn('icon', marker)

    def test_villager_and_islander_rosters_are_villagers(self):
        for npc_kind in ('villager', 'islander', None):
            with self.subTest(npc_kind=npc_kind):
                marker = public_marker(self.row(npc_kind=npc_kind), NOW)
                self.assertEqual(marker['kind'], 'villager')
                self.assertNotIn('icon', marker)

    def test_a_private_faction_never_reaches_the_public_marker(self):
        for faction in ('navy', 'citizen', 'criminal', 'pirate', 'prisoner', 'unknown'):
            with self.subTest(faction=faction):
                marker = public_marker(self.row(faction=faction, npc_kind='villager'), NOW)
                self.assertNotIn('faction', marker)
                self.assertNotIn(faction, json.dumps(marker))
        # A faction-carrying row is still exported by its roster kind, not by its faction.
        self.assertEqual(public_marker(self.row(faction='navy', npc_kind='wildlife'), NOW)['kind'], 'mob')

    def test_only_ship_and_npc_rows_are_publishable(self):
        for kind in ('player', 'players', 'zone', '', None):
            with self.subTest(kind=kind):
                self.assertIsNone(public_marker_kind({'kind': kind}))
                self.assertIsNone(public_marker(self.row(kind=kind), NOW))

    def test_validation_refuses_player_ish_unknown_and_faction_markers(self):
        for marker in (
            {'id': 'a' * 20, 'kind': 'npc', 'x': 0, 'z': 0, 'faction': 'navy'},
            {'id': 'a' * 20, 'kind': 'navy', 'x': 0, 'z': 0},
            {'id': 'a' * 20, 'kind': 'pirate', 'x': 0, 'z': 0},
            {'id': 'a' * 20, 'kind': 'player', 'x': 0, 'z': 0},
            {'id': 'a' * 20, 'kind': 'patrol', 'x': 0, 'z': 0},
            {'id': 'a' * 20, 'kind': 'guard', 'x': 0, 'z': 0},
            {'id': 'a' * 20, 'kind': '', 'x': 0, 'z': 0},
            {'id': 'a' * 20, 'kind': 'ship', 'x': 0, 'z': 0, 'icon': 'navy_unit'},
            {'id': 'a' * 20, 'kind': 'land_patrol', 'x': 0, 'z': 0, 'icon': 'guard_patrol'},
        ):
            with self.subTest(marker=marker):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    fixture_export(root, markers=[marker])
                    with self.assertRaises(AssertionError):
                        validate_data(root)

    def test_validation_accepts_every_published_kind(self):
        markers = [
            {'id': hashlib.sha256(kind.encode()).hexdigest()[:20], 'kind': kind, 'name': kind,
             'x': 1.0, 'z': 2.0, 'observed_at': NOW.isoformat(), **({'icon': icon} if icon else {})}
            for kind, icon in (('ship', 'hull'), ('sea_patrol', 'navy_ship'), ('land_patrol', 'navy_unit-guard'),
                               ('villager', None), ('mob', None))]
        self.assertEqual([m['kind'] for m in markers], list(PUBLIC_MARKER_KINDS))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture_export(root, markers=markers)
            world = validate_data(root)
            self.assertEqual([m['kind'] for m in world['markers']], [m['kind'] for m in markers])


class PrivacyTests(unittest.TestCase):
    def test_download_exports_our_jar_and_exact_stack_version_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            paths = []
            for ident in ['easter-navy', *DEPENDENCIES]:
                path = root / (ident + '.jar')
                with zipfile.ZipFile(path, 'w') as jar:
                    jar.writestr('fabric.mod.json', json.dumps({'id': ident, 'name': ident, 'version': '1', 'depends': {'minecraft': '>=26.2'}}))
                paths.append(path)
            target = root / 'public'
            export_client(target, SimpleNamespace(_mods=lambda: paths, facts=SimpleNamespace(stack=lambda: 'MC 26.2 · Fabric 0.19.5')),
                          resolver=fixture_resolver(DEPENDENCIES), state_path=root / 'state/modrinth.json')
            client = json.loads((target / 'data/client.json').read_text())
            self.assertEqual(client['minecraft'], '26.2')
            self.assertEqual([p.name for p in (target / 'downloads').iterdir()], ['easter-navy.jar'])
            self.assertEqual(len(client['dependencies']), 5)

    def test_allowlist_never_copies_player_fields_or_raw_entity_id(self):
        row = {'kind': 'npc', 'id': 'private-uuid', 'name': 'Guard', 'x': 1, 'z': 2, 'y': 64,
               'read_at': NOW.timestamp(), 'age_seconds': 60, 'faction': 'navy', 'npc_kind': 'sailor',
               'owner': 'private-owner', 'players': [{'x': 99}], 'provenance': {'path': '/private'}, 'detail': 'private detail'}
        result = public_marker(row, NOW)
        self.assertLessEqual(set(result), MARKER_KEYS)
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(result['observed_at'], (NOW - timedelta(seconds=60)).isoformat())
        self.assertIsNone(public_marker(row | {'kind': 'player'}, NOW))

    def test_unknown_or_invalid_positions_are_never_invented(self):
        for x in (None, '1', float('nan'), float('inf'), True):
            self.assertIsNone(public_marker({'kind': 'ship', 'x': x, 'z': 1}, NOW))
        self.assertIsNone(public_marker({'kind': 'ship', 'x': 1, 'z': 2}, NOW)['observed_at'])

    def test_validation_refuses_player_payload_and_modified_tiles(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture_export(root)
            validate_data(root)
            path = root / 'data/world.json'
            doc = json.loads(path.read_text())
            doc['markers'] = [{'kind': 'player', 'id': 'a'*20, 'x': 0, 'z': 0}]
            write_json(path, doc)
            with self.assertRaises(AssertionError):
                validate_data(root)
            fixture_export(root)
            (root / 'data/tiles/0/0.png').write_bytes(PNG + b'changed')
            with self.assertRaises(AssertionError):
                validate_data(root)


class ClientChunkTests(unittest.TestCase):
    """The published chunk list, which must agree with the flat fields an old launcher reads."""

    def staged(self, root, client):
        """Stage a complete public payload whose client manifest is the one under test."""
        fixture_export(root, client=client)
        return validate_data(root)

    def chunked(self, root, chunks=None, dependencies=None):
        return chunked_client(root, chunks=chunks, dependencies=dependencies)

    def test_a_chunked_manifest_is_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            world = self.staged(root, self.chunked(root))
            self.assertEqual(len(world['tiles']), 1)
            client = json.loads((root / 'data/client.json').read_text())
            base = client['chunks'][0]
            self.assertEqual(base['id'], 'base')
            self.assertFalse(base['optional'])
            self.assertTrue(base['immutable'])
            self.assertEqual(base['version'], chunk_version(base))
            self.assertNotEqual(base['version'], client['minecraft'])
            self.assertIn(client['minecraft'], base['name'])
            self.assertEqual(base['fabric'], client['fabric'])
            self.assertTrue(base['files'])

    def test_the_flat_fields_still_validate_without_a_chunk_list(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture_export(root)
            client = json.loads((root / 'data/client.json').read_text())
            self.assertEqual(set(client), {'minecraft', 'mod', 'dependencies'})
            validate_data(root)  # an unchanged pre-change manifest stays publishable

    def test_the_flat_fields_keep_their_meaning_and_values(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self.chunked(root)
            self.staged(root, client)
            published = json.loads((root / 'data/client.json').read_text())
            self.assertEqual(set(published) - {'chunks', 'fabric'}, {'minecraft', 'mod', 'dependencies'})
            self.assertEqual(published['minecraft'], '26.2')
            self.assertEqual(published['mod']['url'], 'downloads/easter-navy.jar')
            self.assertEqual(published['mod']['sha256'], client['mod']['sha256'])
            self.assertEqual([d['id'] for d in published['dependencies']], list(DEPENDENCIES))
            self.assertTrue(all(d['url'].startswith('https://modrinth.com/') for d in published['dependencies']))
            base = published['chunks'][0]
            self.assertEqual(set(base) - {'id', 'name', 'optional', 'immutable', 'version', 'files'},
                             {'fabric', 'java'})
            for entry in base['files']:
                self.assertEqual(set(entry), {'id', 'name', 'version', 'path', 'url', 'hash', 'size'})

    def test_an_optional_chunk_is_allowed_and_a_required_one_must_have_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            graphics = {'id': 'graphics', 'name': 'Enhanced graphics and shaders', 'optional': True,
                        'immutable': False, 'version': '26.2', 'fabric': None, 'java': None, 'files': [{
                            'id': 'sodium', 'name': 'Sodium', 'version': '0.9.2', 'path': 'sodium-0.9.2.jar',
                            'url': 'https://cdn.modrinth.com/data/AANobbMI/0.9.2/sodium.jar',
                            'hash': 'sha512:' + SHA512, 'size': 100}]}
            client = self.chunked(root, chunks=self.chunked(root)['chunks'] + [graphics])
            self.staged(root, client)
            self.assertEqual(len(client['chunks']), 2)
            empty = dict(graphics, files=[])
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                fixture_export(root, client=self.chunked(root, chunks=self.chunked(root)['chunks'] + [empty]))
                with self.assertRaises(AssertionError):
                    validate_data(root)

    def test_the_base_chunk_version_is_the_digest_of_its_files(self):
        """The identity must be content, not the Minecraft version: see the mod-bump test."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base = self.chunked(root)['chunks'][0]
            self.assertRegex(base['version'], r'^sha256:[a-f0-9]{64}$')
            self.assertNotEqual(base['version'], '26.2')
            self.assertIn('26.2', base['name'])
            self.assertEqual(base['version'], chunk_version(base))  # recomputed, not echoed
            self.assertNotEqual(chunk_version(dict(base, files=[])), chunk_version(base))
            fixture_export(root, client=self.chunked(root))  # the consistent pair is accepted
            validate_data(root)
            broken = self.chunked(root)
            broken['chunks'][0]['version'] = '26.2'
            fixture_export(root, client=broken)
            with self.assertRaises(AssertionError) as caught:
                validate_data(root)
            self.assertIn('not the digest of the files', str(caught.exception))
            for field, value in (('name', 'Frozen game'), ('fabric', '0.18.0'), ('java', None)):
                with self.subTest(field=field):
                    with tempfile.TemporaryDirectory() as temp:
                        root = Path(temp)
                        amended = self.chunked(root)
                        amended['chunks'][0][field] = value
                        fixture_export(root, client=amended)
                        with self.assertRaises(AssertionError):
                            validate_data(root)

    def test_a_chunk_list_that_disagrees_with_the_flat_fields_is_refused(self):
        def missing_id(client):
            client['chunks'][0]['id'] = ''
            return client

        def duplicated_id(client):
            client['chunks'].append(json.loads(json.dumps(client['chunks'][0])))
            return client

        def not_a_boolean(client):
            client['chunks'][0]['optional'] = 'false'
            return client

        def immutable_not_a_boolean(client):
            client['chunks'][0]['immutable'] = 1
            return client

        def base_marked_optional(client):
            client['chunks'][0]['optional'] = True
            return client

        def forged_hash(client):
            client['chunks'][0]['files'][0]['hash'] = 'md5:abc'
            return client

        def shortened_hash(client):
            client['chunks'][0]['files'][0]['hash'] = 'sha256:abc'
            return client

        def no_size(client):
            client['chunks'][0]['files'][0].pop('size')
            return client

        def zero_size(client):
            client['chunks'][0]['files'][0]['size'] = 0
            return client

        def missing_file(client):
            client['chunks'][0]['files'].pop()
            return client

        def insecure_url(client):
            client['chunks'][0]['files'][1]['url'] = 'http://cdn.modrinth.com/data/x.jar'
            return client

        def foreign_url(client):
            client['chunks'][0]['files'][1]['url'] = 'file:///root/mods/x.jar'
            return client

        def absolute_path(client):
            client['chunks'][0]['files'][1]['path'] = '/root/.minecraft/mods/x.jar'
            return client

        def private_detail(client):
            client['chunks'][0]['name'] = 'base for /home/hannah'
            return client

        def mod_hash_disagrees(client):
            client['mod']['sha256'] = 'f' * 64
            return client

        def dependency_version_disagrees(client):
            client['dependencies'][0]['version'] = '9.9.9'
            return client

        def dependency_missing_from_chunks(client):
            client['chunks'][0]['files'] = [e for e in client['chunks'][0]['files'] if e['id'] != 'tectonic']
            return client

        def required_chunk_not_immutable(client):
            extra = {'id': 'extra', 'name': 'Extra required content', 'optional': False, 'immutable': False,
                     'version': '26.2', 'fabric': None, 'java': None,
                     'files': [{'id': 'extra', 'name': 'Extra', 'version': '1', 'path': 'extra.jar',
                                'url': 'https://cdn.modrinth.com/data/x/1/extra.jar',
                                'hash': 'sha512:' + SHA512, 'size': 5}]}
            client['chunks'].append(extra)
            return client

        def empty_chunk_list(client):
            client['chunks'] = []
            return client

        def chunk_list_not_a_list(client):
            client['chunks'] = {'base': {}}
            return client

        def unknown_field(client):
            client['chunks'][0]['owner'] = 'owen'
            return client

        refusals = {name: value for name, value in locals().items() if callable(value) and name != 'self'}
        self.assertEqual(len(refusals), 21)
        for name, mutate in sorted(refusals.items()):
            with self.subTest(refusal=name):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    fixture_export(root, client=mutate(self.chunked(root)))
                    with self.assertRaises(AssertionError):
                        validate_data(root)

    def test_a_manifest_claiming_a_fabric_pin_without_chunks_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self.chunked(root)
            del client['chunks']
            fixture_export(root, client=client)
            with self.assertRaises(AssertionError):
                validate_data(root)

    def test_validation_refuses_private_paths_or_player_detail_in_the_chunk_list(self):
        for path in ('/root/client.jar', '/home/owen/client.jar', 'C:\\mods\\x.jar'):
            with self.subTest(path=path):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    client = self.chunked(root)
                    client['chunks'][0]['files'][0]['path'] = path
                    fixture_export(root, client=client)
                    with self.assertRaises(AssertionError):
                        validate_data(root)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self.chunked(root)
            client['chunks'][0]['name'] = 'base for /home/hannah'
            fixture_export(root, client=client)
            with self.assertRaises(AssertionError):
                validate_data(root)


class ClientExportTests(unittest.TestCase):
    """The exporter publishes the chunks, stays deterministic, and invents no checksums."""

    def build(self, root, resolver=None, calls=None, state_path=None, mod_version='1.0.0'):
        root.mkdir(parents=True, exist_ok=True)
        paths = []
        for ident in ['easter-navy', *DEPENDENCIES]:
            path = root / (ident + '.jar')
            version = mod_version if ident == 'easter-navy' else '1.0.0'
            with zipfile.ZipFile(path, 'w') as jar:
                jar.writestr('fabric.mod.json', json.dumps({'id': ident, 'name': ident, 'version': version}))
            paths.append(path)
        module = SimpleNamespace(_mods=lambda: paths, facts=SimpleNamespace(stack=lambda: 'MC 26.2 · Fabric 0.19.5'))
        return export_client(root / 'public', module,
                             resolver=resolver if resolver is not None else fixture_resolver(DEPENDENCIES, calls=calls),
                             now=NOW, state_path=state_path if state_path else root / 'state/modrinth.json')

    def test_the_base_chunk_version_changes_when_only_our_mod_changes(self):
        """An Easter Co. jar update while Minecraft stays frozen must be visible to a client.

        The base chunk version is the digest of its files, not the Minecraft version. If it
        were '26.2', bumping our mod would leave the chunk version unchanged, an installed
        client would skip the chunk, and the player would keep the old jar forever.
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = self.build(root, mod_version='2.0.0')
            before = first['chunks'][0]['version']
            self.assertEqual(first['minecraft'], '26.2')
            second = self.build(root / 'again', mod_version='2.1.0')
            after = second['chunks'][0]['version']
            self.assertEqual(second['minecraft'], first['minecraft'])  # Minecraft is unchanged
            self.assertEqual(second['mod']['version'], '2.1.0')
            self.assertEqual([entry['version'] for entry in first['chunks'][0]['files'][1:]],
                             [entry['version'] for entry in second['chunks'][0]['files'][1:]])
            self.assertEqual(first['chunks'][0]['immutable'], second['chunks'][0]['immutable'])
            self.assertNotEqual(before, after)
            self.assertEqual(after, chunk_version(second['chunks'][0]))

    def test_the_export_is_additive_and_deterministic(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self.build(root)
            first = (root / 'public/data/client.json').read_bytes()
            version = client['chunks'][0]['version']
            self.build(root)
            again = (root / 'public/data/client.json').read_bytes()
            self.assertEqual(first, again)  # unchanged inputs, byte-identical manifest
            self.assertEqual(version, json.loads(again)['chunks'][0]['version'])
            published = json.loads(first)
            self.assertEqual(set(published) <= set(MANIFEST_KEYS), True)
            self.assertEqual(published['minecraft'], '26.2')
            self.assertEqual(published['fabric'], '0.19.5')
            self.assertEqual(published['mod']['url'], 'downloads/easter-navy.jar')
            self.assertEqual([d['id'] for d in published['dependencies']], list(DEPENDENCIES))
            base = published['chunks'][0]
            self.assertEqual(base['version'], chunk_version(base))
            self.assertNotEqual(base['version'], published['minecraft'])
            self.assertFalse(base['optional'])
            self.assertTrue(base['immutable'])
            self.assertEqual(sorted(f['path'] for f in base['files'])[0], 'downloads/easter-navy.jar')
            self.assertEqual(len(base['files']), len(DEPENDENCIES) + 1)
            self.assertEqual(client, published)

    def test_the_published_base_chunk_matches_the_flat_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            published = self.build(root)
            target = root / 'public/downloads/easter-navy.jar'
            by_path = {entry['url']: entry for entry in published['chunks'][0]['files']}
            mod = by_path['downloads/easter-navy.jar']
            self.assertEqual(mod['hash'], 'sha256:' + published['mod']['sha256'])
            self.assertEqual(mod['size'], target.stat().st_size)
            self.assertEqual(mod['version'], published['mod']['version'])
            for dependency in published['dependencies']:
                entry = by_path[f"https://cdn.modrinth.com/data/{dependency['id']}/1.0.0/{dependency['id']}-1.0.0.jar"]
                self.assertEqual(entry['hash'], 'sha512:' + SHA512)
                self.assertEqual(entry['version'], dependency['version'])

    def test_an_unresolvable_dependency_fails_the_export_rather_than_omitting_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # The pin exists on the project, but not for our Minecraft version and loader.
            failures = {'tectonic': [modrinth_release('tectonic', '1.0.0', minecraft='1.21.1', loaders=('forge',))]}
            with self.assertRaises(RuntimeError) as caught:
                self.build(root, resolver=fixture_resolver(DEPENDENCIES, releases=failures))
            self.assertIn('tectonic', str(caught.exception))
            self.assertIn('could not confirm', str(caught.exception))
            self.assertFalse((root / 'public/data/client.json').exists())

    def test_the_publisher_s_own_answers_are_required_for_every_file_entry(self):
        # A file that claims a checksum the upstream does not publish is refused.
        for release in (modrinth_release('tectonic', '3.0.28', digest='nothex'),
                        modrinth_release('tectonic', '3.0.28', url='https://example.invalid/x.jar'),
                        modrinth_release('tectonic', '3.0.28', loaders=('forge',))):
            with self.subTest(release=release['loaders']):
                with self.assertRaises(ValueError):
                    parse_modrinth_files([release], 'tectonic', '3.0.28', '26.2')
        parsed = parse_modrinth_files([modrinth_release('tectonic', '3.0.28')], 'tectonic', '3.0.28', '26.2')
        self.assertEqual(parsed['hash'], 'sha512:' + SHA512)
        self.assertEqual(parsed['name'], 'tectonic-3.0.28.jar')

    def test_the_primary_file_and_the_launcher_s_version_match_rule_are_used(self):
        secondary = modrinth_release('x', '1.0.0', primary=False)
        secondary['files'].append({**secondary['files'][0], 'primary': True, 'filename': 'x-1.0.0-primary.jar'})
        parsed = parse_modrinth_files([secondary], 'x', '1.0.0', '26.2')
        self.assertEqual(parsed['name'], 'x-1.0.0-primary.jar')
        # The launcher also accepts a version whose filename carries the pin, as lithostitched does.
        parsed = parse_modrinth_files([modrinth_release('lithostitched', '1.8.0-fabric-26.2')],
                                      'lithostitched', '1.8.0', '26.2')
        self.assertEqual(parsed['name'], 'lithostitched-1.8.0-fabric-26.2.jar')
        with self.assertRaises(ValueError):
            parse_modrinth_files([modrinth_release('tectonic', '3.0.28', minecraft='1.21.1')],
                                 'tectonic', '3.0.28', '26.2')

    def test_resolution_is_cached_and_re_resolved_only_when_the_pin_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / 'state/modrinth.json'
            calls = []
            self.build(root, calls=calls)
            self.assertEqual(sorted(calls), sorted(DEPENDENCIES))
            cached = read_resolution_state(state)
            self.assertEqual(set(cached['entries']), set(DEPENDENCIES))
            self.assertEqual(set(cached['checked']), set(DEPENDENCIES))
            self.assertTrue(all(entry['version'] == '1.0.0' for entry in cached['entries'].values()))
            # A second export reuses the cache: no publisher call, and the same manifest.
            first = (root / 'public/data/client.json').read_bytes()
            calls.clear()
            self.build(root, calls=calls)
            self.assertEqual(calls, [])
            self.assertEqual(first, (root / 'public/data/client.json').read_bytes())
            # A changed pin is resolved again instead of reusing the old answer.
            state.write_text(manifest_text({'entries': dict(cached['entries'], tectonic={'version': '0.0.1'})}))
            calls.clear()
            self.build(root, calls=calls)
            self.assertEqual(calls, ['tectonic'])

    def test_resolution_state_lives_outside_the_published_site(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.build(root)
            published = [p for p in (root / 'public').rglob('*') if p.is_file()]
            self.assertEqual([p.name for p in published if p.name != 'client.json' and p.suffix == '.json'], [])
            self.assertFalse((root / 'public/data/modrinth.json').exists())
            client = json.loads((root / 'public/data/client.json').read_text())
            self.assertEqual([k for k in client if k.startswith('fetched')], [])

    def test_only_the_project_id_and_pins_reach_the_publisher(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'[]'

        def opener(request, timeout=None):
            captured['url'] = request.full_url
            captured['agent'] = request.get_header('User-agent')
            return Response()

        with mock.patch('urllib.request.urlopen', opener):
            fetch_modrinth_versions('fabric-api', '26.2')
        self.assertEqual(captured['url'],
                         'https://api.modrinth.com/v2/project/fabric-api/version'
                         '?loaders=%5B%22fabric%22%5D&game_versions=%5B%2226.2%22%5D')
        self.assertEqual(captured['agent'], 'EasterCompanyLauncher/1.0 (easter-co-smp.github.io)')

    def test_the_resolver_publishes_no_chunk_it_cannot_verify(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = {}
            with self.assertRaises(RuntimeError) as caught:
                resolve_dependencies(None, {'tectonic': {'name': 'Tectonic', 'version': '3.0.28'}},
                                     '26.2', state, now=NOW)
            self.assertIn('unverifiable base chunk', str(caught.exception))
            self.assertFalse(state.get('entries'))
            with self.assertRaises(RuntimeError):
                modrinth_resolver(fetch=lambda ident, minecraft: [])({}, [('tectonic', '3.0.28')], '26.2')
            self.assertTrue(root.exists())

    def test_a_launcher_source_without_a_readable_pin_fails_the_export(self):
        """A remembered loader is the same bug as a stale bundle, so it must be loud."""
        cases = {
            'pin renamed': "const LOADER='0.19.5';\n",
            'pin templated': 'const FABRIC=`${BASE}`;\n',
            'file emptied': '',
            'value not a version': "const FABRIC='latest';\n",
            'declaration removed': "async function prepare(){const fabric=await installer.installFabric();}\n",
        }
        for label, source in cases.items():
            with self.subTest(launcher=label):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    (root / 'desktop').mkdir()
                    (root / 'desktop/install.cjs').write_text(source)
                    with self.assertRaises(RuntimeError) as caught:
                        resolved_pins(root, {'minecraft': '26.2'})
                    self.assertIn('could not be read', str(caught.exception))
                    self.assertIn('refusing to guess', str(caught.exception))
                    self.assertNotIn(FABRIC_FALLBACK, str(caught.exception))

    def test_a_genuinely_absent_launcher_source_is_the_only_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with mock.patch('sys.stdout') as quiet:  # the fallback says so out loud
                pins = resolved_pins(root, {'minecraft': '26.2'})
            self.assertEqual(pins, {'minecraft': '26.2', 'fabric': FABRIC_FALLBACK, 'java': 25})
            self.assertIn('falls back to the built-in pin', quiet.write.call_args_list[0].args[0])
            printed = ''.join(call.args[0] for call in quiet.write.call_args_list)
            self.assertIn(FABRIC_FALLBACK, printed)
        # And the pin really is read from the launcher source when there is one.
        self.assertEqual(declared_fabric(Path('desktop/install.cjs')), '0.19.5')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'desktop').mkdir()
            (root / 'desktop/install.cjs').write_text("const FABRIC='0.19.9';\n")
            self.assertEqual(resolved_pins(root, {'minecraft': '26.2'})['fabric'], '0.19.9')

    def test_the_exporter_refuses_a_non_relative_file_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            paths = []
            for ident in ['easter-navy', *DEPENDENCIES]:
                path = root / (ident + '.jar')
                with zipfile.ZipFile(path, 'w') as jar:
                    jar.writestr('fabric.mod.json', json.dumps({'id': ident, 'name': ident, 'version': '1.0.0'}))
                paths.append(path)
            module = SimpleNamespace(_mods=lambda: paths, facts=SimpleNamespace(stack=lambda: 'MC 26.2 · Fabric 0.19.5'))
            honest = fixture_resolver(DEPENDENCIES)
            resolved = []

            def resolver(entries, wanted, minecraft):
                resolved.extend(ident for ident, _ in wanted)
                return honest(entries, wanted, minecraft)

            # The exported path comes from the publisher's own file name, never from a local path.
            client = export_client(root / 'public', module, resolver=resolver,
                                   state_path=root / 'state/modrinth.json')
            self.assertEqual(sorted(resolved), sorted(DEPENDENCIES))
            for entry in client['chunks'][0]['files']:
                self.assertFalse(entry['path'].startswith('/'))

            def escaping(entries, wanted, minecraft):
                return {ident: {'version': version, 'name': '/home/owen/' + ident + '.jar', 'size': 1,
                                'url': 'https://cdn.modrinth.com/data/x/1/x.jar', 'hash': 'sha512:' + SHA512}
                        for ident, version in wanted}

            with self.assertRaises(RuntimeError) as caught:
                export_client(root / 'public', module, resolver=escaping,
                              state_path=root / 'state/other.json')
            self.assertIn('non-relative file path', str(caught.exception))


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.repo, self.remote, self.state = root / 'repo', root / 'origin.git', root / 'state'
        self.repo.mkdir()
        run_git(self.repo, 'init', '-b', 'main')
        run_git(self.repo, 'config', 'user.name', 'Fixture')
        run_git(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        run_git(root, 'init', '--bare', '--initial-branch=main', str(self.remote))
        fixture_export(self.repo / 'site', now=NOW - timedelta(days=1))
        (self.repo / 'README.md').write_text('Website source\n')
        run_git(self.repo, 'add', '.')
        run_git(self.repo, 'commit', '-m', 'Baseline')
        run_git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        run_git(self.repo, 'push', '-u', 'origin', 'main')

    def capture(self, now=NOW, exporter=fixture_export):
        return publish(self.repo, self.state, Path('/unused'), now=now, exporter=exporter)

    def count(self, root=None):
        return int(run_git(root or self.repo, 'rev-list', '--count', 'main'))

    def test_one_commit_per_day_and_same_day_retries_are_idempotent(self):
        self.assertTrue(self.capture())
        self.assertEqual(self.count(), 2)
        self.assertFalse(self.capture())
        self.assertEqual(self.count(), 2)
        self.assertTrue(self.capture(NOW + timedelta(days=1)))
        self.assertEqual(self.count(), 3)
        self.assertEqual(self.count(self.remote), 3)

    def test_offline_days_stay_committed_then_all_push_on_recovery(self):
        run_git(self.repo, 'remote', 'set-url', 'origin', str(self.remote) + '.offline')
        for day in range(2):
            with self.assertRaises(RuntimeError):
                self.capture(NOW + timedelta(days=day))
        self.assertEqual(self.count(), 3)
        self.assertEqual(self.count(self.remote), 1)
        run_git(self.repo, 'remote', 'set-url', 'origin', str(self.remote))
        self.assertFalse(self.capture(NOW + timedelta(days=1)))
        self.assertEqual(self.count(self.remote), 3)

    def test_machine_downtime_records_a_gap_without_backdating(self):
        self.capture(NOW + timedelta(days=3))
        doc = json.loads((self.repo / 'site/data/world.json').read_text())
        self.assertEqual(doc['missed_days'], 3)
        self.assertEqual(doc['snapshot_day'], '2026-10-18')
        self.assertEqual(doc['captured_at'], (NOW + timedelta(days=3)).isoformat())
        self.assertEqual(self.count(), 2)

    def test_interrupted_install_recovers_only_generated_data(self):
        (self.repo / 'site/data/world.json').write_text('interrupted')
        (self.repo / 'site/data/orphan.json').write_text('partial')
        self.capture()
        self.assertFalse((self.repo / 'site/data/orphan.json').exists())
        self.assertEqual(run_git(self.repo, 'status', '--porcelain'), '')
        (self.repo / 'README.md').write_text('My unfinished edit')
        with self.assertRaises(RuntimeError):
            self.capture(NOW + timedelta(days=1))
        self.assertEqual((self.repo / 'README.md').read_text(), 'My unfinished edit')

    def test_failed_export_retains_last_committed_snapshot(self):
        before = (self.repo / 'site/data/world.json').read_bytes()
        def broken(stage, *args, **kwargs):
            fixture_export(stage)
            raise RuntimeError('World save is changing')
        with self.assertRaises(RuntimeError):
            self.capture(exporter=broken)
        self.assertEqual((self.repo / 'site/data/world.json').read_bytes(), before)
        self.assertEqual(run_git(self.repo, 'status', '--porcelain'), '')

    def test_upstream_website_edits_and_pending_snapshots_both_survive(self):
        run_git(self.repo, 'remote', 'set-url', 'origin', str(self.remote) + '.offline')
        with self.assertRaises(RuntimeError):
            self.capture()
        other = Path(self.temp.name) / 'other'
        run_git(Path(self.temp.name), 'clone', str(self.remote), str(other))
        run_git(other, 'config', 'user.name', 'Fixture')
        run_git(other, 'config', 'user.email', 'fixture@example.invalid')
        (other / 'README.md').write_text('Upstream design update')
        run_git(other, 'add', '.')
        run_git(other, 'commit', '-m', 'Design update')
        run_git(other, 'push')
        run_git(self.repo, 'remote', 'set-url', 'origin', str(self.remote))
        self.assertFalse(self.capture())
        self.assertEqual((self.repo / 'README.md').read_text(), 'Upstream design update')
        self.assertEqual(self.count(self.remote), 3)


if __name__ == '__main__':
    unittest.main()
