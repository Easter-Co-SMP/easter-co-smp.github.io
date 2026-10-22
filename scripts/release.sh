#!/usr/bin/env bash
# Cut and verify a launcher release. Never type the bump, the dispatch or the asset checks
# by hand: doc/releasing.md is the checklist this script performs, and every step it owns
# exists because a hand-run release skipped it once.
#
#   ./scripts/release.sh --check                     # preconditions and fast suites only
#   ./scripts/release.sh --cut 1.0.39 --notes FILE   # bump, notes, suites, package, publish, verify
#   ./scripts/release.sh --verify launcher-v1.0.38   # verify an already published release
#
# --cut, in order:
#   1. --check: clean tree, on main, level with origin/main, package.json and
#      package-lock.json agreeing on the current version.
#   2. npm test, the python suites, and the site validator.
#   3. npm run pack, then scripts/check-packaged-first-screen.mjs against that package:
#      the packaged artifact's first screen and its Play Now stage, with isolated HOMEs.
#   4. Bump the current version to the new one in package.json and in both package-lock
#      fields, prepend the notes file as the release section, commit and push.
#   5. `gh workflow run launcher.yml --ref main`, then watch it to a conclusion.
#   6. --verify the tag the workflow published.
#
# --verify <tag>, on a published release:
#   * the release exists, is not a draft and is not a prerelease (/releases/latest skips
#     prereleases, so a prerelease means every download button 404s);
#   * every asset downloads and every SHA256SUMS line checks out;
#   * the AppImage extracts and its app.asar matches the repository's site/ byte for byte,
#     and so do both update-payload ASARs;
#   * the AppImage's own first screen paints from an isolated HOME.
#
# Nothing here talks to a host other than GitHub and the files it publishes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
cd "$root"
python="${PYTHON:-python3}"
tag_prefix="launcher-v"

die() { echo "release: $*" >&2; exit 1; }
usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

current_version() { node -p "require('./package.json').version"; }
lock_version() { node -p "require('./package-lock.json').version"; }
lock_root_version() { node -p "require('./package-lock.json').packages[''].version"; }

check_tree() {
  [[ -z "$(git status --porcelain)" ]] || die "the tree is dirty; a release is cut from a clean tree"
  [[ "$(git branch --show-current)" == "main" ]] || die "not on main ($(git branch --show-current))"
  git fetch --quiet origin main
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not level with origin/main; push or pull first"
  local a b c
  a="$(current_version)"; b="$(lock_version)"; c="$(lock_root_version)"
  [[ "$a" == "$b" && "$b" == "$c" ]] || die "versions disagree: package.json=$a package-lock=$b packages['']=$c"
  echo "  ok   clean main at $(git rev-parse --short HEAD), version $a"
}

run_check() {
  echo "release: preconditions"
  check_tree
  echo "release: fast suites"
  npm test >/tmp/release-npm-test.log 2>&1 || { tail -20 /tmp/release-npm-test.log; die "npm test failed"; }
  grep -E "^ℹ (tests|pass|fail)" /tmp/release-npm-test.log | sed 's/^/  /'
  "$python" -m unittest discover -s tests -p 'test_*.py' >/tmp/release-python.log 2>&1 || { tail -20 /tmp/release-python.log; die "the python suites failed"; }
  grep -E "^Ran|^OK" /tmp/release-python.log | sed 's/^/  /'
  "$python" scripts/validate.py site >/tmp/release-validate.log 2>&1 || { tail -20 /tmp/release-validate.log; die "scripts/validate.py site failed"; }
  echo "  ok   scripts/validate.py site"
}

verify_release() {
  local tag="$1" work
  work="$(mktemp -d -t easter-release-verify.XXXXXX)"
  trap 'rm -rf "$work"' RETURN
  local json
  json="$(gh release view "$tag" --json tagName,isDraft,isPrerelease,assets)"
  echo "$json" | "$python" -c '
import json,sys
r=json.load(sys.stdin)
assert not r["isDraft"], "the release is a draft"
assert not r["isPrerelease"], "the release is a prerelease: /releases/latest ignores those and every download button 404s"
names=[a["name"] for a in r["assets"]]
for required in ("SHA256SUMS","Easter-Company-Linux-x86_64.AppImage","Easter-Company-Windows-x64.exe",
                 "Easter-Company-Update-linux-x64.asar","Easter-Company-Update-win32-x64.asar",
                 "Easter-Company-Update-linux-x64.json","Easter-Company-Update-win32-x64.json"):
    assert required in names, "missing asset "+required
print("  ok   %s carries %d assets, none a draft or prerelease" % (r["tagName"], len(names)))
'
  local base="https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/download/$tag"
  mkdir -p "$work/dl"
  ( cd "$work/dl" && curl -sSfL --max-time 300 -O "$base/SHA256SUMS" ) || die "SHA256SUMS did not download"
  ( cd "$work/dl" && while read -r sum name; do
        curl -sSfL --max-time 600 -o "$name" "$base/$name" || { echo "download failed: $name" >&2; exit 1; }
    done < SHA256SUMS ) || die "an asset did not download"
  ( cd "$work/dl" && sha256sum -c SHA256SUMS >/tmp/release-sha.log 2>&1 ) || { tail -10 /tmp/release-sha.log; die "sha256sum -c failed"; }
  echo "  ok   every asset matches SHA256SUMS (ranged GET, not HEAD)"
  # The AppImage, and both update payloads, must carry this tree's site/ byte for byte.
  local check_dir
  for pair in "Easter-Company-Linux-x86_64.AppImage:appimage" \
              "Easter-Company-Update-linux-x64.asar:asar" \
              "Easter-Company-Update-win32-x64.asar:asar"; do
    local asset="${pair%%:*}" kind="${pair##*:}"
    check_dir="$work/check-${asset//[^A-Za-z0-9]/_}"
    mkdir -p "$check_dir/linux-unpacked/resources"
    if [[ "$kind" == "appimage" ]]; then
      chmod +x "$work/dl/$asset"
      ( cd "$work" && "$work/dl/$asset" --appimage-extract >/dev/null 2>&1 ) || die "$asset did not extract"
      cp "$work/squashfs-root/resources/app.asar" "$check_dir/linux-unpacked/resources/app.asar"
      rm -rf "$work/squashfs-root"
    else
      cp "$work/dl/$asset" "$check_dir/linux-unpacked/resources/app.asar"
    fi
    "$python" scripts/verify_app_bundle.py --release-dir "$check_dir" >/tmp/release-bundle.log 2>&1 \
      || { tail -15 /tmp/release-bundle.log; die "$asset does not carry this tree's site/"; }
    echo "  ok   $asset carries this tree's site/ byte for byte"
  done
  # And the published AppImage paints its first screen.
  chmod +x "$work/dl/Easter-Company-Linux-x86_64.AppImage"
  EASTER_RELEASE_BINARY="$work/dl/Easter-Company-Linux-x86_64.AppImage" \
    xvfb-run -a node scripts/check-packaged-first-screen.mjs --app "$work/dl/Easter-Company-Linux-x86_64.AppImage" >/tmp/release-first-screen.log 2>&1 \
    || { tail -20 /tmp/release-first-screen.log; die "the published AppImage failed the first-screen check"; }
  grep -E "PASS" /tmp/release-first-screen.log | tail -1 | sed 's/^/  /'
  echo "release: PASS - $tag is published, hashed and carries this tree"
}

cut_release() {
  local version="$1" notes="$2"
  [[ -f "$notes" ]] || die "notes file not found: $notes"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--cut needs a plain X.Y.Z version (got '$version')"
  local current
  current="$(current_version)"
  [[ "$current" != "$version" ]] || die "package.json is already $version"
  run_check
  echo "release: packaged build (npm run pack, ~2 min)"
  npm run pack >/tmp/release-pack.log 2>&1 || { tail -20 /tmp/release-pack.log; die "npm run pack failed"; }
  echo "release: packaged first screen"
  xvfb-run -a node scripts/check-packaged-first-screen.mjs >/tmp/release-first-screen.log 2>&1 \
    || { tail -25 /tmp/release-first-screen.log; die "the packaged build failed the first-screen check"; }
  grep -E "PASS" /tmp/release-first-screen.log | tail -1 | sed 's/^/  /'
  echo "release: bumping $current -> $version and writing the notes"
  node -e '
const fs=require("fs");
const version=process.argv[1];
const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); pkg.version=version;
fs.writeFileSync("package.json",JSON.stringify(pkg,null,2)+"\n");
const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));
lock.version=version; if(lock.packages&&lock.packages[""]) lock.packages[""].version=version;
fs.writeFileSync("package-lock.json",JSON.stringify(lock,null,2)+"\n");
' "$version"
  local section="/tmp/release-section.md"
  { echo "# Easter Company launcher $version"; echo; cat "$notes"; echo; echo; } > "$section"
  cat "$section" doc/launcher-release-notes.md > /tmp/release-notes.md
  mv /tmp/release-notes.md doc/launcher-release-notes.md
  git add package.json package-lock.json doc/launcher-release-notes.md
  git commit -q -m "Launcher $version" -m "Release notes prepended; package.json and package-lock.json bumped together."
  git push origin main
  echo "release: dispatching launcher.yml"
  gh workflow run launcher.yml --ref main
  local run_id
  for _ in $(seq 1 30); do
    run_id="$(gh run list --workflow launcher.yml --limit 1 --json databaseId,headSha --jq '.[0].databaseId')"
    [[ -n "$run_id" ]] && break
    sleep 4
  done
  [[ -n "$run_id" ]] || die "no workflow run appeared"
  gh run watch "$run_id" --exit-status >/tmp/release-workflow.log 2>&1 || { tail -25 /tmp/release-workflow.log; die "the release workflow failed (run $run_id)"; }
  echo "  ok   workflow run $run_id concluded successfully"
  verify_release "${tag_prefix}${version}"
}

action=""
version=""
notes=""
tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) action="check"; shift ;;
    --cut) action="cut"; version="${2:-}"; shift 2 ;;
    --notes) notes="${2:-}"; shift 2 ;;
    --verify) action="verify"; tag="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
case "$action" in
  check) run_check; echo "release: CHECK PASS" ;;
  cut) [[ -n "$notes" ]] || usage; cut_release "$version" "$notes" ;;
  verify) [[ -n "$tag" ]] || usage; verify_release "$tag" ;;
  *) usage ;;
esac
