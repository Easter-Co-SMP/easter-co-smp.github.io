/*
 * The Community store's main-process half: the wire shape of its three routes, the two refusal
 * sentences, and the fact that nothing else can be said. No network, no Electron: the account
 * client is handed a fake request, so what is proved is what this launcher sends and what it
 * will accept, not what the cloud service answers today (the catalogue and orders routes do not
 * exist in the deployed API yet, so they answer 404 and this half refuses honestly).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const STORE = require("../desktop/store.cjs");
const { AccountClient, AccountError, OPERATIONS, STORE_RETRY_BUDGET_MS } = require(
  "../desktop/accounts.cjs",
);
// The five products Owen sells, exactly as the cloud half is to send them. Prices are USD minor
// units; creditPence is what a pack is worth in the game (so 100000 is 1,000 Sterling), and
// bought Sterling is credited to the player's bank, which is why the card says "in your bank".
const PRODUCTS = [
  { key: "sterling-10", name: "10 Sterling", amountMinor: 149, currency: "USD", kind: "sterling", creditPence: 1000 },
  { key: "sterling-100", name: "100 Sterling", amountMinor: 695, currency: "USD", kind: "sterling", creditPence: 10000 },
  { key: "sterling-1000", name: "1000 Sterling", amountMinor: 2999, currency: "USD", kind: "sterling", creditPence: 100000 },
  { key: "donation-5", name: "Keep the lights on", amountMinor: 500, currency: "USD", kind: "donation", creditPence: 0 },
  { key: "penny", name: "Penny for the poor", amountMinor: 1, currency: "USD", kind: "donation", creditPence: 0 },
];
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
const clientWith = (answer) => {
  const calls = [];
  const client = new AccountClient({
    baseUrl: "https://accounts.test",
    client: "launcher/test",
    retryBudget: 0,
    request: async (url, options) => {
      calls.push({ url, options });
      return answer;
    },
  });
  return { client, calls };
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

test("the catalogue is the server's five products, in the server's order, and nothing else", () => {
  const { products } = STORE.catalogue({ products: PRODUCTS });
  assert.deepEqual(
    products.map((p) => p.key),
    ["sterling-10", "sterling-100", "sterling-1000", "donation-5", "penny"],
  );
  assert.deepEqual(products[0], PRODUCTS[0]);
  // Anything the service adds that this half does not know is dropped, never forwarded.
  const [first] = STORE.catalogue({
    products: [{ ...PRODUCTS[0], priceId: "price_secret", url: "https://elsewhere.test" }],
  }).products;
  assert.equal(first.priceId, undefined);
  assert.equal(first.url, undefined);
});

test("a catalogue this half cannot draw is refused, never rendered half-drawn", () => {
  const refused = [
    {},
    { products: [] },
    { products: null },
    { products: [PRODUCTS[0], null] },
    { products: [{ ...PRODUCTS[0], key: "Sterling 10" }] },
    { products: [{ ...PRODUCTS[0], name: "" }] },
    { products: [{ ...PRODUCTS[0], name: "x".repeat(200) }] },
    { products: [{ ...PRODUCTS[0], currency: "usd" }] },
    { products: [{ ...PRODUCTS[0], amountMinor: -1 }] },
    { products: [{ ...PRODUCTS[0], amountMinor: 1.5 }] },
    { products: [{ ...PRODUCTS[0], creditPence: "1000" }] },
    { products: [{ ...PRODUCTS[0], kind: "Sterling" }] },
    // Two products on one key would put two prices on one card.
    { products: [PRODUCTS[0], PRODUCTS[0]] },
    { products: Array.from({ length: 65 }, (_, i) => ({ ...PRODUCTS[0], key: `p-${i}` })) },
  ];
  for (const payload of refused)
    assert.throws(() => STORE.catalogue(payload), (error) => {
      assert.equal(error.name, "AccountError");
      assert.equal(error.message, STORE.SENTENCES.unavailable);
      return true;
    });
});

test("checkout forwards the Stripe URL only when it is an HTTPS link, and keeps the rest of the answer", () => {
  const answer = STORE.checkout({
    url: "https://checkout.stripe.com/c/pay/cs_test_a1",
    sessionId: "cs_test_a1",
    product: "sterling-10",
    priceId: "price_secret",
  });
  assert.deepEqual(answer, {
    url: "https://checkout.stripe.com/c/pay/cs_test_a1",
    sessionId: "cs_test_a1",
    product: "sterling-10",
  });
  for (const url of [
    "http://checkout.stripe.com/c/pay/x",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@checkout.stripe.com/c/pay/x",
    "",
    undefined,
  ])
    assert.throws(
      () => STORE.checkout({ url, sessionId: "cs_1", product: "penny" }),
      (error) => error.message === STORE.SENTENCES.unavailable,
    );
  for (const broken of [
    { url: "https://checkout.stripe.com/c/pay/x", product: "penny" },
    { url: "https://checkout.stripe.com/c/pay/x", sessionId: "", product: "penny" },
    { url: "https://checkout.stripe.com/c/pay/x", sessionId: "cs_1", product: "x".repeat(65) },
    {}
  ])
    assert.throws(
      () => STORE.checkout(broken),
      (error) => error.message === STORE.SENTENCES.unavailable,
    );
});

test("an order says Paid and In the game only on the server's own booleans", () => {
  const [pending] = STORE.orders({ orders: [ORDER] }).orders;
  assert.equal(pending.paid, false);
  assert.equal(pending.delivered, false);
  const [paid] = STORE.orders({ orders: [{ ...ORDER, paid: true }] }).orders;
  assert.equal(paid.paid, true);
  assert.equal(paid.delivered, false);
  const [delivered] = STORE.orders({
    orders: [{ ...ORDER, paid: true, delivered: true }],
  }).orders;
  assert.equal(delivered.delivered, true);
  // A truthy string is not a yes: this launcher claims nothing it was not told plainly.
  const [loose] = STORE.orders({
    orders: [{ ...ORDER, paid: "yes", delivered: 1 }],
  }).orders;
  assert.equal(loose.paid, false);
  assert.equal(loose.delivered, false);
  assert.equal(pending.createdAt, "2026-10-23T10:00:00.000Z");
});

test("orders may be empty and may not be unreadable", () => {
  assert.deepEqual(STORE.orders({ orders: [] }), { orders: [] });
  for (const payload of [
    {},
    { orders: null },
    { orders: [null] },
    { orders: [{ ...ORDER, createdAt: "yesterday" }] },
    { orders: [{ ...ORDER, currency: "dollars" }] },
    { orders: [{ ...ORDER, sessionId: "" }] },
    { orders: [{ ...ORDER, amountMinor: Number.MAX_SAFE_INTEGER }] },
    { orders: [{ ...ORDER, product: "Sterling 100" }] },
  ])
    assert.throws(
      () => STORE.orders(payload),
      (error) => error.message === STORE.SENTENCES.unavailable,
    );
});

test("every failure becomes one of exactly two sentences, and a lost session is the sign-in one", () => {
  const sessionLost = new AccountError("invalid_session", "anything");
  sessionLost.status = 401;
  assert.equal(STORE.refusal(sessionLost).message, STORE.SENTENCES.signedOut);
  const routeMissing = new AccountError("service_404", "anything");
  routeMissing.status = 404;
  assert.equal(STORE.refusal(routeMissing).message, STORE.SENTENCES.unavailable);
  const unreachable = new AccountError("unreachable", "anything");
  assert.equal(STORE.refusal(unreachable).message, STORE.SENTENCES.unavailable);
  for (const status of [400, 403, 429, 500, 502, 503, undefined])
    assert.equal(
      STORE.refusal(Object.assign(new AccountError("service_error", "x"), { status })).message,
      STORE.SENTENCES.unavailable,
    );
  // The two sentences are the whole vocabulary, and they are the frozen strings.
  assert.deepEqual(STORE.SENTENCES, {
    signedOut: "Sign in to buy.",
    unavailable: "The store is unavailable right now.",
  });
  assert.equal(STORE.signedOut().message, "Sign in to buy.");
  assert.equal(STORE.unavailable().message, "The store is unavailable right now.");
});

test("a product key is the only thing the renderer can send, and only in the server's own shape", () => {
  assert.equal(STORE.productKey("sterling-10"), "sterling-10");
  for (const value of ["", "Sterling", "../checkout", "a".repeat(65), 1, null, undefined, {}])
    assert.throws(
      () => STORE.productKey(value),
      (error) => error.message === STORE.SENTENCES.unavailable,
    );
});

test("the two store reads repeat inside the store's own window; the checkout is a write and is not repeated", () => {
  assert.equal(STORE_RETRY_BUDGET_MS, 20000);
  for (const path of ["/v2/accounts/store/catalogue", "/v2/accounts/store/orders"]) {
    const row = OPERATIONS[path];
    assert.ok(row, `${path} has a row in OPERATIONS`);
    assert.equal(row.kind, "read");
    assert.equal(row.repeat, true, `${path} may be asked again`);
    assert.equal(row.budgetMs, STORE_RETRY_BUDGET_MS);
    assert.ok(row.why.length > 20, `${path} states why`);
  }
  // A checkout creates a Stripe Checkout Session, so it is on the same rule as every other
  // write: never repeated after a lost answer, only waited out on the service's own declared
  // `database_unavailable`, which it answers before it creates anything.
  const checkout = OPERATIONS["/v2/accounts/checkout"];
  assert.equal(checkout.kind, "write");
  assert.equal(checkout.repeat, false);
  assert.equal(checkout.wakeSafe, true);
  assert.ok(checkout.why.length > 20);
});

test("storeCheckout names the product and nothing else, on the route the service serves", async () => {
  const { client, calls } = clientWith(
    ok({ url: "https://checkout.stripe.com/c/pay/cs_1", sessionId: "cs_1", product: "penny" }),
  );
  const answer = await client.storeCheckout("session-token", "penny");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://accounts.test/v2/accounts/checkout");
  assert.equal(calls[0].options.method, "POST");
  // Exactly the one field the route reads: a payment request carries nothing else.
  assert.deepEqual(JSON.parse(calls[0].options.body), { product: "penny" });
  assert.equal(calls[0].options.headers.Authorization, "Bearer session-token");
  // No price, no amount, no currency, no quantity, and no client identifier: the server prices
  // the product it knows.
  for (const field of ["price", "amount", "client"]) assert.equal(calls[0].options.body.includes(field), false);
  assert.equal(answer.product, "penny");
});

test("the two reads ask their own routes with the session and no body", async () => {
  for (const [method, path] of [
    ["storeCatalogue", "/v2/accounts/store/catalogue"],
    ["storeOrders", "/v2/accounts/store/orders"],
  ]) {
    const { client, calls } = clientWith(ok(method === "storeCatalogue" ? { products: PRODUCTS } : { orders: [] }));
    await client[method]("session-token");
    assert.equal(calls[0].url, "https://accounts.test" + path);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.headers.Authorization, "Bearer session-token");
  }
});

test("a route the deployed service does not have yet is the unavailable sentence, not an empty shop", async () => {
  // This is the state of the cloud half today: /store/catalogue and /store/orders answer 404.
  // The bridge must not read that as "nothing for sale and no orders".
  const { client } = clientWith(fail(404, { error: "not_found" }));
  await assert.rejects(client.storeCatalogue("session-token"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(STORE.refusal(error).message, STORE.SENTENCES.unavailable);
    return true;
  });
  await assert.rejects(client.storeOrders("session-token"), (error) => {
    assert.equal(STORE.refusal(error).message, STORE.SENTENCES.unavailable);
    return true;
  });
  const refused = clientWith(fail(400, { error: "unknown_product" }));
  await assert.rejects(refused.client.storeCheckout("session-token", "not-a-product"), (error) => {
    assert.equal(STORE.refusal(error).message, STORE.SENTENCES.unavailable);
    return true;
  });
  const unconfigured = clientWith(fail(503, { error: "checkout_not_configured" }));
  await assert.rejects(
    unconfigured.client.storeCheckout("session-token", "penny"),
    (error) => {
      assert.equal(STORE.refusal(error).message, STORE.SENTENCES.unavailable);
      return true;
    },
  );
});

test("an expired session asks the player to sign in, and a lost connection is the unavailable sentence", async () => {
  const expired = clientWith(fail(401, { error: "invalid_session" }));
  await assert.rejects(expired.client.storeCatalogue("stale-token"), (error) => {
    assert.equal(STORE.refusal(error).message, STORE.SENTENCES.signedOut);
    return true;
  });
  const dropped = new AccountClient({
    baseUrl: "https://accounts.test",
    retryBudget: 0,
    request: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    },
  });
  await assert.rejects(dropped.storeOrders("session-token"), (error) => {
    assert.equal(error.code, "unreachable");
    assert.equal(STORE.refusal(error).message, STORE.SENTENCES.unavailable);
    return true;
  });
});
