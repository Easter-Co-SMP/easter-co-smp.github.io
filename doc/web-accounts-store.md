# Website accounts and shared store

Owen requested browser sign-up/sign-in and the same store features as the launcher on
2026-10-26, preserving the existing website design and download-first hero. This
supersedes the earlier launcher-only store visibility instruction. No game rule,
product, amount, price, copy policy or launcher release is changed here.

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
- Document loads per step, measured with `tests/account-browser.mjs`'s counter
  against `f386139`: dialog → Microsoft 2 → 1, a refused start 1 → 0, a callback
  with a code 1 → 1, the page's own Microsoft button 1 → 1, a refused exchange
  1 → 1, a provider sign-in from the page 0 → 0. The whole journey from the
  nav's Sign in to a signed-in account page is 4 → 3. The two that remain are the
  authorize redirect and Microsoft's return to `/account/`, which are the
  registration itself.

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
password, successful sign-in, profile edits, store navigation and orders, validated
checkout navigation, forged success fragment distrust, logout and provider signup.
Existing store-browser.mjs retains the launcher flows and now expects the public
store route instead of the superseded browser redirect. Independent frontend review
is required before production, in addition to these checks.

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
