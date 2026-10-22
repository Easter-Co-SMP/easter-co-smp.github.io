#!/usr/bin/env bash
# The capture, run ON THE GAME HOST through SSM Run Command.
#
# Why this is a committed file rather than a string in the workflow: a hand-typed cloud
# command has already deleted a live auth domain in this household, and this one runs
# against the production server's world. The pipeline sends these exact bytes
# (`scripts/atlas/host.py` base64-encodes this file) so what runs on the host is what was
# reviewed in Git, and nothing on the host has to be installed or updated for it to work.
#
# What it does, in this order, and nothing else:
#   1. refuses before touching anything if a required command is missing;
#   2. `save-off`, then `save-all flush`, and fails if the flush is not confirmed;
#   3. tars the Overworld region directory and level.dat into the frozen key, plus the
#      optional marker/region sources when the host has them;
#   4. uploads the tarball, then a sidecar JSON that states its sha256 and byte count;
#   5. `save-on` on EVERY exit path, including every failure above, through an EXIT trap.
#
# The one host fact this file cannot know is how to talk to the server's console. It is
# `ATLAS_CONSOLE` (default `minecraft-console`), a command that takes one line of server
# console input as its argument. RCON is usually the easiest way to provide it
# (`rcon-cli`, or a wrapper around a console FIFO). When it is missing or refuses, this
# script fails without saving anything and says which command failed: a capture of an
# unflushed world is a corrupt snapshot, not a partial one.
#
# Environment (set by scripts/atlas/host.py on the SSM command line):
#   ATLAS_BUCKET      bucket to upload to
#   ATLAS_SNAPSHOT_KEY  key for the tarball
#   ATLAS_SIDECAR_KEY   key for the sidecar JSON
#   ATLAS_SERVER_ROOT   server directory (default /opt/minecraft/server)
#   ATLAS_CONSOLE       console command (default minecraft-console)
#   ATLAS_ZONES_FILE    the game's region-rules document, if it is on this host
#   ATLAS_CAPTURE_ID    an identifier for this capture, echoed in the manifest
set -uo pipefail

log() { printf 'atlas-snapshot: %s\n' "$*"; }
fail() { printf 'atlas-snapshot: ERROR: %s\n' "$*" >&2; STATUS=1; }

STATUS=0
SAVES_OFF=0
TAR_PATH=""
CONSOLE="${ATLAS_CONSOLE:-minecraft-console}"
SERVER_ROOT="${ATLAS_SERVER_ROOT:-/opt/minecraft/server}"
WORLD="$SERVER_ROOT/world"
REGION_DIR="$WORLD/dimensions/minecraft/overworld/region"
if [ ! -d "$REGION_DIR" ]; then
  # Pre-1.21 worlds keep the Overworld regions beside level.dat. e-server's renderer makes
  # the same choice, so a capture of an older world still names the right directory.
  REGION_DIR="$WORLD/region"
fi
CAPTURE_ID="${ATLAS_CAPTURE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

save_on() {
  if [ "$SAVES_OFF" = 1 ]; then
    if "$CONSOLE" "save-on" >/dev/null 2>&1; then
      log "save-on sent"
    else
      fail "save-on could not be sent: the world may still have saving disabled, and that needs a human"
    fi
    SAVES_OFF=0
  fi
}

cleanup() {
  rc=$?
  save_on
  if [ -n "$TAR_PATH" ] && [ -f "$TAR_PATH" ]; then rm -f "$TAR_PATH"; fi
  if [ -n "${STAGE:-}" ] && [ -d "$STAGE" ]; then rm -rf "$STAGE"; fi
  # A failed capture must never look like a success to SSM, or the pipeline would go on to
  # publish whatever was in the bucket from last time.
  exit $(( rc != 0 ? rc : STATUS ))
}
trap cleanup EXIT

console() {
  local line="$1" answer
  if ! answer="$("$CONSOLE" "$line" 2>&1)"; then
    fail "console refused '${line}': ${answer}"
    return 1
  fi
  log "console '${line}' -> ${answer}"
  return 0
}

# ── 1. preflight, before the world is touched at all ────────────────────────────────────
for command in tar gzip sha256sum base64; do
  command -v "$command" >/dev/null 2>&1 || fail "required command '${command}' is not on this host"
done
if ! command -v aws >/dev/null 2>&1; then
  fail "the AWS CLI is not on this host; it uploads the snapshot, so nothing is captured without it"
fi
if ! command -v "$CONSOLE" >/dev/null 2>&1; then
  fail "the console command '${CONSOLE}' is not on this host (set ATLAS_CONSOLE); \
capturing without save-off/save-all would archive a half-written world"
fi
if [ ! -d "$REGION_DIR" ]; then fail "no Overworld region directory under ${WORLD}"; fi
if [ ! -f "$WORLD/level.dat" ]; then fail "no level.dat under ${WORLD}"; fi
if [ "$STATUS" != 0 ]; then
  log "preflight failed; nothing was captured and the world was never touched"
  exit 1
fi

# ── 2. stop writing, then force everything to disk ──────────────────────────────────────
# save-off first, always: a save-then-save-off pair can have the server write a chunk
# between the two commands, which is exactly the torn region the renderer would then read.
if console "save-off"; then SAVES_OFF=1; else
  fail "save-off was not accepted; refusing to tar a world the server is still writing"
  exit 1
fi
if ! console "save-all flush"; then
  fail "save-all flush was not accepted; refusing to tar a world that may not be on disk"
  exit 1
fi

# ── 3. build the tarball ────────────────────────────────────────────────────────────────
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/atlas-capture.XXXXXX")" || { fail "no temporary directory"; exit 1; }
mkdir -p "${STAGE}/capture/config"
TAR_PATH="${STAGE}/world-snapshot.tar.gz"

captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
region_files=0
nonempty_regions=0
# An empty region file is a 4096-byte (or zero-byte) header of zeroes: the world has a file
# for that position and no saved chunk in it. The renderer skips those too, so counting them
# the same way here is what makes this number comparable with the render log.
while IFS= read -r -d '' region; do
  region_files=$((region_files + 1))
  if [ -s "$region" ] && [ "$(head -c 4096 "$region" | tr -d '\000' | wc -c)" -gt 0 ]; then
    nonempty_regions=$((nonempty_regions + 1))
  fi
done < <(find "$REGION_DIR" -maxdepth 1 -type f -name 'r.*.*.mca' -print0)

level_dat_bytes=0
if [ -f "$WORLD/level.dat" ]; then level_dat_bytes="$(stat -c %s "$WORLD/level.dat" 2>/dev/null || echo 0)"; fi

# The optional sources the public document's marker and region halves need. Each is copied
# only when the host has it, and its absence is recorded in the manifest rather than
# invented: the pipeline carries those fields forward from the last published document and
# says so (see scripts/atlas/markers.py).
missing_sources=""
copy_optional() {
  local source="$1" target="$2"
  if [ -f "$source" ]; then
    cp -f "$source" "${STAGE}/capture/${target}" || fail "could not copy ${source}"
  else
    missing_sources="${missing_sources}${target} "
  fi
}
copy_optional "$SERVER_ROOT/config/easter-fleet-ships.json" "config/easter-fleet-ships.json"
copy_optional "$SERVER_ROOT/config/easter-region-guards.json" "config/easter-region-guards.json"
for roster in easter-navy-villagers.txt easter-navy-islanders.txt easter-navy-garrison.txt \
              easter-navy-wildlife.txt; do
  copy_optional "$SERVER_ROOT/config/${roster}" "config/${roster}"
done
# The last-known position store, if this host keeps one. Without it every ship and NPC row
# arrives without a position, and the pipeline will not publish a marker list that loses the
# ones the site already shows.
copy_optional "${ATLAS_POSITIONS_FILE:-${SERVER_ROOT}/atlas-positions.json}" "positions.json"
if [ -n "${ATLAS_ZONES_FILE:-}" ]; then
  copy_optional "$ATLAS_ZONES_FILE" "map-zones.json"
fi

cat > "${STAGE}/capture/manifest.json" <<MANIFEST
{
  "schema": 1,
  "capture_id": "${CAPTURE_ID}",
  "captured_at": "${captured_at}",
  "host": "$(hostname)",
  "server_root": "${SERVER_ROOT}",
  "region_dir": "${REGION_DIR}",
  "region_files": ${region_files},
  "nonempty_regions": ${nonempty_regions},
  "level_dat_bytes": ${level_dat_bytes},
  "missing_sources": "$(printf '%s' "$missing_sources" | sed 's/ *$//')",
  "console": "${CONSOLE}"
}
MANIFEST

# Two -C groups so the tarball's member names are exactly the frozen layout:
#   world/dimensions/minecraft/overworld/region/... , world/level.dat , capture/...
# GNU tar treats each -C as applying to the file arguments that follow it.
if ! tar -czf "$TAR_PATH" -C "$SERVER_ROOT" "world/dimensions/minecraft/overworld/region" \
        "world/level.dat" -C "$STAGE" "capture"; then
  fail "tar failed; nothing will be uploaded"
  exit 1
fi

tar_bytes="$(stat -c %s "$TAR_PATH")" || { fail "cannot stat the tarball"; exit 1; }
tar_sha256="$(sha256sum "$TAR_PATH" | cut -d' ' -f1)" || { fail "cannot hash the tarball"; exit 1; }
if [ "${tar_bytes:-0}" -le 0 ]; then fail "the tarball is empty"; exit 1; fi
log "captured ${region_files} region files (${nonempty_regions} non-empty), ${tar_bytes} bytes, sha256 ${tar_sha256}"

# ── 4. upload, then say what was uploaded ──────────────────────────────────────────────
if ! aws s3 cp --only-show-errors --no-progress "$TAR_PATH" \
        "s3://${ATLAS_BUCKET}/${ATLAS_SNAPSHOT_KEY}"; then
  fail "upload of s3://${ATLAS_BUCKET}/${ATLAS_SNAPSHOT_KEY} failed"
  exit 1
fi
sidecar="$(mktemp "${TMPDIR:-/tmp}/atlas-sidecar.XXXXXX")" || { fail "no temporary file"; exit 1; }
cat > "$sidecar" <<SIDECAR
{
  "schema": 1,
  "captured_at": "${captured_at}",
  "instance_id": "$(curl -s -H 'X-aws-ec2-metadata-token: ' --max-time 2 http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo unknown)",
  "tar_key": "${ATLAS_SNAPSHOT_KEY}",
  "tar_sha256": "${tar_sha256}",
  "tar_bytes": ${tar_bytes},
  "region_files": ${region_files},
  "nonempty_regions": ${nonempty_regions},
  "level_dat_bytes": ${level_dat_bytes},
  "warnings": "$(printf '%s' "$missing_sources" | sed 's/ *$//')"
}
SIDECAR
if ! aws s3 cp --only-show-errors --no-progress "$sidecar" \
        "s3://${ATLAS_BUCKET}/${ATLAS_SIDECAR_KEY}"; then
  fail "upload of the sidecar s3://${ATLAS_BUCKET}/${ATLAS_SIDECAR_KEY} failed"
  rm -f "$sidecar"
  exit 1
fi
rm -f "$sidecar"

log "uploaded s3://${ATLAS_BUCKET}/${ATLAS_SNAPSHOT_KEY} and its sidecar"
if [ "$STATUS" != 0 ]; then exit 1; fi
exit 0
