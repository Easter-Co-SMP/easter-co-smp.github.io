"""The site half's frozen names, checked against the publisher it replaces."""
from __future__ import annotations

import unittest

from scripts import sync, validate
from scripts.atlas import contract


class ContractTests(unittest.TestCase):
    def test_the_generated_paths_are_the_ones_sync_py_owns(self):
        self.assertEqual(tuple(contract.GENERATED_PATHS), tuple(sync.GENERATED))

    def test_the_two_halves_cover_exactly_the_generated_tree(self):
        halves = set(contract.MAP_PATHS) | set(contract.CLIENT_PATHS)
        for path in halves:
            self.assertTrue(any(path == prefix or path.startswith(prefix + "/")
                                for prefix in contract.GENERATED_PATHS), path)
        self.assertEqual(set(contract.MAP_PATHS) & set(contract.CLIENT_PATHS), set())
        self.assertIn("site/data/world.json", contract.MAP_PATHS)
        self.assertIn("site/data/client.json", contract.CLIENT_PATHS)

    def test_the_world_key_set_is_the_validators_key_set(self):
        self.assertEqual(set(contract.WORLD_KEYS), set(validate.WORLD_KEYS))

    def test_the_zip_paths_are_the_published_paths_without_the_site_prefix(self):
        self.assertTrue(contract.MAP_PATHS[0].endswith(contract.ZIP_WORLD))
        self.assertTrue(contract.CLIENT_PATHS[0].endswith(contract.ZIP_CLIENT))


if __name__ == "__main__":
    unittest.main()
