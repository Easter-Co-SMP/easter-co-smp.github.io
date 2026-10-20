import test from "node:test";
import assert from "node:assert/strict";
import { createMockStoreAPI } from "../site/store/mock-api.mjs";
const setup = (options) => createMockStoreAPI({ latency: 0, ...options });
const quote = (api, id = "crowns-1000", quantity = 1) =>
  api.quote({ lines: [{ id, quantity, unitAmount: 1 }] });
const purchase = (api, q, key = "test-order-unique") =>
  api.purchase({ quoteId: q.id, idempotencyKey: key });
test("all products use real currency, quotes ignore supplied prices and currency is a normal purchasable SKU", async () => {
  const api = setup(),
    catalogue = await api.catalogue();
  assert.ok(
    catalogue.items.every(
      (p) => p.currency === "USD" && Number.isInteger(p.price) && p.price > 0,
    ),
  );
  const q = await quote(api, "crowns-1000", 2);
  assert.equal(q.total, 1000);
  assert.equal(q.tax, 0);
  assert.equal(q.currency, "USD");
  const result = await purchase(api, q);
  assert.equal(result.total, 1000);
  assert.equal(result.mode, "mock");
  assert.equal(result.status, "simulated");
  assert.equal(result.lines[0].quantity, 2);
});
test("concurrent duplicate submissions return one order and never double-decrement stock", async () => {
  const api = setup(),
    q = await quote(api, "coastal-sloop");
  const [a, b] = await Promise.all([purchase(api, q), purchase(api, q)]);
  assert.equal(a.id, b.id);
  assert.equal((await api.orders()).length, 1);
  assert.equal(
    (await api.catalogue()).items.find((p) => p.id === "coastal-sloop").stock,
    7,
  );
  const other = await quote(api);
  await assert.rejects(purchase(api, other), { code: "KEY_CONFLICT" });
});
test("expired quotes require re-review and a declined attempt preserves cart and retry key", async () => {
  let clock = 1000;
  const api = setup({ now: () => clock }),
    q = await quote(api);
  clock += 120000;
  await assert.rejects(purchase(api, q), { code: "QUOTE_EXPIRED" });
  const next = await quote(api);
  api.failNext("purchase");
  await assert.rejects(purchase(api, next), { code: "PAYMENT_DECLINED" });
  assert.equal((await api.orders()).length, 0);
  assert.ok((await purchase(api, next)).id);
});
test("sold-out, owned, duplicate and invalid quantities are refused, orders are atomic", async () => {
  const api = setup();
  await assert.rejects(quote(api, "clifftop-house"), { code: "SOLD_OUT" });
  await assert.rejects(quote(api, "priority-30", 2), { code: "INVALID_CART" });
  for (const n of [0, 21, 1.5])
    await assert.rejects(quote(api, "crowns-1000", n), {
      code: "INVALID_CART",
    });
  await assert.rejects(
    api.quote({
      lines: [
        { id: "crowns-1000", quantity: 1 },
        { id: "crowns-1000", quantity: 1 },
      ],
    }),
    { code: "INVALID_CART" },
  );
  const q = await quote(api, "coastal-sloop"),
    second = await quote(api, "coastal-sloop");
  await purchase(api, q);
  await assert.rejects(purchase(api, second, "another-order"), {
    code: "OWNED",
  });
  assert.equal((await api.orders()).length, 1);
});
test("returned catalogue and orders are isolated copies; cancelled reads create no order", async () => {
  const api = setup(),
    catalogue = await api.catalogue();
  catalogue.items[0].price = 0;
  assert.ok((await api.catalogue()).items[0].price > 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.catalogue({ signal: controller.signal }));
  assert.equal((await api.orders()).length, 0);
  const q = await quote(api);
  const order = await purchase(api, q);
  order.total = 0;
  assert.notEqual((await api.orders())[0].total, 0);
});
test("a lost success response can be retried with the same key even after quote expiry", async () => {
  let clock = 1000;
  const api = setup({ now: () => clock }),
    q = await quote(api, "harbour-cottage");
  api.failNext("purchase-response", "NETWORK");
  await assert.rejects(purchase(api, q), { code: "NETWORK" });
  assert.equal((await api.orders()).length, 1);
  clock += 200000;
  const retry = await purchase(api, q);
  assert.equal(retry.id, (await api.orders())[0].id);
  assert.equal((await api.orders()).length, 1);
  assert.equal(
    (await api.catalogue()).items.find((p) => p.id === "harbour-cottage").stock,
    4,
  );
});
test("catalogue, quotes and receipts retain authoritative game identity; coming-soon games have no purchasable SKUs", async () => {
  const api = setup(),
    c = await api.catalogue();
  assert.equal(c.games.length, 3);
  assert.ok(c.items.every((p) => p.gameId === "easter-smp"));
  assert.equal(c.games.filter((g) => g.status === "coming-soon").length, 2);
  await assert.rejects(
    api.quote({
      gameId: "orbital-racing",
      lines: [{ id: "crowns-1000", quantity: 1 }],
    }),
    { code: "GAME_MISMATCH" },
  );
  await assert.rejects(
    api.quote({
      lines: [{ id: "crowns-1000", quantity: 1, gameId: "frontier" }],
    }),
    { code: "GAME_MISMATCH" },
  );
  await assert.rejects(
    api.quote({ lines: [{ id: "orbital-livery", quantity: 1 }] }),
    { code: "UNAVAILABLE" },
  );
  const q = await quote(api);
  assert.equal(q.gameId, "easter-smp");
  assert.equal(q.lines[0].gameId, "easter-smp");
  const o = await purchase(api, q);
  assert.equal(o.gameId, "easter-smp");
  assert.equal((await api.orders())[0].gameId, "easter-smp");
});
