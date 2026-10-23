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
only by being restarted. It now asks again on its own, and it *stages* — it does not restart.
The restart choreography, the deferral while a game runs and the tray-hidden relaunch are a
separate ticket, so this half can be proven alone.

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
activation record and the relaunch — stays where it is, on the startup gate, and the staged
record is what a restart ticket reads to reach it.

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

**Nothing here restarts anything.** `desktop/updater.cjs` never calls `app.relaunch` or
`app.quit`, and the background section of `desktop/main.cjs` is asserted to contain neither:
the only relaunch in the launcher remains the startup gate's own apply step.

