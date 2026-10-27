# Shared wiki: handoff to Delta

Branch: `codex/shared-wiki`, based on `d23cf1a` (launcher 1.0.7).
Owen requested a new branch and explicitly left the merge to Delta.
Do not release from this worktree.

## Result

The shared `site/minecraft/wiki/` UI is linked from Home and Map in the website and launcher.
Six clearly marked demo articles exercise the content model; they specify no new
gameplay rules. One bundled catalogue supplies article text, topic navigation,
full-text search, section links, related links and the overview. There are no
new dependencies, privileged IPC handlers, remote content sources or build steps.

Article and section routes use hashes, including on GitHub Pages and the
launcher's easter:// origin. The mobile topic list and article contents collapse
into compact controls. Search queries remain plain text, including HTML-looking input.

Edit `site/minecraft/wiki/pages.mjs` for real content later. Keep page and section IDs stable
once links are shared. The README documents the catalogue and test commands.

## Frontend review

The designated frontend reviewer completed the final visual and interaction pass
on 2026-10-17. Reviewed the desktop overview and article, launcher article, and
390px and 320px website layouts. Navigation, search, empty/unknown results, related
links, keyboard focus, section jumps and history were exercised in real Chromium.
Demo labeling is visible and there is no home mist on the wiki.

Review screenshots on Easter-Server:
- /tmp/wiki-overview-desktop.png
- /tmp/wiki-article-desktop.png
- /tmp/wiki-overview-390.png and /tmp/wiki-overview-320.png
- /tmp/wiki-article-390.png
- /tmp/wiki-launcher.png

## Validation

Passed on Easter-Server:
- Python unittest discovery: 79 tests; public payload and local-link validation.
- npm test: 86 tests, including catalogue integrity and search tests now in CI.
- New wiki browser suite: direct links, search, safe query text, back/forward,
  section focus, unknown page, desktop and 800/390/320px layouts.
- Existing browser, downloads and map drawings suites.
- Existing full Electron UI suite.
- New real Electron wiki suite, against both the source entry and the packaged
  Linux executable: Home → Wiki, navigation and search with HTTP/HTTPS requests
  blocked, isolated renderer, no Node access.
- Local Linux directory packaging and app.asar/site byte comparison.
- JavaScript syntax checks and git diff whitespace checks.

Browser checks used a local preview on 127.0.0.1:18107.
The wiki suite accepts EASTER_PUBLIC_ORIGIN for that origin.
The Electron wiki suite accepts EASTER_PACKAGED_LAUNCHER to exercise a packaged
executable instead of the source entry.

## Integration and release

Delta owns the merge and release. The main checkout was not edited for this work.
Pushing this feature branch does not publish the site. Merging into main starts
the existing Pages workflow. Existing launcher installations will need a launcher
release that bundles this site to gain the wiki. No version bump, installer
publication or production deployment is part of this branch. Follow
doc/releasing.md when preparing that release.
