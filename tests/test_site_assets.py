"""Guard the published site against material that AGENTS.md forbids showing.

The removed elytra limit and first-elytra house prize left dead CSS behind once
already. This test scans the published site/ tree for that removed material so it
cannot creep back through a stylesheet, page, script, or data payload.

It covers removed gameplay material only. Map legend labels and similar public
copy are governed by their own review, so this test must not be widened into a
general vocabulary ban.
"""
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'

# Removed material: selectors from the withdrawn elytra rules, plus the phrases
# that name the withdrawn mechanics in prose.
WITHDRAWN = ('elytra-limit', 'first-elytra', 'elytra limit', 'first elytra prize')

# Text assets carry copy, styles and code. It also covers the generated JSON data
# and downloads manifest, which are text. Binary imagery and third-party archives
# are skipped: they cannot describe the withdrawn content.
TEXT_SUFFIXES = {'.css', '.html', '.js', '.mjs', '.json', '.txt', '.md', '.svg', '.webmanifest'}


def scan_text(root, suffixes=TEXT_SUFFIXES):
    """Return (path, phrase) for every forbidden phrase found under root."""
    root = Path(root)
    findings = []
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        if path.suffix.lower() not in suffixes:
            continue
        text = path.read_text(encoding='utf-8', errors='replace').lower()
        for phrase in WITHDRAWN:
            if phrase in text:
                findings.append((str(path.relative_to(root)), phrase))
    return findings


class RemovedMaterialTests(unittest.TestCase):
    def test_no_withdrawn_elytra_material_in_published_site(self):
        findings = scan_text(SITE)
        self.assertEqual(findings, [], 'Withdrawn elytra material is published again: %r' % (findings,))

    def test_scan_actually_reads_the_site(self):
        scanned = [p for p in SITE.rglob('*') if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES]
        self.assertIn('site/styles.css', [str(p.relative_to(ROOT)) for p in scanned])
        self.assertGreaterEqual(len(scanned), 10, 'Site text assets disappeared; the guard would pass vacuously')

    def test_stylesheet_has_no_withdrawn_elytra_selectors(self):
        css = (SITE / 'styles.css').read_text(encoding='utf-8').lower()
        for selector in ('.elytra-limit', '.first-elytra'):
            self.assertNotIn(selector, css)


class ScannerTests(unittest.TestCase):
    """The scanner must fail on the removed material, not merely run."""

    def test_scanner_reports_every_withdrawn_phrase(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for index, phrase in enumerate(WITHDRAWN):
                (root / ('page%d.html' % index)).write_text('<p>The %s is withdrawn.</p>' % phrase)
            self.assertEqual(scan_text(root), [('page%d.html' % i, p) for i, p in enumerate(WITHDRAWN)])

    def test_scanner_is_case_insensitive_and_reports_path_and_phrase(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'styles.css').write_text('.FIRST-ELYTRA{border-top:1px dashed #000}')
            self.assertEqual(scan_text(root), [('styles.css', 'first-elytra')])

    def test_scanner_skips_binary_imagery(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'tile.png').write_bytes(b'\x89PNG\r\n\x1a\n elytra limit')
            (root / 'notes.md').write_text('Nothing withdrawn here.')
            self.assertEqual(scan_text(root), [])


if __name__ == '__main__':
    unittest.main()
