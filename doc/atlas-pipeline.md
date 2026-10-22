# The atlas pipeline: the public map without Owen's machine

The map used to be rendered and published by a systemd timer on Easter-Server, the household's
own computer. Owen's rule is that his personal machine cannot be part of production
infrastructure, so the timer is disabled (2026-10-22) and this pipeline replaces it. Nothing in
it runs on any machine of his, and no Minecraft server has to be up for it to decide what to do.

It is one scheduled GitHub Actions workflow (`.github/workflows/atlas.yml`) running
`python -m scripts.atlas` from `scripts/atlas/`. The repository is public, so the minutes are
free at any frequency, and there is no long-lived credential anywhere: AWS access is GitHub
OIDC, publishing is the workflow's own `GITHUB_TOKEN`.

## The three questions, in this order

```
python -m scripts.atlas            # client half, then the map half
```

### 1. Has the world changed since the last snapshot? (cheap: two reads)

One `GetObject` of the pointer `s3://$ATLAS_BUCKET/atlas/last-snapshot.json` and one
`DescribeInstances`. Nothing else. EC2 already knows what the pipeline needs:

| field | changes when | why it is compared |
|---|---|---|
| `LaunchTime` | the instance is replaced or rebuilt | a different launch is a different machine |
| the timestamp in `StateTransitionReason` | every start and every stop | it catches a player's session, a launcher wake or a lifecycle policy, none of which move `LaunchTime` |

The pointer records the transition that ended the capture we published, so an unchanged world
is an exact match rather than a time comparison:

```
atlas: change: field=launch_time 2026-10-20T09:00:00+00:00 and field=state_transition_reason
2026-10-22T04:31:00+00:00 match the pointer captured_at 2026-10-22T04:30:00+00:00
-> unchanged (no capture, no wake, no commit)
```

and then exactly one line:

```
atlas: map reuse -- the published snapshot stands (snapshot_day 2026-10-19); nothing was captured: <that line>
```

No wake, no SSM command, no upload, no commit, no pointer write, and `site/data/world.json` is
byte-for-byte untouched. Anything unreadable (a pointer without the facts, a reason string with
no timestamp) biases towards capture: a needless capture costs a minute of render, a wrongly
skipped one silently freezes the public map.

A **running** host is never captured and never stopped: if EC2 says `running`, somebody is using
it. The run defers, says so, and leaves it alone.

### 2. Capture (only when the answer was yes)

```
start_instances -> ready-check.sh over SSM -> snapshot.sh over SSM -> confirm the upload -> stop_instances
```

* **The scripts are committed files**, sent base64-encoded inside the SSM command, so what runs
  on the host is the reviewed bytes in this repository. `scripts/atlas/host/snapshot.sh` does
  `save-off`, `save-all flush`, tars the Overworld regions + `level.dat` (+ the optional marker
  sources) into the frozen key, uploads it with a sha256 sidecar, and sends `save-on` from an
  `EXIT` trap on **every** path, including every failure. `ready-check.sh` waits for the unit to
  be active, for `Done (` to appear in the log written *after it started waiting*, and for the
  port to accept a connection.
* **The stop is asserted, not assumed.** It runs in a `finally`, it happens after a failure in
  every stage, and its result is checked: `stop_instances` once, then EC2 is described until it
  reports `stopping`/`stopped`. A stop that cannot be confirmed raises `StopNotConfirmed` and
  says the production server may still be running.
* **The upload is confirmed by the pipeline**: the sidecar's sha256 and byte count are compared
  with the object's real size in S3, and the tarball is hashed again while it is downloaded
  before a single member is extracted.

### 3. Publish (two independent halves, two commits)

| half | paths | when |
|---|---|---|
| client | `site/data/client.json`, `site/downloads/` | first, every run, its own commit and its own failure domain |
| map | `site/data/world.json`, `site/data/tiles/` | only after a capture, only if the bytes differ |

The order is deliberate: from 2026-10-19 to 2026-10-22 a dead map capture took the client
manifest down with it, so the client half publishes first and alone. Publishing is the Git Data
API with the workflow's token (`scripts/atlas/publish.py`): a blob is only uploaded when its
git blob hash is not already in the tree, a whole half is one commit, the ref is fast-forwarded
(never forced), and any path outside `site/data/` and `site/downloads/` is refused before a
single request is made.

The pointer is written **after** the commit. A failed publication leaves it where it was, so the
next run captures again instead of losing a capture; the same runs' tiles are not lost because
the S3 snapshot is still there.

## The bucket contract

One private bucket, three keys:

| key | written by | contents |
|---|---|---|
| `atlas/world-snapshot.tar.gz` | the game host, over SSM | the newest capture, overwritten each time |
| `atlas/snapshot-sidecar.json` | the game host, over SSM | the host's own claim: sha256, bytes, region counts |
| `atlas/last-snapshot.json` | this pipeline | the pointer: which capture we published, plus the EC2 facts to compare next time |

Tarball layout (frozen):

```
capture/manifest.json                        the host's capture record
world/dimensions/minecraft/overworld/region/r.<x>.<z>.mca
world/level.dat
capture/map-zones.json                       optional: the region rules the game applied
capture/config/easter-*.{json,txt}           optional: which ships and named NPCs exist
capture/positions.json                       optional: last-known ship/NPC positions
```

The first three are the minimum. The optional files are what the marker and region halves of
`world.json` need, and the pipeline says plainly what it did when a capture carries none: it
carries those fields forward from the last published document, keeps every `observed_at`
unchanged, and states it in `position_source`. It never invents a position, never erases the
regions the site already shows, and never writes a `captured_at` newer than the capture. With
`ATLAS_MARKERS=refuse` it refuses instead and publishes nothing.

## The renderer

`scripts/atlas/renderer/` is a generated copy of e-server's renderer: `minecraft_map.py`,
`minecraft_map_data.py`, `minecraft_nbt.py`, plus `map_zones.py` (a fourth file the ticket did
not name: `minecraft_map_data.patrol_groups()` imports it at call time, so without it the marker
reader raises `ModuleNotFoundError`). `scripts/atlas/renderer/vendor.py` is the only writer of
those files; it applies a documented list of substitutions (the world root and the tile cache
become environment-overridable, the cache is keyed on the world root's path instead of its
inode, the three modules import each other relatively) and records the upstream sha256 of each
one in `VENDORED.json`. `tests/test_atlas_renderer_vendor.py` fails in both directions: an
upstream file that moved, and a vendored file edited by hand. Re-vendoring is a deliberate act:

```
python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --write
```

Rendering runs in parallel **processes** (`ATLAS_RENDER_WORKERS`, default `min(4, cpus)`):
a region costs 0.8 s of CPU on average and up to 3.3 s for the biggest ones, and a thread would
hold the GIL through every chunk parse.

## Measured

Measured on Easter-Server (16 cores, Python 3.14, Pillow 13.0.0) against the live world tree,
2026-10-22, with `scripts/atlas/render.py` itself:

| | |
|---|---|
| region files in the world tree | 390 |
| region files with any saved chunk | **66** (the other 324 are empty headers and cost ~2 ms each) |
| serial render of the whole set | 52.9 s (0.801 s per region mean, 0.163 s median, 3.3 s max) |
| 6 worker processes, same set | 11.2 s wall, 62.1 s CPU |
| tiles produced | 66, 551 285 bytes total |
| replayed against `site/data/tiles` | **66/66 byte-identical** |

The brief's "390 regions at ~2.5 s each is over ten minutes serially" is an over-estimate: 324 of
those files have no saved chunk and are skipped before any rendering, and the ~2.5 s figure is
the cost of the *biggest* regions, not the average. The honest number for one real capture is
**under a minute of render**, so the pipeline is cheap for the reason the brief hoped and not
for the reason it guessed.

## What is proven, and what is not

**Proven here, by a test that fails if the behaviour changes:**

* The renderer replay: 32 published tiles carry terrain, and the vendored renderer reproduces
  them byte for byte from a copy of the world tree with the root overridden
  (`tests/test_atlas_render_parity.py`; 6 replayed by default, `ATLAS_PARITY_TILES=all` for all).
* The cache is keyed on the world root: a re-extracted tree at the same path hits the same cache
  entry, and two different roots never share one.
* The whole pipeline against fakes, on a runner-shaped call (`tests/test_atlas_pipeline.py`):
  the order of the three questions, zero actions when nothing changed, the pointer only after a
  commit, one commit per half, and the client half publishing while the map half captures
  nothing.
* The wake path with **one test per failing stage** (start raises, never ready, SSM refused,
  upload truncated, sidecar unreadable, snapshot command fails), each asserting
  `stop_instances` was called once and EC2 settled; plus the unconfirmed stop, which is loud;
  plus the inverse, that a host this run did not start is never stopped
  (`tests/test_atlas_host.py`).
* Change detection's every branch, and the counting assertion that an unchanged world costs one
  `GetObject` and one `DescribeInstances` and nothing else (`tests/test_atlas_change.py`).
* The publisher over real HTTP against a local server that speaks the Git Data API
  (`tests/test_atlas_publish.py`): blobs reused by content, one commit per half, refusals for
  paths outside the generated tree, a retried 422 that never forces the ref.
* The workflow's shape: exactly two permissions, cron + dispatch, one non-cancellable
  concurrency group, no secret expression anywhere, and actionlint clean.
* The client half rebuilt on a runner-shaped call reproduces the published
  `site/data/client.json` byte for byte, and the repository's own `validate_data` accepts it
  composed with the published map half.

**Not proven, and why:**

* **No real AWS call has ever been made by this code.** No EC2 start/stop, no SSM command, no
  S3 upload. The first scheduled run is the proof, and the workflow's step summary prints the
  run summary so that run is readable afterwards.
* **The host-side facts are assumptions until the first capture.** Three of them:
  `ATLAS_CONSOLE` (a command that sends one line to the server console; `rcon-cli` is the usual
  provider) — the pipeline refuses to capture rather than tar an unflushed world;
  `ATLAS_SERVER_UNIT` and `ATLAS_SERVER_LOG` (defaults `minecraft.service` and
  `/opt/minecraft/server/logs/latest.log`). The host also needs an instance profile allowing
  `s3:PutObject` on `atlas/*`, which is the cloud ticket's job, and the `aws` CLI, which
  Amazon Linux 2023 ships.
* **The tarball's real-world shape** has only been exercised with synthetic captures of a real
  world tree, not with a tarball produced by the committed script on the host.
* **The client half does not build a new mod jar.** `export_world.export_client` builds it from
  `/opt/minecraft/client-mods`, a directory on Owen's machine, and the whole point of this
  pipeline is not needing that machine. So the half republishes the manifest around the jar
  already in `site/downloads/` (verified against the published checksum), and re-confirms every
  dependency pin against Modrinth. **A new mod jar still needs the launcher/game release path to
  place it in `site/downloads/`.** If that boundary is not acceptable, the alternative is to
  publish jars to the bucket from wherever the mod is built and have this half read them from
  S3 — a separate ticket, and worth doing if mod updates need to be hands-off.
* **Pillow's version can change tile bytes.** The pin (`pillow==13.0.0`) is the version that
  produced the published tiles. Bumping it re-encodes every tile, so every content-addressed
  tile version changes and the whole map republishes once. That is not a correctness problem,
  but it should not be discovered by accident.

## Running it

Nothing here is deployed. The command sequence for a first real run:

```
# 1. On a branch, with the checks green:
python -m unittest discover -s tests -p 'test_atlas_*.py'
python scripts/validate.py site
actionlint .github/workflows/atlas.yml

# 2. Repository variables, once (not secrets):
#    ATLAS_ROLE_ARN, ATLAS_AWS_REGION, ATLAS_BUCKET, ATLAS_INSTANCE_ID
#    ATLAS_CONSOLE, ATLAS_SERVER_UNIT   (only if the defaults do not fit the host)

# 3. First run, safely: nothing is committed and the instance is still stopped and started:
gh workflow run atlas.yml -f dry_run=true

# 4. Watch it, then let the schedule take over (hourly at :17).
gh run list --workflow atlas.yml
```

Locally, against fakes, the whole thing is a test:

```
python -m unittest tests.test_atlas_pipeline -v
```

and against a real world tree (read-only), the renderer replay:

```
ATLAS_WORLD_ROOT=/opt/minecraft/server/world ATLAS_PARITY_TILES=all \
  python -m unittest tests.test_atlas_render_parity -v
```
