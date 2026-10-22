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

1. `main` is pushed and the working tree is clean — and it is the `main` you think
   it is. Cut from `origin/main` after a `git fetch`, and confirm the fixes you
   intend to ship are actually ancestors of it:

       git fetch && git log --oneline -1 origin/main
       git merge-base --is-ancestor <sha-you-expect> origin/main && echo "in"

   Three releases on 2026-10-19 were cut from a branch that predated merged work:
   1.0.32 shipped without the hero fix Owen had reported, and 1.0.34 shipped with
   neither the server-status LED nor the cold-start retry fix — so the launcher a
   player installed still failed on the first cold Lambda, and the version number
   was already spent. A release cut from a stale branch is worse than a late one.
1a. **The packaged build runs, and its first screen paints.** This is the one check
   that no unit, browser or Electron journey performs, and it is where 1.0.36 shipped a
   bug that every other gate passed: the home cards greeted a first launch with
   "Dispatches unavailable" because the renderer's first read arrived before its frame
   was trusted, which main refuses by design and records nowhere. The unpackaged app was
   fine; only the package was wrong. Before bumping the version:

       npm run pack                                   # ~2 min, writes release/*-unpacked
       rm -rf /tmp/packcheck && mkdir -p /tmp/packcheck
       Xvfb :84 -screen 0 1280x800x24 &
       DISPLAY=:84 HOME=/tmp/packcheck EASTER_TEST_HOME=/tmp/packcheck \
         ./release/linux-unpacked/easter-company --no-sandbox &
       sleep 12 && DISPLAY=:84 import -window root /tmp/packcheck/first-screen.png

   Look at the image: the header, the client card and every block that loads data on the
   home screen, with no "unavailable" sentence over a thing that works. An empty HOME is
   the point — it is the first launch a new player gets. Repeat for any change that adds a
   start-up IPC read: `handle()` refuses an untrusted frame, so a read can be refused once
   and has to be warmed in main or retried by the renderer.
2. The full check suite passes on that exact tree: `python -m unittest discover -s tests
   -p 'test_*.py'` (use `/root/e-server/.venv/bin/python`), `python scripts/validate.py
   site`, `npm test`, `node tests/drawings.mjs`, `node tests/browser.mjs` against a local
   preview, `xvfb-run -a node tests/desktop/electron.mjs`,
   `xvfb-run -a node tests/desktop/company.electron.mjs` (the Company identity journey
   against the real account handler and PostgreSQL: signup with the username chosen before
   the password, signing in again with the same Microsoft identity after signing out and
   landing in that same account with no second setup step, username sign-in, wrong-provider
   rejection, matching Microsoft reconnect
   and a password reset that goes through a linked provider — this one needs the fixture
   below, and fails without it), `xvfb-run -a node tests/desktop/accounts.electron.mjs`
   (the account transport and vault: the exact public account shape the renderer receives,
   the proof path, no credential in the renderer, the safeStorage rule and logout
   revocation — it starts its own loopback stub and needs no fixture),
   `xvfb-run -a node tests/desktop/company-username.electron.mjs` (the username journey,
   against its own loopback stub that speaks the frozen account contract and records every
   request body: the signed-out hero asking for the Easter Company account with no Company
   ID anywhere, Microsoft signup with no username landing on step 1, the availability
   probe's taken and policy refusals each keeping the player on step 1 and writing nothing,
   the username chosen before the password in one call, a lost race walking back to step 1
   with the typed name kept, username or email sign-in, the verified login email saved,
   re-read, cleared and kept across a restart, a password change that reauthenticates
   through the provider linked to the account, and Play appearing only once the account is
   ready — it starts its own stub and needs no fixture. It was absent from this list until
   2026-10-19, and that is how two of its expectations drifted from the product unnoticed:
   the signed-out hero's sentence, and the username-policy refusal, which the product
   reworded in 1.0.27 when capitals started being folded instead of refused while the
   journey kept the older words),
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
   signing out and back in with the same linked Discord identity to the same account id with
   no second username or password step and no second account, Google linking, display-name
   and picture editing, the encrypted fixture restart,
   password login and Discord password recovery. It needs its own fixture instance on 18797
   started WITH `EASTER_PROVIDER_FIXTURE=1`, which is the only thing that serves the
   provider stub; the exact commands are under "The provider journey needs its own
   fixture" below. Until 2026-10-19 this journey was absent from this list and could not be
   run from this document at all, which is how provider linking shipped unexercised), and
   `xvfb-run -a node tests/desktop/bootstrap.electron.mjs` (the launcher's own update
   payload: a downloaded ASAR is hashed, installed beside the running app and started, and
   the process that answers is the verified payload rather than the one that downloaded
   it), and
   `xvfb-run -a node tests/desktop/flow.electron.mjs` (the state object the real main
   process broadcasts: the frozen field list, every phase, the Play gate, pause, resume,
   cancel, the location handlers, a completed install and a quiet update check — the
   contract `site/` renders, asserted where it is produced instead of in a stub), and
   `xvfb-run -a node tests/desktop/integration.electron.mjs` (the download-first flow end
   to end through the real main process and the real renderer: the during-download hero
   asking for the Easter Company account, sign-in while a transfer runs and what it does to
   that transfer, an install completing under a pending device code, Play gated on both
   halves, and the sticky bar following the player to the Map. It was outside this list
   until 2026-10-19, which is why its hero assertion was still written against the
   Microsoft-only sentence that 5c9c853 had already replaced), and
   `xvfb-run -a node tests/desktop/loopback.electron.mjs` (the real launcher, no stub
   harness at all, against a loopback client origin: the display defaults and key binds it
   writes on a first run and leaves alone on a second, a manifest fetch, the one changed
   chunk applied with byte progress that pauses and resumes, the detected hardware and
   graphics answer, the enhanced-graphics toggle in both directions, and the migration of
   the settings file this box actually carries), and
   `xvfb-run -a node tests/desktop/minecraft-head.electron.mjs` (the Minecraft head a
   password sign-in still shows — the letter tile Owen reported — and what a refused read
   leaves behind: the head is read once from the account's own uuid through Mojang's public
   endpoints, reaches the header as a data URL and is painted, and no credential is in the
   read), and
   `xvfb-run -a node tests/desktop/server-session.electron.mjs` (the server-held Microsoft
   session across four launches: a password sign-in that reaches Play with no prompt, the
   one-time hand-over that leaves no refresh token in the vault, the same account signing in
   on a second machine, one `reauth_required` fallback instead of a loop, and Sign out of
   Minecraft everywhere), and
   `xvfb-run -a node tests/desktop/update-gate.electron.mjs` (the mandatory update gate: the
   arrival waits for it, Play, sign-in and download are refused until it finishes, Escape
   cannot dismiss it, a failed launcher or game check starts nothing, a failed retry leaves
   Play off and a successful one restores it, and there is no opt-out control), and
   `xvfb-run -a node tests/desktop/wiki.electron.mjs` (the wiki the launcher bundles, served
   from its own `easter://` origin with no network read: all twelve articles, search, deep
   links and a narrow window; `EASTER_PACKAGED_LAUNCHER` points the same journey at a
   packaged build), and
   `xvfb-run -a node tests/desktop/cold-start.electron.mjs` (a cold account service: a
   dropped connection, an API Gateway timeout and a declared `database_unavailable` recover
   behind "Checking your Minecraft session…" in one press without the hero ever showing the
   busy verdict, a 429 and a declared configuration fault give the existing "Try again"
   sentence with one request each and recover on the hero's own Try again, and signing out
   during an open mint ends it and discards the answer that lands afterwards).

   That is every Electron journey in `tests/desktop` except one: `electron.mjs` and the
   twenty `*.electron.mjs` files, of which ten were named here before 2026-10-19, eight were
   added that day and `cold-start.electron.mjs` on 2026-10-19 with the retry policy. None of
   the nine needs a fixture: each starts its own stub, harness
   or payload, and none of them reads 18796–18798 (the detail is under "The other Electron
   journeys need no fixture"). The nine that had been left out were left out silently, and
   one of them (`integration.electron.mjs`) was red for weeks because of it. Measured on
   2026-10-19, run one at a time on this machine: each of the eighteen finishes in 4 to 36
   seconds (the fastest, `bootstrap.electron.mjs`, in 3.6) and the eighteen together take
   about three minutes (191–193 seconds across two sweeps), with the three fixture instances'
   own start-up on top. That is not a reason to check a release by hand instead.

   **`ui-review.electron.mjs` is deliberately not on this list.** It is a design-review
   pass, not a gate: it drives the launcher at several widths and writes screenshots to
   `EASTER_REVIEW_IMAGES` for a person to look at, and what it asserts about behaviour is
   already asserted here by `electron.mjs`, `deslop.electron.mjs` and
   `launcher-identity-conflict.electron.mjs`. It has also been red intermittently for a
   notice-band race that ticket 80bf173e owns; all three of its runs on 2026-10-19 passed,
   which is exactly what an intermittent failure looks like. A required check that fails at
   random teaches people to skip required checks. Run it when the frontend reviewer asks for
   it, and read its images.

3. The version in `package.json` is higher than the published one. The tag is derived
   from it, so forgetting this step produces a release that cannot be created.
4. Nothing is being shipped that the app bundles but does not fetch. The packaged app
   carries its own copy of `site/` inside `app.asar`, so the app is only current if it was
   built from the tree being released. `scripts/verify_app_bundle.py` enforces this in the
   workflow and fails the release naming each file that differs.
5. The live client payload gate passes: `node tests/live/client-payload.mjs` twice, on a
   fresh root and then on the same root (see "The live client payload gate" below). It is
   the only check in this repository that touches what is actually published, so run it
   before a release that changes `site/data/client.json`, any file it names, or the client's
   own content. It is not part of `npm test`, and must not be: it needs the public network,
   about 1 GB of free space and several minutes.

## The live client payload gate

Precondition 5 is one command, run by hand against the public origin, that answers the
question no other check here answers: **can the launcher download the client, every intended
mod and the graphics payload from what is published right now?** Everything else in this
repository runs against a stub, a loopback origin or a prepared tree.

    node tests/live/client-payload.mjs     # 1st run, fresh root: downloads the payload
    node tests/live/client-payload.mjs     # 2nd run, same root: proves it is quiet
    node tests/live/client-payload.mjs --self-check   # offline: every refusal ends FAIL

It takes no arguments. The origin is `https://easter-co-smp.github.io/` — a positional URL or
`EASTER_LIVE_ORIGIN` points it at a staging page — and the tree it installs into is
`/var/tmp/easter-live-payload`, overridable with `--root <folder>` or `EASTER_LIVE_ROOT`. The
persistent root is why it is built this way: the first run proves the download, and the second
proves that a finished tree costs nothing.

It refuses, deliberately: a folder that already holds files and carries no `.easter-client`
marker (the launcher's own app-owned-tree rule, so it can never adopt somebody's directory), a
second run while one is in progress (it holds `<root>.lock`), an origin that is not HTTPS
outside loopback, and a published manifest with no graphics chunk — there it stops and says
so rather than passing the half of the gate that has nothing to drive.

Every way it can stop — the normal path, an early stop, and a refusal to start at all — ends
in one summary line whose verdict and exit code come from the same failure count, so a
refusal can never print PASS. `--self-check` pins that: it drives four refusal paths offline
(a root another run holds, a folder the gate did not create, an origin that is not a URL, and
an origin nothing answers on) and asserts each one exits non-zero with exactly one verdict
line saying FAIL.

**Do not run it beside an Electron journey.** It pulls about half a gigabyte and takes
minutes; a concurrent suite competes for the same network and disk.

### What it proves

Every item is a check in the script and the phase name in the output says which one.

- **manifest** — the live `data/client.json` still pins minecraft 26.2 and fabric 0.19.5, and
  the three chunks still have the shape the contract freezes (`doc/launcher-states.md`,
  "Content chunks"): `base` 6 files, required and immutable; `graphics` 4 files, optional;
  `visuals` 9 files, required and immutable.
- **install** — a fresh root installs through the real `installClient`, with the toggle off
  and a `{vramMB:8188,tier:'capable'}` profile, and reports "Client ready." with version id
  `26.2-fabric0.19.5`.
- **chunk files** — all 15 files the required chunks declare are present with their declared
  size and their declared sha256/sha512; the 4 optional graphics files are asserted *absent*
  while the toggle is off; the install marker records exactly the manifest's files and
  nothing else.
- **game** — `versions/26.2-fabric0.19.5/26.2-fabric0.19.5.json` parses with mainClass
  `net.fabricmc.loader.impl.launch.knot.KnotClient` and `inheritsFrom` 26.2; the
  `net.fabricmc:fabric-loader:0.19.5` library is named; `versions/26.2/26.2.jar` is installed;
  the asset index parses, the objects on disk equal the index's own entries and every object
  it names is present; and the Mojang runtime the launcher installed
  (`runtime/java-runtime-epsilon`) reports `openjdk version "25.0.1"` when executed.
- **graphics on** — the toggle fetches exactly the optional chunk's bytes and no other
  chunk's; all four files match their hashes; `config/iris.properties` says
  `enableShaders:true`, `shadowDistance:12` and names the shader pack the chunk itself
  delivered (read from the chunk's own `shaderpacks/*.zip` name, never from a constant);
  `options.txt` carries `renderDistance:16`, the top rung of `QUALITY_LADDER` for the profile
  the gate passes; and `mods/easter-grassier-grass.jar` is the activated, byte-equal copy of
  `optional-mods/grassier-grass.jar.disabled`.
- **mods** — every jar in `mods/` is a whole zip: every entry is inflated and its CRC checked
  against the central directory. Every `fabric.mod.json` require resolves against the
  installed set counted together with the jar-in-jar modules in `META-INF/jars`, and each
  top-level require edge is printed with what resolved it. Two of the shipped metadata files
  are not strict JSON — entity model features and entity texture features carry a raw newline
  inside a description string — so the gate reads those the way Gson, and therefore Fabric,
  reads them, and names them in its output rather than calling a mod that loads broken. The
  gate also runs the blind checks
  a naive reader makes, so the nesting is proven load-bearing rather than assumed: reading
  only `mods/*.jar` reports 21 ids missing today, a reader that lets each jar see only its own
  nested modules reports 2, and 5 requires are satisfied only by fabric-api's nested modules.
- **graphics off** — 0 bytes fetched, 0 hashes read, `enableShaders:false`, the activated
  foliage jar removed, and the shader pack and the `.jar.disabled` cache kept for the next
  enable.
- **quiet install** — a second install over the finished tree fetches 0 bytes, reads 0 hashes,
  reports unchanged, and leaves `options.txt`'s mtime and bytes untouched.
- **player edit** — a simulated player edit (`renderDistance:8`, crouch moved to left alt)
  survives the next install pass, which does not write `options.txt` at all.

Any failed check exits non-zero, and the run ends with a phase table and one summary line per
install. The gate pins the numbers it was measured with and prints a `DRIFT` line when the
*published payload* has moved under it — a mod republished, a shader pack updated. A drift is a
finding to read and confirm, never a reason to edit a pin to match; the checks that fail the
gate are about behaviour.

### The 2026-10-22 measurement

Measured on this household server against `https://easter-co-smp.github.io/data/client.json`.
The gate's own two runs, which are the numbers a re-run should be read against — byte counts
are stable, durations are that day's network:

    # first run, fresh root (exit code 0)
    summary install (fresh root)  "Client ready."  508,051,649 bytes · 5073 hash reads · 3m 7s
    summary graphics on            7,595,639 bytes · 351 ms · ComplementaryUnbound_r5.9.3.zip
    summary graphics off           0 bytes · 7 ms
    summary second install         "Client ready."  0 bytes · 0 hash reads · 2 ms
    summary player-edit pass       0 bytes · 1 ms
    summary downloaded this run     515,647,288 bytes (491.8 MB)
    gate PASS · 154 checks · none failed · 2 recorded numbers drifted from the 2026-10-22 measurement

    # second run, same root (exit code 0)
    summary install (same root)  "Client ready."  0 bytes · 0 hash reads · 4 ms
    summary graphics on            0 bytes · 3 ms · ComplementaryUnbound_r5.9.3.zip
    summary graphics off           0 bytes · 5 ms
    summary second install         "Client ready."  0 bytes · 0 hash reads · 2 ms
    summary player-edit pass       0 bytes · 1 ms
    summary downloaded this run     0 bytes
    gate PASS · 152 checks · none failed · 1 skipped · 2 recorded numbers drifted from the 2026-10-22 measurement

The single skipped check on the second run is the one that asserts the optional graphics files
are absent: the first run's payload is still on disk, and switching the toggle off keeps it
there by design. The fresh root is where that assertion belongs.

The run above started 02:08:01 and answered "Client ready." at 02:11:08 — 3 min 7 s for the
same 508 MB. Across the runs made while writing this gate that one install took 3 min 7 s,
4 min 0 s, 6 min 3 s and 6 min 16 s, and the hand measurement this gate was written from took
3 min 8 s (05:09:09 → 05:12:17): the duration is the network's, not the payload's. The byte
counts are what a later run should be read against. What every one of those runs establishes:

- 15 non-optional files and 4 optional ones, every one matching its declared size and hash.
  The graphics chunk is 7,595,639 bytes of files.
- 5,057 asset objects, equal to the asset index's own entry count, every one on disk.
- `openjdk version "25.0.1"` from `runtime/java-runtime-epsilon`, the runtime Mojang ships.
- 15 jars in `mods/`, all zip-integrity clean, 84 require edges (65 of them declared by
  jar-in-jar modules) and none unresolved.
- 732 MB on disk after the first run; the second run adds nothing to it.

Three of the hand-measured numbers the gate cannot reproduce are printed as drifts rather than
adopted, and are recorded here so a later reader is not surprised:

- **7,631,839 bytes for the graphics chunk** matches no published graphics payload: the chunk
  has declared 7,595,639 bytes in every manifest since 2026-10-19 (5,260,588 before that), and
  the toggle fetches exactly that. The gate asserts the invariant — the bytes fetched equal
  the bytes the chunk declares — and pins the declared total.
- **45 nested modules in fabric-api**: the jar carries 44 `META-INF/jars/*.jar` entries. A
  text listing also prints the `META-INF/jars/` directory, which is the 45th line and is not a
  module.
- **"a check that ignores nested jars reports 5 missing"** is reproduced exactly as the set of
  requires only fabric-api's nested modules satisfy: fabric-block-getter-api-v2,
  fabric-command-api-v2, fabric-rendering-fluids-v1, fabric-resource-loader-v0 and
  fabric-resource-loader-v1. That is the figure the gate pins; the two blunter blind checks
  report 21 and 2, and all three are printed.

### What it does not prove

- **That the client renders, or even starts.** The game is never launched, so a mod that is
  present, whole and dependency-satisfied can still crash the client at load.
- **That a sign-in works.** No account, token or session is involved anywhere in this gate.
- **That Windows or macOS behave the same.** It ran on Linux x64 with Mojang's linux runtime.
- **That the `fabric.mod.json` version predicates are satisfiable.** The ids are resolved and
  every edge is printed with its predicate, but the predicate itself is not evaluated; Fabric
  does that when the client loads.
- **Anything about the server** — its mod set, the world, the wake path — or about the
  launcher's Play, account and update paths.
- **That a player sees the same bytes.** The gate passes the manifest it read into the install,
  so its own run is one consistent snapshot; a change at the origin between two runs is not
  something it can see.

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

Four ways this bites, all measured on 2026-10-19 and 2026-10-20:

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
- **`page.waitForFunction` with an async predicate waits for nothing.** The account service
  answers a sign-in a moment after Microsoft's browser flow ends, so a journey that waits
  for the account has to poll. Measured 2026-10-20 on Playwright 1.61.1: a predicate written
  as `()=>window.easterDesktop.status().then(s=>s.account!==null)` resolved immediately
  while `status()` still reported `account: null`, and the assertion two lines later read a
  null account — which looks exactly like a product fault and is not one. Poll
  `status()` in a bounded loop with a failure message instead. `company.electron.mjs` and
  `providers.electron.mjs` did this on 2026-10-20; a bare `waitForFunction` over
  `window.easterDesktop.status()` anywhere in a journey asserts nothing.

The other Electron journeys need no fixture. `accounts.electron.mjs` starts its own
loopback stub and reads the account shape from it, and `company-username.electron.mjs`
does the same and drives the whole username flow against it; `electron.mjs`,
`flow.electron.mjs`, `launcher-identity-conflict.electron.mjs`, `ownership.electron.mjs`,
`deslop.electron.mjs`, `shortcuts.electron.mjs` and `update-gate.electron.mjs` use their own
harnesses. Six more bring their own loopback server or build their own payload rather than
using a harness, and none of them reads 18796–18798: `integration.electron.mjs` runs the
flow harness over its own account stub, `minecraft-head.electron.mjs` stubs the two Mojang
endpoints it reads through `head-harness.cjs`, `server-session.electron.mjs` serves its own
account routes through `server-session-harness.cjs`, `loopback.electron.mjs` starts a
loopback client origin and runs the real `desktop/main.cjs` with no harness at all,
`bootstrap.electron.mjs` builds its own ASAR payload with `@electron/asar`, and
`wiki.electron.mjs` needs nothing but an X display. The exception is
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
- The live client payload gate ("The live client payload gate" above) proves the published
  client, every declared mod, the game's own files and the enhanced graphics toggle install
  and verify against the real origin. It never starts the game, so it says nothing about
  whether the client renders, loads every mod or reaches the server, and nothing about a
  sign-in.
