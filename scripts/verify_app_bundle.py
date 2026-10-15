"""Verify that a packaged launcher carries the repository's current site/.

Electron packages site/ into release/<platform>-unpacked/resources/app.asar. `npm start`
reads site/ from the working directory instead, so a stale bundle is invisible to every
other check in this repository: on 2026-10-15 a launcher-v1.0.0 installer shipped with a
site snapshot from an older commit, and its in-app map legend offered player-faction
layers that the current site had already replaced.

This script reads the ASAR directory directly with the standard library. No dependency,
no `npx asar`. The header is nested pickles, so the byte layout of a real build is:

    bytes 0-3    payloadSize  little-endian uint32, 4: the first pickle holds one uint32
    bytes 4-7    headerSize   little-endian uint32, the length of the whole header object
    bytes 8-11   innerSize    little-endian uint32, the length of the second pickle payload
    bytes 12-15  jsonLength   little-endian uint32, the JSON string length, padded
    bytes 16-    the JSON header {"files": {...}}, whose entries carry "size" and "offset",
                 jsonLength - 5 bytes of JSON followed by 4 bytes of padding
    contents     start at 8 + headerSize + offset

Measured on the real build in this repository, and confirmed rather than assumed:
payloadSize 4, headerSize 175060, innerSize 175056, jsonLength 175051, the JSON text spanning
bytes 16..175066, four padding bytes at 175051+16, and content at 175068 == 8 + headerSize. At
that base all 676 entries match the SHA-256 each one declares for itself; at 175067 and at
175064 only 1 of 676 does. The integrity hashes, not the arithmetic, are what settle the base,
and they settle it on 8 + headerSize.

A bundle whose numbers do not agree is reported unreadable, never silently passed.

WHAT IS COMPARED, byte for byte, against the repository's site/:

  * every text asset the bundle carries: .html .js .mjs .css .json .svg .txt .md
    .webmanifest .nojekyll, at any depth under site/.
  * site/data/world.json and the other generated data files. They are compared on
    purpose: a bundle is expected to be built after "npm run ci" and after the daily
    export, so a mismatch means the bundle is older than the tree being released. The
    daily snapshot is refreshed by scripts/sync.py with its own commit, and the launcher
    job builds from the checkout, so a routine days-old snapshot is not what this check
    sees. If a legitimate daily update does fail a release, rebuild the package; the
    snapshot is generated data, and re-running electron-builder is the fix, not editing
    this list.
  * every entry the bundle carries under site/, so a path that exists in only one of the
    two is reported loudly instead of skipped.

WHAT IS DELIBERATELY SKIPPED (and printed as such):

  * binary imagery: .png .jpg .jpeg .gif .webp .ico (the map tiles, crest and favicon).
  * site/downloads/: third-party archives and jars, including the mod jar.
  * anything else with a suffix outside the text list above.

A fresh clone has no release/ (it is gitignored), so this script exits 0 and prints that
there was nothing to check. That keeps `python -m unittest discover -s tests -p
'test_*.py'` green without a build. Every packaged platform directory that exists must
hold an app.asar: one without it is reported and fails the run, so a platform that was
supposed to be built cannot pass unnoticed. --require names additional platform
directories that must be present, for a caller that knows which platforms to expect.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]

#: Text assets inside the bundle that are compared byte for byte. Suffixless names are
#: matched exactly; everything else by suffix.
TEXT_SUFFIXES = {'.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.webmanifest'}
TEXT_NAMES = {'.nojekyll'}

#: Skipped on purpose, and reported by name in the summary.
SKIPPED_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.jar', '.zip', '.exe',
                    '.deb', '.pacman', '.AppImage', '.blockmap', '.icns'}
SKIPPED_PREFIXES = ('site/downloads/',)


class BundleError(Exception):
    """The bundle could not be read. Never treated as a pass."""


def is_text_asset(relpath):
    """Return True when a bundled site path must be compared byte for byte."""
    if relpath.startswith(SKIPPED_PREFIXES):
        return False
    return Path(relpath).suffix.lower() in TEXT_SUFFIXES or Path(relpath).name in TEXT_NAMES


def skip_reason(relpath):
    """Return why a bundled site path is not compared, or None when it is compared."""
    if relpath.startswith(SKIPPED_PREFIXES):
        return 'third-party downloads are not copied into the repository'
    suffix = Path(relpath).suffix.lower()
    if suffix in SKIPPED_SUFFIXES:
        return f'binary {suffix} imagery or archive'
    return 'not a text asset'


def parse_manifest(asar_path):
    """Return (header, content_base, raw_bytes) for an ASAR file, or raise BundleError.

    The JSON header is located by parsing the nested pickle lengths and then confirmed
    against where the JSON text actually starts, so a bundle with inconsistent numbers is
    refused instead of being read at a wrong offset.
    """
    asar_path = Path(asar_path)
    try:
        raw = asar_path.read_bytes()
    except OSError as error:
        raise BundleError(f'{asar_path}: cannot read file: {error}') from error
    if len(raw) < 16:
        raise BundleError(f'{asar_path}: file is {len(raw)} bytes, too short to hold an ASAR header')
    payload_size, header_size = struct.unpack('<II', raw[:8])
    if payload_size != 4:
        raise BundleError(f'{asar_path}: unexpected first pickle payload size {payload_size}; only '
                          f'the standard "files" header layout is supported')
    if header_size > len(raw):
        raise BundleError(f'{asar_path}: header size {header_size} is larger than the {len(raw)} '
                          f'byte file; the bundle is truncated')
    inner_size, json_length = struct.unpack('<II', raw[8:16])
    if inner_size > header_size or json_length > inner_size or json_length < 4:
        raise BundleError(f'{asar_path}: the header lengths do not agree (header {header_size}, '
                          f'pickle {inner_size}, JSON {json_length}); the bundle is corrupt')
    if 16 + json_length > len(raw):
        raise BundleError(f'{asar_path}: the header declares a {json_length} byte JSON string, '
                          f'which does not fit a {len(raw)} byte file; the bundle is truncated')
    if raw[16:17] != b'{':
        raise BundleError(f'{asar_path}: expected the ASAR header JSON at offset 16 but found '
                          f'{raw[16:20]!r}; the bundle is corrupt')
    text = raw[16:16 + json_length].decode('utf-8', errors='replace')
    try:
        header, end = json.JSONDecoder().raw_decode(text)
    except ValueError as error:
        raise BundleError(f'{asar_path}: the ASAR header is not readable JSON: {error}') from error
    if not isinstance(header, dict) or not isinstance(header.get('files'), dict):
        raise BundleError(f'{asar_path}: the ASAR header has no "files" directory tree')
    if end > json_length:
        raise BundleError(f'{asar_path}: the ASAR header JSON is {end} bytes, longer than the '
                          f'declared {json_length}; the bundle is corrupt')
    # Member offsets are relative to the end of the whole header object, 8 + headerSize.
    # The JSON text itself is padded, so this is not where the JSON text ends.
    content_base = 8 + header_size
    if content_base >= len(raw):
        raise BundleError(f'{asar_path}: content starts at {content_base}, past the end of a '
                          f'{len(raw)} byte file')
    return header, content_base, raw


def collect_files(node, prefix=''):
    """Flatten an ASAR "files" tree into {repository path: entry}, refusing odd entries."""
    for name, entry in node.items():
        if not isinstance(entry, dict):
            raise BundleError(f'{prefix}{name}: the ASAR header entry is not an object')
        if 'files' in entry:
            if not isinstance(entry['files'], dict):
                raise BundleError(f'{prefix}{name}: the ASAR directory entry has no file tree')
            yield from collect_files(entry['files'], f'{prefix}{name}/')
            continue
        if entry.get('unpacked'):
            # The bundle relies on a file next to the asar that this check does not read.
            raise BundleError(f'{prefix}{name}: the ASAR entry is unpacked, so its contents '
                              f'cannot be compared here')
        if 'size' not in entry or 'offset' not in entry:
            raise BundleError(f'{prefix}{name}: the ASAR entry has no size and offset')
        yield prefix + name, entry


def read_member(raw, content_base, entry):
    """Return the bytes of one ASAR member, checking the declared size is inside the file."""
    try:
        offset = int(entry['offset'])
        size = int(entry['size'])
    except (TypeError, ValueError) as error:
        raise BundleError(f'the ASAR entry size/offset is not an integer: {error}') from error
    start = content_base + offset
    end = start + size
    if offset < 0 or size < 0 or end > len(raw):
        raise BundleError(f'the ASAR entry claims bytes {start}..{end}, past the end of a '
                          f'{len(raw)} byte file; the bundle is truncated')
    return raw[start:end]


def bundled_site_paths(header):
    """Return every path the bundle carries under site/."""
    return sorted(path for path, _ in collect_files(header['files']) if path.startswith('site/'))


def app_bundles(root=ROOT, release_dir=None):
    """Return [(platform directory name, asar path)] for packaged output that exists."""
    release = Path(release_dir) if release_dir is not None else Path(root) / 'release'
    if not release.is_dir():
        return []
    found = []
    for child in sorted(release.iterdir()):
        if not child.is_dir() or not child.name.endswith('-unpacked'):
            continue
        asar = child / 'resources' / 'app.asar'
        if asar.is_file():
            found.append((child.name, asar))
        else:
            # Packaged output without an app.asar: report it rather than pass quietly.
            found.append((child.name, None))
    return found


def verify_bundle(asar_path, site_dir):
    """Compare one app.asar against site_dir.

    Returns a report dict with 'missing' paths, 'differing' paths, 'extra' paths, the
    compared and skipped counts, and human-readable 'notes'.
    """
    asar_path = Path(asar_path)
    site_dir = Path(site_dir)
    header, content_base, raw = parse_manifest(asar_path)
    notes, missing, extra, differing = [], [], [], []
    compared = skipped = 0
    seen = set()
    for relpath, entry in collect_files(header['files']):
        if not relpath.startswith('site/'):
            continue
        seen.add(relpath)
        local = site_dir / relpath[len('site/'):]
        if not is_text_asset(relpath):
            skipped += 1
            notes.append(f'skipped {relpath}: {skip_reason(relpath)}')
            continue
        if not local.is_file():
            missing.append(relpath)
            continue
        compared += 1
        bundled = read_member(raw, content_base, entry)
        if bundled != local.read_bytes():
            differing.append(relpath)
    # A text asset the repository has but the bundle never received is the same defect
    # seen from the other side: the bundle is not the site being released.
    for local in sorted(p for p in site_dir.rglob('*') if p.is_file()):
        relpath = 'site/' + local.relative_to(site_dir).as_posix()
        if relpath in seen or not is_text_asset(relpath):
            continue
        extra.append(relpath)
    return {
        'asar': str(asar_path),
        'compared': compared,
        'skipped': skipped,
        'missing': missing,
        'differing': differing,
        'extra': extra,
        'notes': notes,
    }


def report_problems(report, platform):
    """Return the failure lines for one report, empty when the bundle matches."""
    problems = []
    for relpath in report['differing']:
        problems.append(f'{platform}: {relpath} in app.asar differs from the repository site/')
    for relpath in report['missing']:
        problems.append(f'{platform}: {relpath} is bundled but missing from the repository site/')
    for relpath in report['extra']:
        problems.append(f'{platform}: {relpath} is in the repository site/ but not in app.asar')
    return problems


def check(root=ROOT, release_dir=None, required_platforms=()):
    """Check every packaged bundle under release/. Return (problems, summary lines)."""
    root = Path(root)
    release = Path(release_dir) if release_dir is not None else root / 'release'
    site_dir = root / 'site'
    bundles = app_bundles(root, release)
    lines, problems = [], []
    if not bundles:
        lines.append(f'No packaged launcher bundles under {release}; nothing to check. '
                     f'Build one with npm run pack.')
        for platform in required_platforms:
            problems.append(f'{platform} was expected but {release / platform} has no app.asar')
        return problems, lines
    lines.append(f'Checking {len(bundles)} packaged launcher bundle(s) under {release} '
                 f'against {site_dir}')
    lines.append('Compared byte for byte: text assets (.html .js .mjs .css .json .svg .txt .md '
                 '.webmanifest .nojekyll) at every depth under site/, including generated '
                 'site/data/ files such as world.json')
    lines.append('Deliberately skipped: binary imagery (.png .jpg .jpeg .gif .webp .ico), '
                 'site/downloads/ third-party archives and the mod jar, and any other '
                 'non-text asset')
    for platform, asar in bundles:
        if asar is None:
            problems.append(f'{release / platform}: packaged platform without resources/app.asar')
            continue
        try:
            report = verify_bundle(asar, site_dir)
        except BundleError as error:
            problems.append(f'unreadable bundle: {error}')
            continue
        lines.append(f'  {platform}: {report["compared"]} text assets compared, '
                     f'{report["skipped"]} deliberately skipped, {asar}')
        for note in report['notes']:
            lines.append(f'    {note}')
        problems.extend(report_problems(report, platform))
    for platform in required_platforms:
        if not any(name == platform and asar for name, asar in bundles):
            problems.append(f'{platform} was expected but {release / platform} has no app.asar')
    return problems, lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', type=Path, default=ROOT,
                        help='repository root holding site/ and release/ (default: this repo)')
    parser.add_argument('--release-dir', type=Path, default=None,
                        help='packaged output directory (default: <root>/release)')
    parser.add_argument('--require', action='append', default=[], metavar='PLATFORM',
                        help='fail when this packaged platform directory has no app.asar, '
                             'for example --require win-unpacked; repeatable')
    args = parser.parse_args(argv)
    problems, lines = check(root=args.root, release_dir=args.release_dir,
                           required_platforms=args.require)
    for line in lines:
        print(line)
    for problem in problems:
        print(f'FAIL: {problem}')
    if problems:
        print(f'Packaged launcher bundle check failed with {len(problems)} problem(s).')
        return 1
    print('Packaged launcher bundle(s) match the repository site/.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
