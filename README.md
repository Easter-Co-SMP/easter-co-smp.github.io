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

A packaged launcher carries its own copy of `site/` inside `release/<platform>-unpacked/`
`resources/app.asar`, so a build made before a site change ships the old interface even
though it installs and starts normally: the launcher-v1.0.0 installer's in-app map legend
still offered the removed player-faction layers. `scripts/verify_app_bundle.py` reads the
ASAR directory with the standard library and compares the bundled text assets (html, js,
mjs, css, json, svg, txt, md, webmanifest and `.nojekyll`, including the generated
`site/data/world.json`) byte for byte against the repository's `site/`, so a bundled
snapshot older than the tree being released fails instead of shipping. Binary imagery
(`.png`, `.jpg`, `.gif`, `.webp`, `.ico`) and `site/downloads/` are reported as deliberately
skipped: they are not what goes stale, and the daily export owns them. With no `release/`
present, as in a fresh clone, it prints that there was nothing to check and exits 0, which
is why the documented unittest command stays green without a build. The launcher release
workflow runs it after the package job's artifacts are merged: every packaged platform the
job uploaded must carry an `app.asar`, and a platform that contributed none fails the job
before anything is published. Pass `--require <platform>-unpacked` by hand to demand one
specific platform.

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
`desktop/config.cjs`, currently the deployed API Gateway host of the accounts HTTP API
(`https://jyjshd22z3.execute-api.us-east-2.amazonaws.com`); set `EASTER_API_BASE_URL` to
override it (HTTPS required, with a loopback exception used by the tests). That hostname is
stable while the stack exists and changes if the stack is destroyed and recreated.

The launcher is download-first. On a fresh machine the hero promotes downloading the game
rather than the launcher: the player picks an installation folder or accepts the default, may
toggle enhanced graphics and shaders, and starts a transfer they can pause and resume while
watching the percentage, the measured speed and the ETA. Play stays unavailable until the
client is installed *and* an account is connected; `canPlay` in the state object is the only
gate. The default installation folder is the app-owned `minecraft` directory under the app
data directory; a folder chosen with the picker is persisted and the client tree is created
there. A folder inside an existing `.minecraft`, inside the launcher's own app data, holding
another launcher, the server or the world, or one the process cannot write is refused with a
message instead of being used. Nothing is ever written into `~/.minecraft`.

Progress follows `doc/launcher-states.md`, the frozen contract between the main process and
the shared UI. Each step reports its own `label` and `percent`; a step whose sizes are known
also reports `bytesDone`, `bytesTotal`, `bytesPerSecond` and `etaSeconds` measured from the
bytes actually observed, and those byte fields stay null for a step whose unit is a count
(asset verification, library installation, Java setup). `percent` is null exactly when the
step has no total. Pausing parks the transfer: no further bytes are fetched, the state reports
`paused: true`, and resuming continues the same transfer. A transfer that is interrupted is
resumable too: the bytes already on disk are kept and the next attempt asks for the rest with
an HTTP Range request, still verifying the whole-file checksum before the file replaces
anything, and discarding a prefix the source did not agree to continue from. An install that is
already present checks the published manifest on launch and applies any difference through the
same pipeline; when nothing differs the check reports nothing at all, so no progress bar
flashes at the player.

The manifest can describe the client as named chunks instead of one blob (`doc/launcher-states.md`,
"Content chunks"). A chunk's version is derived from its content, and the launcher consumes it as
an opaque string: it is compared with what the installed marker records and never parsed, so a
chunk whose recorded version still matches what is published is neither fetched nor re-verified,
and a future version scheme cannot break an installed launcher. An optional chunk is never fetched
while its toggle is off, and a chunk the manifest marks immutable is verified once and then
trusted, so a launch that finds nothing changed performs no content reads at all. Chunk files are still individually checksum verified,
and `installed.json` records each installed chunk's version so "nothing to do" is provable. The
base chunk carries the frozen game and the required mods; enhanced graphics and shaders are the
optional `graphics` chunk, installed only when the toggle is on and the manifest declares it. As
of 2026-10-16 that chunk carries the one shader pack the server's look is built on — Complementary
Unbound r5.9.3, from its publisher's own Modrinth artifact, with the pack version pinned in the
exporter rather than resolved to "latest". A manifest that declares no graphics chunk still
installs normally and reports that nothing extra was published. A manifest with no chunk list stays
valid and keeps working exactly as before.

Where the published manifest and the launcher's own files live is the constant in
`desktop/config.cjs`, overridable with `EASTER_CLIENT_ORIGIN` under the same rule as the API
origin: HTTPS required, with a loopback exception used only by tests, so no real deployment can
be pointed at a plaintext host.

The app installs its own Java 25, Minecraft 26.2, Fabric 0.19.5, the custom mod, and the five
pinned dependencies into its chosen client directory. It does not touch ~/.minecraft or
an existing player's credentials. The default server is the same tailnet address as the drun
shortcut; the launcher does not grant tailnet membership or change server network access.
Java is spawned directly with argument arrays on Windows and Linux, without a shell. Game
logs live in the dedicated client directory. The app remains available for the map while playing.

Build installers: `npm run dist:linux` (AppImage, Ubuntu .deb, Arch .pacman), then
`npm run dist:windows` (.exe; Linux cross-build requires Wine). Output goes to ignored release/.
The Build launcher release workflow builds on native Linux and Windows runners when invoked.
Installers are currently unsigned; publishing a build does not claim Authenticode verification.

Check a packaged build against the repository site with
`python scripts/verify_app_bundle.py` after `npm run pack` (or after either dist command),
which reports every bundled text asset it compared, what it skipped and why, and exits
non-zero naming each file that differs. Add `--require win-unpacked` to make a platform
expected by a release fail when it produced no `app.asar`.

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
Playwright plus an X display: `xvfb-run -a node tests/desktop/accounts.electron.mjs`. The
download-first flow has its own coverage: `tests/desktop/flow.test.cjs` runs in `npm test`
and proves the Play gate, the installation-location refusals, the throughput estimator
against a fake clock, pause/resume/cancel and the checksum gate against a loopback stub
server that serves bytes slowly, and the update check against fixture manifests.
`tests/desktop/chunks.test.cjs` proves the chunk rules against fixtures and loopback stub
servers: a repeat run fetches no chunk and re-hashes nothing, a new graphics chunk is fetched
alone with the base chunk untouched, an optional chunk is never fetched while its toggle is
off, an interrupted transfer resumes with a Range request instead of restarting the file, and
a corrupted prefix is discarded rather than trusted. `xvfb-run -a node
tests/desktop/flow.electron.mjs` drives the real main process and asserts the state object it
broadcasts for a fresh run, sign-in, download, pause, resume, cancel, a completed install, a
quiet update check and the location handlers. `xvfb-run -a node
tests/desktop/loopback.electron.mjs` runs the real launcher, with no stub harness, against a
loopback server publishing a fixture manifest and chunk payload through `EASTER_CLIENT_ORIGIN`,
and asserts that only the changed chunk is fetched and that its transfer pauses, resumes and
verifies. The
packaged-bundle guard has its own fixture tests in `tests/test_app_bundle.py`, which build
minimal ASARs in a temporary directory rather than reading `release/`, so they hold with or
without a build.

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

## Shared wiki

`site/wiki/` is the same bundled wiki in the website and Electron launcher, with no
separate desktop content or network dependency. Its six initial articles are explicitly
labelled demonstration content, not authoritative game instructions.

Edit `site/wiki/pages.mjs` to maintain articles. Each has a stable id, title, group,
summary, sections (stable ids, text, optional list and map link), and related article ids.
The same catalogue supplies the overview, sidebar, full-text search, related links and
table of contents. Hash routes such as `wiki/#/ships-and-sailing` and
`wiki/#/ships-and-sailing/before-you-sail` work on GitHub Pages and the launcher's
`easter://` origin without server routing. Search URLs are shareable too.
Content ships with the launcher, so existing installations need a new launcher build
to receive it. This change does not create a release.

Wiki checks: `node --test tests/wiki.test.mjs`, `node tests/wiki-browser.mjs`
(with the local preview origin in `EASTER_PUBLIC_ORIGIN`), and
`xvfb-run -a node tests/desktop/wiki.electron.mjs`. The browser and Electron checks
cover search, navigation, deep links, narrow layouts and the bundled offline wiki.
