import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
// The journey Owen asked for: the legal documents are reachable from inside the launcher without
// anyone being handed a URL. desktop/main.cjs only lets easter://easter/ through its will-navigate
// guard, so a footer link that resolves anywhere else is opened in the desktop browser instead of
// the launcher; every click below is a real click on the footer, not a loadURL.
const root = process.cwd();
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easter-legal-'));
const packaged = process.env.EASTER_PACKAGED_LAUNCHER;
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const app = await electron.launch({executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', ...(packaged ? [] : [path.join(root, 'desktop/main.cjs')])],
  env: {...process.env, EASTER_TEST_HOME: home}});
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.easterDesktop?.mode === 'desktop');
  await page.keyboard.press('Escape');
  const initial = await page.evaluate(() => window.easterDesktop.status());
  // The same channel main.cjs carries the launcher state on. A transfer is the one state that
  // floats the sticky progress bar over the bottom of whichever page is open, so it is sent here
  // rather than waited for: no test may start a real client download.
  const send = state => app.evaluate(({BrowserWindow}, state) =>
    BrowserWindow.getAllWindows()[0].webContents.send('launcher:state', state), state);
  const footerLinks = () => page.locator('.home-footer .legal-links a');

  // The launcher writes "Launcher <version>" into the last home footer span on every render. The
  // legal links were added in front of that span, so the version still replaces the motto and the
  // links are still there afterwards.
  await page.waitForFunction(expected => document.querySelector('.home-footer>span:last-child')?.textContent === expected, 'Launcher ' + version);
  assert.equal(await page.locator('.home-footer>span:last-child').innerText(), 'Launcher ' + version,
    'the motto span no longer carries the launcher version');
  assert.deepEqual(await footerLinks().allInnerTexts(), ['Privacy', 'Terms'], 'the launcher home footer lost its legal links');
  assert.equal(await page.locator('.home-footer>span:last-child .legal-links').count(), 0,
    'the legal links are in the last home footer span, which the launcher overwrites');
  assert.equal(await page.locator('.home-footer>span').last().evaluate(node => node.classList.contains('legal-links')), false);
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({width, height});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `the launcher home page scrolls sideways at ${width}px with the legal links in the footer`);
    assert.equal(await footerLinks().first().isVisible(), true, `the launcher home footer hides the legal links at ${width}px`);
  }
  await page.setViewportSize({width: 1440, height: 900});

  // Privacy, from the footer, inside the launcher.
  await footerLinks().first().click();
  await page.waitForURL(url => url.href.startsWith('easter://easter/legal/privacy/'));
  assert(page.url().startsWith('easter://easter/legal/privacy/'), 'Privacy did not stay inside the launcher: ' + page.url());
  await page.getByRole('heading', {name: 'Privacy Policy', exact: true, level: 1}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Privacy Policy', exact: true, level: 1}).isVisible(), true);
  assert.equal(await page.locator('nav [popovertarget]').count(), 0, 'the launcher still offers the website download menu');
  assert.equal(await page.locator('.arrival-mist').count(), 0, 'the launcher omits the arrival mist');

  // The sticky bar floats over the bottom of every page. With a transfer running, the end of the
  // document must still be readable above it rather than under it.
  await send({...initial, phase: 'downloading', actions: ['pause'],
    progress: {label: 'Downloading client files', percent: 47, bytesDone: 470000000, bytesTotal: 1000000000}});
  await page.waitForFunction(() => document.getElementById('launcher-bar')?.hidden === false);
  const bottom = await page.evaluate(async () => {
    scrollTo(0, document.body.scrollHeight);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bar = document.getElementById('launcher-bar'), footer = document.querySelector('.legal-footer');
    const last = [...document.querySelectorAll('.legal-body p')].pop();
    const footerBox = footer.getBoundingClientRect(), barBox = bar.getBoundingClientRect(), point = last.getBoundingClientRect();
    const hit = document.elementFromPoint(point.left + 4, point.top + point.height / 2);
    return {barTop: barBox.top, footerBottom: footerBox.bottom, innerHeight,
      covered: hit ? Boolean(hit.closest('#launcher-bar')) : false,
      documentEnd: document.documentElement.scrollHeight - scrollY,
      reserved: parseFloat(getComputedStyle(document.body).paddingBottom)};
  });
  assert.equal(bottom.covered, false, 'the sticky bar covers the last line of the privacy policy');
  assert(bottom.reserved >= 60, `the legal page reserves ${bottom.reserved}px at the bottom, less than the sticky bar needs`);
  assert(bottom.footerBottom <= bottom.barTop, `the document footer ends at ${Math.round(bottom.footerBottom)}px, under the bar which starts at ${Math.round(bottom.barTop)}px`);
  await page.screenshot({path: '/tmp/legal-launcher-privacy.png', fullPage: true});
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({width, height});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `the privacy policy scrolls sideways in the launcher at ${width}px`);
  }
  await page.setViewportSize({width: 1440, height: 900});

  // Terms, from the document's own footer, then back to Home through the shared navigation.
  await send(initial);
  await page.waitForFunction(() => document.getElementById('launcher-bar').hidden === true);
  await page.locator('.legal-footer').getByRole('link', {name: 'Terms', exact: true}).click();
  await page.waitForURL(url => url.href.startsWith('easter://easter/legal/terms/'));
  await page.getByRole('heading', {name: 'Terms of Service', exact: true, level: 1}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Terms of Service', exact: true, level: 1}).isVisible(), true);
  await page.screenshot({path: '/tmp/legal-launcher-terms.png', fullPage: true});
  await page.getByRole('link', {name: 'Home', exact: true}).click();
  await page.waitForFunction(() => location.protocol === 'easter:' && !location.pathname.startsWith('/legal/'));
  await page.waitForFunction(expected => document.querySelector('.home-footer>span:last-child')?.textContent === expected, 'Launcher ' + version);
  assert.equal(await page.locator('.home-footer>span:last-child').innerText(), 'Launcher ' + version,
    'the version disappeared from the home footer after the journey');
  assert.deepEqual(await footerLinks().allInnerTexts(), ['Privacy', 'Terms'], 'the legal links did not survive the journey');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Home scrolls sideways after the journey');
  assert.deepEqual(errors, [], `Page errors: ${JSON.stringify(errors)}`);
  console.log('Legal Electron PASS: the home footer keeps "Launcher ' + version + '" in the motto span with both legal '
    + 'links beside it, Privacy and Terms open inside the launcher at easter://easter/legal/ from the footer, the '
    + 'sticky transfer bar leaves the end of the document readable, and Home comes back with the version intact.');
} finally {
  await app.close();
  await fs.rm(home, {recursive: true, force: true});
}
