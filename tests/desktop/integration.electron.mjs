// Integration verification for the download-first launcher flow.
//
// Run from the repository root after the flow branches are merged:
//   xvfb-run -a node tests/desktop/integration.electron.mjs [--keep]
//
// What this proves that the unit suites cannot: the REAL main process and the REAL shared UI
// agree about the flow. It launches the app with the existing fixture harness (which stubs
// only the Mojang side and the game process) and a loopback stub of the account API, then
// drives the actual state machine and asserts what a player would see at each step.
//
// What it deliberately does not prove: the download mechanics themselves (chunk selection,
// byte progress, pause and resume of real transfers). Those belong to
// tests/desktop/loopback.electron.mjs, which uses a real local HTTP fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const root = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : process.cwd();
const keep = process.argv.includes('--keep');

const ACCOUNT = {passwordRequired:false,microsoftLinked:true,microsoftSubject:'cc75443d8979fe5cdbdf2de55b822ec8b63bc55348c2e451b46b19f4746885ca',id: 7, minecraftUuid: '12345678-90ab-cdef-1234-567890abcdef', minecraftName: 'TestCaptain',
  displayName: 'Captain Testbeard', roles: ['crew'], createdAt: '2026-01-01T00:00:00Z'};
const SESSION = 'stub-session-token-private';

const stub = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', c => chunks.push(c));
  request.on('end', () => {
    const json = payload => { response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify(payload)); };
    if (request.url === '/v2/accounts/microsoft') return json({created: true, account: ACCOUNT,
      session: {token: SESSION, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString()}});
    if (request.url === '/v2/accounts/me') return json({account: ACCOUNT});
    if (request.url === '/v2/accounts/logout') { response.writeHead(204); return response.end(); }
    response.writeHead(404, {'Content-Type': 'application/json'}); response.end('{"error":"not_found"}');
  });
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
const apiBase = 'http://127.0.0.1:' + stub.address().port;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easter-flow-e2e-'));
const home = path.join(dir, 'home');
const steps = [];
const note = (name, detail) => { steps.push(name); console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`); };

const app = await electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', path.join(root, 'tests/desktop/flow-harness.cjs')],
  env: {...process.env, EASTER_TEST_HOME: home, EASTER_API_BASE_URL: apiBase},
});

let failed = null;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.easterDesktop?.mode === 'desktop');

  const state = () => page.evaluate(() => window.easterDesktop.status());
  const hero = () => page.locator('[data-desktop-play]').innerText();
  const barVisible = () => page.locator('#launcher-bar').isVisible();

  // 1. Fresh install, nothing downloaded, nobody signed in.
  let s = await state();
  assert.equal(s.canPlay, false, 'a fresh launcher cannot play');
  assert.equal(await barVisible(), false, 'the bar stays hidden before any download');
  assert.match(await hero(), /Download the game/i, 'the hero asks for the game first: ' + await hero());
  note('fresh: hero promotes the download, no bar, Play absent');

  // 2. Start the client download. The hero action is the only download control; the
  // details beside it hold the location and the machine's graphics answer.
  const installSection = page.locator('#desktop-install-details');
  await installSection.waitFor({state: 'visible'});
  assert.equal(await page.getByRole('button', {name: /^(download the game|start download|install the game)\b/i}).count(), 1, 'one download action per screen');
  const location = (await installSection.locator('.desktop-install-current').textContent()).trim();
  assert(location.length > 0, 'the install folder defaults to something the player can accept');
  // The graphics choice is no longer a checkbox in the install form: the card states the
  // machine's own answer, and the hero toggle is the player's control once the client is in.
  const graphicsNote=(await installSection.locator('.desktop-install-graphics').textContent()).trim();
  assert(graphicsNote.length>0,'the card states what the graphics setting will be: '+JSON.stringify(graphicsNote));
  assert(/graphics|shader/i.test(graphicsNote),'and says it in terms of graphics: '+graphicsNote);
  note('download: location defaults and the machine\'s graphics answer is stated', location);
  const picked=path.join(dir,'chosen-client');
  await fs.mkdir(picked);
  await app.evaluate(({dialog},picked)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[picked]});},picked);
  await installSection.getByRole('button',{name:'Choose folder…'}).click();
  await page.waitForFunction(picked=>document.querySelector('.desktop-install-current').textContent.trim()===picked,picked);
  assert.equal((await state()).install.location,picked,'the real picker object updates both UI and saved location');
  assert.equal((await installSection.locator('.desktop-install-graphics').textContent()).trim(),graphicsNote,'choosing a folder leaves the graphics answer untouched');

  await page.locator('[data-desktop-play][data-action="download"]').click();
  await page.waitForFunction(() => document.getElementById('launcher-bar')?.hidden === false, {timeout: 20000});
  note('download: the sticky bar appears once the download starts');

  await installSection.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.waitForFunction(async()=>(await window.easterDesktop.status()).paused);
  // An already in-flight fixture step may report once after pause. Wait for it to park.
  await page.waitForTimeout(200);
  const pausedProgress=(await state()).progress;
  await page.screenshot({path:'/tmp/launcher-assist-install.png'});
  await page.keyboard.press('Escape');
  await page.screenshot({path:'/tmp/launcher-assist-home.png'});

  // 3. While it is downloading and nobody is signed in, the hero must ask for an account.
  s = await state();
  assert.equal(s.canPlay, false, 'a download alone must not unlock Play');
  const heroWhileDownloading = await hero();
  assert.match(heroWhileDownloading, /Sign in/i, 'the hero switches to sign-in while downloading: ' + heroWhileDownloading);
  note('during download: hero asks for Microsoft sign-in, Play still absent');

  // 4. Sign in through the stubbed Microsoft flow the harness provides.
  await page.locator('[data-desktop-play]').click();await page.getByRole('button',{name:'Continue with Microsoft',exact:true}).click();
  await page.locator('.desktop-code').waitFor({state: 'visible'});
  assert.equal((await state()).paused,true,'sign-in does not resume the paused transfer');
  assert.deepEqual((await state()).progress,pausedProgress,'sign-in preserves transfer progress');
  await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
  await page.waitForFunction(async()=>(await window.easterDesktop.status()).device===null);
  assert.equal((await state()).paused,true,'cancelling sign-in leaves download paused');
  assert.deepEqual((await state()).progress,pausedProgress,'cancel preserves transfer progress');
  // Signing in is the hero's action; the dialog is modal, so close it first.
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('#desktop-launcher')?.open);
  await page.locator('[data-desktop-play]').click();await page.getByRole('button',{name:'Continue with Microsoft',exact:true}).click();
  await page.locator('.desktop-code').waitFor({state:'visible'});
  // Let the client finish while Microsoft approval is still pending. The code must
  // survive installation completing, and Play must stay gated on the account.
  // Resume the fixture transfer through IPC while the modal remains open.
  // Escape now cancels sign-in instead of hiding an in-flight authentication flow.
  await page.evaluate(()=>window.easterDesktop.resumeInstall());
  await page.waitForFunction(async()=>(await window.easterDesktop.status()).install.installed);
  assert.equal((await state()).canPlay,false,'a completed client still needs Microsoft approval');
  // Settings is the hero's secondary action; it opens the dialog that carries the
  // still-pending device code.
  // Settings is offered at the Play Now stage and withheld while a transfer runs, so wait
  // for the transfer to settle rather than assuming it has.
  // This fixture deliberately changes its chunk between requests, so after an install it
  // starts another transfer and the client stops being "installed" for a moment. Asserting
  // that Settings is on screen right now would be a race, so the contract's rule is what is
  // asserted here: Settings is offered exactly when the client is installed and nothing is
  // transferring. The dialog's own contents are driven in tests/desktop/electron.mjs, where
  // the state is stable.
  const settingsRule=await page.evaluate(async()=>{
   const s=await window.easterDesktop.status();
   const busy=['downloading','paused','verifying','installing','updating'].includes(s.phase);
   const button=document.querySelector('.desktop-settings-button');
   return {offered:!!button&&!button.hidden,expected:s.install?.installed===true&&!busy,phase:s.phase,installed:s.install?.installed===true};
  });
  assert.equal(settingsRule.offered,settingsRule.expected,
   'Settings is offered exactly when the client is installed and nothing is transferring: '+JSON.stringify(settingsRule));
  // The pending code was asserted while the dialog was open; re-opening it here would race
  // the transfer the fixture keeps starting, so the same fact is read from the state.
  assert.equal((await state()).device?.code,'TEST-CODE','install completion preserves the pending device code');
  await app.evaluate(() => global.easterTestApprove());
  await page.waitForFunction(async () => (await window.easterDesktop.status()).profile !== null, null, {timeout: 30000});
  note('sign-in: the account connects through the device-code flow');

  await page.keyboard.press('Escape');

  // 5. Both halves satisfied: Play is finally revealed.
  await page.waitForFunction(async () => (await window.easterDesktop.status()).canPlay === true, null, {timeout: 30000});
  await page.locator('[data-desktop-play][data-action=play]').waitFor();
  assert.equal(await page.locator('[data-desktop-play]').innerText().then(t => /PLAY NOW|Play Minecraft|^Play/i.test(t)), true,
    'the hero becomes the Play action once both halves are satisfied');
  note('ready: hero is the Play action, canPlay true with an installed client and an account');

  assert.deepEqual(errors, [], 'the flow must not raise renderer errors');

  await page.addInitScript(()=>{
   window.__terrainTiles=0;
   const draw=CanvasRenderingContext2D.prototype.drawImage;
   CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.id==='terrain')window.__terrainTiles++;return draw.apply(this,args);};
  });
  // 6. The bar follows the player to the other page.
  await page.getByRole('link', {name: 'Map', exact: true}).click();
  await page.waitForFunction(() => window.easterDesktop?.mode === 'desktop');
  const barOnMap = await barVisible();
  assert.equal(barOnMap,true,'ready bar persists on map');
  await page.waitForFunction(()=>window.__terrainTiles>0&&document.getElementById('snapshot-date')?.textContent.startsWith('Charted'));
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:'/tmp/launcher-assist-map.png'});
  await page.getByRole('link',{name:'Home',exact:true}).click();
  await page.locator('[data-desktop-play][data-action=play]').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.body.classList.contains('is-arriving')&&Number(getComputedStyle(document.querySelector('.hero-copy')).opacity)>.99);
  await page.screenshot({path:'/tmp/launcher-assist-ready.png'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/launcher-assist-mobile.png'});
  await page.getByRole('link',{name:'Map',exact:true}).click();
  await page.waitForFunction(()=>window.__terrainTiles>0&&document.getElementById('snapshot-date')?.textContent.startsWith('Charted'));
  await page.locator('#launcher-bar').waitFor({state:'visible'});
  await page.screenshot({path:'/tmp/launcher-assist-mobile-map.png'});
  note('map: the bar follows the player across pages', String(barOnMap));
} catch (error) {
  failed = error;
} finally {
  await app.close().catch(() => {});
  if (!keep) await fs.rm(dir, {recursive: true, force: true});
  stub.close();
}

if (failed) {
  console.error(`\nFAILED after ${steps.length} step(s): ${failed.message}`);
  process.exit(1);
}
console.log(`\nFLOW PASS: ${steps.length} steps — hero gating, bar appearance, sign-in and the Play gate`);
