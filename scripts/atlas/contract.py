"""The frozen contract between the atlas pipeline, the bucket and the public site.

One module holds every key name, every document shape and the set of paths this pipeline
is allowed to write, because the other halves of the feature -- the CDK bucket and OIDC role
in the cloud repository, and the Pages deploy this repository already runs -- need to agree
with it exactly. Anything that has to be negotiated with another layer lives here and
nowhere else.

## The bucket

One private bucket, three objects, all under `atlas/`:

| key | written by | meaning |
|---|---|---|
| `atlas/world-snapshot.tar.gz` | the game host, over SSM | the newest capture; overwritten each time |
| `atlas/snapshot-sidecar.json` | the game host, over SSM | the host's own claim about that capture |
| `atlas/last-snapshot.json` | this pipeline | the pointer: the capture we published |

The pointer is the only object the pipeline ever trusts for "what did we last publish", and
it is written *after* the site commit exists, never before. The sidecar is the host's claim
and the pipeline verifies the tarball against it; the two are separate objects on purpose, so
"what the host says it uploaded" can never be silently rewritten by the pipeline.

The tarball layout, frozen:

```
capture/manifest.json                        the host's capture record (schema, time, counts)
world/dimensions/minecraft/overworld/region/r.<x>.<z>.mca
world/level.dat
capture/map-zones.json                       optional: the region rules the game applied
capture/config/easter-fleet-ships.json       optional: which ships exist
capture/config/easter-navy-*.txt             optional: which named NPCs exist
capture/config/easter-region-guards.json     optional: which guards exist
capture/positions.json                       optional: last-known ship/NPC positions
```

The first three are the minimum the ticket freezes. The optional files are what the marker
and region halves of `world.json` need; when a capture carries none of them the pipeline
carries those fields forward from the last published document and says so, rather than
inventing positions or erasing the map's regions.

## Why the pointer carries EC2 facts

Change detection compares two fields EC2 already reports -- `LaunchTime` and the timestamp
inside `StateTransitionReason` -- against the ones recorded in the pointer. That is why the
pointer records them: it is the only store, there is no second database, and a run that
compares nothing has nothing to be wrong about.
"""

SCHEMA = 1

#: Bucket keys, frozen. `{` in a key would mean a template; these are literals.
SNAPSHOT_KEY = "atlas/world-snapshot.tar.gz"
SIDECAR_KEY = "atlas/snapshot-sidecar.json"
POINTER_KEY = "atlas/last-snapshot.json"

#: The paths this pipeline may write in this repository, and the two independent halves.
#: `site/data` and `site/downloads` are exactly what `scripts/sync.py` owns; the check in
#: `tests/test_atlas_contract.py` keeps the two lists from drifting apart.
GENERATED_PATHS = ("site/data", "site/downloads")
MAP_PATHS = ("site/data/world.json", "site/data/tiles")
CLIENT_PATHS = ("site/data/client.json", "site/downloads")
MAP_COMMIT_MESSAGE = "Publish the atlas terrain for {snapshot_id}"
CLIENT_COMMIT_MESSAGE = "Publish the client manifest"

#: The public atlas document's key set, frozen by `scripts/validate.py` in this repository
#: and by the site's own reader. Restated here so the pipeline refuses to build anything the
#: validator would refuse, and so a change to one has to be a change to both.
WORLD_KEYS = frozenset({
    "schema", "captured_at", "snapshot_day", "missed_days", "center", "region_blocks",
    "saved_chunk_slots", "tiles", "regions", "markers", "unlocated_markers",
    "position_source",
})
#: The ten fields a published region row carries; `scripts/export_world.py:public_regions`.
REGION_KEYS = ("id", "name", "short_name", "points", "pvp_protection", "pve_protection",
               "edit_protection", "navy_controlled", "guard_patrols", "navy_patrols")

#: The zone document the host captures verbatim from the game (`core/map_zones.py`), and
#: the shape it must have before a single region polygon may be published from it.
ZONE_KEYS = frozenset({"schema", "revision", "zones"})

#: The capture's own manifest, written by `scripts/atlas/host/snapshot.sh` inside the tar.
CAPTURE_MANIFEST = "capture/manifest.json"
CAPTURE_ZONES = "capture/map-zones.json"
CAPTURE_CONFIG = "capture/config"
CAPTURE_POSITIONS = "capture/positions.json"
CAPTURE_WORLD = "world"

#: Where a capture's world tree is, relative to the extracted snapshot root. The renderer
#: and the NBT reader both take this as their world root.
WORLD_REGION_DIR = "dimensions/minecraft/overworld/region"
WORLD_LEVEL_DAT = "level.dat"

#: The sidecar the host writes: its own claim, verified against the tarball's real bytes.
SIDECAR_KEYS = frozenset({
    "schema", "captured_at", "instance_id", "tar_key", "tar_sha256", "tar_bytes",
    "region_files", "nonempty_regions", "level_dat_bytes", "warnings",
})

#: The pointer this pipeline writes, after a published commit.
POINTER_KEYS = frozenset({
    "schema", "snapshot_id", "captured_at", "published_at", "instance_id", "launch_time",
    "state_transition_at", "state_transition_reason", "tar_key", "tar_sha256", "tar_bytes",
    "region_files", "nonempty_regions", "tiles", "position_source", "source",
})


def _stamp(value, length=None):
    """An instant as a compact UTC stamp: one spelling for one moment.

    `2026-10-22T04:30:00Z`, `2026-10-22T04:30:00+00:00` and `...T00:30:00-04:00` are the same
    capture instant and must produce the same identifier, or a re-run would look like a new
    snapshot to anything that compares ids.
    """
    from datetime import datetime, timezone

    text = str(value or "")
    moment = None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        moment = None
    if moment is None:
        stem = "".join(character for character in text if character.isalnum())[:length or 15]
        return stem or "unknown"
    moment = moment.astimezone(timezone.utc) if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    stamp = moment.strftime("%Y%m%dT%H%M%SZ")
    return stamp if length is None else stamp[:length]


def snapshot_id(captured_at, launch_time):
    """"The capture this is", stable and readable: the capture instant plus the instance's
    launch, so two captures of the same host are distinguishable in a log and a commit."""
    return f"{_stamp(captured_at)}-{_stamp(launch_time, 15)}"


def pointer_document(*, captured_at, published_at, instance_id, launch_time,
                     state_transition_at, state_transition_reason, tar_key, tar_sha256,
                     tar_bytes, region_files, nonempty_regions, tiles, position_source,
                     source="github-actions"):
    """Build the pointer. Refuses a document with keys the contract does not name."""
    document = {
        "schema": SCHEMA,
        "snapshot_id": snapshot_id(captured_at, launch_time),
        "captured_at": captured_at,
        "published_at": published_at,
        "instance_id": instance_id,
        "launch_time": launch_time,
        "state_transition_at": state_transition_at,
        "state_transition_reason": state_transition_reason,
        "tar_key": tar_key,
        "tar_sha256": tar_sha256,
        "tar_bytes": int(tar_bytes),
        "region_files": int(region_files),
        "nonempty_regions": int(nonempty_regions),
        "tiles": int(tiles),
        "position_source": position_source,
        "source": source,
    }
    unexpected = set(document) - POINTER_KEYS
    if unexpected:
        raise ValueError("pointer has fields outside the contract: " + ", ".join(sorted(unexpected)))
    return document
