# Releasing the launcher

How a launcher release is produced and what has to be true before it is published.
Read this before cutting a release; the checks it names are the difference between
a release that reaches players and one that ships a stale or broken app.

## What a release is

The four installers, platform-specific app-file payloads/manifests, and `SHA256SUMS` are published as assets on a GitHub Release
tagged `launcher-v<package.json version>`, and `site/downloads.js` requests them by
name from `/releases/latest/download/`. The launcher job is
`.github/workflows/launcher.yml`, which runs on `workflow_dispatch` only.

## Preconditions, all of which must hold

1. `main` is pushed and the working tree is clean.
2. The full check suite passes on that exact tree: `python -m unittest discover -s tests
   -p 'test_*.py'` (use `/root/e-server/.venv/bin/python`), `python scripts/validate.py
   site`, `npm test`, `node tests/drawings.mjs`, `node tests/browser.mjs` against a local
   preview, `xvfb-run -a node tests/desktop/electron.mjs`,
   `xvfb-run -a node tests/desktop/company.electron.mjs` (the Company identity journey
   against the real account handler and PostgreSQL: signup with the username chosen before
   the password, username sign-in, wrong-provider rejection, matching Microsoft reconnect
   and a password reset that goes through a linked provider — this one needs the fixture
   below, and fails without it), `xvfb-run -a node tests/desktop/accounts.electron.mjs`
   (the account transport and vault: the exact public account shape the renderer receives,
   the proof path, no credential in the renderer, the safeStorage rule and logout
   revocation — it starts its own loopback stub and needs no fixture),
   `xvfb-run -a node tests/desktop/launcher-identity-conflict.electron.mjs` (the identity
   conflict through the real preload: the refusal code crosses the isolated world, the
   chooser comes back with the account service's sentence, and the signed-in account is
   unchanged — the browser suite drives a stub bridge and cannot see this),
   `xvfb-run -a node tests/desktop/ownership.electron.mjs` (the ownership gate on the one
   signed-in account: sign-in without Java Edition lands on Buy Now and never on Play, the
   store link is Minecraft's own, a direct Play IPC call cannot bypass the gate, the
   profile-required and service-outage rechecks each offer their own action, Play appears
   once access is owned, and revoked access refuses to start the cached profile),
   `xvfb-run -a node tests/desktop/deslop.electron.mjs` (no slop in the UI on the one-account
   model: one action per screen, no second route to the Map, Settings only once there is a
   client, a launcher update check withholds Settings and closes its dialog, the header names
   the one signed-in account, nothing in the profile menu offers Add account or Switch
   Account, and signing out returns the signed-out copy), and
   `xvfb-run -a node tests/desktop/readiness-gate.electron.mjs` (unreachable and unknown
   game status never invoke Java or wake, leave Play as the retry, and a ready retry
   starts exactly one game), and
   `xvfb-run -a node tests/desktop/shortcuts.electron.mjs` (the game shortcuts: both
   entries created and removed in an isolated HOME, and the auto-start path driven
   through the real main process), and
   `xvfb-run -a node tests/desktop/wait-post-approval.electron.mjs` (the promise Owen hit
   in 1.0.30: once Microsoft's approval is consumed the dialog stops asking for the code
   and shows the current stage, and a long wait shows the ten-second reassurance. It needs
   its own fixture instance on 18798 — `EASTER_API_FIXTURE_PORT=18798`, same procedure as
   below — because it holds the account call open for thirteen seconds through a proxy of
   its own; without one it fails early on an unreachable account service), and
   `xvfb-run -a node tests/desktop/providers.electron.mjs` (provider linking end to end
   against the real account handler: Discord signup, the mandatory username and password,
   Google linking, display-name and picture editing, the encrypted fixture restart,
   password login and Discord password recovery. It needs its own fixture instance on 18797
   started WITH `EASTER_PROVIDER_FIXTURE=1`, which is the only thing that serves the
   provider stub; the exact commands are under "The provider journey needs its own
   fixture" below. Until 2026-10-19 this journey was absent from this list and could not be
   run from this document at all, which is how provider linking shipped unexercised).
3. The version in `package.json` is higher than the published one. The tag is derived
   from it, so forgetting this step produces a release that cannot be created.
4. Nothing is being shipped that the app bundles but does not fetch. The packaged app
   carries its own copy of `site/` inside `app.asar`, so the app is only current if it was
   built from the tree being released. `scripts/verify_app_bundle.py` enforces this in the
   workflow and fails the release naming each file that differs.

## The fixture `company.electron.mjs` needs

That journey signs a synthetic player up end to end, so it drives the **real** account
handler and real SQL rather than a stub: `tests/launcher_api_fixture.py` in
`/root/easter-co-cloud`, on loopback 18796, with the disposable PostgreSQL behind it. None
of it touches AWS, and none of it is optional — without the fixture the journey fails
early on an unreachable account service, and the failure reads like a launcher bug.

Start it, from the cloud repository, before running the journey:

    # 1. the disposable PostgreSQL the handler stores into, on 127.0.0.1:15439
    #    (container identity-fixture-pg, image postgres:17, trust auth, loopback only)
    docker start identity-fixture-pg
    docker exec identity-fixture-pg pg_isready -U postgres   # "accepting connections"

    # 2. the fixture API itself, on 127.0.0.1:18796
    cd /root/easter-co-cloud
    PYTHONPATH=/root/easter-co-cloud \
      EASTER_API_FIXTURE_PORT=18796 \
      .venv/bin/python tests/launcher_api_fixture.py

    # 3. the journey, from this repository, with the fixture running
    xvfb-run -a node tests/desktop/company.electron.mjs

The three facts that make it work, and the details that bite:

- **Ports.** 18796 is the fixture's API port (`EASTER_API_FIXTURE_PORT` overrides it), and
  the journey defaults to `EASTER_API_BASE_URL=http://127.0.0.1:18796`. Set
  `EASTER_FIXTURE_ORIGIN` on the journey to use a separately started fixture instead
  of a stale or occupied default port. 15439 is the
  disposable PostgreSQL's port, and the fixture hard-codes it, not a variable.
- **`PYTHONPATH` must be the cloud repository**, because the fixture imports `api.*` from
  it. Run it with that repository's `.venv/bin/python`, which is where `pg8000` lives; a
  bare `python` fails on the import before it opens a socket. `/root/e-server/.venv/bin/python`
  is the interpreter for *this* repository's `tests/`, not for the fixture.
- **The PostgreSQL on 15439 must be running** before the fixture starts: it connects as
  `postgres` on `database=postgres` at import time and the process exits if it cannot.
- Each fixture process creates its own database (`company_launcher_<pid>`), applies every
  migration to it and drops it on exit. That is deliberate — a shared database makes the
  second run fail on the previous run's account — so run one fixture at a time, and expect a
  second one on the same port to fail to bind rather than to share.
- The fixture keeps that database for the life of the process, which is why the journey
  claims a fresh `fixture_<token>` username per run: re-running against a long-lived
  fixture would otherwise be refused a name it already holds.
- `EASTER_PROVIDER_FIXTURE=1` adds the Google/Steam/Discord provider stub and
  `EASTER_FIXTURE_LOG=1` prints one line per request. Neither is needed for
  `company.electron.mjs`; the first is what a journey that links a non-Microsoft provider
  needs.

### The provider journey needs its own fixture

`providers.electron.mjs` is the one journey that needs `EASTER_PROVIDER_FIXTURE=1`, and it
needs it on **18797**, not 18796. Run it like this, from a clean start:

    docker start identity-fixture-pg
    docker exec identity-fixture-pg pg_isready -U postgres   # "accepting connections"

    cd /root/easter-co-cloud
    PYTHONPATH=/root/easter-co-cloud \
      EASTER_API_FIXTURE_PORT=18797 \
      EASTER_PROVIDER_FIXTURE=1 \
      .venv/bin/python tests/launcher_api_fixture.py

    # in this repository, with the fixture running
    xvfb-run -a node tests/desktop/providers.electron.mjs

Add `EASTER_FIXTURE_LOG=1` to the fixture for one line per request; that is how a request
sequence gets settled when a journey fails.

Three ways this bites, all measured on 2026-10-19:

- **Run it alone.** This journey fails when other Electron or xvfb suites are running at
  the same time. One run failed while three other agents were starting worktrees and
  browser suites, and the two runs immediately afterwards passed alone — a fresh fixture
  plus an immediate run also passed. A failure here while anything else is using Chromium
  or Xvfb is contention, not a product fault; re-run it by itself before diagnosing.
- **The port matters.** Start the fixture on the default 18796 and the journey fails at its
  first click against nothing, which reads exactly like a launcher bug. 18796 is
  `company.electron.mjs`'s port, and the two cannot share one because each fixture process
  makes and drops its own database.
- **The sign-in limiter is durable and shared.** `easter.auth_limits`, key
  `ip:fixture-electron`, allows 60 account requests per 10 minutes and guards
  `/v2/accounts/microsoft`, `/v2/accounts/password/login` and `/v2/accounts/password`. One
  run of `company.electron.mjs` spends about six of those, so repeated runs inside ten
  minutes end in a correct `429` and a launcher sentence that looks like a product failure.
  The mint budget is separate and smaller per account (30 per 10 minutes), and a 1.0.33
  launcher spends one per password sign-in, one per Microsoft sign-in and one per Play
  press. Because each fixture process creates its own database and drops it on exit, the
  limiter resets when you restart the fixture — so a journey that starts failing after a
  few green runs is asking you to restart the fixture, not to debug the launcher.

The other Electron journeys need no fixture. `accounts.electron.mjs` starts its own
loopback stub and reads the account shape from it; `electron.mjs`, `flow.electron.mjs`,
`launcher-identity-conflict.electron.mjs`, `ownership.electron.mjs`, `deslop.electron.mjs`
and `shortcuts.electron.mjs` use their own harnesses. The exception is
`wait-post-approval.electron.mjs`, which is the one journey needing a real fixture instance
of its own (18798) with no harness around it. The browser, waits and drawings
suites need only the static preview of `site/` (run them from the repository root, and note
that `tests/waits-browser.mjs` reads `EASTER_PUBLIC_ORIGIN`, which is how it is pointed at
18100 rather than its own default port):

    python -m http.server --directory site 18100

`ownership.electron.mjs` and `deslop.electron.mjs` were the two journeys the account
clean-up left driving the removed Add/Switch Account UI; they are re-authored against the
one-account model (see the account state contract in `doc/launcher-states.md`) and both are
green, so a red one of them is a real regression rather than a stale test.

## Cutting it

Update `doc/launcher-release-notes.md` for the version being released; the workflow
copies that file into the published release notes.

    # 1. the version bump is a real commit, not a local edit
    #    package.json: "version": "1.0.2"
    git commit -am "Release launcher <version>" && git push origin main

    # 2. dispatch the workflow (there is no tag trigger)
    gh workflow run launcher.yml --ref main
    gh run list --workflow=launcher.yml --limit 1
    gh run watch <run-id>

The job builds on a native Linux runner and a native Windows runner, packages the
installers, checks the bundle against the repository, verifies that all four required
installer names exist and are referenced by `site/downloads.js`, writes `SHA256SUMS`
over exactly those four, and publishes the release with generated notes.

## Do not publish it as a prerelease

`/releases/latest` ignores prereleases. While `launcher-v<version>` is the only
release, marking it prerelease makes `/releases/latest/download/` unresolvable and
breaks all four download buttons at once. The workflow does not pass `--prerelease`
and there is a comment there saying why.

## Line endings are pinned, and the bundle check depends on it

`.gitattributes` pins every text type the bundle check compares to LF, and
`tests/test_line_endings.py` enforces the pin. Keep both. The Windows installer is
built on a Windows runner, where Git's default `autocrlf` rewrites LF to CRLF on
checkout, so the Windows `app.asar` would carry CRLF copies of all 14 `site/` text
assets and `verify_app_bundle.py` would fail on a bundle that is not stale at all.
That is what stopped launcher-v1.0.2 run 38835252575: `site/index.html` had 46 CRLF
pairs, `desktop.js` 311 and `data/world.json` 2134, and each size difference equalled
its CRLF count exactly while the Linux bundle matched. If the bundle check ever fails
with every text asset listed and no binary one, check line endings before rebuilding.

## The Arch package states its own dependencies

electron-builder's default dependency list for the `pacman` target is not installable on
Arch. It names `http-parser`, which the repositories dropped, and `libappindicator-gtk3`,
which left them, and nothing in the packaged app links either one. launcher-v1.0.5 shipped
that default list, so `sudo pacman -U` refused the download outright:

    warning: cannot resolve "http-parser", a dependency of "easter-company-launcher"
    error: failed to prepare transaction (could not satisfy dependencies)

`build.pacman.depends` in package.json now states the libraries the shipped binaries actually
link, and `tests/test_pacman_depends.py` fails if that list is deleted or if a name known to
be gone reappears. To check a built package, read its metadata and confirm every name still
resolves:

    bsdtar -xOf release/*.pacman .PKGINFO | grep depend
    pacman -Sp --print-format '%n' <those names>

The `deb` target needs no equivalent: Ubuntu 24.04 and Debian 13 renamed `libgtk-3-0` and
`libatspi2.0-0` to t64 builds, but the new packages `Provides:` the old names, so the
dependencies already listed still resolve.

## The game shortcuts an installed launcher offers

An installed launcher can put two entries on the machine from its own Settings dialog: a
desktop shortcut and a Start menu entry. **Both run the launcher, never Minecraft.**
Each one passes the single argument `--play`, and the launcher then applies its mandatory
launcher update, its client update gate and its account/access checks before it starts a
game, honouring the player's launch-behaviour setting — stay open, close behind the game,
or minimise to the tray — exactly as pressing Play does. That is deliberate: a shortcut
that started the client directly would skip the updater and the access checks.

| Platform | Desktop shortcut | Start menu entry |
|---|---|---|
| Linux | `~/Desktop/easter-co-game.desktop` | `~/.local/share/applications/easter-co-game.desktop` |
| Windows | `Easter Co. Game.lnk` on the shell's desktop | `Easter Co. Game.lnk` in the per-user Start menu |
| macOS | not offered, and said so in the dialog | not offered |

Both preferences default to off, so nothing is written until the player ticks a switch,
and saving the dialog is the only thing that creates or removes an entry.

**What the uninstaller removes, and what it does not.** The installers create the
launcher's own shortcut ("Easter Co. Launcher": the NSIS `createDesktopShortcut` with
`shortcutName`, and the packaged `easter-company.desktop` for the deb and pacman
packages), and that is what an uninstall removes, along with the installed files. The two
game entries are a different thing: the launcher writes them later, in the user's own
directories, at the player's request. **The uninstaller removes neither of them**, because
it has no record of a file written after it ran, and it keeps the launcher's data
directory (Windows: `deleteAppDataOnUninstall` is off), which is where the saved
preference lives. So an uninstalled launcher can leave "Easter Co. Game" entries behind,
pointing at a binary that is no longer there. The removal path the launcher owns is the
dialog: untick both switches before uninstalling. Reinstalling with the preference still
saved does not recreate the files on its own — entries are created on a settings save, and
the reopened dialog says plainly that a ticked entry is not on the computer.

**macOS is not supported and a release must not claim it is.** Electron's shortcut API is
a Windows feature, and an alias the launcher wrote would not survive the launcher's own
update path, so the two switches are hidden there and the dialog states why. Everything
about the entries is exercised on Linux; the Windows `.lnk` details and the macOS refusal
are covered by their pure builders and by the platform rule, not by a run on those
machines.

**Nothing about an account goes into an entry.** A shortcut file carries the launcher's
path, `--play`, its own name, the launcher's comment, the icon path and the launcher's
marker, and nothing else: no token, no account id, no client path and no log line.
`npm test` (`tests/desktop/shortcuts.test.cjs`) pins the contents and that absence, and
`tests/desktop/shortcuts.electron.mjs` reads both files back after creating them.

## Verify after it publishes

    gh release view launcher-v<version> -R Easter-Co-SMP/easter-co-smp.github.io \
      --json tagName,isDraft,isPrerelease,publishedAt,assets

Then confirm, rather than assume:

- The release is not a draft and not a prerelease. It carries four installers, Linux/Windows
  x64 `.asar` payloads and matching `.json` manifests, plus `SHA256SUMS`, with plausible sizes.
- Each of the four `/releases/latest/download/` URLs resolves. Use a ranged GET, not
  `HEAD`: the redirect chain behaves differently for HEAD and a 404 there is a false alarm.
- `sha256sum -c SHA256SUMS` passes against freshly downloaded files, and the bytes match
  the local `release/` artifacts.
- The live site serves a `downloads.js` whose names match the published assets.
- The AppImage actually runs (chmod it first: a browser download lands non-executable,
  and an AppImage without the execute bit produces an opaque error).

## What a release does not prove

- Windows installers are unsigned, so a SmartScreen warning is expected. Running the
  installer on real Windows is a separate, manual step that CI does not perform.
  It has been done once, on 2026-10-16: Owen installed v1.0.4 on Windows and it ran
  smoothly up to the sign-in modal. Everything past that point - the client
  download, a real Microsoft approval, playing the game - has still only ever been
  exercised on Linux with fixtures.
- CI builds on runners; it does not launch the game, sign in a person, or exercise the
  client download end to end. Say so in the release notes rather than implying it.
- The game shortcuts are proven on Linux, in an isolated HOME, with a stubbed client and
  account. A real desktop's own icon-permission behaviour, a real Windows Start menu and a
  real macOS desktop are not covered, and the two entries are not removed by any
  uninstaller this repository builds.
