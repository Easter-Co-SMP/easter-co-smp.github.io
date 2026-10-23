/*
 * THE CATALOGUE IS THE SERVER'S, AND NOTHING ELSE IS.
 *
 * This file replaces the "game-scoped storefronts" suite that used to live here: it drove the
 * mock store's "Choose Your Game" picker, its three fictional games, its category chips and its
 * coming-soon concept cards. Owen's store sells five real products and is reached from the
 * launcher's own nav, so that picker and its fixtures are deleted rather than trimmed, and what
 * this suite proves instead is the property that mattered in it — that the page has no catalogue,
 * no price and no product word of its own. It renders exactly the list the server sends, in the
 * server's order, and says so when it has no list at all.
 *
 * The stubbed bridge sends deliberately unusual products (made-up names, a made-up worth, a
 * four-figure price, an 80-character name) precisely because site/ must not have an opinion
 * about any of it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.EASTER_PUBLIC_ORIGIN || "http://127.0.0.1:18100";
const UNAVAILABLE = "The store is unavailable right now.";
// None of this is one of Easter Co. SMP's products: if any of it renders, the page is drawing the
// server's answer rather than a fixture of its own.
const SERVER_PRODUCTS = [
  { key: "zzz-last", name: "A Server Named Product", amountMinor: 100000, currency: "USD", kind: "sterling", creditPence: 2500 },
  { key: "aaa-first", name: "Another One", amountMinor: 3, currency: "USD", kind: "donation", creditPence: 0 },
  { key: "long-name", name: "A Product Whose Name Is Deliberately Long Enough To Wrap In Any Card", amountMinor: 4567, currency: "USD", kind: "sterling", creditPence: 7 },
];
function installBridge(cfg) {
  window.__store = { checkouts: [] };
  window.easterDesktop = {
    mode: "desktop",
    status: async () => ({ phase: "idle", settings: {}, install: {}, profile: null, actions: [], startupReady: true }),
    onState: () => () => {},
    homeContent: async () => ({ schema: 1, posts: [], featuredItem: null }),
    storeCatalogue: async () => ({ products: cfg.products }),
    storeCheckout: async (key) => {
      window.__store.checkouts.push(key);
      return { url: "https://checkout.stripe.com/c/pay/cs_test_1", sessionId: "cs_test_1", product: key };
    },
    storeOrders: async () => ({ orders: [] }),
  };
}
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const open = async (config, { width = 1280, height = 900 } = {}) => {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installBridge, config);
  await page.goto(origin + "/store/", { waitUntil: "networkidle" });
  return { page, errors };
};
try {
  for (const [width, height] of [
    [1280, 900],
    [800, 700],
    [390, 844],
    [320, 568],
  ]) {
    const { page, errors } = await open({ products: SERVER_PRODUCTS }, { width, height });
    try {
      const store = page.locator(".store-app");
      await store.locator(".store-product").first().waitFor();
      assert.deepEqual(
        await store.locator(".store-product-name").allInnerTexts(),
        SERVER_PRODUCTS.map((p) => p.name),
        "the page keeps the server's order, whatever it is",
      );
      assert.deepEqual(
        await store.locator(".store-price").allInnerTexts(),
        ["$1,000.00", "$0.03", "$45.67"],
        "every price is the server's own minor amount, formatted and not recalculated",
      );
      assert.deepEqual(
        await store.locator(".store-worth").allInnerTexts(),
        ["25 Sterling in your bank", "A one-off donation.", "0.07 Sterling in your bank"],
        "the worth line comes from creditPence and names the bank, and a product that credits nothing is a donation",
      );
      // No product, price, category or placeholder of the old mock survives anywhere on the page.
      const served = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      for (const ghost of [
        "Coastal Sloop",
        "Harbour Cottage",
        "Clifftop Residence",
        "Merchant Brig",
        "Priority boarding",
        "Voyager",
        "Crowns",
        "Choose Your Game",
        "Orbital Racing",
        "Frontier",
        "Coming soon",
      ])
        assert.equal(served.includes(ghost), false, `${ghost} is gone from the page`);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `no horizontal overflow at ${width}, including the 80-character name`,
      );
      const longNameInside = await store
        .locator(".store-product")
        .nth(2)
        .locator(".store-product-name")
        .evaluate((name) => {
          const card = name.closest(".store-product").getBoundingClientRect(),
            box = name.getBoundingClientRect();
          return box.left >= card.left && box.right <= card.right;
        });
      assert.equal(longNameInside, true, "a long product name stays inside its card");
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
  console.log("Server-driven catalogue passed at 1280, 800, 390 and 320");
  // A press sends the key the server sent, even one this file has never heard of.
  {
    const { page } = await open({ products: SERVER_PRODUCTS });
    try {
      await page.locator(".store-product").first().waitFor();
      await page.getByRole("button", { name: "Buy A Server Named Product" }).click();
      await page.waitForFunction(() => window.__store.checkouts.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__store.checkouts), ["zzz-last"]);
    } finally {
      await page.close();
    }
    console.log("Buy sends the server's own product key");
  }
  // Nothing for sale is a shut door, not an empty shop: an answer with no products draws no cards
  // and says the one sentence, so a misconfigured server cannot look like a frontend bug.
  {
    const { page, errors } = await open({ products: [] });
    try {
      const store = page.locator(".store-app");
      await store.locator(".store-feedback span").waitFor();
      assert.equal(
        (await store.locator(".store-feedback span").innerText()).trim(),
        UNAVAILABLE,
      );
      assert.equal(await store.locator(".store-product").count(), 0);
      assert.equal(await store.getByRole("button").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
    console.log("An empty catalogue says the store is unavailable and draws nothing");
  }
  // The page's own source carries no product, no price and no catalogue module to fall back on:
  // the server is the only source of what is for sale. The frozen copy's words are allowed; a
  // dollar amount or one of the five live product keys is not.
  {
    const source = await readFile(new URL("../site/store/store.mjs", import.meta.url), "utf8");
    for (const ghost of [
      "sterling-10",
      "sterling-100",
      "sterling-1000",
      "donation-5",
      "Keep the lights on",
      "Penny for the poor",
      "$1.49",
      "$6.95",
      "$29.99",
      "amountMinor\":149",
      "creditPence:100000",
    ])
      assert.equal(source.includes(ghost), false, `site/store/store.mjs hard-codes ${ghost}`);
    for (const removed of ["catalogue.mjs", "mock-api.mjs"]) {
      await assert.rejects(
        readFile(new URL("../site/store/" + removed, import.meta.url)),
        /ENOENT/,
        `${removed} is deleted, not left unreachable`,
      );
    }
  }
  console.log("The page carries no catalogue, no product and no price of its own");
} finally {
  await browser.close();
}
