# The Community store — the real store, inside the launcher

The store sells five real products for real USD, through Stripe's hosted Checkout page, and it
lives only inside the launcher — the payment included. `site/store/` is the page,
`desktop/store.cjs` is the half that shapes what the account service sends,
`desktop/main.cjs`'s `openStripeCheckout()` is the modal window the card form is filled in, and the
three commands on `window.easterDesktop` are the only way the page can ask for anything.

**Payments moved inside the launcher on 2026-10-23.** Owen, after paying with a test card from his
own Windows launcher: *"It opened stripe in my web browser, but it should open in an embedded view
within the launcher instead, and when it succeeds it should not redirect to the website or
anything, all functionality should maintain within the launcher. And also the launcher needs a
'Payment Successful' modal for when the stripe transaction succeeds."* Before that commit
`storeCheckout()` handed the Checkout URL to `shell.openExternal` and Stripe's own redirect took
the player to the public site. See "Paying, inside the launcher" below for what replaced it.

This document replaces the mock-commerce record it used to be. The mock — nine example products,
a five-category catalogue, a cart with quantities, a quote, a consent checkbox, a "Place test
order" button and a demo receipt — is **deleted**, not hidden: `site/store/catalogue.mjs` and
`site/store/mock-api.mjs` no longer exist, and `tests/store-games-browser.mjs` now asserts that
they stay gone. `doc/store-testing-rollout.md` records the mock rollout as history, not as description.

## The products

Exactly what the server sends, in the server's order, and nothing priced in `site/`:

| key | name | price | what a card says about it |
| --- | --- | --- | --- |
| `sterling-10` | 10 Sterling | $1.49 | 10 Sterling in your bank |
| `sterling-100` | 100 Sterling | $6.95 | 100 Sterling in your bank |
| `sterling-1000` | 1000 Sterling | $29.99 | 1,000 Sterling in your bank |
| `donation-5` | Keep the lights on | $5.00 | A one-off donation. |

The names and USD amounts in that table are the server's, quoted here as the record of what is
sold; nothing in `site/` contains them. A card's second line is decided by `creditPence` (**what
a pack is worth in the game**, from the server): above zero the card says how much Sterling
arrives, and a product that credits nothing is described as a donation.

**Where bought currency lands, and why it matters to the reader:** a purchase credits the
player's **bank** — the uncapped in-game vault — and never the spendable wallet, because the
wallet is capped for gameplay and a purchase must not be truncated by a cap that exists for a
different reason (Owen, 2026-10-23: *"when adding in-game currency to a player, do not add to
their wallet add to their bank account"*). That is why the card says "… in your bank" and not
"… in the game": the bank is a real thing the player sees, so naming it is the honest version.
The fulfilment half is the cloud's; this half only prints the number the server sends. That is why the
`kind` word the server sends is carried but never parsed for meaning — two halves cannot disagree
about what a product is worth if only one of them says what it is worth.

## The page

`site/store/index.html` owns the shell (the shared site header and its nav, the `h1` "The
Community store", the footer) and links `store.css` from its own head. `store.mjs` exports
`mountStore(root, {bridge})` and renders everything inside `#store-root`. Views are hash routes:

| Route | View |
| --- | --- |
| `#catalogue` | Every product the server sells. An empty, unknown or removed hash lands here |
| `#item/<key>` | One product on its own; a key this launcher does not have lands on `#catalogue` |
| `#orders` | The player's own orders, read fresh every time the view is entered |

`#cart`, `#checkout` and `#receipt/<id>` are **gone**. Buying is one product at a time from its
own card: there is no cart, no quantity and no basket total, because the server prices one line
item of one and a total computed here would be a second source of pricing truth. A stale link to
one of the removed routes is redirected in place with `history.replaceState`, so the address bar
never names a view that is not on screen.

The page is reached from the launcher's own nav, and from the website's. The store is shared by
both surfaces again: Owen, 2026-10-29, *"yes, return the store to the website"*, after the
Minecraft API approval of 2026-10-28 ended the review it had been hidden for since 2026-10-27
(`doc/web-accounts-store.md` keeps that history). Every page of the site carries its own `Store`
entry in static markup, resolved against the site root; `site/desktop.js` appends its own only on
a page that has none, which is the safety net and never a second entry; and `site/desktop.css`
paints the page and the entry in both modes. `site/store/store.mjs` mounts on
`window.easterDesktop || webAccount` — the launcher's isolated preload, or the website's own
bounded account transport — so the views are one implementation and only the transport differs.

**A browser is a shop floor again**, and both browser suites prove it in both modes. The rules are
asserted **where they live**, because a design pass over a stale base dropped them once (commit
5e5a2fc): every page's own markup is asserted to carry exactly one `class="store-entry"` pointing
at the site root — including a wiki guide three directories deep, which is the page a relative
literal gets wrong — the mount's transport line (`globalThis.easterDesktop || webAccount`) is
asserted in `site/store/store.mjs`'s source, and `site/web.js`'s fragment forwarding is asserted to
set a HASH and nothing else. In a browser, `/store/` renders the store with no Easter Company
session asking the player to sign in, and the signed-in journey in
`tests/web-accounts-browser.mjs` drives the catalogue, Orders and a Buy press into Stripe.

## The look: Sol's pass, applied to the wired page

Owen commissioned a separate front-end pass (Sol, `origin/work` 26660a2, "Replace mock storefront
with five-product shop"). It was written before the store had any behaviour, so it could not be
merged as it stood: it hard-coded the products and their USD prices in
`site/store/catalogue.mjs`, kept a client-side "selection for review" flow with a `#cart` route and
an Orders section with no service behind them, and — because it branched before 5e5a2fc — it
dropped the mount gate and the `store-entry` class. The design was applied to the wired page
instead. Nothing below changes what the store can do.

**Kept from Sol:** the dark ground (`#0d2029` under a teal radial), his palette (`--store-ink`
`#edf1e9`, `--store-muted` `#a8b9b4`, `--store-gold` `#e4c486`, panel `#11252d`), the gold
uppercase overline, his tight-tracked heading scale (weight 550, `-.035em`; the h1 takes his size
curve but keeps a **34px floor** so the page title never falls under the site's page-heading
scale), the 960px measure, the **single-column list of rows** instead of the old three-across card
grid (medallion, then the name and what it is worth, then the price and the one control), the
circular **coin medallion** with its gold ring, inset ring, dashed inner ring and teal gradient, the
gold **44px buying control**, the top nav as muted words on a rule with the current one gold and
underlined, the **skip link**, the reduced-motion block, and his footer scale. The medallions
themselves are still the page's own local vectors (`site/store/art.mjs`), re-cut for a circular
95px box: a stack of coins for a pack and a banner for anything the server calls a donation.

**Dropped, because the wired page has no such element:**

| Sol's element | Why it is not here |
| --- | --- |
| Selection, `Review` step, `#cart`, `#checkout`, `.store-review` panel | Buying is one product at a time from its own row; there is no cart, so there is nothing to review. `#cart` and `#checkout` are gone as routes and land on `#catalogue` |
| Receipt view (`#receipt/<id>`) | Receipts are the payment service's; the orders read is what reports what happened |
| An Orders section with no service behind it | This page's orders are the server's own records, with `Paid` and `In the game` printed only when the server says so |
| The product description and the paragraph under the title (`store-lead`) | The server sends no description, and that paragraph was new player-facing copy. The card's second line is the worth line from `creditPence` - `N Sterling in your bank`, or `A one-off donation.` - taking the slot his description occupied |
| His per-product artwork variants (`data-product="…"`) | This page has no catalogue to key anything on. The medallion variant is keyed on the `kind` the server sends, and his two donation variants are folded into one |
| `All prices in USD` in the footer | The currency comes from the server; a static USD claim in the shell could be false. The footer keeps `Numquam Succumbe` |
| `#store-announcement` live region and `.store-sr-only`'s announcements | The page announces nothing the route change does not already say, and every word of it would be copy this page does not own |

One interaction detail moved with the layout and nothing else did: the product **name** is the link
to `#item/<key>`, and the medallion is decoration (`aria-hidden`), as it was in Sol's row. Before,
the medallion and the name were one link target. The three bridge commands, one product per card,
`Buy` handing the player's own browser the Stripe page, the orders read and every frozen sentence
are untouched.

## The bridge

Three commands, added in `desktop/preload.cjs` and implemented in `desktop/main.cjs` through the
account client (`desktop/accounts.cjs`). The page never fetches: it has no server address, no
token and no catalogue.

| Command | Route | Answer |
| --- | --- | --- |
| `storeSnapshot()` | none — answered from the launcher's own memory | `{writtenAt, products, orders}` from the startup fetch described below, or `null`; `orders` is `null` unless the snapshot was written for this account |
| `storeCatalogue()` | `GET /v2/accounts/store/catalogue` | `{products:[{key,name,amountMinor,currency,kind,creditPence}]}`, in the server's order |
| `storeCheckout(productKey)` | `POST /v2/accounts/checkout` with `{product}` | `{outcome, url, sessionId, product}`; **main** opens `url` in a modal window of its own, waits for the payment to finish there, and answers with `outcome: 'paid' \| 'cancelled' \| 'closed'` |
| `storeOrders()` | `GET /v2/accounts/store/orders` | `{orders:[{sessionId,product,amountMinor,currency,paid,creditPence,delivered,createdAt}]}` |

The renderer's argument is called `productKey`; on the wire the body is `{product}` because that
is what the deployed route reads (`easter-co-cloud/api/checkout_routes.py`, "The request body
names a product by one of the stable keys"). Nothing else travels: no price, no amount, no price
id, no quantity — the server resolves the key to its own Stripe Price id, so this launcher cannot
name an amount.

`storeCheckout` never hands a URL to the operating system. The address is checked by
`stripeCheckoutURL()` in `desktop/security.cjs` before anything opens — HTTPS, no credentials, and
the host must be `checkout.stripe.com` — so a service answer pointing anywhere else is refused
with the store's one sentence and no window opens. The same rule is applied twice: in
`desktop/store.cjs` where the answer is shaped, and again in `desktop/main.cjs` where the window is
made, because a service answer is the far side of a network either way.

None of the three reads is in `REACHABLE_BEFORE_STARTUP`: the two live ones need a signed-in
session and none of them is needed to start the launcher. `storeSnapshot()` asks nothing of
anybody — it answers what this process already holds — and it is not in that list either: it is
only useful to a page that is open, and the store is reached by navigation after the gate.

### Every failure is a refusal, never a silent empty list

Two sentences, both Owen's, and the page prints nothing else:

| Situation | What the player reads |
| --- | --- |
| No Company session, or a 401 `invalid_session` | **Sign in to buy.** |
| Service unreachable, 404 (route not deployed yet), 5xx, `unknown_product`, `checkout_not_configured`, `checkout_unavailable`, an answer this half cannot read, a URL that will not open | **The store is unavailable right now.** |

`desktop/store.cjs` maps every failure onto those two (`refusal()`), and `store.mjs` prints a
refusal **only** when it is one of them: a message from somewhere else (the startup gate's own
refusal, a transport fault, a bridge from another build) is reported as "The store is unavailable
right now." rather than printed, so the page can never become a second author of launcher copy.

An answer that cannot be drawn is refused, not half-rendered: a catalogue with no products, a
duplicated key, a product with no name, a currency that is not three capitals, a non-integer
amount or credit, an order with an unparseable `createdAt` or a `paid`/`delivered` that is not a
real boolean. `paid` and `delivered` are read as `=== true`, so this launcher never claims "Paid"
or "In the game" on evidence it did not receive.

### Paying, inside the launcher

`openStripeCheckout()` (`desktop/main.cjs`) loads the Checkout URL into a `BrowserWindow` that
belongs to the launcher:

| Option | Value |
| --- | --- |
| `parent` | the launcher window — without it `modal` means nothing, so a press with no window is refused |
| `modal` | `true` (the launcher window takes no input while it is up) |
| `width` / `height` | `STRIPE_WINDOW_WIDTH` 480 × `STRIPE_WINDOW_HEIGHT` 760, each capped at the launcher window's own bounds so the dialog never hangs off a small window |
| `autoHideMenuBar`, `removeMenu()` | `true`, then the menu is removed — no menu bar, and none to reveal with Alt |
| `isDevToolsOpened()` after `openDevTools()` | `false` — `devTools: false` is asserted by its behaviour, not by the option being present |
| `minimizable`, `maximizable`, `fullscreenable` | `false` |
| `show` | `false`, shown on `ready-to-show` so nothing paints a white frame first |
| `webPreferences` | `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, `devTools: false`, `spellcheck: false`, **no preload**, and its own in-memory session (`partition: 'stripe-checkout'`) so the launcher's cookies and storage are not Stripe's to read |

The window is given exactly one starting address (`stripeCheckoutURL`, above) and then decides
every navigation **before it loads**:

- a navigation whose fragment starts `#store-paid` means the payment finished — the account
  service sets `https://easter-co-smp.github.io/#store-paid/{CHECKOUT_SESSION_ID}` as the Stripe
  session's `success_url`;
- a navigation whose fragment starts `#store-cancelled` means the player backed out — the
  `cancel_url` is `https://easter-co-smp.github.io/#store-cancelled`;
- in both cases the navigation is cancelled (`preventDefault` on `will-navigate` and
  `will-redirect`), the window is destroyed, and the launcher window is what the player comes
  back to. The website is never fetched and no tab opens anywhere;
- a navigation staying on `https://checkout.stripe.com` is allowed, so Stripe's own page keeps
  working; **any other host is cancelled and nothing else happens**;
- a same-document hash change loads nothing, so it cannot leave the launcher, and it is still read
  as one of the two signals (`did-navigate-in-page`), because a success URL on Stripe's own host
  would arrive only there;
- `setWindowOpenHandler` denies every new window and the session denies every permission, so
  nothing inside a payment can open anything.

`storeCheckout()`'s answer says what happened, and only those three things:

| `outcome` | When | What the page does |
| --- | --- | --- |
| `'paid'` | the `#store-paid` fragment arrived | opens the **Payment Successful** dialog |
| `'cancelled'` | the `#store-cancelled` fragment arrived | nothing at all |
| `'closed'` | anything else ended the window — the player closed it, the window was closed for them, the load failed | the sentence that says where the payment finishes |

A window closed any other way is **not** a payment: `'closed'` claims nothing, shows no dialog and
writes nothing. An answer with no `outcome` at all (a bridge from an older build) is read the same
way.

### The Payment Successful dialog

Owen's surface, in his words: heading **Payment Successful**, body **Your order is recorded.**
and one control, **Close** — no confetti, no exclamation mark, no second sentence. It is drawn in
`site/store/store.mjs` outside the content region (a route change must not delete a dialog
underneath the player) and styled by `.store-modal` in `site/store/store.css`.

- It is a modal dialog in markup as well as in intent: `role="dialog"`, `aria-modal="true"`,
  `aria-labelledby` pointing at its own heading.
- Focus moves into it when it opens (the Close control), and returns to the **Buy** control of the
  product just bought when it closes.
- **Escape** and **Enter** close it as well as the button.
- Close dismisses it and re-reads the orders, so the row on screen is the account service's own
  and never one this page invented from the fragment Stripe navigated to. The service's answer is
  the authority: a player whose payment the service has not recorded yet sees no row, and one
  whose payment it has recorded sees the row it answered with.
- A **cancelled** payment says nothing at all: no dialog, no sentence, and the store is exactly as
  it was before the press.

**What the dialog does not claim:** it says the order is *recorded*, which is what the success
fragment means, and it names no product, no amount and no delivery. The order's row — `Paid`, `In
the game`, the amount — is printed only from the account service's own answer.

## Opening the store instantly: the snapshot (2026-10-23)

Owen, 2026-10-23: *"The store pages should perhaps even pre-render the store page, and cache client
side on launcher start-up so opening the store is instant."*

It was not instant. The page mounted, asked this process for the catalogue and (entering `#orders`)
for the player's orders, and painted when the answers arrived — and against a cold account service
that round trip is the **18–22 s Aurora resume** behind two reads (`STORE_RETRY_BUDGET_MS`, "How
long the store waits"). The launcher now asks for both answers **once, early**, and keeps them.

**When.** After the startup gate has settled, and off the critical path of anything the player is
waiting for: `prefetchStore()` in `desktop/main.cjs` is started with `void` from the gate's own
settle, from each sign-in that settles, and from the six-hourly account renewal. It never touches
`startupReady`, `phase`, `progress` or the broadcast state, and nothing awaits it. A store page that
is opened within seconds of startup may therefore find the launcher's own two reads still in flight;
that is the cost of it being free everywhere else.

**Where.** `store-snapshot.json` in the launcher's data directory, beside `session-cache.json`, so it
is the session cache's sibling in shape and in discipline: a schema `version`, a `writtenAt`, a
`accountId`, and the two frozen wire answers. It is written by the main process, never by the page:
the renderer holds no token and the file holds none either — `SNAPSHOT_FIELDS` in
`desktop/store.cjs` is the whole whitelist, and `tests/desktop/store-snapshot.test.cjs` proves that
no token, refresh token, address, email or Stripe id can reach it.

```
{ "version": 1,
  "writtenAt": "2026-10-23T12:00:00.000Z",   // the moment the service sent these answers
  "accountId": "7",                          // whose orders these are; null = catalogue only
  "catalogue": { "products": [ … the frozen product shape, in the server's order … ] },
  "orders":    { "orders":   [ … the frozen order shape, as the service listed them … ] } }
```

Both blocks are built by the **same two functions** that shape a live answer (`catalogue()` and
`orders()`), on the way in and on the way out, so a file can never hold a product or an order this
half would refuse from the service.

**What the page does with it.** `mountStore` asks `storeSnapshot()` first and paints it at once, then
**confirms** it with the two reads it always made (`hydrate`, `loadCatalogue`, `loadOrders`,
`settleCatalogue`):

- While a snapshot's rows are on screen and their confirming read is in flight, the content region
  keeps `aria-busy="true"` — the page's existing way of saying "still being asked" — and **no busy
  ring is drawn over rows the player can read**. No sentence is invented for the occasion: the
  store's visible vocabulary is Owen's and this adds nothing to it.
- An answer that **agrees** with what is already drawn repaints nothing at all: the rows keep their
  identity, so the player's place, focus and reading are undisturbed.
- An answer that **differs** is painted the moment it arrives. Prices, products and their order are
  the service's, not this page's.
- A confirming read that **fails** paints the one sentence the page always painted ("The store is
  unavailable right now."). A shop whose answer has just failed is not one this page can stand
  behind, whatever it kept.
- A bridge with no `storeSnapshot`, a `null` answer, or a snapshot with no products is **today's
  cold store**: the ring, then the service's answer.

**It prices nothing.** The Buy press still goes to the service, which resolves the product key
against its own Stripe configuration and its own price, so a stale snapshot can put an out-of-date
number on a card and can never change what is charged. An order row is still only ever what the
orders read answers with: `paid` and `delivered` are the server's booleans (`=== true`), and a
snapshot with no orders publishes `orders: null` rather than an empty list — the orders view then
waits for the service instead of printing "No orders yet." from a file.

**The age bound: `SNAPSHOT_MAX_AGE_MS` = 24 hours** (`desktop/store.cjs`, named and argued there).
The catalogue is upstream of money: every card prints a price a player will compare against a
charge, so a snapshot older than one Company-session lifetime is **not used at all** — it is
deleted and the store waits exactly as it did before this existed. One session lifetime is the
right unit because the launcher's own session lives 24 h and `renewCompany` re-proves it every six
hours, re-reading the shop at the same moment; past it, a snapshot would describe a shop nobody has
asked about in a day. The bound is asked twice — when the file is read at startup and again when the
answer is published, because a launcher left open for a day still holds a copy in memory that the
file would no longer be read as.

**On sign-out and on account switch the orders go and the catalogue stays.** The catalogue is what
the server sells, not what any player bought, so it is kept for whoever signs in next; the orders
are the account's own and are rewritten out of the file — so a second account can never read the
first account's purchases. Three places do it: `forgetStoreOrders()` from the two sign-out paths,
the account-change belt in `notify()` (the same place the session cache drops another account's
answer), and `readStoreSnapshot()`, which rewrites a file it finds written for somebody else. A
signed-out player's snapshot is a catalogue only, never orders.

**A service that cannot be reached at startup is not an error the player sees**: it is an empty
snapshot, no sentence, and no change to the hero. The store paints its one sentence when it is
opened, exactly as it did before.

**What it costs now (measured 2026-10-23, in the launcher's own window, this machine).** Pressing
Store to the first product card on screen, with the account service's store reads delayed by 2 s to
stand in for a cold Aurora resume:

| | first card on screen |
| --- | --- |
| warm — a snapshot on disk | **48 ms** (median of 5; 44.6–58.2 ms), with the service's own answers still 2 s away |
| cold — no snapshot, today's store | **2329 ms** (median of 3), i.e. the service's delay plus the page's own mount |

The warm figure is what the snapshot removes: it is a local IPC round trip, so it does not grow with
the resume behind it. Against the **18–22 s** measured for that resume, a cold open is unchanged
(twenty seconds of it is the service's own budget, `STORE_RETRY_BUDGET_MS`) and a warm one is about
a twentieth of a second. `tests/desktop/store-prefetch.electron.mjs` prints the same number on every
run while it holds the service's answers open — it is evidence, not a bound, because a clock is a
flaky gate.

## Player-facing copy

The whole visible vocabulary, exactly as Owen fixed it (ticket 45bb99ad, with the two changes the
payment window forced on 2026-10-23): the buy button
**Buy**; while the press is in flight **Pending…**; every currency card carries both its own
amount (`1,000 Sterling in your bank`, from the server's creditPence) *and* the rule
(`All in-game currency is deposited into your in-game bank account upon purchase, and can
only be withdrawn in-game.`) — Owen chose \"Both, on every card\" on 2026-10-23 after the
line flipped twice between one form and the other, so both are asserted per card from now on; after a window the player closed by
hand **Finish the payment in the Stripe window. Your Sterling arrives the next time you join.**
(it said "in your browser" until the payment moved inside the launcher); a payment the launcher
saw finish **Payment Successful** and **Your order is recorded.**, with one control **Close**;
signed out **Sign in to buy.**; any
other failure **The store is unavailable right now.**; the orders view headed **Your orders**, and
an empty one **No orders yet.**; a paid order **Paid** and a delivered one **In the game**; a
donation **A one-off donation.** and a pack **N Sterling in your bank** from `creditPence`.
Everything else on the page is a product name, a price, a date or a product key the server sent.

Two consequences worth stating, because they are the reviewer's to judge and not this half's to
reword:

- The sentence after a hand-closed payment window names Sterling for every product, a donation
  included. It is one frozen sentence, so a donation card prints it too.
- An order that is not paid carries **no** status word at all. There is no "pending" copy, so the
  page prints nothing rather than inventing one.

The shared home screen's store card (`site/launcher-discovery.mjs`) lost the description that
promised a preview "with no real charges", and the item-preview dialog lost its "purchasing is not
available in this launcher yet" note: both were true of the mock and false of this store.

## How long the store waits

`STORE_RETRY_BUDGET_MS` = **20 s** for each of the two reads (`desktop/accounts.cjs`,
`OPERATIONS`). A store page is one the player is looking at with the catalogue in front of them,
not a Play press: twenty seconds is one Aurora resume plus a second attempt, and short enough
that a shut store says so instead of leaving a spinner on the page. Each attempt is still capped
by `attempt()` below the gateway's 30 s integration limit, and every read and write on this client
follows the same rule as the rest of the account API: the checkout is a **write**, so it is never
repeated after a lost answer — it is only waited out on the service's own declared
`database_unavailable`, which it answers before it creates anything. A press that fails outright
is answered by the player pressing **Buy** again.

## Verification

- `npm test` — includes `tests/store.test.mjs`: the wire shape, the two sentences, the strict
  `paid`/`delivered` reading, the HTTPS-only checkout URL, the declared retry rows, and the fact
  that a 404 from a service that has not shipped the routes yet becomes "unavailable" rather than
  an empty shop. No network.
- `EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18100 PLAYWRIGHT_MODULE=… node tests/store-browser.mjs`
  — the real page against a stubbed bridge at 1440, 1100, 800, 390 and 320: four products and
  their USD prices, the Buy press recording the key, "Pending…" then the sentence after it,
  the orders view empty/pending/paid/delivered, the unavailable and signed-out states, a bridge
  with no store commands, a stale `#cart` link landing on `#catalogue`, and the launcher-only rule.
  It also measures Sol's pass rather than trusting it: one column of rows, a circular 94px medallion
  (64px under 600px), the gold 44px control, no part of a row outside its row, no horizontal
  overflow, the skip link as the first Tab stop landing inside the store, **every visible control
  reached by Tab** (21 of 21), the busy ring still turning without the reduced-motion setting and
  still under it, and the two standing rules asserted in the markup and the module source.
- `… node tests/store-games-browser.mjs` — the catalogue is the server's: unusual products render
  in the server's order with the server's prices, a long name stays inside its card, an empty
  catalogue is a refusal, `site/store/store.mjs` contains none of the products or prices, and
  neither does `site/store/store.css` — a sheet that named a product key would be a catalogue with
  a different file extension, which is exactly what Sol's sheet did. Every medallion is the `kind`
  the server sent, in the server's order, and none carries a `data-product` key.

- `xvfb-run -a node tests/desktop/store-payment.electron.mjs` — **the payment window itself**,
against a local fixture page served by the harness for the Checkout host (no real Stripe session
exists, and none is opened): Buy opens a window inside the launcher (modal, parented, menu-less,
node off, no preload) while `shell.openExternal` is never called; the success fragment closes it
and opens Owen's dialog; the cancel fragment closes it and says nothing; closing it by hand claims
nothing and leaves the store usable; a navigation to another host is refused before it loads; and
a Checkout URL on any other host opens nothing at all.
- `tests/store-browser.mjs` drives the same dialog against the stubbed bridge at 320–1440px:
`paid` → the dialog with its role, labels, focus and one control → Close → the orders view, where
the row the service recorded is on screen (one orders read per dismissal); Escape and Enter; and
`cancelled` → no dialog, no sentence, the store exactly as it was.
- `npm test` also runs `tests/desktop/store-snapshot.test.cjs` — the snapshot as a file: its
  whitelist, the two frozen shapes it holds, that no credential, address, email or Stripe id can
  reach it, that a signed-out snapshot is a catalogue only, that an account's snapshot gives the
  shop and never the orders to another account, that a file past `SNAPSHOT_MAX_AGE_MS` (and one with
  an unknown `version`) is discarded with a named reason, and that publishing bounds the age again.
  No network.
- `xvfb-run -a node tests/desktop/store-prefetch.electron.mjs` — **the launcher's own half**,
  through the real main process against a loopback account service that holds its store routes open
  on promises: a signed-out launch fetches nothing and writes nothing; a sign-in fetches the
  catalogue and the orders once and writes them beside the session cache (no token in the file); a
  cold launch with the session restored prefetches at startup **while both reads are still
  unanswered, with the hero already Play and `startupReady` true**; with the service quoting a
  different price and holding its answer, pressing Store paints the cached shop with no ring and
  `aria-busy="true"` and is corrected the instant the live answer arrives; a snapshot past the bound
  is deleted and leaves today's waiting store; and a snapshot written for another account keeps the
  catalogue, loses its orders, and is rewritten catalogue-only, as a sign-out does.
- `tests/store-browser.mjs`'s snapshot block proves the page's half against the stubbed bridge: the
  rows are on screen with neither read answered, an agreeing confirmation keeps the same DOM nodes,
  a different answer is painted at once, and a bridge with no snapshot still waits exactly as it
  did before the snapshot existed.

**What is not proved, and cannot be from here:** no real Stripe payment has been made through this
window, and no real Checkout Session has been opened from the launcher — the journey drives a
local fixture page, because the account is in Stripe test mode and a session opened just to prove a
window is a session nobody asked for. What a real Checkout page does inside this window (its own
internal navigations, a 3-D Secure step in an iframe, a wallet redirect that leaves
`checkout.stripe.com` for a top-level page) is **not** covered: Stripe's own host may navigate
within itself, and a top-level navigation anywhere else is cancelled by design, so a payment method
that needs a cross-host top-level redirect cannot complete in this window. The card form Owen
used does not.

The two store reads answer 404 in the deployed account API today, which this half reports honestly
as "The store is unavailable right now."

One cross-ticket consequence: the success and cancel fragments this window reads are the **cloud
half's** to set on the Stripe session — `https://easter-co-smp.github.io/#store-paid/{CHECKOUT_SESSION_ID}`
and `https://easter-co-smp.github.io/#store-cancelled`. The deployed values were both the bare site
root when this was written, and a session carrying those produces neither fragment: the window
would simply be closed by the player. Until that deploy, the fixture above is the only thing that
proves the fragments work.

## Currency descriptions and donation art (2026-10-23)

Superseding the earlier worth-line wording above, every currency pack now reads: "All in-game currency is deposited into your in-game bank account upon purchase, and can only be withdrawn in-game." Titles and server prices are unchanged. Donations retain "A one-off donation." The donation emblem is a detailed local vector heart above gifted gold coins, replacing the flag, in both catalogue and item views.

Currency artwork scales with the server-provided creditPence: a few coins below 100 Sterling, a filled pouch from 100 Sterling, and an overflowing chest from 1,000 Sterling. Catalogue and item views share the selection.

## Currency item descriptions — correction

Each currency item must show this exact description in catalogue and detail views: "All in-game currency is deposited into your in-game bank account upon purchase, and can only be withdrawn in-game." There is no bank explanation above the catalogue. Keep the amount in the product title. This supersedes the earlier instruction to put the bank explanation once above the cards.
