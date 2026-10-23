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
 * (window.easterDesktop.storeSnapshot / storeCatalogue / storeCheckout / storeOrders). This module
 * prices nothing, totals nothing and fetches nothing: it has no server address, no credentials and
 * no catalogue of its own, and the dollar amounts it prints are the integers the server sent. A
 * build whose bridge does not carry those commands gets the unavailable line and no buying control
 * at all, rather than a button that does nothing.
 *
 * AN EMPTY PAGE IS NOT THE FIRST THING ON SCREEN ANY MORE. The launcher asks the account service
 * for the catalogue and the player's orders once, at startup, and keeps the answers beside its
 * session cache (desktop/main.cjs, `prefetchStore`); `storeSnapshot()` hands them over with no
 * network call, so opening the store paints the shop at once instead of paying a cold account
 * service's resume behind two reads. The snapshot is then CONFIRMED by the same two reads this
 * page always made, and that confirmation is what decides whether anything is redrawn
 * (`settleCatalogue`, `loadOrders`). While it is in flight the content region keeps
 * `aria-busy="true"` — this page's existing way of saying "still being asked" — so no sentence is
 * invented and a cached number is never presented as a live one. The prices on a card are always
 * the ones the service sent, and the Buy press always goes to the service, which prices the
 * purchase itself.
 *
 * The sentences below are Owen's, fixed in writing, and this page prints no others: every
 * failure is one of the two refusals main chose, never a wording of this page's own.
 *
 * PAYING HAPPENS IN THE LAUNCHER. Since 2026-10-23 the press answers `outcome` as well as the
 * session it opened — `paid`, `cancelled` or `closed` — because main now loads Stripe's Checkout
 * page into a modal window of its own instead of handing it to the player's browser, and it reads
 * the success and cancel fragments Stripe navigates to as the payment ending. Three consequences
 * live in this module: `paid` opens the launcher's own "Payment Successful" dialog, `cancelled`
 * says nothing at all, and `closed` keeps the sentence that says where the payment happens. None
 * of the three writes an order: the row is the server's, and the orders read is what shows it.
 */
import { productArt } from "./art.mjs";

const COPY = {
  buy: "Buy",
  // While the Stripe window is being opened.
  opening: "Pending\u2026",
  // After a payment window the player closed by hand. The word changed with the flow (Owen,
  // 2026-10-23): the payment finishes in the launcher's own window, not in a browser.
  finish:
    "Finish the payment in the Stripe window. Your Sterling arrives the next time you join.",
  // Owen's heading, in his words, for a payment the launcher saw finish. The body is his too.
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
const artwork = (product, cls = "store-art") => {
  const { kind, creditPence } = product;
  const n = el("div", cls);
  // Local vector emblems stay crisp in the catalogue and detail view.
  n.dataset.kind = kind;
  n.setAttribute("aria-hidden", "true");
  const emblem = kind === "donation" ? "donation"
    : creditPence >= 100000 ? "chest"
    : creditPence >= 10000 ? "pouch" : "coins";
  n.dataset.emblem = emblem;
  n.innerHTML = productArt(emblem);
  return n;
};
const money = (amountMinor, currency) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    amountMinor / 100,
  );
// Purchases go to the bank; every currency pack shares Owen's deposit instructions.
const worth = (p) =>
  p.creditPence > 0
    ? "All in-game currency is deposited into your in-game bank account upon purchase, and can only be withdrawn in-game."
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
// Two shapes of rows are the same rows: the frozen wire shape, so a confirmation that agrees with
// the snapshot can be recognised without a second reading of it.
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
    // The rows on screen that came from the launcher's startup snapshot and have not been confirmed
    // yet. They are what makes the page paint without waiting, and they are the flag this page
    // treats as "still being asked" — the content region keeps `aria-busy` while either is true,
    // and the busy ring is never drawn over rows the player is already reading.
    snapshotProducts = false,
    snapshotOrders = false,
    // True only while the mount is asking the launcher for its snapshot (a local IPC round trip):
    // the page draws nothing for that instant rather than a busy ring it may be about to replace
    // with the shop, and paints the ring the moment it knows no snapshot is coming.
    hydrating = false,
    // Whether the route change being applied arrives with the orders already read — see
    // dismissPaymentSuccessful and applyRoute.
    ordersReadForEntry = false,
    pressing = null,
    opened = null,
    // The launcher's "Payment Successful" dialog: the element while it is open. Nothing else is
    // remembered about it, because closing it goes to the player's orders rather than back to
    // the button they pressed.
    modal = null,
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
    // A view whose rows came from the snapshot is still being confirmed: the content stays exactly
    // as it is, `aria-busy` says it is not final yet, and no ring is drawn over readable rows. With
    // nothing to show the page says nothing and draws the ring, as it always did.
    const fromSnapshot = view === "orders" ? snapshotOrders : snapshotProducts;
    const busy = view === "orders" ? ordersLoading : catalogueLoading;
    content.setAttribute(
      "aria-busy",
      String(busy || Boolean(pressing) || fromSnapshot),
    );
    content.replaceChildren();
    if (busy && !fromSnapshot) {
      // No words while a read is in flight: this page has no sentence of its own to print,
      // and the spinner says "still working" without claiming anything. While the snapshot is
      // being read there is nothing to draw yet and nothing yet to claim, so the region is left
      // empty for that instant rather than flashing a ring.
      if (!hydrating) content.append(el("span", "store-busy"));
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
    // One route change can carry a read the caller has already made (see dismissPaymentSuccessful):
    // it is consumed here, so the next entry into the orders view reads for itself again.
    const entryRead = ordersReadForEntry;
    ordersReadForEntry = false;
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
    // Entering the orders view starts its read, unless the entry that is being applied has already
    // made it: the payment dialog's dismissal reads the orders itself (so the row the player just
    // paid for is on screen rather than a stale list) and then changes the hash, and without this
    // the same entry asked the service twice for one dismissal.
    if (view === "orders" && !entryRead) void loadOrders();
  }
  /*
   * One row of Sol's list: the coin medallion, the name (which is the link to the product's own
   * view), what the product is worth in the player's bank, and the price with the one control
   * beside it.
   * The medallion stands outside the link, as it did in Sol's row: the click target is the name,
   * and the drawing is decoration that takes no focus and says nothing to a screen reader.
   */
  function card(p) {
    const article = el("article", "store-product");
    const open = anchor("#item/" + encodeURIComponent(p.key), "store-product-open");
    open.append(el("h2", "store-product-name", p.name));
    const footer = el("div", "store-product-footer");
    footer.append(
      el("strong", "store-price", money(p.amountMinor, p.currency)),
      buyControl(p),
    );
    article.append(artwork(p), open, el("p", "store-worth", worth(p)), footer);
    const note = openedNote(p);
    if (note) article.append(note);
    return article;
  }
  /*
   * The one buying control. A press asks main for a Stripe page and nothing else: while that is
   * happening the row says Pending... and nothing more (Owen, 2026-10-23: the old "Opening
   * Stripe..." described plumbing, and what a player wants to know is that their press is in
   * flight), and afterwards openedNote() says where the payment finishes. It
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
    // The payment dialog hands focus back to THIS control when it closes, so the row it left is
    // found by the key the server sent rather than by a name this page would have to guess at.
    buy.dataset.buy = p.key;
    buy.disabled = Boolean(pressing);
    wrap.append(buy);
    return wrap;
  }
  // What the player reads after a payment window they closed by hand. It describes where the
  // payment happens, not that it happened.
  function openedNote(p) {
    if (opened !== p.key) return null;
    const note = el("p", "store-status", COPY.finish);
    note.setAttribute("role", "status");
    return note;
  }
  /*
   * Owen's dialog, 2026-10-23: *"the launcher needs a 'Payment Successful' modal for when the
   * stripe transaction succeeds"*. His heading, his body sentence, and one control - no
   * confetti, no exclamation mark, no second sentence, because the order's own row is what says
   * what was bought.
   *
   * It lives outside `content` on purpose: every paint replaces that region, and a dialog that a
   * route change can delete underneath the player is not a dialog. It is announced as a modal
   * dialog (role, aria-modal, labelled by its own heading), focus moves into it as it opens, and
   * both Escape and Enter close it, wherever the focus happens to be.
   */
  function openPaymentSuccessful() {
    if (modal) return;
    modal = el("div", "store-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "store-payment-heading");
    const panel = el("div", "store-modal-panel"),
      heading = el("h2", "store-modal-heading", COPY.successful),
      close = button(COPY.close, () => dismissPaymentSuccessful(), "store-button store-primary store-modal-close");
    heading.id = "store-payment-heading";
    panel.append(heading, el("p", "store-modal-body", COPY.orderRecorded), close);
    modal.append(panel);
    root.append(modal);
    document.addEventListener("keydown", paymentKey, true);
    close.focus();
  }
  function paymentKey(event) {
    if (event.key !== "Escape" && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    dismissPaymentSuccessful();
  }
  /*
   * Closing it lands the player on their orders, because that is the thing they just changed: the
   * row the server recorded is on screen, with the amount it charged and whatever state the
   * server reports. The alternative - giving focus back to the Buy control - would satisfy a
   * focus rule and hide the receipt, and this page's whole discipline is that the order is the
   * server's fact rather than a claim the page makes. The ticket's two clauses could not both
   * hold; this is the one worth keeping.
   *
   * The route change repaints and the read is what fills it, so the order is fetched first and
   * the view is painted when it arrives rather than showing a stale list for a moment.
   */
  function dismissPaymentSuccessful() {
    if (!modal) return;
    document.removeEventListener("keydown", paymentKey, true);
    modal.remove();
    modal = null;
    // The read is this dismissal's own, made before the view is painted, so the row the service
    // has just recorded is what the player lands on. The route change it triggers must not make a
    // second one: `ordersReadForEntry` tells applyRoute that this entry has already read, and it
    // is cleared by that very route change. The hash that is already the orders route changes
    // nothing and fires nothing, so there is no entry to tell and no flag to leave behind.
    if (location.hash !== "#orders") {
      ordersReadForEntry = true;
      location.hash = "#orders";
    }
    void loadOrders({ repaint: true });
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
    section.append(artwork(p, "store-art store-detail-art"), copy);
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
  /*
   * One press, and then the three answers main can give about what happened in its own window
   * (doc/launcher-store.md, "Paying"):
   *
   *   paid       the success fragment arrived: the launcher's "Payment Successful" dialog, and
   *              the orders read that dialog dismisses into.
   *   cancelled  the cancel fragment arrived: nothing at all. The store is left exactly as it was
   *              before the press, down to the note a previous press may have left.
   *   closed     the window ended any other way: no dialog and no claim, and the sentence that
   *              says where the payment finishes, which is the only thing this page says about a
   *              press it did not see finish. An answer with no `outcome` (a bridge from an older
   *              build) is read this way too: it opened a window and cannot claim anything.
   */
  async function buyProduct(key) {
    if (!store || pressing || !product(key)) return;
    const before = opened;
    pressing = key;
    message = null;
    paint();
    let outcome = null;
    try {
      const answer = await store.storeCheckout(key);
      outcome = answer && answer.outcome;
    } catch (error) {
      message = refusal(error);
    }
    pressing = null;
    if (!message) {
      if (outcome === "cancelled") opened = before;
      else if (outcome !== "paid") opened = key;
      else opened = null;
    }
    paint();
    if (!message && outcome === "paid") openPaymentSuccessful();
  }
  /*
   * THE STORE, ALREADY IN HAND. The launcher fetched the catalogue and the orders once, at startup,
   * and `storeSnapshot()` hands them over with no network call at all — so this paints the shop
   * before anything has been asked of the account service, which is the whole point of the
   * snapshot (a cold service pays an 18-22 s resume behind two reads). Everything it paints is
   * marked `snapshotProducts` / `snapshotOrders`, and the two reads below are what confirm it.
   *
   * It is read ONCE per mount, and only when there is nothing on screen. A bridge from a build
   * without the command, a null answer, an unreadable one or one with no products is today's cold
   * store: the page waits for the live answer exactly as it did before this existed.
   */
  async function readSnapshot() {
    if (typeof store.storeSnapshot !== "function") return null;
    let answer = null;
    try {
      answer = await store.storeSnapshot();
    } catch {
      return null;
    }
    const list = answer && answer.products;
    if (!Array.isArray(list) || !list.length) return null;
    return {
      products: list,
      orders: Array.isArray(answer.orders) ? answer.orders : null,
    };
  }
  /*
   * The first paint, then the confirmation.
   *
   * The live read is started FIRST and the snapshot is asked for at the same moment, so the page
   * never waits on the snapshot to begin talking to the service - and the two reads cannot take
   * turns clearing this page's one refusal sentence, which is what they did at mount before the
   * snapshot existed. Whichever answers first is what the player sees; a snapshot that arrives
   * after the live answer has already settled is simply not used, because a live answer is newer
   * than a file by definition.
   */
  async function hydrate() {
    hydrating = true;
    const live = loadCatalogue();
    const snapshot = await readSnapshot();
    applySnapshot(snapshot);
    hydrating = false;
    // Nothing came from a snapshot: draw what this page always drew - the busy ring, or the answer
    // itself if the live read has already landed.
    if (!snapshotProducts && !snapshotOrders) paint();
    void live;
  }
  /*
   * The snapshot, painted only where it is still the freshest thing there is: a half whose live
   * read is still in flight and whose rows are not on screen yet. The snapshot can name the product
   * in the address where an empty page could not, so the #item/<key> route is applied again with
   * the catalogue in hand (a key it does not have still lands on #catalogue, by applyRoute's own
   * rule).
   */
  function applySnapshot(snapshot) {
    if (!snapshot || !catalogueLoading || products.length) return;
    const list = snapshot.products;
    if (!Array.isArray(list) || !list.length) return;
    products = list;
    snapshotProducts = true;
    // The orders view was entered by the read its route started at mount; its rows are taken from
    // the snapshot only while that read is still asking.
    if (ordersLoading && Array.isArray(snapshot.orders) && snapshot.orders.length) {
      orders = snapshot.orders;
      snapshotOrders = true;
    }
    if (view === "detail") applyRoute({ focus: false });
    else paint();
  }
  async function loadCatalogue() {
    if (!store) return;
    const token = ++catalogueRead;
    catalogueLoading = true;
    message = null;
    // The busy ring is what paint() draws when there is nothing to show; rows from the snapshot
    // stay on screen while this read confirms them.
    if (!snapshotProducts) paint();
    let answered = null;
    try {
      const answer = await store.storeCatalogue();
      if (token !== catalogueRead) return;
      const list = answer && answer.products;
      // A shop that draws no cards and says nothing would look like a bug rather than a shut
      // door, so an answer with nothing for sale is reported as the store being unavailable -
      // the same sentence as any other failure, and no catalogue of this page's own.
      if (!Array.isArray(list) || !list.length) throw Error("no products");
      answered = list;
    } catch (error) {
      if (token === catalogueRead) message = refusal(error);
    } finally {
      if (token === catalogueRead) {
        catalogueLoading = false;
        settleCatalogue(answered);
      }
    }
  }
  /*
   * The catalogue read has settled, and it may have been a CONFIRMATION of the snapshot. A refusal
   * is painted even over rows that came from the cache: a shop whose answer has just failed is not
   * one this page can stand behind, whatever it kept, and the sentence it prints is the same one it
   * printed before there was a snapshot. An answer that agrees with the rows already on screen
   * redraws nothing — the player's place, focus and reading stay exactly as they were — and only
   * `aria-busy` stops claiming the shop is being confirmed. A different answer is painted at once:
   * prices, products and their order are the service's, not this page's.
   */
  function settleCatalogue(answered) {
    const before = products;
    const fromSnapshot = snapshotProducts;
    snapshotProducts = false;
    if (answered) products = answered;
    const same = fromSnapshot && answered && !message && sameRows(before, answered);
    if (same) content.setAttribute("aria-busy", String(Boolean(pressing)));
    else paint();
    // The catalogue is what says whether the item in the address exists.
    if (view === "detail" && products.length && !product(selected))
      applyRoute({ focus: false });
  }
  /*
   * `repaint: false` is the payment dialog's own read (dismissPaymentSuccessful). It keeps the
   * rows the server answers with and says nothing about a failure: the player has not been
   * promised a list, and a refusal painted over the view they are standing on would be a second
   * answer to a question they did not ask. The Orders view is still entered by its own read, so a
   * failed silent read costs nothing but the freshness of a list nobody is looking at.
   */
  async function loadOrders({ repaint = true } = {}) {
    if (!store) return;
    const token = ++ordersRead;
    const before = orders;
    if (repaint) {
      ordersLoading = true;
      message = null;
      if (!snapshotOrders) paint();
    }
    let answered = null;
    try {
      const answer = await store.storeOrders();
      if (token !== ordersRead) return;
      if (!answer || !Array.isArray(answer.orders)) throw Error("unreadable orders");
      answered = answer.orders;
    } catch (error) {
      if (token !== ordersRead) return;
      if (repaint) message = refusal(error);
    } finally {
      if (token === ordersRead) {
        const fromSnapshot = snapshotOrders;
        snapshotOrders = false;
        if (answered) orders = answered;
        else if (repaint && message) orders = [];
        if (repaint) {
          ordersLoading = false;
          // The same rule as the catalogue's: an answer that agrees with the rows already on
          // screen redraws nothing and only stops claiming it is being confirmed.
          if (
            fromSnapshot &&
            answered &&
            !message &&
            sameRows(before, answered)
          )
            content.setAttribute("aria-busy", String(Boolean(pressing)));
          else paint();
        }
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
  // The snapshot first (if this launcher kept one), then the confirmation of it. `reload` is the
  // live read and nothing else: a page asked to reload must go to the service, not to a file.
  void hydrate();
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
  if (bridge && bridge.mode === "desktop") {
    mountStore(mount);
    // The page's skip link is Sol's. It has to land inside the store rather than in the address
    // bar: #store-root is not one of this page's routes, so letting the fragment through would
    // send the reader to the catalogue and scroll the page to the top on the way. The link
    // focuses the region a route change focuses, and leaves the route alone. (Without a bridge the
    // page is redirected home before any of this matters.)
    const skip = document.querySelector(".store-skip"),
      region = mount.querySelector(".store-content");
    if (skip && region)
      skip.addEventListener("click", (event) => {
        event.preventDefault();
        region.focus();
      });
  } else location.replace("../");
}
