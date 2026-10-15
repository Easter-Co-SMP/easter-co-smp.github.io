# Easter Co. SMP — The Easter Isles

Public website: **https://easter-co-smp.github.io/**

`site/` is the complete buildless GitHub Pages site. A push to `main` validates the site
and deploys that directory. Scripts, host configuration, and tests are excluded from the
published artifact. Preview with `python -m http.server --directory site 18100`.

## The public chart

The map uses the same saved Overworld renderer and region definitions as the household
map. It supports pan, zoom, touch, fullscreen, and remembered layer toggles. IndexedDB
restores the previous chart and marker snapshot immediately, then refreshes changed tiles
individually. A failed replacement keeps the old bitmap. SHA-256 verifies each downloaded
tile against its manifest before storing it. The cache is bounded to 256 tiles / 64 MiB.

**Player records are never collected or exported.** Public markers are a strict allowlist
of ship and NPC positions, with hashed entity identifiers and observation timestamps.
The exporter reads the existing last-known stores rather than querying the game console.
The chart is a daily snapshot, not a live tracking service. Region editing and private
server routes are not included in the public application.

Only the custom Easter Co. mod is downloadable here. Other mods link to their original
publishers. The client manifest and custom mod refresh with the daily data export.

## Daily archive and recovery

The host checkout is `/root/easter-co-smp.github.io`. Install the two units from `ops/` in
`/etc/systemd/system/`, then enable `easter-co-pages.timer`. The service uses the existing
e-server Python environment and existing SSH Git credentials, never repository secrets.

- Daily capture at **05:30 America/New_York**, with up to three minutes of jitter.
- `Persistent=true` plus a boot trigger catches missed runs. An hourly trigger retries
  failures and pushes. Successful retries on the same date do not create extra snapshots.
- If the network is down, the daily snapshot is committed locally. Later runs push the
  entire pending history, preserving each day that this machine actually captured.
- After machine downtime, one current snapshot is captured. `missed_days` records the
  gap; offline days are never reconstructed or falsely backdated.
- The same tile paths and JSON files are overwritten. Git commits archive their previous
  versions; the chart’s World history link opens this history.
- Git fetches are fast-forwarded or unpublished commits rebased over upstream edits.
  Conflicts abort cleanly for manual resolution. The job never force-pushes.
- A single process lock prevents overlapping exports. An export is fully staged and
  validated before installation. Interrupted uncommitted changes in **generated**
  `site/data/` and `site/downloads/` are recovered from the last local commit on retry.
  Changes elsewhere stop automatic publication and are preserved.
- Empty terrain, unreadable chunks, unexpected payload fields, or tile checksum failures
  stop publication and retain the previous live site. The game is never restarted or
  modified, and terrain is never generated.

Manual capture: `/root/e-server/.venv/bin/python scripts/sync.py --force`.
Logs: `journalctl -u easter-co-pages.service`. Timer: `systemctl list-timers easter-co-pages.timer`.

Checks: `python -m unittest discover -s tests -p 'test_*.py'` and
`python scripts/validate.py site`. Browser checks: `node tests/browser.mjs` with a local
preview serving the `site/` directory (`EASTER_PUBLIC_ORIGIN` overrides the origin).

The current site is deliberately small; Git history grows with changed PNGs. Track
repository growth over time. Old snapshots remain in Git rather than being duplicated
into the Pages deployment.

© Easter LTD. Not affiliated with Mojang or Microsoft.
