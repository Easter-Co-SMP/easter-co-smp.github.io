/*
 * The store is a page at /store/, not a modal: this walks the whole mock purchase through the
 * real page shell at five viewport sizes, then proves the shape the launcher relies on — no
 * dialog, no inline script, no off-origin request, a header nav entry that navigates, and hash
 * routes that a cold load honours on its own.
 */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.EASTER_PUBLIC_ORIGIN || "http://127.0.0.1:18100",
  output = process.env.EASTER_REVIEW_OUTPUT;
const MOCK_NOTICE =
  "This is a mock store. Products and USD prices are examples. No real payment is taken and nothing is delivered to the game.";
/*
 * The labelled mock surface has to stay labelled wherever the page is scrolled to, not only at
 * the top of the flow: a grid of USD prices and "Sold out" badges with no visible disclaimer
 * reads as a live shop. This scrolls to the bottom of the document, then reads the text of the
 * leaf elements actually inside the viewport and requires at least one of them to say "mock" or
 * "simulated", and the notice itself to still be on screen (it is sticky under the header).
 */
const assertMockInView = async (page, route) => {
  const seen = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const inView = [];
    for (const node of document.body.querySelectorAll("*")) {
      if (node.children.length) continue;
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      if (box.bottom <= 0 || box.top >= window.innerHeight) continue;
      if (getComputedStyle(node).visibility === "hidden") continue;
      const text = (node.innerText || "").trim();
      if (/mock|simulated/i.test(text)) inView.push(text);
    }
    const notice = document.querySelector(".store-demo");
    const box = notice.getBoundingClientRect();
    return {
      scrollY: Math.round(window.scrollY),
      docHeight: document.documentElement.scrollHeight,
      inView,
      notice: {
        position: getComputedStyle(notice).position,
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        viewport: window.innerHeight,
        mock: /mock|simulated/i.test(notice.innerText || ""),
      },
    };
  });
  assert.ok(
    seen.scrollY > 0,
    `the page at ${route} actually scrolled (${seen.scrollY} of ${seen.docHeight})`,
  );
  assert.equal(
    seen.notice.position,
    "sticky",
    `the mock notice is pinned, not only at the top of ${route}`,
  );
  assert.ok(
    seen.notice.top >= 0 && seen.notice.bottom <= seen.notice.viewport,
    `the mock notice is on screen at the bottom of ${route} (top ${seen.notice.top}, bottom ${seen.notice.bottom}, viewport ${seen.notice.viewport})`,
  );
  assert.ok(
    seen.notice.mock && seen.inView.length > 0,
    `a visible element still says the surface is a mock at the bottom of ${route}: ${JSON.stringify(seen.inView.slice(0, 4))}`,
  );
  // While the store's own sticky columns are pinned, the notice must not sit on top of them:
  // both start below it (store.css pins them at the notice's measured 42px).
  const pinned = await page.evaluate(() => {
    window.scrollTo(0, 600);
    const notice = document.querySelector(".store-demo").getBoundingClientRect();
    const sidebar = document.querySelector(".store-sidebar");
    const box = sidebar.getBoundingClientRect();
    const offset = parseFloat(getComputedStyle(sidebar).top) || 0;
    const first = sidebar.firstElementChild?.getBoundingClientRect() ?? null;
    return {
      sticky: getComputedStyle(sidebar).position === "sticky",
      pinned: Math.abs(box.top - offset) <= 1,
      noticeBottom: Math.round(notice.bottom),
      firstChildTop: first ? Math.round(first.top) : null,
    };
  });
  if (pinned.sticky && pinned.pinned)
    assert.ok(
      pinned.firstChildTop >= pinned.noticeBottom - 1,
      `the pinned notice does not cover the sticky sidebar at ${route} (notice bottom ${pinned.noticeBottom}, sidebar top ${pinned.firstChildTop})`,
    );
  await page.evaluate(() => window.scrollTo(0, 0));
};
const bridge = () => {
  const state = {
    phase: "idle",
    settings: {},
    install: {},
    profile: null,
    actions: [],
    startupReady: true,
  };
  window.easterDesktop = {
    mode: "desktop",
    status: async () => state,
    onState: () => () => {},
    homeContent: async () => ({ schema: 1, posts: [], featuredItem: null }),
  };
};
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const [width, height] of [
    [1440, 1000],
    [1100, 760],
    [800, 700],
    [390, 844],
    [320, 568],
  ]) {
    const page = await browser.newPage({
        viewport: { width, height },
        reducedMotion: "reduce",
      }),
      errors = [],
      external = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith(origin)) external.push(r.url());
    });
    // The launcher's own bridge and no click: /store/ has to be the store on its own, reached by
    // navigation, with nothing having been opened for it. The bridge is required now (Owen,
    // 2026-10-23: the store is hidden outside the launcher), so this is the shape the launcher
    // gives it: the isolated preload claiming desktop mode and nothing else.
    await page.addInitScript(bridge);
    await page.goto(origin + "/store/", { waitUntil: "networkidle" });
    // downloads.js owns the header's Download popover and its setup dialog, so what is
    // asserted here is that the store itself is no dialog and nothing is open over the page.
    assert.equal(await page.locator(".company-store").count(), 0);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(
      await page.getByRole("heading", { name: "The Community store" }).count(),
      1,
    );
    assert.equal(
      await page.locator(".preview-panel, #open-store").count(),
      0,
      "no preview panel and no open-store trigger",
    );
    assert.equal(
      await page
        .locator('.site-header nav a[aria-current="page"]')
        .getAttribute("href"),
      "../store/",
      "the shared nav marks Store as the current page",
    );
    assert.equal(
      await page.locator('.site-header nav a[href$="store/"]').count(),
      1,
      "the nav lists Store once",
    );
    assert.equal(
      await page.locator("script:not([src])").count(),
      0,
      "no inline script, so the launcher's script-src 'self' CSP holds",
    );
    assert.equal(
      await page.locator('link[rel="stylesheet"][href="store.css"]').count(),
      1,
      "store.css is linked from the page head, not injected",
    );
    assert.equal(
      (await page.locator(".store-demo").innerText()).replace(/\s+/g, " "),
      MOCK_NOTICE,
    );
    assert.ok(
      await page.locator(".store-demo").isVisible(),
      "the mock notice is on the page without any interaction",
    );
    const store = page.locator(".store-app");
    await store.locator(".store-product").first().waitFor();
    assert.equal(new URL(page.url()).hash, "#catalogue");
    assert.equal(await store.locator(".store-product").count(), 9);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "no horizontal page overflow",
    );
    // The store's type belongs to the site: the same stack the rest of site/ renders in, and a
    // heading order where the page title is the largest thing on it.
    const type = await page.evaluate(() => {
      const family = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily;
      const sizes = [
        ...document.querySelectorAll(".store-main h1,.store-main h2,.store-main h3"),
      ].map((n) => ({ tag: n.tagName, size: parseFloat(getComputedStyle(n).fontSize) }));
      return {
        siteFamily: getComputedStyle(document.body).fontFamily,
        storeFamily: family(".store-app"),
        demoFamily: family(".store-demo"),
        introFamily: family(".store-intro"),
        sizes,
      };
    });
    assert.match(type.siteFamily, /^Inter/, "the site itself renders in Inter");
    assert.equal(
      type.storeFamily,
      type.siteFamily,
      "store text uses the site's own stack, not a system-ui shorthand",
    );
    assert.equal(type.demoFamily, type.siteFamily);
    assert.equal(type.introFamily, type.siteFamily);
    const largest = (tag) =>
      Math.max(
        0,
        ...type.sizes.filter((s) => s.tag === tag).map((s) => s.size),
      );
    assert.ok(
      largest("H1") >= 34,
      `the page title is at the site's page-heading scale (${largest("H1")}px)`,
    );
    assert.ok(
      largest("H1") >= largest("H2") && largest("H2") >= largest("H3"),
      `heading sizes are ordered h1 ${largest("H1")} >= h2 ${largest("H2")} >= h3 ${largest("H3")}`,
    );
    await assertMockInView(page, "#catalogue");
    if (output)
      await page.screenshot({ path: `${output}/store-catalogue-${width}.png` });
    await store
      .getByRole("button", { name: "Player houses", exact: true })
      .click();
    assert.equal(await store.locator(".store-product").count(), 2);
    assert.equal(
      await store
        .getByRole("button", { name: "Add Clifftop Residence to cart" })
        .isDisabled(),
      true,
    );
    await store.getByRole("button", { name: "View Harbour Cottage" }).click();
    await store.getByRole("heading", { name: "Before you buy" }).waitFor();
    assert.match(
      new URL(page.url()).hash,
      /^#item\/harbour-cottage$/,
      "an item detail has its own address",
    );
    await assertMockInView(page, "#item/harbour-cottage");
    if (output)
      await page.screenshot({ path: `${output}/store-detail-${width}.png` });
    await store
      .getByRole("button", { name: "Add to cart", exact: true })
      .click();
    await store
      .getByRole("button", { name: "In-game money", exact: true })
      .click();
    await store
      .getByRole("button", { name: "Add 1,000 Crowns to cart" })
      .click();
    await store.getByRole("button", { name: "Ships", exact: true }).click();
    await store
      .getByRole("button", { name: "Add The Coastal Sloop to cart" })
      .click();
    await store
      .getByRole("button", { name: "Account upgrades", exact: true })
      .click();
    await store
      .getByRole("button", { name: "Add Priority boarding to cart" })
      .click();
    await store.getByRole("button", { name: "Items", exact: true }).click();
    await store
      .getByRole("button", { name: "Add Voyager’s provisions to cart" })
      .click();
    await store.getByRole("link", { name: "Cart · 5", exact: true }).click();
    assert.equal(new URL(page.url()).hash, "#cart");
    await store
      .getByRole("spinbutton", { name: "Quantity for 1,000 Crowns" })
      .fill("2");
    await store
      .getByRole("spinbutton", { name: "Quantity for 1,000 Crowns" })
      .press("Tab");
    await store.getByRole("link", { name: "Cart · 6", exact: true }).waitFor();
    await assertMockInView(page, "#cart");
    if (output)
      await page.screenshot({ path: `${output}/store-cart-${width}.png` });
    await store.getByRole("button", { name: "Review checkout" }).click();
    await store.getByRole("heading", { name: "Review your order" }).waitFor();
    assert.equal(new URL(page.url()).hash, "#checkout");
    await assertMockInView(page, "#checkout");
    const submit = store.getByRole("button", { name: /Place test order/ });
    assert.equal(await submit.isDisabled(), true);
    assert.equal(
      await store.locator("input").count(),
      1,
      "no real payment fields",
    );
    assert.match(
      await store.innerText(),
      /Crowns are only spendable inside the game/,
    );
    if (output)
      await page.screenshot({ path: `${output}/store-checkout-${width}.png` });
    await store.getByRole("checkbox").check();
    await submit.click();
    await store
      .getByRole("heading", { name: "Your test order is complete." })
      .waitFor();
    assert.match(new URL(page.url()).hash, /^#receipt\/.+/);
    assert.match(await store.innerText(), /No money was charged/);
    if (output)
      await page.screenshot({ path: `${output}/store-receipt-${width}.png` });
    await store.getByRole("button", { name: "View orders" }).click();
    await store.locator(".store-order-record").waitFor();
    assert.equal(new URL(page.url()).hash, "#orders");
    assert.equal(await store.locator(".store-order-record").count(), 1);
    await assertMockInView(page, "#orders");
    // Back and Forward belong to the browser, not to a private view stack.
    await page.goBack();
    await store.locator(".store-receipt").waitFor();
    assert.match(new URL(page.url()).hash, /^#receipt\/.+/);
    await page.goForward();
    await store.locator(".store-order-record").waitFor();
    assert.equal(new URL(page.url()).hash, "#orders");
    await store.getByRole("link", { name: "Browse", exact: true }).click();
    assert.equal(new URL(page.url()).hash, "#catalogue");
    await store
      .getByRole("searchbox", { name: "Search the store" })
      .fill("zzzz");
    await store.getByRole("heading", { name: "No items found" }).waitFor();
    await store.getByRole("button", { name: "Clear search" }).click();
    assert.equal(await store.locator(".store-product").count(), 2);
    await store
      .getByRole("button", { name: "Player houses", exact: true })
      .click();
    assert.match(
      await store.locator(".store-product").first().innerText(),
      /In demo library/,
    );
    // The page still scrolls and takes focus without a mouse.
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement !== null),
      true,
      "focus stays in the page",
    );
    const privacy = await page
      .getByRole("link", { name: "Privacy", exact: true })
      .getAttribute("href");
    const privacyResponse = await page.request.get(
      new URL(privacy, page.url()).href,
    );
    assert.equal(privacyResponse.status(), 200);
    assert.deepEqual(errors, [], "no page error");
    assert.deepEqual(external, [], "nothing is fetched off-origin");
    console.log("Store page and purchase flow passed:", width, height);
    await page.close();
  }
  // A cold load of a shared link opens that view directly.
  const coldLoad = async (hash, check) => {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 760 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(bridge);
    await page.goto(origin + "/store/" + hash, { waitUntil: "networkidle" });
    await check(page);
    assert.deepEqual(errors, [], "no page error on " + hash);
    await page.close();
  };
  await coldLoad("#cart", async (page) => {
    await page.getByRole("heading", { name: "Your cart" }).waitFor();
    assert.match(
      await page.locator(".store-app").innerText(),
      /Your next adventure starts here/,
    );
  });
  await coldLoad("#item/harbour-cottage", async (page) => {
    await page.getByRole("heading", { name: "Harbour Cottage" }).waitFor();
    await page.getByRole("heading", { name: "Before you buy" }).waitFor();
  });
  await coldLoad("#orders", async (page) => {
    await page.getByRole("heading", { name: "Demo orders" }).waitFor();
    assert.match(await page.locator(".store-app").innerText(), /No orders yet/);
  });
  // A route this session cannot honour falls back to the view that can, in place.
  await coldLoad("#receipt/no-such-order", async (page) => {
    await page.getByRole("heading", { name: "Demo orders" }).waitFor();
    assert.equal(new URL(page.url()).hash, "#orders");
  });
  await coldLoad("#nonsense", async (page) => {
    await page.locator(".store-product").first().waitFor();
    assert.equal(new URL(page.url()).hash, "#catalogue");
  });
  // THE STORE IS A LAUNCHER SURFACE, NOT A WEBSITE DESTINATION. Owen, 2026-10-23: *"hide all
  // store elements when not inside of launcher."* The link stays in every page's static markup
  // because each page's route to the store is relative and the launcher needs each one correct
  // (./store/ from the home page, ../store/ from map, wiki and the store itself), so what makes
  // the website storeless is desktop.css hiding it until `desktop-mode` arrives. That is why the
  // no-script page is asserted first: it is the case with no JavaScript at all to hide anything.
  const noScript = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    javaScriptEnabled: false,
  });
  try {
    await noScript.goto(origin + "/", { waitUntil: "load" });
    const staticEntry = noScript.locator(".site-header nav a.store-entry");
    assert.equal(
      await staticEntry.count(),
      1,
      "the home markup still carries the Store link, so the launcher has a route on every page",
    );
    assert.equal(
      await staticEntry.isVisible(),
      false,
      "without the bridge the Store entry is hidden, not merely moved down the page",
    );
    assert.equal(
      await noScript.locator(".site-header nav").evaluate((nav) =>
        [...nav.children]
          .filter((n) => n.getClientRects().length > 0)
          .map((n) => n.textContent.trim().replace(/\s+/g, " ").split(" ")[0])
          .join(" "),
      ),
      "Home Download Map Wiki",
      "the home header offers four destinations, and the store is not one of them",
    );
    await noScript.goto(origin + "/store/", { waitUntil: "load" });
    assert.equal(
      await noScript.locator(".store-main").isVisible(),
      false,
      "a browser at /store/ with no script paints no store at all",
    );
    assert.equal(await noScript.locator(".store-demo").isVisible(), false);
    assert.equal(
      await noScript.locator(".store-product").count(),
      0,
      "no catalogue, no prices and no product markup reach a browser",
    );
  } finally {
    await noScript.close();
  }
  // The same page with script running and still no bridge: no store entry, and /store/ sends the
  // visitor back to the site rather than showing a catalogue they have no way to buy from.
  const plain = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const plainErrors = [];
  plain.on("pageerror", (e) => plainErrors.push(e.message));
  try {
    await plain.goto(origin + "/", { waitUntil: "networkidle" });
    assert.equal(
      await plain.evaluate(() => typeof window.easterDesktop),
      "undefined",
      "a plain browser page has no desktop bridge",
    );
    assert.equal(
      await plain.evaluate(() =>
        document.documentElement.classList.contains("desktop-mode"),
      ),
      false,
      "a browser cannot put itself into desktop mode",
    );
    assert.equal(
      await plain.locator('.site-header nav a[href*="store/"]:visible').count(),
      0,
      "the home nav shows no Store entry in a browser, scripted or not",
    );
    await plain.goto(origin + "/store/", { waitUntil: "networkidle" });
    await plain.waitForURL(origin + "/");
    assert.equal(
      await plain.locator(".store-main").count(),
      0,
      "a browser that asks for /store/ is sent home and shown no store page",
    );
    assert.deepEqual(plainErrors, [], "no page error redirecting a browser home");
  } finally {
    await plain.close();
  }
  // The launcher's nav entry is a link to the page, not a modal behind a button.
  const launcher = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const launcherErrors = [];
  launcher.on("pageerror", (e) => launcherErrors.push(e.message));
  await launcher.addInitScript(bridge);
  await launcher.goto(origin, { waitUntil: "networkidle" });
  assert.equal(
    await launcher.getByRole("button", { name: "Store", exact: true }).count(),
    0,
    "no Store button that opens a dialog",
  );
  const entry = launcher.locator(".site-header nav a.store-entry");
  assert.equal(await entry.textContent(), "Store");
  assert.equal(
    await entry.isVisible(),
    true,
    "inside the launcher the store entry is shown, which is the whole difference",
  );
  await entry.click();
  await launcher.waitForURL(origin + "/store/");
  await launcher
    .getByRole("heading", { name: "The Community store" })
    .waitFor();
  assert.equal(
    await launcher.locator('.site-header nav a[href*="store/"]').count(),
    1,
    "the nav lists Store once",
  );
  assert.equal(await launcher.locator(".company-store").count(), 0);
  assert.equal(await launcher.locator("dialog[open]").count(), 0);
  assert.deepEqual(launcherErrors, []);
  console.log("Launcher nav entry navigates to the store page");
  await launcher.close();
  // Isolated adapter injection: retry a decline, retain cart, expire a quote, recover a read.
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const { createMockStoreAPI } = await import("/store/mock-api.mjs");
    const { mountStore } = await import("/store/store.mjs");
    window.demoClock = Date.now();
    window.storeAPI = createMockStoreAPI({
      latency: 0,
      now: () => window.demoClock,
    });
    const host = document.createElement("div");
    host.id = "injected-store";
    document.body.append(host);
    window.testStore = mountStore(host, { api: window.storeAPI });
  });
  const store = page.locator("#injected-store");
  await store.locator(".store-product").first().waitFor();
  await store
    .getByRole("button", { name: "Add The Coastal Sloop to cart", exact: true })
    .click();
  await store.getByRole("link", { name: "Cart · 1" }).click();
  await store.getByRole("button", { name: "Review checkout" }).click();
  await store.getByRole("checkbox").check();
  await page.evaluate(() => storeAPI.failNext("purchase"));
  await store.getByRole("button", { name: /Place test order/ }).click();
  await store.getByRole("alert").filter({ hasText: "declined" }).waitFor();
  assert.equal(await store.getByRole("checkbox").isChecked(), false);
  await store.getByRole("checkbox").check();
  await store.getByRole("button", { name: /Place test order/ }).click();
  await store
    .getByRole("heading", { name: "Your test order is complete." })
    .waitFor();
  await store.getByRole("button", { name: "Continue exploring" }).click();
  await store.getByRole("button", { name: "Add 1,000 Crowns to cart" }).click();
  await store.getByRole("link", { name: "Cart · 1" }).click();
  await store.getByRole("button", { name: "Review checkout" }).click();
  await store.getByRole("checkbox").check();
  await page.evaluate(() => (window.demoClock += 120001));
  await store.getByRole("button", { name: /Place test order/ }).click();
  await store.getByRole("alert").filter({ hasText: "expired" }).waitFor();
  // An expired quote leaves the checkout route, so the cart is what is on screen next.
  await store.getByRole("button", { name: "Review checkout" }).waitFor();
  await store.getByRole("button", { name: "Review checkout" }).click();
  await store.getByRole("checkbox").check();
  await page.evaluate(() => storeAPI.failNext("purchase-response", "NETWORK"));
  await store.getByRole("button", { name: /Place test order/ }).click();
  await store.getByRole("alert").filter({ hasText: "interrupted" }).waitFor();
  await store.getByRole("checkbox").check();
  await store.getByRole("button", { name: /Place test order/ }).click();
  await store
    .getByRole("heading", { name: "Your test order is complete." })
    .waitFor();
  assert.equal(
    await page.evaluate(async () => (await storeAPI.orders()).length),
    2,
    "interrupted response retries one order, not another payment",
  );
  await page.evaluate(() => {
    storeAPI.failNext("catalogue", "OFFLINE");
    return window.testStore.reload();
  });
  await store.getByRole("alert").waitFor();
  await store.getByRole("button", { name: "Try again", exact: true }).click();
  // The receipt is still the route the retried read belongs to, so the catalogue is one link away.
  await store.getByRole("link", { name: "Browse", exact: true }).click();
  await store.locator(".store-product").first().waitFor();
  console.log(
    "Store decline, quote expiry, interrupted response and catalogue retry passed",
  );
  await page.close();
} finally {
  await browser.close();
}
