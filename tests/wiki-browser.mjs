/*
 * The field guide, driven in a browser against the site as it is published today.
 *
 * WHAT THIS GATE ASSERTED BEFORE 2026-10-29 AND WHY IT COULD NOT PASS. The wiki used to be one
 * page — /wiki/ — whose articles were hash routes, so this file asserted that clicking a card left
 * the address bar on `#/ships-and-sailing`, that a section link ended in
 * `ships-and-sailing/chart-a-course`, and that `/minecraft/wiki/#/<guide>` rendered the article by
 * rewriting the page's own DOM. The SEO work (PR #22, 0381609) then published every guide as its
 * own crawlable document under /minecraft/wiki/<guide>/ with a real title, canonical and
 * structured data, and the hash routes became the LAUNCHER's transport (site/minecraft/wiki/wiki.js
 * only rewrites `#/<id>` links into `./<id>/` when no `window.easterDesktop` is present). The gate
 * kept asserting the old truth and was red on main - measured on an untouched checkout on
 * 2026-10-29 - which is worse than no gate at all: it teaches everyone to read a red suite as
 * normal, and in one night it hid two real defects in another suite.
 *
 * WHAT IT ASSERTS NOW, and it is still about what the wiki is FOR:
 *   - the overview at /minecraft/wiki/ lists the twelve guides, and every card is a link to a real
 *     guide document that answers 200 (a card pointing at a missing document fails here);
 *   - a guide is a URL, not a rendering: /minecraft/wiki/<guide>/ names its own title, h1, intro,
 *     canonical and sections, survives a reload, and reads in full with scripting off - that last
 *     one is the whole point of the restructure;
 *   - its section links and shared deep links reach the section (hash and in-view, measured);
 *   - navigation between wiki pages works: cards in, breadcrumb and sidebar out, and back;
 *   - search still finds an article, still says so when it finds nothing, still renders a hostile
 *     query as text, and works from inside a guide document (article.js sends it to the overview);
 *   - the hash routes are still there for the LAUNCHER and for old bookmarks, including the
 *     unknown-page answer;
 *   - the noindex stubs at the old /wiki/ address still answer 200 and still carry the fragment
 *     across by hand, because GitHub Pages cannot answer a 301 for a path. The fragment is dropped
 *     only when scripting is off, which is exactly why the script hop is load-bearing;
 *   - the pages fit 800, 390 and 320 wide without scrolling sideways.
 *
 * WHAT IT CANNOT ASSERT, and does not pretend to: the pre-restructure suite asserted that pressing
 * a section link moved FOCUS to the section (`document.getElementById(id) === document.activeElement`),
 * which the hash-route article did with `tabIndex=-1` and `focus()`. These are plain HTML anchors
 * now: the browser scrolls the section into view and moves its own sequential focus start there,
 * but no script assigns focus, so `document.activeElement` stays <body>. Asserted below as the hash
 * plus the section in the viewport, which is what the documents actually do - reported to Delta
 * rather than papered over, because restoring the explicit focus is a product change and not a
 * test repair.
 *
 * Run it against a served site/ tree: `EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18100 node
 * tests/wiki-browser.mjs` (or `npm run test:site`, which runs this one with tests/browser.mjs).
 */
import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const origin = process.env.EASTER_PUBLIC_ORIGIN || 'http://127.0.0.1:18100';
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
// What a guide document is, in one place: the twelve the overview publishes, and the one this gate
// follows all the way through. Any of them would do; this is the one the old gate used, so the
// before/after comparison is about the same article rather than about two different pages.
const GUIDE = {slug:'ships-and-sailing', title:'Ships & sailing', titleTag:'Ships & sailing — Easter Co. SMP',
  intro:'Learn custom piloting and reverse rowing', sections:5,
  firstSection:{id:'before-you-sail', label:'Before you sail'}};
const GUIDE_COUNT = 12;
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.setDefaultTimeout(15000);
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  // A resolved link, never the attribute: the overview's cards are server-rendered as
  // `getting-started/` and rebuilt by site/minecraft/wiki/wiki.js as `./getting-started/` in a
  // browser, and both are the same document. Asserting the attribute would pass locally and fail
  // on production (measured: 127.0.0.1:18100 rewrote, launcher.easter.company had not yet), which
  // is a gate measuring its own timing rather than the site.
  const resolved = locator => locator.evaluateAll(nodes => nodes.map(node => node.href));

  // ---- The overview is a page of documents ---------------------------------------------------
  // Reached the way a visitor reaches it - through the header - so the nav route is proven too.
  await page.goto(origin + '/', {waitUntil:'domcontentloaded'});
  await page.getByRole('link', {name:'Wiki', exact:true}).click();
  await page.locator('.wiki-card').first().waitFor();
  assert.equal(new URL(page.url()).pathname, '/minecraft/wiki/', 'the header\'s Wiki link lands on the overview');
  assert.equal(await page.locator('.wiki-card').count(), GUIDE_COUNT, 'the overview lists all ' + GUIDE_COUNT + ' guides');
  assert.equal(await page.locator('.site-header a[aria-current]').textContent(), 'Wiki', 'and the shared header marks Wiki as the current page');
  assert.equal(await page.locator('.arrival-mist').count(), 0, 'no home-page arrival intro leaks into the wiki');
  const cardHrefs = await resolved(page.locator('.wiki-card'));
  assert.equal(new Set(cardHrefs).size, GUIDE_COUNT, 'every card is a different guide');
  for (const href of cardHrefs) {
    assert.match(new URL(href).pathname, /^\/minecraft\/wiki\/[a-z0-9-]+\/$/,
      'a card is a link to a guide DOCUMENT, not a hash route: ' + href);
  }
  // EVERY CARD OPENS ITS OWN DOCUMENT. Not just the one guide this file follows further down: a
  // card that points at a missing document, or a guide whose title stopped matching the card it is
  // listed under, is caught here for all twelve rather than on a player's click.
  const cards = await page.locator('.wiki-card').evaluateAll(nodes => nodes.map(node => ({
    href: node.href, title: node.querySelector('h2').textContent,
  })));
  for (const {href, title} of cards) {
    const answer = await page.goto(href, {waitUntil:'domcontentloaded'});
    assert.equal(answer.status(), 200, 'the card\'s guide document answers 200: ' + new URL(href).pathname);
    assert.equal(await page.title(), title + ' — Easter Co. SMP', href + ' names itself in its own <title>: ' + title);
    assert.equal(await page.locator('h1').first().textContent(), title, href + ' names itself in its own h1');
  }
  await page.goto(origin + '/minecraft/wiki/', {waitUntil:'domcontentloaded'});
  await page.locator('.wiki-card').first().waitFor();
  console.log('Wiki overview passed: ' + GUIDE_COUNT + ' guides, each a real document that answers 200 and names itself');

  // ---- A guide is a URL that names itself ----------------------------------------------------
  await page.getByRole('link', {name:GUIDE.title, exact:true}).first().click();
  await page.waitForURL(origin + '/minecraft/wiki/' + GUIDE.slug + '/');
  assert.equal(page.url(), origin + '/minecraft/wiki/' + GUIDE.slug + '/', 'clicking a card opens the guide at its own address');
  assert.equal(await page.title(), GUIDE.titleTag, 'the document titles itself for search and for a shared tab');
  assert.equal(await page.locator('h1').first().textContent(), GUIDE.title, 'and names the guide in its own h1');
  // The canonical is the ONE absolute, production-hosted URL a page carries by design - search
  // engines read it, so it names https://launcher.easter.company even when the page is served from
  // a loopback preview. Its path is what proves the point: the guide, not the overview.
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  assert.equal(new URL(canonical).pathname, '/minecraft/wiki/' + GUIDE.slug + '/',
    'its canonical address is its own document, not the overview');
  assert.equal(new URL(canonical).host, 'launcher.easter.company',
    'and names the production host, which is what a crawler has to be told');
  assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /index,follow/,
    'a guide document is indexable: the restructure exists so that search can find it');
  assert.equal(await page.locator('.wiki-article-section').count(), GUIDE.sections,
    'the body is in the document, in ' + GUIDE.sections + ' sections');
  assert.match(await page.locator('.wiki-intro').first().textContent(), new RegExp(GUIDE.intro),
    'and the guide\'s own words are on it, not a placeholder');
  // A document survives a reload; a rendering does not always.
  await page.reload({waitUntil:'domcontentloaded'});
  assert.equal(page.url(), origin + '/minecraft/wiki/' + GUIDE.slug + '/', 'the address is the state: a reload stays on the guide');
  assert.equal(await page.locator('h1').first().textContent(), GUIDE.title, 'and paints the same guide from the server');
  console.log('Guide document passed: ' + page.url() + ' names its title, h1, canonical and sections, and survives a reload');

  // ---- Section links and shared deep links reach the section ---------------------------------
  const inView = id => page.evaluate(sectionId => {
    const node = document.getElementById(sectionId);
    if (!node) return 'missing';
    const box = node.getBoundingClientRect();
    return box.top >= -2 && box.top < window.innerHeight;
  }, id);
  const toc = page.getByRole('navigation', {name:'On this page', exact:true}).last();
  await toc.getByRole('link', {name:GUIDE.firstSection.label, exact:true}).click();
  assert.equal(new URL(page.url()).hash, '#' + GUIDE.firstSection.id, 'a section link names its section in the address');
  assert.equal(await inView(GUIDE.firstSection.id), true, 'and brings that section into view');
  await page.goto(origin + '/minecraft/wiki/' + GUIDE.slug + '/#chart-a-course', {waitUntil:'domcontentloaded'});
  assert.equal(new URL(page.url()).hash, '#chart-a-course', 'a shared deep link keeps its section');
  assert.equal(await inView('chart-a-course'), true, 'and lands with that section on screen');
  console.log('Section links passed: the on-this-page nav and a shared deep link both reach their section');

  // ---- Navigation between wiki pages ---------------------------------------------------------
  await page.locator('#wiki-topics a').filter({hasText:'Law & bounties'}).first().click();
  await page.waitForURL(origin + '/minecraft/wiki/law-and-bounties/');
  assert.equal(await page.locator('h1').first().textContent(), 'Law & bounties', 'the sidebar reaches another guide');
  assert.equal(await page.locator('#wiki-topics a[aria-current="page"]').count(), 1, 'and marks where the reader is');
  await page.locator('.wiki-breadcrumb a').first().click();
  await page.waitForURL(origin + '/minecraft/wiki/');
  await page.locator('.wiki-card').first().waitFor();
  assert.equal(await page.locator('.wiki-card').count(), GUIDE_COUNT, 'the breadcrumb comes back to the overview');
  console.log('Navigation passed: card in, sidebar across, breadcrumb back');

  // ---- Search ---------------------------------------------------------------------------------
  const search = page.getByLabel('Search the wiki', {exact:true});
  await search.fill('piloting');
  await page.getByRole('heading', {name:'Search the wiki', exact:true}).waitFor();
  assert.equal(await page.locator('.wiki-result').count(), 1, 'one article matches the word piloting');
  assert.match(await page.locator('.wiki-result').first().innerText(), new RegExp(GUIDE.title),
    'and it is the guide that carries it');
  assert.equal(new URL((await resolved(page.locator('.wiki-result')))[0]).pathname,
    '/minecraft/wiki/' + GUIDE.slug + '/', 'a search result is a link to the guide document too');
  await search.fill('zzzzzz');
  await page.getByRole('heading', {name:'No articles found.', exact:true}).waitFor();
  await search.fill('<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('main img').count(), 0, 'a hostile query renders as text and never as markup');
  await page.getByRole('link', {name:'Browse all articles →', exact:true}).click();
  await page.locator('.wiki-card').first().waitFor();
  await page.locator('h1').first().click();
  await page.keyboard.press('/');
  assert.equal(await search.evaluate(node => node === document.activeElement), true, 'and "/" still puts the cursor in the search box');
  // Searching from INSIDE a guide: site/minecraft/wiki/article.js sends the query to the overview.
  await page.goto(origin + '/minecraft/wiki/law-and-bounties/', {waitUntil:'domcontentloaded'});
  await page.getByLabel('Search the wiki', {exact:true}).fill('piloting');
  await page.getByLabel('Search the wiki', {exact:true}).press('Enter');
  await page.waitForURL(origin + '/minecraft/wiki/#/search?q=piloting');
  await page.getByRole('heading', {name:'Search the wiki', exact:true}).waitFor();
  assert.equal(await page.locator('.wiki-result').count(), 1, 'a search started in a guide finds the article from the overview');
  console.log('Search passed: found, empty, hostile query as text, and from inside a guide');

  // ---- The hash routes: the launcher's transport and every old bookmark ----------------------
  // site/minecraft/wiki/wiki.js keeps them, and the restructure did not quietly drop them.
  for (const [id, heading, shape] of [['money-and-banking','Money & banking','steps'], ['law-and-bounties','Law & bounties','table']]) {
    await page.goto(origin + '/minecraft/wiki/#/' + id, {waitUntil:'networkidle'});
    assert.equal(await page.locator('h1').first().textContent(), heading, '#/' + id + ' still renders its article');
    if (shape === 'steps') assert(await page.locator('.wiki-steps li').count() >= 3, 'with its steps intact');
    else assert(await page.locator('.wiki-table').count() >= 1, 'with its table intact');
  }
  // A section that was renamed keeps its old deep link: site/minecraft/wiki/wiki.js carries
  // `sectionAliases`, and the hash-route render rewrites the address and moves focus to the
  // section - the one transport where focus IS moved, because there the article is built by script.
  await page.goto(origin + '/minecraft/wiki/#/the-world-and-its-regions/a-world-to-explore', {waitUntil:'networkidle'});
  await page.waitForFunction(() => document.activeElement?.id === 'region-notices');
  assert.equal(new URL(page.url()).hash, '#/the-world-and-its-regions/region-notices',
    'an old section deep link is steered to the section that replaced it');
  await page.goto(origin + '/minecraft/wiki/#/unknown-page', {waitUntil:'networkidle'});
  await page.getByRole('heading', {name:'That page isn’t on the chart.'}).waitFor();
  await page.getByRole('link', {name:'Back to the wiki →'}).click();
  await page.locator('.wiki-card').first().waitFor();
  console.log('Hash routes passed: articles still render on #/<guide> and an unknown one still says so');

  // ---- The old /wiki/ address: a stub that must keep working ---------------------------------
  // GitHub Pages serves files and cannot answer a 301 for a path, so site/wiki/index.html is the
  // redirect, and it carries location.hash across by hand. That is load-bearing: without it every
  // bookmarked article lands on the overview instead of on the article.
  const stub = await page.request.get(origin + '/wiki/', {maxRedirects:0});
  assert.equal(stub.status(), 200, 'the old address answers 200 rather than 404ing');
  const stubMarkup = await stub.text();
  assert.match(stubMarkup, /<meta name="robots" content="noindex">/, 'the stub keeps itself out of search');
  assert.match(stubMarkup, /<link rel="canonical" href="https:\/\/launcher\.easter\.company\/minecraft\/wiki\/">/,
    'and names the new address canonical');
  assert.match(stubMarkup, /location\.replace\('\.\.\/minecraft\/wiki\/'\+location\.hash\)/,
    'the hop is a navigation of its own, because only that can carry a fragment');
  await page.goto(origin + '/wiki/#/' + GUIDE.slug, {waitUntil:'domcontentloaded'});
  await page.waitForURL(origin + '/minecraft/wiki/#/' + GUIDE.slug);
  assert.equal(await page.locator('h1').first().textContent(), GUIDE.title,
    'a bookmarked article at the old address still opens that article');
  await page.goto(origin + '/wiki/', {waitUntil:'domcontentloaded'});
  await page.waitForURL(origin + '/minecraft/wiki/');
  await page.locator('.wiki-card').first().waitFor();
  assert.equal(await page.locator('.wiki-card').count(), GUIDE_COUNT, 'and a bare old address lands on the overview');
  console.log('Old /wiki/ passed: 200, noindex, canonical and the fragment still carried to the article');

  // ---- The documents read with scripting off --------------------------------------------------
  // The restructure's whole point: a crawler and a reader with no JavaScript get the guide, not a
  // shell. The stub's noscript refresh drops the fragment, which is why it is the script hop - and
  // not this - that keeps bookmarks working.
  const noScript = await browser.newPage({viewport:{width:1440,height:1000}, javaScriptEnabled:false});
  try {
    await noScript.goto(origin + '/minecraft/wiki/', {waitUntil:'load'});
    assert.equal(await noScript.locator('.wiki-card').count(), GUIDE_COUNT, 'the overview is server-rendered');
    for (const href of await noScript.locator('.wiki-card').evaluateAll(nodes => nodes.map(node => node.href))) {
      assert.match(new URL(href).pathname, /^\/minecraft\/wiki\/[a-z0-9-]+\/$/, 'and its cards are document links with no script: ' + href);
    }
    await noScript.goto(origin + '/minecraft/wiki/' + GUIDE.slug + '/', {waitUntil:'load'});
    assert.equal(await noScript.locator('h1').first().textContent(), GUIDE.title, 'a guide reads in full with no scripting');
    assert.equal(await noScript.locator('.wiki-article-section').count(), GUIDE.sections, 'every section of it');
    assert.equal(await noScript.title(), GUIDE.titleTag, 'and still titles itself');
    await noScript.goto(origin + '/wiki/#/' + GUIDE.slug, {waitUntil:'load'});
    await noScript.waitForURL(origin + '/minecraft/wiki/');
    assert.equal(new URL(noScript.url()).hash, '', 'with no scripting the stub\'s refresh drops the fragment: the script hop is what keeps it');
  } finally {
    await noScript.close();
  }
  console.log('No-script passed: the overview and every guide are in the HTML, and the fragment is the one thing that needs the script');

  // ---- It fits the phone ----------------------------------------------------------------
  for (const width of [800, 390, 320]) {
    await page.setViewportSize({width, height: width === 800 ? 600 : 844});
    await page.goto(origin + '/minecraft/wiki/', {waitUntil:'domcontentloaded'});
    await page.locator('.wiki-card').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0,
      'the overview fits ' + width + ' without scrolling sideways');
    const topicsToggle = page.getByRole('button', {name:'Browse topics'});
    if (width < 760) {
      await topicsToggle.click();
      assert.equal(await topicsToggle.getAttribute('aria-expanded'), 'true', 'Browse topics opens at ' + width);
    }
    await page.locator('#wiki-topics a').filter({hasText:'Cooking & crafting'}).first().click();
    await page.waitForURL(origin + '/minecraft/wiki/cooking-and-crafting/');
    assert.equal(await page.locator('h1').first().textContent(), 'Cooking & crafting', 'the sidebar reaches a guide at ' + width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0,
      'and the guide fits ' + width + ' without scrolling sideways');
  }
  console.log('Responsive passed: 800, 390 and 320 fit, and the topics toggle opens where it should');

  assert.deepEqual(errors, [], 'no page error anywhere in this journey');
  console.log('Wiki browser PASS: the guide is twelve real documents reached through the header, a guide names itself and survives a reload, section links, sidebar and breadcrumb navigation, search from the overview and from inside a guide, the hash routes the launcher still uses, the old /wiki/ stub carrying its fragment, and every page readable with scripting off at four widths.');
} finally { await browser.close(); }
