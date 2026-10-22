"""The vendored renderer cannot drift from e-server's copy without a red test.

Two directions, both checked here:

* **e-server moved.** The upstream files on this machine no longer hash to what
  `VENDORED.json` records, so this copy is older than the code it claims to be.
* **this repository moved.** The committed modules are not what `vendor.py` produces from
  upstream right now, so somebody edited a vendored file by hand.

Either one fails with the same instruction: re-vendor deliberately.
"""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from scripts.atlas.renderer import vendor

RENDERER = Path(vendor.HERE)
UPSTREAM = Path(vendor.DEFAULT_UPSTREAM)


class VendorTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((RENDERER / "VENDORED.json").read_text(encoding="utf8"))

    def test_the_manifest_records_every_vendored_module_with_the_documented_substitutions(self):
        self.assertEqual(set(self.manifest["files"]), set(vendor.SOURCES))
        self.assertEqual(len(self.manifest["substitutions"]), len(vendor.SUBSTITUTIONS))
        for name, record in self.manifest["files"].items():
            self.assertEqual(record["upstream"], vendor.SOURCES[name])
            self.assertRegex(record["upstream_sha256"], r"^[a-f0-9]{64}$")
            self.assertTrue((RENDERER / name).is_file())

    def test_the_committed_copies_are_upstream_plus_the_documented_substitutions(self):
        if not UPSTREAM.is_dir():
            self.skipTest(f"the e-server checkout {UPSTREAM} is not here, so upstream cannot "
                          "be compared; the manifest's hashes are the only record on a runner")
        built = vendor.build(UPSTREAM)
        for name, (text, digest) in built.items():
            committed = (RENDERER / name).read_text(encoding="utf8")
            self.assertEqual(committed, text,
                             f"{name} is not what vendor.py produces from upstream; "
                             "re-vendor deliberately")
            self.assertEqual(self.manifest["files"][name]["upstream_sha256"], digest,
                             f"upstream {vendor.SOURCES[name]} changed since this copy was "
                             "recorded; re-vendor deliberately")

    def test_every_substitution_still_matches_its_upstream_file_exactly_once(self):
        if not UPSTREAM.is_dir():
            self.skipTest("no e-server checkout here")
        for name, before, after, why in vendor.SUBSTITUTIONS:
            self.assertTrue(why, "every substitution must say why it exists")
            source = (UPSTREAM / vendor.SOURCES[name]).read_text(encoding="utf8")
            self.assertEqual(source.count(before), 1,
                             f"{name}: {before!r} is no longer unique upstream")
            built = (RENDERER / name).read_text(encoding="utf8")
            self.assertIn(after, built)
            self.assertNotIn(before, built.replace(after, ""))

    def test_the_world_root_and_cache_are_overridable_and_root_keyed(self):
        terrain = (RENDERER / "minecraft_map.py").read_text(encoding="utf8")
        self.assertIn('os.environ.get("ATLAS_WORLD_ROOT")', terrain)
        self.assertIn('os.environ.get("ATLAS_TILE_CACHE")', terrain)
        self.assertIn("world_id=str(WORLD.resolve())", terrain)
        self.assertNotIn("st_ino", terrain)
        records = (RENDERER / "minecraft_map_data.py").read_text(encoding="utf8")
        self.assertIn('os.environ.get("ATLAS_SERVER_ROOT")', records)

    def test_the_header_says_where_the_file_came_from(self):
        for name, relative in vendor.SOURCES.items():
            head = (RENDERER / name).read_text(encoding="utf8").splitlines()[0]
            self.assertEqual(head, "# VENDORED -- do not edit by hand.")

    def test_a_hand_edited_vendored_file_is_detected(self):
        """The inverse of the drift check: corrupt a copy and prove the comparison notices."""
        if not UPSTREAM.is_dir():
            self.skipTest("no e-server checkout here")
        built = vendor.build(UPSTREAM)
        with tempfile.TemporaryDirectory() as temporary:
            copy = Path(temporary)
            for name, (text, _digest) in built.items():
                (copy / name).write_text(text, encoding="utf8")
            stale = []
            for name, (text, _digest) in built.items():
                if (copy / name).read_text(encoding="utf8") != text:
                    stale.append(name)
            self.assertEqual(stale, [])

            path = copy / "minecraft_map.py"
            path.write_text(path.read_text(encoding="utf8") + "\n# a hand edit\n",
                            encoding="utf8")
            stale = [name for name, (text, _digest) in built.items()
                     if (copy / name).read_text(encoding="utf8") != text]
            self.assertEqual(stale, ["minecraft_map.py"])

    def test_a_changed_upstream_literal_fails_the_vendor_rather_than_half_patching(self):
        with tempfile.TemporaryDirectory() as temporary:
            fake = Path(temporary)
            for relative in vendor.SOURCES.values():
                source = UPSTREAM / relative
                (fake / relative).parent.mkdir(parents=True, exist_ok=True)
                if source.is_file():
                    (fake / relative).write_text(source.read_text(encoding="utf8"),
                                                 encoding="utf8")
            target = fake / "core/minecraft_map.py"
            if not target.is_file():
                self.skipTest("no e-server checkout here")
            target.write_text(target.read_text(encoding="utf8").replace(
                'WORLD = Path("/opt/minecraft/server/world")',
                'WORLD = Path("/srv/minecraft/world")'), encoding="utf8")
            with self.assertRaises(vendor.VendorError) as caught:
                vendor.build(fake)
            self.assertIn("expected exactly one occurrence", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
