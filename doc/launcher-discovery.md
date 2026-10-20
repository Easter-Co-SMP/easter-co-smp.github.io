# Launcher home: client, dispatch, store

The website retains its exclusive SMP headline and download hero. The launcher has
three tiles: existing client controls, the latest social post, and one featured
store item. Content never blocks signing in, installing, or playing. No social
trackers, embeds, third-party scripts, invented posts, prices, or products ship.

## The content document (implemented 2026-10-20)

The contract below is what main and the preload now do. The document lives at
`site/home.json`, published with the rest of the site, and is read from the same origin the
launcher installs from (`clientOrigin()` in `desktop/config.cjs`) — no second host, no
credentials, no signing, nothing the renderer can name. `desktop/discovery.cjs` owns the
read; `desktop/main.cjs` answers `home-content`; the preload exposes it as
`window.easterDesktop.homeContent()`.

What main enforces, and why each bound exists:

| Bound | Value | Why |
|---|---|---|
| Path and origin | `/home.json` on the client origin only | One document, one host. A development `EASTER_CLIENT_ORIGIN` moves it with the rest of the public files |
| Transport | the launcher's own `apiFetch`, HTTPS (loopback allowed for fixtures) | The same stack as the account API, so no second HTTP client and no Chromium TLS quirks |
| Timeout | 8 s (`AbortSignal.timeout`) | The cards are optional; they may never hold the home screen |
| Body ceiling | 64 KiB, enforced during the read | A public file the launcher does not control may not be talked into filling memory |
| Schema | `schema: 1`, `posts` an array | An unknown schema is refused whole rather than guessed at |
| Entries | at most 12 posts, duplicate ids collapsed | The page cannot grow into a newsletter archive |
| Text | title 160, excerpt 400, description 1600, category 40 | Clamped, not dropped: over-long copy the Company wrote is still its copy |
| Ids | ≤64 chars, `[A-Za-z0-9._:-]`, refused if longer | Truncating an id could collide two items into one stable key |
| Links | `https:` only, no credentials, ≤2048 | Main's window-open handler checks again before anything leaves for the browser |
| Cache | 30 minutes, one request in flight at a time | One read per half hour however many times the screen renders; concurrent asks share it |
| Failure | `content_unavailable`, no transport detail | The renderer shows its own unavailable state and the player keeps playing; an answer already in hand survives a later failure |

Publishing a dispatch or a featured item is editing `site/home.json` and pushing: the site
deploys in a minute and every launcher picks the change up on its next launch, or at most
half an hour later. `posts: []` and `featuredItem: null` are honest answers — the home
screen already has words for both.

**The first ask of a launch can be refused, and that is not an outage.** Every launch IPC
goes through `handle()`, which refuses a sender frame that is not yet the app's own; the
renderer mounts the cards early enough that its first ask can arrive before that frame is
trusted. The refusal is deliberate and is recorded nowhere, which is exactly how 1.0.36
shipped "Dispatches unavailable" over a document that was there all along (fixed in
1.0.37). So main reads the document as soon as the process is ready — the answer is
usually in hand before the screen asks — and the cards retry a failed first ask once,
quietly, before they say anything is unavailable. Any new start-up read on this bridge
needs the same two things.

An unknown field is dropped, an unreadable entry is dropped, and the renderer filters
again on its own: neither side trusts the other, and neither trusts the document.

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
that purchasing is unavailable. The bridge and the document are done; checkout is not,
and the boundary below is the standing rule for when it is built.
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
or advertised products.

Implemented checks: `tests/desktop/discovery.test.cjs` holds the document's bounds and
the cache, `tests/discovery-browser.mjs` holds the three layout widths and the renderer's
states, and `tests/desktop/loopback.electron.mjs` reads a published fixture document
through the real preload and real main — including a `javascript:` entry and a duplicate
that must not survive the trip. The website must have no discovery region and keep its
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

## Home layout refinement

Above 1000 px, client, news and store share a single stretched grid row with equal
height and aligned top/bottom edges. Their content, rather than independent fixed
card heights, determines the row height. Client controls remain primary through
column width; supporting cards share the same surface, padding scale and quiet
labels. Decorative glyphs and the store gradient are removed. Empty states say
what is missing rather than presenting promotional filler.

At 441–1000 px the client spans the top row and the two equal-height supporting
cards sit below it. At 440 px and below, all three stack. Short windows scroll the
page rather than clipping a client card or creating a separate client scrollbar.
The browser checks assert these geometry rules for populated, long-copy, empty
and failed states at 1440, 1100, 900, 600 and 390 px, plus 1100 × 600.
