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
    // No click and no bridge: /store/ has to be the store on its own.
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
    if (output)
      await page.screenshot({ path: `${output}/store-cart-${width}.png` });
    await store.getByRole("button", { name: "Review checkout" }).click();
    await store.getByRole("heading", { name: "Review your order" }).waitFor();
    assert.equal(new URL(page.url()).hash, "#checkout");
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
  const entry = launcher.locator('.site-header nav a[href="./store/"]');
  assert.equal(await entry.textContent(), "Store");
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
