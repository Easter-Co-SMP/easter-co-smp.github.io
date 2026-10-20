import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.EASTER_PUBLIC_ORIGIN || "http://127.0.0.1:18100",
  output = process.env.EASTER_REVIEW_OUTPUT;
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
  ]) {
    const page = await browser.newPage({
        viewport: { width, height },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
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
    });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Store", exact: true }).click();
    const store = page.locator(".company-store");
    await store.locator(".store-product").first().waitFor();
    assert.equal(
      await store.getByRole("heading", { name: "The Company store" }).count(),
      1,
    );
    assert.equal(await store.locator(".store-product").count(), 9);
    assert.ok(
      await store.evaluate((n) => n.scrollWidth <= n.clientWidth),
      "no horizontal store overflow",
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
    await store.getByRole("button", { name: "Cart · 5", exact: true }).click();
    await store
      .getByRole("spinbutton", { name: "Quantity for 1,000 Crowns" })
      .fill("2");
    await store
      .getByRole("spinbutton", { name: "Quantity for 1,000 Crowns" })
      .press("Tab");
    await store
      .getByRole("button", { name: "Cart · 6", exact: true })
      .waitFor();
    if (output)
      await page.screenshot({ path: `${output}/store-cart-${width}.png` });
    await store.getByRole("button", { name: "Review checkout" }).click();
    await store.getByRole("heading", { name: "Review your order" }).waitFor();
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
    assert.match(await store.innerText(), /No money was charged/);
    if (output)
      await page.screenshot({ path: `${output}/store-receipt-${width}.png` });
    await store.getByRole("button", { name: "View orders" }).click();
    await store.locator(".store-order-record").waitFor();
    assert.equal(await store.locator(".store-order-record").count(), 1);
    await store.getByRole("button", { name: "Browse", exact: true }).click();
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
    await page.keyboard.press("Escape");
    assert.equal(await store.evaluate((n) => n.open), false);
    assert.equal(
      await page
        .getByRole("button", { name: "Store", exact: true })
        .evaluate((n) => n === document.activeElement),
      true,
    );
    assert.deepEqual(errors, []);
    console.log("Store purchase and responsive flow passed:", width, height);
    await page.close();
  }
  // Isolated adapter injection: retry a decline, retain cart, expire a quote, recover a read.
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const { createMockStoreAPI } = await import("/store/mock-api.mjs");
    const { createStore } = await import("/store/store.mjs");
    window.demoClock = Date.now();
    window.storeAPI = createMockStoreAPI({
      latency: 0,
      now: () => window.demoClock,
    });
    window.testStore = createStore({ api: window.storeAPI });
    testStore.open();
  });
  const store = page.locator(".company-store");
  await store.locator(".store-product").first().waitFor();
  await store
    .getByRole("button", { name: "Add The Coastal Sloop to cart", exact: true })
    .click();
  await store.getByRole("button", { name: "Cart · 1" }).click();
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
  await store.getByRole("button", { name: "Cart · 1" }).click();
  await store.getByRole("button", { name: "Review checkout" }).click();
  await store.getByRole("checkbox").check();
  await page.evaluate(() => (window.demoClock += 120001));
  await store.getByRole("button", { name: /Place test order/ }).click();
  await store.getByRole("alert").filter({ hasText: "expired" }).waitFor();
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
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    storeAPI.failNext("catalogue", "OFFLINE");
    testStore.open();
  });
  await store.getByRole("alert").waitFor();
  await store.getByRole("button", { name: "Try again", exact: true }).click();
  await store.locator(".store-product").first().waitFor();
  console.log(
    "Store decline, quote expiry, interrupted response and catalogue retry passed",
  );
  await page.close();
} finally {
  await browser.close();
}
