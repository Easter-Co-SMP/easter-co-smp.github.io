import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
import zipfile

from scripts.export_world import (PUBLIC_MARKER_KINDS, public_marker, public_marker_kind,
                                  write_json, export_client, DEPENDENCIES, ZONE)
from scripts.sync import publish
from scripts.validate import validate_data, MARKER_KEYS

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=')
NOW = datetime(2026, 10, 15, 14, tzinfo=timezone.utc)


def fixture_export(root, source=None, now=NOW, previous_day=None, markers=None):
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
    target = root / 'downloads/easter-navy.jar'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'own-mod-fixture')
    write_json(root / 'data/client.json', {
        'minecraft': '26.2', 'mod': {'version': 'test', 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}, 'dependencies': [],
    })


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
            export_client(target, SimpleNamespace(_mods=lambda: paths, facts=SimpleNamespace(stack=lambda: 'MC 26.2 · Fabric 0.19.5')))
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
