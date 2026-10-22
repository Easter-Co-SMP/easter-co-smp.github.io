"""The published document: its twelve fields, and the two honest ways to fill the three
that terrain cannot supply.

The rule under test, in the ticket's words: a document may never claim a newer capture than
the snapshot it came from, may never invent a marker position, and may never erase the regions
or markers the site already shows without saying why.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from scripts.atlas import capture, contract, render, worldjson
from scripts.atlas.config import Settings
from tests.atlas_stubs import (REPO_ROOT, StubS3, make_capture, published_document,
                               zone_document)

NPC_UUID = "11111111-2222-3333-4444-555555555555"
SHIP_UUID = "66666666-7777-8888-9999-000000000000"


def positions(instant=None):
    instant = instant or datetime(2026, 10, 22, 4, 16, 40, tzinfo=timezone.utc).timestamp()
    return {
        f"npc:{NPC_UUID}": {"x": -610.5, "y": 70.0, "z": -200.25, "at": instant},
        f"ship:{SHIP_UUID}": {"x": -700.0, "y": 64.0, "z": -150.0, "at": instant},
    }


def fleet():
    return [{"id": SHIP_UUID, "kind": "ship", "name": "Gull", "owner": "navy",
             "crew": ["a"], "navyPatrol": False}]


def rosters():
    return {"easter-navy-villagers.txt": f"Edith {NPC_UUID}\n"}


class SnapshotCase(unittest.TestCase):
    def snapshot(self, **kwargs):
        temporary = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(temporary, ignore_errors=True))
        tar, sidecar = make_capture(Path(temporary), **kwargs)
        s3 = StubS3({contract.SNAPSHOT_KEY: tar.read_bytes(),
                     contract.SIDECAR_KEY: json.dumps(sidecar).encode()})
        settings = Settings.from_env({"ATLAS_BUCKET": "atlas-bucket",
                                      "ATLAS_INSTANCE_ID": "i-1"}, repo_root=REPO_ROOT)
        return capture.open_snapshot(s3, settings, Path(temporary) / "work", log=lambda _l: None)


class MarkerTests(SnapshotCase):
    def test_a_capture_with_a_roster_and_a_position_store_places_its_markers(self):
        snapshot = self.snapshot(config=rosters() | {"easter-fleet-ships.json": fleet()},
                                 positions=positions())
        markers, rows, notes = worldjson.read_records(snapshot, snapshot.captured_at)
        kinds = sorted(marker["kind"] for marker in markers)
        self.assertEqual(rows, 2)
        self.assertIn("villager", kinds)
        self.assertIn("ship", kinds)
        placed = {marker["kind"]: marker for marker in markers}
        self.assertEqual((placed["villager"]["x"], placed["villager"]["z"]), (-610.5, -200.25))
        # observed_at is the store's own reading instant, never the render time.
        self.assertTrue(placed["villager"]["observed_at"].startswith("2026-10-22T04:1"))
        self.assertNotIn("faction", placed["villager"])

    def test_a_capture_without_sources_carries_the_published_markers_and_says_so(self):
        snapshot = self.snapshot()
        published = published_document()
        markers = worldjson.resolve_markers(snapshot, snapshot.captured_at, published,
                                            policy="carry", log=lambda _l: None)
        self.assertTrue(markers.carried)
        self.assertEqual(markers.rows, published["markers"])
        self.assertEqual(markers.unlocated, published["unlocated_markers"])
        self.assertIn("carried from", markers.position_source)
        self.assertIn("no position store", markers.position_source)
        # Every carried row keeps the observation it already had: nothing is freshened.
        published_at = {row["id"]: row["observed_at"] for row in published["markers"]}
        self.assertEqual({row["id"]: row["observed_at"] for row in markers.rows}, published_at)

    def test_a_capture_without_sources_refuses_when_the_policy_says_refuse(self):
        snapshot = self.snapshot()
        with self.assertRaises(worldjson.WorldDocumentError) as caught:
            worldjson.resolve_markers(snapshot, snapshot.captured_at, published_document(),
                                      policy="refuse", log=lambda _l: None)
        self.assertIn("would erase", str(caught.exception))

    def test_nothing_to_capture_and_nothing_published_is_a_refusal(self):
        snapshot = self.snapshot()
        with self.assertRaises(worldjson.WorldDocumentError):
            worldjson.resolve_markers(snapshot, snapshot.captured_at, None, policy="carry",
                                      log=lambda _l: None)


class RegionTests(SnapshotCase):
    def test_captured_region_rules_become_the_published_rows(self):
        snapshot = self.snapshot(zones=zone_document())
        regions = worldjson.resolve_regions(snapshot, None, log=lambda _l: None)
        self.assertEqual(len(regions), 2)
        self.assertEqual(set(regions[0]), set(contract.REGION_KEYS))
        # The exporter's rule: smallest polygon first, which is what the map's hover uses.
        self.assertEqual(regions[0]["short_name"], "HB")

    def test_a_zone_document_with_an_extra_field_is_refused(self):
        zones = zone_document()
        zones["zones"][0]["owner"] = "player-1"       # a private field must not pass through
        snapshot = self.snapshot(zones=zones)
        with self.assertRaises(worldjson.WorldDocumentError):
            worldjson.resolve_regions(snapshot, None, log=lambda _l: None)

    def test_missing_rules_carry_from_the_published_document_and_refuse_under_refuse(self):
        snapshot = self.snapshot()
        regions = worldjson.resolve_regions(snapshot, published_document(), policy="carry",
                                            log=lambda _l: None)
        self.assertEqual(regions, published_document()["regions"])
        with self.assertRaises(worldjson.WorldDocumentError):
            worldjson.resolve_regions(snapshot, published_document(), policy="refuse",
                                      log=lambda _l: None)


class DocumentTests(SnapshotCase):
    def tiles(self):
        return [render.TileResult(x=-25, z=7, version="a" * 64, bytes=10, completed=1,
                                 unreadable=0, stale=False, seconds=0.1),
                render.TileResult(x=0, z=0, version="b" * 64, bytes=10, completed=2,
                                  unreadable=0, stale=False, seconds=0.2)]

    def coverage(self):
        return {"center": [-625, -247], "saved_chunk_slots": 31023}

    def build(self, snapshot, **kwargs):
        arguments = {"tiles": self.tiles(), "coverage": self.coverage(),
                     "captured_at": snapshot.captured_at,
                     "previous_document": published_document(), "snapshot": snapshot,
                     "log": lambda _l: None}
        arguments.update(kwargs)
        return worldjson.build(**arguments)

    def test_the_document_has_the_frozen_fields_and_the_captures_own_clock(self):
        snapshot = self.snapshot(zones=zone_document())
        document = self.build(snapshot)
        self.assertEqual(set(document), set(contract.WORLD_KEYS))
        self.assertEqual(document["captured_at"], "2026-10-22T04:30:00+00:00")
        self.assertEqual(document["snapshot_day"], "2026-10-22")
        self.assertEqual([tile["x"] for tile in document["tiles"]], [-25, 0])
        self.assertEqual(document["region_blocks"], 512)
        self.assertEqual(document["center"], [-625, -247])
        self.assertEqual(document["saved_chunk_slots"], 31023)
        # A day after 2026-10-19 means one missed day in between.
        self.assertEqual(document["missed_days"], 2)

    def test_a_carried_document_still_carries_the_new_capture_time(self):
        snapshot = self.snapshot()
        document = self.build(snapshot)
        self.assertEqual(document["captured_at"], "2026-10-22T04:30:00+00:00")
        self.assertIn("carried from the 2026-10-19T04:18:12.238111+00:00 snapshot",
                      document["position_source"])
        self.assertEqual(document["markers"], published_document()["markers"])

    def test_the_document_refuses_a_capture_time_in_the_future(self):
        snapshot = self.snapshot()
        with self.assertRaises(worldjson.WorldDocumentError) as caught:
            self.build(snapshot, captured_at="2099-01-01T00:00:00Z")
        self.assertIn("never claim a newer capture", str(caught.exception))

    def test_a_marker_with_a_faction_is_refused(self):
        published = published_document()
        document = self.build(self.snapshot(), previous_document=published)
        document["markers"] = [dict(document["markers"][0], faction="navy")]
        with self.assertRaises(worldjson.WorldDocumentError) as caught:
            worldjson.validate(document)
        self.assertIn("private", str(caught.exception))

    def test_an_unknown_top_level_field_is_refused(self):
        document = self.build(self.snapshot())
        document["players"] = [{"name": "owen"}]
        with self.assertRaises(worldjson.WorldDocumentError):
            worldjson.validate(document)

    def test_a_tile_without_a_sha256_version_is_refused(self):
        document = self.build(self.snapshot())
        document["tiles"][0]["version"] = "abc"
        with self.assertRaises(worldjson.WorldDocumentError):
            worldjson.validate(document)

    def test_the_document_passes_the_repositorys_own_validator(self):
        """The map half alone, composed with the published client half, in a temp tree."""
        from scripts.validate import validate_data
        import shutil

        snapshot = self.snapshot(zones=zone_document())
        document = self.build(snapshot)
        staging = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, staging, True)
        root = staging / "site"
        (root / "data").mkdir(parents=True)
        worldjson.write(document, root / "data/world.json")
        for tile in self.tiles():
            path = root / f"data/tiles/{tile.x}/{tile.z}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes([tile.x % 251]))
            # The validator checks the version against the PNG's own hash, so rewrite the
            # document with the real digests rather than pretending they match.
        import hashlib
        for tile, entry in zip(self.tiles(), document["tiles"]):
            blob = (root / f"data/tiles/{tile.x}/{tile.z}.png").read_bytes()
            entry["version"] = hashlib.sha256(blob).hexdigest()
        worldjson.write(document, root / "data/world.json")
        shutil.copyfile(REPO_ROOT / "site/data/client.json", root / "data/client.json")
        shutil.copytree(REPO_ROOT / "site/downloads", root / "downloads")
        validate_data(root)


if __name__ == "__main__":
    unittest.main()
