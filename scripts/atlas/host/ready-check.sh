#!/usr/bin/env bash
# "Is the Minecraft server genuinely ready?", asked ON THE GAME HOST through SSM.
#
# The launcher's own rule for readiness is "the port, not the instance" (PROJECT.md, game
# control): an instance that is merely `running` proves nothing about the game. The same rule
# is what decides whether a snapshot is worth taking: `save-off` and `save-all flush` on a
# server that is still loading its world archive nothing, and a capture that starts too early
# is a corrupt snapshot rather than a cheap one.
#
# Ready means all three, in this order, and it waits for them with a bounded deadline:
#   1. the systemd unit reports `active`;
#   2. the vanilla ready line ("Done (N.NNNs)! For help, type \"help\"") is in the log,
#      written AFTER this script started waiting -- so a line left by an earlier boot can
#      never be mistaken for this one;
#   3. something accepts a TCP connection on the server port.
#
# It exits 0 only when all three hold, and 1 with a named reason otherwise. The pipeline
# stops the instance when this fails, so an unbounded wait here would be an unbounded bill.
#
# Environment (set by scripts/atlas/host.py):
#   ATLAS_SERVER_UNIT   systemd unit (default minecraft.service)
#   ATLAS_SERVER_LOG    log file (default /opt/minecraft/server/logs/latest.log)
#   ATLAS_SERVER_PORT   port to connect to (default 25565)
#   ATLAS_READY_TIMEOUT seconds to wait (default 900)
set -uo pipefail

UNIT="${ATLAS_SERVER_UNIT:-minecraft.service}"
SERVER_LOG="${ATLAS_SERVER_LOG:-/opt/minecraft/server/logs/latest.log}"
PORT="${ATLAS_SERVER_PORT:-25565}"
TIMEOUT="${ATLAS_READY_TIMEOUT:-900}"
POLL="${ATLAS_READY_POLL:-5}"

log() { printf 'atlas-ready: %s\n' "$*"; }

timed_out() {
  log "not ready within ${TIMEOUT}s: $*"
  log "the pipeline will stop this instance"
  exit 1
}

started_at="$(date +%s)"
deadline=$(( started_at + TIMEOUT ))
log "waiting up to ${TIMEOUT}s for ${UNIT} (log ${SERVER_LOG}, port ${PORT})"

unit_state=""
port_state=""
while [ "$(date +%s)" -le "$deadline" ]; do
  if [ -z "$unit_state" ]; then
    state="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
    if [ "$state" = "active" ]; then
      unit_state="active"
      log "unit ${UNIT} is active"
    else
      log "unit ${UNIT} is '${state:-unknown}'"
    fi
  fi
  if [ "$unit_state" = "active" ] && [ -z "$port_state" ]; then
    if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
      port_state="open"
      log "port ${PORT} accepts connections"
    fi
  fi
  if [ "$unit_state" = "active" ]; then
    # `-newermt @<epoch>` keeps an earlier boot's "Done" line out of the answer. The host's
    # own clock is used for both sides, so there is no skew to reason about.
    if [ -f "$SERVER_LOG" ] && grep -qF 'Done (' "$SERVER_LOG" 2>/dev/null \
        && [ -n "$(find "$SERVER_LOG" -newermt "@$(( started_at - 2 ))" -print -quit 2>/dev/null)" ]; then
      ready_line="$(grep -F 'Done (' "$SERVER_LOG" | tail -n 1)"
      if [ -n "$port_state" ]; then
        log "ready: ${ready_line}"
        exit 0
      fi
    fi
  fi
  sleep "$POLL"
done

if [ "$unit_state" != "active" ]; then
  timed_out "the unit never became active (last state '${unit_state:-unknown}'); \
see journalctl -u ${UNIT}"
fi
if [ ! -f "$SERVER_LOG" ]; then
  timed_out "the unit is active but ${SERVER_LOG} does not exist"
fi
if ! grep -qF 'Done (' "$SERVER_LOG" 2>/dev/null; then
  timed_out "the unit is active but ${SERVER_LOG} has no 'Done (' line: the world is still loading"
fi
timed_out "the world finished loading but nothing accepts a connection on port ${PORT}"
