# Website accounts and shared store

Owen requested browser sign-up/sign-in and the same store features as the launcher on
2026-10-26, preserving the existing website design and download-first hero. That
superseded the earlier launcher-only store visibility instruction; the store then left the
website for three days, 2026-10-27 to 2026-10-29, while the app registration was reviewed —
and it came back when Owen asked for it ("yes, return the store to the website"). Three
sections below hold that history in order; the last one is the state of the site today.
No game rule,
product, amount, price, copy policy or launcher release is changed here.

## The store leaves the website again, 2026-10-27

Owen, while the Easter Company app registration goes to Minecraft for API approval and the
form reviews this site:

> **That review has since concluded — see "The Minecraft API approval arrived, 2026-10-28"
> at the end of this file.** The store's removal from the site was a *review* precaution,
> not a product decision, and the reason it cites is now spent.
 *"let's not remove, but disable the store on the website — having it
on our website will make things more complicated for approval, we can handle that afterwards.
Leave it inside the launcher though."* A storefront on the associated website invites
monetisation questions during a review, so the website now has none:

- no page of the site carries a Store entry or any other link into `/store/`. The five pages
  lose the inline entry, and `site/web.js` neither injects one nor forwards the Stripe return
  fragment (`#store-paid/...`, `#store-cancelled`) into the store any more;
- `/store/` on the public site lands on the home page. `site/store/store.mjs` mounts only under
  `window.easterDesktop` claiming `mode:'desktop'` (the isolated preload is the only thing that
  puts one there) and otherwise replaces the address with the site root; `site/store/index.html`
  carries a `noscript` refresh to the same place, so the URL lands home with no scripting either;
  and `site/desktop.css` paints nothing of the store outside `desktop-mode`, so nothing of the
  shop is on screen on the way;
- a direct `/store/` load makes no store API call at all — `tests/store-browser.mjs` counts
  them rather than assuming, and the count is zero (its one off-site request is the sign-in
  provider list every page makes).

Nothing is deleted. The page, its views, its copy, its tests and the bounded browser transport
in `site/store/store.mjs` all stay, and the launcher's store is exactly what it was: its own nav
entry — appended by `site/desktop.js`, which now resolves it against the site root, because with
no inline link left on any page a page-relative `./store/` was `/map/store/` — and its own mount.
The account work below is unchanged and the store returns to the website afterwards.

## Implementation

- web.js adds the account menu and reuses company-auth.mjs and company-profile.mjs.
  It does not enter desktop-mode, assign easterDesktop or change the hero controls.
- web-account.mjs exposes only browser account/profile/store capabilities. The API
  origin is fixed; it cannot be changed by a URL parameter or browser storage.
- Password sign-in, provider enrolment, username/password setup, linked accounts,
  profile name/picture, verified email selection, sign-out and order history reuse
  the account service. Provider URLs are allowlisted before a new window navigates;
  the new window has no opener. The random verifier stays in memory. Cancellation
  and a ten-minute timeout bound polling. COOP severing a WindowProxy is not proof
  that sign-in ended; only the broker answer, cancellation or timeout ends it.
- Browser sessions live in tab sessionStorage and hold the whole `companySession`
  document — `{token,expiresAt,account}` — the shape the launcher's encrypted vault
  keeps, not the token alone. Not localStorage, cookies, URLs or logs. The account in
  it is the projection `sanitizeAccount` produced and is re-validated through
  `companySession` on the way back in, so a hand-edited or stale document is no cache
  at all; a document never outlives its token's expiry, and sign-out, expiry and a 401
  from `/me` clear it with the token. The token stays the only secret in that storage.
  Restoration still reads `/me` and reconciles the name, the face and the expiry. No
  profile/order cache is written. Storage denial falls back to memory. Account changes
  invalidate in-flight reads and clear store rows. The launcher continues to use its
  encrypted native vault independently.
- export_browser_contracts.py exports the launcher's pure validation/retry contracts
  into account-client.mjs and store-contract.mjs. These files ship directly, with
  no browser build step. Run the script after editing the native contract; --check
  refuses stale exports. Native capabilities and game operations are excluded.
- Checkout sends only the server's product key, validates the returned HTTPS Stripe
  host, and navigates the current tab. It does not retry ambiguous checkout writes.
  Stripe's existing root success/cancel fragments route to Store Orders/Browse.
  A success fragment NEVER claims payment success. Orders come only from the API.
  No real payment or user-provider consent was performed for verification.
- Store markup remains noindex. The same catalogue/detail/orders views run in both
  contexts. This request does not introduce a cart or change native payments.

## Production blockers, verified against current service

1. Browser CORS is not configured on the accounts HTTP API: an OPTIONS request for
   /v2/accounts/password/login from https://easter-co-smp.github.io returned 404,
   with no Access-Control-Allow-Origin. Production needs an explicit public-site
   origin allowlist, GET/POST/OPTIONS, and Authorization/Content-Type headers.
   Do not work around this with a public proxy or no-cors. Fixture tests do not
   prove live browser access. This branch is not ready for production publication.
2. Microsoft sign-in on the website is `site/account/` driving the service's
   authorization-code + PKCE endpoints (`/v2/oauth/microsoft/start` and `/exchange`),
   with the exchange server-side so no Microsoft token ever reaches the browser. The
   launcher keeps its own loopback flow; both use one registration. A browser session
   identifies, shops, orders and reads status — it cannot mint a Minecraft session,
   so Play stays in the launcher (`doc/../easter-co-cloud/doc/BROWSER_SIGN_IN.md`).
3. Provider availability is read from the service; unconfigured providers remain
   disabled. `https://easter-co-smp.github.io/account/` is the callback page, and it
   must be registered as a Web redirect URI on the Microsoft application.

The CORS prerequisite in 1 was implemented in the service: the stage answers the
preflight for the site origin only, and `api/cors.py` adds the header to ordinary
responses. The live journeys still have to be verified against a deployed service —
fixture tests do not prove live browser access.

## One sign-in surface, one busy state, counted loads

Owen signed in for real on 2026-10-26 and reported two things: the account page
"does not show the same content as the sign-in modal, but it should (missing
direct sign in options)", and a page mid-flow should show "a decorative and
descriptive loading spinner" and nothing else.

- `site/signin-options.mjs` is the one source of the sign-in options: the
  Microsoft button, the provider buttons in one order (`google`, `steam`,
  `discord`), the note that says what a provider is for, the direct Company
  username/password form, and the two wait sentences. The nav's dialog
  (`site/company-auth.mjs`, mounted by `site/web.js`) and the account page
  (`site/account/account.mjs`) both draw its panel, so neither spells an option
  itself; `tests/account-page.test.mjs` fails if either does again, and
  `tests/account-browser.mjs` compares the two surfaces' drawn text.
- While a sign-in, sign-up or link flow the page itself runs is in flight,
  `#account-panel[data-busy="true"]` shows one spinner (`.wait-feedback-mark`)
  and one sentence, and the options are `display:none` — out of the tab order,
  not merely invisible. The page does not use `site/wait-feedback.mjs` for it,
  because that component adds a second line after ten seconds.
- The dialog starts the Microsoft flow on the page the player is on, so the
  authorize redirect is one document load away rather than two, and a refused
  start is read in the dialog. `completeMicrosoftSignIn` still refuses a
  callback anywhere but the registered path; what the Azure registration pins is
  the address the answer comes back to.
- A SUCCESS LEAVES THE PAGE. Owen, 2026-10-26, signed in on `/account/`: it
  should "redirect back to the / page once signed in. Do not show whatever this
  is." `signedIn()` — the one funnel the Microsoft callback, a provider sign-in,
  the direct Company form and a stored session re-validated on boot all reach —
  paints nothing and calls `location.replace(new URL('../', location.href))`, so
  the document ends on the site root, the entry it arrived on is replaced rather
  than added to (Back cannot re-enter it), and the "signed in as" line, the note
  about Play and the page-level Sign out are gone. The note's sentence was
  deleted rather than moved. Sign-out did not go with it: the nav's account menu
  carries it on every page (`site/web.js:81`). Every refusal is unchanged.
- Document loads per step, measured with `tests/account-browser.mjs`'s counter
  against `f386139`: dialog → Microsoft 2 → 1, a refused start 1 → 0, a callback
  with a code 1 → 2, the page's own Microsoft button 1 → 1, a refused exchange
  1 → 1, a provider sign-in from the page 0 → 1, the direct Company sign-in →
  1, a signed-in visit to `/account/` → 2. Everything a success gained is the one
  load of the return to the site root above; the refusal rows did not move. The
  whole journey from the nav's Sign in to a signed-in page is 4 → 4 — the
  authorize redirect, Microsoft's return to `/account/`, and that return to `/`,
  of which the first two are the registration itself and the third is the rule
  above.

## A cold load paints the account; it does not ask

Owen, signed in on the site: "Even though I am signed in, I hit ctrl+shift+r and now it
says 'sign in'". Both defects were one storage shape.

- The tab used to keep `{token,expiresAt}` only, so the first frame had no account to
  paint and said `Sign in` until the boot `GET /v2/accounts/me` answered. That read is
  what a cold Aurora resume makes slow — 18-22 s — and the window was long enough to
  act in: measured at 1440 with `/me` held, `t+1.2s` gave label "Sign in or create an
  Easter Company account" with the dialog offering `Sign in with Microsoft`, and at
  `t+8s`, when the read answered, the control silently became `OCEaster`.
- Worse, that sign-in could not be honoured: pressing Microsoft while the read was in
  flight was refused with "Sign out before using another account."
  (`site/web-account.mjs`, `startMicrosoftSignIn`'s `await ready` then `if(session)`),
  and the refusal's own repaint turned the control into the account — which is why it
  "fixed itself". The refusal is correct and stays; with the cached document there is no
  window to click in, because the control opens the account menu instead.
- The launcher never had the flash because its vault holds the account document, not
  just the token (`company.enc`). The site now keeps the same shape, so `web.js` paints
  the display name and the face from `getState()` on its first frame and `/me` only
  reconciles. Measured in the same probe on the fix: **first frame at t+85 ms already
  reads `OCEaster` with the face**, no sign-in offered; the read then reconciles to the
  name the service answers.
- `startupReady` is honest rather than hardcoded `true`. A saved session with no cached
  document — the one load after this change ships, and any future storage-shape change —
  reports `startupReady:false` until the read settles, and the control is then
  **non-interactive, `aria-busy`, and the Easter Company mark with no name** rather than
  a sign-in a click would refuse. No new player-facing copy: it reuses the mark and the
  signed-in accessible name.
- The face is the launcher's geometry, which Owen called the better one ("also on web,
  the profile image is a small circle not fully shown like on the launcher, launcher
  style is better"): **32x32 with a 4px radius**, the cropped head still
  `image-rendering:pixelated`, an uploaded picture filling the rounded square with
  ordinary smoothing, and **24x24** at the launcher's own narrow breakpoint
  (`max-width:420px`, site/desktop.css). The pill does not grow with it: the control is
  40px tall at 1440/834 and 44px at 390/320, the same heights it had with a 16px disc,
  because the block padding gives way to the face (`site/web.css`).

## Checks

Run python3 scripts/export_browser_contracts.py --check, npm test,
python3 -m unittest discover -s tests -p 'test_*.py', and
python3 scripts/validate.py site. With site/ served on loopback port 18104:
node tests/web-accounts-browser.mjs. The latter uses fixture-only credentials,
provider pages and checkout sessions at 1440/834/390/320 widths. It covers wrong
password, successful sign-in, profile edits, the shared store driven through the website's own
account transport (the Store entry, the catalogue and its prices, Orders, one Buy press into
Stripe, and a forged `#store-paid` fragment that re-reads orders and manufactures none),
logout and provider signup.
Its three cold-load journeys hold `/me` on the route — the delay belongs where the
player's Aurora resume is, not in a sleep after the load — and assert what the control
says on its FIRST frame, what a click reaches there, and what happens when the read
answers or answers 401. store-browser.mjs keeps every launcher flow and now proves the web half too:
every page carries its own Store entry with and without scripting, each one resolved at the
site root (a guide three directories deep is in the list, because a relative literal is what
this rule gets wrong), a browser `/store/` renders the store through the website transport,
and `#store-paid/...` and `#store-cancelled` route to `#orders` and `#catalogue` without
starting a checkout or manufacturing an order. Independent
frontend review is required before production, in addition to these checks.

The control's label is the name a player is called, not the handle they type: the
display name, then the Minecraft name, then the username - the order
publicAccount already gives, and the rule the launcher has used since Owen's
same report of 2026-10-19 (site/desktop.js, accountName). Owen, 2026-10-26, on
this site: the nav showed `oceaster` where the launcher shows `OCEaster`.

The same journey drives the account control's face in every state that matters -
signed out, signing in, signed in with a picture, signed in with a skin and no
picture, with both, with `skin: null`, with a skin that is not a decodable PNG,
and with a picture the browser cannot decode - and asserts the control measures
the same before and after the avatar paints, that the nav stays one row, and that
the account is still the control's accessible name.

The face is the launcher's own three-step precedence (site/desktop.js, "The
player's face"), in the same order and ending where it already did: the account's
uploaded `picture`, else the head cropped in the browser from the account's
Minecraft `skin`, else the teal letter tile. Owen, 2026-10-26, signed in on both
surfaces: "I am logged in on both web and launcher, but web shows the placeholder
profile image while the launcher is showing my minecraft skin based one."

Both of those images reach the page only inside the account document, as
`data:image/png;base64` URIs, and `publicAccount` keeps that form and drops any
other - so a face costs the page no request to any host, and the contract is the
same one the launcher reads. `skin` is the WHOLE texture, never a pre-cropped
head, because cropping is the renderer's job: `site/web.js` draws the 8x8 face at
8,8 and the 8x8 hat at 40,8 over it into a 32x32 canvas with
`imageSmoothingEnabled=false`, which is the arithmetic and the numbers of
site/desktop.js:1251-1257. The launcher's first source for that texture,
sessionserver.mojang.com, is still unreachable from a page - it answers without
Access-Control-Allow-Origin, so a browser's uuid-to-texture lookup fails before
any JSON exists - which is why the texture travels in the document instead of
being fetched. A crop that fails for any reason (an image that will not decode, a
canvas that returns nothing) leaves the tile showing, exactly as a failed picture
does. The tile is therefore a primary state, not a stopgap: the wipe in
doc/FRESH_SLATE.md leaves every account with `picture: null` and `skin: null`
until it links again, and that state is measured like any other.

`site/account-client.mjs` is generated from desktop/accounts.cjs by
`scripts/export_browser_contracts.py`, so `skin` was added to the whitelist in
sanitizeAccount and to publicAccount at that source and the browser module
regenerated; the generated file is never hand-edited, and the freshness check
below proves it.

## Verification result and review

The 2026-10-26 branch pass completed 141 existing Python tests (one skipped),
368 Node tests including five browser-adapter security/race checks, the generated
contract freshness check, public asset validation, the existing store browser suite,
and the full public-site/launcher browser regression. The four new fixture browser
journeys passed at 1440, 834, 390 and 320 widths.

The independent frontend reviewer inspected sign-in, My Profile and the catalogue
in Chromium, checked overflow at all four widths and verified store skip-link focus
and sign-out clearing private data. They approved design preservation on the branch,
subject to the corrected profile/privacy wording and the documented production
blockers. This is not live-service or real-payment sign-off.

The Minecraft-head pass (branch fix/web-face, the face above) ran 146 Python tests
(one skipped), 408 Node tests, the generated contract freshness check, public asset
validation and all three browser suites with `site/` on loopback: the eight
`tests/web-accounts-browser.mjs` journeys at 1440, 834, 390 and 320 - which now
include the four skin states - plus `tests/account-browser.mjs` and
`tests/browser.mjs`. The crop is asserted from the painted pixels, not from a
screenshot: the fixture skin's checkerboard face and half-transparent hat come back
as exact 4x4 blocks and a composited blend at the offsets the launcher's arithmetic
puts them. No third-party image host is added, the control's box is measured before
and after every face paints, and the launcher's own copy of the crop is untouched.

The cold-load pass (branch fix/web-boot) reproduced both defects against the base
commit `4561b79` in Chromium at 1440 with `/me` held on the route, then measured the
fix the same way: first frame `OCEaster` with the face and no sign-in offered; the
read reconciling the name; a session with no document inert (`aria-busy`, disabled,
the mark); a 401 returning the control to `Sign in` with the document dropped. The
face measures 32x32 with a 4px radius at 1440 and 834 and 24x24 at 390 and 320, in a
pill that is still 40px at 1440/834 and 44px at 390/320 with the nav one row. Gates:
411 Node tests, 146 Python tests (one skipped), the generated contract freshness
check, `validate.py site`, and `tests/web-accounts-browser.mjs` (twelve journeys),
`tests/account-browser.mjs` and `tests/browser.mjs` with `site/` on loopback. Not
deployed and not released by this branch: the coordinator publishes. `read_image`
does not work in this environment, so every verdict here is a measured number or a
value read back from the DOM, never a look at a screenshot.

## The Minecraft API approval arrived, 2026-10-28

Mojang Enforcement (MCENotify@microsoft.com) closed the appID review on 2026-10-28: the
application was approved for the Java Edition Game Service API allow list, with no blocked
outcomes in the batch. That is the registration whose application id the launcher bakes in
as `DEFAULT_CLIENT_ID` (`desktop/auth.cjs`) and which the accounts stack exports as
`MicrosoftClientId`, so the launcher's own calls are the ones covered — `login_with_xbox`,
`entitlements/license` and `minecraft/profile`. Before approval the service answers
`403 invalid app registration`; that failure mode should not be mistaken for a missing
entitlement, which is a different answer on the same account.

What it does not change: it is not a licence (an account without Java Edition still fails
the entitlement check, correctly), it does not revive the retired Mojang accounts API, and
it says nothing about the map, wiki or catalogue APIs. Mojang's message is explicit that
they do not troubleshoot API access.

**Proven, 2026-10-29:** Owen signed in with Microsoft through `https://launcher.easter.company/`
and through the packaged desktop app, and both completed — the site's flow and the app's
`desktop/auth.cjs` chain are both live on the same registration.

**Consequence, closed 2026-10-29:** the website store was disabled on 2026-10-27 *because*
this review was in flight. That reason is spent, and Owen asked for the storefront back —
see the section below.

## The store returns to the website, 2026-10-29

Owen, 2026-10-29: *"yes, return the store to the website."* Nothing had been deleted on
2026-10-27, so the return is the inverse of the three commits that took it away
(`e6f6b82` the code, `9176c19` these documents and the browser suite, `fe9bb0b` the legal
pages). What is true of the site again:

- **every page of the site carries a Store entry in its shared header**, in the page's own
  static markup, so a reader with scripting off still has the route. The pages are not the
  five that lost it: the SEO work since moved the map and the wiki under `/minecraft/`, so
  the entry cannot be a page-relative `./store/` and is not one. Each page's href is the
  site-root-relative address for its own depth, every one of them resolves to `/store/`,
  and `site/web.js` still injects a root-resolved entry on any page whose nav lacks one;
- **Stripe's return fragment is forwarded again.** `site/web.js` sends
  `#store-paid/...` to `/store/#orders` and `#store-cancelled` to `/store/#catalogue`. The
  fragment stays a routing signal only — it decides a hash and nothing else — and the
  orders view is the account service's answer, re-read on use. A forged fragment therefore
  manufactures no payment, no order row and no success claim, and both browser suites now
  prove that by counting checkouts rather than by reading a sentence;
- **`/store/` mounts for a browser again.** The desktop-only gate and the redirect to the
  site root are gone from `site/store/store.mjs`, the mount takes `window.easterDesktop ||
  webAccount`, and the launcher's own mount through its isolated preload is unchanged. The
  `noscript` refresh in `site/store/index.html` is gone with it, and `site/desktop.css`
  paints the store page and its entry in both modes instead of hiding them outside
  `desktop-mode`;
- **the launcher's entry is untouched** — `site/desktop.js` still resolves it against the
  site root and still appends it only on a page that has none, which now simply means it
  never doubles the page's own.

The gates were the part that mattered: both browser suites asserted the store's ABSENCE
from 2026-10-27, so they were flipped to assert its PRESENCE in both modes rather than left
to pass on the old truth.

## The store needs a session, 2026-10-29

Owen, the same day, once the storefront was back and a signed-out visitor could browse the
catalogue and read its prices: *"hide the store from non-signed-in users."* The store is now
offered to a player with an Easter Company session and to nobody else — and "nobody else"
includes a visitor whose browser runs no scripts.

- **One verdict, one author.** `site/store-access.mjs` is the only thing that decides it:
  `paintStoreAccess(state)` puts `store-signed-in` on `<html>` when the account seam reports an
  account and takes it away when it does not. `site/web.js` uses it for the header's entry and
  `site/store/store.mjs` for the page itself; neither decides for itself.
- **The entry is hidden by a stylesheet default, not by a script.** Every page carries its Store
  entry in static markup and `site/desktop.css` hides `a.store-entry` unless the class is present,
  which is what makes a no-scripting visitor see no Store link: nothing on such a page can check a
  session, so nothing can claim one. `desktop-mode` (the launcher) is outside the rule and shows
  its own entry either way.
- **`/store/` ships the gate in its markup** — a heading saying the store needs an Easter Company
  account, a sentence saying what signing in shows, and the store's own `.store-button` pointing at
  `/account/`, the sign-in surface the site already had. `store.mjs` replaces it with the shop only
  when the seam reports an account, so a signed-out load makes **zero store API calls**: no
  catalogue, no prices, no cart, no orders. A direct address, a bookmark and Stripe's return
  fragment all land on the gate.
- **Signing out takes the store with it, in the same tab and with no reload**: the class goes, the
  entry disappears, the shop the session built is dropped and the gate comes back. The store never
  outlives the session that opened it.
- **The gates assert this in both directions and count the consequence.** `tests/store-browser.mjs`
  proves the signed-out half with scripting off and on (no Store link in the accessibility tree on
  any page, the gate on `/store/` by address, bookmark and fragment, zero store API calls), and
  keeps every launcher-mode rule unchanged; `tests/web-accounts-browser.mjs` drives the signed-out
  gate before sign-in, then the full signed-in shop (entry, catalogue and prices, Orders, one Buy
  into Stripe, `#store-paid` naming `#orders`), then the sign-out that re-gates the shop with no
  store request afterwards. The gate's heading is asserted from the page's markup in both suites,
  so rewording it moves the page and the gates together.

The gate's wording is the one piece of player-facing copy introduced here that is not Owen's own;
it has to live in the markup for the no-script visitor, and it is short and factual for that
reason. Changing it means changing `site/store/index.html` and the `GATE`/`GATE_HEADING` literals
in the two suites.
