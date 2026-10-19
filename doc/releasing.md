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
   unchanged — the browser suite drives a stub bridge and cannot see this), and
   `xvfb-run -a node tests/desktop/shortcuts.electron.mjs` (the game shortcuts: both
   entries created and removed in an isolated HOME, and the auto-start path driven
   through the real main process).
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
  the journey is hard-wired to `EASTER_API_BASE_URL=http://127.0.0.1:18796`. 15439 is the
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

The other Electron journeys need no fixture. `accounts.electron.mjs` starts its own
loopback stub and reads the account shape from it; `electron.mjs`, `flow.electron.mjs`,
`launcher-identity-conflict.electron.mjs` and `shortcuts.electron.mjs` use their own
harnesses. The browser and drawings suites need only the static preview:

    python -m http.server --directory site 18100

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
