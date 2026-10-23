// The store snapshot, through the real main process (ticket 9f6d7b16;
// doc/launcher-store.md, "Opening the store instantly").
//
// Owen, 2026-10-23: "The store pages should perhaps even pre-render the store page, and cache client
// side on launcher start-up so opening the store is instant." Opening the store used to cost a
// round trip - the page mounts, asks the account service for the catalogue and the orders, and
// paints when the answers arrive - and against a cold account service that round trip is the 18-22
// s Aurora resume behind two reads. This journey is the launcher's half of the answer:
//
//   A. a first launch with nobody signed in asks for nothing; signing in fetches the two answers
//      ONCE, writes them beside the session cache in the frozen shapes, and no credential of any
//      kind is anywhere in that file.
//   B. a second launch of the same install (the Company session restored from its vault) HOLDS
//      BOTH STORE READS OPEN ON PROMISES - never a stopwatch - and proves the prefetch is off the
//      critical path: the hero is Play and `startupReady` is true while the request is still
//      unanswered. With the answers released the file appears; then, with the service holding
//      again and quoting DIFFERENT prices, pressing Store paints the snapshot's shop with neither
//      live read answered, says it is still being confirmed in its own pending signal, and is
//      corrected the moment the service disagrees.
//   C. a snapshot written longer ago than the bound is ignored, deleted, and leaves today's store:
//      the busy ring until the service answers.
//   D. a snapshot written for ANOTHER account keeps the catalogue it can share and loses the
//      orders it cannot; signing out of the account keeps the catalogue and drops the orders.
//
// The account service is a real loopback HTTP stub, store routes included; the Microsoft legs and
// the game process are the harness's fixtures (tests/desktop/store-prefetch-harness.cjs). Nothing
// reaches the live API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { _electron as electron } from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import STORE from '../../desktop/store.cjs';
const UHS = 'fixture-uhs-0123456789abcdef0123456789abcdef';
const ACCOUNT = { id: 7, username: 'captainfixture', minecraftUuid: '12345678-90ab-cdef-1234-567890abcdef', minecraftName: 'FixtureCaptain', displayName: 'Captain Fixture', roles: ['crew'], createdAt: '2026-01-01T00:00:00Z', passwordRequired: false, microsoftLinked: true, microsoftSubject: createHash('sha256').update('xbox-uhs:' + UHS).digest('hex') };
// What the account service sells, in the frozen wire shape (doc/launcher-store.md, "The bridge").
// The prices here are the fixture's own and reach no site/ file: the launcher only ever prints what
// this stub answers with.
const SERVICE_PRODUCTS = [
  { key: 'sterling-10', name: '10 Sterling', amountMinor: 149, currency: 'USD', kind: 'sterling', creditPence: 1000 },
  { key: 'sterling-100', name: '100 Sterling', amountMinor: 695, currency: 'USD', kind: 'sterling', creditPence: 10000 },
  { key: 'donation-5', name: 'Keep the lights on', amountMinor: 500, currency: 'USD', kind: 'donation', creditPence: 0 },
];
// The same shop after an operator changed one price: it is what makes the snapshot's paint provably
// the snapshot's and not the service's.
const REPRICED = SERVICE_PRODUCTS.map((product, index) => index === 0 ? { ...product, amountMinor: 999 } : { ...product });
const SERVICE_ORDERS = [
  { sessionId: 'cs_test_a1', product: 'sterling-100', amountMinor: 695, currency: 'USD', paid: true, delivered: false, creditPence: 10000, createdAt: '2026-10-23T10:00:00.000Z' },
];
// The stub's own switches. `hold` keeps every store read open on a promise the journey releases by
// hand, which is the only clock this journey uses.
const service = { hold: false, products: SERVICE_PRODUCTS, orders: SERVICE_ORDERS, pending: [], calls: [], catalogue: 0, ordersReads: 0 };
const sessionBody = () => ({ created: false, account: ACCOUNT, session: { token: 'fixture-company-session-token', expiresAt: new Date(Date.now() + 86400000).toISOString() } });
const stub = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    service.calls.push({ method: request.method, path: request.url, body });
    const json = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
    // A store read is answered by the service, or held: the launcher's own client is what asks.
    const held = async () => {
      if (!service.hold) return;
      await new Promise((resolve) => service.pending.push(resolve));
    };
    const route = request.method + ' ' + request.url;
    if (route === 'POST /v2/accounts/microsoft') return json(200, sessionBody());
    if (route === 'POST /v2/accounts/password/login') return json(200, sessionBody());
    if (route === 'POST /v2/accounts/session/refresh') return json(200, sessionBody());
    if (route === 'GET /v2/accounts/me') return json(200, { account: ACCOUNT });
    if (route === 'GET /v2/accounts/providers') return json(200, { providers: ['microsoft'] });
    if (route === 'GET /v2/accounts/emails') return json(200, { emails: [], loginEmail: null });
    if (route === 'POST /v2/accounts/logout') { response.writeHead(204); response.end(); return; }
    if (route === 'GET /v2/accounts/store/catalogue') {
      service.catalogue += 1;
      await held();
      return json(200, { products: service.products.map((product) => ({ ...product })) });
    }
    if (route === 'GET /v2/accounts/store/orders') {
      service.ordersReads += 1;
      await held();
      return json(200, { orders: service.orders.map((order) => ({ ...order })) });
    }
    if (route === 'GET /v2/game/status') return json(200, { state: 'running', ready: true, endpoint: 'smp.easter.company:25565', since: '2026-10-19T00:00:00Z', players: 0, detail: '' });
    if (route === 'POST /v2/game/session') return json(200, { accessToken: 'fixture-minted-minecraft-token', expiresAt: new Date(Date.now() + 86400000).toISOString(), profile: { uuid: ACCOUNT.minecraftUuid, name: ACCOUNT.minecraftName } });
    response.writeHead(404, { 'Content-Type': 'text/html' });
    response.end('Not Found');
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const api = 'http://127.0.0.1:' + stub.address().port;
const vaultKey = randomBytes(32).toString('hex');
const home = await fs.mkdtemp('/tmp/store-prefetch-electron-');
const snapshotFile = path.join(home, 'store-snapshot.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const release = () => {
  const open = [...service.pending];
  service.pending.length = 0;
  for (const resolve of open) resolve();
};
// Wait until the launcher's client has asked the service for a store route, and it is held.
const waitStoreCall = async (which) => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (service.calls.some((call) => call.path === '/v2/accounts/store/' + which)) return;
    await sleep(25);
  }
  throw Error('the launcher never asked the account service for the store ' + which);
};
const waitStoreCallCount = async (which, count) => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (service.calls.filter((call) => call.path === '/v2/accounts/store/' + which).length >= count) return;
    await sleep(25);
  }
  throw Error('the launcher never asked the account service for the store ' + which + ' ' + count + ' times');
};
const snapshotOnDisk = async () => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { return JSON.parse(await fs.readFile(snapshotFile, 'utf8')); } catch { await sleep(25); }
  }
  return null;
};
const snapshotExists = async () => { try { await fs.stat(snapshotFile); return true; } catch { return false; } };
const written = async (read) => {
  const record = await snapshotOnDisk();
  return record && read(record);
};
const launch = async () => {
  const app = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron'),
    args: ['--no-sandbox', path.resolve('tests/desktop/store-prefetch-harness.cjs')],
    env: { ...process.env, EASTER_TEST_HOME: home, EASTER_VAULT_FIXTURE_KEY: vaultKey, EASTER_API_BASE_URL: api },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.easterDesktop?.mode === 'desktop');
  await page.keyboard.press('Escape');
  return { app, page, errors };
};
const statusOf = (page) => page.evaluate(() => window.easterDesktop.status());
const heroOf = (page) => page.locator('[data-desktop-play]').evaluate((node) => ({ action: node.dataset.action, text: node.innerText.replace(/\s+/g, ' ').trim() }));
const snapshotOf = (page) => page.evaluate(() => window.easterDesktop.storeSnapshot());
// The hero's own sign-in, through the account chooser the launcher opens: the device code is
// approved in the main process, and the Company session the service answers with is what the
// prefetch is then asked against.
const signIn = async (app, page) => {
  await page.locator('[data-desktop-play][data-action="signin"]').click();
  await page.getByRole('button', { name: 'Sign in with Microsoft', exact: true }).click();
  await page.locator('.desktop-code').filter({ hasText: 'STORE-TEST' }).waitFor();
  await app.evaluate(() => global.easterTestApprove());
};
try {
  // ---- A: a first launch asks for nothing, and a sign-in fetches the shop once --------
  process.stdout.write('[journey] scenario  A — a first launch, then a sign-in fetches the shop\n');
  service.hold = false;
  {
    const run = await launch();
    // Nobody is signed in, so no store read has been made or can be made: the snapshot is not a
    // public download, and this is where a launcher that fetched one anyway would show it.
    assert.equal(service.catalogue, 0, 'a signed-out launch asks the account service for no catalogue');
    assert.equal(await snapshotExists(), false, 'and writes no snapshot of its own');
    assert.equal((await snapshotOf(run.page)), null, 'the page is answered no snapshot at all');
    await signIn(run.app, run.page);
    await run.page.waitForFunction(async () => !!((await window.easterDesktop.status()).account));
    const stored = await snapshotOnDisk();
    assert(stored, 'the sign-in is followed by one fetch of the shop, written beside the session cache');
    assert.deepEqual(Object.keys(stored), [...STORE.SNAPSHOT_FIELDS], 'the file holds the whitelist and nothing else: ' + Object.keys(stored).join(', '));
    assert.equal(stored.version, STORE.SNAPSHOT_VERSION, 'it names the shape it was written in');
    assert(Number.isFinite(Date.parse(stored.writtenAt)), 'and the moment the service answered');
    assert.equal(String(stored.accountId), String(ACCOUNT.id), 'under the account it was fetched for');
    assert.deepEqual(stored.catalogue.products, SERVICE_PRODUCTS, 'the catalogue is exactly what the service sent, in its order');
    assert.deepEqual(stored.orders.orders, [{ ...SERVICE_ORDERS[0], createdAt: '2026-10-23T10:00:00.000Z' }], 'and so are the player\'s orders');
    // Nothing this launcher holds may be in there. The values are the fixture's own, so finding
    // one would be finding it in the file.
    const text = await fs.readFile(snapshotFile, 'utf8');
    for (const forbidden of ['fixture-company-session-token', 'fixture-private-refresh', 'fixture-private-ms-', 'fixture-private-minecraft-token', 'fixture-private-xsts', UHS, ACCOUNT.microsoftSubject, 'smp.easter.company', '25565'])
      assert(!text.includes(forbidden), 'the snapshot must never contain ' + forbidden);
    assert(!/"(refreshToken|accessToken|token|xstsToken|sessionKey|password|server|steamId64|microsoftSubject|email)"\s*:/.test(text), 'and never a key for one either: ' + text);
    await run.app.close();
    assert.deepEqual(run.errors, []);
    process.stdout.write('[journey] A: one fetch, three products and a row, no credential\n');
  }

  // ---- B: the startup prefetch, off the hero's path, and the instant paint -------------
  process.stdout.write('[journey] scenario  B — the startup prefetch, and the store painted from it\n');
  service.hold = true;
  {
    const before = service.catalogue;
    const run = await launch();
    // The prefetch is asked for at startup, and the service is holding it.
    await waitStoreCall('catalogue');
    assert(service.catalogue > before, 'a cold launch with a signed-in player asks for the shop once, at startup');
    // Nothing about the hero waits for it: the window is up, the launcher is usable and Play is
    // available while the request is still open. No stopwatch is involved — the answer is provably
    // still owed at the moment this is asserted.
    assert(service.pending.length >= 1, 'the store read is still open when the hero is asserted');
    const state = await statusOf(run.page);
    assert.equal(state.startupReady, true, 'the launcher is usable while the shop is being fetched');
    const hero = await heroOf(run.page);
    assert.equal(hero.action, 'play', 'and the hero is Play, not a wait: ' + hero.text);
    // The answers land, and only then does the file appear.
    release();
    const stored = await snapshotOnDisk();
    assert(stored, 'the prefetch wrote the snapshot as soon as the service answered');
    assert.deepEqual(stored.catalogue.products, SERVICE_PRODUCTS);
    // Now the operator changes a price and the service holds again: what the page paints next can
    // only be what the launcher already had.
    service.products = REPRICED;
    service.hold = true;
    const readsBefore = service.catalogue;
    // The open time, measured here rather than asserted: pressing Store must not depend on the
    // service at all, and this is the number that says so. It is printed with this journey's
    // output as evidence, never used as a bound - a bound on a clock is a flaky gate.
    await run.page.getByRole('link', { name: 'Store', exact: true }).waitFor();
    const pressed = process.hrtime.bigint();
    await run.page.evaluate(() => {
      [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Store').click();
    });
    await run.page.locator('.store-app').waitFor();
    await run.page.locator('.store-product').first().waitFor();
    const openedInMs = Number(process.hrtime.bigint() - pressed) / 1e6;
    assert.equal(await run.page.locator('.store-product').count(), 3, 'the shop the launcher cached, drawn at once');
    assert.deepEqual(
      await run.page.locator('.store-price').allInnerTexts(),
      ['$1.49', '$6.95', '$5.00'],
      'with the prices the service last sent — not the ones it is holding an answer about',
    );
    assert(service.pending.length >= 1, 'and with the live reads still unanswered, which is what makes that a paint from the snapshot');
    assert.equal(await run.page.locator('.store-busy').count(), 0, 'no busy ring over rows that are readable');
    assert.equal(
      await run.page.locator('.store-content').getAttribute('aria-busy'),
      'true',
      'the page says, in its own pending signal, that the shop is still being confirmed',
    );
    // The service answers, and it disagrees: the price is corrected at once.
    release();
    await run.page.waitForFunction(() => document.querySelector('.store-price')?.textContent === '$9.99');
    assert.deepEqual(await run.page.locator('.store-price').allInnerTexts(), ['$9.99', '$6.95', '$5.00'], 'the live answer is painted as soon as it arrives');
    assert.equal(
      await run.page.locator('.store-content').getAttribute('aria-busy'),
      'false',
      'and nothing is being confirmed any more',
    );
    assert(service.catalogue > readsBefore, 'the page still revalidated against the service');
    const after = await snapshotOnDisk();
    assert.deepEqual(after.catalogue.products.map((product) => product.amountMinor), [149, 695, 500], 'a page read does not rewrite the launcher\'s own snapshot');
    await run.app.close();
    assert.deepEqual(run.errors, []);
    run.openedInMs = openedInMs;
    process.stdout.write('[journey] B: prefetched at startup with the hero already Play, painted as $1.49 ' + Math.round(openedInMs) + ' ms after the press with the service held, corrected to $9.99 on its answer\n');
  }

  // ---- C: past the bound, the snapshot is not used at all ------------------------------
  process.stdout.write('[journey] scenario  C — a snapshot older than the bound\n');
  {
    const old = { ...(await snapshotOnDisk()), writtenAt: new Date(Date.now() - STORE.SNAPSHOT_MAX_AGE_MS - 60000).toISOString() };
    await fs.writeFile(snapshotFile, JSON.stringify(old, null, 2));
    service.hold = true;
    service.products = SERVICE_PRODUCTS;
    const run = await launch();
    await waitStoreCall('catalogue');
    let gone = false;
    for (let attempt = 0; attempt < 400 && !gone; attempt += 1) { gone = !(await snapshotExists()); if (!gone) await sleep(25); }
    assert.equal(gone, true, 'a snapshot past the 24-hour bound is deleted, so it cannot be considered twice');
    assert.equal(await snapshotOf(run.page), null, 'and nothing is published to the page');
    await run.page.getByRole('link', { name: 'Store', exact: true }).click();
    await run.page.locator('.store-app').waitFor();
    await run.page.locator('.store-busy').waitFor();
    assert.equal(await run.page.locator('.store-product').count(), 0, 'with nothing cached the store waits for the service, exactly as it did before the snapshot existed');
    release();
    await run.page.locator('.store-product').first().waitFor();
    assert.deepEqual(await run.page.locator('.store-price').allInnerTexts(), ['$1.49', '$6.95', '$5.00'], 'and paints the live answer');
    await run.app.close();
    assert.deepEqual(run.errors, []);
    process.stdout.write('[journey] C: the bound is enforced, the file is deleted, today\'s wait\n');
  }

  // ---- D: another account's orders are never this account's ---------------------------
  process.stdout.write('[journey] scenario  D — a snapshot written for another account, and a sign-out\n');
  {
    const foreign = {
      version: STORE.SNAPSHOT_VERSION,
      writtenAt: new Date().toISOString(),
      accountId: 'EC-999',
      catalogue: { products: SERVICE_PRODUCTS },
      orders: { orders: SERVICE_ORDERS },
    };
    await fs.writeFile(snapshotFile, JSON.stringify(foreign, null, 2));
    service.hold = true;
    service.products = SERVICE_PRODUCTS;
    const run = await launch();
    await waitStoreCall('catalogue');
    const published = await snapshotOf(run.page);
    assert(published, 'the catalogue is not any account\'s private data, so it is published at once');
    assert.deepEqual(published.products, SERVICE_PRODUCTS, 'and it is the shop the service last sent');
    assert.equal(published.orders, null, 'the purchases of the account that has gone are not published to this one');
    assert(Number.isFinite(Date.parse(published.writtenAt)), 'the moment, so no view has to guess at the age');
    const rewritten = await written((record) => record.orders === null && record.accountId === null);
    assert.equal(rewritten, true, 'and the file is rewritten catalogue-only, so the next start cannot find those orders either');
    // Signing out of the account keeps the catalogue and drops the orders, on disk as well.
    release();
    await snapshotOnDisk();
    await run.page.evaluate(() => window.easterDesktop.signOutAccount());
    await run.page.waitForFunction(async () => !(await window.easterDesktop.status()).account);
    let cleared = false;
    for (let attempt = 0; attempt < 400 && !cleared; attempt += 1) {
      const record = await snapshotOnDisk();
      cleared = Boolean(record && record.orders === null && record.accountId === null && record.catalogue?.products?.length);
      if (!cleared) await sleep(25);
    }
    assert.equal(cleared, true, 'signing out leaves a catalogue in the file and no orders of the account that has gone');
    const signedOut = await snapshotOf(run.page);
    assert(signedOut, 'a signed-out player is still handed the catalogue');
    assert.equal(signedOut.orders, null, 'and never orders');
    await run.app.close();
    assert.deepEqual(run.errors, []);
    process.stdout.write('[journey] D: a foreign file gives the shop and no orders, and a sign-out keeps the shop and drops the orders\n');
  }
  console.log('STORE PREFETCH PASS: a signed-out launch fetches nothing and writes nothing; signing in fetches the catalogue and the player\'s orders ONCE and writes them beside the session cache in the frozen shapes with no token, address or service-only field in the file; a cold launch with the session restored prefetches at startup while both store reads are held open on promises, and the hero is Play with startupReady true at that moment; with the service quoting a different price and holding its answer, pressing Store paints the cached shop (3 products, $1.49/$6.95/$5.00) with no busy ring and aria-busy="true", and the live answer paints the new price the instant it arrives with aria-busy="false"; a snapshot past the 24-hour bound is deleted and leaves today\'s waiting store; and a snapshot written for another account keeps the catalogue, loses its orders and is rewritten catalogue-only, as a sign-out does.');
} finally {
  await new Promise((resolve) => stub.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
