"""Guard the checkout against line-ending drift, which the bundle check reads as staleness.

scripts/verify_app_bundle.py compares the text assets inside a packaged app.asar with the
repository's site/ byte for byte. The Windows installer is built on a Windows runner, where
Git's default autocrlf setting rewrites LF to CRLF on checkout, so on 2026-10-16 the
launcher-v1.0.2 release job failed with 14 differences - every text asset under site/ and no
binary one:

    FAIL: win-unpacked: site/index.html in app.asar differs from the repository site/

The bundle was not stale. The Windows copy was CRLF: index.html carried 46 CRLF pairs,
desktop.js 311 and data/world.json 2134, and each size difference equalled its CRLF count
exactly, while the Linux bundle matched. The fix is .gitattributes, because `eol` there
overrides core.autocrlf on every platform.

These tests assert the rule rather than the symptom: every text asset the bundle check
compares must be pinned to LF, so no checkout on any platform can produce different bytes
for the same commit.
"""
from __future__ import annotations
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.verify_app_bundle import is_text_asset

ATTRIBUTES = ROOT / '.gitattributes'


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, check=False)


def in_git_worktree() -> bool:
    return git('rev-parse', '--is-inside-work-tree').stdout.strip() == 'true'


class LineEndingPins(unittest.TestCase):
    """The attributes file must exist and must cover what the bundle check compares."""

    def setUp(self) -> None:
        if not in_git_worktree():
            self.skipTest('not a git worktree, so there is nothing to check out')

    def test_gitattributes_exists_and_pins_lf(self) -> None:
        self.assertTrue(ATTRIBUTES.is_file(), '.gitattributes must exist to pin line endings')
        text = ATTRIBUTES.read_text(encoding='utf-8')
        self.assertIn('eol=lf', text, '.gitattributes must pin eol=lf')

    def test_every_compared_site_asset_is_pinned_to_lf(self) -> None:
        """Walk the real site/ tree, not a hardcoded list, so a new asset is covered too."""
        compared = sorted(
            str(path.relative_to(ROOT))
            for path in (ROOT / 'site').rglob('*')
            if path.is_file() and is_text_asset(str(path.relative_to(ROOT)))
        )
        # The guard is worthless if the walk finds nothing, or if it silently stops
        # covering the files that actually failed.
        self.assertGreater(len(compared), 10, f'expected the site text assets, found {compared}')
        for name in ('site/index.html', 'site/desktop.js', 'site/styles.css',
                     'site/data/world.json', 'site/minecraft/map/map.js', 'site/.nojekyll'):
            self.assertIn(name, compared, f'{name} must be one of the compared text assets')

        result = git('check-attr', 'eol', '--', *compared)
        self.assertEqual(result.returncode, 0, result.stderr)
        for line in result.stdout.splitlines():
            path, _, value = line.rpartition(': ')
            self.assertEqual(value, 'lf', f'{path} must be pinned to lf, got {value!r}')

    def test_no_compared_site_asset_is_stored_with_crlf(self) -> None:
        """A CRLF blob in the index would defeat the attributes for that file.

        This asserts the CRLF property only. The attribute itself is asserted with
        `git check-attr` in the test above, because `git ls-files --eol` prints
        `i/none w/none attr/text` for an empty file such as site/.nojekyll and does not
        repeat the eol attribute there, so reading the pin out of this output would
        fail on a file that is in fact pinned correctly.
        """
        result = git('ls-files', '--eol', 'site')
        self.assertEqual(result.returncode, 0, result.stderr)
        inspected = 0
        for line in result.stdout.splitlines():
            fields = line.split('\t', 1)
            if len(fields) != 2:
                continue
            index_eol, worktree_eol = (fields[0].split() + ['', ''])[:2]
            name = fields[1]
            if not is_text_asset(name):
                continue
            inspected += 1
            self.assertNotEqual(index_eol, 'i/crlf', f'{name} is stored with CRLF in the index')
            self.assertNotEqual(worktree_eol, 'w/crlf', f'{name} is checked out with CRLF')
        self.assertGreater(inspected, 10, 'the walk should have inspected the site text assets')

    def test_verify_app_bundle_compares_the_files_this_guard_pins(self) -> None:
        """The two lists must not drift apart: this is the link between them."""
        source = (ROOT / 'scripts' / 'verify_app_bundle.py').read_text(encoding='utf-8')
        for suffix in ('.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md',
                       '.webmanifest'):
            self.assertIn(f"'{suffix}'", source, f'the bundle check should still compare {suffix}')
            self.assertIn(f'*{suffix}', ATTRIBUTES.read_text(encoding='utf-8'),
                          f'.gitattributes should still pin {suffix}')


if __name__ == '__main__':
    unittest.main()
