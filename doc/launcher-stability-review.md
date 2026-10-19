# Launcher stability review — 2026-10-19

Scope: `desktop/`, its unit tests, download/update flow and release instructions;
reviewed from f1b2a2e in an isolated worktree. No saved account was read and no
production service was restarted. The in-game mod/UI review is separate.

## Fixed

- **Healthy slow downloads failed after three minutes.** The single-file transfer
  armed an idle timer once rather than refreshing it as bytes arrived. It also
  started that timer only after headers, leaving a nonresponding request unbounded.
  The timer now covers headers and resets on each received chunk.
- **Pause and cancel could leave blocked network work running.** A control change
  now informs each active transfer directly: pause suspends its deadline, resume
  starts a fresh inactivity window, and cancel aborts a pending fetch/body read.
  Subscribers are removed on completion. Partial bytes remain available to resume,
  and a cancelled or unverifiable transfer never replaces its destination.
- **Renamed managed files remained installed.** An updated chunk previously recorded
  its new file list without retiring its old files, leaving obsolete mod JARs loadable.
  After all replacement downloads verify, only obsolete files owned by the updated
  chunks are removed. Files another recorded chunk uses and player-added files stay.
  This handles a changed chunk; it does not migrate a chunk removed entirely from
  the published manifest.
- **A game shortcut lost Play across a launcher update.** Relaunch now forwards the
  recognised `--play` switch alongside `--no-sandbox`, retaining the AppImage path
  rule. It forwards no arbitrary command-line values.

## Evidence

- The healthy slow-transfer regression fails against the original install module
  with `TimeoutError` after about 309 ms despite continuous bytes (250 ms test
  inactivity window), and passes after the fix.
- `npm test`: 237 tests pass, none skipped or cancelled.
- `xvfb-run -a node tests/desktop/loopback.electron.mjs`: passes through the real
  Electron main process, with fixture manifests, changed chunks and pause/resume.
- Targeted tests cover unresponsive headers, a stalled body, immediate cancellation,
  pausing a header wait, failed replacement preservation, obsolete managed-file
  retirement, shared/unmanaged-file preservation and Play relaunch on Linux/Windows.

These are synthetic loopback/temporary-directory checks. They do not prove real
Microsoft sign-in, Windows runtime behaviour or a complete live game launch.

## Follow-up risks and design work

- Chunk downloads replace files individually; an interrupted multi-file update is
  repairable by retry, rather than a transaction that rolls back every replacement.
- Installed markers trust previously verified immutable content. Game completeness
  checks do not comprehensively detect later manual deletion/corruption of libraries
  or assets; a player-facing explicit Repair operation would need its own contract.
- Existing minor/major version cleanup deletes the default managed client tree except
  `.easter-client`, `saves/` and `screenshots/`, including options and manually added
  packs. Patch releases preserve these. This review does not change that previously
  specified update policy.
- `main.cjs` combines identity, update orchestration, window lifecycle, IPC and game
  launch. Extracting one operation coordinator with explicit cancellation ownership
  would reduce future race risks; rewriting it without targeted journeys is unsafe.
