import { CATALOGUE, GAMES } from "./catalogue.mjs";
const clone = (value) => structuredClone(value);
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
// The only commerce adapter shipped here. No fetch, credentials, wallet or payment SDK.
export function createMockStoreAPI({
  latency = 280,
  now = () => Date.now(),
} = {}) {
  let catalogue = clone(CATALOGUE),
    orders = [],
    sequence = 0;
  const quotes = new Map(),
    attempts = new Map(),
    failures = new Map();
  const error = (code, message) => {
    throw new StoreError(code, message);
  };
  async function wait(operation, signal) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(done, latency);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
    const failure = failures.get(operation);
    if (failure) {
      failures.delete(operation);
      error(
        failure,
        failure === "PAYMENT_DECLINED"
          ? "The mock payment was declined. Your cart has been kept."
          : "The mock store could not complete this request. Please try again.",
      );
    }
  }
  function linesOf(lines) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 20)
      error("INVALID_CART", "Add an item before checking out.");
    const seen = new Set();
    return lines.map((line) => {
      if (
        !line ||
        seen.has(line.id) ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 20
      )
        error("INVALID_CART", "Check the quantities in your cart.");
      seen.add(line.id);
      const product = catalogue.find((p) => p.id === line.id);
      if (!product) error("UNAVAILABLE", "An item is no longer available.");
      if (GAMES.find((g) => g.id === product.gameId)?.status !== "available")
        error("GAME_UNAVAILABLE", "This game’s store is not open yet.");
      if (line.gameId !== undefined && line.gameId !== product.gameId)
        error("GAME_MISMATCH", "This item belongs to a different game.");
      if (!product.repeatable && line.quantity !== 1)
        error("INVALID_CART", "This item can only be bought once.");
      if (
        !product.repeatable &&
        orders.some((o) => o.lines.some((l) => l.id === product.id))
      )
        error("OWNED", "You already own this item in the demo.");
      if (product.stock !== null && product.stock < line.quantity)
        error("SOLD_OUT", product.name + " is no longer in stock.");
      return {
        id: product.id,
        gameId: product.gameId,
        name: product.name,
        quantity: line.quantity,
        unitAmount: product.price,
        totalAmount: product.price * line.quantity,
      };
    });
  }
  return {
    mode: "mock",
    async catalogue({ signal } = {}) {
      await wait("catalogue", signal);
      return {
        schema: 1,
        currency: "USD",
        items: clone(catalogue),
        games: clone(GAMES),
        owned: orders.flatMap((o) => o.lines.map((l) => l.id)),
      };
    },
    async quote({ lines, gameId }, { signal } = {}) {
      await wait("quote", signal);
      const validated = linesOf(lines),
        subtotal = validated.reduce((n, l) => n + l.totalAmount, 0);
      if (new Set(validated.map((l) => l.gameId)).size !== 1)
        error("MIXED_GAMES", "Please check out items for one game at a time.");
      if (gameId !== undefined && gameId !== validated[0].gameId)
        error("GAME_MISMATCH", "Review the game selected for this checkout.");
      const q = {
        id: "quote-" + ++sequence,
        gameId: validated[0].gameId,
        currency: "USD",
        lines: validated,
        subtotal,
        tax: 0,
        total: subtotal,
        expiresAt: now() + 120000,
        mode: "mock",
      };
      quotes.set(q.id, q);
      return clone(q);
    },
    async purchase({ quoteId, idempotencyKey }, { signal } = {}) {
      await wait("purchase", signal);
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8)
        error(
          "INVALID_KEY",
          "The order could not be identified. Please review your cart.",
        );
      const previous = attempts.get(idempotencyKey);
      if (previous) {
        if (previous.quoteId !== quoteId)
          error(
            "KEY_CONFLICT",
            "This checkout attempt belongs to a different quote.",
          );
        return clone(previous.order);
      }
      const q = quotes.get(quoteId);
      if (!q) error("QUOTE_MISSING", "Please review your cart again.");
      if (q.expiresAt <= now())
        error(
          "QUOTE_EXPIRED",
          "Your price quote expired. Review the updated total before continuing.",
        );
      const lines = linesOf(q.lines);
      if (lines.some((l, i) => l.unitAmount !== q.lines[i].unitAmount))
        error("PRICE_CHANGED", "A price changed. Review your cart again.");
      const order = {
        id: "DEMO-" + String(++sequence).padStart(5, "0"),
        createdAt: new Date(now()).toISOString(),
        gameId: q.gameId,
        currency: q.currency,
        lines: clone(q.lines),
        subtotal: q.subtotal,
        tax: q.tax,
        total: q.total,
        status: "simulated",
        mode: "mock",
      };
      for (const line of lines) {
        const p = catalogue.find((p) => p.id === line.id);
        if (p.stock !== null) p.stock -= line.quantity;
      }
      orders.unshift(order);
      attempts.set(idempotencyKey, { quoteId, order });
      const responseFailure = failures.get("purchase-response");
      if (responseFailure) {
        failures.delete("purchase-response");
        error(
          responseFailure,
          "The order response was interrupted. Retry to confirm the same order; do not start another checkout.",
        );
      }
      return clone(order);
    },
    async orders({ signal } = {}) {
      await wait("orders", signal);
      return clone(orders);
    },
    // Test injection only; these controls are not rendered as shopping UI.
    failNext(operation, code = "PAYMENT_DECLINED") {
      failures.set(operation, code);
    },
  };
}
