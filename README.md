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

The launcher installers are distributed through GitHub Releases. Third-party client mods
are downloaded directly from their publishers during setup. The client manifest and custom
Easter Co. mod refresh with the daily data export.

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

## Shared website and desktop launcher

Run `npm ci`, then `npm start`. The same site/ UI runs in the browser and in Electron;
only the isolated preload enables desktop mode. The browser shows platform downloads;
desktop mode shows Sign in & Play, account state, installation progress, and client settings.
Map annotations, terrain cache, and UI preferences persist in the desktop session too.
The shell bundles the site so its interface opens without a web connection. Map data refreshes
from Pages, with the bundled snapshot and persistent tile cache as fallbacks.

Microsoft device-code login follows the existing drun shortcut's consumers → Xbox Live →
XSTS → Minecraft Java profile chain. Tokens never cross IPC or enter web storage. OS-backed
safeStorage encrypts remembered accounts; Linux basic_text is rejected and the UI explicitly
shows This session only when secure storage is unavailable. Sign-out deletes this app's session.
The inherited public client ID currently displays **Prism Launcher** in Microsoft's consent UI,
just like the existing shortcut. Set EASTER_MICROSOFT_CLIENT_ID to an Easter Company
registration approved for Minecraft/Xbox access when available; no secret belongs in the app.

Easter Company account enrolment rides on that same Microsoft session: the Mojang access
token the launcher already holds is posted to `POST /v1/accounts/login`, and the first
successful call creates the account while every later one signs in. The returned session
lives in its own safeStorage vault (`company.enc` in app data) under the same rules as the
Microsoft session, so `basic_text` is refused there too. Signing out revokes it with
`POST /v1/accounts/logout` and deletes it locally whether or not the revocation is reachable.
Only the account name, its roles and the session's expiry reach the renderer: no token, UUID
or response body crosses IPC, and every cloud call happens in the main process behind the
origin-checked handlers with a bounded timeout. The API origin is the constant in
`desktop/config.cjs`; set `EASTER_API_BASE_URL` to override it (HTTPS required, with a
loopback exception used by the tests). The account API is not deployed yet, so a real
sign-in currently reports that the account service could not be reached and keeps the
Microsoft session usable; nothing else depends on it.

The app installs its own Java 25, Minecraft 26.2, Fabric 0.19.5, the custom mod, and the five
pinned dependencies into its app-data/minecraft directory. It does not touch ~/.minecraft or
an existing player's credentials. The default server is the same tailnet address as the drun
shortcut; the launcher does not grant tailnet membership or change server network access.
Java is spawned directly with argument arrays on Windows and Linux, without a shell. Game
logs live in the dedicated client directory. The app remains available for the map while playing.

Build installers: `npm run dist:linux` (AppImage, Ubuntu .deb, Arch .pacman), then
`npm run dist:windows` (.exe; Linux cross-build requires Wine). Output goes to ignored release/.
The Build launcher release workflow builds on native Linux and Windows runners when invoked.
Installers are currently unsigned; publishing a build does not claim Authenticode verification.

Checks: `npm test` (desktop unit and fixture tests), `npm run test:desktop`
(`xvfb-run -a node tests/desktop/electron.mjs`, which launches the packaged shell under a
temporary app home), `node tests/drawings.mjs`, and `node tests/browser.mjs`. The browser and
Electron checks need a local preview of `site/` and use the host's existing Playwright
installation. Auth tests use fixture identities; no test reads an existing account cache or
signs in a person. The Electron harness is excluded from packages. `tests/desktop/*.test.cjs`
includes the account client against a local stub server (unreachable API, `401
invalid_minecraft_token`, a malformed body and a create-then-login pair) and the vault's
refusal of `basic_text`. `node tests/desktop/accounts.electron.mjs` additionally drives real
Electron against a loopback stub through `EASTER_API_BASE_URL`, and needs the host's
Playwright plus an X display: `xvfb-run -a node tests/desktop/accounts.electron.mjs`.

Verified on this machine on **2026-10-15**: `python -m unittest discover -s tests -p 'test_*.py'`,
`python scripts/validate.py site`, `npm test` (10 desktop tests), `node tests/drawings.mjs`,
`xvfb-run -a node tests/desktop/electron.mjs`, and `node tests/browser.mjs` against a local
preview all pass. The Linux AppImage, Ubuntu `.deb`, and Arch `.pacman` builds and the Windows
`.exe` were built locally with electron-builder at 17:27–17:28 on that date and are unsigned.

Two limits remain, and this repository cannot settle either one. The Windows `.exe` was
cross-built on Linux, so its runtime behaviour is unverified until it is installed and
launched on Windows. Interactive Microsoft sign-in opens a real approval prompt in a browser
and requires a user session on the target platform. A clean automatic install was exercised
once in `/tmp/easter-company-clean-install` on that date, including real Java and publisher
downloads; that path is a scratch directory outside this repository, so the run is not
reproducible from a fresh clone and is recorded here as history, not as a standing check.

## Personal map notes

Draw opens a separate palette: brush, line, square, rectangle, circle, triangle, diamond,
eraser, colour, stroke width, undo/redo, and visibility. All geometry and stroke widths are
stored in world blocks in the dedicated easter-co-personal-map IndexedDB database. They
stay aligned while zooming, panning, resizing, and reloading. Erasing removes a touched
stroke/shape and can be undone. Middle-drag always pans, never draws or edits notes.
Drawings are private to the browser profile; they are not shared with other players, synced
between computers, or included in the daily map archive. Clearing browser data removes them.
