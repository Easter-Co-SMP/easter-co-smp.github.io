#!/usr/bin/env node
// Live measurement, deliberately NOT part of `npm test`: it downloads the real
// Minecraft client jar and the Iris jar the published graphics chunk pins, so it
// needs the network and ~40 MB of cache.
//
//   node tests/live/option-keys.mjs
//
// The question it answers is the one doc/launcher-states.md used to answer by
// assertion: are the option names desktop/hardware.cjs and desktop/visuals.cjs write
// into the client's options.txt and config/iris.properties names the shipped jars
// actually contain? A key the jar does not contain is a key the client does not read
// (the vanilla client rewrites options.txt on exit and drops what it never read), so
// this exits non-zero when a written key is absent.
//
// The key list is not transcribed here. The script drives the launcher's own write
// path — applyQualitySettings, applyDisplayDefaults — into a throwaway client tree
// and reads back the files they wrote, so what is measured is exactly what the
// launcher writes. The one hand-written key is `resourcePacks` (configureVisuals
// only writes it when resource packs are installed, and its value is gameplay data
// rather than a key this script can generate); the four probes at the end are
// reported and never gate.
//
// Both jars are cached in /tmp/easter-keys-cache (override with EASTER_KEYS_CACHE)
// and re-used when the hash the manifest records still matches, so the second run is
// a scan rather than a download.
//
// Scanning method: every entry of each jar is decompressed (stored entries copied,
// deflated entries inflated with node:zlib inflateRaw) and matched by WHOLE TOKEN,
// never by substring: .class entries are parsed for their constant-pool UTF-8
// strings and compared for exact equality, and text entries (.json, .properties,
// .lang, .mcmeta, .txt, ...) are tokenised into their own quoted strings and
// `key=`/`key:` leads and compared for exact equality. A substring search would
// answer the wrong question for a short name like `ao`, which occurs inside
// thousands of unrelated words; exact-token matching is what makes a "found" mean
// "this exact name exists in the jar".
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const {
  applyQualitySettings,
  applyDisplayDefaults,
  qualitySettings,
  parseProperties
} = require(path.join(REPO, 'desktop', 'hardware.cjs'));

// ---- where the artefacts come from -------------------------------------------
// The published manifest is the live one, not this checkout's copy: the question
// is what the launcher ships to players today.
const PUBLISHED_MANIFEST = 'https://easter-co-smp.github.io/data/client.json';
const PISTON_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MINECRAFT_VERSION = '26.2';
// The cache lives outside the repository on purpose: a 39 MB client jar is not a
// file that may enter Git history, and jar caches are rebuilt, not committed.
const CACHE_DIR = path.resolve(process.env.EASTER_KEYS_CACHE || '/tmp/easter-keys-cache');

// ---- the one key that is expected NOT to be in the vanilla jar ----------------
// A mod-provided binding only exists once the mod has registered it, so the vanilla
// client cannot contain it. It is searched in the vanilla jar anyway, and its
// absence is the expected result rather than a failure.
const MOD_PROVIDED_ACTIONS = new Set(['key.shippy-ships.isPressingCtrl']);
// Written by configureVisuals into options.txt when the managed resource packs are
// installed. Its value is the pack selection, so this script cannot generate it by
// running configureVisuals; the key name is the part that has to exist in the jar.
const HAND_WRITTEN_OPTIONS_KEYS = ['resourcePacks'];
// Report-only probes: recorded, never gating, because the ticket asks what the jar
// says about them rather than for a pass/fail.
//  - graphicsMode is the key Minecraft 26.2 is said to have replaced, and which
//    applyQualitySettings deliberately strips from options.txt before writing;
//  - the two file names anchor the claim that the class holding the names is the
//    class that owns the file, instead of assuming it;
//  - "custom" is the graphicsPreset value applyQualitySettings writes, so whether
//    the client knows that preset name is worth recording next to the key names.
const PROBES = [
  {key: 'graphicsMode', jar: 'vanilla', note: 'the key applyQualitySettings strips'},
  {key: 'options.txt', jar: 'vanilla', note: 'the file the client owns'},
  {key: 'custom', jar: 'vanilla', note: 'the graphicsPreset value we write'},
  {key: 'iris.properties', jar: 'iris', note: 'the file Iris owns'}
];

const started = Date.now();
function log(line = '') { process.stdout.write(line + '\n'); }
function fail(message) { process.stderr.write(`option-keys: ${message}\n`); process.exitCode = 1; }

// ---- downloads ---------------------------------------------------------------
async function download(url, file, {sha1 = null, sha512 = null} = {}) {
  try {
    const cached = await fs.readFile(file);
    if (matches(cached, {sha1, sha512})) return {buffer: cached, cached: true};
  } catch {}
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok) throw Error(`GET ${url} -> HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!matches(buffer, {sha1, sha512})) throw Error(`${url} did not match its recorded hash`);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, buffer);
  return {buffer, cached: false};
}
function matches(buffer, {sha1, sha512}) {
  if (!buffer.length) return false;
  if (sha1 && crypto.createHash('sha1').update(buffer).digest('hex') !== String(sha1).toLowerCase()) return false;
  if (sha512 && crypto.createHash('sha512').update(buffer).digest('hex') !== String(sha512).toLowerCase()) return false;
  return true;
}
async function fetchJson(url) {
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok) throw Error(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

// ---- a zip reader, because the scan must look inside the jars -----------------
function zipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('not a zip: no end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw Error('corrupt zip central directory');
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    entries.push({
      name: buffer.toString('utf8', p + 46, p + 46 + nameLength),
      method, compressedSize, uncompressedSize, localOffset
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
function zipRead(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw Error(`corrupt local header for ${entry.name}`);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw Error(`unsupported zip method ${entry.method} for ${entry.name}`);
}

// ---- exact-token extraction ---------------------------------------------------
// .class: the JVM constant pool. Constant_Utf8 is the only place an option name can
// live as a string, so the pool is the whole token set of a class file.
const TAG_UTF8 = 1, TAG_INTEGER = 3, TAG_FLOAT = 4, TAG_LONG = 5, TAG_DOUBLE = 6;
const TAG_CLASS = 7, TAG_STRING = 8, TAG_FIELDREF = 9, TAG_METHODREF = 10;
const TAG_INTERFACE_METHODREF = 11, TAG_NAME_AND_TYPE = 12, TAG_METHOD_HANDLE = 15;
const TAG_METHOD_TYPE = 16, TAG_DYNAMIC = 17, TAG_INVOKE_DYNAMIC = 18;
const TAG_MODULE = 19, TAG_PACKAGE = 20;
function constantPoolStrings(buffer) {
  if (buffer.length < 10 || buffer.readUInt32BE(0) !== 0xcafebabe) throw Error('not a class file');
  const count = buffer.readUInt16BE(8);
  const strings = [];
  let p = 10;
  for (let i = 1; i < count; i += 1) {
    const tag = buffer[p];
    p += 1;
    switch (tag) {
      case TAG_UTF8: {
        const length = buffer.readUInt16BE(p);
        p += 2;
        strings.push(buffer.toString('utf8', p, p + length));
        p += length;
        break;
      }
      case TAG_INTEGER: case TAG_FLOAT: p += 4; break;
      case TAG_LONG: case TAG_DOUBLE: p += 8; i += 1; break;
      case TAG_CLASS: case TAG_STRING: case TAG_METHOD_TYPE:
      case TAG_MODULE: case TAG_PACKAGE: p += 2; break;
      case TAG_FIELDREF: case TAG_METHODREF: case TAG_INTERFACE_METHODREF:
      case TAG_NAME_AND_TYPE: case TAG_DYNAMIC: case TAG_INVOKE_DYNAMIC: p += 4; break;
      case TAG_METHOD_HANDLE: p += 3; break;
      default: throw Error(`unknown constant pool tag ${tag}`);
    }
    if (p > buffer.length) throw Error('constant pool runs past the end of the class file');
  }
  return strings;
}
const TEXT_ENTRY = /\.(json|properties|lang|mcmeta|txt|cfg|toml|ya?ml|accesswidener)$/i;
function textTokens(name, text) {
  const tokens = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) tokens.push(match[1]);
  // .properties / .lang leads, and JSON object keys without quotes are not a thing.
  for (const match of text.matchAll(/^\s*([\w.$-]+)\s*[=:]/gm)) tokens.push(match[1]);
  return tokens;
}

// ---- the scan ------------------------------------------------------------------
function scanJar(buffer, wanted) {
  const wantedSet = new Set(wanted);
  const hits = new Map();
  for (const key of wantedSet) hits.set(key, {total: 0, classes: 0, texts: 0, entries: []});
  // Which entries carry which names, so the report can say where a name lives
  // rather than only that it exists somewhere.
  const byEntry = new Map();
  const stats = {entries: 0, classes: 0, texts: 0, skipped: [], parseFailures: 0};
  for (const entry of zipEntries(buffer)) {
    stats.entries += 1;
    const isClass = entry.name.endsWith('.class');
    const isText = TEXT_ENTRY.test(entry.name);
    if (!isClass && !isText) { stats.skipped.push(entry.name); continue; }
    let data;
    try { data = zipRead(buffer, entry); }
    catch (error) { stats.parseFailures += 1; continue; }
    let tokens;
    try { tokens = isClass ? constantPoolStrings(data) : textTokens(entry.name, data.toString('utf8')); }
    catch { stats.parseFailures += 1; continue; }
    if (isClass) stats.classes += 1; else stats.texts += 1;
    const seenHere = new Set();
    for (const token of tokens) {
      if (!wantedSet.has(token) || seenHere.has(token)) continue;
      seenHere.add(token);
      const record = hits.get(token);
      record.total += 1;
      if (isClass) record.classes += 1; else record.texts += 1;
      record.entries.push(entry.name);
      if (!byEntry.has(entry.name)) byEntry.set(entry.name, new Set());
      byEntry.get(entry.name).add(token);
    }
  }
  return {hits, byEntry, stats};
}

// ---- what the launcher actually writes -----------------------------------------
// Runs the launcher's own writers into a throwaway tree and returns the keys the
// files on disk carry, so the list measured is the list written.
async function writtenKeys() {
  const root = await fs.mkdtemp(path.join(CACHE_DIR, 'tree-'));
  await fs.writeFile(path.join(root, '.easter-client'), '');
  // applyDisplayDefaults treats the Shippy binding as deferred: it is written only
  // once the client has already put the line in options.txt (doc/launcher-states.md,
  // "The Shippy Ships hotkey moves off Left Ctrl"). A tree that has run once with the
  // mod looks exactly like this, so the deferred key is present here on purpose.
  await fs.writeFile(path.join(root, 'options.txt'),
    'key_key.shippy-ships.isPressingCtrl:key.keyboard.left.control\n', {mode: 0o600});
  const quality = qualitySettings({vramMB: 8192, tier: 'capable'});
  await applyQualitySettings(root, quality, {marker: '.easter-client'});
  await applyDisplayDefaults(root, {marker: '.easter-client', guiScale: 3});
  const options = parseProperties(await fs.readFile(path.join(root, 'options.txt'), 'utf8'));
  const iris = parseProperties(await fs.readFile(path.join(root, 'config', 'iris.properties'), 'utf8'));
  await fs.rm(root, {recursive: true, force: true});
  const optionKeys = [...options.keys()];
  const bindingActions = optionKeys.filter(key => key.startsWith('key_key.')).map(key => key.slice('key_'.length));
  const optionNames = optionKeys.filter(key => !key.startsWith('key_key.'));
  return {quality, optionNames, bindingActions, irisKeys: [...iris.keys()]};
}

// ---- the report ----------------------------------------------------------------
function pad(text, width) { return String(text).padEnd(width); }
function row({key, jar, result, hits, where}) {
  log(`  ${pad(key, 34)} ${pad(jar, 10)} ${pad(result, 8)} ${pad(hits, 6)} ${where}`);
}
function header(columns) {
  log(`  ${pad(columns[0], 34)} ${pad(columns[1], 10)} ${pad(columns[2], 8)} ${pad(columns[3], 6)} ${columns[4]}`);
  log(`  ${'-'.repeat(34)} ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(40)}`);
}
function where(record) {
  if (!record.total) return '';
  // The class a player's options actually go through is the interesting one, so it
  // sorts first; the language file that names an action is next.
  const rank = name => (/\/Options\.class$/.test(name) ? 0 : /\/IrisConfig\.class$/.test(name) ? 0 : /lang\/en_us\.json$/.test(name) ? 1 : 2);
  return [...record.entries].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 2).join(', ');
}
// Which entries carry the most of the measured names: the answer to "where do these
// names live", which is what makes an exact match more than a coincidence.
function nameHolders(scan, label, names) {
  const rows = [...scan.byEntry.entries()]
    .map(([entry, keys]) => {
      const missing = names.filter(name => !keys.has(name));
      return {entry, hit: names.length - missing.length, missing};
    })
    .filter(row => row.hit > 0)
    .sort((a, b) => b.hit - a.hit || a.entry.localeCompare(b.entry))
    .slice(0, 4);
  log(`where the ${label} names live (largest holders):`);
  for (const row of rows) {
    const missing = row.missing.length ? ` (not: ${row.missing.slice(0, 6).join(' ')}${row.missing.length > 6 ? ' …' : ''})` : '';
    log(`  ${pad(row.entry, 58)} ${row.hit}/${names.length}${missing}`);
  }
  log('');
}

async function main() {
  log(`option keys vs shipped jars — measured ${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z`);
  log(`cache: ${CACHE_DIR} (outside the repository; reused when the recorded hash matches)`);
  log('');

  // 1. the published graphics chunk decides which Iris jar is measured
  const published = await fetchJson(PUBLISHED_MANIFEST);
  const graphics = (published.chunks || []).find(chunk => chunk.id === 'graphics');
  if (!graphics) throw Error(`${PUBLISHED_MANIFEST} has no graphics chunk`);
  const irisFile = (graphics.files || []).find(file => /^mods\/iris(?:-[^/]+)?\.jar$/.test(file.path));
  if (!irisFile) throw Error(`${PUBLISHED_MANIFEST} graphics chunk names no iris jar`);
  const irisHash = String(irisFile.hash || '');
  const iris = await download(irisFile.url, path.join(CACHE_DIR, path.posix.basename(irisFile.path)), {
    sha512: irisHash.startsWith('sha512:') ? irisHash.slice(7) : null
  });

  // 2. the Minecraft client jar, through piston-meta
  const piston = await fetchJson(PISTON_MANIFEST);
  const version = (piston.versions || []).find(item => item.id === MINECRAFT_VERSION);
  if (!version) throw Error(`Minecraft ${MINECRAFT_VERSION} is not in ${PISTON_MANIFEST}`);
  const versionJson = await fetchJson(version.url);
  const client = (versionJson.downloads || {}).client;
  if (!client || !client.url) throw Error(`Minecraft ${MINECRAFT_VERSION} version json has no downloads.client.url`);
  const vanilla = await download(client.url, path.join(CACHE_DIR, `client-${MINECRAFT_VERSION}.jar`), {sha1: client.sha1});

  log(`Minecraft ${MINECRAFT_VERSION} client jar`);
  log(`  ${client.url}`);
  log(`  sha1 ${client.sha1}, ${vanilla.buffer.length} bytes, ${client.size} bytes expected by the version json, ${vanilla.cached ? 'reused from cache' : 'downloaded'}`);
  log(`Iris jar the published graphics chunk pins (${PUBLISHED_MANIFEST}, chunk "graphics")`);
  log(`  ${irisFile.path} version ${irisFile.version}`);
  log(`  ${irisFile.url}`);
  log(`  ${irisHash.split(':')[0]} ${irisHash.split(':')[1]}, ${iris.buffer.length} bytes (${irisFile.size} expected), ${iris.cached ? 'reused from cache' : 'downloaded'}`);
  log('');

  // 3. what the launcher writes
  const written = await writtenKeys();
  log(`keys the launcher writes, read back from the files applyQualitySettings and applyDisplayDefaults produced`);
  log(`  options.txt            ${written.optionNames.length + written.bindingActions.length} keys: `
    + [...written.optionNames, ...written.bindingActions.map(action => 'key_' + action)].join(' '));
  log(`  config/iris.properties ${written.irisKeys.length} keys: ${written.irisKeys.join(' ')}`);
  log('');

  // 4. scan
  const probeKeys = jar => PROBES.filter(probe => probe.jar === jar).map(probe => probe.key);
  const vanillaWanted = [...written.optionNames, ...HAND_WRITTEN_OPTIONS_KEYS, ...written.bindingActions, ...probeKeys('vanilla')];
  const vanillaScan = scanJar(vanilla.buffer, vanillaWanted);
  const irisScan = scanJar(iris.buffer, [...written.irisKeys, ...probeKeys('iris')]);

  log(`Minecraft ${MINECRAFT_VERSION} client jar: ${vanillaScan.stats.classes} class files, `
    + `${vanillaScan.stats.texts} text entries, ${vanillaScan.stats.entries} entries, `
    + `${vanillaScan.stats.parseFailures} unreadable`);
  log(`Iris jar: ${irisScan.stats.classes} class files, ${irisScan.stats.texts} text entries, `
    + `${irisScan.stats.entries} entries, ${irisScan.stats.parseFailures} unreadable`);
  log('');

  const missing = [];
  const present = [];
  const report = (key, jar, label, scan, expected) => {
    const record = scan.hits.get(key);
    const found = record.total > 0;
    if (expected === 'absent' ? found : !found) missing.push({key, jar, label, expected, found});
    else present.push({key, jar});
    row({
      key,
      jar,
      result: found ? 'found' : 'ABSENT',
      hits: record.total,
      where: where(record)
    });
  };

  const optionKeysWritten = [...written.optionNames, ...HAND_WRITTEN_OPTIONS_KEYS];
  log('options.txt keys -> Minecraft client jar (whole-token match: an exact constant-pool or text token)');
  header(['key', 'jar', 'result', 'hits', 'where (two entries)']);
  for (const key of optionKeysWritten) report(key, 'vanilla', 'options.txt', vanillaScan, 'present');
  log('');
  nameHolders(vanillaScan, 'options.txt', optionKeysWritten);
  log('options.txt binding actions -> Minecraft client jar (the ACTION name; options.txt prefixes it with "key_")');
  header(['key', 'jar', 'result', 'hits', 'where (two entries)']);
  for (const action of written.bindingActions) {
    report(action, 'vanilla', 'binding', vanillaScan, MOD_PROVIDED_ACTIONS.has(action) ? 'absent' : 'present');
  }
  log('');
  nameHolders(vanillaScan, 'binding-action', written.bindingActions.filter(action => !MOD_PROVIDED_ACTIONS.has(action)));
  log('config/iris.properties keys -> Iris jar (whole-token match)');
  header(['key', 'jar', 'result', 'hits', 'where (two entries)']);
  for (const key of written.irisKeys) report(key, 'iris', 'iris.properties', irisScan, 'present');
  log('');
  nameHolders(irisScan, 'iris.properties', written.irisKeys);
  log('report-only probes (no pass/fail: they exist to be recorded, not to gate)');
  header(['key', 'jar', 'result', 'hits', 'where (two entries)']);
  for (const probe of PROBES) {
    const scan = probe.jar === 'iris' ? irisScan : vanillaScan;
    const record = scan.hits.get(probe.key);
    row({key: probe.key, jar: probe.jar, result: record.total ? 'found' : 'ABSENT', hits: record.total, where: where(record)});
    log(`  ${' '.repeat(34)} ${' '.repeat(10)} ${' '.repeat(8)} ${' '.repeat(6)} ${probe.note}`);
  }
  log('');

  // 5. the verdict
  if (!missing.length) {
    log(`PASS: every key the launcher writes was found in the jar that must read it `
      + `(${present.length} keys measured), and the ${MOD_PROVIDED_ACTIONS.size} mod-provided action is absent from the vanilla jar as expected.`);
  } else {
    for (const item of missing) {
      if (item.expected === 'present') fail(`${item.key} (${item.label}) is NOT in the ${item.jar} jar, so the client does not read it`);
      else fail(`${item.key} (${item.label}) IS in the ${item.jar} jar, but it was expected to be mod-provided only`);
    }
    log(`FAIL: ${missing.length} key(s) did not measure as expected. See the "ABSENT" rows above.`);
  }
  log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

main().catch(error => {
  fail(error && error.stack ? error.stack : String(error));
});
