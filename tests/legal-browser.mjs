import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
// The shared static preview of site/ (README: `python -m http.server --directory site 18100`).
// It serves whichever tree that listener was started from, so it must be started in this
// worktree, not in the integration checkout.
const origin = process.env.EASTER_PUBLIC_ORIGIN || 'http://127.0.0.1:18100';
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const colours = {legal: 'rgb(200, 189, 158)', gold: 'rgb(219, 186, 121)'};
const widths = [1440, 900, 600, 390];

// Every footer must offer both documents and nothing may scroll sideways at any of the
// widths this site is checked at. The links are read from the footer that owns them, so a
// page that loses its legal span fails here rather than silently skipping its journey.
async function inspectFooter(page, footer, label) {
  const legal = page.locator(`${footer} .legal-links`);
  assert.equal(await legal.count(), 1, `${label}: the footer has no .legal-links span`);
  const links = legal.getByRole('link');
  assert.deepEqual(await links.allInnerTexts(), ['Privacy', 'Terms'], `${label}: the footer links are not Privacy and Terms`);
  for (const width of widths) {
    await page.setViewportSize({width, height: width < 700 ? 844 : 900});
    const state = await page.evaluate(selector => {
      const footerNode = document.querySelector(selector), legalNode = footerNode.querySelector('.legal-links');
      const anchors = [...legalNode.querySelectorAll('a')];
      const separator = legalNode.querySelector('[aria-hidden="true"]');
      return {scrollWidth: document.documentElement.scrollWidth, innerWidth,
        inside: (() => { const box = legalNode.getBoundingClientRect(), outer = footerNode.getBoundingClientRect();
          return box.left >= outer.left - 1 && box.right <= outer.right + 1; })(),
        colour: getComputedStyle(anchors[0]).color,
        fontSize: parseFloat(getComputedStyle(anchors[0]).fontSize),
        sameLine: separator ? anchors.every(anchor => Math.abs(anchor.getBoundingClientRect().top - separator.getBoundingClientRect().top) < 2) : false,
        links: anchors.map(anchor => ({text: anchor.textContent, href: anchor.getAttribute('href'), resolved: anchor.href}))};
    }, footer);
    assert(state.scrollWidth <= state.innerWidth + 1, `${label} at ${width}px scrolls sideways: ${state.scrollWidth} > ${state.innerWidth}`);
    assert.equal(state.inside, true, `${label} at ${width}px pushes the legal links outside the footer box`);
    assert.equal(state.colour, colours.legal, `${label} at ${width}px paints the legal links ${state.colour}, not the readable #c8bd9e`);
    assert(state.fontSize >= 8, `${label} at ${width}px sets the legal links at ${state.fontSize}px`);
    assert.equal(state.sameLine, true, `${label} at ${width}px strands a separator away from its links`);
  }
  // A keyboard visitor gets the base stylesheet's gold focus ring on these links, so no rule
  // added for the legal links may have switched it off.
  await page.setViewportSize({width: 1440, height: 900});
  const ring = await page.evaluate(selector => {
    const anchor = document.querySelector(`${selector} .legal-links a`);
    anchor.focus();
    return {width: getComputedStyle(anchor).outlineWidth, style: getComputedStyle(anchor).outlineStyle};
  }, footer);
  assert(parseFloat(ring.width) >= 2 && ring.style !== 'none', `${label}: the legal links have no focus ring (${JSON.stringify(ring)})`);
  return legal;
}

// One page's journey: footer Privacy -> the policy -> the policy's own footer link to Terms.
async function journey(page, path, footer, label) {
  await page.goto(origin + path);
  await page.keyboard.press('Escape'); // The homepage arrival mist is skippable; skip it.
  const legal = await inspectFooter(page, footer, label);
  await legal.getByRole('link', {name: 'Privacy', exact: true}).click();
  await page.waitForURL('**/legal/privacy/');
  assert.match(page.url(), /\/legal\/privacy\/$/, `${label}: Privacy did not land on the policy`);
  await page.getByRole('heading', {name: 'Privacy Policy', exact: true, level: 1}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Privacy Policy', exact: true, level: 1}).isVisible(), true);
  // The document's own footer is how the reader gets to the other one from there.
  await page.locator('.legal-footer').getByRole('link', {name: 'Terms', exact: true}).click();
  await page.waitForURL('**/legal/terms/');
  assert.match(page.url(), /\/legal\/terms\/$/, `${label}: the document footer did not reach the terms`);
  await page.getByRole('heading', {name: 'Terms of Service', exact: true, level: 1}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Terms of Service', exact: true, level: 1}).isVisible(), true);
  for (const width of widths) {
    await page.setViewportSize({width, height: width < 700 ? 844 : 900});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `${label}: the terms document scrolls sideways at ${width}px`);
  }
  await page.screenshot({path: `/tmp/legal-journey-${label}.png`, fullPage: true});
}

const page = await browser.newPage({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce'});
page.setDefaultTimeout(15000);
const errors = [];
const failed = [];
page.on('pageerror', error => errors.push(error.message));
// The 404 page is answered with a 404 status on purpose below; every other failure is real.
page.on('response', response => {
  if (response.status() >= 400 && !response.url().includes('/charted/nowhere/')) failed.push(`${response.status()} ${response.url()}`);
});
try {
  await journey(page, '/', '.home-footer', 'home');
  await journey(page, '/minecraft/map/', '.map-bottom', 'map');
  await journey(page, '/minecraft/wiki/', '.wiki-footer', 'wiki');

  // GitHub Pages answers any missing path with 404.html, so the page is served from a URL that
  // is not its own directory. The static preview cannot do that, so the file the preview serves
  // is answered for a deep missing path here: the same document, resolved from the same place
  // the visitor is standing. A relative legal href would point at /charted/nowhere/legal/... .
  const notFound = await (await fetch(origin + '/404.html')).text();
  await page.route('**/charted/nowhere/**', route => route.fulfill({status: 404, contentType: 'text/html', body: notFound}));
  await page.goto(origin + '/charted/nowhere/some/deep/path/');
  await page.getByRole('heading', {name: 'A little off course.', exact: true, level: 1}).waitFor();
  const notFoundLinks = page.locator('.not-found-footer a');
  const notFoundFooter = page.locator('.not-found-footer');
  assert.deepEqual(await notFoundLinks.allInnerTexts(), ['Privacy', 'Terms']);
  assert.deepEqual(await notFoundLinks.evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href'))),
    ['/legal/privacy/', '/legal/terms/'], '404.html must link to the documents from the site root');
  for (const width of widths) {
    await page.setViewportSize({width, height: width < 700 ? 844 : 900});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `404 scrolls sideways at ${width}px`);
  }
  await page.screenshot({path: '/tmp/legal-journey-404.png', fullPage: true});
  await notFoundFooter.getByRole('link', {name: 'Privacy', exact: true}).click();
  await page.waitForURL('**/legal/privacy/');
  await page.getByRole('heading', {name: 'Privacy Policy', exact: true, level: 1}).waitFor();
  await page.unroute('**/charted/nowhere/**');

  assert.deepEqual(errors, [], `Page errors: ${JSON.stringify(errors)}`);
  assert.deepEqual(failed, [], `Failed requests: ${JSON.stringify(failed)}`);
  console.log('Legal pages PASS: home, map and wiki footers reach both documents with the right heading, '
    + 'both documents link to each other, 404 resolves from a deep path, and no page overflows at '
    + widths.join(', ') + 'px.');
} finally {
  await browser.close();
}
