import base64
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.parse import urlsplit
import zipfile

from scripts.export_world import (FABRIC_FALLBACK, GRAPHICS_COMPANIONS, GRAPHICS_PACK_NAME,
                                  GRAPHICS_PACK_VERSION, GRAPHICS_PATH_PREFIX, GRAPHICS_PROJECT_ID,
                                  COMPANION_PATH_PREFIX, MANIFEST_KEYS,
                                  MODRINTH_CDN_HOST, PUBLIC_MARKER_KINDS, chunk_version,
                                  declared_fabric, default_resolution_state, ensure_state_writable,
                                  export_client, export_world_snapshot,
                                  PublishedClientArtifacts, fetch_modrinth_versions,
                                  manifest_text, modrinth_resolver, packages, parse_graphics_release,
                                  parse_modrinth_files, public_marker, public_marker_kind,
                                  read_resolution_state, resolve_dependencies, resolved_pins, write_json,
                                  DEPENDENCIES, ZONE)
from scripts import export_world, sync
from scripts.sync import publish
from scripts.validate import MARKER_KEYS, WORLD_KEYS, validate_client, validate_data

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


def graphics_release(loaders=('iris', 'optifine'), minecraft='26.2', version=GRAPHICS_PACK_VERSION,
                     filename=GRAPHICS_PACK_NAME, size=553400, host=MODRINTH_CDN_HOST, hashes=None):
    """One shader-pack release, shaped exactly as the publisher's API returns it."""
    files = [{'primary': True, 'filename': filename, 'size': size,
              'url': f'https://{host}/data/{GRAPHICS_PROJECT_ID}/versions/B1kyfoUZ/{filename}',
              'hashes': {'sha512': SHA512, 'sha1': 'c' * 40} if hashes is None else hashes}]
    return [{'version_number': version, 'game_versions': [minecraft], 'loaders': list(loaders), 'files': files}]


def graphics_fixture_resolver(loaders=('iris', 'optifine'), minecraft='26.2', version=GRAPHICS_PACK_VERSION,
                              filename=GRAPHICS_PACK_NAME, size=553400, host=MODRINTH_CDN_HOST, hashes=None,
                              companion_loaders=('fabric',), companion_size=2821616):
    """A graphics fetch that answers from a fixture, so tests never touch the publisher.

    The chunk asks for the pack (published for iris) and for its loader companions
    (published for fabric), so the fixture answers both shapes.
    """
    def fetch(project, wanted_version, game_version, loader=None):
        if project == GRAPHICS_PROJECT_ID:
            assert wanted_version == GRAPHICS_PACK_VERSION, 'the pinned pack is fetched'
            return graphics_release(loaders, minecraft, version, filename, size, host, hashes)
        companion = next(item for item in GRAPHICS_COMPANIONS if item['id'] == project)
        assert wanted_version == companion['version'], 'the pinned loader is fetched by version'
        assert loader == 'fabric', 'a loader is a fabric mod'
        return graphics_release(companion_loaders, minecraft, wanted_version,
                                f"{project}-fabric-{wanted_version}+mc{minecraft}.jar",
                                companion_size, host, hashes)

    return fetch


def fixture_mod_jar(root, ident='easter-navy'):
    """The one local jar the exporter redistributes, staged where the exporter expects it."""
    target = Path(root) / f'downloads/{ident}.jar'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'own-mod-fixture')
    return target


LOCAL_DEPLOYMENT = {'schema': 1, 'serverAddress': '10.0.0.5:25565'}
#: The production deployment, and the reason the map half has refused since 2026-10-19.
REMOTE_DEPLOYMENT = {'schema': 1, 'serverAddress': 'smp.easter.company:25565'}


def snapshot_source(deployment):
    """Point the exporter's own gate at a local or a remote game deployment.

    Both the probe and the exporter read this one function, so a patched deployment is what
    the run really sees: the gate is never bypassed, only aimed.
    """
    return mock.patch('scripts.export_world.deployment_metadata', return_value=deployment)


def fixture_client_half(version='test', payload=b'own-mod-fixture'):
    """A client half that publishes a fixture manifest, so tests never touch the network.

    Its output is byte-identical to fixture_export's client manifest by default, so the
    recovery fixtures keep the published client unchanged unless a test bumps it on purpose.
    """
    def publish_client(stage, state_dir, now=None):
        target = Path(stage) / 'downloads/easter-navy.jar'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        write_json(Path(stage) / 'data/client.json', {
            'minecraft': '26.2',
            'mod': {'version': version, 'sha256': hashlib.sha256(payload).hexdigest()},
            'dependencies': [],
        })
    return publish_client


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
                          resolver=fixture_resolver(DEPENDENCIES), state_path=root / 'state/modrinth.json',
                          graphics_resolver=graphics_fixture_resolver())
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
            # Every chunk carries the same field set; the game pins are the base chunk's own.
            for chunk in published['chunks']:
                self.assertEqual(set(chunk) - {'id', 'name', 'optional', 'immutable', 'version', 'files'},
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

    def build(self, root, resolver=None, calls=None, state_path=None, mod_version='1.0.0',
              graphics_resolver=None):
        root.mkdir(parents=True, exist_ok=True)
        paths = []
        for ident in ['easter-navy', *DEPENDENCIES]:
            path = root / (ident + '.jar')
            version = mod_version if ident == 'easter-navy' else '1.0.0'
            with zipfile.ZipFile(path, 'w') as jar:
                # ZIP headers are input bytes too: recreating the same fake release
                # must not change its hash when the wall clock crosses a DOS tick.
                member = zipfile.ZipInfo('fabric.mod.json', date_time=(1980, 1, 1, 0, 0, 0))
                jar.writestr(member, json.dumps({'id': ident, 'name': ident, 'version': version}))
            paths.append(path)
        module = SimpleNamespace(_mods=lambda: paths, facts=SimpleNamespace(stack=lambda: 'MC 26.2 · Fabric 0.19.5'))
        return export_client(root / 'public', module,
                             resolver=resolver if resolver is not None else fixture_resolver(DEPENDENCIES, calls=calls),
                             now=NOW, state_path=state_path if state_path else root / 'state/modrinth.json',
                             graphics_resolver=graphics_resolver if graphics_resolver is not None
                             else graphics_fixture_resolver())

    def test_the_graphics_chunk_publishes_the_pinned_pack_from_its_publisher(self):
        """The optional graphics chunk: one shader pack, its publisher's own artifact.

        Owen's server look is Complementary Unbound r5.9.3 and the other three packs the
        clients arrived with were trimmed, so the chunk describes exactly that one file.
        A shader pack is published for the iris/optifine loaders, so it cannot be resolved
        the way a fabric mod is; the pinned version is fetched directly and held to the same
        rules -- the publisher's own CDN and the publisher's own sha512 -- and a release that
        does not fit is refused rather than published.
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            calls = []
            def fetch(project, version, minecraft, loader=None):
                calls.append((project, version, minecraft))
                if project == GRAPHICS_PROJECT_ID:
                    return graphics_release()
                return graphics_release(('fabric',), minecraft, version,
                                        f'{project}-fabric-{version}+mc{minecraft}.jar', 1234)
            client = self.build(root, graphics_resolver=fetch)
            chunks = {chunk['id']: chunk for chunk in client['chunks']}
            self.assertEqual(sorted(chunks), ['base', 'graphics', 'visuals'])
            self.assertFalse(chunks['visuals']['optional'])
            self.assertEqual(chunks['visuals']['version'], chunk_version(chunks['visuals']))
            graphics = chunks['graphics']
            self.assertTrue(graphics['optional'], 'the graphics chunk is switched off by default, so it is optional')
            self.assertFalse(graphics['immutable'], 'an optional chunk is re-verified, not trusted once')
            self.assertEqual(graphics['version'], chunk_version(graphics))
            self.assertIn('26.2', graphics['name'])
            pack, *loaders = [entry for entry in graphics['files'] if entry['id'] != 'grassier-grass']
            foliage = next(entry for entry in graphics['files'] if entry['id'] == 'grassier-grass')
            self.assertTrue(foliage['path'].endswith('.jar.disabled'))
            for entry in [pack, *loaders]:
                self.assertEqual(set(entry), {'id', 'name', 'version', 'path', 'url', 'hash', 'size'})
                self.assertEqual(urlsplit(entry['url']).hostname, 'cdn.modrinth.com')
                self.assertEqual(entry['hash'], 'sha512:' + SHA512)
            self.assertEqual(pack['id'], GRAPHICS_PROJECT_ID)
            self.assertEqual(pack['version'], GRAPHICS_PACK_VERSION)
            self.assertEqual(pack['path'], GRAPHICS_PATH_PREFIX + GRAPHICS_PACK_NAME)
            self.assertEqual(pack['size'], 553400)
            # The loader travels with the pack: without Iris the config file the launcher
            # writes is inert and the player sees no shaders at all.
            self.assertEqual([entry['id'] for entry in loaders], [item['id'] for item in GRAPHICS_COMPANIONS])
            for entry, pinned in zip(loaders, GRAPHICS_COMPANIONS):
                self.assertEqual(entry['version'], pinned['version'])
                self.assertTrue(entry['path'].startswith(COMPANION_PATH_PREFIX), 'a loader installs under mods/')
                self.assertTrue(entry['path'].endswith('.jar'))
            # The resolver is asked for the pinned project and version, like every other pin.
            self.assertEqual(calls, [(GRAPHICS_PROJECT_ID, GRAPHICS_PACK_VERSION, '26.2'),
                                     ('iris', '1.11.4+26.2-fabric', '26.2'),
                                     ('sodium', 'mc26.2-0.9.2-fabric', '26.2')])
            # The pack filename becomes a path in the manifest, so it is validated, not
            # sanitised: a publisher filename that would escape the chunk is refused.
            for filename in ('../../etc/passwd', 'pack.zip/../../x', '', 'pack.tar.gz'):
                with self.subTest(filename=filename):
                    with self.assertRaises(ValueError):
                        parse_graphics_release(graphics_release(filename=filename), GRAPHICS_PACK_VERSION, '26.2')
            # The chunk is a function of its own file list: a different artifact is a
            # different chunk version, which is what makes an installed client update.
            other = packages(chunks['base']['files'][0], {'mods': chunks['base']['files'][1:]},
                             {'minecraft': '26.2', 'fabric': '0.19.5', 'java': 25},
                             {'name': 'Complementary Shaders - Unbound', 'version': GRAPHICS_PACK_VERSION,
                              'path': GRAPHICS_PATH_PREFIX + GRAPHICS_PACK_NAME, 'url': pack['url'],
                              'hash': 'sha512:' + 'cd' * 64, 'size': 553400})[1]
            self.assertNotEqual(other['version'], graphics['version'])
            # And the exported manifest is the shape the site validator accepts, staged as
            # the public payload the exporter would publish: the manifest with the jar it
            # actually describes, never a fixture jar under its checksum.
            fixture_export(root, client=client)
            shutil.copyfile(root / 'public/downloads/easter-navy.jar', root / 'downloads/easter-navy.jar')
            validate_data(root)
            self.assertEqual(json.loads((root / 'data/client.json').read_text())['chunks'][1], graphics)
            # The resolver is asked for the pinned project and version, like every other pin.
            self.assertEqual(calls, [(GRAPHICS_PROJECT_ID, GRAPHICS_PACK_VERSION, '26.2'),
                                     ('iris', '1.11.4+26.2-fabric', '26.2'),
                                     ('sodium', 'mc26.2-0.9.2-fabric', '26.2')])
            # The cached confirmation is reused, so a second export into another tree makes
            # no second call: the pin is confirmed once, not once per export.
            before = list(calls)
            self.build(root / 'again', state_path=root / 'state/modrinth.json',
                       graphics_resolver=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('the confirmed artifact was not reused')))
            self.assertEqual(calls, before, 'the confirmed pack and loader are reused')

    def test_an_unusable_graphics_release_is_refused_rather_than_published(self):
        """A pack that does not fit, or an unreachable publisher, fails the export.

        Silently omitting the chunk would switch every player's enhanced graphics off with
        nothing reporting a problem, which is the same class of bug as publishing a stale
        chunk version, so the export refuses loudly instead.
        """
        broken = [
            (graphics_release(loaders=('optifine',)), 'iris'),
            (graphics_release(minecraft='1.21.1'), 'Minecraft 26.2'),
            (graphics_release(host='example.invalid'), 'cdn.modrinth.com'),
            (graphics_release(size=0), 'file size'),
            (graphics_release(hashes={'sha1': 'c' * 40}), 'sha512'),
            (None, 'could not be confirmed'),
            ('not a list', 'no version list'),
        ]
        for versions, expected in broken:
            with self.subTest(expected=expected):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    if versions is None:
                        def resolver(project, wanted, game, loader=None):
                            raise OSError('the publisher is unreachable')
                    else:
                        def resolver(project, wanted, game, loader=None, published=versions):
                            return published
                    with self.assertRaises(RuntimeError) as caught:
                        self.build(root, graphics_resolver=resolver)
                    self.assertIn(expected, str(caught.exception))
        # A loader that cannot be confirmed refuses the export too: shipping the pack
        # without Iris is exactly the fault this release fixes.
        def pack_ok():
            return graphics_release()
        loader_faults = [
            (lambda project, wanted, game, loader=None: pack_ok() if project == GRAPHICS_PROJECT_ID
             else graphics_release(('neoforge',), game, wanted, 'x.jar', 1234), 'fabric'),
            (lambda project, wanted, game, loader=None: pack_ok() if project == GRAPHICS_PROJECT_ID
             else graphics_release(('fabric',), game, wanted, 'iris.jar/../../x.zip', 1234), 'unusable filename'),
            (lambda project, wanted, game, loader=None: pack_ok() if project == GRAPHICS_PROJECT_ID
             else graphics_release(('fabric',), '1.21.1', wanted, 'iris.jar', 1234), 'Minecraft 26.2'),
        ]
        for resolver, expected in loader_faults:
            with self.subTest(expected=expected):
                with tempfile.TemporaryDirectory() as temp:
                    with self.assertRaises(RuntimeError) as caught:
                        self.build(Path(temp), graphics_resolver=resolver)
                    self.assertIn(expected, str(caught.exception))

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
            self.assertEqual(published['deployment'], json.loads((Path(__file__).resolve().parents[1] / 'deployment.json').read_text()))
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

    def test_recreated_fixture_jars_and_manifests_ignore_the_wall_clock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with mock.patch('zipfile.time.localtime', return_value=(2026, 10, 19, 12, 0, 0, 0, 0, -1)):
                self.build(root)
            jars = {path.name: path.read_bytes() for path in root.glob('*.jar')}
            manifest = (root / 'public/data/client.json').read_bytes()
            # Force another representable ZIP timestamp without sleeping. The old
            # fixture always changed its JAR and manifest checksums at this boundary.
            with mock.patch('zipfile.time.localtime', return_value=(2026, 10, 19, 12, 0, 4, 0, 0, -1)):
                self.build(root)
            self.assertEqual(jars, {path.name: path.read_bytes() for path in root.glob('*.jar')})
            self.assertEqual(manifest, (root / 'public/data/client.json').read_bytes())

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
                                   state_path=root / 'state/modrinth.json',
                                   graphics_resolver=graphics_fixture_resolver())
            self.assertEqual(sorted(resolved), sorted(DEPENDENCIES))
            for entry in client['chunks'][0]['files']:
                self.assertFalse(entry['path'].startswith('/'))

            def escaping(entries, wanted, minecraft):
                return {ident: {'version': version, 'name': '/home/owen/' + ident + '.jar', 'size': 1,
                                'url': 'https://cdn.modrinth.com/data/x/1/x.jar', 'hash': 'sha512:' + SHA512}
                        for ident, version in wanted}

            with self.assertRaises(RuntimeError) as caught:
                export_client(root / 'public', module, resolver=escaping,
                              state_path=root / 'state/other.json',
                              graphics_resolver=graphics_fixture_resolver())
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

    def capture(self, now=NOW, exporter=fixture_export, deployment=LOCAL_DEPLOYMENT, client=None):
        with snapshot_source(deployment):
            return publish(self.repo, self.state, Path('/unused'), now=now, exporter=exporter,
                           client_exporter=client or fixture_client_half())

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


class SplitPublisherTests(unittest.TestCase):
    """Ticket 766f5564: the client publication stops being hostage to the map capture.

    The fixture is the published tree as it really was on 2026-10-22: world.json frozen on
    snapshot_day 2026-10-19, the client manifest frozen with it, and the map half refusing
    every hourly run with 'the production game deployment is remote'. One export_snapshot
    call used to write both halves, so the refusal also blocked the client release.
    """

    TODAY = datetime(2026, 10, 22, 15, 0, tzinfo=timezone.utc)  # the failing run's day, in ZONE
    PUBLISHED_AT = datetime(2026, 10, 19, 4, 18, tzinfo=timezone.utc)

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
        fixture_export(self.repo / 'site', now=self.PUBLISHED_AT)
        (self.repo / 'README.md').write_text('Website source\n')
        run_git(self.repo, 'add', '.')
        run_git(self.repo, 'commit', '-m', 'Baseline')
        run_git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        run_git(self.repo, 'push', '-u', 'origin', 'main')
        self.journal = io.StringIO()

    def published(self):
        return {str(path.relative_to(self.repo)): path.read_bytes()
                for prefix in ('site/data', 'site/downloads')
                for path in (self.repo / prefix).rglob('*') if path.is_file()}

    def run_publish(self, now=None, exporter=fixture_export, deployment=REMOTE_DEPLOYMENT, client=None):
        """One timer run with its whole journal captured; a failing run still raises."""
        self.journal = io.StringIO()
        with snapshot_source(deployment), redirect_stdout(self.journal):
            return sync.publish(self.repo, self.state, Path('/unused'), now=now or self.TODAY,
                                exporter=exporter,
                                client_exporter=fixture_client_half() if client is None else client)

    def lines(self, needle=''):
        return [line for line in self.journal.getvalue().splitlines() if needle in line]

    def count(self, root=None):
        return int(run_git(root or self.repo, 'rev-list', '--count', 'main'))

    def test_a_refused_map_source_still_publishes_the_client_half(self):
        """The acceptance case: the map half refuses, the client half publishes for real."""
        before = self.published()
        self.assertEqual(json.loads(before['site/data/world.json'])['snapshot_day'], '2026-10-19')
        jar = b'own-mod-fixture-2.1.0'
        captured = self.run_publish(client=fixture_client_half('2.1.0', jar))
        self.assertFalse(captured, 'the reuse path captured nothing')
        # The client half is regenerated, jar and manifest agreeing with each other.
        self.assertEqual((self.repo / 'site/downloads/easter-navy.jar').read_bytes(), jar)
        client = json.loads((self.repo / 'site/data/client.json').read_text())
        self.assertEqual(client['mod'], {'version': '2.1.0', 'sha256': hashlib.sha256(jar).hexdigest()})
        validate_client(self.repo / 'site')
        # ...and it is published, not merely staged in the checkout: the commit is pushed.
        self.assertEqual(self.count(), 2)
        self.assertEqual(self.count(self.remote), 2)
        self.assertEqual(json.loads(run_git(self.remote, 'show', 'main:site/data/client.json'))['mod']['version'], '2.1.0')
        self.assertEqual(run_git(self.repo, 'log', '-1', '--format=%s'), 'Client publication · 2026-10-22')
        # The map half captured nothing and claims nothing.
        self.assertEqual((self.repo / 'site/data/world.json').read_bytes(), before['site/data/world.json'])
        self.assertEqual(self.lines('Daily snapshot committed'), [])
        self.assertEqual(self.lines('Exported '), [])
        self.assertEqual(run_git(self.repo, 'status', '--porcelain'), '')

    def test_the_reuse_line_names_the_reason_and_the_day_that_is_published(self):
        world = json.loads((self.repo / 'site/data/world.json').read_text())
        self.run_publish()
        reuse = self.lines('reused the published snapshot')
        self.assertEqual(len(reuse), 1, 'exactly one journal line registers the reuse')
        line = reuse[0]
        self.assertIn('nothing was captured', line)
        self.assertIn(f"snapshot_day {world['snapshot_day']}", line)
        self.assertIn('the production game deployment is remote', line)
        self.assertIn('a verified remote snapshot source is required', line)
        self.assertNotIn('snapshot_day 2026-10-22', line, 'the line never claims today')
        self.assertEqual(self.lines('committed'), [], 'the reuse path commits nothing of its own')

    def test_the_reuse_path_keeps_world_json_byte_identical_and_adds_no_field(self):
        """No field records the reuse: the payload is untouched, which is the honest shape."""
        path = self.repo / 'site/data/world.json'
        before = path.read_bytes()
        day = json.loads(before)['snapshot_day']
        for now in (self.TODAY, self.TODAY + timedelta(days=3), self.TODAY + timedelta(days=30)):
            with self.subTest(now=now.isoformat()):
                self.run_publish(now=now)
                self.assertEqual(path.read_bytes(), before)
                published = json.loads(path.read_bytes())
                self.assertEqual(set(published), WORLD_KEYS)
                self.assertEqual(published['snapshot_day'], day)
                self.assertEqual(published['captured_at'], json.loads(before)['captured_at'])
                for field in ('reused', 'reuse', 'refused', 'reason', 'capture_failed', 'stale'):
                    self.assertNotIn(field, published)

    def test_a_map_source_present_but_broken_still_fails_the_run(self):
        """This ticket removes a false failure, not the gate."""
        def broken(stage, source_root, now=None, previous_day=None):
            raise RuntimeError('Terrain is being saved; retry rather than archive partial chunks')
        before = self.published()
        jar = b'own-mod-fixture-2.1.0'
        with self.assertRaises(RuntimeError) as caught:
            self.run_publish(exporter=broken, deployment=LOCAL_DEPLOYMENT,
                             client=fixture_client_half('2.1.0', jar))
        self.assertIn('Terrain is being saved', str(caught.exception))
        self.assertEqual(self.lines('reused the published snapshot'), [],
                         'a broken source is a failure, never a reuse')
        self.assertEqual((self.repo / 'site/data/world.json').read_bytes(), before['site/data/world.json'])
        self.assertEqual(self.lines('Daily snapshot committed'), [])
        # The client half published anyway, which is the whole point of the split.
        self.assertEqual((self.repo / 'site/downloads/easter-navy.jar').read_bytes(), jar)
        self.assertEqual(json.loads((self.repo / 'site/data/client.json').read_text())['mod']['version'], '2.1.0')
        self.assertEqual(self.count(self.remote), 2)
        self.assertEqual(run_git(self.repo, 'status', '--porcelain'), '')

    def test_a_successful_capture_runs_exactly_as_before(self):
        before = self.published()
        captured = self.run_publish(deployment=LOCAL_DEPLOYMENT)
        self.assertTrue(captured)
        world = json.loads((self.repo / 'site/data/world.json').read_text())
        self.assertEqual(world['snapshot_day'], '2026-10-22')
        self.assertEqual(world['captured_at'], self.TODAY.isoformat())
        self.assertEqual(world['missed_days'], 2, 'the two uncharted days are recorded, not backdated')
        self.assertEqual(self.lines('reused the published snapshot'), [])
        self.assertEqual(run_git(self.repo, 'log', '-1', '--format=%s'), 'World snapshot · 2026-10-22')
        # One commit: the client half was unchanged, and the world half did not touch its paths.
        self.assertEqual(self.count(), 2)
        self.assertEqual(self.count(self.remote), 2)
        self.assertEqual(json.loads((self.repo / 'site/data/client.json').read_bytes()),
                         json.loads(before['site/data/client.json']))
        changed = run_git(self.repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').split()
        self.assertIn('site/data/world.json', changed)
        self.assertTrue(all(path == 'site/data/world.json' or path.startswith('site/data/tiles/')
                            for path in changed), changed)
        self.assertEqual(validate_data(self.repo / 'site')['snapshot_day'], '2026-10-22')
        self.assertEqual(run_git(self.repo, 'status', '--porcelain'), '')

    def test_the_world_half_does_not_overwrite_the_client_half_it_staged_beside(self):
        """The two halves write disjoint paths, so a capture cannot republish an old client."""
        jar = b'own-mod-fixture-2.1.0'
        captured = self.run_publish(deployment=LOCAL_DEPLOYMENT, client=fixture_client_half('2.1.0', jar))
        self.assertTrue(captured)
        client = json.loads((self.repo / 'site/data/client.json').read_text())
        self.assertEqual(client['mod']['version'], '2.1.0', 'the world half staged its own client.json and it is not published')
        self.assertEqual(client['mod']['sha256'], hashlib.sha256(jar).hexdigest())
        self.assertEqual(json.loads((self.repo / 'site/data/world.json').read_text())['snapshot_day'], '2026-10-22')
        self.assertEqual(validate_data(self.repo / 'site')['snapshot_day'], '2026-10-22')

    def test_a_broken_client_manifest_fails_the_run_without_freezing_the_map(self):
        def broken_client(stage, state_dir, now=None):
            fixture_client_half()(stage, state_dir, now=now)
            client = json.loads((Path(stage) / 'data/client.json').read_text())
            client['mod']['sha256'] = 'f' * 64
            write_json(Path(stage) / 'data/client.json', client)
        before = self.published()
        with self.assertRaises(RuntimeError) as caught:
            self.run_publish(deployment=LOCAL_DEPLOYMENT, client=broken_client)
        self.assertIn('Client publication failed', str(caught.exception))
        self.assertIn('does not match the manifest checksum', str(caught.exception))
        # The broken half is never applied, and the map half still captured.
        self.assertEqual((self.repo / 'site/data/client.json').read_bytes(), before['site/data/client.json'])
        self.assertEqual(json.loads((self.repo / 'site/data/world.json').read_text())['snapshot_day'], '2026-10-22')
        self.assertEqual(run_git(self.repo, 'log', '-1', '--format=%s'), 'World snapshot · 2026-10-22')
        self.assertEqual(run_git(self.repo, 'status', '--porcelain'), '')

    def test_a_refusal_with_no_published_snapshot_fails_rather_than_pretending(self):
        run_git(self.repo, 'rm', '-q', 'site/data/world.json')
        run_git(self.repo, 'commit', '-m', 'No published snapshot yet')
        run_git(self.repo, 'push')
        with self.assertRaises(RuntimeError) as caught:
            self.run_publish()
        self.assertIn('the production game deployment is remote', str(caught.exception))
        self.assertEqual(self.lines('reused the published snapshot'), [],
                         'there is no published snapshot to reuse, so nothing may say there is')
        self.assertFalse((self.repo / 'site/data/world.json').exists())

    def test_the_world_half_is_gated_on_its_own_and_stages_nothing_when_it_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            with snapshot_source(REMOTE_DEPLOYMENT):
                with self.assertRaises(export_world.SnapshotSourceUnavailable):
                    export_world_snapshot(stage, Path('/unused'))
            self.assertEqual(list(stage.iterdir()), [])
            with snapshot_source(LOCAL_DEPLOYMENT):
                self.assertIsNone(export_world.snapshot_source_refusal())

    def test_the_client_half_is_rebuilt_from_the_canonical_artifacts(self):
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(sync, 'export_client') as exported, \
                mock.patch.object(sync, 'PublishedClientArtifacts') as artifacts:
            sync.stage_client(Path(temp) / 'stage', Path(temp), now=self.TODAY)
        self.assertEqual(export_world.CANONICAL_CLIENT_MODS, Path('/opt/minecraft/client-mods'))
        self.assertEqual(artifacts.call_args, mock.call(), 'the canonical directory is the default source')
        args, kwargs = exported.call_args
        self.assertEqual(args[0], Path(temp) / 'stage')
        self.assertIs(args[1], artifacts.return_value)
        self.assertEqual(kwargs['state_path'], Path(temp) / 'modrinth.json')
        self.assertEqual(kwargs['now'], self.TODAY)

    def test_the_remote_snapshot_source_is_one_module_reference(self):
        """Ticket 9ee87d22 replaces this reference; the split, the reuse path and the tests stay."""
        self.assertIs(sync.snapshot_source, export_world)
        calls = []

        class RemoteSource:
            """Shaped exactly like scripts/export_world for the two names sync.py uses."""
            @staticmethod
            def snapshot_source_refusal():
                calls.append('refusal')
                return None

            @staticmethod
            def export_world_snapshot(stage, source_root, now=None, previous_day=None):
                calls.append(('export', source_root, previous_day))
                fixture_export(stage, now=now, previous_day=previous_day)

        with mock.patch.object(sync, 'snapshot_source', RemoteSource):
            self.assertTrue(self.run_publish(exporter=None, deployment=LOCAL_DEPLOYMENT))
        self.assertEqual(calls, ['refusal', ('export', Path('/unused'), '2026-10-19')])
        self.assertEqual(json.loads((self.repo / 'site/data/world.json').read_text())['snapshot_day'], '2026-10-22')


class ManifestStatePreflightTests(unittest.TestCase):
    """The export must fail in its first second when its runtime cache cannot be written.

    The failure this guards against was real: the systemd unit runs with
    ProtectHome=read-only, so the default state path under $HOME could never be written,
    and the daily capture died *after* rendering every tile. The probe writes rather than
    checking permission bits, because the sandbox is invisible from outside it.
    """

    def test_the_configured_state_directory_is_used_and_left_clean(self):
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.dict(os.environ, {'EASTER_MANIFEST_STATE': root}):
            path = default_resolution_state()
            self.assertEqual(path, Path(root) / 'modrinth.json')
            self.assertEqual(ensure_state_writable(path), path)
            self.assertTrue(path.parent.is_dir())
            self.assertEqual(list(path.parent.iterdir()), [], 'the probe file must be removed')

    def test_an_unwritable_state_directory_is_refused_with_a_named_error(self):
        with tempfile.TemporaryDirectory() as root:
            blocker = Path(root) / 'not-a-directory'
            blocker.write_text('x')
            with self.assertRaises(RuntimeError) as caught:
                ensure_state_writable(blocker / 'easter-co-pages' / 'modrinth.json')
            message = str(caught.exception)
            self.assertIn('is not writable', message)
            self.assertIn('EASTER_MANIFEST_STATE', message)


if __name__ == '__main__':
    unittest.main()


class PublishedArtifactSourceTests(unittest.TestCase):
    def test_source_uses_reviewed_pins_and_refuses_old_or_ambiguous_same_version_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            jar = root / 'custom.jar'
            def write(version):
                with zipfile.ZipFile(jar, 'w') as archive:
                    archive.writestr('fabric.mod.json', json.dumps({'id': 'easter-navy', 'version': version}))
            write('2.0.1')
            published = {'minecraft': '26.2', 'fabric': '0.19.5', 'mod': {
                'version': '2.0.1', 'sha256': hashlib.sha256(jar.read_bytes()).hexdigest()}}
            source = PublishedClientArtifacts(root, published)
            self.assertIn('MC 26.2', source.facts.stack())
            self.assertEqual(source.fabric, '0.19.5')
            self.assertEqual(source._mods(), [jar])
            write('2.0.0')
            with self.assertRaisesRegex(RuntimeError, 'older than'):
                source._mods()
            write('2.0.1')
            with zipfile.ZipFile(jar, 'a') as archive:
                archive.writestr('changed.txt', 'different same-version artifact')
            with self.assertRaisesRegex(RuntimeError, 'same version'):
                source._mods()
            write('2.0.2')
            self.assertEqual(source._mods(), [jar])
