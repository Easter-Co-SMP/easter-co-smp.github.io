"""Guard the packaged launcher: prove a stale bundled site/ is caught, and not guessed at.

Every case here builds its own minimal ASAR in a temporary directory. That is deliberate:
a test that asserted on `release/` would pass vacuously on a fresh clone, which has no
packaged output at all, and would break on any machine that built a launcher. The fixtures
are the product of this repository's own understanding of the ASAR layout, so the real
artifact was also checked by hand during development: the guard named site/map/map.js,
site/map/index.html, site/styles.css and site/data/world.json in a launcher-v1.0.0 build.

The guard runs through its command line interface, so the exit status and the exact wording
a release job sees are what these tests assert.
"""
from __future__ import annotations
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'verify_app_bundle.py'
sys.path.insert(0, str(ROOT))

from scripts.verify_app_bundle import (BundleError, bundled_site_paths, is_text_asset,
                                       parse_manifest, skip_reason)

#: Documents the padding arithmetic: the JSON text is followed by '\0   ' so the header
#: object ends 9 bytes later, which is what makes content start at 8 + headerSize.
HEADER_PADDING = b'\0   '


def build_asar(path, members):
    """Write a minimal ASAR holding {member path: bytes}. Returns the path.

    Only a flat one-directory-deep tree is needed for these fixtures, but the header shape
    is exactly the real one: the JSON directory tree with "size" and "offset" per file, and
    contents at 8 + headerSize + offset.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tree = {}
    blobs, offset = [], 0
    for relpath, blob in members.items():
        parts = relpath.split('/')
        node = tree
        for part in parts[:-1]:
            node = node.setdefault(part, {'files': {}})['files']
        node[parts[-1]] = {'size': len(blob), 'offset': str(offset)}
        blobs.append(blob)
        offset += len(blob)
    header = json.dumps({'files': tree}, separators=(',', ':')).encode('utf-8') + HEADER_PADDING
    inner_size = len(header) + 4          # the inner pickle: jsonLength field plus the JSON
    header_size = inner_size + 4          # the outer pickle: innerSize field plus the inner
    machine = struct.pack('<III', 4, header_size, inner_size) + struct.pack('<I', len(header))
    path.write_bytes(machine + header + b''.join(blobs))
    return path


_AUTO = object()


def fake_repo(root, site_files, platform='linux-unpacked', asar_members=None, asar=_AUTO):
    """Create root/site/... and a packaged bundle. Returns the app.asar path.

    site_files keys are relative to site/ ('index.html', 'map/map.js'). asar_members keys
    are full bundled paths ('site/index.html') and default to site_files, so the bundle
    matches the repository. asar=False writes no bundle, reproducing a fresh clone.
    """
    root = Path(root)
    for relpath, blob in site_files.items():
        target = root / 'site' / relpath
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
    if asar is _AUTO:
        members = ({'site/' + relpath: blob for relpath, blob in site_files.items()}
                   if asar_members is None else asar_members)
        asar = root / 'release' / platform / 'resources' / 'app.asar'
        build_asar(asar, members)
    return asar


def run_guard(root, *args):
    """Run the guard against root and return (exit code, output)."""
    result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(root), *args],
                            text=True, capture_output=True, cwd=str(ROOT))
    return result.returncode, result.stdout + result.stderr


def find_asar(root):
    """Return the single app.asar under root, for corrupting it in place."""
    found = sorted(Path(root).rglob('app.asar'))
    assert len(found) == 1, f'expected one app.asar under {root}, found {found}'
    return found[0]


class MatchingBundleTests(unittest.TestCase):
    """A bundle that carries the repository's site/ must be accepted."""

    def test_matching_bundle_is_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'<p>Easter Co.</p>',
                             'map/map.js': b'const layers={ship:{}};'})
            code, output = run_guard(temp)
            self.assertEqual(code, 0, output)
            self.assertIn('match the repository site/', output)
            self.assertIn('2 text assets compared', output)

    def test_empty_member_is_compared_not_skipped(self):
        # site/.nojekyll is a real file in this repository and is zero bytes long.
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'.nojekyll': b'', 'index.html': b'x'})
            code, output = run_guard(temp)
            self.assertEqual(code, 0, output)
            self.assertIn('2 text assets compared', output)

    def test_bundle_paths_are_read_back_from_the_header(self):
        with tempfile.TemporaryDirectory() as temp:
            asar = build_asar(Path(temp) / 'app.asar',
                              {'site/index.html': b'x', 'site/map/map.js': b'y',
                               'desktop/main.cjs': b'z', 'site/data/tiles/0/0.png': b'\x89PNG'})
            header, _, _ = parse_manifest(asar)
            self.assertEqual(bundled_site_paths(header),
                             ['site/data/tiles/0/0.png', 'site/index.html', 'site/map/map.js'])

    def test_binary_imagery_and_downloads_are_reported_as_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x',
                             'data/tiles/0/0.png': b'\x89PNG\r\n\x1a\n tile',
                             'downloads/easter-navy.jar': b'PK\x03\x04 jar'})
            code, output = run_guard(temp)
            self.assertEqual(code, 0, output)
            self.assertIn('1 text assets compared', output)
            self.assertIn('2 deliberately skipped', output)
            self.assertIn('skipped site/data/tiles/0/0.png: binary .png imagery or archive', output)
            self.assertIn('skipped site/downloads/easter-navy.jar', output)


class StaleBundleTests(unittest.TestCase):
    """A bundle that does not carry the repository's site/ must fail, naming the path."""

    def test_differing_file_is_rejected_by_name(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'<p>current legend</p>'},
                      asar_members={'site/index.html': b'<p>removed player factions</p>'})
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('FAIL: linux-unpacked: site/index.html in app.asar differs', output)

    def test_only_the_stale_path_is_named(self):
        with tempfile.TemporaryDirectory() as temp:
            site = {'index.html': b'same', 'map/map.js': b'current palette'}
            fake_repo(temp, site,
                      asar_members={'site/index.html': b'same', 'site/map/map.js': b'old palette'})
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('site/map/map.js', output)
            self.assertNotIn('site/index.html', output)
            self.assertIn('1 problem(s)', output)

    def test_bundled_path_missing_from_the_repository_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'},
                      asar_members={'site/index.html': b'x', 'site/map/removed.js': b'withdrawn'})
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('FAIL: linux-unpacked: site/map/removed.js is bundled but missing', output)

    def test_repository_path_never_bundled_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x', 'map/new.mjs': b'new module'},
                      asar_members={'site/index.html': b'x'})
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('FAIL: linux-unpacked: site/map/new.mjs is in the repository site/ '
                          'but not in app.asar', output)

    def test_missing_world_snapshot_mismatch_is_reported(self):
        # The generated daily snapshot is compared on purpose; a bundle built before the
        # daily export must fail rather than ship an older snapshot than the site publishes.
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'data/world.json': b'{"markers":[{"kind":"ship"}]}'},
                      asar_members={'site/data/world.json': b'{"markers":[{"kind":"npc"}]}'})
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('site/data/world.json', output)


class UnreadableBundleTests(unittest.TestCase):
    """A bundle that cannot be read is a failure, never a silent pass."""

    def test_truncated_asar_is_reported_unreadable(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'<p>content</p>'})
            asar = find_asar(temp)
            asar.write_bytes(asar.read_bytes()[:24])
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('unreadable bundle', output)
            self.assertNotIn('match the repository site/', output)

    def test_empty_asar_is_reported_unreadable(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'})
            find_asar(temp).write_bytes(b'')
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('too short to hold an ASAR header', output)

    def test_non_asar_bytes_are_reported_unreadable(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'})
            find_asar(temp).write_bytes(b'not an asar at all, not even close' * 4)
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('unreadable bundle', output)

    def test_parse_manifest_refuses_truncated_header(self):
        with tempfile.TemporaryDirectory() as temp:
            asar = build_asar(Path(temp) / 'app.asar', {'site/index.html': b'x'})
            raw = asar.read_bytes()
            # Cut into the header, so the declared header lengths cannot be satisfied.
            asar.write_bytes(raw[:20])
            with self.assertRaises(BundleError) as caught:
                parse_manifest(asar)
            self.assertIn('truncated', str(caught.exception))

    def test_packaged_platform_without_asar_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'})
            (Path(temp) / 'release' / 'win-unpacked' / 'resources').mkdir(parents=True)
            code, output = run_guard(temp)
            self.assertEqual(code, 1, output)
            self.assertIn('packaged platform without resources/app.asar', output)


class NoPackagedOutputTests(unittest.TestCase):
    """A fresh clone has no release/; the documented test command must stay green."""

    def test_no_release_directory_exits_zero(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'}, asar=False)
            code, output = run_guard(temp)
            self.assertEqual(code, 0, output)
            self.assertIn('nothing to check', output)

    def test_empty_release_directory_exits_zero(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'}, asar=False)
            (Path(temp) / 'release').mkdir()
            code, output = run_guard(temp)
            self.assertEqual(code, 0, output)
            self.assertIn('nothing to check', output)

    def test_required_platform_turns_a_missing_bundle_into_a_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'}, asar=False)
            code, output = run_guard(temp, '--require', 'win-unpacked')
            self.assertEqual(code, 1, output)
            self.assertIn('win-unpacked was expected but', output)

    def test_required_platform_is_satisfied_by_a_present_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_repo(temp, {'index.html': b'x'}, platform='win-unpacked')
            code, output = run_guard(temp, '--require', 'win-unpacked')
            self.assertEqual(code, 0, output)

    def test_a_root_with_no_release_directory_has_nothing_to_check(self):
        # The exact claim the documented unittest command depends on, checked on a fixture
        # root: a checkout that has never been built. The fixture is a plain directory with
        # site/ and no release/, which is what a fresh clone looks like. It deliberately
        # does not read the repository's own release/: that directory is gitignored and any
        # developer may have a packaged build in it, matching or stale, and whether one is
        # present must not decide whether this behaviour is tested.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'site' / 'map').mkdir(parents=True)
            (root / 'site' / 'index.html').write_text('<p>Easter Co.</p>')
            (root / 'site' / 'map' / 'map.js').write_text('const layers={ship:{}};')
            self.assertFalse((root / 'release').exists())
            code, output = run_guard(root)
            self.assertEqual(code, 0, output)
            self.assertIn('nothing to check', output)
            self.assertIn(f'No packaged launcher bundles under {root / "release"}', output)
            self.assertNotIn('FAIL:', output)


class ClassificationTests(unittest.TestCase):
    """The compared/skipped split is a contract, not an accident."""

    def test_text_assets_are_compared(self):
        for relpath in ('site/index.html', 'site/styles.css', 'site/desktop.js', 'site/map/cache.mjs',
                        'site/map/index.html', 'site/data/world.json', 'site/data/client.json',
                        'site/.nojekyll', 'site/404.html', 'site/notes.txt', 'site/README.md'):
            self.assertTrue(is_text_asset(relpath), relpath)

    def test_imagery_and_downloads_are_skipped_with_a_reason(self):
        for relpath in ('site/assets/crest.jpg', 'site/assets/favicon.png',
                        'site/data/tiles/0/0.png', 'site/downloads/easter-navy.jar'):
            self.assertFalse(is_text_asset(relpath), relpath)
            self.assertTrue(skip_reason(relpath), relpath)


if __name__ == '__main__':
    unittest.main()
