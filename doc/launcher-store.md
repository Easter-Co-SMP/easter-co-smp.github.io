# The Community store — the real store, inside the launcher

The store sells five real products for real USD, through Stripe's hosted Checkout page, and it
lives only inside the launcher. `site/store/` is the page, `desktop/store.cjs` is the half that
shapes what the account service sends, and the three commands on `window.easterDesktop` are the
only way the page can ask for anything.

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
| `penny` | Penny for the poor | $0.01 | A one-off donation. |

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

The page is reached from the launcher's own nav only. Every page keeps its `Store` link in static
markup (the route differs per page), `site/desktop.css` hides it and the whole store page until
`desktop-mode` is on `<html>`, and `store.mjs` sends a browser visitor — no `window.easterDesktop`
claiming `mode:'desktop'` — back to the site root. Nothing advertises the store on the website.

**A browser is not a shop floor** is unchanged from the previous commit and is re-proved by both
browser suites: the no-script page paints no store, and a scripted page with no bridge is
redirected home. Both of the rules that keep it off the website are now asserted **where they
live**, because a design pass over a stale base dropped both of them once (commit 5e5a2fc): the
Store link's `class="store-entry"` is asserted in `site/store/index.html`'s own markup, and the
mount gate (`bridge.mode === "desktop"`, else `location.replace("../")`) is asserted in
`site/store/store.mjs`'s source as well as observed in the browser.

## The look: Sol's pass, applied to the wired page

Owen commissioned a separate front-end pass (Sol, `origin/work` 26660a2, "Replace mock storefront
with five-product shop"). It was written before the store had any behaviour, so it could not be
merged as it stood: it hard-coded the five products and their USD prices in
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
| `storeCatalogue()` | `GET /v2/accounts/store/catalogue` | `{products:[{key,name,amountMinor,currency,kind,creditPence}]}`, in the server's order |
| `storeCheckout(productKey)` | `POST /v2/accounts/checkout` with `{product}` | `{url, sessionId, product}`; **main** opens `url` in the player's own browser and returns |
| `storeOrders()` | `GET /v2/accounts/store/orders` | `{orders:[{sessionId,product,amountMinor,currency,paid,creditPence,delivered,createdAt}]}` |

The renderer's argument is called `productKey`; on the wire the body is `{product}` because that
is what the deployed route reads (`easter-co-cloud/api/checkout_routes.py`, "The request body
names a product by one of the stable keys"). Nothing else travels: no price, no amount, no price
id, no quantity — the server resolves the key to its own Stripe Price id, so this launcher cannot
name an amount.

`storeCheckout` opens the URL with `shell.openExternal` **behind the existing HTTPS-only link rule
in `desktop/security.cjs`** (`externalURL`), so a session that answers with any other scheme is
refused rather than opened. The card form is never in our window.

None of the three is in `REACHABLE_BEFORE_STARTUP`: they need a signed-in session and are not
needed to start the launcher.

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

### Nothing here claims a purchase

After the browser opens, the page says where the payment finishes and stops. It never says
"payment received", never marks an item owned and never invents a receipt: the orders read — on
the next visit to `#orders`, and on the next launch, because the page reads orders on mount — is
what reports what really happened (pending, paid, delivered, or not there at all).

## Player-facing copy

The whole visible vocabulary, exactly as Owen fixed it (ticket 45bb99ad): the buy button
**Buy**; while the browser opens **Opening Stripe…**; after it **Finish the payment in your
browser. Your Sterling arrives the next time you join.**; signed out **Sign in to buy.**; any
other failure **The store is unavailable right now.**; the orders view headed **Your orders**, and
an empty one **No orders yet.**; a paid order **Paid** and a delivered one **In the game**; a
donation **A one-off donation.** and a pack **N Sterling in your bank** from `creditPence`.
Everything else on the page is a product name, a price, a date or a product key the server sent.

Two consequences worth stating, because they are the reviewer's to judge and not this half's to
reword:

- The sentence after a purchase names Sterling for every product, a donation included. It is one
  frozen sentence, so a donation card prints it too.
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
  — the real page against a stubbed bridge at 1440, 1100, 800, 390 and 320: five products and
  their USD prices, the Buy press recording the key, "Opening Stripe…" then the sentence after it,
  the orders view empty/pending/paid/delivered, the unavailable and signed-out states, a bridge
  with no store commands, a stale `#cart` link landing on `#catalogue`, and the launcher-only rule.
  It also measures Sol's pass rather than trusting it: one column of rows, a circular 94px medallion
  (64px under 600px), the gold 44px control, no part of a row outside its row, no horizontal
  overflow, the skip link as the first Tab stop landing inside the store, **every visible control
  reached by Tab** (21 of 21), the busy ring still turning without the reduced-motion setting and
  still under it, and the two standing rules asserted in the markup and the module source.
- `… node tests/store-games-browser.mjs` — the catalogue is the server's: unusual products render
  in the server's order with the server's prices, a long name stays inside its card, an empty
  catalogue is a refusal, `site/store/store.mjs` contains none of the five products or prices, and
  neither does `site/store/store.css` — a sheet that named a product key would be a catalogue with
  a different file extension, which is exactly what Sol's sheet did. Every medallion is the `kind`
  the server sent, in the server's order, and none carries a `data-product` key.

**What is not proved, and cannot be from here yet:** no real Stripe payment has been made through
this page, no real Stripe session has been opened from the launcher, and the two new routes do not
exist in the deployed account API — `/v2/accounts/store/catalogue` and `/v2/accounts/store/orders`
answer 404 today, which this half reports honestly as "The store is unavailable right now." The
bridge is proved against the frozen contract and a stub, not against the service.

One cross-ticket consequence to watch: `easter-co-cloud/api/checkout_routes.py` builds its Stripe
`success_url` as `https://easter-co-smp.github.io/store/#receipt/{CHECKOUT_SESSION_ID}` and its
`cancel_url` as the store's `#cart`. Both routes are removed by this change, so a player who pays
lands on the public site's store page — which, correctly, sends a browser visitor home. The cloud
half should point both at a page that can be read outside the launcher.
