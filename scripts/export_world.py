"""Saved-terrain public export. No player reader, console commands, or world writes."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/New_York')

#: The only marker kinds the public map publishes, and the only ones its key lists.
#: Player factions (navy, citizen, criminal, pirate, prisoner) are read by the private
#: household map and must never be re-added here: player records are not exported.
PUBLIC_MARKER_KINDS = ('ship', 'sea_patrol', 'land_patrol', 'villager', 'mob')

#: The only icons a public marker may carry. They name what the map draws -- a hull, a
#: patrol ship, or a guard -- not the roster or faction a row came from, so no private
#: icon name is copied out even when it matches.
PUBLIC_MARKER_ICONS = ('hull', 'navy_ship', 'navy_unit-guard')
#: The drawing each published category uses. Villagers and mobs are plain dots.
ICON_BY_KIND = {'ship': 'hull', 'sea_patrol': 'navy_ship', 'land_patrol': 'navy_unit-guard'}

#: NPC roster kinds that are a land patrol. 'navy_patrol' is set explicitly for the
#: patrols derived from regions in core/minecraft_map_data.npc_records.
#: 'guard_patrol' is kept as an icon alias for a guard roster that arrives without a kind.
PATROL_NPC_KINDS = frozenset({'sailor', 'region_guard', 'navy_patrol'})
PATROL_ICONS = frozenset({'guard_patrol'})
WILDLIFE_NPC_KINDS = frozenset({'wildlife'})
DEPENDENCIES = {
    'fabric-api': 'https://modrinth.com/mod/fabric-api',
    'shippy-ships': 'https://modrinth.com/mod/shippy-ships',
    'ingeniumapi': 'https://modrinth.com/project/ingeniumapi',
    'tectonic': 'https://modrinth.com/project/tectonic',
    'lithostitched': 'https://modrinth.com/project/lithostitched',
}


#: The pinned Fabric loader, which must equal the one desktop/install.cjs launches. It is
#: read from that file at export time rather than copied, so the manifest cannot claim a
#: loader the launcher does not install. The built-in value is only a substitute for a
#: checkout that genuinely has no launcher source to read -- never an answer for one that
#: does, because a silently-stale pin here is the same bug as a stale bundle, one layer down.
FABRIC_FALLBACK = '0.19.5'
INSTALL_RELEASE = 'desktop/install.cjs'
#: The Java major version MC 26.2 requires, matching desktop/install.cjs's fallback. The
#: exporter cannot read Mojang's catalogue, so it publishes our pin, not a guess at theirs.
JAVA_MAJOR = 25

#: The one manifest field added alongside the flat fields: the chunk list. Every other key
#: keeps its former meaning and value, because the launcher already installed on a machine
#: reads the flat ones.
MANIFEST_KEYS = ('minecraft', 'mod', 'dependencies', 'fabric', 'chunks')

MODRINTH_API = 'https://api.modrinth.com/v2/project/'
MODRINTH_CDN_HOST = 'cdn.modrinth.com'
#: The same identification the shipped launcher sends, so the publisher sees one client.
MODRINTH_AGENT = 'EasterCompanyLauncher/1.0 (easter-co-smp.github.io)'
_FABRIC_PATTERN = r"const FABRIC='([0-9][0-9A-Za-z.+-]*)'"

#: The optional graphics chunk's one payload: the shader pack Owen chose as the server's
#: artistic look, Complementary Unbound r5.9.3, from its publisher's Modrinth project.
#: The other three packs the clients arrived with (BSL, Bliss, Complementary Reimagined)
#: were trimmed on 2026-10-16 and are deliberately not described here. The version is pinned
#: in this file rather than resolved to "latest", so the published chunk changes only when
#: someone changes this pin: the artifact is what a player downloads, and an export that
#: quietly followed a new upstream release would ship an untested shader stack.
GRAPHICS_PROJECT_ID = 'R6NEzAwj'
GRAPHICS_PROJECT_NAME = 'Complementary Shaders - Unbound'
GRAPHICS_PACK_VERSION = 'r5.9.3'
GRAPHICS_PACK_NAME = 'ComplementaryUnbound_r5.9.3.zip'
#: Iris is the loader the household clients run; OptiFine is not installed. A release that
#: does not list it is refused rather than published as the graphics payload.
GRAPHICS_LOADER = 'iris'
GRAPHICS_LOADER_NAME = 'Iris Shaders'
#: The directory Iris reads packs from, inside the launcher's own Minecraft directory.
GRAPHICS_PATH_PREFIX = 'shaderpacks/'
#: A pack filename becomes a path in the manifest, so it is held to the same shape as any
#: other publisher filename rather than copied in and checked afterwards.
_PACK_FILENAME_PATTERN = re.compile('[A-Za-z0-9][A-Za-z0-9._+-]{0,120}?[.]zip')
#: The mod filename shape, held to the same standard as the pack's.
_MOD_FILENAME_PATTERN = re.compile('[A-Za-z0-9][A-Za-z0-9._+-]{0,120}?[.]jar')

#: The chunk's other half: the loader that makes the pack do anything. Owen reported on
#: 2026-10-17 that the game had no shaders with the pack installed, because 1.0.8 shipped
#: the pack into a client with no Iris: config/iris.properties was written and nothing read
#: it. These are the exact artifacts both household clients already run, verified against
#: Modrinth by sha512 (iris dee95558..., sodium 9b7a7aad..., byte-identical to the jars in
#: /opt/minecraft/client-mods). Iris needs Sodium; Fabric API is already in the base chunk.
GRAPHICS_COMPANIONS = (
    {'id': 'iris', 'name': 'Iris Shaders', 'version': '1.11.4+26.2-fabric'},
    {'id': 'sodium', 'name': 'Sodium', 'version': 'mc26.2-0.9.2-fabric'},
)
#: JARs install under mods/ whatever their published path, and the manifest says so.
COMPANION_PATH_PREFIX = 'mods/'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + '\n')


def manifest_text(value):
    """The one canonical serialisation of a manifest object. Used for JSON and for hashes."""
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + '\n'


def chunk_version(chunk):
    """A chunk's version is the digest of everything it contains, so it changes only on change.

    This is its identity, not the Minecraft version: the Easter Co. jar lives inside the base
    chunk and is updated on its own schedule while Minecraft stays frozen, so an identity
    fixed to '26.2' would leave a mod update invisible and a client would skip the chunk
    forever. An equal version means the chunk is already installed and is neither
    re-downloaded nor re-hashed; any change to any file changes it.
    """
    return 'sha256:' + hashlib.sha256(manifest_text(chunk['files']).encode()).hexdigest()


def declared_fabric(install):
    """The Fabric loader the shipped launcher launches, read from its own source.

    Three outcomes, deliberately kept distinct:

    - the launcher source is there and declares a pin -> that pin;
    - the launcher source is there but the pin cannot be read from it -> refuse, because
      publishing a remembered 0.19.5 while the launcher installs something else is exactly
      the drift the chunk list exists to catch;
    - there is no launcher source to read at all (an isolated export fixture) -> the
      built-in pin, said out loud rather than assumed.
    """
    install = Path(install)
    if not install.exists():
        print(f'Launcher source {install.name} is absent; fabric falls back to the built-in '
              f'pin {FABRIC_FALLBACK}', flush=True)
        return FABRIC_FALLBACK
    match = re.search(_FABRIC_PATTERN, install.read_text())
    if not match:
        raise RuntimeError(f'The Fabric pin could not be read from {install.name}; refusing to '
                           f'guess a loader the launcher may not install')
    return match.group(1)


def resolved_pins(root, dependencies):
    """The pins the base chunk carries: the Minecraft version, the loader and the Java major.

    The Fabric pin is read from the shipped launcher's own source, so the manifest cannot
    claim a loader that launcher does not install. A launcher source that cannot be read is
    an error, not a fallback.
    """
    return {'minecraft': dependencies['minecraft'],
            'fabric': declared_fabric(Path(root) / INSTALL_RELEASE), 'java': JAVA_MAJOR}


def packages(mod, dependencies, pins, graphics=None, companions=()):
    """The published chunk list: the frozen base chunk, plus the graphics chunk when pinned.

    The base chunk describes the frozen game and is always required. The graphics chunk is
    the optional enhanced-graphics and shaders payload: it is present only when a published
    upstream artifact for the pinned pack has been confirmed, because an optional chunk
    with invented contents would claim a payload that does not exist. An optional chunk
    that is switched off is not fetched, and its absence invalidates nothing else.
    """
    base = {
        'id': 'base',
        'name': 'Minecraft ' + pins['minecraft'] + ' game, libraries and required mods',
        'optional': False,
        'immutable': True,
        'fabric': pins['fabric'],
        'java': pins['java'],
        'files': sorted([{**mod, 'id': 'easter-navy', 'name': mod['name']}] + list(dependencies['mods']),
                        key=lambda entry: entry['path']),
    }
    # The version is the digest of the file list, never the Minecraft version: our own mod
    # jar lives in this chunk and is updated on its own schedule while Minecraft stays
    # frozen, so a '26.2' identity would hide a mod update from every installed client
    # forever. The pinned Minecraft version stays visible in the manifest, in this chunk's
    # name, and beside it as the chunk's own fabric and java pins.
    chunks = [dict(base, version=chunk_version(base))]
    if graphics:
        # The file entry carries the publisher's project id, as a dependency entry does, and
        # the publisher's own packed filename as its path: the same file Iris reads once the
        # chunk has installed it into the launcher's own shaderpacks directory.
        entry = {'id': GRAPHICS_PROJECT_ID, 'name': graphics['name'], 'version': graphics['version'],
                 'path': graphics['path'], 'url': graphics['url'],
                 'hash': graphics['hash'], 'size': graphics['size']}
        # The loader travels with the pack: a shader pack without Iris is a file the game
        # never reads, which is how 1.0.8 shipped no visible shaders to a player who had
        # them switched on.
        entries = [entry] + [{'id': item['id'], 'name': item['name'], 'version': item['version'],
                              'path': item['path'], 'url': item['url'], 'hash': item['hash'],
                              'size': item['size']} for item in companions]
        # Every chunk carries the same field set, so a chunk's shape never depends on which
        # kind it is. The game pins are meaningful on the frozen base chunk only, and are
        # null here rather than absent.
        chunk = {'id': 'graphics', 'name': graphics['name'] + ' and ' + GRAPHICS_LOADER_NAME +
                 ' for Minecraft ' + pins['minecraft'],
                 'optional': True, 'immutable': False, 'fabric': None, 'java': None, 'files': entries}
        chunks.append(dict(chunk, version=chunk_version(chunk)))
    return chunks


def public_marker_kind(row):
    """One of PUBLIC_MARKER_KINDS, or None for a row the public map must not show.

    A hull the fleet registry marks as a navy patrol is published as a sea patrol; every
    other hull is published as a ship. NPC rows are published by what their roster says
    they are: garrison, region-guard and region-derived patrols, wildlife, or a
    villager/islander. A private faction is not a public category, so it is never
    consulted here.
    """
    if row.get('kind') == 'ship':
        return 'sea_patrol' if row.get('navy_patrol') is True else 'ship'
    if row.get('kind') != 'npc':
        return None
    npc_kind, icon = row.get('npc_kind'), row.get('icon')
    if npc_kind in PATROL_NPC_KINDS or icon in PATROL_ICONS:
        return 'land_patrol'
    if npc_kind in WILDLIFE_NPC_KINDS:
        return 'mob'
    return 'villager'


def public_marker(row, now):
    """Build a NEW, narrow record. Never copy arbitrary private fields into the export."""
    kind = public_marker_kind(row)
    if kind is None:
        return None
    if any(type(row.get(axis)) not in (float, int) or not math.isfinite(row[axis]) for axis in ('x', 'z')):
        return None
    at = row.get('read_at')
    age = row.get('age_seconds')
    observed = None
    if type(at) in (int, float) and math.isfinite(at) and type(age) in (int, float) and math.isfinite(age):
        observed = datetime.fromtimestamp(min(now.timestamp(), max(0, at - max(0, age))), timezone.utc).isoformat()
    marker = {
        'id': hashlib.sha256((row['kind'] + ':' + str(row.get('id', ''))).encode()).hexdigest()[:20],
        'kind': kind, 'name': str(row.get('name') or ('Ship' if row['kind'] == 'ship' else 'NPC'))[:120],
        'x': round(row['x'], 2), 'z': round(row['z'], 2), 'observed_at': observed,
    }
    icon = ICON_BY_KIND.get(kind)
    if icon:
        marker['icon'] = icon
    return marker


class SavedPositions:
    """Have the existing readers use their last-known ship/NPC stores, without console I/O.

    A separate console poll can interleave with private map reads. Public daily exports
    instead preserve each saved observation's own timestamp and never claim to be live.
    """
    def positions(self, selectors):
        return {ident: ('not_loaded', None, {'absence_age_known': False}) for ident in selectors}


def public_regions(doc):
    result = []
    for zone in doc['zones']:
        result.append({key: zone[key] for key in (
            'id', 'name', 'short_name', 'points', 'pvp_protection', 'pve_protection',
            'edit_protection', 'navy_controlled', 'guard_patrols', 'navy_patrols')})
    # The smallest overlapping region supplies the hover name, as on the private map.
    result.sort(key=lambda r: abs(sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(r['points'], r['points'][1:]+r['points'][:1]))))
    return result


def parse_modrinth_files(versions, ident, version, minecraft):
    """The one published file for a pinned project version, in the launcher's own terms.

    The same rule desktop/install.cjs resolveMod applies: a version of the project that
    lists our Minecraft version and the fabric loader, and whose primary file is served
    from cdn.modrinth.com with a sha512 hash. A project that publishes no such file is
    refused rather than described with a hash the upstream does not publish.
    """
    if not isinstance(versions, list):
        raise ValueError(f'Modrinth returned no version list for {ident}')
    for release in versions:
        versions_listed = release.get('game_versions') or []
        loaders = release.get('loaders') or []
        files = release.get('files') or []
        matches = (release.get('version_number') == version
                   or any(version in (f.get('filename') or '') for f in files))
        if not (minecraft in versions_listed and 'fabric' in loaders and matches):
            continue
        file = next((f for f in files if f.get('primary')), files[0] if files else None)
        digest = (file or {}).get('hashes', {}).get('sha512')
        if not file or not re.fullmatch('[a-f0-9]{128}', str(digest)):
            raise ValueError(f'The pinned {ident} {version} has no sha512 from its publisher')
        if urllib.parse.urlsplit(file.get('url', '')).hostname != MODRINTH_CDN_HOST:
            raise ValueError(f'The pinned {ident} {version} is not served by {MODRINTH_CDN_HOST}')
        if type(file.get('size')) is not int or file['size'] <= 0:
            raise ValueError(f'The pinned {ident} {version} publishes no file size')
        return {'name': (file.get('filename') or ident + '.jar').rsplit('/', 1)[-1], 'url': file['url'],
                'hash': 'sha512:' + digest, 'size': file['size']}
    raise ValueError(f'The pinned {ident} {version} is unavailable for Minecraft {minecraft} and fabric')


def fetch_modrinth_versions(ident, minecraft, timeout=45):
    """One GET against the publisher's JSON API. Only the project id and pins reach the URL."""
    if not re.fullmatch('[a-z0-9-]{1,80}', ident):
        raise ValueError('Invalid Modrinth project id')
    query = urllib.parse.urlencode({'loaders': json.dumps(['fabric']),
                                    'game_versions': json.dumps([minecraft])})
    request = urllib.request.Request(MODRINTH_API + urllib.parse.quote(ident) + '/version?' + query,
                                     headers={'Accept': 'application/json', 'User-Agent': MODRINTH_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def fetch_modrinth_version(ident, version, minecraft, timeout=45, loader=None):
    """The pinned graphics release, asked for by version rather than filtered for loaders.

    A shader pack is published with the iris/optifine loaders, so the fabric query the mods
    use would never return it. The pinned version is fetched directly and then held to the
    same rules: it must list this Minecraft version and the loader the clients run.

    A Modrinth project id is base62 and mixed case -- the launcher's own pinned ids are
    ('P7dR8mSH', 'R6NEzAwj') -- so it is validated as alphanumeric rather than lowercase
    before it is quoted into the URL.
    """
    if not re.fullmatch('[A-Za-z0-9]{1,80}', ident):
        raise ValueError('Invalid Modrinth project id')
    query = urllib.parse.urlencode({'loaders': json.dumps([loader or GRAPHICS_LOADER]),
                                    'game_versions': json.dumps([minecraft])})
    request = urllib.request.Request(MODRINTH_API + urllib.parse.quote(ident) + '/version?' + query,
                                     headers={'Accept': 'application/json', 'User-Agent': MODRINTH_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def parse_graphics_release(versions, version, minecraft, project_id=None, project_name=None,
                           filename_pattern=None, path_prefix=None, loader=None):
    """The one published file for the pinned graphics pack, in the launcher's own terms.

    The same standard as a mod dependency: the artifact must be served by the publisher's
    own CDN and carry the publisher's own sha512, or it is refused. The filename becomes a
    path in the manifest, so it is validated here rather than sanitised afterwards.
    """
    ident = project_id or GRAPHICS_PROJECT_ID
    label = project_name or GRAPHICS_PROJECT_NAME
    shape = filename_pattern or _PACK_FILENAME_PATTERN
    prefix = GRAPHICS_PATH_PREFIX if path_prefix is None else path_prefix
    if not isinstance(versions, list):
        raise ValueError(f'Modrinth returned no version list for {ident}')
    for release in versions:
        files = release.get('files') or []
        matches = (release.get('version_number') == version
                   or any(version in (f.get('filename') or '') for f in files))
        if not matches:
            continue
        if minecraft not in (release.get('game_versions') or []):
            raise ValueError(f'The pinned graphics pack {version} does not list Minecraft {minecraft}')
        wanted_loader = loader or GRAPHICS_LOADER
        if wanted_loader not in (release.get('loaders') or []):
            raise ValueError(f'The pinned graphics pack {version} is not published for {wanted_loader}')
        file = next((f for f in files if f.get('primary')), files[0] if files else None)
        digest = (file or {}).get('hashes', {}).get('sha512')
        if not file or not re.fullmatch('[a-f0-9]{128}', str(digest)):
            raise ValueError(f'The pinned graphics pack {version} has no sha512 from its publisher')
        if urllib.parse.urlsplit(file.get('url', '')).hostname != MODRINTH_CDN_HOST:
            raise ValueError(f'The pinned graphics pack {version} is not served by {MODRINTH_CDN_HOST}')
        if type(file.get('size')) is not int or file['size'] <= 0:
            raise ValueError(f'The pinned graphics pack {version} publishes no file size')
        filename = str(file.get('filename') or '')
        if not shape.fullmatch(filename.rsplit('/', 1)[-1]):
            raise ValueError(f'The pinned graphics pack {version} publishes an unusable filename')
        return {'id': ident, 'name': label, 'version': version, 'path': prefix + filename.rsplit('/', 1)[-1],
                'url': file['url'], 'hash': 'sha512:' + digest, 'size': file['size']}
    raise ValueError(f'The pinned graphics pack {version} is unavailable for Minecraft {minecraft}')


def read_graphics_state(path):
    """The cached confirmed graphics artifact, or None when there is none to reuse.

    Runtime state, like the dependency resolution cache: it lives outside the repository.
    A cache can never outvote a refusal, because only a confirmed artifact is ever stored.
    """
    try:
        graphics = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(graphics, dict):
        return None
    required = ('name', 'version', 'path', 'url', 'hash', 'size')
    return graphics if all(graphics.get(key) for key in required) else None


def write_graphics_state(path, graphics):
    if graphics:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(manifest_text(graphics))


def graphics_resolver(fetch=fetch_modrinth_version):
    """The graphics fetch: the publisher's own release record for the pinned pack."""
    return fetch


def resolved_graphics(resolver, minecraft, state_path):
    """The graphics chunk's file, confirmed by its publisher, from cache only when cached.

    The resolver answers with the publisher's own release record, exactly as the dependency
    resolver answers with a version list, so the rules can live in one place: a stub from a
    test and the real API give the same shape. The published entry is then built from the
    confirmed fields alone -- when it was fetched is runtime state and stays in the state
    file outside the repository, so re-running the export on unchanged inputs still
    produces a byte-identical manifest.

    A refusal is not quietly downgraded to an absent chunk. The manifest is what an installed
    launcher acts on, so a silently missing graphics chunk would switch every player's
    enhanced graphics off with nothing reporting a problem, which is the same class of bug
    as a stale version. The export fails loudly and the next run retries.
    """
    cached = read_graphics_state(state_path)
    if cached and cached.get('version') == GRAPHICS_PACK_VERSION \
            and str(cached.get('path', '')).startswith(GRAPHICS_PATH_PREFIX):
        return cached
    if resolver is None:
        resolver = graphics_resolver()
    try:
        parsed = parse_graphics_release(resolver(GRAPHICS_PROJECT_ID, GRAPHICS_PACK_VERSION, minecraft),
                                        GRAPHICS_PACK_VERSION, minecraft)
        confirmed = {'name': parsed['name'], 'version': parsed['version'], 'path': parsed['path'],
                     'url': parsed['url'], 'hash': parsed['hash'], 'size': parsed['size']}
    except Exception as error:
        raise RuntimeError(f'The pinned graphics pack {GRAPHICS_PACK_VERSION} could not be '
                           f'confirmed: {error}') from error
    write_graphics_state(state_path, {'fetched_at': datetime.now(timezone.utc).isoformat(), **confirmed})
    return confirmed


def read_companions_state(path):
    """The cached confirmed loader files, or None when there is none to reuse."""
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get('versions'), list) \
            or not isinstance(value.get('files'), list):
        return None
    required = ('id', 'name', 'version', 'path', 'url', 'hash', 'size')
    if not all(isinstance(entry, dict) and all(entry.get(key) for key in required)
               for entry in value['files']):
        return None
    return value


def resolved_graphics_companions(resolver, minecraft, state_path):
    """The shader loader's own files, confirmed by their publisher, from cache when cached.

    Same rules as the pack and the same refusal: an unconfirmed loader means an export that
    stops rather than a published chunk whose shader pack nothing can open. The cache is
    keyed by the pinned versions, so changing a pin always re-fetches.
    """
    cached = read_companions_state(state_path)
    wanted = tuple(item['version'] for item in GRAPHICS_COMPANIONS)
    if cached and cached.get('versions') == list(wanted):
        return [{key: entry[key] for key in ('id', 'name', 'version', 'path', 'url', 'hash', 'size')}
                for entry in cached['files']]
    if resolver is None:
        resolver = graphics_resolver()
    files = []
    for item in GRAPHICS_COMPANIONS:
        try:
            parsed = parse_graphics_release(resolver(item['id'], item['version'], minecraft, loader='fabric'),
                                            item['version'], minecraft, project_id=item['id'],
                                            project_name=item['name'],
                                            filename_pattern=_MOD_FILENAME_PATTERN,
                                            path_prefix=COMPANION_PATH_PREFIX, loader='fabric')
        except Exception as error:
            raise RuntimeError(f'The pinned shader loader {item["id"]} {item["version"]} could not '
                               f'be confirmed: {error}') from error
        files.append(parsed)
    write_graphics_state(state_path, {'fetched_at': datetime.now(timezone.utc).isoformat(),
                                      'versions': list(wanted), 'files': files})
    return files


def read_resolution_state(path):
    """A cached resolution, shaped {entries: {...}, checked: {...}}, or {} when unusable.

    The cache only saves network round trips. Each entry records the pinned version it was
    resolved for, and an entry is reused only while that version still matches, so a stale
    cache can never disagree with what the export is about to publish.
    """
    try:
        stored = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    if isinstance(stored, dict) and isinstance(stored.get('entries'), dict):
        return stored
    return {'entries': stored, 'checked': {}} if isinstance(stored, dict) else {}


def resolve_dependencies(resolver, dependencies, minecraft, state, now=None):
    """The published file behind each pinned dependency, resolved once and remembered.

    A dependency whose file cannot be confirmed fails the export. Omitting it would either
    contradict the flat dependency list or publish an incomplete frozen base chunk, and
    publishing an unverified URL is worse than not publishing.
    """
    entries = dict(state.get('entries') or {})
    checked = dict(state.get('checked') or {})
    today = (now or datetime.now(timezone.utc)).date()
    wanted = [(ident, entry['version']) for ident, entry in dependencies.items()
              if entry['version'] != entries.get(ident, {}).get('version')]
    entries.update(resolver(entries, wanted, minecraft) if (wanted and resolver is not None) else {})
    for ident, _ in wanted:
        checked[ident] = today.isoformat()
    state['entries'], state['checked'] = entries, checked
    missing = [ident for ident, entry in dependencies.items()
               if entries.get(ident, {}).get('version') != entry['version']]
    if missing:
        raise RuntimeError('No verified upstream file for ' + ', '.join(sorted(missing))
                           + '; refusing to publish an unverifiable base chunk')
    return [{'id': ident, 'name': entry['name'], 'version': entry['version'],
             'path': entries[ident]['name'], 'url': entries[ident]['url'],
             'hash': entries[ident]['hash'], 'size': entries[ident]['size']}
            for ident, entry in dependencies.items()]


def modrinth_resolver(fetch=fetch_modrinth_versions):
    """Resolve only the dependencies handed to it; everything else is reused from the cache."""
    def resolve(entries, wanted, minecraft):
        resolved, failures = {}, []
        for ident, version in wanted:
            try:
                resolved[ident] = {'version': version, 'fetched_at': datetime.now(timezone.utc).isoformat(),
                                   **parse_modrinth_files(fetch(ident, minecraft), ident, version, minecraft)}
            except Exception as error:  # one dependency's failure must not hide the others
                failures.append(f'{ident} {version}: {error}')
        if failures:
            raise RuntimeError('Modrinth could not confirm ' + '; '.join(failures))
        return resolved

    return resolve


def default_resolution_state():
    """Resolution state is runtime state: it lives outside the repository, never in site/."""
    override = os.environ.get('EASTER_MANIFEST_STATE')
    if override:
        return Path(override) / 'modrinth.json'
    base = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state')
    return base / 'easter-co-pages/modrinth.json'


def export_client(destination, download_module, resolver=None, now=None, state_path=None,
                  graphics_resolver=None):
    """Publish the additive client manifest: the flat fields, plus the chunk list.

    The flat fields keep their exact former meaning and values so a launcher built before
    chunks keeps working. The chunk list is a second, consistent description of the same
    client, and validate.py refuses the pair when they disagree.
    """
    mods = {}
    for path in download_module._mods():
        with zipfile.ZipFile(path) as jar:
            try:
                meta = json.loads(jar.read('fabric.mod.json'))
            except KeyError:
                continue
        mods[meta['id']] = (path, meta)
    custom, meta = mods['easter-navy']
    target = destination / 'downloads/easter-navy.jar'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(custom, target)
    # Fail a changing build rather than publish a mismatched JAR and checksum.
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if hashlib.sha256(custom.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Custom mod changed during export; retry')
    minecraft = download_module.facts.stack().split(' · ', 1)[0].removeprefix('MC ')
    # A resolved entry is only reused when it is still pinned to the same version, so the
    # cache can never outvote the publisher's own answer.
    state_path = Path(state_path) if state_path else default_resolution_state()
    resolution = read_resolution_state(state_path)
    mod_entries = {}
    for ident in DEPENDENCIES:
        name, version = mods[ident][1]['name'], mods[ident][1]['version']
        mod_entries[ident] = {'name': name, 'version': version}
    pins = resolved_pins(Path(__file__).resolve().parents[1], {'minecraft': minecraft})
    if resolver is None:
        resolver = modrinth_resolver()
    files = resolve_dependencies(resolver, mod_entries, minecraft, resolution, now=now)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(manifest_text(resolution))
    size = target.stat().st_size  # the copied jar's own size, never a local path
    custom_file = {'name': meta['name'], 'version': meta['version'], 'path': 'downloads/easter-navy.jar',
                   'url': 'downloads/easter-navy.jar', 'hash': 'sha256:' + digest, 'size': size}
    # The optional graphics chunk is confirmed against the publisher before anything is
    # published: an unconfirmed shader stack is omitted only by refusing the export, never
    # by publishing a chunk that claims a payload nobody verified.
    graphics = resolved_graphics(graphics_resolver, minecraft, state_path.parent / 'graphics.json')
    # The loader is part of the same payload: without it the pack is inert.
    companions = resolved_graphics_companions(graphics_resolver, minecraft,
                                              state_path.parent / 'graphics-companions.json')
    client = {
        'minecraft': minecraft,
        'fabric': pins['fabric'],
        'mod': {'name': meta['name'], 'version': meta['version'], 'sha256': digest,
                'bytes': size, 'url': 'downloads/easter-navy.jar'},
        'dependencies': [{'id': ident, 'name': entry['name'], 'version': entry['version'],
                          'url': DEPENDENCIES[ident]} for ident, entry in mod_entries.items()],
        'chunks': packages(custom_file, {'mods': files}, pins, graphics, companions),
    }
    # Nothing local, private or absolute may reach the public manifest.
    for chunk in client['chunks']:
        for entry in chunk['files']:
            if entry['path'].startswith('/') or ':' in entry['path'] or '\\' in entry['path']:
                raise RuntimeError('Refusing to publish a non-relative file path')
    write_json(destination / 'data/client.json', client)
    return client


def export_snapshot(destination, source_root=Path('/root/e-server'), now=None, previous_day=None):
    """Stage a complete export before touching the publishing checkout."""
    now = now or datetime.now(timezone.utc)
    destination = Path(destination)
    sys.path.insert(0, str(source_root))
    terrain = importlib.import_module('core.minecraft_map')
    entities = importlib.import_module('core.minecraft_map_data')
    zones = importlib.import_module('core.map_zones')
    downloads = importlib.import_module('api.minecraft_download')
    coverage = terrain.metadata()
    if not coverage['regions']:
        raise RuntimeError('No saved terrain; refusing to erase the published world')
    tiles = []
    for index, region in enumerate(sorted(coverage['regions'], key=lambda r: (r['x'], r['z']))):
        path, report = terrain.tile(region['x'], region['z'])
        if report.get('unreadable'):
            raise RuntimeError('Terrain is being saved; retry rather than archive partial chunks')
        blob = path.read_bytes()
        target = destination / f"data/tiles/{region['x']}/{region['z']}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        tiles.append({'x': region['x'], 'z': region['z'], 'version': hashlib.sha256(blob).hexdigest()})
        if (index + 1) % 10 == 0:
            print(f'Rendered {index + 1}/{len(coverage["regions"])} saved tiles', flush=True)
    positions = SavedPositions()
    ships, _ = entities.ship_records(positions)
    npcs, _ = entities.npc_records(positions)
    markers = [clean for row in ships + npcs if (clean := public_marker(row, now)) is not None]
    day = now.astimezone(ZONE).date()
    gap = max(0, (day - datetime.fromisoformat(previous_day).date()).days - 1) if previous_day else 0
    snapshot = {
        'schema': 1, 'captured_at': now.astimezone(timezone.utc).isoformat(), 'snapshot_day': day.isoformat(),
        'missed_days': gap, 'center': coverage['center'], 'region_blocks': 512,
        'saved_chunk_slots': coverage['saved_chunk_slots'], 'tiles': tiles,
        'regions': public_regions(zones.read_document()[0]), 'markers': sorted(markers, key=lambda r: r['id']),
        'unlocated_markers': len(ships) + len(npcs) - len(markers),
        'position_source': 'Last observed ships and NPCs. Player records are excluded at export.',
    }
    write_json(destination / 'data/world.json', snapshot)
    export_client(destination, downloads)
    print(f'Exported {len(tiles)} tiles, {len(snapshot["regions"])} regions and {len(markers)} non-player markers', flush=True)
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--source-root', type=Path, default=Path('/root/e-server'))
    args = parser.parse_args()
    export_snapshot(args.destination, args.source_root)


if __name__ == '__main__':
    main()
