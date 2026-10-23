# The Community store page — mock commerce

The store implements a complete presentation with an in-process mock API, as a normal
page of the public site at `/store/`, alongside the aligned home cards and quiet
profile refresh. The user-authorized mock testing rollout and independent review are
recorded in `store-testing-rollout.md`. Real backend and payment integration remain
separate work. No game services, player accounts or world data are changed.

## Experience

The store is a page, not a dialog. `site/store/index.html` owns the shell — the shared
site header and its nav, the `h1` naming “The Community store”, the mock notice that is
readable before any interaction, and the footer — and `site/store/store.css` is linked
from that head rather than injected. `site/store/store.mjs` exports
`mountStore(root, {api})` and renders everything inside `#store-root`. Nothing loads it
from the launcher's own surface: `site/desktop.js` adds a plain `<a href="./store/">`
nav link only when the page does not already carry one, and `site/launcher-discovery.mjs`
links to `./store/` with the text “Browse the store”.

The page is reachable from the shared site header nav on Home, Map, Wiki and itself, and
its views are hash routes, so Back, Forward and a shared link all reach the same view:

| Route | View |
| --- | --- |
| `#catalogue` | The selected game's catalogue; an empty or unrecognised hash lands here |
| `#item/<id>` | One product's detail, `<id>` being a `catalogue.mjs` product id |
| `#cart` | The cart and its demo totals |
| `#checkout` | Quote review and the test order; without a live quote it falls back to `#cart` |
| `#receipt/<id>` | One demo receipt; without that order in this session it falls back to `#orders` |
| `#orders` | The mock purchase history |

One `hashchange` handler draws every view change. A route that cannot be honoured now —
a receipt or checkout this session cannot back, an unknown item id — is redirected with
`history.replaceState` to the view that can be, so the address bar never names a view
that is not on screen. Category, search and sort are filter state on `#catalogue`, not
routes: changing them never adds a history entry. The fragment is the store's whole
routing surface, so the page carries no in-page anchor link.

The store keeps persistent navigation, category filters, search, sort, product details,
stock/ownership states, cart quantities/removal, quote review, consent, one-time
checkout, receipt and order history. Without a JavaScript-capable browser the page says
so rather than showing an empty frame. During submission, controls are locked until the
result is known; reads never lock navigation.

Categories are items, ships, player houses, account upgrades and in-game money.
The nine fictional products and all sample prices are defined in
`site/store/catalogue.mjs`. They are authorized mock fixtures, not a live catalogue
or offers in `home.json`. Local static vector illustrations are deliberate product
placeholders, not screenshots or guarantees of delivered builds. No existing
company artwork is redrawn. Replace them with approved real product previews
before selling actual houses or ships.

**Every SKU costs real currency.** In this demo that is USD, integer minor units,
formatted with Intl.NumberFormat. Crowns are one of those SKUs: bought for USD,
spendable only inside the game. There is no store wallet, Crowns payment option,
real payment field, payment SDK, cash-out route or conversion back to real money.
Real prices, regions, currency support and gameplay policy remain product/backend
decisions. Queue access is modelled as a one-time 30-day grant, never an implicit
subscription or auto-renewal. It does not promise immediate server entry.

A persistent mock notice, explicit fictional recipient, purchase consent and a
“Place test order” action distinguish this from real payment. The resulting receipt
states that no money was charged and nothing was delivered in-game. Orders and
mock ownership last only for the current page session and reset on reload or
navigation to another page. They are not saved into the
launcher's authenticated account or entitlement state.

## Mock API boundary

`createMockStoreAPI()` in `site/store/mock-api.mjs` returns:

| Operation | Input | Output |
| --- | --- | --- |
| `catalogue({signal})` | Optional AbortSignal | `{schema:1,currency,items,owned}` |
| `quote({lines},{signal})` | SKU ids and integer quantities only | Quote id, exact line prices, subtotal, tax, total, currency, expiry |
| `purchase({quoteId,idempotencyKey},{signal})` | Existing quote id and a stable attempt key | Immutable simulated order snapshot |
| `orders({signal})` | Optional AbortSignal | Newest-first simulated order snapshots |

The quote lives 120 seconds; tax is explicitly mocked at zero, not a real tax
calculation. The API ignores client-supplied unit prices, checks quantities,
product ids, stock and non-repeatable ownership, revalidates at purchase, and
commits the order/stock atomically within the in-memory mock. A repeated key with
the same quote returns the same receipt; changing its quote is refused. Successful
idempotent retries resolve even after expiry. Read responses are cloned so the UI
cannot mutate API state. No HTTP requests or credentials are used by this adapter.

Test-only `failNext(operation, code)` supports read/payment failures and
`purchase-response` failure *after* the order commits. This proves that retrying
an uncertain result with the original key returns one order. These test controls
are never rendered in the shopping UI. The UI retains the cart and stable attempt
key on a decline/interrupted response, clears consent, and requires another
explicit confirmation. Expiry, changed price, stock or ownership refusal returns
to cart and requires a fresh quote. Search does not recreate its input on keystrokes.
Quick repeated submit clicks are locked synchronously.

`mountStore(root, {api})` is the page entry point; the module is loaded by
`site/store/index.html` itself. For now it **refuses non-mock adapters** — the page
only accepts a mock commerce adapter. Live integration is an intentional later
change, not something enabled by a runtime URL or a query parameter. Lifecycle,
Play, install and authentication gates are untouched.

## Delta's real-money integration

Keep the same renderer/adapter separation. Add narrow, authenticated preload/main
operations to a fixed trusted commerce origin; never expose payment keys, arbitrary
URLs, card data, account tokens or renderer-supplied prices. The purchaser and
delivery account must be selected/validated by the server, not a typed username or
a local ownership flag. The fictional Demo Captain is not a real recipient.

A live quote must include currency, tax, price/availability versions, eligibility,
recipient, sale window and expiry, plus clear refund and fulfilment conditions.
Handle region restrictions, parental/age requirements and applicable consumer
consent in the actual checkout flow. Currency packs must be separately fulfilled
into the in-game ledger, never credited as a store-spendable balance. Ship/house
stock needs reservation/transactional allocation and authoritative placement.
Upgrades need server-owned effective/expiry timestamps and queue entitlements.

Use a hosted payment flow opened by main with an approved origin and an order id;
never collect card details in this renderer. Backend payment-provider callbacks
must authorize fulfilment. A browser redirect is not proof of payment. Persist
idempotency keys and orders server-side, support order lookup/reconciliation after
timeouts or restart, and represent pending payment, paid/pending fulfilment,
fulfilled, cancelled, failed, refunded and disputed separately. Do not activate
items locally based on this mock's `simulated` receipt or copied catalogue data.
Implement signed webhook verification, audit/receipt records, safe retries,
refund/revocation workflows and support contact before real money is enabled.
Replace the demo tax/prices and approve the full item descriptions before release.

## Verification

`npm test` includes the mock commerce tests. Python/site checks remain unchanged.
For browser journeys, serve `site/` locally and run:

```sh
EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18100 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
node tests/store-browser.mjs
```

`EASTER_REVIEW_OUTPUT` optionally points to an existing screenshot directory.
The browser suite uses fixture-only launcher bindings, never a person's account.
It purchases all five product categories at 1440, 1100, 800 and 390 px; checks
search, categories, stock/ownership, quantity changes, quotes, consent, receipts,
history, decline, expiry, uncertain-response retry and failed-catalogue recovery.
Mock unit tests independently cover atomicity, quantity validation, authoritative
prices, idempotency and abort/copy isolation. This demonstrates frontend/mock
readiness, not live payment readiness.

The same suite proves the page shape rather than a dialog: no dialog element is open
over the store, no inline script ships with the page, no off-origin request is made,
the header nav entry navigates, and a cold load of a hash route honours that route on
its own. A scoped axe WCAG 2 A/AA and WCAG 2.1 AA scan found no violations in
catalogue, checkout and receipt views. The shared-home browser suite also passes all
24 populated/long/empty/failed layout cases. These checks do not replace the
designated frontend reviewer’s production sign-off.

## The public page

`/store/` is the storefront itself: a normal site page using the same `store.mjs`
interface and mock API, with no native bridge, real account, payment field or external
store request. Its demo catalogue and prices are not live offers. The page is marked
`noindex,nofollow` because it is a labelled mock rather than a live commercial
storefront, but its URL can be shared directly and opened cold on any hash route.
Publishing it does not publish a new installer or bypass the packaged-launcher release
gates; the launcher ships `site/` as its UI, so a build older than a `site/` change
shows the older page until the next release.

## Game-scoped storefronts

Game selection is a vertical list in the sidebar, directly below “BROWSE THE
STORE”, labelled “Choose Your Game”, above item categories. Easter Co. SMP
is the available example; Orbital Racing and Frontier are explicitly fictional
coming-soon placeholders, not release announcements. Their concept views have no
SKUs, prices or purchase controls. The selected game has a labelled pressed button,
gold outline and its own catalogue heading. On compact screens the labelled
disclosure starts collapsed, opens the same vertical list, and closes after a game
is selected; the panel can scroll without covering the catalogue.

`GAMES` defines stable game IDs and availability metadata. Every product now has
`gameId`. Catalogue responses include game metadata, while quote/order snapshots
and their lines retain authoritative game identity. An optional requested quote
or line game must match the SKU's game. Unknown products and mismatched games are
refused; one checkout contains one game's items. Switching views never silently
clears the cart. Opening a retained cart restores its actual game selection;
product details, cart rows, delivery confirmation, receipt and order history state
the target game explicitly.

For future backend work, scope entitlements and currency ledgers by account AND
game. SMP queue priority and Crowns are not global launcher benefits. If genuine
launcher-wide upgrades are introduced, model that scope explicitly rather than
inheriting the last selected game. All store purchases still use real currency;
in-game currencies stay in their own games and never pay for store purchases.

`tests/store-games-browser.mjs` covers the “Choose Your Game” picker, selection,
placeholder non-purchasability, cart retention and correctly scoped
checkout/receipts at 1440, 1100, 800, 390 and 320 px. The independent frontend
reviewer approved desktop/mobile visual and keyboard behaviour for this
mock-preview update.
