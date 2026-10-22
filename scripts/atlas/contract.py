"""The site half's frozen names: where the bundle comes from and where its bytes may land.

The AWS half (`easter-co-cloud`, `pipeline/atlas/`) captures and renders and leaves two
objects in a bucket: `publish/latest.json` (what is ready) and a zip beside it (the bytes).
This half reads the document over plain HTTPS -- no credential, because the objects it reads
are public and hold nothing the site does not already show -- and commits the zip's contents
with the workflow's own token.

`site/data` and `site/downloads` are the only paths either half may write, and they are the
same two `scripts/sync.py` owns; `tests/test_atlas_contract.py` keeps the three lists equal so
a third publisher cannot appear by accident.
"""

SCHEMA = 1

#: The two generated paths this pipeline may commit, exactly as `scripts/sync.py` names them.
GENERATED_PATHS = ("site/data", "site/downloads")

#: The two independent halves, as repository paths. The bundle may carry either on its own.
MAP_PATHS = ("site/data/world.json", "site/data/tiles")
CLIENT_PATHS = ("site/data/client.json", "site/downloads")

MAP_COMMIT_MESSAGE = "Publish the atlas terrain for {snapshot_day}"
CLIENT_COMMIT_MESSAGE = "Publish the client manifest"

#: Inside the zip, paths are relative to `site/`, which is what the workflow unzips into.
ZIP_WORLD = "data/world.json"
ZIP_TILES = "data/tiles"
ZIP_CLIENT = "data/client.json"
ZIP_DOWNLOADS = "downloads"

#: The publish document's own key sets, restated here so this half refuses a document the AWS
#: half could not have written -- a mismatch in either direction is a deployment mistake.
PUBLISH_KEYS = frozenset({"schema", "takenAt", "snapshot_day", "captured_at", "map", "client"})
MAP_KEYS = frozenset({"zip", "sha256", "bytes", "world_sha256", "world_bytes", "tiles"})
CLIENT_HALF_KEYS = frozenset({"document", "files", "zip", "sha256", "bytes"})

#: The public atlas document's key set, frozen by `scripts/validate.py`.
WORLD_KEYS = frozenset({
    "schema", "captured_at", "snapshot_day", "missed_days", "center", "region_blocks",
    "saved_chunk_slots", "tiles", "regions", "markers", "unlocated_markers",
    "position_source",
})
