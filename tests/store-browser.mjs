/*
 * The Community store is a page at /store/ and the real one: four products the server sells,
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
import { readFile } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.EASTER_PUBLIC_ORIGIN || "http://127.0.0.1:18100",
  output = process.env.EASTER_REVIEW_OUTPUT;
// The four live products, in the server's order, exactly as the cloud half sends them. The
// $0.01 penny was dropped on 2026-10-23: Stripe's minimum charge for USD is $0.50 and it refuses
// the Checkout Session with amount_too_small, so a one-cent product can never be sold.
const PRODUCTS = [
  { key: "sterling-10", name: "10 Sterling", amountMinor: 149, currency: "USD", kind: "sterling", creditPence: 1000 },
  { key: "sterling-100", name: "100 Sterling", amountMinor: 695, currency: "USD", kind: "sterling", creditPence: 10000 },
  { key: "sterling-1000", name: "1000 Sterling", amountMinor: 2999, currency: "USD", kind: "sterling", creditPence: 100000 },
  { key: "donation-5", name: "Keep the lights on", amountMinor: 500, currency: "USD", kind: "donation", creditPence: 0 },
];
// Owen's sentences, character for character. This suite is their second reader: if the page is
// ever reworded, this stops rather than blessing the new wording.
const COPY = {
  buy: "Buy",
  opening: "Pending\u2026",
  deposit:
    "All in-game currency is deposited into your in-game bank account upon purchase, and can only be withdrawn in-game.",
  finish:
    "Finish the payment in the Stripe window. Your Sterling arrives the next time you join.",
  successful: "Payment Successful",
  orderRecorded: "Your order is recorded.",
  close: "Close",
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
  const store = {
    catalogue: 0,
    orders: 0,
    snapshots: 0,
    // How many of the two reads the page has actually been ANSWERED by. A paint drawn from the
    // startup snapshot is on screen while this is still zero, which is the whole difference the
    // snapshot makes.
    answered: 0,
    checkouts: [],
    // The rows the stub's service holds. A scenario can add one from the test side: the page only
    // ever shows what this list answers with.
    orders_: (cfg.orders || []).slice(),
    release: null,
    releaseCatalogue: null,
    releaseOrders: null,
    releaseSnapshot: null,
  };
  window.__store = store;
  window.easterDesktop = {
    mode: "desktop",
    // The launcher's startup snapshot (desktop/main.cjs, `prefetchStore`): `{writtenAt, products,
    // orders}` or null. `holdSnapshot` keeps the answer itself open, so a scenario can prove what
    // the page does while the launcher is still handing it over.
    storeSnapshot: async () => {
      store.snapshots += 1;
      if (!cfg.snapshot) return null;
      if (!cfg.holdSnapshot) return cfg.snapshot;
      return new Promise((resolve) => {
        store.releaseSnapshot = () => resolve(cfg.snapshot);
      });
    },
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
      if (!cfg.holdCatalogue) {
        store.answered += 1;
        return { products: cfg.products };
      }
      // A held read is how the busy ring is measured at all: it is drawn only while the page is
      // still asking, and this store prints no words while it waits.
      return new Promise((resolve) => {
        store.releaseCatalogue = () => {
          store.answered += 1;
          resolve({ products: cfg.products });
        };
      });
    },
    storeOrders: async () => {
      store.orders += 1;
      if (cfg.ordersError) throw new Error(cfg.ordersError);
      if (!cfg.holdOrders) {
        store.answered += 1;
        return { orders: store.orders_ };
      }
      return new Promise((resolve) => {
        store.releaseOrders = () => {
          store.answered += 1;
          resolve({ orders: store.orders_ });
        };
      });
    },
    storeCheckout: async (key) => {
      store.checkouts.push(key);
      if (cfg.checkoutError) throw new Error(cfg.checkoutError);
      const answer = {
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
        sessionId: "cs_test_1",
        product: key,
        // What main saw happen in its own payment window (doc/launcher-store.md, "Paying").
        // `closed` is the default because it is the only outcome that claims nothing.
        outcome: cfg.checkoutOutcome || "closed",
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
    assert.equal(await store.locator(".store-product").count(), 4, "four products, and only four");
    assert.deepEqual(
      await store.locator(".store-product-name").allInnerTexts(),
      PRODUCTS.map((p) => p.name),
      "the catalogue is drawn in the server's order",
    );
    assert.deepEqual(
      await store.locator(".store-price").allInnerTexts(),
      ["$1.49", "$6.95", "$29.99", "$5.00"],
      "every price is the server's USD amount",
    );
    assert.deepEqual(
      await store.locator(".store-worth").allInnerTexts(),
      [
        "10 Sterling in your bank",
        "100 Sterling in your bank",
        "1,000 Sterling in your bank",
        COPY.donation,
      ],
      "a pack says what it is worth from creditPence, and a donation says it is a donation",
    );
    assert.deepEqual(
      await store.locator(".store-deposit").allInnerTexts(),
      [COPY.deposit, COPY.deposit, COPY.deposit],
      "every currency card also carries where the money goes and whether it can be spent",
    );
    assert.deepEqual(
      await store.locator(".store-product > .store-art").evaluateAll((nodes) => nodes.map((n) => n.dataset.emblem)),
      ["coins", "pouch", "chest", "donation"],
      "currency artwork grows from coins to pouch to chest, while donations keep their own emblem",
    );
    assert.equal(await store.locator(".store-bank-note").count(), 0, "deposit instructions belong on each currency item, never above the cards");
    assert.equal(await store.getByRole("button", { name: /^Buy / }).count(), 4);
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
    // SOL'S DESIGN, MEASURED. One row per product in one column — not the three-across card grid
    // that needed 1280px to hold five cards — with a circular coin medallion beside the name and
    // Sol's gold, 44px-tall control on the right. Every part of a row stays inside its row.
    const row = await store.locator(".store-product").first().evaluate((card) => {
      const box = card.getBoundingClientRect(),
        art = card.querySelector(".store-art"),
        artBox = art.getBoundingClientRect(),
        buy = card.querySelector(".store-button"),
        outside = [...card.querySelectorAll("*")]
          .filter((node) => {
            const b = node.getBoundingClientRect();
            return (
              b.width > 0 &&
              (b.left < box.left - 0.5 ||
                b.right > box.right + 0.5 ||
                b.top < box.top - 0.5 ||
                b.bottom > box.bottom + 0.5)
            );
          })
          .map((node) => node.className || node.tagName);
      return {
        cardWidth: Math.round(box.width),
        gridColumns: getComputedStyle(card).gridTemplateColumns.split(" ").length,
        art: {
          width: Math.round(artBox.width),
          radius: getComputedStyle(art).borderTopLeftRadius,
          hidden: art.getAttribute("aria-hidden"),
        },
        buy: {
          height: Math.round(buy.getBoundingClientRect().height),
          background: getComputedStyle(buy).backgroundColor,
        },
        outside,
      };
    });
    const listWidth = Math.round((await store.locator(".store-grid").boundingBox()).width);
    assert.equal(
      row.gridColumns,
      width <= 600 ? 2 : 3,
      `a row is medallion and copy above 600px, medallion and a stacked copy below it (${width}px: ${row.gridColumns} columns)`,
    );
    assert.equal(
      row.cardWidth,
      listWidth,
      "the catalogue is one column: every row is as wide as the list",
    );
    assert.equal(
      row.art.width,
      width <= 600 ? 64 : 94,
      `the coin medallion takes Sol's size (${width}px: ${row.art.width}px)`,
    );
    assert.equal(row.art.radius, "50%", "the medallion is a coin: a circle");
    assert.equal(
      row.art.hidden,
      "true",
      "the medallion is decoration and says nothing to a screen reader",
    );
    assert.ok(
      row.buy.height >= 44,
      `the Buying control is at least 44px tall (${width}px: ${row.buy.height}px)`,
    );
    assert.equal(
      row.buy.background,
      "rgb(228, 196, 134)",
      "the Buying control is Sol's gold tab, not a dark panel button",
    );
    assert.deepEqual(row.outside, [], `every part of a row stays inside its row (${width}px)`);
    assert.deepEqual(errors, [], `no page error at ${width}`);
    assert.deepEqual(external, [], "nothing is fetched off-origin");
    if (output)
      await page.screenshot({ path: `${output}/store-catalogue-${width}.png` });
    console.log("Store catalogue passed:", width, height);
  }
  // BUYING. One press on one card: the key the page sent, the sentence while the launcher's
  // Stripe window is opening, and the sentence after a window the player closed by hand. Nothing
  // here says a payment happened.
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
    assert.match(
      afterBuy,
      /Finish the payment in the Stripe window\. Your Sterling arrives the next time you join\./,
    );
    assert.doesNotMatch(afterBuy, /browser/);
    assert.doesNotMatch(afterBuy, /received|complete|thank/i);
    assert.equal(await store.locator(".store-modal").count(), 0, "a closed window says nothing more");
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
  // THE PAYMENT DIALOG. `outcome: "paid"` is the one answer from main that may claim a payment,
  // and it claims it in the launcher's own words: Owen's heading, Owen's body sentence, and one
  // control. What it does NOT do is invent an order - the row is the service's, so the stub's own
  // list is what appears, and only after the dialog's read.
  {
    const { page, errors } = await storePage({
      config: { products: PRODUCTS, orders: [], checkoutOutcome: "paid" },
    });
    const store = page.locator(".store-app");
    await store.locator(".store-product").first().waitFor();
    await store.getByRole("button", { name: COPY.buy + " 10 Sterling" }).click();
    const modal = store.locator(".store-modal");
    await modal.waitFor();
    assert.equal(await modal.getAttribute("role"), "dialog");
    assert.equal(await modal.getAttribute("aria-modal"), "true");
    const labelledBy = await modal.getAttribute("aria-labelledby");
    assert.equal(
      await page.evaluate((id) => document.getElementById(id)?.textContent, labelledBy),
      COPY.successful,
      "the dialog is labelled by its own heading",
    );
    assert.equal(
      await store.getByRole("heading", { name: COPY.successful, exact: true }).count(),
      1,
    );
    assert.equal(
      (await modal.innerText()).replace(/\s+/g, " ").trim(),
      COPY.successful + " " + COPY.orderRecorded + " " + COPY.close,
      "one heading, one sentence and one control: no second sentence and no exclamation mark",
    );
    assert.doesNotMatch(await modal.innerText(), /!/);
    assert.equal(
      await page.evaluate(
        () => document.activeElement === document.querySelector(".store-modal-close"),
      ),
      true,
      "focus moves into the dialog when it opens",
    );
    assert.equal(
      await store.locator(".store-order-record").count(),
      0,
      "the dialog writes no order row by itself",
    );
    // The account service records the purchase; the dialog's own read is what shows it.
    await page.evaluate(
      (row) => window.__store.orders_.push(row),
      { ...ORDER, product: "sterling-10", amountMinor: 149, paid: true },
    );
    const reads = await page.evaluate(() => window.__store.orders);
    await modal.getByRole("button", { name: COPY.close, exact: true }).click();
    await modal.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() => window.__store.orders),
      reads + 1,
      "Close re-reads the orders once",
    );
    assert.equal(await store.locator(".store-modal").count(), 0, "and dismisses the dialog");
    // Close lands on the orders rather than back on the Buy control: the ticket's two clauses
    // could not both hold, and the row the server recorded is the point of the whole press.
    assert.equal(
      new URL(page.url()).hash,
      "#orders",
      "Close lands on the orders, where the row just recorded is on screen",
    );
    await store.locator(".store-order-record").waitFor();
    const row = (await store.locator(".store-order-record").innerText()).replace(/\s+/g, " ");
    assert.match(row, /10 Sterling/);
    assert.match(row, /Paid/);
    assert.deepEqual(errors, []);
    console.log(
      "Payment Successful passed: Owen's dialog, one control, and a row that only the service can write",
    );
  }
  // Escape and Enter close it too, and neither leaves the dialog behind. The dialog is measured
  // rather than assumed at the smallest window the suite drives: it fits, with no sideways scroll.
  {
    const closers = [
      ["Escape", (page) => page.keyboard.press("Escape")],
      ["Enter", (page) => page.keyboard.press("Enter")],
    ];
    for (const [name, close] of closers) {
      const { page } = await storePage({
        width: 320,
        height: 568,
        config: { products: PRODUCTS, orders: [], checkoutOutcome: "paid" },
      });
      const store = page.locator(".store-app");
      await store.locator(".store-product").first().waitFor();
      await store.getByRole("button", { name: COPY.buy + " 10 Sterling" }).click();
      await store.locator(".store-modal").waitFor();
      const box = await store.locator(".store-modal-panel").boundingBox();
      assert.ok(
        box.x >= 0 && box.y >= 0 && box.x + box.width <= 320 && box.y + box.height <= 568,
        `the dialog fits the 320px window (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)})`,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        0,
        "and it never makes the page scroll sideways",
      );
      await close(page);
      await store.locator(".store-modal").waitFor({ state: "detached" });
      assert.equal(
        new URL(page.url()).hash,
        "#orders",
        name + " closes the dialog and lands on the orders like Close does",
      );
      assert.equal(await store.locator(".store-modal").count(), 0);
      await page.close();
    }
    console.log("Keyboard passed: Escape and Enter close the payment dialog, and it fits 320px");
  }
  // A CANCELLED payment says nothing at all: no dialog, no sentence, and the store exactly as it
  // was before the press.
  {
    const { page, errors } = await storePage({
      config: { products: PRODUCTS, orders: [], checkoutOutcome: "cancelled" },
    });
    const store = page.locator(".store-app");
    await store.locator(".store-product").first().waitFor();
    const before = (await store.innerText()).replace(/\s+/g, " ").trim();
    await store.getByRole("button", { name: COPY.buy + " 10 Sterling" }).click();
    await page.waitForFunction(() => window.__store.checkouts.length === 1);
    await store.getByRole("button", { name: COPY.buy + " 10 Sterling" }).waitFor();
    assert.equal(await store.locator(".store-modal").count(), 0, "no dialog");
    assert.equal(await store.locator(".store-status").count(), 0, "and no sentence");
    assert.equal(
      (await store.innerText()).replace(/\s+/g, " ").trim(),
      before,
      "the store is exactly as it was before the press",
    );
    assert.equal(await page.evaluate(() => window.__store.orders), 0, "and nothing is re-read");
    assert.deepEqual(errors, []);
    console.log("Cancelled passed: no dialog, no sentence, the store exactly as it was");
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
      assert.equal(await store.locator(".store-worth").innerText(), "100 Sterling in your bank");
      assert.equal(await store.locator(".store-deposit").innerText(), COPY.deposit);
      assert.equal(await store.getByRole("button", { name: /^Buy / }).count(), 1);
    });
    for (const [key, emblem] of [["sterling-10", "coins"], ["sterling-100", "pouch"], ["sterling-1000", "chest"], ["donation-5", "donation"]]) {
      await coldLoad("#item/" + key, async (page) => {
        await page.locator(".store-detail-art").waitFor();
        assert.equal(await page.locator(".store-detail-art").getAttribute("data-emblem"), emblem,
          "detail keeps the catalogue emblem for " + key);
        // Both lines, keyed on what the server said the product credits: a currency pack shows its
        // own amount and the deposit rule, and a donation shows neither.
        const credits = key !== "donation-5";
        assert.equal(
          await page.locator(".store-worth").innerText(),
          credits ? { "sterling-10": "10 Sterling in your bank", "sterling-100": "100 Sterling in your bank", "sterling-1000": "1,000 Sterling in your bank" }[key] : COPY.donation,
          "detail shows what the pack is worth for " + key,
        );
        assert.equal(
          await page.locator(".store-deposit").count(),
          credits ? 1 : 0,
          "and the deposit rule only where something is deposited, for " + key,
        );
        assert.equal(await page.locator(".store-bank-note").count(), 0,
          "and never as a standalone explanation beside the card");
      });
    }
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
      assert.equal(await staticEntry.isVisible(), true);
      await noScript.goto(origin + "/store/", { waitUntil: "load" });
      assert.equal(await noScript.locator(".store-main").isVisible(), true);
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
      1,
      "the home nav shows the shared Store entry in a browser",
    );
    await plain.page.goto(origin + "/store/", { waitUntil: "networkidle" });
    await plain.page.getByText("Sign in to buy.", {exact:true}).waitFor();
    assert.equal(await plain.page.locator(".store-main").count(), 1);
    assert.deepEqual(plain.errors, [], "no page error redirecting a browser home");
    console.log("Shared store passed: browser catalogue asks for sign-in without a native bridge");
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
  // SOL'S SKIP LINK AND THE KEYBOARD. The link is the page's first Tab stop, it is off screen
  // until it is focused, and pressing it puts the reader inside the store without turning itself
  // into a route. Then every visible control on the page is reached by Tab, in document order.
  {
    const { page, errors } = await storePage({ width: 1440, height: 1000 });
    await page.locator(".store-product").first().waitFor();
    const asleep = await page.locator(".store-skip").boundingBox();
    assert.ok(
      asleep.width <= 1 && asleep.height <= 1,
      "the skip link is off screen until it is focused",
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement.className),
      "store-skip",
      "the first Tab stop on the page is the skip link",
    );
    const awake = await page.locator(".store-skip").boundingBox();
    assert.ok(
      awake.height >= 44 && awake.y >= 0 && awake.y < 60,
      `the focused skip link is on screen (${Math.round(awake.y)}px from the top, ${Math.round(awake.height)}px tall)`,
    );
    await page.keyboard.press("Enter");
    const landed = await page.evaluate(() => ({
      cls: document.activeElement.className,
      inStore: Boolean(document.activeElement.closest(".store-app")),
      hash: location.hash,
      top: Math.round(document.activeElement.getBoundingClientRect().top),
    }));
    assert.equal(landed.inStore, true, "the skip link reaches the store");
    assert.equal(landed.hash, "#catalogue", "and it does not become a route of its own");
    assert.ok(
      landed.top >= 0 && landed.top < 1000,
      `the store's content region is on screen after the jump (top ${landed.top}px)`,
    );
    assert.deepEqual(errors, []);
    const second = await storePage({ width: 1440, height: 1000 });
    await second.page.locator(".store-product").first().waitFor();
    const controls = await second.page.evaluate(() =>
      [...document.querySelectorAll("a[href], button, [tabindex]")]
        .filter(
          (n) =>
            n.checkVisibility && n.checkVisibility() && n.tabIndex >= 0 && !n.disabled,
        )
        .map((n) => (n.className || n.tagName) + "|" + (n.textContent || "").trim().slice(0, 24)),
    );
    // From a fresh load, one Tab per visible control in the document: every one of them is visited,
    // in order, before focus leaves the page.
    const walked = [];
    for (let step = 0; step < controls.length; step += 1) {
      await second.page.keyboard.press("Tab");
      walked.push(
        await second.page.evaluate(() => {
          const n = document.activeElement;
          return (n.className || n.tagName) + "|" + (n.textContent || "").trim().slice(0, 24);
        }),
      );
    }
    assert.deepEqual(
      walked,
      controls,
      "every visible control on the store page is reached by Tab, in document order",
    );
    assert.ok(
      walked.includes("store-nav|Browse") && walked.includes("store-nav|Orders"),
      "the store's own two views are keyboard reachable",
    );
    assert.equal(
      walked.filter((c) => c.startsWith("store-product-open")).length,
      4,
      "every product name, the link to its own view, is reachable",
    );
    assert.equal(
      walked.filter((c) => c.startsWith("store-button")).length,
      4,
      "every Buy control is reachable",
    );
    assert.ok(walked.includes("store-skip|Skip to store"), "and the skip link is walked too");
    console.log(
      `Skip link and keyboard passed: ${walked.length} Tab stops, ${controls.length} visible controls, none missed`,
    );
  }
  /*
   * THE SNAPSHOT: THE STORE, ALREADY IN HAND (ticket 9f6d7b16; doc/launcher-store.md, "Opening the
   * store instantly").
   *
   * The launcher asks the account service for the catalogue and the player's orders once, at
   * startup, and hands them to this page before it asks anything (desktop/main.cjs `prefetchStore`,
   * the bridge's `storeSnapshot()`). The page therefore paints the shop at once and confirms it
   * with the same two reads it always made. What is proved here is the page's own half:
   *
   *   - a warm snapshot paints with both reads still held open on promises (never a stopwatch):
   *     four cards, the snapshot's own prices, no busy ring, and no service answer used at all;
   *   - while it is being confirmed the content region keeps `aria-busy="true"` — this page's
   *     existing pending signal, because it has no sentence of its own to print — and the cards
   *     stay on screen instead of being replaced by the ring;
   *   - a confirmation that agrees with what is drawn redraws nothing (the same nodes, so the
   *     player's reading and focus are undisturbed) and only stops claiming it is being confirmed;
   *   - a confirmation that differs is painted at once, because prices and products are the
   *     server's and never this page's;
   *   - a bridge with no snapshot, or one that answers null, waits exactly as this page did before
   *     the snapshot existed: the ring, then the answer;
   *   - cached orders paint the orders view at once, and a snapshot with no orders leaves the
   *     orders view waiting rather than claiming "No orders yet." from a file.
   */
  {
    // The catalogue the service "last sent" at startup, priced differently from the live answers
    // below so every assertion can tell the snapshot's rows from the service's.
    const LAST_SENT = PRODUCTS.map((p, i) =>
      i === 0 ? { ...p, amountMinor: 199 } : { ...p },
    );
    const snapshotAt = new Date().toISOString();
    const held = (snapshot) => ({
      products: PRODUCTS,
      orders: [],
      holdCatalogue: true,
      holdOrders: true,
      snapshot,
    });
    const prices = (page) => page.locator(".store-price").allInnerTexts();
    // Every read the page may have in flight is released at once: the catalogue view never asks
    // for the orders and the orders view never asks a product's price, so whichever read a
    // scenario started is the one there is to release.
    const release = (page) =>
      page.evaluate(() => {
        window.__store.releaseCatalogue?.();
        window.__store.releaseOrders?.();
        window.__store.releaseSnapshot?.();
      });
    // The same answer the snapshot holds: a confirmation, not a correction.
    {
      // The live answer agrees with the snapshot, so nothing may be redrawn.
      const { page, errors } = await storePage({
        config: {
          ...held({ writtenAt: snapshotAt, products: LAST_SENT, orders: [] }),
          products: LAST_SENT,
        },
      });
      const store = page.locator(".store-app");
      await store.locator(".store-product").first().waitFor();
      assert.deepEqual(
        await prices(page),
        ["$1.99", "$6.95", "$29.99", "$5.00"],
        "the first paint is the catalogue the service last sent, before it has answered again",
      );
      assert.equal(
        await page.evaluate(() => window.__store.answered),
        0,
        "and it is on screen with neither read answered: the launcher's snapshot is what painted it",
      );
      assert.equal(
        await store.locator(".store-busy").count(),
        0,
        "no busy ring over rows the player is already reading",
      );
      assert.equal(
        await store.locator(".store-content").getAttribute("aria-busy"),
        "true",
        "the content region says it is still being confirmed, in the page's own pending signal",
      );
      assert.equal(await store.locator(".store-product").count(), 4, "four cards, and only four");
      await page.evaluate(() => {
        window.__painted = document.querySelector(".store-product");
      });
      // Now the service answers, and it agrees.
      await release(page);
      await page.waitForFunction(
        () => document.querySelector(".store-content").getAttribute("aria-busy") === "false",
      );
      assert.equal(
        await page.evaluate(
          () => document.querySelector(".store-product") === window.__painted,
        ),
        true,
        "a confirmation that agrees redraws nothing: the cards on screen are the same nodes",
      );
      assert.deepEqual(
        await prices(page),
        ["$1.99", "$6.95", "$29.99", "$5.00"],
        "and the prices are still the ones the server sent",
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
    // A different answer: a new price is painted at once, and the pending flag stops.
    {
      const { page, errors } = await storePage({
        config: held({ writtenAt: snapshotAt, products: LAST_SENT, orders: [] }),
      });
      const store = page.locator(".store-app");
      await store.locator(".store-product").first().waitFor();
      assert.deepEqual(await prices(page), ["$1.99", "$6.95", "$29.99", "$5.00"]);
      assert.equal(await page.evaluate(() => window.__store.answered), 0);
      await page.evaluate(() => {
        window.__painted = document.querySelector(".store-product");
      });
      // The service now disagrees: the first pack costs $1.49, not $1.99.
      await release(page);
      await page.waitForFunction(
        () => document.querySelector(".store-price")?.textContent === "$1.49",
      );
      assert.equal(
        await page.evaluate(
          () => document.querySelector(".store-product") === window.__painted,
        ),
        false,
        "a different answer is painted, not kept: the rows are new nodes",
      );
      assert.deepEqual(
        await prices(page),
        ["$1.49", "$6.95", "$29.99", "$5.00"],
        "and every price on screen is now the service's own",
      );
      assert.equal(
        await store.locator(".store-content").getAttribute("aria-busy"),
        "false",
        "nothing is being confirmed any more",
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
    // No snapshot at all: exactly today's wait, word for word.
    {
      const { page, errors } = await storePage({
        config: { products: PRODUCTS, orders: [], holdCatalogue: true },
      });
      const store = page.locator(".store-app");
      await store.locator(".store-busy").waitFor();
      assert.equal(
        await store.locator(".store-product").count(),
        0,
        "with no snapshot the page waits for the service, as it did before this existed",
      );
      assert.equal(
        await store.locator(".store-content").getAttribute("aria-busy"),
        "true",
        "and says it is waiting in the same way",
      );
      await page.evaluate(() => window.__store.releaseCatalogue());
      await store.locator(".store-product").first().waitFor();
      assert.deepEqual(await prices(page), ["$1.49", "$6.95", "$29.99", "$5.00"]);
      assert.equal(
        await store.locator(".store-busy").count(),
        0,
        "and the ring goes when the answer arrives",
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
    // The orders view from the snapshot: cached rows paint at once, and no cached orders at all
    // leaves the view waiting rather than claiming "No orders yet.".
    {
      const { page, errors } = await storePage({
        hash: "#orders",
        config: {
          products: PRODUCTS,
          orders: [ORDER],
          holdCatalogue: true,
          holdOrders: true,
          snapshot: { writtenAt: snapshotAt, products: LAST_SENT, orders: [ORDER] },
        },
      });
      const store = page.locator(".store-app");
      await store.locator(".store-order-record").waitFor();
      assert.equal(
        await page.evaluate(() => window.__store.answered),
        0,
        "the orders view paints from the snapshot before either read answers",
      );
      assert.match(
        (await store.locator(".store-order-record").innerText()).replace(/\s+/g, " "),
        /\$6\.95/,
        "with the row the service last sent",
      );
      assert.equal(
        await store.locator(".store-content").getAttribute("aria-busy"),
        "true",
        "while it is being confirmed",
      );
      await release(page);
      await page.waitForFunction(
        () => document.querySelector(".store-content").getAttribute("aria-busy") === "false",
      );
      assert.equal(await store.locator(".store-order-record").count(), 1);
      assert.deepEqual(errors, []);
      await page.close();
    }
    {
      // A snapshot with a catalogue and no orders: the signed-out player's snapshot, and the
      // answer for anyone whose orders the launcher has never fetched.
      const { page, errors } = await storePage({
        hash: "#orders",
        config: {
          products: PRODUCTS,
          orders: [],
          holdOrders: true,
          snapshot: { writtenAt: snapshotAt, products: LAST_SENT, orders: null },
        },
      });
      const store = page.locator(".store-app");
      await store.locator(".store-busy").waitFor();
      assert.equal(
        await store.locator(".store-empty").count(),
        0,
        "no cached orders is not the same answer as no orders: the view waits for the service",
      );
      await page.evaluate(() => window.__store.releaseOrders());
      await store.getByText(COPY.noOrders).waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      'Snapshot passed: a warm catalogue and orders paint with both reads unanswered (no ring, aria-busy="true"), an agreeing confirmation redraws nothing, a different one is painted at once, and a cold page still waits exactly as it did',
    );
  }
  // THE MOTION SETTING. A reader who asked for reduced motion gets a still ring; without that
  // setting the ring Sol never had still turns, so the busy state is not silently dead for
  // everyone.
  {
    const busyRing = async (reducedMotion) => {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        reducedMotion,
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(installBridge, {
        products: PRODUCTS,
        orders: [],
        holdCatalogue: true,
      });
      await page.goto(origin + "/store/", { waitUntil: "domcontentloaded" });
      await page.locator(".store-busy").waitFor();
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector(".store-busy"));
        return { name: style.animationName, duration: style.animationDuration };
      });
      await page.evaluate(() => window.__store.releaseCatalogue());
      await page.locator(".store-product").first().waitFor();
      const settled = await page.evaluate(() => ({
        transition: getComputedStyle(document.querySelector(".store-product"))
          .transitionDuration,
        overflow:
          document.documentElement.scrollWidth - window.innerWidth,
      }));
      await page.close();
      return { ring, settled, errors };
    };
    const quiet = await busyRing("reduce");
    assert.deepEqual(quiet.errors, []);
    assert.equal(
      quiet.ring.name,
      "none",
      "a reader who asked for reduced motion gets a still ring, not a spinning one",
    );
    assert.equal(quiet.settled.overflow, 0, "and the settled page still does not scroll sideways");
    const lively = await busyRing("no-preference");
    assert.deepEqual(lively.errors, []);
    assert.equal(lively.ring.name, "store-spin", "without that setting the ring still turns");
    assert.equal(lively.ring.duration, "0.9s");
    console.log("Reduced motion passed: the busy ring turns, and stops when the reader asks it to");
  }
  // THE TWO STANDING RULES A DESIGN PASS HAS ALREADY DROPPED ONCE (commit 5e5a2fc): the class that
  // keeps the Store link out of the public site, and the mount gate that keeps the store off it.
  // Both are asserted where they live, so a later visual pass over a stale base fails here.
  {
    const markup = await readFile(new URL("../site/store/index.html", import.meta.url), "utf8");
    assert.match(
      markup,
      /<a class="store-entry" href="\.\.\/store\/"/,
      'site/store/index.html keeps class="store-entry" on its Store link',
    );
    assert.match(
      markup,
      /<a class="store-skip" href="#store-root">Skip to store<\/a>/,
      "the skip link is in the static markup, so it exists before any script runs",
    );
    const source = await readFile(new URL("../site/store/store.mjs", import.meta.url), "utf8");
    assert.match(
      source,
      /globalThis\.easterDesktop \|\| webAccount/,
      "the mount selects the native or browser account transport",
    );
    assert.match(
      source,
      /mountStore\(mount, \{bridge\}\)/,
      "and mounts the shared store with that transport",
    );
    const noScript = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      javaScriptEnabled: false,
    });
    try {
      await noScript.goto(origin + "/store/", { waitUntil: "load" });
      assert.equal(
        await noScript.locator('.site-header nav a.store-entry[href="../store/"]').count(),
        1,
        "the store page's own nav carries the class that hides it outside the launcher",
      );
      assert.equal(await noScript.locator(".store-main").isVisible(), true);
      const skip = await noScript.locator(".store-skip").boundingBox();
      assert.ok(
        skip.width <= 1 && skip.height <= 1,
        "and the skip link stays off screen on a page with no scripting",
      );
    } finally {
      await noScript.close();
    }
    console.log(
      'Standing rules passed: class="store-entry" on the Store link, and the mount gate in store.mjs',
    );
  }
} finally {
  for (const { page } of opened) if (!page.isClosed()) await page.close();
  await browser.close();
}
