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

from scripts.export_world import public_marker, write_json, export_client, DEPENDENCIES, ZONE
from scripts.sync import publish
from scripts.validate import validate_data, MARKER_KEYS

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=')
NOW = datetime(2026, 10, 15, 14, tzinfo=timezone.utc)


def fixture_export(root, source=None, now=NOW, previous_day=None):
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
        'regions': [], 'markers': [], 'unlocated_markers': 0, 'position_source': 'Saved non-player records',
    })
    target = root / 'downloads/easter-navy.jar'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'own-mod-fixture')
    write_json(root / 'data/client.json', {
        'minecraft': '26.2', 'mod': {'version': 'test', 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}, 'dependencies': [],
    })


def run_git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=True).stdout.strip()


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
               'read_at': NOW.timestamp(), 'age_seconds': 60, 'faction': 'navy',
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
