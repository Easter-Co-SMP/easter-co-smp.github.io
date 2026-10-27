# Generic return targets for the site's sign-in flows

Owen, 2026-10-26: *"easter-co-smp.github.io should have generic flags to handle redirects and
other e apps using the same auth flows."* The site already owns the household's sign-in (the
Microsoft callback on `/account/`, the provider broker, the direct Company form, the splash a
finishing window shows). What it did not own was the answer to *and then where?*: every success
went to the site root, so a second app that wanted the same identity had to invent a flow of its
own. This is that answer, and it is a contract between two repositories — the site implements it
and e-server's profile dropdown is its first consumer.

## The rule

A return target is accepted only when it is

- `https`, with a host that is `easter.company` or a subdomain of it, or
- `https`, with a host that is `char-istrian.ts.net` or a subdomain of it, or
- the `easter-company://` scheme (the launcher's deep link).

Matching is on label boundaries and never on a substring: `evil-char-istrian.ts.net`,
`char-istrian.ts.net.evil.example` and `char-istrianXts.net` are all refused. A host that only
becomes an allowed host after normalisation — a trailing dot, an upper-case spelling — is refused
too, and one masked host is excluded by name (below). The host also has to
be spelled the way the URL parser already reads it, so a trailing dot, an upper-case spelling, a
percent-encoded dot and a Unicode look-alike are refused rather than accepted on a normalisation
nobody wrote. Any URL carrying a username or password is refused outright.

One host under an allowed suffix is refused by name, because it is a **mask rather than an
origin**: `https://minecraft.easter.company/` is a GoDaddy masked forward, measured 2026-10-26 —
it serves a single `<frameset>` whose only frame is `https://launcher.easter.company`, and every
deep link under it 404s (`/account/` → 404, `/wiki/` → 404); only the root exists. The suffix rule
would accept it, and a return there would be a return to a missing page — the false success this
project keeps getting bitten by. It is one named row, `MASKED_HOSTS` in `site/auth-return.mjs`, and
it comes out the moment Owen replaces the mask with a plain 301 forward (the fix being recommended
to him: `easter-co-smp.github.io`'s own 301 already preserves paths, a mask does not). Nothing about
the mask needs a CORS entry: inside the frame the document's own origin is
`launcher.easter.company`, and the API already answers that origin correctly.

Owen wrote "chat-istrian". The domain the household's tailnet actually serves — measured from
e-server's own configured public URL, `https://easter-server.char-istrian.ts.net:8443/` — is
**`char-istrian.ts.net`**, and that is what is implemented. It is one constant
(`TAILNET_DOMAIN` in `site/auth-return.mjs`): a second domain is one line, not a second rule.

## The two parameters

| Parameter | Accepted value | Where it comes from |
| --- | --- | --- |
| `?app=<id>` | an id in the `ALLOWED` table: `e-server`, `launcher` | the household app sending the browser here |
| `?next=<absolute URL>` | any absolute URL that passes the rule above | an app that wants an address the table does not name yet |

The table, in `site/auth-return.mjs`:

| id | address |
| --- | --- |
| `e-server` | `https://easter-server.char-istrian.ts.net:8443/` |
| `launcher` | `easter-company://signed-in` |

`?app=` wins over `?next=` when both are present, and an unknown id is ignored (it does not fall
through to a refused `?next=` and it is never an error). Whatever the parameter, the resolved
address is run through the same validator, including the addresses the table itself builds — a row
that stopped being a legal address would refuse itself rather than send a browser somewhere
unlisted.

## How the browser is brought back

1. Any page of the site, opened with `?app=` or `?next=`, resolves the target once and stores it,
   once, in **this tab's `sessionStorage`** under `easter-company-auth-return-v1`
   (`rememberReturnTarget`, called from `site/web.js` and, before its first paint, from
   `site/account/account.mjs`). `sessionStorage` and not `localStorage`: the return belongs to the
   tab that started the sign-in and must not outlive it.
2. The tab signs in however it likes. Microsoft leaves this origin entirely and comes back to the
   fixed registered literal `/account/` — which cannot carry a parameter — so it is the stored
   value, not the URL, that survives the round trip.
3. The sign-in that succeeds consumes it: `signedIn()` in `site/account/account.mjs` navigates to
   the stored target instead of `/`, and the site root's `/?signed-in=1` hand-back does the same in
   `site/index.html`'s head script (which loads the module rather than reading the key a second
   time, so the allow-list has one author). **Reading it deletes it**, so the return happens once
   and a later visit goes to `/` as it always did.
4. A **popup** closes itself and navigates nowhere: only an ordinary tab leaves for the target.
5. A visit with neither parameter writes nothing and behaves exactly as it did before.

A refused sign-in drops the request. A cancellation, the authority's own refusal and a failed
exchange all leave the visitor on `/account/` with the sentence and with no stored target, so a
later sign-in in that tab cannot redeem an abandoned intent; a retry is a fresh visit from the app,
carrying its parameter again.

## What this must never become

**No token, session, password or one-time code travels in a redirect target.** The parameter means
*bring this browser back* and nothing else. `site/auth-return.mjs` holds no account state, imports
nothing that has any, and the only value it stores is the URL; `tests/auth-return.test.mjs` scans
the module's shipping code for the words that would mean otherwise and fails if one appears. An app
that needs its own session gets it from its own flow against the account API — e-server already
does, with `core/company_accounts.py`. The flag tells that app where to continue, never what it may
do.

## Where it is proved

- `tests/auth-return.test.mjs` — the validator on its own: every accept, every rejection class the
  ticket names, the masked-host exclusion beside the suffix acceptance it carves out of
  (`https://launcher.easter.company/wiki/` accepted, `https://minecraft.easter.company/wiki/`
  refused), the storage seam (stored once, consumed once, a refused sign-in dropping it, a
  hand-edited value dropped), and the no-token scan.
- `tests/account-page.test.mjs` — the account page's answer: one navigation, the stored target when
  there is one and the site root otherwise, the target stored before the first paint can answer with
  it, and a refusal dropping it.
- `tests/account-browser.mjs` section 17 — the composed journeys in a browser, with fixture copies of
  both allow-listed origins: `?app=e-server` stored in the tab, carried through the real Microsoft
  round trip and spent on exactly one visit to the allowed origin with an address carrying nothing
  appended; `?next=` accepted only on an `easter.company` host; a refused and a cancelled sign-in
  each leaving no target; the splashed ordinary tab leaving for the app with no frame of the homepage
  behind it; and a popup closing itself instead.
