/*
 * The Community store, rendered into the page at /store/.
 *
 * site/store/index.html owns the page shell — the site header and its nav, the h1 and the
 * footer. This module owns everything inside #store-root, and it is a page like /map/ and
 * /wiki/ rather than a dialog, so its views are hash routes: Back, Forward and a shared link
 * all reach the same view.
 *
 *   #catalogue    every product the server sells, in the server's order.
 *   #item/<key>   one product on its own, <key> being the key the server sent. A key this
 *                 launcher does not have falls back to #catalogue.
 *   #orders       the player's own orders, as the server reports them.
 *
 * #cart, #checkout and #receipt/<id> are gone: buying is one product at a time from its own
 * card, so there is no cart to review and no receipt to invent. A link or an old bookmark to
 * one of those lands on #catalogue, in place, so the address bar never names a view that is
 * not on screen.
 *
 * MONEY, PRODUCTS AND ORDERS COME FROM THE ACCOUNT SERVICE, through the launcher's own bridge
 * (window.easterDesktop.storeCatalogue / storeCheckout / storeOrders). This module prices
 * nothing, totals nothing and fetches nothing: it has no server address, no credentials and no
 * catalogue of its own, and the dollar amounts it prints are the integers the server sent. A
 * build whose bridge does not carry those three commands gets the unavailable line and no
 * buying control at all, rather than a button that does nothing.
 *
 * The sentences below are Owen's, fixed in writing, and this page prints no others: every
 * failure is one of the two refusals main chose, never a wording of this page's own.
 */
import { productArt } from "./art.mjs";

const COPY = {
  buy: "Buy",
  // While the browser is being handed the Stripe page.
  opening: "Opening Stripe\u2026",
  // After it. The launcher opened a page; it did not see a payment, so this is all it says.
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
const anchor = (href, cls) => {
  const n = el("a", cls);
  n.href = href;
  return n;
};
const artwork = (kind, cls = "store-art") => {
  const n = el("div", cls);
  // The illustrations are local static vectors, chosen by the kind the server sent. A kind
  // with no illustration of its own still gets one: art is decoration, never a claim.
  n.innerHTML = productArt(kind === "donation" ? "flag" : "coins");
  return n;
};
const money = (amountMinor, currency) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    amountMinor / 100,
  );
// What a Sterling pack is worth in the game, from the server's own creditPence: the card
// describes the pack, it does not price it. The line names the BANK, not the wallet: bought
// currency is credited to the player's bank account (Owen, 2026-10-23), which is the uncapped
// in-game vault, because the wallet is capped for gameplay and a purchase must not be truncated
// by a cap that exists for a different reason. A product that credits nothing is a donation.
const worth = (p) =>
  p.creditPence > 0
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
        p.creditPence / 100,
      ) + " Sterling in your bank"
    : COPY.donation;
const dateOf = (iso) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(iso),
  );
// A refusal is printed only if it is one of the two sentences main owns. Anything else — the
// startup gate's own refusal, a transport failure, a bridge from a build that is not this one —
// is reported as the store being unavailable rather than printed here, so this page never
// becomes a second author of launcher copy.
const refusal = (error) =>
  error && error.message === COPY.signedOut
    ? COPY.signedOut
    : COPY.unavailable;
const STORE_COMMANDS = ["storeCatalogue", "storeCheckout", "storeOrders"];
/*
 * Mounts the store into `root` and returns the handle the page (and tests) drive it with.
 * `bridge` defaults to the isolated preload's object; a test passes its own stand-in.
 */
export function mountStore(root, { bridge = globalThis.easterDesktop } = {}) {
  const store =
    bridge &&
    typeof bridge === "object" &&
    STORE_COMMANDS.every((name) => typeof bridge[name] === "function")
      ? bridge
      : null;
  root.replaceChildren();
  const navbar = el("div", "store-navbar"),
    nav = el("nav", "store-top-nav");
  nav.setAttribute("aria-label", "Store views");
  const browse = anchor("#catalogue", "store-nav"),
    ordersLink = anchor("#orders", "store-nav");
  browse.textContent = "Browse";
  ordersLink.textContent = "Orders";
  nav.append(browse, ordersLink);
  navbar.append(nav);
  const feedback = el("div", "store-feedback");
  feedback.hidden = true;
  feedback.setAttribute("role", "alert");
  const content = el("div", "store-content");
  content.tabIndex = -1;
  const body = el("div", "store-body");
  body.append(feedback, content);
  root.append(navbar, body);

  let products = [],
    orders = [],
    view = "catalogue",
    selected = null,
    message = null,
    catalogueLoading = false,
    ordersLoading = false,
    pressing = null,
    opened = null,
    // One counter per in-flight read, so entering a route never discards the answer another
    // read is already carrying in.
    catalogueRead = 0,
    ordersRead = 0;
  const product = (key) => products.find((p) => p.key === key);
  const nameOf = (key) => product(key)?.name || key;
  function paintFeedback() {
    feedback.replaceChildren();
    feedback.hidden = !message;
    if (message) feedback.append(el("span", "", message));
  }
  function paintNav() {
    for (const [n, target] of [
      [browse, "catalogue"],
      [ordersLink, "orders"],
    ]) {
      if (view === target) n.setAttribute("aria-current", "page");
      else n.removeAttribute("aria-current");
      if (pressing) n.setAttribute("aria-disabled", "true");
      else n.removeAttribute("aria-disabled");
    }
  }
  function paint() {
    paintFeedback();
    paintNav();
    const busy = view === "orders" ? ordersLoading : catalogueLoading;
    content.setAttribute("aria-busy", String(busy || Boolean(pressing)));
    content.replaceChildren();
    if (busy) {
      // No words while a read is in flight: this page has no sentence of its own to print,
      // and the spinner says "still working" without claiming anything.
      content.append(el("span", "store-busy"));
      return;
    }
    if (view === "orders") ordersView();
    else if (view === "detail") detailView();
    else catalogueView();
  }
  // The hash a view is addressed by (see the route table at the top of this module).
  function hashFor(next) {
    if (next === "detail") return "#item/" + encodeURIComponent(selected);
    if (next === "orders") return "#orders";
    return "#catalogue";
  }
  function route() {
    const [name, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
    const key = rest.join("/");
    if (name === "item" && key) return { view: "detail", key: decodeURIComponent(key) };
    if (name === "orders") return { view: "orders" };
    return { view: "catalogue" };
  }
  /*
   * Draws whatever the hash asks for. #cart, #checkout, #receipt/<id> and any other hash are
   * the catalogue's own address once they are read, and an item key this launcher does not
   * have becomes the catalogue too: `replaceState` keeps the address bar and the screen
   * agreeing without adding a history entry the player did not ask for.
   */
  function applyRoute({ focus = true } = {}) {
    const asked = route();
    let next = asked.view;
    if (next === "detail") {
      selected = asked.key;
      if (products.length && !product(selected)) next = "catalogue";
    }
    view = next;
    if (hashFor(view) !== location.hash)
      history.replaceState(null, "", hashFor(view));
    paint();
    if (focus) {
      window.scrollTo(0, 0);
      content.focus({ preventScroll: true });
    }
    if (view === "orders") void loadOrders();
  }
  function card(p) {
    const article = el("article", "store-product");
    const open = anchor("#item/" + encodeURIComponent(p.key), "store-product-open");
    open.append(artwork(p.kind), el("h2", "store-product-name", p.name));
    const footer = el("div", "store-product-footer");
    footer.append(
      el("strong", "store-price", money(p.amountMinor, p.currency)),
      el("p", "store-worth", worth(p)),
      buyControl(p),
    );
    article.append(open, footer);
    const note = openedNote(p);
    if (note) article.append(note);
    return article;
  }
  /*
   * The one buying control. A press asks main for a Stripe page and nothing else: while that
   * is happening this says so, and afterwards openedNote() says where the payment finishes. It
   * never says a payment was received, because main did not see one — the next orders read is
   * what reports what really happened.
   */
  function buyControl(p) {
    const wrap = el("div", "store-product-buy");
    if (pressing === p.key) {
      const status = el("p", "store-status", COPY.opening);
      status.setAttribute("role", "status");
      wrap.append(status);
      return wrap;
    }
    const buy = button(COPY.buy, () => void buyProduct(p.key), "store-button store-primary");
    buy.setAttribute("aria-label", COPY.buy + " " + p.name);
    buy.disabled = Boolean(pressing);
    wrap.append(buy);
    return wrap;
  }
  // What the player reads after the browser has been handed the page. It describes where the
  // payment happens, not that it happened.
  function openedNote(p) {
    if (opened !== p.key) return null;
    const note = el("p", "store-status", COPY.finish);
    note.setAttribute("role", "status");
    return note;
  }
  function catalogueView() {
    if (message || !products.length) return;
    const grid = el("div", "store-grid");
    for (const p of products) grid.append(card(p));
    content.append(grid);
  }
  function detailView() {
    const p = product(selected);
    // applyRoute sends an unknown key to the catalogue; this keeps a stray render honest.
    if (!p) return;
    const back = anchor("#catalogue", "store-back");
    back.textContent = "← Back to store";
    content.append(back);
    const section = el("section", "store-detail"),
      copy = el("div", "store-detail-copy");
    copy.append(
      el("h2", "", p.name),
      el("p", "store-detail-price", money(p.amountMinor, p.currency)),
      el("p", "store-worth", worth(p)),
      buyControl(p),
    );
    const note = openedNote(p);
    if (note) copy.append(note);
    section.append(artwork(p.kind, "store-detail-art"), copy);
    content.append(section);
  }
  function ordersView() {
    content.append(el("h2", "store-orders-heading", COPY.orders));
    if (message) return;
    if (!orders.length) {
      content.append(el("p", "store-empty", COPY.noOrders));
      return;
    }
    const list = el("div", "store-orders");
    for (const o of orders) {
      const article = el("article", "store-order-record"),
        copy = el("div");
      copy.append(
        el("h3", "", nameOf(o.product)),
        el("p", "store-muted", dateOf(o.createdAt)),
      );
      // Only what the server says. An order that is not paid carries no word claiming it is,
      // and one that has not been delivered says nothing about delivery.
      const states = el("p", "store-order-states");
      if (o.paid) states.append(el("span", "store-order-state", COPY.paid));
      if (o.delivered) states.append(el("span", "store-order-state", COPY.delivered));
      if (states.children.length) copy.append(states);
      article.append(copy, el("strong", "store-order-amount", money(o.amountMinor, o.currency)));
      list.append(article);
    }
    content.append(list);
  }
  async function buyProduct(key) {
    if (!store || pressing || !product(key)) return;
    pressing = key;
    message = null;
    paint();
    let openedNow = false;
    try {
      await store.storeCheckout(key);
      openedNow = true;
    } catch (error) {
      message = refusal(error);
    } finally {
      pressing = null;
      if (openedNow) opened = key;
      paint();
    }
  }
  async function loadCatalogue() {
    if (!store) return;
    const token = ++catalogueRead;
    catalogueLoading = true;
    message = null;
    paint();
    try {
      const answer = await store.storeCatalogue();
      if (token !== catalogueRead) return;
      const list = answer && answer.products;
      // A shop that draws no cards and says nothing would look like a bug rather than a shut
      // door, so an answer with nothing for sale is reported as the store being unavailable -
      // the same sentence as any other failure, and no catalogue of this page's own.
      if (!Array.isArray(list) || !list.length) throw Error("no products");
      products = list;
    } catch (error) {
      if (token === catalogueRead) message = refusal(error);
    } finally {
      if (token === catalogueRead) {
        catalogueLoading = false;
        paint();
        // The catalogue is what says whether the item in the address exists.
        if (view === "detail" && products.length && !product(selected))
          applyRoute({ focus: false });
      }
    }
  }
  async function loadOrders() {
    if (!store) return;
    const token = ++ordersRead;
    ordersLoading = true;
    message = null;
    paint();
    try {
      const answer = await store.storeOrders();
      if (token !== ordersRead) return;
      if (!answer || !Array.isArray(answer.orders)) throw Error("unreadable orders");
      orders = answer.orders;
    } catch (error) {
      if (token === ordersRead) {
        orders = [];
        message = refusal(error);
      }
    } finally {
      if (token === ordersRead) {
        ordersLoading = false;
        paint();
      }
    }
  }
  // Back, Forward and a hand-typed hash all arrive here. The first draw is the mount's own, so
  // nothing steals focus until the reader actually navigates.
  window.addEventListener("hashchange", () => applyRoute());
  if (!store) {
    // A build with no store bridge says the one sentence and offers no control at all.
    message = COPY.unavailable;
    applyRoute({ focus: false });
    return { root, reload: async () => {} };
  }
  applyRoute({ focus: false });
  void loadCatalogue();
  return { root, reload: () => loadCatalogue() };
}

// The store page is the only page with a mount point; importing this module elsewhere (as the
// browser tests do, with their own bridge) renders nothing.
//
// A BROWSER IS NOT A SHOP FLOOR. Owen, 2026-10-23: *"hide all store elements when not inside of
// launcher"* - the store lives inside the launcher and is discovered there, so a visitor who
// types or shares this address is sent back to the site instead of being shown a catalogue they
// have no way to buy from. `mode:'desktop'` is the isolated preload's own claim and the same
// test site/desktop.js makes to enter desktop mode, so a published URL is not a way in and a URL
// parameter or stored preference cannot forge one. The CSS in desktop.css hides every
// store-shaped element until `desktop-mode` arrives, which covers the case where this module
// never runs at all (scripting off), and the redirect covers the visitor who lands here.
const mount = document.getElementById("store-root");
const bridge = globalThis.easterDesktop;
if (mount) {
  if (bridge && bridge.mode === "desktop") mountStore(mount);
  else location.replace("../");
}
