/*
 * The Community store is a page at /store/ and the real one: five products the server sells,
 * one at a time from their own cards, and the player's own orders. This suite drives the real
 * page shell against a STUBBED LAUNCHER BRIDGE at five viewport sizes and proves the shape the
 * launcher relies on - no dialog, no inline script, no off-origin request, a header nav entry
 * that navigates, hash routes a cold load honours, a stale route landing on the catalogue, and
 * the launcher-only rule the previous commit enforced.
 *
 * What is NOT proved here: any real payment, and any real server answer. The account API's
 * catalogue and orders routes do not exist yet, so the only honest way to drive this page is a
 * stand-in that answers exactly the frozen wire shape (ticket 45bb99ad) and records what the
 * page asked for. `tests/store.test.mjs` proves the main-process half that shapes those answers.
 */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.EASTER_PUBLIC_ORIGIN || "http://127.0.0.1:18100",
  output = process.env.EASTER_REVIEW_OUTPUT;
// The five live products, in the server's order, exactly as the cloud half is to send them.
const PRODUCTS = [
  { key: "sterling-10", name: "10 Sterling", amountMinor: 149, currency: "USD", kind: "sterling", creditPence: 1000 },
  { key: "sterling-100", name: "100 Sterling", amountMinor: 695, currency: "USD", kind: "sterling", creditPence: 10000 },
  { key: "sterling-1000", name: "1000 Sterling", amountMinor: 2999, currency: "USD", kind: "sterling", creditPence: 100000 },
  { key: "donation-5", name: "Keep the lights on", amountMinor: 500, currency: "USD", kind: "donation", creditPence: 0 },
  { key: "penny", name: "Penny for the poor", amountMinor: 1, currency: "USD", kind: "donation", creditPence: 0 },
];
// Owen's sentences, character for character. This suite is their second reader: if the page is
// ever reworded, this stops rather than blessing the new wording.
const COPY = {
  buy: "Buy",
  opening: "Opening Stripe\u2026",
  finish:
    "Finish the payment in your browser. Your Sterling arrives the next time you join.",
  signedOut: "Sign in to buy.",
  unavailable: "The store is unavailable right now.",
  orders: "Your orders",
  noOrders: "No orders yet.",
  paid: "Paid",
  delivered: "In the game",
  donation: "A one-off donation.",
};
const ORDER = {
  sessionId: "cs_test_a1",
  product: "sterling-100",
  amountMinor: 695,
  currency: "USD",
  paid: false,
  delivered: false,
  creditPence: 10000,
  createdAt: "2026-10-23T10:00:00.000Z",
};
// The isolated preload's own shape, with the three store commands a stub answers. `cfg` carries
// the products, the orders and the one failure a scenario is about.
function installBridge(cfg) {
  const home = { schema: 1, posts: [], featuredItem: null };
  const store = { catalogue: 0, orders: 0, checkouts: [], release: null };
  window.__store = store;
  window.easterDesktop = {
    mode: "desktop",
    status: async () => ({
      phase: "idle",
      settings: {},
      install: {},
      profile: null,
      actions: [],
      startupReady: true,
    }),
    onState: () => () => {},
    homeContent: async () => home,
    storeCatalogue: async () => {
      store.catalogue += 1;
      if (cfg.catalogueError) throw new Error(cfg.catalogueError);
      return { products: cfg.products };
    },
    storeOrders: async () => {
      store.orders += 1;
      if (cfg.ordersError) throw new Error(cfg.ordersError);
      return { orders: cfg.orders || [] };
    },
    storeCheckout: async (key) => {
      store.checkouts.push(key);
      if (cfg.checkoutError) throw new Error(cfg.checkoutError);
      const answer = {
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
        sessionId: "cs_test_1",
        product: key,
      };
      // A held answer is how the "while the browser opens" sentence is read at all: it is
      // painted only while main has not come back yet.
      if (!cfg.holdCheckout) return answer;
      return new Promise((resolve) => {
        store.release = () => resolve(answer);
      });
    },
  };
}
// A preload from a build that does not carry the store at all.
function installBridgeWithoutStore() {
  window.easterDesktop = {
    mode: "desktop",
    status: async () => ({ phase: "idle", settings: {}, install: {}, profile: null, actions: [], startupReady: true }),
    onState: () => () => {},
    homeContent: async () => ({ schema: 1, posts: [], featuredItem: null }),
  };
}
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const opened = [];
async function openPage({ width = 1440, height = 1000, init, arg, url } = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  const errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) external.push(r.url());
  });
  if (init) await page.addInitScript(init, arg);
  if (url) await page.goto(url, { waitUntil: "networkidle" });
  opened.push({ page, errors, external });
  return { page, errors, external };
}
const storePage = async (options = {}) => {
  const session = await openPage({
    ...options,
    init: installBridge,
    arg: options.config || { products: PRODUCTS, orders: [] },
    url: origin + "/store/" + (options.hash || ""),
  });
  await session.page.locator(".store-app").waitFor();
  return session;
};
const text = async (page) =>
  (await page.locator(".store-app").innerText()).replace(/\s+/g, " ");
try {
  for (const [width, height] of [
    [1440, 1000],
    [1100, 760],
    [800, 700],
    [390, 844],
    [320, 568],
  ]) {
    const { page, errors, external } = await storePage({ width, height });
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(
      await page.getByRole("heading", { name: "The Community store" }).count(),
      1,
    );
    assert.equal(
      await page.locator('.site-header nav a[aria-current="page"]').getAttribute("href"),
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
    // The mock is gone, completely: no notice, no demo wording, no example product anywhere on
    // the page, whether or not it is on screen.
    const pageText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert.doesNotMatch(pageText, /mock|simulat|demo|test order|no real payment/i);
    const store = page.locator(".store-app");
    await store.locator(".store-product").first().waitFor();
    assert.equal(new URL(page.url()).hash, "#catalogue");
    assert.equal(await store.locator(".store-product").count(), 5, "five products, and only five");
    assert.deepEqual(
      await store.locator(".store-product-name").allInnerTexts(),
      PRODUCTS.map((p) => p.name),
      "the catalogue is drawn in the server's order",
    );
    assert.deepEqual(
      await store.locator(".store-price").allInnerTexts(),
      ["$1.49", "$6.95", "$29.99", "$5.00", "$0.01"],
      "every price is the server's USD amount",
    );
    assert.deepEqual(
      await store.locator(".store-worth").allInnerTexts(),
      [
        "10 Sterling in your bank",
        "100 Sterling in your bank",
        "1,000 Sterling in your bank",
        COPY.donation,
        COPY.donation,
      ],
      "a pack says what it is worth from creditPence, and a donation says it is a donation",
    );
    assert.equal(await store.getByRole("button", { name: /^Buy / }).count(), 5);
    assert.equal(
      await store
        .getByRole("button", { name: COPY.buy + " 1000 Sterling" })
        .isEnabled(),
      true,
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `no horizontal page overflow at ${width}`,
    );
    // The store's type belongs to the site: the same stack the rest of site/ renders in, and a
    // heading order where the page title is the largest thing on it.
    const type = await page.evaluate(() => {
      const sizes = [
        ...document.querySelectorAll(".store-main h1,.store-main h2"),
      ].map((n) => ({ tag: n.tagName, size: parseFloat(getComputedStyle(n).fontSize) }));
      return {
        siteFamily: getComputedStyle(document.body).fontFamily,
        storeFamily: getComputedStyle(document.querySelector(".store-app")).fontFamily,
        sizes,
      };
    });
    assert.match(type.siteFamily, /^Inter/, "the site itself renders in Inter");
    assert.equal(
      type.storeFamily,
      type.siteFamily,
      "store text uses the site's own stack, not a system-ui shorthand",
    );
    const largest = (tag) =>
      Math.max(0, ...type.sizes.filter((s) => s.tag === tag).map((s) => s.size));
    assert.ok(
      largest("H1") >= 34,
      `the page title is at the site's page-heading scale (${largest("H1")}px)`,
    );
    assert.ok(
      largest("H1") >= largest("H2"),
      `heading sizes are ordered h1 ${largest("H1")} >= h2 ${largest("H2")}`,
    );
    assert.deepEqual(errors, [], `no page error at ${width}`);
    assert.deepEqual(external, [], "nothing is fetched off-origin");
    if (output)
      await page.screenshot({ path: `${output}/store-catalogue-${width}.png` });
    console.log("Store catalogue passed:", width, height);
  }
  // BUYING. One press on one card: the key the page sent, the sentence while the browser is
  // being handed the page, and the sentence after it. Nothing here says a payment happened.
  {
    const { page, errors } = await storePage({
      config: { products: PRODUCTS, orders: [], holdCheckout: true },
    });
    const store = page.locator(".store-app");
    await store.locator(".store-product").first().waitFor();
    await store.getByRole("button", { name: COPY.buy + " 1000 Sterling" }).click();
    await store.locator(".store-status").waitFor();
    assert.equal((await store.locator(".store-status").innerText()).trim(), COPY.opening);
    assert.deepEqual(
      await page.evaluate(() => window.__store.checkouts),
      ["sterling-1000"],
      "the page asked for the product the player pressed, and nothing else",
    );
    await page.evaluate(() => window.__store.release());
    await store.locator(".store-status").first().waitFor();
    await page.waitForFunction(
      (copy) =>
        [...document.querySelectorAll(".store-status")].some(
          (n) => n.textContent.trim() === copy,
        ),
      COPY.finish,
    );
    const afterBuy = (await store.innerText()).replace(/\s+/g, " ");
    assert.match(afterBuy, /Finish the payment in your browser/);
    assert.doesNotMatch(afterBuy, /received|complete|thank/i);
    assert.equal(
      await store.getByRole("button", { name: COPY.buy + " 1000 Sterling" }).count(),
      1,
      "the card goes back to offering the one control it has",
    );
    assert.deepEqual(errors, []);
    console.log("Buy passed: the key sent, the opening sentence and the sentence after it");
  }
  // A press that is refused says the one sentence and opens nothing.
  {
    const { page } = await storePage({
      config: {
        products: PRODUCTS,
        orders: [],
        checkoutError: COPY.unavailable,
      },
    });
    const store = page.locator(".store-app");
    await store.locator(".store-product").first().waitFor();
    await store.getByRole("button", { name: COPY.buy + " 10 Sterling" }).click();
    await store.locator(".store-feedback span").waitFor();
    assert.equal(
      (await store.locator(".store-feedback span").innerText()).trim(),
      COPY.unavailable,
    );
    assert.equal(await store.locator(".store-status").count(), 0, "nothing claims a browser opened");
    console.log("A refused press says the store is unavailable and opens nothing");
  }
  // ORDERS, as the server reports them: empty, pending, paid, delivered. A pending order is
  // never worded as paid, and a paid one is never worded as delivered.
  {
    const coldOrders = async (orders, check) => {
      const { page, errors } = await storePage({
        config: { products: PRODUCTS, orders },
        hash: "#orders",
      });
      await page.getByRole("heading", { name: COPY.orders }).waitFor();
      await check(page);
      assert.deepEqual(errors, [], "no page error on #orders");
      await page.close();
    };
    await coldOrders([], async (page) => {
      const store = page.locator(".store-app");
      await store.getByText(COPY.noOrders).waitFor();
      assert.equal(await store.locator(".store-order-record").count(), 0);
    });
    await coldOrders([ORDER], async (page) => {
      const store = page.locator(".store-app");
      await store.locator(".store-order-record").waitFor();
      // The catalogue is read for the name the order carries only a key for.
      await page.waitForFunction(
        (name) =>
          (document.querySelector(".store-order-record h3") || {}).textContent === name,
        "100 Sterling",
      );
      const record = (await store.locator(".store-order-record").innerText()).replace(
        /\s+/g,
        " ",
      );
      assert.match(record, /\$6\.95/);
      assert.doesNotMatch(record, new RegExp(COPY.paid));
      assert.doesNotMatch(record, new RegExp(COPY.delivered));
      assert.equal(await store.locator(".store-order-state").count(), 0);
    });
    await coldOrders([{ ...ORDER, paid: true }], async (page) => {
      const store = page.locator(".store-app");
      await store.locator(".store-order-state").first().waitFor();
      assert.deepEqual(
        await store.locator(".store-order-state").allInnerTexts(),
        [COPY.paid],
      );
    });
    await coldOrders([{ ...ORDER, paid: true, delivered: true }], async (page) => {
      const store = page.locator(".store-app");
      await store.locator(".store-order-state").first().waitFor();
      assert.deepEqual(
        await store.locator(".store-order-state").allInnerTexts(),
        [COPY.paid, COPY.delivered],
      );
    });
    console.log("Orders passed: empty, pending, paid and delivered, in the server's own words");
  }
  // A FAILED READ IS NEVER AN EMPTY SHOP OR AN EMPTY HISTORY.
  {
    const { page } = await storePage({
      config: { products: PRODUCTS, orders: [], catalogueError: COPY.unavailable },
    });
    const store = page.locator(".store-app");
    await store.locator(".store-feedback span").waitFor();
    assert.equal(
      (await store.locator(".store-feedback span").innerText()).trim(),
      COPY.unavailable,
    );
    assert.equal(await store.locator(".store-product").count(), 0);
    assert.equal(await store.getByRole("button", { name: /^Buy / }).count(), 0);
    console.log("An unavailable store says so and offers nothing to buy");
  }
  {
    const { page } = await storePage({
      config: { products: PRODUCTS, orders: [], ordersError: COPY.unavailable },
      hash: "#orders",
    });
    const store = page.locator(".store-app");
    await store.locator(".store-feedback span").waitFor();
    assert.equal(
      (await store.locator(".store-feedback span").innerText()).trim(),
      COPY.unavailable,
    );
    assert.doesNotMatch(
      (await store.innerText()).replace(/\s+/g, " "),
      /No orders yet/,
      "a failed orders read is not reported as a player with no orders",
    );
    console.log("A failed orders read is a refusal, never an empty history");
  }
  // SIGNED OUT, and a refusal this page does not know how to word.
  {
    const { page } = await storePage({
      config: { products: PRODUCTS, orders: [], catalogueError: COPY.signedOut },
    });
    const store = page.locator(".store-app");
    await store.locator(".store-feedback span").waitFor();
    assert.equal(
      (await store.locator(".store-feedback span").innerText()).trim(),
      COPY.signedOut,
    );
    assert.equal(await store.getByRole("button", { name: /^Buy / }).count(), 0);
    console.log("Signed out: Sign in to buy., and no buying control");
  }
  {
    // The startup gate's own refusal must not become store copy: the page reports the one
    // sentence it is allowed to report.
    const { page } = await storePage({
      config: {
        products: PRODUCTS,
        orders: [],
        catalogueError: "Updates must finish before this launcher can be used.",
      },
    });
    const store = page.locator(".store-app");
    await store.locator(".store-feedback span").waitFor();
    assert.equal(
      (await store.locator(".store-feedback span").innerText()).trim(),
      COPY.unavailable,
      "the page prints only the sentences it was given, never a message from elsewhere",
    );
    console.log("A refusal outside the frozen copy is reported as the store being unavailable");
  }
  // THE ROUTES. #catalogue, #item/<key> and #orders stay; a removed route lands on #catalogue in
  // place, so the address bar never names a view that is not on screen.
  {
    const coldLoad = async (hash, check) => {
      const { page, errors } = await storePage({ hash });
      await check(page);
      assert.deepEqual(errors, [], "no page error on " + hash);
      await page.close();
    };
    await coldLoad("#item/sterling-100", async (page) => {
      const store = page.locator(".store-app");
      await page.getByRole("heading", { name: "100 Sterling", level: 2 }).waitFor();
      assert.match(await store.locator(".store-detail-price").innerText(), /\$6\.95/);
      assert.match(await store.locator(".store-worth").innerText(), /100 Sterling in your bank/);
      assert.equal(await store.getByRole("button", { name: /^Buy / }).count(), 1);
    });
    await coldLoad("#item/not-a-product", async (page) => {
      await page.locator(".store-product").first().waitFor();
      assert.equal(new URL(page.url()).hash, "#catalogue");
    });
    for (const removed of ["#cart", "#checkout", "#receipt/cs_test_1", "#cart/", "#nonsense"]) {
      await coldLoad(removed, async (page) => {
        await page.locator(".store-product").first().waitFor();
        assert.equal(
          new URL(page.url()).hash,
          "#catalogue",
          `${removed} lands on the catalogue rather than a dead view`,
        );
        assert.equal(await page.getByRole("heading", { name: COPY.orders }).count(), 0);
      });
    }
    console.log("Routes passed: #item/<key> keeps its address and a removed route lands on #catalogue");
  }
  // A BUILD WITH NO STORE BRIDGE offers no buying control rather than one that does nothing.
  {
    const { page } = await openPage({
      init: installBridgeWithoutStore,
      url: origin + "/store/",
    });
    const store = page.locator(".store-app");
    await store.locator(".store-feedback span").waitFor();
    assert.equal(
      (await store.locator(".store-feedback span").innerText()).trim(),
      COPY.unavailable,
    );
    assert.equal(await store.locator(".store-product").count(), 0);
    assert.equal(await store.getByRole("button").count(), 0, "no control at all");
    assert.equal(await store.locator("input").count(), 0);
    console.log("A preload without the store commands offers no buying control");
  }
  // THE STORE IS A LAUNCHER SURFACE, NOT A WEBSITE DESTINATION (desktop.css, and the previous
  // commit's rule). Asserted with no JavaScript first: that is the case with nothing to hide it.
  {
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
      assert.equal(await staticEntry.isVisible(), false);
      await noScript.goto(origin + "/store/", { waitUntil: "load" });
      assert.equal(await noScript.locator(".store-main").isVisible(), false);
      assert.equal(await noScript.locator(".store-product").count(), 0);
    } finally {
      await noScript.close();
    }
    const plain = await openPage({ url: origin + "/" });
    assert.equal(
      await plain.page.evaluate(() => typeof window.easterDesktop),
      "undefined",
      "a plain browser page has no desktop bridge",
    );
    assert.equal(
      await plain.page.locator('.site-header nav a[href*="store/"]:visible').count(),
      0,
      "the home nav shows no Store entry in a browser",
    );
    await plain.page.goto(origin + "/store/", { waitUntil: "networkidle" });
    await plain.page.waitForURL(origin + "/");
    assert.equal(await plain.page.locator(".store-main").count(), 0);
    assert.deepEqual(plain.errors, [], "no page error redirecting a browser home");
    console.log("Launcher-only passed: hidden without the bridge, and a browser is sent home");
  }
  // The launcher's nav entry is a link to the page, not a modal behind a button.
  {
    const { page, errors } = await openPage({
      init: installBridge,
      arg: { products: PRODUCTS, orders: [] },
      url: origin,
    });
    await page.locator(".site-header nav a.store-entry").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Store", exact: true }).count(),
      0,
      "no Store button that opens a dialog",
    );
    await page.locator(".site-header nav a.store-entry").click();
    await page.waitForURL(origin + "/store/");
    await page.locator(".store-product").first().waitFor();
    assert.equal(await page.locator('.site-header nav a[href*="store/"]').count(), 1);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.deepEqual(errors, []);
    console.log("Launcher nav entry navigates to the store page");
  }
} finally {
  for (const { page } of opened) if (!page.isClosed()) await page.close();
  await browser.close();
}
