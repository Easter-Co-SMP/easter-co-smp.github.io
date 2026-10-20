# Launcher home: client, dispatch, store

The website retains its exclusive SMP headline and download hero. The launcher has
three tiles: existing client controls, the latest social post, and one featured
store item. Content never blocks signing in, installing, or playing. No social
trackers, embeds, third-party scripts, invented posts, prices, or products ship.

## Delta integration contract (proposed; not implemented in main/preload)

Expose one read-only `window.easterDesktop.homeContent()` Promise through the
isolated preload, backed by a fixed public-content endpoint chosen by main:

```json
{
  "schema": 1,
  "posts": [
    {
      "id": "stable-source-id",
      "title": "Post headline",
      "excerpt": "Plain-text editorial summary",
      "publishedAt": "2026-10-19T16:00:00Z",
      "url": "https://example.com/posts/stable-source-id"
    }
  ],
  "featuredItem": {
    "id": "stable-catalogue-id",
    "title": "Catalogue item title",
    "description": "Plain-text description of the item and what it includes",
    "category": "Catalogue category"
  }
}
```

`posts: []` and `featuredItem: null` are valid empty results. The UI selects the
newest valid post, rejects non-HTTPS/credential-bearing links, and renders text
without HTML. Post links open the system browser using the existing main-process
HTTPS validation. Fetch failure/10-second timeout shows local unavailable states
and Retry; the client remains usable. A missing bridge shows honest empty cards.
Main should enforce payload bounds, endpoint trust, timeouts, caching, freshness,
and publication visibility. Never pass social credentials into the renderer.

A featured item opens a keyboard-accessible preview dialog, with explicit notice
that purchasing is unavailable. Main/preload/API and checkout are Delta's work.
The current frontend intentionally accepts no price, checkout URL, purchase
callback or ownership claim. Previewing a catalogue item does not grant it.

## Store decisions before commerce is enabled

Keep catalogue/editorial promotion separate from authenticated ownership and
checkout. Stable item IDs should survive renames; model offers/SKUs separately.
Backend must own eligibility, entitlements, stock, supported regions/currencies,
tax-inclusive totals where applicable, sale windows, refunds, and idempotent
purchase confirmation. Future price displays need integer minor units plus ISO
currency, expiry, and an authoritative refreshed quote before payment. An ad's
cached price must never become a checkout authorization.

Use a main-process action accepting an item ID, not arbitrary payment URLs or
renderer prices. Open a dedicated store view with full contents, conditions,
price, ownership and confirmation before checkout; never purchase on tile click.
Only backend-confirmed receipts may unlock items, with pending/retry/refund states.
Do not infer ownership from local storage or a successful browser redirect.
Avoid payment SDKs, account secrets, trackers and remotely executed content in
this shared renderer. A cosmetic-first catalogue is recommended; monetization
and gameplay policy require a product decision rather than a frontend assumption.

## Review and validation

Use fixture payloads in browser tests for populated, empty, failed, retry and
malicious-content states. These are test fixtures, never production social posts
or advertised products. The website must have no discovery region and keep its
headline. Inspect desktop and compact launcher layouts plus short-height screens.
Delta owns API integration, final designated frontend review, merge and release.

Run `npm test` for the content selection and trust-boundary tests. With the site
served locally and Playwright installed outside the checkout, run:

```sh
EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18100 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
node tests/discovery-browser.mjs
```

`EASTER_REVIEW_OUTPUT` optionally saves layout screenshots to an existing folder.
The browser check uses Chromium at `/usr/bin/chromium`, fixture-only preload
bindings, and validates website separation/centring, three launcher sizes, loaded,
empty and failed feed states, item dialog Escape handling, and external link targets.
This does not validate Electron IPC or a live backend.
