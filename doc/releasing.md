# Releasing the launcher

How a launcher release is produced and what has to be true before it is published.
Read this before cutting a release; the checks it names are the difference between
a release that reaches players and one that ships a stale or broken app.

## What a release is

The four installers plus `SHA256SUMS` are published as assets on a GitHub Release
tagged `launcher-v<package.json version>`, and `site/downloads.js` requests them by
name from `/releases/latest/download/`. The launcher job is
`.github/workflows/launcher.yml`, which runs on `workflow_dispatch` only.

## Preconditions, all of which must hold

1. `main` is pushed and the working tree is clean.
2. The full check suite passes on that exact tree: `python -m unittest discover -s tests
   -p 'test_*.py'` (use `/root/e-server/.venv/bin/python`), `python scripts/validate.py
   site`, `npm test`, `node tests/drawings.mjs`, `node tests/browser.mjs` against a local
   preview, and `xvfb-run -a node tests/desktop/electron.mjs`.
3. The version in `package.json` is higher than the published one. The tag is derived
   from it, so forgetting this step produces a release that cannot be created.
4. Nothing is being shipped that the app bundles but does not fetch. The packaged app
   carries its own copy of `site/` inside `app.asar`, so the app is only current if it was
   built from the tree being released. `scripts/verify_app_bundle.py` enforces this in the
   workflow and fails the release naming each file that differs.

## Cutting it

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

## Verify after it publishes

    gh release view launcher-v<version> -R Easter-Co-SMP/easter-co-smp.github.io \
      --json tagName,isDraft,isPrerelease,publishedAt,assets

Then confirm, rather than assume:

- The release is not a draft and not a prerelease, and its assets are the four expected
  installer names plus `SHA256SUMS`, with plausible sizes.
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
- CI builds on runners; it does not launch the game, sign in a person, or exercise the
  client download end to end. Say so in the release notes rather than implying it.
