# Launcher UI overhaul — Delta handoff

Branch: `codex/launcher-ui-overhaul`
Base: `24fa2cd`
Reviewed: 2026-10-18

## Result

Home now uses a compact, static crest and control panel over the existing harbour. It has one primary action; the idle dock is omitted on Home, while transfers stay available on every page and idle launch actions remain on Map and Wiki. The desktop stylesheet has been replaced with one coherent set of shell, dialog, form, profile and dock rules.

Settings has aligned preference switches, collapsed advanced fields, one keyboard-submittable Save action, a folder shortcut and version. Account management lives in the profile popover, with separate Microsoft and company identity labels. The launcher preference says “Check for launcher updates” because in-place launcher updating is not implemented.

Microsoft authentication has its own pending/device-code dialog. Escape, close and Cancel abort it without revealing Settings or discarding an existing account. Account mutations are disabled during authentication or gameplay.

Errors appear in the active dialog or a dismissible page notice. A typed, sanitised `error` field carries background operation and asynchronous game-process failures. Cancellation is not treated as failure. Settings remain usable while Minecraft runs; saving changes the next launch configuration, not the running process. Graphics changes remain disabled during play.

The state contract was updated before the implementation. Existing shared website, Map and Wiki content is preserved.

## Verification

- 89 Node unit/catalogue tests.
- 79 Python tests; public export/site validation.
- Browser suite: website, map and desktop state/rendering/keyboard/responsive flows.
- Website download platform/instruction checks and drawing tools suite.
- Electron suites: standard UI, account add/switch/logout, main/UI integration, state contract, accounts API loopback, real transfer loopback and bundled Wiki.
- Added `tests/desktop/ui-review.electron.mjs`: pending/device authentication cancellation, single idle Home action, visible/dismissible launch errors, asynchronous child failure, Enter-to-save, Settings during play, account action locks, aligned switches, Home sizing, compact Settings and utility-page errors.
- Linux unpacked Electron package built locally; bundled `site/` checked against repository files.
- Visual inspection in real Electron: first run and ready at 1360×920 and 800×600; pending/device sign-in, transfer/failure, Settings default/advanced, profile and Wiki. Narrow sign-in and renderer layouts also exercised by existing suites.

Review screenshots remain on Easter-Server under `/tmp/launcher-ui-after/`. Reproduce with:
```sh
xvfb-run -a node tests/desktop/ui-review.electron.mjs
```

## Release boundary

Prepared for Delta to merge. No version bump, release, deployment, service restart, installed-launcher change or live game change is part of this branch. Authentication and game execution use dedicated fixtures in these tests; no real player credentials were used. This host has no usable OS keyring, so the secure-storage refusal path was exercised. Windows packaging remains a release-runner check.
