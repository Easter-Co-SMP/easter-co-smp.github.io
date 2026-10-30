/**
 * THE PAGE'S THEME ON THE LAUNCHER'S OWN PAGES, AND ON SIGN-IN / SIGN-OUT.
 *
 * The same gap the corporate site had, in the shared control every launcher page mounts: the
 * only thing that ever published `data-easter-theme` was the settings panel's applyTheme(), so a
 * page wore the OS default until somebody opened the panel. Owen, 2026-10-30, reported it on
 * easter.company and asked for the same behaviour everywhere.
 *
 * THREE THINGS ARE MEASURED, on this repository's real pages and its real modules:
 *   1. a signed-out launcher page publishes `system` on load, from the OS, with no panel;
 *   2. a signed-in one publishes the account's saved Theme setting on load, with no panel;
 *   3. signing in and signing out move it between those two answers **inside one document** —
 *      a fake account service is injected through the seam's own `client` argument, so the
 *      switch is the real subscription doing the work, not a reload.
 *
 * The launcher site itself publishes no light palette — only `color-scheme` and the panel's own
 * surfaces follow the theme here — so the assertions are the attribute and `color-scheme`, not a
 * background colour. The corporate site, which does have Diana's light palette, measures `--bg`
 * in its own gate (eastercompany.github.io/scripts/page_theme_browser.mjs).
 *
 * Run: node tests/page-theme-browser.mjs
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {readFileSync, existsSync} from 'node:fs';
import {extname, join} from 'node:path';
import {tmpdir} from 'node:os';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE
  || '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs');

const site = new URL('..', import.meta.url).pathname.replace(/\/tests\/?$/, '') + 'site';
const output = process.env.EASTER_THEME_OUTPUT || join(tmpdir(), 'launcher-theme-review');
await mkdir(output, {recursive: true});
const API = 'https://jyjshd22z3.execute-api.us-east-2.amazonaws.com';
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
               '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'};
const ACCOUNT = {id: 34, username: 'owen', displayName: 'Owen Easter', minecraftName: 'OCEaster',
                 roles: ['owner'], passwordRequired: false, microsoftLinked: false, providers: []};

// A page that mounts the shared control with a FAKE client, so sign-in and sign-out are the
// control's own subscription doing the work. It is served from this origin and imports the real
// modules; nothing about the control is stubbed except the account service behind the seam.
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>control harness</title></head><body>
<header class="site-header"><nav aria-label="Main navigation"></nav></header>
<script type="module">
import {createWebAccount} from './web-account.mjs';
import {mountAccountControl} from './account-control.mjs';
const ACCOUNT=${JSON.stringify(ACCOUNT)};
// THE SHAPE THE REAL CLIENT ANSWERS: AccountClient.settings() resolves the DOCUMENT
// ({settings, revision, updatedAt}); the seam is what wraps an answer in {ok, value}. A fake that
// returned {ok,value} here would agree with its own caller and prove nothing.
const settingsDocument=()=>({settings:{version:1,language:'auto',theme:'light',
  chat:{enter:'submit',shiftEnter:'newline',ctrlEnter:'queue'},editor:{vim:false}},revision:3,updatedAt:null});
const seam=createWebAccount({client:{
  settings:()=>settingsDocument(), wake:()=>{},
  saveSettings:()=>settingsDocument(),
  me:async()=>({account:ACCOUNT}),
  loginPassword:async()=>({session:{token:'fake-token',expiresAt:Date.now()+3600000},account:ACCOUNT}),
  logout:async()=>{},
}});
const nav=document.querySelector('nav');
window.__control=await mountAccountControl({nav,seam});
window.__seam=seam;
window.__ready=true;
</script></body></html>`;

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/__theme-harness.html') {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8',
                             'access-control-allow-origin': '*'}).end(HARNESS);
    return;
  }
  const file = join(site, path === '/' ? 'index.html' : path);
  if (!file.startsWith(site) || !existsSync(file)) {
    response.writeHead(404, {'content-type': 'text/plain'}).end('not found');
    return;
  }
  response.writeHead(200, {'content-type': TYPES[extname(file)] || 'application/octet-stream',
                           'access-control-allow-origin': '*'}).end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox']});
const errors = [];
const measured = {};
let context, page;
let stored = {version: 1, language: 'auto', theme: 'system',
              chat: {enter: 'submit', shiftEnter: 'newline', ctrlEnter: 'queue'},
              editor: {vim: false}};
let session = null;            // the fake service's own session state
let revision = 3;

async function wire(target) {
  target.on('pageerror', error => errors.push(String(error)));
  await target.route('https://fonts.googleapis.com/**', route =>
    route.fulfill({contentType: 'text/css', headers: {'access-control-allow-origin': '*'}, body: ''}));
  await target.route('https://fonts.gstatic.com/**', route => route.fulfill({status: 404, body: ''}));
  await target.route('https://api.github.com/**', route =>
    route.fulfill({contentType: 'application/json', headers: {'access-control-allow-origin': '*'}, body: '[]'}));
  await target.route(API + '/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({status: 204, headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, accept',
        'access-control-allow-methods': 'GET, PUT, POST, OPTIONS'}});
    }
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({status, headers: {
      'access-control-allow-origin': '*', 'content-type': 'application/json', 'cache-control': 'no-store'},
      body: JSON.stringify(body)});
    if (path === '/v2/accounts/settings') {
      if (!session) return json({error: 'invalid_session', message: 'Sign in again.'}, 401);
      if (request.method() === 'PUT') {
        const body = JSON.parse(request.postData() || '{}');
        if (body.settings) stored = body.settings;
        revision += 1;
      }
      return json({settings: stored, revision, updatedAt: null});
    }
    if (path === '/v2/accounts/me') {
      return session ? json({account: ACCOUNT}) : json({error: 'invalid_session'}, 401);
    }
    if (path === '/v2/accounts/password/login') {
      session = 'fixture-session-token';
      return json({session: {token: session, expiresAt: Date.now() + 3600_000}, account: ACCOUNT});
    }
    if (path === '/v2/accounts/logout') {
      session = null;
      return route.fulfill({status: 204, headers: {'access-control-allow-origin': '*'}});
    }
    return json({});
  });
}

const readTheme = () => page.evaluate(() => ({
  attribute: document.documentElement.getAttribute('data-easter-theme'),
  colorScheme: document.documentElement.style.colorScheme,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  navigations: performance.getEntriesByType('navigation').length,
}));

async function waitForTheme(attribute, budgetMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await page.evaluate(want => document.documentElement.getAttribute('data-easter-theme') === want,
      attribute)) return {...(await readTheme()), landedAfterMs: Date.now() - start};
    await page.waitForTimeout(25);
  }
  return {...(await readTheme()), landedAfterMs: null};
}

async function load(path, {signedIn = false, scheme = 'light', theme = 'system'} = {}) {
  stored = {...stored, theme};
  session = signedIn ? 'fixture-session-token' : null;
  if (context) await context.close();
  context = await browser.newContext({viewport: {width: 1280, height: 900}, colorScheme: scheme});
  if (signedIn) {
    await context.addInitScript(() => sessionStorage.setItem('easter-company-web-session-v1',
      JSON.stringify({token: 'fixture-session-token', expiresAt: Date.now() + 3600_000, account: null})));
  } else {
    await context.addInitScript(() => sessionStorage.clear());
  }
  await wire(context);
  page = await context.newPage();
  await page.goto(origin + path, {waitUntil: 'domcontentloaded'});
  return readTheme();
}

try {
  // ── 1. a signed-out launcher page publishes `system` on load ────────────────────
  let atDCL = await load('/', {signedIn: false, scheme: 'light', theme: 'dark'});
  measured.signedOutLightOS = atDCL;
  assert.equal(atDCL.attribute, 'light',
    `a signed-out page on a light OS must publish light at DOMContentLoaded; saw ${atDCL.attribute}`);
  assert.equal(atDCL.colorScheme, 'light', 'color-scheme is published beside the attribute');
  await page.waitForTimeout(400);
  measured.signedOutLightOSAfter = await readTheme();
  assert.equal(measured.signedOutLightOSAfter.attribute, 'light', 'and it stays put');

  atDCL = await load('/', {signedIn: false, scheme: 'dark', theme: 'light'});
  measured.signedOutDarkOS = atDCL;
  assert.equal(atDCL.attribute, 'dark',
    `a signed-out page on a dark OS must publish dark, whatever a saved preference once was; saw ${atDCL.attribute}`);

  // ── 2. a signed-in launcher page publishes the account's setting on load ────────
  // No head script on these pages (there is no light palette to flash), so the account's
  // answer lands one document read after DOMContentLoaded: asserted with the wait, and the
  // time it took is reported rather than hidden.
  atDCL = await load('/', {signedIn: true, scheme: 'dark', theme: 'light'});
  measured.signedInAccountLightDarkOSAtDCL = atDCL;
  let landed = await waitForTheme('light');
  measured.signedInAccountLightDarkOS = landed;
  assert.equal(landed.attribute, 'light',
    `a signed-in page whose account chose light must publish light on a dark OS; saw ${landed.attribute}`);
  assert.equal(landed.colorScheme, 'light', 'color-scheme follows the account');
  assert.ok(landed.landedAfterMs !== null, 'the account theme never arrived on the launcher page');

  atDCL = await load('/', {signedIn: true, scheme: 'light', theme: 'dark'});
  landed = await waitForTheme('dark');
  measured.signedInAccountDarkLightOS = landed;
  assert.equal(landed.attribute, 'dark',
    `a signed-in page whose account chose dark must publish dark on a light OS; saw ${landed.attribute}`);

  atDCL = await load('/', {signedIn: true, scheme: 'light', theme: 'system'});
  measured.signedInSystemLightOS = atDCL;
  assert.equal(atDCL.attribute, 'light', 'system follows the OS on a signed-in page too');

  // ── 3. sign-in and sign-out, inside one document ─────────────────────────────────
  // Signed out on a dark OS first, then sign in against an account whose preference is light.
  await load('/__theme-harness.html', {signedIn: false, scheme: 'dark', theme: 'light'});
  await page.waitForFunction(() => window.__ready === true, {timeout: 15000});
  const signedOut = await readTheme();
  measured.beforeSignIn = signedOut;
  assert.equal(signedOut.attribute, 'dark', 'the harness starts on the OS answer, signed out');
  await page.evaluate(async () => { await window.__seam.loginCompany('owen', 'fixture-password'); });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-easter-theme') === 'light',
    {timeout: 10000}).catch(() => {});
  const signedIn = await readTheme();
  measured.afterSignIn = signedIn;
  assert.equal(signedIn.attribute, 'light',
    `signing in must take the account's light with no reload; saw ${signedIn.attribute}`);
  assert.equal(signedIn.navigations, 1, 'the switch happened inside the one document');
  await page.evaluate(async () => { await window.__seam.signOut(); });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-easter-theme') === 'dark',
    {timeout: 10000}).catch(() => {});
  const signedOutAgain = await readTheme();
  measured.afterSignOut = signedOutAgain;
  assert.equal(signedOutAgain.attribute, 'dark',
    `signing out must return the page to system, which is dark on a dark OS; saw ${signedOutAgain.attribute}`);
  assert.equal(signedOutAgain.navigations, 1, 'and still no navigation');
  await page.screenshot({path: join(output, 'harness-after-sign-out.png')});

  console.log('MEASURED', JSON.stringify(measured, null, 2));
  console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
  console.log('screenshots:', output);
} finally {
  if (context) await context.close().catch(() => {});
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
