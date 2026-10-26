import runpy
import unittest
from pathlib import Path

class BrowserContractsTest(unittest.TestCase):
    def test_buildless_exports_match_the_authoritative_native_contracts(self):
        root = Path(__file__).resolve().parents[1]
        exporter = runpy.run_path(str(root / "scripts/export_browser_contracts.py"))
        for name, content in exporter["outputs"]():
            with self.subTest(path=name):
                self.assertEqual((root / name).read_text(), content)
