"""The pipeline's frozen names, checked against the layers that must agree with them.

Two things can rot silently in a pipeline this size: a key that the bucket and the code
spell differently, and a path allowlist that drifts away from the publisher it replaced.
Both are cheap to assert and expensive to discover in production.
"""
from __future__ import annotations

import unittest

from scripts import sync, validate
from scripts.atlas import contract, worldjson


class ContractTests(unittest.TestCase):
    def test_the_generated_paths_are_the_ones_sync_py_owns(self):
        self.assertEqual(tuple(contract.GENERATED_PATHS), tuple(sync.GENERATED))

    def test_the_two_halves_cover_exactly_the_generated_tree(self):
        halves = set(contract.MAP_PATHS) | set(contract.CLIENT_PATHS)
        for path in halves:
            self.assertTrue(
                any(path == prefix or path.startswith(prefix + "/")
                    for prefix in contract.GENERATED_PATHS),
                f"{path} is outside the generated tree")
        # The map half owns the map document and its tiles; the client half owns the client
        # document and the downloads it names. Neither path appears in both.
        self.assertEqual(set(contract.MAP_PATHS) & set(contract.CLIENT_PATHS), set())
        self.assertIn("site/data/world.json", contract.MAP_PATHS)
        self.assertIn("site/data/client.json", contract.CLIENT_PATHS)

    def test_the_public_document_keys_are_the_validators_keys(self):
        self.assertEqual(set(contract.WORLD_KEYS), set(validate.WORLD_KEYS))

    def test_the_region_row_keys_are_the_validators_keys(self):
        self.assertEqual(set(contract.REGION_KEYS), set(validate.REGION_KEYS))

    def test_the_site_zone_is_the_exporters_zone(self):
        from scripts import export_world
        self.assertEqual(worldjson.ZONE, export_world.ZONE)

    def test_the_marker_allowlist_is_imported_not_restated(self):
        from scripts import export_world
        # worldjson re-exports the exporter's allowlist; a second copy would be the bug.
        self.assertIs(worldjson.PUBLIC_MARKER_KINDS, export_world.PUBLIC_MARKER_KINDS)
        self.assertIs(worldjson.PUBLIC_MARKER_ICONS, export_world.PUBLIC_MARKER_ICONS)

    def test_the_three_bucket_keys_are_distinct_and_under_atlas(self):
        keys = {contract.SNAPSHOT_KEY, contract.SIDECAR_KEY, contract.POINTER_KEY}
        self.assertEqual(len(keys), 3)
        for key in keys:
            self.assertTrue(key.startswith("atlas/"), key)

    def test_a_pointer_with_an_unknown_field_is_refused(self):
        document = contract.pointer_document(
            captured_at="2026-10-22T04:30:00+00:00", published_at="2026-10-22T04:40:00Z",
            instance_id="i-1", launch_time="2026-10-20T09:00:00+00:00",
            state_transition_at="2026-10-22T04:31:00+00:00",
            state_transition_reason="User initiated (2026-10-22 04:31:00 GMT)",
            tar_key=contract.SNAPSHOT_KEY, tar_sha256="a" * 64, tar_bytes=10,
            region_files=390, nonempty_regions=66, tiles=66, position_source="test")
        self.assertEqual(set(document), set(contract.POINTER_KEYS))
        # A field the contract does not name cannot enter the pointer: the builder's own
        # signature is the guard, and the key-set assertion above is the second one.
        with self.assertRaises(TypeError):
            contract.pointer_document(
                captured_at="2026-10-22T04:30:00+00:00", published_at="x", instance_id="i-1",
                launch_time=None, state_transition_at=None, state_transition_reason=None,
                tar_key="k", tar_sha256="a" * 64, tar_bytes=1, region_files=1,
                nonempty_regions=1, tiles=1, position_source="test", surprise_field=1)

    def test_a_snapshot_id_is_stable_for_one_capture(self):
        first = contract.snapshot_id("2026-10-22T04:30:00.123456+00:00", "2026-10-20T09:00:00+00:00")
        second = contract.snapshot_id("2026-10-22T04:30:00+00:00", "2026-10-20T09:00:00+00:00")
        self.assertEqual(first, second)
        self.assertRegex(first, r"^[0-9TZ-]+$")
        self.assertNotEqual(first, contract.snapshot_id(
            "2026-10-22T05:30:00+00:00", "2026-10-20T09:00:00+00:00"))


if __name__ == "__main__":
    unittest.main()
