import { CATEGORIES, GAMES, money } from "./catalogue.mjs";
import { createMockStoreAPI } from "./mock-api.mjs";
import { productArt } from "./art.mjs";
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (label, fn, cls = "store-button") => {
  const n = el("button", cls, label);
  n.type = "button";
  n.onclick = fn;
  return n;
};
const artwork = (kind, cls = "store-art") => {
  const n = el("div", cls);
  n.innerHTML = productArt(kind);
  return n;
};
let singleton;
export function openStore(options = {}) {
  if (!singleton) singleton = createStore(options);
  singleton.open();
  return singleton;
}
export function createStore({ api = createMockStoreAPI() } = {}) {
  if (api.mode !== "mock")
    throw Error("This preview only accepts a mock commerce adapter.");
  const dialog = el("dialog", "company-store");
  dialog.setAttribute("aria-labelledby", "company-store-title");
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./store.css", import.meta.url).href;
  document.head.append(css);
  const mast = el("header", "store-mast"),
    brand = el("div", "store-brand");
  brand.append(el("span", "store-overline", "EASTER COMPANY"));
  const title = el("h1", "store-title", "The Company store");
  title.id = "company-store-title";
  brand.append(title);
  const nav = el("nav", "store-top-nav");
  nav.setAttribute("aria-label", "Store navigation");
  const browse = button("Browse", () => go("catalogue"), "store-nav"),
    history = button("Orders", () => go("orders"), "store-nav"),
    cartButton = button(
      "Cart · 0",
      () => go("cart"),
      "store-nav store-cart-link",
    ),
    close = button("Close", () => dialog.close(), "store-close");
  close.setAttribute("aria-label", "Close store");
  nav.append(browse, history, cartButton, close);
  mast.append(brand, nav);
  const demo = el("div", "store-demo");
  demo.append(
    el("strong", "", "Mock store"),
    el(
      "span",
      "",
      "Sample products and USD prices. No charges or in-game delivery.",
    ),
  );
  const layout = el("div", "store-layout"),
    sidebar = el("aside", "store-sidebar"),
    body = el("div", "store-body"),
    feedback = el("div", "store-feedback"),
    content = el("div", "store-content");
  feedback.hidden = true;
  feedback.setAttribute("role", "alert");
  content.tabIndex = -1;
  body.append(feedback, content);
  layout.append(sidebar, body);
  const announce = el("p", "store-sr-only");
  announce.setAttribute("role", "status");
  announce.setAttribute("aria-live", "polite");
  const gamesNav = el("nav", "store-games");
  gamesNav.setAttribute("aria-label", "Choose a game");
  dialog.append(mast, demo, gamesNav, layout, announce);
  document.body.append(dialog);
  let gameId = "easter-smp";
  const gameName = (id) =>
    GAMES.find((g) => g.id === id)?.name || "Unknown game";
  let products = [],
    owned = [],
    cart = [],
    view = "catalogue",
    category = "all",
    query = "",
    sort = "featured",
    selected = null,
    quote = null,
    order = null,
    error = null,
    retry = null,
    busy = false,
    loading = false,
    key = null,
    generation = 0;
  const count = () => cart.reduce((sum, l) => sum + l.quantity, 0);
  const product = (id) => products.find((p) => p.id === id);
  const blocked = (p) =>
    p.stock === 0 || (!p.repeatable && owned.includes(p.id));
  const status = (p) =>
    p.stock === 0
      ? "Sold out"
      : !p.repeatable && owned.includes(p.id)
        ? "In demo library"
        : null;
  function top() {
    gamesNav.replaceChildren();
    for (const game of GAMES) {
      const choice = button(
        "",
        () => {
          gameId = game.id;
          category = "all";
          query = "";
          go("catalogue");
        },
        "store-game",
      );
      choice.dataset.game = game.id;
      choice.setAttribute("aria-pressed", String(gameId === game.id));
      choice.setAttribute(
        "aria-label",
        game.name +
          (game.status === "available"
            ? " — Store open"
            : " — Coming soon, placeholder"),
      );
      choice.disabled = busy || loading;
      const mark = el("span", "store-game-mark", game.mark);
      mark.setAttribute("aria-hidden", "true");
      if (game.id === "easter-smp") {
        const image = el("img");
        image.src = new URL("../assets/ec-logo.svg", import.meta.url).href;
        image.alt = "";
        mark.replaceChildren(image);
      }
      const copy = el("span", "store-game-copy");
      copy.append(el("strong", "", game.name), el("small", "", game.genre));
      choice.append(
        mark,
        copy,
        el(
          "span",
          "store-game-state",
          game.status === "available" ? "Store open" : "Coming soon",
        ),
      );
      gamesNav.append(choice);
    }
    requestAnimationFrame(() =>
      gamesNav
        .querySelector('[aria-pressed="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
    cartButton.textContent = "Cart · " + count();
    for (const [n, v] of [
      [browse, "catalogue"],
      [history, "orders"],
      [cartButton, "cart"],
    ]) {
      n.setAttribute("aria-current", view === v ? "page" : "false");
      n.disabled = busy || loading;
    }
    close.disabled = busy;
    sidebar.hidden =
      view === "catalogue" &&
      GAMES.find((g) => g.id === gameId)?.status !== "available";
    sidebar.replaceChildren(
      el("p", "store-overline", "BROWSE THE STORE"),
      el("p", "store-sidebar-game", gameName(gameId)),
    );
    for (const [id, label] of CATEGORIES) {
      const b = button(
        label,
        () => {
          category = id;
          query = "";
          go("catalogue");
        },
        "store-category",
      );
      b.setAttribute(
        "aria-pressed",
        String(category === id && view === "catalogue"),
      );
      b.disabled =
        busy ||
        loading ||
        GAMES.find((g) => g.id === gameId)?.status !== "available";
      sidebar.append(b);
    }
    const note = el("div", "store-sidebar-note");
    note.append(
      el("strong", "", "Real-currency checkout"),
      el(
        "p",
        "",
        "All products are priced in USD in this demo. Crowns are spendable in-game only; they cannot pay for this store.",
      ),
    );
    sidebar.append(note);
  }
  function paintError() {
    feedback.replaceChildren();
    feedback.hidden = !error;
    if (error) {
      feedback.append(el("span", "", error));
      if (retry)
        feedback.append(button("Try again", retry, "store-text-button"));
    }
  }
  function fail(e, again = null) {
    error = e?.message || "Something went wrong. Please try again.";
    retry = again;
    paintError();
  }
  function heading(kicker, text, description) {
    const h = el("div", "store-section-heading");
    if (kicker) h.append(el("p", "store-overline", kicker));
    h.append(el("h2", "", text));
    if (description) h.append(el("p", "", description));
    content.append(h);
  }
  function empty(
    title,
    copy,
    action = "Browse the store",
    fn = () => go("catalogue"),
  ) {
    const n = el("section", "store-empty");
    n.append(
      artwork("ship"),
      el("h3", "", title),
      el("p", "", copy),
      button(action, fn, "store-button store-primary"),
    );
    content.append(n);
  }
  function render() {
    top();
    paintError();
    content.replaceChildren();
    if (loading) {
      heading(
        "THE COMPANY STORE",
        view === "orders" ? "Loading your orders…" : "Opening the store…",
        view === "orders"
          ? "Fetching your mock purchase history."
          : "Fetching the catalogue.",
      );
      content.setAttribute("aria-busy", "true");
      return;
    }
    content.setAttribute("aria-busy", String(busy));
    if (view === "catalogue") catalogue();
    else if (view === "detail") details();
    else if (view === "cart") basket();
    else if (view === "checkout") checkout();
    else if (view === "receipt") receipt();
    else if (view === "orders") historyView();
    if (busy)
      for (const control of content.querySelectorAll("button,input,select"))
        control.disabled = true;
  }
  function go(next) {
    if (busy || loading) return;
    if (next === "cart" && cart.length) gameId = product(cart[0].id).gameId;
    if (next === "receipt" && order) gameId = order.gameId;
    generation++;
    loading = false;
    error = null;
    retry = null;
    view = next;
    render();
    content.scrollTop = 0;
    body.scrollTop = 0;
    content.focus({ preventScroll: true });
    if (next === "orders") void loadOrders();
  }
  function add(p) {
    if (busy || loading || blocked(p)) return;
    const line = cart.find((l) => l.id === p.id),
      max = p.repeatable ? Math.min(p.stock ?? 20, 20) : 1;
    if (line) {
      if (line.quantity >= max) {
        announce.textContent = "Maximum quantity is already in your cart.";
        return;
      }
      line.quantity++;
    } else cart.push({ id: p.id, quantity: 1 });
    quote = null;
    key = null;
    announce.textContent = p.name + " added to your cart.";
    render();
    const added = content.querySelector(`[data-add="${p.id}"]`);
    (added && !added.disabled ? added : cartButton).focus();
  }
  function catalogue() {
    const game = GAMES.find((g) => g.id === gameId);
    if (game.status !== "available") {
      heading("COMING SOON · PLACEHOLDER", game.name, game.description);
      const soon = el("section", "store-coming-soon");
      soon.dataset.game = game.id;
      soon.append(
        el("span", "store-concept-mark", game.mark),
        el("h3", "", "A new world. A store of its own."),
        el(
          "p",
          "",
          "Each game will have its own catalogue, purchases and in-game currency. These concept cards show how future games could appear; nothing here is for sale.",
        ),
      );
      const previews = el("div", "store-concept-grid");
      for (const title of game.previews) {
        const card = el("article", "store-concept-card");
        card.append(
          el("p", "store-overline", "COMING SOON"),
          el("h4", "", title),
          el("p", "", "Illustrative placeholder · Not purchasable"),
        );
        previews.append(card);
      }
      soon.append(
        previews,
        button(
          "Back to Easter Co. SMP",
          () => {
            gameId = "easter-smp";
            category = "all";
            go("catalogue");
          },
          "store-button",
        ),
      );
      content.append(soon);
      return;
    }
    heading(
      "SHOP BY GAME",
      game.name,
      "Purchases, queue access and Crowns in this catalogue apply only to Easter Co. SMP.",
    );
    if (category === "all" && !query) {
      const feature =
        products.find((p) => p.gameId === gameId && p.id === "coastal-sloop") ||
        products.find((p) => p.gameId === gameId);
      if (feature) {
        const hero = el("section", "store-feature"),
          copy = el("div", "store-feature-copy");
        copy.append(
          el("p", "store-overline", "THE NEXT CHAPTER"),
          el("h2", "", "A new horizon awaits."),
          el(
            "p",
            "",
            "A ship to command. A place to call home. Find something for your next life on the Isles.",
          ),
        );
        copy.append(
          button(
            "Explore the Coastal Sloop",
            () => {
              selected = feature.id;
              go("detail");
            },
            "store-button store-primary",
          ),
        );
        hero.append(copy, artwork(feature.kind, "store-feature-art"));
        content.append(hero);
      }
    }
    const toolbar = el("div", "store-toolbar"),
      label = el("label", "store-search");
    label.append(el("span", "store-sr-only", "Search the store"));
    const input = el("input");
    input.type = "search";
    input.placeholder = "Search the store";
    input.value = query;
    label.append(input);
    const sortLabel = el("label", "store-sort");
    sortLabel.append(el("span", "", "Sort by"));
    const select = el("select");
    for (const [value, text] of [
      ["featured", "Featured"],
      ["low", "Price: low to high"],
      ["high", "Price: high to low"],
    ]) {
      const o = el("option", "", text);
      o.value = value;
      select.append(o);
    }
    select.value = sort;
    sortLabel.append(select);
    toolbar.append(label, sortLabel);
    content.append(toolbar);
    const grid = el("div", "store-grid"),
      summary = el("p", "store-results");
    summary.setAttribute("role", "status");
    content.append(summary, grid);
    function draw() {
      grid.replaceChildren();
      let list = products.filter(
        (p) =>
          p.gameId === gameId &&
          (category === "all" || p.category === category) &&
          `${p.name} ${p.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      );
      if (sort !== "featured")
        list.sort((a, b) =>
          sort === "low" ? a.price - b.price : b.price - a.price,
        );
      summary.textContent =
        (CATEGORIES.find((c) => c[0] === category)?.[1] || "Discover") +
        " · " +
        list.length +
        " " +
        (list.length === 1 ? "item" : "items");
      if (!list.length) {
        const blank = el("div", "store-no-results");
        blank.append(
          el("h3", "", "No items found"),
          el("p", "", "Try another search or browse a different category."),
          button(
            "Clear search",
            () => {
              query = "";
              input.value = "";
              draw();
              input.focus();
            },
            "store-text-button",
          ),
        );
        grid.append(blank);
      }
      for (const p of list) {
        const card = el("article", "store-product"),
          open = button(
            "",
            () => {
              selected = p.id;
              go("detail");
            },
            "store-product-open",
          );
        open.setAttribute("aria-label", "View " + p.name);
        const art = artwork(p.kind);
        if (status(p)) art.append(el("span", "store-badge", status(p)));
        open.append(
          art,
          el(
            "span",
            "store-product-category",
            CATEGORIES.find((c) => c[0] === p.category)?.[1],
          ),
          el("h3", "", p.name),
        );
        const footer = el("div", "store-product-footer");
        footer.append(el("strong", "", money(p.price, p.currency)));
        const addButton = button(
          status(p) || "Add to cart",
          () => add(p),
          "store-small-button",
        );
        addButton.dataset.add = p.id;
        addButton.disabled =
          blocked(p) || (cart.some((l) => l.id === p.id) && !p.repeatable);
        addButton.setAttribute("aria-label", "Add " + p.name + " to cart");
        if (!blocked(p) && !p.repeatable && cart.some((l) => l.id === p.id))
          addButton.textContent = "In cart";
        footer.append(addButton);
        card.append(open, footer);
        grid.append(card);
      }
    }
    input.oninput = () => {
      query = input.value;
      draw();
    };
    select.onchange = () => {
      sort = select.value;
      draw();
    };
    draw();
  }
  function details() {
    const p = product(selected);
    if (!p) {
      empty("Item unavailable", "Choose another item from the catalogue.");
      return;
    }
    content.append(
      button("← Back to store", () => go("catalogue"), "store-back"),
    );
    content.append(el("p", "store-game-context", "FOR " + gameName(p.gameId)));
    const detail = el("section", "store-detail"),
      copy = el("div", "store-detail-copy");
    copy.append(
      el(
        "p",
        "store-overline",
        CATEGORIES.find((c) => c[0] === p.category)?.[1],
      ),
      el("h2", "", p.name),
      el("p", "store-detail-description", p.description),
      el("p", "store-detail-price", money(p.price, p.currency)),
      el("p", "store-muted", "One-time payment · Sample USD price"),
    );
    const addButton = button(
      status(p) || "Add to cart",
      () => add(p),
      "store-button store-primary",
    );
    addButton.dataset.add = p.id;
    addButton.disabled =
      blocked(p) || (!p.repeatable && cart.some((l) => l.id === p.id));
    if (!blocked(p) && !p.repeatable && cart.some((l) => l.id === p.id))
      addButton.textContent = "In cart";
    copy.append(
      addButton,
      button("View cart", () => go("cart"), "store-button"),
    );
    if (p.stock !== null)
      copy.append(
        el(
          "p",
          "store-muted",
          p.stock
            ? `${p.stock} available in the demo`
            : "Currently unavailable",
        ),
      );
    const list = el("ul", "store-includes");
    for (const value of p.includes) list.append(el("li", "", value));
    copy.append(
      el("h3", "", "What’s included"),
      list,
      el("h3", "", "Before you buy"),
      el("p", "store-terms", p.terms),
    );
    detail.append(artwork(p.kind, "store-detail-art"), copy);
    content.append(detail);
  }
  function changeQuantity(id, value) {
    if (busy) return;
    const p = product(id),
      line = cart.find((l) => l.id === id);
    if (!line || !Number.isInteger(value)) return;
    line.quantity = Math.max(
      1,
      Math.min(value, p.repeatable ? Math.min(p.stock ?? 20, 20) : 1),
    );
    quote = null;
    key = null;
    render();
    content.querySelector(`[data-quantity="${id}"]`)?.focus();
  }
  function basket() {
    heading(
      "YOUR NEXT VOYAGE",
      "Your cart",
      `${count()} ${count() === 1 ? "item" : "items"} · Prices in USD. In-game Crowns cannot be used here.`,
    );
    if (!cart.length) {
      empty(
        "Your next adventure starts here.",
        "Explore ships, homes, supplies and account upgrades.",
      );
      return;
    }
    const layout = el("div", "store-checkout-layout"),
      list = el("div", "store-cart-lines");
    for (const line of cart) {
      const p = product(line.id);
      if (!p) continue;
      const row = el("article", "store-cart-row"),
        copy = el("div", "store-cart-copy");
      copy.append(
        el("h3", "", p.name),
        el("p", "", gameName(p.gameId) + " · " + money(p.price) + " each"),
      );
      const controls = el("div", "store-quantity");
      const label = el("label", "", "Quantity");
      const input = el("input");
      input.type = "number";
      input.min = "1";
      input.max = String(p.repeatable ? Math.min(p.stock ?? 20, 20) : 1);
      input.value = String(line.quantity);
      input.dataset.quantity = p.id;
      input.setAttribute("aria-label", "Quantity for " + p.name);
      input.onchange = () => changeQuantity(p.id, Number(input.value));
      label.append(input);
      controls.append(
        label,
        button(
          "Remove",
          () => {
            cart = cart.filter((l) => l.id !== p.id);
            quote = null;
            key = null;
            render();
            announce.textContent = p.name + " removed from your cart.";
          },
          "store-text-button",
        ),
      );
      copy.append(controls);
      row.append(
        artwork(p.kind, "store-cart-art"),
        copy,
        el("strong", "store-line-total", money(p.price * line.quantity)),
      );
      list.append(row);
    }
    const sum = cart.reduce(
        (n, l) => n + (product(l.id)?.price || 0) * l.quantity,
        0,
      ),
      summary = el("aside", "store-summary");
    summary.append(el("h3", "", "Order summary"));
    amountRow(summary, "Subtotal", sum);
    summary.append(
      el(
        "p",
        "store-muted",
        "Final demo tax and total are confirmed at checkout.",
      ),
    );
    summary.append(
      button("Review checkout", prepare, "store-button store-primary"),
      button("Continue shopping", () => go("catalogue"), "store-button"),
    );
    layout.append(list, summary);
    content.append(layout);
  }
  function amountRow(parent, label, amount, total = false) {
    const row = el("div", total ? "store-amount store-total" : "store-amount");
    row.append(
      el("span", "", label),
      el("strong", "", money(amount, quote?.currency || "USD")),
    );
    parent.append(row);
  }
  async function prepare() {
    if (busy) return;
    busy = true;
    error = null;
    render();
    announce.textContent = "Checking availability and confirming your total.";
    try {
      quote = await api.quote({
        gameId: product(cart[0].id).gameId,
        lines: cart.map((l) => ({ ...l })),
      });
      gameId = quote.gameId;
      key = crypto.randomUUID();
      view = "checkout";
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
      render();
      body.scrollTop = 0;
      content.focus({ preventScroll: true });
    }
  }
  function checkout() {
    if (!quote) {
      view = "cart";
      basket();
      return;
    }
    heading(
      "ONE LAST LOOK",
      "Review your order",
      "This is a simulated real-money checkout. No real payment is taken.",
    );
    const layout = el("div", "store-checkout-layout"),
      main = el("div", "store-checkout-main"),
      recipient = el("section", "store-checkout-panel");
    recipient.append(
      el("h3", "", "Delivery account"),
      el("strong", "", "Demo Captain"),
      el(
        "p",
        "",
        gameName(quote.gameId) +
          " only. A dedicated fictional account for this preview. Purchases will not be linked to your signed-in account.",
      ),
    );
    const payment = el("section", "store-checkout-panel");
    payment.append(
      el("h3", "", "Payment"),
      el("strong", "", "Simulated USD payment"),
      el(
        "p",
        "",
        "No card or bank details required. All store products use real currency. Crowns are only spendable inside the game.",
      ),
    );
    const terms = el("label", "store-check");
    const consent = el("input");
    consent.type = "checkbox";
    consent.disabled = busy;
    consent.id = "store-confirm";
    const text = el(
      "span",
      "",
      "I understand this is a mock purchase, with no charge and no in-game delivery.",
    );
    terms.append(consent, text);
    main.append(recipient, payment, terms);
    const summary = el("aside", "store-summary");
    summary.append(el("h3", "", "Your order"));
    for (const l of quote.lines) {
      const line = el("div", "store-order-line");
      line.append(
        el("span", "", l.name + " × " + l.quantity),
        el("strong", "", money(l.totalAmount, quote.currency)),
      );
      summary.append(line);
    }
    amountRow(summary, "Subtotal", quote.subtotal);
    amountRow(summary, "Tax (demo)", quote.tax);
    amountRow(summary, "Total · USD", quote.total, true);
    summary.append(
      el(
        "p",
        "store-muted",
        "One-time payment. No subscriptions or automatic renewals. Demo tax is $0.00; real tax is not calculated.",
      ),
    );
    const submit = button(
      busy
        ? "Placing test order…"
        : "Place test order · " + money(quote.total, quote.currency),
      submitOrder,
      "store-button store-primary",
    );
    submit.disabled = true;
    consent.onchange = () => {
      submit.disabled = busy || !consent.checked;
    };
    summary.append(submit);
    if (busy) {
      summary.append(
        el(
          "p",
          "store-muted",
          "Please keep this window open while the order completes.",
        ),
      );
    }
    const back = button(
      "Back to cart",
      () => {
        quote = null;
        key = null;
        go("cart");
      },
      "store-button",
    );
    back.disabled = busy;
    summary.append(back);
    layout.append(main, summary);
    content.append(layout);
  }
  async function submitOrder() {
    if (busy || !quote || !content.querySelector("#store-confirm")?.checked)
      return;
    busy = true;
    error = null;
    render();
    try {
      order = await api.purchase({ quoteId: quote.id, idempotencyKey: key });
      cart = [];
      quote = null;
      key = null;
      const snapshot = await api.catalogue().catch(() => null);
      if (snapshot) {
        products = snapshot.items;
        owned = snapshot.owned;
      }
      view = "receipt";
    } catch (e) {
      if (
        [
          "QUOTE_EXPIRED",
          "PRICE_CHANGED",
          "SOLD_OUT",
          "OWNED",
          "UNAVAILABLE",
        ].includes(e.code)
      ) {
        quote = null;
        key = null;
        view = "cart";
      }
      fail(e);
    } finally {
      busy = false;
      render();
      body.scrollTop = 0;
      content.focus({ preventScroll: true });
    }
  }
  function receipt() {
    heading(
      "ORDER RECEIVED",
      "Your test order is complete.",
      "No money was charged. No items, currency or privileges were delivered to the game.",
    );
    const panel = el("section", "store-receipt");
    panel.append(
      el("p", "store-game-context", gameName(order.gameId)),
      el("span", "store-receipt-mark", "✓"),
      el("p", "store-overline", order.id),
      el("h3", "", "Thanks for visiting the Company store."),
      el(
        "p",
        "store-muted",
        new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(order.createdAt)),
      ),
    );
    for (const line of order.lines) {
      const row = el("div", "store-order-line");
      row.append(
        el("span", "", line.name + " × " + line.quantity),
        el("strong", "", money(line.totalAmount, order.currency)),
      );
      panel.append(row);
    }
    const total = el("div", "store-amount store-total");
    total.append(
      el("span", "", "Simulated total"),
      el("strong", "", money(order.total, order.currency)),
    );
    panel.append(
      total,
      el(
        "p",
        "store-terms",
        "This is a temporary demo receipt, not proof of payment or in-game ownership.",
      ),
    );
    panel.append(
      button(
        "Continue exploring",
        () => go("catalogue"),
        "store-button store-primary",
      ),
      button("View orders", () => go("orders"), "store-button"),
    );
    content.append(panel);
  }
  let orderList = [];
  function historyView() {
    heading(
      "YOUR ACCOUNT",
      "Demo orders",
      "Simulated purchase history for this launcher session.",
    );
    if (!orderList.length) {
      empty("No orders yet.", "Your test purchases will appear here.");
      return;
    }
    const list = el("div", "store-orders");
    for (const o of orderList) {
      const row = el("article", "store-order-record"),
        copy = el("div");
      copy.append(
        el("h3", "", o.id),
        el("p", "store-game-context", gameName(o.gameId)),
        el(
          "p",
          "store-muted",
          new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
            new Date(o.createdAt),
          ) + " · Mock purchase",
        ),
        el(
          "p",
          "",
          o.lines.map((l) => l.name + " × " + l.quantity).join(" · "),
        ),
      );
      row.append(
        copy,
        el("strong", "", money(o.total, o.currency)),
        button(
          "View receipt",
          () => {
            order = o;
            go("receipt");
          },
          "store-button",
        ),
      );
      list.append(row);
    }
    content.append(list);
  }
  async function loadOrders() {
    const token = ++generation;
    loading = true;
    render();
    try {
      const result = await api.orders();
      if (token !== generation) return;
      orderList = result;
    } catch (e) {
      if (token === generation) fail(e, loadOrders);
    } finally {
      if (token === generation) {
        loading = false;
        render();
      }
    }
  }
  async function load() {
    const token = ++generation;
    loading = true;
    error = null;
    render();
    try {
      const result = await api.catalogue();
      if (token !== generation) return;
      products = result.items;
      owned = result.owned;
    } catch (e) {
      if (token === generation) fail(e, load);
    } finally {
      if (token === generation) {
        loading = false;
        render();
      }
    }
  }
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  return {
    open() {
      if (dialog.open) {
        dialog.focus();
        return;
      }
      view = "catalogue";
      dialog.showModal();
      void load();
    },
    close() {
      if (!busy) dialog.close();
    },
    element: dialog,
  };
}
