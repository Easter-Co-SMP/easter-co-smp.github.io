# Mandatory updates

Launcher and game updates are always enabled. Saved false values and renderer input cannot disable them. Only closing the launcher when Minecraft starts remains a preference.

Packaged startup checks the latest normal GitHub release before checking the game. Checking, download, verification, restart and failure occupy a dedicated startup screen before the Home arrival. Failure blocks installation and Play and offers Retry; it never silently enables an unsupported client. Game manifests are checked on startup for existing installs and again immediately before launch.

Each release publishes a platform/architecture-specific app.asar and update manifest. The manifest pins release version, exact Electron runtime, bootstrap protocol, byte length and SHA-256. Assets come only from this repository's HTTPS release URLs. New application files are streamed to a unique temporary file, bounded by the declared length, hashed, and atomically activated only after complete verification. Updates live beneath the existing per-user application directory, so installed program files and AppImages are not overwritten. Account vaults, preferences and Minecraft files keep their existing paths.

A small installed bootstrap validates the selected payload on each start, loads its main entry, and keeps the installed bundle as a repair fallback. A bad cached payload cannot bypass the online version gate. A required runtime/bootstrap change blocks with a clear reinstall message; it never loads incompatible application code. Routine JavaScript/HTML/CSS/dependency updates need only a payload download and automatic restart.

Relaunch uses the original AppImage path on Linux and the installed executable elsewhere, without a shell or renderer-supplied arguments. The installed bootstrap version must be installed once: 1.0.10 and earlier contain no updater and cannot acquire one automatically.

Unpackaged development and test harnesses use the local tree and do not query the production launcher feed. Production does not accept a test feed or bypass flag. Tests inject the update transport in the updater module and use dedicated Electron harnesses.

## Asking again while the launcher is open (2026-10-23)

Owen: "If the updater is open, every 10 or 15 minutes, or maybe 20, 30, 1 hour? … let's have
the launcher client ping our servers asking 'hey am I still running the latest version?', and
if it's not then it automatically updates and restarts." The startup check answers that
question once, at launch. A launcher left open for six hours used to learn about a release
only by being restarted. It now asks again on its own, and it *stages*: this half only ever
writes a payload to disk. What takes that stage — the apply step, the relaunch and the game it
has to keep alive — is the section after this one (*Applying what was staged, behind a live
game*), so the question can still be proven without the choreography.

**The question is the release's own `/releases/latest` redirect.** One request, no GitHub API
call, no token, redirect not followed, body empty. Measured against the real endpoint on
2026-10-23: `302`, `content-length: 0`, `location:
.../releases/tag/launcher-v1.0.44`, 21–138 ms. Neither the manifest under
`/releases/latest/download/` nor the release page is fetched to answer "is there something
newer?"; the manifest is read — through the same `update()` the startup gate calls — only
when the tag says it is worth reading. Electron cannot express this with `net.fetch`: it
refuses `redirect:'manual'` with *Redirect was cancelled* and follows the redirect otherwise,
so the launcher asks with `net.request({redirect:'manual'})` and takes the hop from the
`redirect` event, aborting the request before any body is read.

**The interval is fifteen minutes, and the reason is that the ask is nearly free.** 96 checks
a day of a header-only 302 is a few hundred kilobytes a year, so the interval is chosen by how
long a player should be left on a broken build rather than by cost: releases are cut by hand,
a handful a week at most, and a quarter of an hour is the shortest wait that is still
invisible to a person using the launcher. Up to 90 s of jitter is added, so a fleet that
started together does not check in lockstep — a synchronised herd is the only thing that could
ever make this request expensive. After consecutive failures the wait doubles and stops at an
hour, and any success returns it to fifteen minutes.

| Bound | Value | Why |
|---|---|---|
| `POLL_INTERVAL_MS` | 15 min | 96 header-only requests a day; the shortest wait that is invisible to a player |
| `POLL_JITTER_MS` | 90 s, added | a fleet does not check in step, which is the only way a 302 becomes expensive |
| `POLL_BACKOFF_CAP_MS` | 1 h | an offline machine asks at most 24 times a day |
| `POLL_BACKOFF_MAX` | 3 doublings | 30 min, 60 min, then the cap |
| `POLL_TIMEOUT_MS` | 15 s | a hop slower than that is not an answer; the next tick is a fresh try |

**It is quiet, and "quiet" is a structural property here, not a promise.** The background
check has no `notify`, no `phase`, no dialog, no spinner and no page notice: a failure, a
timeout or an unreachable network writes exactly one line to `launcher-update.log`
(`step=update-poll outcome=failed … note=ENOTFOUND`) and returns. A check that finds the
launcher current writes nothing at all. A stage writes one line and puts one field on the
state — `launcherUpdate.staged {version, from, stagedAt}` — and sends no broadcast, because a
broadcast repaints and, since every broadcast drops `error`, could take a page notice away
mid-read. A success neither moves `phase` nor touches `canPlay`, `install`, `actions` or the
message.

**A stage is not an activation.** The background check calls `update({apply:false})`: the
manifest is validated, the payload is streamed to a temporary file, hashed against the
manifest's SHA-256, renamed into place and recorded in `launcher-updates/staged.json`. It does
not write `launcher-updates/current.json`, which is the record `bootstrap.cjs` loads on the
next start, and it does not run the version policy's clear. That matters: a background stage
that wrote `current.json` would make a `minor` release activate on the next ordinary start
*without* the cache clear its level asks for, because bootstrap would then load the new bundle
and the startup gate would find nothing newer. The apply step — the version policy, the
activation record and the relaunch — reads that staged record and does all three itself; see
*Applying what was staged, behind a live game* below.

**It cannot delay a launch, and it cannot overlap itself.** The next tick is armed only once
the current check settles, so two checks cannot be in flight; a second request while one is
out is refused rather than queued. Nothing in the launch path waits on it, and its timer is
unref'd, so a pending question is never the reason the process stays alive. `stop()` cancels
the timer and aborts a request in flight, and a cancelled check is not a failure: it writes
nothing and moves no interval. It defers itself — no request at all — while the launcher is at
its startup gate, mid-operation, updating, playing a game or installing one, because the
question must not compete with work the player is waiting for.

**The preference is read, and it is currently pinned on.** `autoUpdateLauncher` off means no
timer and no request at all. `cleanSettings` pins both update preferences to `true`
(*Mandatory update gate* in `launcher-states.md`), so that branch cannot be reached in a
shipped build today and is proven by `tests/desktop/update-poll.test.cjs` rather than by a
journey; the wiring reads `settings.autoUpdateLauncher !== false` so unpinning it later needs
no second change.

**Nothing in the poll restarts anything.** `desktop/updater.cjs` never calls `app.relaunch` or
`app.quit`, and the background section of `desktop/main.cjs` is asserted to contain neither:
the two relaunches in the launcher are the startup gate's own apply step and the apply step
below, which is what takes a stage this section wrote.

## Applying what was staged, behind a live game (2026-10-23)

Owen's design, and his own correction of the first draft of this section: *"the launcher can
update while a game is open, in the background and resume that was a big part of my design."*
So a running Minecraft is **not** a reason to wait. The launcher stages the newer release,
applies it, quits, comes back on the new version and re-adopts the game it left playing — and
the player, in the world, notices nothing except that the launcher is current when they return.

Three things make that true, and they are the whole of the mechanism:

**The client outlives the launcher, deliberately.** `execOptions` in `desktop/install.cjs`
spawns the client `detached` (its own process group and session, so the launcher's exit does
not signal it) and with `stdio:'ignore'` (no pipe the launcher would have to keep servicing
after it is gone; the launcher discards game output anyway). Neither of those is a side
effect: they are the reason a relaunch no longer takes the game down or orphans it.

**The game's identity is written down before anything can restart.** `desktop/game-marker.cjs`
records `{pid, start, startedAt}` in `<data>/running-game.json` the moment the client is
spawned, where `start` is the process's own start time as the operating system reports it —
field 22 of `/proc/<pid>/stat` on Linux, the process creation time through PowerShell on Windows.
A pid alone is not an identity: pids are reused, and "pid 4711 exists" is true of an unrelated
browser an hour later. The marker matches only when the process at that pid started at exactly
the recorded moment. Linux and Windows only, because those are the platforms we publish for
(`AGENTS.md`): anywhere else there is no marker and therefore no adoption, so an unsupported
platform behaves exactly as the launcher did before this existed.

**A restarted launcher reads it back.** `adoptRunningGame()` runs in `whenReady` before the
first broadcast, so the first frame a returning player sees says Minecraft is running instead
of offering Play, and a second Play is refused while that process lives. The launcher has no
child handle on this side of the relaunch, so it watches liveness instead, on a named bound:

| Bound | Value | Why |
|---|---|---|
| `ADOPTED_WATCH_MS` | 2 s on Linux, 5 s on Windows | one `/proc` read is microseconds, and the marker is the only thing that can end a game state; on Windows the same question costs a spawned probe, so it is asked less often |
| `game-marker.PROBE_TIMEOUT_MS` | 4 s | a process question slower than that is answered "unknown", which `adopt` treats as "not the game": coming back to a launcher that guesses wrong is worse than coming back to the ordinary state |

The watch timer is unref'd, and it stops the moment the process is gone. When it goes, the marker
is removed and the launcher settles the sentence a clean exit has always had — *"Minecraft
closed. Ready to play."* — with no exit code invented for a process it did not parent. A marker
that no longer matches its process is removed at startup and the launcher starts in its
ordinary state: never a dead screen.

**The apply step itself.** `applyStagedLauncherUpdate` in `desktop/main.cjs` reads the poll's
own record — `launcher-updates/staged.json` beside `<sha256>.asar` (`updater.stagedState`) —
and never invents a second format or re-downloads. It runs the version policy's clear itself,
before the activation record, in the same order the startup gate uses, so a crash between the
two leaves an unactivated launcher rather than an uncleared one:

| Step | What it does | Why here |
|---|---|---|
| `updater.stagedState` | validates the record and the payload's length, and answers `none`, `stale`, `invalid` or `ready` with the record | a record that can never be applied is discarded, not retried |
| `updater.applyVersionPolicy` | `classify(from, to)` and the clear that level asks for — one `step=update-policy` line | a stage must never activate without its clear |
| `updater.activateStaged` | re-reads, re-validates, hashes the whole payload, writes `current.json`, removes `staged.json` | this is the bytes that run next; the same standard `selected` applies at load time |
| `app.relaunch` + `app.quit` | the new process, with the window's own state as one explicit switch | see the tray rule below |

One quiet line per apply goes to `launcher-update.log` (`step=update-apply … note=applied`,
`note=stale` or `note=invalid`), beside the policy's own decision line. Nothing else is said.

**What an apply still refuses to interrupt.** A *press* that has not settled into a game, a
transfer, a sign-in, an install, or the startup gate itself: `updater.updateMayApplyNow` is the
whole rule in one pure function (`pressInFlight`, `busy`, `phase`), and a game is deliberately
absent from it. A stage that arrives while one of those is live is not lost — it waits, and the
operation that was in the way asks again as it settles (`retryStagedUpdateApply`).

**The tray, and the frame that is not painted.** *"If the launcher was minimized to system tray
it should open in the system tray, not as a regular window and pop up on the screen for a frame
or two."* `relaunchOptions` gains one explicit switch, `--hidden-to-tray` (beside the two
recognised `--no-sandbox` / `--play` it already preserved, and never any other argv), written
only when the window it replaces had stepped aside into the tray. `launchBehaviour` in
`security.cjs` honours it — but only where a tray icon can actually exist:

- **with a tray host**, the relaunch creates the tray icon *before the window exists* and never
  calls `show()`. `visible` is sampled every 10 ms across startup and every sample is false
  (`tests/desktop/update-apply.electron.mjs`); the ordinary relaunch, sampled identically, ends
  visible.
- **with no tray host** (`trayHostAvailable` false: no `org.kde.StatusNotifierWatcher` on the
  session bus, the state of a bare X seat and of Owen's own i3/polybar desktop) the switch is
  **not** honoured and the window comes up as an ordinary window. An invisible launcher with no
  icon is one nobody can reach, which is worse than the single frame the switch exists to avoid.
  This is the same measurement, and it is why `launchBehaviour` answers `stay` here rather than
  `hide`.

**Nothing about a manual update changes.** The startup gate, `update-gate.electron.mjs`,
`bootstrap.electron.mjs`, the version-classification rules and the mandatory-update surface are
exactly as they were; the apply step reuses that surface (`phase:'restarting'` and the sentence
*Restarting launcher…*) when the player is looking at the launcher, and sends no broadcast at
all when the window is in the tray, because a relaunch behind a running game is supposed to be
invisible.


