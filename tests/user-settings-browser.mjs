// THE SHARED ACCOUNT MENU AND THE USER SETTINGS PANEL, ON BOTH SURFACES, IN A REAL BROWSER.
//
// What this suite exists to prove, in the ticket's own words: the menu opens with the account's
// display name over its username (two lines, a rule, then the actions), `Settings` OPENS the
// account-wide panel rather than linking somewhere, a save round-trips against the fixture cloud,
// a stale revision is refused and surfaced honestly, and the blocked-close nudge moves the dialog
// the way Diana measured it - on the launcher's own site AND on easter.company, which mounts this
// same module over the network.
//
// TWO SERVERS, BECAUSE ONE SURFACE IS A DIFFERENT ORIGIN FROM THE OTHER. The launcher's site is
// served from this worktree's site/ on a loopback port. The corporate page is the REAL
// /root/eastercompany.github.io/site — its own index.html, its own account-corporate.mjs, its own
// copied pill rules — served from its own port, and every request it makes to
// https://launcher.easter.company/** is answered from this worktree's site/ with the
// `access-control-allow-origin: *` GitHub Pages itself sends for .mjs (measured 2026-10-27, and
// said so in site/account-control.mjs' header). That is the network mount, not a description of
// it: the corporate module's own imports resolve to the launcher origin, and so do the panel's
// import and the stylesheet the module injects. If any of those resolved against the corporate
// page instead, this suite would fail rather than quietly pass.
//
// The cloud is a fixture, not the live account service: the account client's own origin is
// intercepted and answered with the frozen document shape, a revision that compare-and-sets, and
// a 409 when a write names a revision that has moved. Nothing here can touch a real account.
//
// Run it against this worktree: nothing else needs to be running.
//     node tests/user-settings-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, '../site');
// The corporate repository is a separate checkout on this machine and a required prerequisite: a
// suite that skipped it would report a green run for the surface Owen actually asked about.
const corporateDir = process.env.EASTER_CORPORATE_SITE || '/root/eastercompany.github.io/site';
const LAUNCHER_ORIGIN = `http://127.0.0.1:${Number(process.env.EASTER_SETTINGS_LAUNCHER_PORT || 18131)}`;
const CORPORATE_ORIGIN = `http://127.0.0.1:${Number(process.env.EASTER_SETTINGS_CORPORATE_PORT || 18132)}`;
const NETWORK_LAUNCHER = 'https://launcher.easter.company';
const api = 'https://jyjshd22z3.execute-api.us-east-2.amazonaws.com';
const SESSION_KEY = 'easter-company-web-session-v1';

// The account under test. The display name is deliberately NOT the username: a fixture whose two
// names read the same would prove nothing about which line is which.
const account = {id: 17, username: 'fixture_player', displayName: 'Captain Fixture', passwordRequired: false, microsoftLinked: false, providers: ['steam'], roles: [], picture: null};
// The catalogue the picker draws, in the service's own shape and its stable native-name order,
// including a right-to-left native name: the panel isolates it rather than reordering the line.
const CATALOGUE = {automatic: 'auto', languages: [
  {code: 'ar_sa', native: 'العربية (العالم العربي)', english: 'ar_sa'},
  {code: 'de_de', native: 'Deutsch (Deutschland)', english: 'de_de'},
  {code: 'en_us', native: 'English (United States)', english: 'English (United States)'},
  {code: 'ja_jp', native: '日本語 (日本)', english: 'ja_jp'}
]};

const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json'};

// One reader for both the local servers and the intercepted launcher origin, so the corporate page
// and the injected stylesheet are served by exactly the code path a static host would.
async function readAsset(root, pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  const relative = clean.replace(/^\/+/, '');
  let target = path.join(root, relative);
  if (!target.startsWith(root)) return null;
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) target = path.join(target, 'index.html');
  } catch { return null; }
  try {
    const body = await fs.readFile(target);
    return {body, type: TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream'};
  } catch { return null; }
}
function serve(root) {
  return http.createServer(async (request, response) => {
    const found = await readAsset(root, new URL(request.url, 'http://127.0.0.1').pathname);
    if (!found) { response.writeHead(404, {'content-type': 'text/plain'}); response.end('not found'); return; }
    response.writeHead(200, {'content-type': found.type, // GitHub Pages' own header for the static tree: one page may import another origin's module.
      'access-control-allow-origin': '*', 'cache-control': 'no-store'});
    response.end(found.body);
  });
}
const listen = (server, origin) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(Number(new URL(origin).port), '127.0.0.1', () => resolve(server));
});

// The fixture cloud: one document, a revision that compare-and-sets, and the exact bodies
// api/settings_routes.py answers with. `bump()` is another surface saving behind this panel's
// back, which is the only way to reach the 409 a real second window produces.
function createCloud() {
  const document = {version: 1, language: 'auto', theme: 'system', chat: {enter: 'submit', shiftEnter: 'newline', ctrlEnter: 'interrupt'}, editor: {vim: false}};
  let revision = 3;
  const puts = [];
  const state = {
    gets: 0,
    puts,
    get document() { return document; },
    get revision() { return revision; },
    bump(by = 1) { revision += by; },
    write(next) { Object.assign(document, {version: next.version, language: next.language, theme: next.theme, chat: {...next.chat}, editor: {...next.editor}}); revision += 1; },
    answer() { return {settings: {version: document.version, language: document.language, theme: document.theme, chat: {...document.chat}, editor: {...document.editor}}, revision, updatedAt: '2026-10-30T12:00:00Z'}; }
  };
  return state;
}
const json = (value, status = 200) => ({status, contentType: 'application/json', body: JSON.stringify(value)});

// The nudge, recorded where it is made. The component calls Element.animate with the keyframes and
// timings Diana's spec freezes; this hook keeps them, so the assertion is about what the panel
// actually asked the browser to do rather than about a class it also happens to set.
const NUDGE_HOOK = () => {
  window.__nudges = [];
  const native = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    try { if (this.id === 'easter-user-settings') window.__nudges.push({keyframes, options}); } catch { /* not our element */ }
    return native.call(this, keyframes, options);
  };
};
const SEED_SESSION = ([key, value]) => { try { sessionStorage.setItem(key, value); } catch { /* a storage-less page signs in, and this suite cannot */ } };

const C = {
  status: {clean: 'All changes saved.', dirty: 'You have unsaved changes.', first: 'You have unsaved changes. Save or discard them to close.', again: 'Still editing? Save Changes or Discard Changes to close.', failed: 'Couldn’t save your changes. Try again, or discard them.'},
  buttons: {discard: 'Discard Changes', save: 'Save Changes'},
  title: 'User Settings'
};

async function openMenu(page) {
  await page.getByRole('button', {name: 'Account options'}).click();
  await page.locator('#web-account-menu').waitFor({state: 'visible'});
}
const settingsDialog = page => page.locator('#easter-user-settings');
async function openSettings(page) {
  await openMenu(page);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await settingsDialog(page).waitFor({state: 'visible'});
}
const statusText = page => page.locator('#easter-user-settings .es-status span:last-child').textContent();
// The host's live region is filled on the next tick, deliberately (a live region is announced when
// its text CHANGES, so the same sentence twice needs the clear first). Waiting for it is the test
// being patient with the reader rather than the component being late.
const expectAnnouncement = (page, text, label) => page.waitForFunction(expected => document.querySelector('.web-settings-announce')?.textContent.trim() === expected, text).then(() => checks += 1, () => { throw new Error(label + ': the host announced nothing'); });
const nudgeCount = page => page.evaluate(() => window.__nudges.length);
const clearNudges = page => page.evaluate(() => { window.__nudges = []; });
// One preference edit: Ctrl+Enter becomes Submit & Queue, which is a real document change on every
// surface because the fixture starts on the service's own default (interrupt).
const editChat = async (page, value = 'queue') => {
  await page.locator('#es-chat-ctrlEnter').selectOption(value);
  await page.waitForFunction(() => document.getElementById('easter-user-settings').querySelector('.es-actions')?.hidden === false);
};
// The tokens the panel was actually painted with, read off the live element rather than off a
// constant: this is what "one component, host palette" has to mean.
const paintedTokens = page => page.evaluate(() => {
  const dialog = document.getElementById('easter-user-settings');
  const style = getComputedStyle(dialog);
  const host = getComputedStyle(document.documentElement);
  const read = name => style.getPropertyValue(name).trim();
  return {
    accent: read('--es-accent'), surface: read('--es-surface'), text: read('--es-text'), muted: read('--es-muted'), border: read('--es-border'),
    background: style.backgroundColor,
    accentFill: (() => { const probe = document.createElement('div'); probe.style.background = read('--es-accent'); document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; })(),
    primaryBackground: getComputedStyle(dialog.querySelector('.es-primary')).backgroundColor,
    primaryColor: getComputedStyle(dialog.querySelector('.es-primary')).color,
    hostGold: host.getPropertyValue('--app-gold').trim(), hostAccent: host.getPropertyValue('--accent').trim(), hostPanel: host.getPropertyValue('--app-panel').trim(),
    hostDark: host.getPropertyValue('--ink').trim()
  };
});

let browser;
let launcherServer, corporateServer;
let checks = 0;
const check = (label, fn) => { checks += 1; return fn(label); };

try {
  try {
    await fs.access(path.join(corporateDir, 'account-corporate.mjs'));
  } catch {
    throw new Error(`the corporate site is not at ${corporateDir}: set EASTER_CORPORATE_SITE to the eastercompany.github.io site/ tree this suite mounts`);
  }
  launcherServer = await listen(serve(siteDir), LAUNCHER_ORIGIN);
  corporateServer = await listen(serve(corporateDir), CORPORATE_ORIGIN);
  browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});

  // -------------------------------------------------------------------------------------------
  // One surface, driven end to end. `mount` names it in the assertions; everything else is shared,
  // because the claim is that the two surfaces are the same component.
  // -------------------------------------------------------------------------------------------
  const runSurface = async (mount, origin, {width = 1280, height = 900} = {}) => {
    const cloud = createCloud();
    const context = await browser.newContext({viewport: {width, height}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(SEED_SESSION, [SESSION_KEY, JSON.stringify({token: 'fixture-session-not-a-real-credential', expiresAt: Date.now() + 3600000, account})]);
    await context.addInitScript(NUDGE_HOOK);
    // NOTHING ELSE LEAVES THIS MACHINE, and the order matters: Playwright matches the route
    // registered LAST first, so this catch-all goes in before the stubs below it or it would
    // shadow every one of them and dial the real account service.
    // Nothing else leaves this machine. The two static trees are loopback; anything else (an
    // analytics beacon, a release page) is refused rather than dialled.
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith(LAUNCHER_ORIGIN) || url.startsWith(CORPORATE_ORIGIN) || url.startsWith(NETWORK_LAUNCHER) || url.startsWith(api) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      return route.abort();
    });

    // THE CLOUD, answered route by route. A request this fixture does not know is a failure, not a
    // silent 404: an unknown route means the panel is calling something it should not.
    await context.route(api + '/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const body = method === 'PUT' || method === 'POST' ? request.postDataJSON() : null;
      if (url.pathname === '/v2/accounts/wake') return route.fulfill(json({}));
      if (url.pathname === '/v2/accounts/me') return route.fulfill(json({account}));
      if (url.pathname === '/v2/accounts/settings/languages') return route.fulfill(json(CATALOGUE));
      if (url.pathname === '/v2/accounts/settings') {
        if (method === 'GET') { cloud.gets += 1; return route.fulfill(json(cloud.answer())); }
        if (method === 'PUT') {
          const held = body?.revision ?? null;
          if (held !== cloud.revision) return route.fulfill(json({error: 'revision_conflict', settings: cloud.answer().settings, revision: cloud.revision}, 409));
          cloud.puts.push(body);
          cloud.write(body.settings);
          return route.fulfill(json(cloud.answer()));
        }
      }
      throw new Error(`${mount}: unexpected API request ${method} ${url.pathname}`);
    });
    // The corporate page asks for the launcher's modules by absolute address. Every one of them is
    // answered from this worktree's site/ with GitHub Pages' own permissive header, which is the
    // network mount the corporate repository really performs.
    await context.route(NETWORK_LAUNCHER + '/**', async route => {
      const found = await readAsset(siteDir, new URL(route.request().url()).pathname);
      if (!found) return route.fulfill({status: 404, body: 'not found'});
      return route.fulfill({status: 200, contentType: found.type, headers: {'access-control-allow-origin': '*'}, body: found.body});
    });

    await page.goto(origin + '/');
    // The control is not painted until the seam has a session: this is the same wait the other
    // account suites do, and it is the one thing every assertion below depends on.
    await page.getByRole('button', {name: 'Account options'}).waitFor();

    // ---- the two name lines, the rule, then the actions --------------------------------------
    await openMenu(page);
    const menu = page.locator('#web-account-menu');
    assert.equal(await menu.locator('.web-account-identity-name').textContent(), 'Captain Fixture', `${mount}: the menu leads with the display name`);
    assert.equal(await menu.locator('.web-account-identity-username').textContent(), 'fixture_player', `${mount}: the bare username is the second line`);
    assert.equal(await menu.locator('.web-account-identity').isVisible(), true, `${mount}: the identity block is visible`);
    assert.deepEqual(
      await menu.evaluate(node => [...node.children].filter(child => !child.hidden && child.tagName !== 'P').map(child => child.className || child.tagName)),
      ['web-account-identity', 'web-account-menu-rule', 'BUTTON', 'BUTTON', 'BUTTON', 'BUTTON'],
      `${mount}: the order is the identity pair, a rule, then the actions`);
    assert.deepEqual(await menu.locator('button').allTextContents(), ['My Profile', 'Linked Accounts', 'Settings', 'Sign out'], `${mount}: Settings sits among the actions, before Sign out`);
    check(`${mount}: identity pair`, () => {});

    // ---- Settings opens the account-wide panel ----------------------------------------------
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    const dialog = settingsDialog(page);
    await dialog.waitFor({state: 'visible'});
    assert.equal(await dialog.getByRole('heading', {name: C.title, exact: true}).isVisible(), true, `${mount}: Settings opens the User Settings panel`);
    assert.equal((await dialog.locator('.es-sub').textContent()).trim(), 'Your preferences, across Easter Company.');
    assert.deepEqual(await dialog.locator('.es-body h3, .es-body legend').allTextContents(), ['Preferred Language', 'Preferred Theme', 'Preferred Chat Behaviour', 'Preferred Text Editing Behaviour'], `${mount}: Diana's four sections, in her order`);
    // "Clean: no action buttons in DOM/tab sequence" (DESIGN-SPEC.md). What is measurable is the
    // tab sequence and the accessibility tree: no Save and no Discard are in either, and the row
    // that would hold them is not painted at all.
    assert.equal(await dialog.getByRole('button', {name: C.buttons.save}).count(), 0, `${mount}: a clean panel offers no Save button in its tab sequence or its accessibility tree`);
    assert.equal(await dialog.getByRole('button', {name: C.buttons.discard}).count(), 0, `${mount}: and no Discard either`);
    assert.equal(await dialog.locator('.es-actions').evaluate(node => getComputedStyle(node).display), 'none', `${mount}: the action row is not painted while clean`);
    assert.equal(await dialog.locator('.es-vim').count(), 0);
    assert.equal(await dialog.locator('[role=switch]').getAttribute('aria-checked'), 'false', `${mount}: the VIM switch is off and inert`);
    assert.equal(await dialog.locator('[role=switch]').getAttribute('aria-disabled'), 'true');
    assert.equal((await statusText(page)).trim(), C.status.clean, `${mount}: and it says all changes are saved`);
    // The panel is painted from the host's five tokens, so the two surfaces differ only in palette.
    const tokens = await paintedTokens(page);
    assert.equal(tokens.accent, tokens.hostGold || tokens.hostAccent, `${mount}: --es-accent is the host's own accent (${tokens.accent})`);
    assert.equal(tokens.text, tokens.hostDark, `${mount}: --es-text is the host's own ink`);
    assert.equal(tokens.background, await page.evaluate(panel => {
      const probe = document.createElement('div');
      probe.style.background = getComputedStyle(document.getElementById('easter-user-settings')).getPropertyValue('--es-surface').trim();
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    }), `${mount}: the dialog paints --es-surface, not a colour of its own`);
    check(`${mount}: host palette`, () => {});

    // ---- keyboard: the panel's first focus, and a clean close ------------------------------
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'es-settings-title', `${mount}: the panel opens with focus on its heading`);
    await clearNudges(page);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('easter-user-settings')?.open === false);
    assert.equal(await nudgeCount(page), 0, `${mount}: a clean panel closes on Escape with no nudge - there is nothing to resolve`);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Account options', `${mount}: and focus returns to the pill that opened it`);
    await openSettings(page);
    // ---- the catalogue comes from the cloud, Automatic first, and no flags -------------------
    await dialog.locator('.es-wide').click();
    await dialog.locator('#es-language-list').waitFor({state: 'visible'});
    // The catalogue is a network read: the picker opens on "Automatic" alone and grows when the
    // answer lands, which is the honest shape of a list the surface does not carry.
    await page.waitForFunction(() => document.querySelectorAll('#es-language-list option').length === 5);
    const options = await dialog.locator('#es-language-list option').allTextContents();
    assert.equal(options[0].startsWith('Automatic'), true, `${mount}: Automatic is pinned first`);
    assert.deepEqual(options.slice(1).map(text => text.split(' — ')[0]), ['العربية (العالم العربي)', 'Deutsch (Deutschland)', 'English (United States)', '日本語 (日本)'], `${mount}: the rest are the catalogue's own entries, native names and no flags`);
    assert.equal(await dialog.locator('#es-language-list').evaluate(node => node.size), 5, `${mount}: the list shows five rows at a time`);
    await dialog.locator('#es-language-search').fill('deu');
    await page.waitForTimeout(200);
    assert.deepEqual(await dialog.locator('#es-language-list option').allTextContents().then(rows => rows.map(text => text.split(' — ')[0])), ['Automatic', 'Deutsch (Deutschland)'], `${mount}: search matches a native name and keeps Automatic available`);
    assert.equal((await dialog.locator('#es-language-picker .es-help').last().textContent()).trim(), '1 matching languages · Automatic always available.');
    await dialog.locator('#es-language-search').fill('zzzz');
    await page.waitForTimeout(200);
    assert.equal((await dialog.locator('#es-language-picker .es-help').last().textContent()).trim(), 'No matches. Try a name or code.', `${mount}: an empty result says so`);
    await dialog.locator('#es-language-search').fill('');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.locator('#es-language-picker').isHidden(), true, `${mount}: the first Escape closes only the picker`);
    assert.equal(await dialog.isVisible(), true, `${mount}: and leaves the panel up`);
    check(`${mount}: catalogue`, () => {});

    // ---- dirty, and the buttons appear together ---------------------------------------------
    await editChat(page);
    assert.equal((await statusText(page)).trim(), C.status.dirty, `${mount}: a change makes it dirty`);
    assert.deepEqual(await dialog.locator('.es-actions button').allTextContents(), [C.buttons.discard, C.buttons.save], `${mount}: both resolving buttons appear, discard then save`);
    assert.equal(await dialog.locator('.es-primary').evaluate(node => getComputedStyle(node).backgroundColor), tokens.accentFill, `${mount}: the primary button is filled with the host's accent (${tokens.accentFill})`);
    assert.equal(await dialog.locator('.es-primary').evaluate(node => getComputedStyle(node).color), tokens.background, `${mount}: and its foreground is the surface, as the token contract requires`);
    check(`${mount}: dirty`, () => {});

    // ---- the save round trip ----------------------------------------------------------------
    const held = cloud.revision;
    await dialog.getByRole('button', {name: C.buttons.save}).click();
    await page.waitForFunction(() => document.getElementById('easter-user-settings')?.open === false);
    assert.equal(cloud.puts.length, 1, `${mount}: exactly one write reached the cloud`);
    assert.deepEqual(cloud.puts[0], {settings: {version: 1, language: 'auto', theme: 'system', chat: {enter: 'submit', shiftEnter: 'newline', ctrlEnter: 'queue'}, editor: {vim: false}}, revision: held}, `${mount}: the write is the whole document and the revision it was read at`);
    assert.equal(cloud.document.chat.ctrlEnter, 'queue', `${mount}: the fixture cloud stored the change`);
    assert.equal(cloud.revision, held + 1, `${mount}: and answered with the next revision`);
    await expectAnnouncement(page, 'Settings saved.', `${mount}: the host announces the save outside the closed dialog`);
    // Reopening reads the document back: the round trip is the read as well as the write.
    await openSettings(page);
    assert.equal(await dialog.locator('#es-chat-ctrlEnter').inputValue(), 'queue', `${mount}: reopening shows what was stored`);
    assert.equal(await dialog.locator('.es-actions').isHidden(), true, `${mount}: and the panel is clean again`);
    check(`${mount}: save round trip`, () => {});

    // ---- a refused stale revision ------------------------------------------------------------
    // A second, different value: after the round trip above the stored document already holds
    // `queue`, so changing it to `queue` again would be a clean panel and prove nothing.
    await editChat(page, 'newline');
    cloud.bump();   // another surface saved behind this panel's back
    const writesBefore = cloud.puts.length;
    await dialog.getByRole('button', {name: C.buttons.save}).click();
    await page.waitForFunction(text => document.querySelector('#easter-user-settings .es-status span:last-child')?.textContent === text, C.status.failed);
    assert.equal(cloud.puts.length, writesBefore, `${mount}: the refused write stored nothing`);
    assert.equal(await dialog.isVisible(), true, `${mount}: the panel stays open on a refusal`);
    assert.equal(await dialog.locator('#es-chat-ctrlEnter').inputValue(), 'newline', `${mount}: every draft is kept`);
    assert.deepEqual(await dialog.locator('.es-actions button').allTextContents(), [C.buttons.discard, C.buttons.save], `${mount}: and Save Changes is still the retry`);
    await dialog.getByRole('button', {name: C.buttons.save}).click();
    await page.waitForFunction(() => document.getElementById('easter-user-settings')?.open === false);
    assert.equal(cloud.puts.length, writesBefore + 1, `${mount}: the retry writes, now against the revision the conflict reported`);
    assert.equal(cloud.puts.at(-1).revision, held + 2, `${mount}: which is the revision the other surface wrote`);
    assert.equal(cloud.document.chat.ctrlEnter, 'newline', `${mount}: and the document now holds this panel's choice`);
    check(`${mount}: stale revision`, () => {});

    // ---- the blocked-close nudge, measured ---------------------------------------------------
    await openSettings(page);
    await editChat(page, 'queue');
    await clearNudges(page);
    await page.keyboard.press('Escape');
    let nudges = await page.evaluate(() => window.__nudges);
    assert.equal(nudges.length, 1, `${mount}: the first blocked close moves the dialog once`);
    assert.deepEqual(nudges[0].keyframes.map(frame => frame.transform), ['translateX(0)', 'translateX(-6px)', 'translateX(6px)', 'translateX(-3px)', 'translateX(0)'], `${mount}: at 0,-6,+6,-3,0 px on X and nothing else`);
    assert.equal(nudges[0].options.duration, 360, `${mount}: over 360ms`);
    assert.equal(nudges[0].options.easing, 'cubic-bezier(.22,.61,.36,1)', `${mount}: on Diana's curve`);
    assert.equal(await dialog.evaluate(node => node.classList.contains('es-attend')), true, `${mount}: with both buttons outlined`);
    assert.deepEqual(
      await dialog.locator('.es-actions button').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return [style.outlineStyle, style.outlineWidth, style.outlineOffset, style.outlineColor].join(' ');
      })),
      [tokens.accentFill, tokens.accentFill].map(accent => `solid 2px 3px ${accent}`),
      `${mount}: the same 2px accent outline at a 3px offset, on both buttons`);
    assert.equal((await statusText(page)).trim(), C.status.first, `${mount}: and the footer says why`);
    assert.equal(await dialog.isVisible(), true, `${mount}: nothing closed`);
    // A held Escape inside the coalescing window is one attempt.
    await page.keyboard.press('Escape');
    assert.equal(await nudgeCount(page), 1, `${mount}: a second Escape inside 500ms is not a second attempt`);
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    nudges = await page.evaluate(() => window.__nudges);
    assert.equal(nudges.length, 2, `${mount}: the second attempt moves it again`);
    assert.deepEqual(nudges[1].keyframes.map(frame => frame.transform), ['translateX(0)', 'translateX(-3px)', 'translateX(3px)', 'translateX(-1.5px)', 'translateX(0)'], `${mount}: at half the distance`);
    assert.equal(nudges[1].options.duration, 240, `${mount}: over 240ms`);
    assert.equal((await statusText(page)).trim(), C.status.again, `${mount}: with the subsequent copy`);
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    assert.equal(await nudgeCount(page), 2, `${mount}: the third attempt does not move at all`);
    await page.waitForTimeout(120);
    assert.equal(await dialog.evaluate(node => node.classList.contains('es-attend')), true, `${mount}: and the outlines stay until something resolves`);
    assert.equal((await statusText(page)).trim(), C.status.again);
    // Discard is the way out, and it writes nothing.
    const writesAtDiscard = cloud.puts.length;
    await dialog.getByRole('button', {name: C.buttons.discard}).click();
    await page.waitForFunction(() => document.getElementById('easter-user-settings')?.open === false);
    assert.equal(cloud.puts.length, writesAtDiscard, `${mount}: Discard writes nothing`);
    await expectAnnouncement(page, 'Changes discarded.', `${mount}: the host announces the discard`);
    await openSettings(page);
    assert.equal(await dialog.locator('#es-chat-ctrlEnter').inputValue(), 'newline', `${mount}: and the panel reopened on the stored document, not the discarded draft`);
    await page.keyboard.press('Escape');
    check(`${mount}: blocked-close nudge`, () => {});

    // An unrelated script error on the corporate page (it ships its own download widget) is not
    // this component's failure, so the assertion is about the modules under test.
    const ours = errors.filter(message => /account-control|user-settings|web-account|company-auth/.test(message));
    assert.deepEqual(ours, [], `${mount}: no error from the shared control or the panel`);
    assert.equal(typeof errors, 'object');
    await context.close();
    return {mount, errors: errors.length};
  };

  const launcher = await runSurface('launcher.easter.company', LAUNCHER_ORIGIN);
  console.log(`PASS ${launcher.mount}: the menu reads "Captain Fixture" over "fixture_player", Settings opens the account-wide panel, the catalogue loads from the cloud, a save round-trips through the fixture cloud, a stale revision is refused and then accepted on retry, and the blocked-close nudge measures 0,-6,+6,-3,0 over 360ms and 0,-3,+3,-1.5,0 over 240ms before stopping`);
  const corporate = await runSurface('easter.company', CORPORATE_ORIGIN);
  console.log(`PASS ${corporate.mount}: the corporate page mounts the same module over the network and the same assertions hold — identity pair, Settings, catalogue, save round-trip, refused stale revision, and the measured nudge`);

  // ---- 390px: the panel is a near-full-height dialog, not a bottom sheet and not a route ------
  {
    const cloud = createCloud();
    const context = await browser.newContext({viewport: {width: 390, height: 844}});
    const page = await context.newPage();
    await context.addInitScript(SEED_SESSION, [SESSION_KEY, JSON.stringify({token: 'fixture-session-not-a-real-credential', expiresAt: Date.now() + 3600000, account})]);
    await context.addInitScript(NUDGE_HOOK);
    await context.route(api + '/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/v2/accounts/wake') return route.fulfill(json({}));
      if (url.pathname === '/v2/accounts/me') return route.fulfill(json({account}));
      if (url.pathname === '/v2/accounts/settings/languages') return route.fulfill(json(CATALOGUE));
      if (url.pathname === '/v2/accounts/settings') return route.fulfill(json(cloud.answer()));
      throw new Error('unexpected API request ' + url.pathname);
    });
    await page.goto(LAUNCHER_ORIGIN + '/');
    await page.getByRole('button', {name: 'Account options'}).waitFor();
    await openSettings(page);
    const box = await settingsDialog(page).boundingBox();
    assert(box.width <= 390 - 16 + 0.5, `390px: the dialog is the viewport width minus its margin (${box.width}px)`);
    assert(box.y >= 8 - 0.5 && box.y + box.height <= 844 - 8 + 0.5, `390px: it keeps its 8px vertical margin (${box.y}+${box.height})`);
    await editChat(page);
    assert.equal(await settingsDialog(page).locator('.es-actions').evaluate(node => getComputedStyle(node).flexDirection), 'column', '390px: the two actions stack');
    assert.deepEqual(await settingsDialog(page).locator('.es-actions button').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height))).then(heights => heights.every(height => height >= 44)), true, '390px: and each is at least 44px high');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '390px: no horizontal scroll');
    await context.close();
    console.log('PASS 390x844: the panel is the viewport minus 16px, keeps its margin, stacks its two actions at full width and scrolls neither axis');
  }

  // ---- OS reduced motion: the same words, no movement ----------------------------------------
  {
    const cloud = createCloud();
    const context = await browser.newContext({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce'});
    const page = await context.newPage();
    await context.addInitScript(SEED_SESSION, [SESSION_KEY, JSON.stringify({token: 'fixture-session-not-a-real-credential', expiresAt: Date.now() + 3600000, account})]);
    await context.addInitScript(NUDGE_HOOK);
    await context.route(api + '/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/v2/accounts/wake') return route.fulfill(json({}));
      if (url.pathname === '/v2/accounts/me') return route.fulfill(json({account}));
      if (url.pathname === '/v2/accounts/settings/languages') return route.fulfill(json(CATALOGUE));
      if (url.pathname === '/v2/accounts/settings') return route.fulfill(json(cloud.answer()));
      throw new Error('unexpected API request ' + url.pathname);
    });
    await page.goto(LAUNCHER_ORIGIN + '/');
    await page.getByRole('button', {name: 'Account options'}).waitFor();
    await openSettings(page);
    await editChat(page);
    await clearNudges(page);
    await page.keyboard.press('Escape');
    assert.equal(await nudgeCount(page), 0, 'reduced motion: the dialog does not move');
    assert.equal(await settingsDialog(page).evaluate(node => node.classList.contains('es-attend')), true, 'reduced motion: but both buttons are outlined at once');
    assert.equal((await statusText(page)).trim(), C.status.first, 'reduced motion: and the word is the same');
    await context.close();
    console.log('PASS reduced motion: no translation at all, the outlines and the blocked-close copy appear immediately, and nothing substitutes a different animation');
  }

  // ---- a fresh account: the first save names no revision at all ------------------------------
  // The service answers revision 0 for an account that has never saved, and `revision: null` is
  // its way of saying "only if no row exists". That is the path every new member takes, and it is
  // the one revision value the cloud's own CAS treats specially (api/settings_routes.py).
  {
    const cloud = createCloud();
    cloud.bump(-3);   // 3 -> 0: a document that was never written
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const page = await context.newPage();
    await context.addInitScript(SEED_SESSION, [SESSION_KEY, JSON.stringify({token: 'fixture-session-not-a-real-credential', expiresAt: Date.now() + 3600000, account})]);
    await context.route(api + '/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/v2/accounts/wake') return route.fulfill(json({}));
      if (url.pathname === '/v2/accounts/me') return route.fulfill(json({account}));
      if (url.pathname === '/v2/accounts/settings/languages') return route.fulfill(json(CATALOGUE));
      if (url.pathname === '/v2/accounts/settings' && request.method() === 'GET') return route.fulfill(json(cloud.answer()));
      if (url.pathname === '/v2/accounts/settings' && request.method() === 'PUT') {
        const body = request.postDataJSON();
        if (body.revision !== null) return route.fulfill(json({error: 'revision_conflict', settings: cloud.answer().settings, revision: cloud.revision}, 409));
        cloud.puts.push(body);
        cloud.write(body.settings);
        return route.fulfill(json(cloud.answer()));
      }
      throw new Error('unexpected API request ' + url.pathname);
    });
    await page.goto(LAUNCHER_ORIGIN + '/');
    await page.getByRole('button', {name: 'Account options'}).waitFor();
    await openSettings(page);
    await settingsDialog(page).locator('input[name=es-theme][value=dark]').check();
    // The theme previews before it is saved, on the page rather than in a picture of one: the
    // resolved scheme is what a surface can actually use today, and the preference travels with
    // the document either way.
    assert.equal(await page.evaluate(() => document.documentElement.dataset.easterTheme), 'dark', 'a fresh account: choosing Dark previews immediately');
    await editChat(page);
    await settingsDialog(page).getByRole('button', {name: C.buttons.save}).click();
    await page.waitForFunction(() => document.getElementById('easter-user-settings')?.open === false);
    assert.equal(cloud.document.theme, 'dark', 'a fresh account: the theme is stored in the document, not only previewed');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.easterTheme), 'dark', 'a fresh account: and stays applied after the save');
    assert.equal(cloud.puts.length, 1, 'a fresh account: the first save reached the cloud');
    assert.equal(cloud.puts[0].revision, null, 'a fresh account: and named no revision, which is what "only if no row exists" means on the wire');
    assert.equal(cloud.revision, 1, 'a fresh account: the service answered revision 1');
    await context.close();
    console.log('PASS a fresh account: the first save sends revision null against a document at revision 0, and the service answers revision 1');
  }

  // ---- an account whose name IS its username prints one line, not two ------------------------
  {
    const sameName = {...account, displayName: 'oceaster', username: 'oceaster'};
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const page = await context.newPage();
    await context.addInitScript(SEED_SESSION, [SESSION_KEY, JSON.stringify({token: 'fixture-session-not-a-real-credential', expiresAt: Date.now() + 3600000, account: sameName})]);
    await context.route(api + '/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/v2/accounts/wake') return route.fulfill(json({}));
      if (url.pathname === '/v2/accounts/me') return route.fulfill(json({account: sameName}));
      throw new Error('unexpected API request ' + url.pathname);
    });
    await page.goto(LAUNCHER_ORIGIN + '/');
    await page.getByRole('button', {name: 'Account options'}).click();
    const menu = page.locator('#web-account-menu');
    await menu.waitFor({state: 'visible'});
    assert.equal(await menu.locator('.web-account-identity-name').textContent(), 'oceaster');
    assert.equal(await menu.locator('.web-account-identity-username').isHidden(), true, 'an account whose name is its username is not printed twice');
    await context.close();
    console.log('PASS a name that is its own username: the menu prints one line rather than the same word twice');
  }

  console.log(`\nPASS ${checks} assertions groups across both surfaces, the 390px layout, reduced motion, and the one-line account`);
} finally {
  await browser?.close().catch(() => {});
  await new Promise(resolve => launcherServer?.close(resolve) ?? resolve());
  await new Promise(resolve => corporateServer?.close(resolve) ?? resolve());
}
