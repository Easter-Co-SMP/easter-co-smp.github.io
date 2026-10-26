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
- Browser sessions live in tab sessionStorage (token and expiry only), not localStorage,
  cookies, URLs or logs. Restoration validates with /me. No profile/order cache is
  written. Storage denial falls back to memory. Expiry, logout and invalid sessions
  clear account state. Account changes invalidate in-flight reads and clear store
  rows. The launcher continues to use its encrypted native vault independently.
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
