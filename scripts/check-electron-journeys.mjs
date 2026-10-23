// Every Electron journey in tests/desktop, run one at a time, with a verdict this
// file counts for itself.
//
//   node scripts/check-electron-journeys.mjs              # the gate: all of them, serially
//   node scripts/check-electron-journeys.mjs --only NAME  # one journey, for a diagnosis
//   node scripts/check-electron-journeys.mjs --root DIR   # run another tree's journeys
//   node scripts/check-electron-journeys.mjs --list       # what would run, and why
//
// doc/releasing.md precondition 2 is a list of `xvfb-run -a node tests/desktop/*.mjs`
// commands that nothing ran: `npm test`'s glob is `tests/desktop/*.test.cjs`, so it cannot
// match a `*.electron.mjs`, and `scripts/release.sh --check` ran only the unit suites, the
// python suites and the site validator. On 2026-10-23 two of those journeys —
// `providers.electron.mjs` and `wait-post-approval.electron.mjs` — were red on main and
// nobody knew, and the sweep was green once they were fixed (15a2e02, 4513f77). This
// script is that sweep, and `release.sh --check` calls it, which is the only way the
// document and the release path cannot drift apart again.
//
// The rules it keeps, because a gate that breaks them teaches people to skip it:
//
//   * One journey at a time, each under `xvfb-run -a`. A journey that fails while another
//     suite runs is contention, not a product fault (doc/releasing.md, "Run it alone"), so
//     the sweep also refuses to start while a fixture port is already occupied.
//   * A journey that needs the real account handler gets a freshly started fixture of its
//     own, on its own port, restarted before every run of it — which is also what resets
//     the durable sign-in limiter (60 per 10 minutes) between runs. Nothing of the
//     fixture's survives the journey it was started for.
//   * The verdict is counted, never inferred: PASS requires exit 0 *and* output. Every
//     discovered journey that has no recorded result at the end — a runaway, a timeout, a
//     journey that never ran — is a failure, so the failure count is
//     `discovered - passed` and cannot be short by an accident.
//   * A missing prerequisite (the cloud repository, its venv, the disposable PostgreSQL
//     container, the packaged electron binary, xvfb-run) is one sentence naming it and a
//     non-zero exit before anything runs. Never a skip, never a silent pass.
//   * An unclassified new `*.electron.mjs` that names a fixture port fails the gate rather
//     than quietly running without its fixture.
//   * It cleans up: fixtures stopped by process group and their ports confirmed free, the
//     PostgreSQL container left in the state it was found in, and any process the sweep
//     itself left behind is named and fails the run.
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '..');

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
let root = repo;
let only = null;
let listOnly = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--root') root = path.resolve(args[++i] || '');
  else if (arg === '--only') only = args[++i] || '';
  else if (arg === '--list') listOnly = true;
  else if (arg === '-h' || arg === '--help') {
    console.log((await fs.readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(0, 11).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exit(0);
  } else {
    console.error(`electron journeys: unknown argument ${JSON.stringify(arg)} (see --help)`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- constants
const cloudRepo = process.env.EASTER_CLOUD_REPO || '/root/easter-co-cloud';
const fixtureScript = path.join(cloudRepo, 'tests', 'launcher_api_fixture.py');
const fixturePython = process.env.EASTER_CLOUD_PYTHON || path.join(cloudRepo, '.venv', 'bin', 'python');
const pgContainer = 'identity-fixture-pg';
const pgPort = 15439;

// Which journeys need the real account handler, and on what. The numbers are
// doc/releasing.md's own ("The fixture company.electron.mjs needs", "The provider journey
// needs its own fixture"); `handover.electron.mjs` composes the real handler too, behind a
// recording proxy, and is the fourth one.
const FIXTURES = {
  'company.electron.mjs': {port: 18796},
  'handover.electron.mjs': {port: 18796},
  'providers.electron.mjs': {port: 18797, env: {EASTER_PROVIDER_FIXTURE: '1'}},
  'wait-post-approval.electron.mjs': {port: 18798},
};

// Deliberately not gated. Named here so the exclusion is a decision with a reason in it
// rather than a file that fell through a glob.
const NOT_GATES = {
  'ui-review.electron.mjs':
    'a design-review pass: it drives the launcher at several widths and writes screenshots to ' +
    'EASTER_REVIEW_IMAGES for a person to look at, and what it asserts about behaviour is ' +
    'already asserted by electron.mjs, deslop.electron.mjs and launcher-identity-conflict.electron.mjs',
};

// A journey that outlives its own internal bounds has run away and fails. The measured
// worst case is cold-start.electron.mjs at 214s (its own waits inside allow 240s); every
// other journey is under 50s.
const DEFAULT_TIMEOUT_MS = 300_000;
const TIMEOUTS = {'cold-start.electron.mjs': 480_000};
const FIXTURE_START_MS = 40_000;
const PORT_FREE_MS = 10_000;
const GROUP_GRACE_MS = 8_000;

// ---------------------------------------------------------------- helpers
const now = () => process.hrtime.bigint();
const secondsSince = (start) => Number(now() - start) / 1e9;
const fmtSeconds = (value) => `${value < 100 ? value.toFixed(1) : Math.round(value)}s`;
const fmtDuration = (value) => (value >= 60 ? `${Math.floor(value / 60)}m ${Math.round(value % 60)}s` : `${Math.round(value)}s`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({port, host: '127.0.0.1'});
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function waitPortFree(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await sleep(100);
  }
  return false;
}

// Kill a whole process group, never a command line: `pkill -f <pattern>` matches the shell
// that typed it, which is how two runs of this sweep were lost. Each child here is spawned
// detached, so its pid is its group id and its children (xvfb-run's Xvfb, electron) go with
// it.
function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function groupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function stopGroup(child, graceMs = GROUP_GRACE_MS) {
  if (!child || !child.pid) return;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  killGroup(child.pid, 'SIGTERM');
  const timed = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!timed) {
    killGroup(child.pid, 'SIGKILL');
    await Promise.race([exited, sleep(graceMs)]);
  }
  if (groupAlive(child.pid)) killGroup(child.pid, 'SIGKILL');
}

// The processes that contend with a journey, read from `ps` comm rather than from a
// command-line pattern: `pkill -f <pattern>` matches the shell that typed it.
function processes() {
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid=,stat=,comm='], {encoding: 'utf8'});
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 3 && !fields[1].startsWith('Z'))
    .map(([pid, stat, comm]) => ({pid: Number(pid), stat, comm}))
    .filter((entry) => entry.pid && entry.pid !== process.pid);
}

const CONTENDERS = ['Xvfb', 'electron', 'xvfb-run'];
function contenders() {
  const found = {};
  for (const {comm} of processes()) if (CONTENDERS.includes(comm)) found[comm] = (found[comm] || 0) + 1;
  return found;
}

function describeContenders(found) {
  return Object.entries(found).map(([name, count]) => `${count} ${name}`).join(', ');
}

function pidsOf(name) {
  return processes().filter((entry) => entry.comm === name).map((entry) => entry.pid);
}

async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

// ---------------------------------------------------------------- discovery
const journeyDir = path.join(root, 'tests', 'desktop');
let discovered;
try {
  discovered = (await fs.readdir(journeyDir)).filter((name) => name.endsWith('.electron.mjs')).sort();
} catch (error) {
  console.error(`electron journeys: cannot read ${journeyDir}: ${error.message}`);
  process.exit(2);
}
if (discovered.length === 0) {
  console.error(`electron journeys: no *.electron.mjs in ${journeyDir}`);
  process.exit(2);
}
// electron.mjs itself is a journey of the list in doc/releasing.md, and is run first: it is
// the cheapest full-shell smoke.
const all = (await fs.stat(path.join(journeyDir, 'electron.mjs')).then(() => true, () => false))
  ? ['electron.mjs', ...discovered]
  : discovered;

// A journey that names the account fixture in its own source but has no entry above would
// run against nothing and fail for the wrong reason, or worse, pass against whatever else
// happens to be listening. Fail closed instead.
const fixtureDrift = [];
for (const name of all) {
  if (FIXTURES[name] || NOT_GATES[name]) continue;
  const source = await fs.readFile(path.join(journeyDir, name), 'utf8');
  if (/EASTER_API_FIXTURE_PORT|launcher_api_fixture|127\.0\.0\.1:1879[0-9]/.test(source))
    fixtureDrift.push(name);
}
// And a stale entry names a journey that no longer exists.
const vanished = [...Object.keys(FIXTURES), ...Object.keys(NOT_GATES)].filter((name) => !all.includes(name));

if (fixtureDrift.length) {
  console.error(
    `electron journeys: ${fixtureDrift.join(', ')} names the account fixture in its source but has no fixture ` +
      'entry in scripts/check-electron-journeys.mjs; add it to FIXTURES with its port',
  );
  process.exit(2);
}
if (vanished.length) {
  console.error(
    `electron journeys: scripts/check-electron-journeys.mjs names ${vanished.join(', ')}, which ` +
      `is not in ${path.relative(repo, journeyDir)}; remove it from FIXTURES/NOT_GATES`,
  );
  process.exit(2);
}

const gates = all.filter((name) => !NOT_GATES[name]);
const notGates = all.filter((name) => NOT_GATES[name]);

if (listOnly) {
  const pad = Math.max(...gates.map((name) => name.length));
  for (const name of gates) {
    const fixture = FIXTURES[name] ? `fixture :${FIXTURES[name].port}${FIXTURES[name].env ? ' ' + JSON.stringify(FIXTURES[name].env) : ''}` : 'no fixture';
    const bound = fmtSeconds((TIMEOUTS[name] || DEFAULT_TIMEOUT_MS) / 1000).replace('s', 's bound');
    console.log(`  gate  ${name.padEnd(pad)}  ${fixture.padEnd(34)} ${bound}`);
  }
  for (const name of notGates) console.log(`  --    ${name.padEnd(pad)}  not a gate: ${NOT_GATES[name]}`);
  console.log(`electron journeys: ${gates.length} gates, ${notGates.length} not a gate, root ${root}`);
  process.exit(0);
}

if (only !== null) {
  if (!all.includes(only)) {
    console.error(`electron journeys: --only names ${JSON.stringify(only)}, which is not a journey in ${journeyDir}`);
    process.exit(2);
  }
  if (NOT_GATES[only]) {
    console.error(`electron journeys: --only names ${only}, which is not a gate: ${NOT_GATES[only]}`);
    process.exit(2);
  }
}
const selected = only === null ? gates : [only];

// ---------------------------------------------------------------- prerequisites
const missing = [];
const readable = (file) => fs.access(file, fs.constants.R_OK).then(() => true, () => false);
const executable = (file) => fs.access(file, fs.constants.X_OK).then(() => true, () => false);

async function requireExecutable(file, sentence) {
  if (!(await executable(file))) missing.push(sentence);
}
async function requireFile(file, sentence) {
  if (!(await readable(file))) missing.push(sentence);
}
async function requireOnPath(command, sentence) {
  try {
    execFileSync('which', [command], {stdio: 'ignore'});
  } catch {
    missing.push(sentence);
  }
}

await requireExecutable(path.join(root, 'node_modules', 'electron', 'dist', 'electron'), `the electron binary at ${path.join(root, 'node_modules', 'electron', 'dist', 'electron')} is missing (npm ci)`);
await requireOnPath('xvfb-run', 'xvfb-run is not on PATH, and every journey runs under xvfb-run -a');

// The account fixture is needed by four of the journeys, so it is checked before the sweep
// rather than after 20 failures with the same import error.
let dockerUsable = true;
try {
  execFileSync('docker', ['inspect', '--type=container', '--format', '{{.State.Running}}', pgContainer], {stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'});
} catch (error) {
  dockerUsable = false;
  missing.push(
    `the docker container ${pgContainer} on 127.0.0.1:${pgPort} does not exist or the docker daemon is unreachable, ` +
      'so company.electron.mjs, handover.electron.mjs, providers.electron.mjs and wait-post-approval.electron.mjs cannot run',
  );
}
await requireFile(fixtureScript, `${fixtureScript} is missing, so the four journeys that drive the real account handler cannot run`);
await requireExecutable(fixturePython, `${fixturePython} is missing, so tests/launcher_api_fixture.py cannot be run with the interpreter that carries pg8000`);

if (missing.length) {
  console.error(`electron journeys: cannot run - ${missing.join('; ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------- the container
let pgWasRunning = false;
try {
  pgWasRunning = execFileSync('docker', ['inspect', '--type=container', '--format', '{{.State.Running}}', pgContainer], {encoding: 'utf8'}).trim() === 'true';
} catch {
  /* already refused above */
}
async function pgReady() {
  try {
    execFileSync('docker', ['exec', pgContainer, 'pg_isready', '-U', 'postgres'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}
async function ensurePg() {
  if (!pgWasRunning) {
    try {
      execFileSync('docker', ['start', pgContainer], {stdio: 'ignore'});
    } catch (error) {
      throw new Error(`docker start ${pgContainer} failed: ${error.message}`);
    }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await pgReady()) return;
    await sleep(300);
  }
  throw new Error(`${pgContainer} did not accept connections on 127.0.0.1:${pgPort}`);
}
function restorePg() {
  if (pgWasRunning) return;
  try {
    execFileSync('docker', ['stop', pgContainer], {stdio: 'ignore'});
  } catch {
    /* a container we cannot stop is reported by the leftover check below only if it is
       something this sweep started; docker's own state is left visible with `docker ps` */
  }
}

// ---------------------------------------------------------------- run state
const logDir = process.env.EASTER_JOURNEY_LOGS || path.resolve(
  (await fs.mkdtemp(path.join(os.tmpdir(), 'easter-journey-sweep-'))),
);
await fs.mkdir(logDir, {recursive: true});

const results = new Map();
const strayLeftovers = [];
const foreignAtStart = contenders();
let interrupted = null;
let currentGroup = null; // {child, label} so a signal can stop whatever is running
let fixtureGroup = null;

async function stopEverything() {
  await stopGroup(currentGroup && currentGroup.child);
  currentGroup = null;
  if (fixtureGroup && fixtureGroup.spec) {
    await stopGroup(fixtureGroup.child);
    await waitPortFree(fixtureGroup.spec.port, PORT_FREE_MS);
    fixtureGroup = null;
  }
  restorePg();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = signal;
    console.error(`electron journeys: ${signal} - stopping the running journey and the fixture`);
    stopEverything().then(() => process.exit(130));
  });
}

// ---------------------------------------------------------------- one journey
async function startFixture(spec, logFile) {
  if (!(await portFree(spec.port))) {
    throw new Error(`127.0.0.1:${spec.port} is already listening before the fixture started, so this journey would run against a fixture this sweep did not start`);
  }
  const handle = await fs.open(logFile, 'w');
  const child = spawn(fixturePython, ['tests/launcher_api_fixture.py'], {
    cwd: cloudRepo,
    detached: true,
    stdio: ['ignore', handle.fd, handle.fd],
    env: {
      ...process.env,
      PYTHONPATH: cloudRepo,
      EASTER_API_FIXTURE_PORT: String(spec.port),
      ...(spec.env || {}),
    },
  });
  const failure = new Promise((resolve) => {
    child.once('error', (error) => resolve(`could not start ${fixturePython}: ${error.message}`));
    child.once('exit', (code, signal) => resolve(`tests/launcher_api_fixture.py exited (${code === null ? signal : `code ${code}`}) before it answered on 127.0.0.1:${spec.port}`));
  });
  const ready = (async () => {
    const deadline = Date.now() + FIXTURE_START_MS;
    while (Date.now() < deadline) {
      if (await portOpen(spec.port)) return true;
      await sleep(100);
    }
    return false;
  })();
  const answer = await Promise.race([ready, failure]);
  await handle.close().catch(() => {});
  if (answer !== true) {
    await stopGroup(child);
    await waitPortFree(spec.port, PORT_FREE_MS);
    let tail = '';
    try {
      tail = (await fs.readFile(logFile, 'utf8')).trim().split('\n').slice(-1)[0] || '';
    } catch {
      /* nothing to add */
    }
    throw new Error(`${String(answer === false ? `the fixture did not answer on 127.0.0.1:${spec.port} within ${FIXTURE_START_MS / 1000}s` : answer)}${tail ? ` (${tail})` : ''}`);
  }
  return child;
}

// The last thing the journey said that reads like an error, and the frame that names the
// journey itself. Journeys fail through assert.equal, through Playwright timeouts and
// through a thrown Error, so this reads the stack rather than one known message.
function diagnose(output, name) {
  const lines = output.split('\n');
  const frame = new RegExp(`tests/desktop/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)(?::(\\d+))?`);
  let where = null;
  for (const line of lines) {
    const match = frame.exec(line);
    if (match) {
      where = `tests/desktop/${name}:${match[1]}${match[2] ? ':' + match[2] : ''}`;
      break;
    }
  }
  const isError = (line) =>
    /(^|[^a-z])([A-Z]\w*Error|Error:|error|Timeout|Exception)\b/.test(line) &&
    !/^\s+at\s/.test(line) &&
    !/^node:internal/.test(line) &&
    !/^\s*$/.test(line) &&
    !/^⚠|^\s+\[/.test(line);
  let lastError = null;
  for (const line of lines) if (isError(line)) lastError = line.trim();
  if (!lastError) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line && !/^at\s/.test(line) && !/^node:internal/.test(line)) {
        lastError = line;
        break;
      }
    }
  }
  return {where, lastError};
}

async function runJourney(name) {
  const spec = FIXTURES[name] || null;
  const bound = TIMEOUTS[name] || DEFAULT_TIMEOUT_MS;
  const logFile = path.join(logDir, `${name}.log`);
  const result = {name, status: 'FAIL', seconds: 0, where: null, lastError: null, note: null, fixture: null};

  if (spec) {
    const fixtureLog = path.join(logDir, `fixture-${spec.port}.log`);
    const startedAt = now();
    try {
      await ensurePg();
      fixtureGroup = {spec, child: await startFixture(spec, fixtureLog)};
      result.fixture = `:${spec.port}${spec.env ? ' provider' : ''} restarted in ${fmtSeconds(secondsSince(startedAt))}`;
    } catch (error) {
      result.note = error.message;
      result.lastError = error.message;
      await stopEverything();
      return result;
    }
  }

  const handle = await fs.open(logFile, 'w');
  const startedAt = now();
  let child;
  try {
    child = spawn('xvfb-run', ['-a', 'node', path.join('tests', 'desktop', name)], {
      cwd: root,
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd],
      env: {
        ...process.env,
        ...(spec ? {EASTER_FIXTURE_ORIGIN: `http://127.0.0.1:${spec.port}`} : {}),
      },
    });
  } finally {
    await handle.close().catch(() => {});
  }
  currentGroup = {child, label: name};
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), GROUP_GRACE_MS);
  }, bound);
  const exit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({error}));
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(timer);
  result.seconds = secondsSince(startedAt);

  // Nothing of the journey's own may outlive it: xvfb-run, its Xvfb and electron are all in
  // the group this sweep created. Give the group a moment to drain first - a killed Xvfb is
  // still in `ps` until it is reaped - and only then treat what is left as a leak.
  currentGroup = null;
  if (!(await waitUntil(() => !groupAlive(child.pid), GROUP_GRACE_MS))) {
    killGroup(child.pid, 'SIGKILL');
    if (!(await waitUntil(() => !groupAlive(child.pid), GROUP_GRACE_MS))) strayLeftovers.push(`${name}'s process group is still running`);
  }

  if (spec && fixtureGroup) {
    await stopGroup(fixtureGroup.child);
    const free = await waitPortFree(spec.port, PORT_FREE_MS);
    if (!free) strayLeftovers.push(`127.0.0.1:${spec.port} still listening after ${name}`);
    fixtureGroup = null;
  }

  let output = '';
  try {
    output = await fs.readFile(logFile, 'utf8');
  } catch (error) {
    result.note = `its log could not be read: ${error.message}`;
  }

  if (exit.error) {
    result.note = `could not start xvfb-run: ${exit.error.message}`;
    result.lastError = result.note;
    return result;
  }
  if (timedOut) {
    result.note = `ran away: killed at its ${Math.round(bound / 1000)}s bound`;
    const {where, lastError} = diagnose(output, name);
    result.where = where;
    result.lastError = lastError;
    return result;
  }
  if (exit.signal) {
    result.note = `was killed by ${exit.signal}`;
    const {where, lastError} = diagnose(output, name);
    result.where = where;
    result.lastError = lastError;
    return result;
  }
  if (exit.code !== 0) {
    result.note = `exit ${exit.code}`;
    const {where, lastError} = diagnose(output, name);
    result.where = where;
    result.lastError = lastError;
    return result;
  }
  // Exit 0 is not a verdict on its own: a journey that printed nothing produced none.
  if (output.trim().length === 0) {
    result.note = 'exit 0 but it printed nothing, so it recorded no verdict';
    return result;
  }
  result.status = 'PASS';
  return result;
}

// ---------------------------------------------------------------- the sweep
const sweepStarted = now();
const scope = only === null ? `${gates.length} gates` : `1 journey (--only ${only}, which is a diagnosis, not a gate run)`;
console.log(`electron journeys: ${scope}, one at a time, each under xvfb-run -a${only === null ? '' : ` - root ${root}`}`);
if (only === null && Object.keys(foreignAtStart).length) {
  console.log(
    `electron journeys: WARNING ${describeContenders(foreignAtStart)} already running; a journey that fails under ` +
      'contention is not a product fault (doc/releasing.md, "Run it alone")',
  );
}
for (const name of only === null ? notGates : []) console.log(`  skip  ${name}  - not a gate: ${NOT_GATES[name].split(':')[0]}`);
console.log(`electron journeys: logs in ${logDir}`);
const nameColumn = Math.max(...selected.map((name) => name.length));

for (const name of selected) {
  if (interrupted) break;
  const result = await runJourney(name);
  results.set(name, result);
  const fixtureNote = result.fixture ? `  [fixture ${result.fixture}]` : '';
  console.log(`  ${result.status === 'PASS' ? 'PASS ' : 'FAIL '} ${name.padEnd(nameColumn)} ${fmtSeconds(result.seconds).padStart(7)}${fixtureNote}`);
  if (result.status === 'FAIL') {
    if (result.where) console.log(`        at ${result.where}`);
    if (result.note) console.log(`        ${result.note}`);
    if (result.lastError) console.log(`        last error: ${result.lastError}`);
  }
}

// ---------------------------------------------------------------- leftovers
// Anything over what was already running when the sweep started was started by it. A
// process that has just been signalled is still in `ps` until it is reaped, so the counts
// are given a moment to settle before anything is called a leak - and a leak is stopped by
// pid, never by a command-line pattern, which matches the shell that typed it.
const leakedOver = async () => {
  const nowCounted = contenders();
  return Object.entries(nowCounted).filter(([name, count]) => count > (foreignAtStart[name] || 0));
};
let leaked = await leakedOver();
if (leaked.length) {
  await waitUntil(async () => (await leakedOver()).length === 0, GROUP_GRACE_MS);
  leaked = await leakedOver();
}
if (leaked.length) {
  for (const [name] of leaked) {
    for (const pid of pidsOf(name)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  await waitUntil(async () => (await leakedOver()).length === 0, GROUP_GRACE_MS);
  leaked = await leakedOver();
}

// No fixture port may still be listening, and the disposable PostgreSQL container goes back
// to the state it was found in.
let fixturePortsLeft = [];
await waitUntil(async () => {
  const open = [];
  for (const port of new Set(Object.values(FIXTURES).map((spec) => spec.port))) if (await portOpen(port)) open.push(port);
  fixturePortsLeft = open;
  return open.length === 0;
}, PORT_FREE_MS);
restorePg();
const pgNow = (() => {
  try {
    return execFileSync('docker', ['inspect', '--type=container', '--format', '{{.State.Running}}', pgContainer], {encoding: 'utf8'}).trim() === 'true';
  } catch {
    return null;
  }
})();
const containerMoved = pgNow !== null && pgNow !== pgWasRunning;

const total = secondsSince(sweepStarted);
const passed = [...results.values()].filter((result) => result.status === 'PASS').length;
// Counted, not inferred: every selected journey that has no PASS is a failure, including the
// ones a runaway or an interrupt never recorded.
const failedNames = selected.filter((name) => (results.get(name) || {status: 'FAIL'}).status !== 'PASS');
const failed = failedNames.length;
const cleanliness = [
  ...strayLeftovers,
  ...fixturePortsLeft.map((port) => `127.0.0.1:${port} still listening`),
  ...(leaked.length ? [`left ${leaked.map(([name, count]) => `${count} ${name}`).join(', ')} running`] : []),
  ...(containerMoved ? [`${pgContainer} was ${pgWasRunning ? 'running' : 'stopped'} before the sweep and is ${pgNow ? 'running' : 'stopped'} after it`] : []),
];

if (interrupted) {
  console.error(`electron journeys: interrupted by ${interrupted} after ${fmtDuration(total)}; ${selected.length - results.size} of ${selected.length} journeys have no result, so this run proves nothing`);
  process.exit(130);
}
for (const where of cleanliness) console.error(`electron journeys: cleanup - ${where}`);
if (failed === 0 && cleanliness.length === 0) {
  console.log(`electron journeys PASS: ${passed} of ${selected.length} gates passed in ${fmtDuration(total)}${notGates.length ? ` (${notGates.map((name) => name).join(', ')} not a gate)` : ''}`);
  process.exit(0);
}
console.log(
  `electron journeys FAIL: ${failed} of ${selected.length} gates failed in ${fmtDuration(total)} - ${failedNames.join(', ')}` +
    (cleanliness.length ? ` - cleanup: ${cleanliness.join('; ')}` : ''),
);
process.exit(1);
