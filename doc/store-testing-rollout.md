# Mock store testing rollout — 2026-10-20

Owen authorized merging and deploying the mock store for production testing and
sharing. This supersedes the earlier handoff that left merge/release with Delta.
Real payments and in-game fulfilment remain disabled.

The independent frontend reviewer approved commit `37007c6` for a mock-store
release. Review covered desktop/mobile store journeys, all five product categories,
checkout consent and failure recovery, the 24 shared-home layout cases, the quiet
profile status, and an additional 320×568 keyboard/focus/submit-lock/no-network
check. This is frontend approval, not proof of successful publication.

Pre-merge validation on that tree:

- 303 Node tests and 104 Python tests passed; site validation passed.
- Public-site/launcher browser suite and map-drawing browser suite passed.
- The basic Electron journey and all 17 self-contained required Electron journeys
  passed using original tests and a runtime import mapping to the installed
  Playwright. No assertions or checks were disabled.
- Production dependency audit: zero vulnerabilities.
- Linux unpacked application built from checksum-verified Electron 44.7.2; all
  34 bundled site text assets matched the source byte for byte.

Launcher publication remains gated by this execution environment:

- The actual packaged first screen rendered, but its mandatory updater stopped
  with `net::ERR_CERT_AUTHORITY_INVALID`; the home document was also unavailable.
  The production-like startup gate is therefore not passed. Certificate/TLS
  verification and mandatory updates were kept enabled.
- This instance rejects GitHub API and the public site proxy requests. Network
  additions for `api.github.com` and `easter-co-smp.github.io` are saved in the
  environment draft but need application/publication in environment settings.
- The three required cloud-fixture journeys (Company, providers and post-approval
  wait) are unrun. Their `/root/easter-co-cloud` source cannot be read here, and
  the fixture PostgreSQL/API instances need to be made available before running
  them. Do not mark them passed or silently replace them with stubs.

The package version is deliberately unchanged. Do not tag or dispatch a launcher
release until the packaged-startup and remaining fixture gates are resolved.
Once they pass, follow `doc/releasing.md`: bump an unused version, publish the
native-platform installers/update payloads, and verify the live downloads.
