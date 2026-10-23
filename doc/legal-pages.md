# Legal pages: the Privacy Policy and the Terms of Service

The public site carries two legal documents and links to both from every footer, so a
player — or a Google reviewer — can reach them from the site and from inside the
launcher without being handed a raw URL.

They exist because the Google OAuth consent screen will not accept the app without a
public privacy policy, and because a public server should say plainly what it records,
what it forbids, and what it will not be liable for.

## URLs

| Field | URL |
| --- | --- |
| Application home page | https://easter-co-smp.github.io |
| Application privacy policy link | https://easter-co-smp.github.io/legal/privacy/ |
| Application Terms of Service link | https://easter-co-smp.github.io/legal/terms/ |

Google also requires the authorised domain to be verified as owned by the Cloud project
owner (Search Console). The HTML-file or HTML-meta-tag method is the one that works
here: `easter-co-smp.github.io` is a Pages site we publish, while the DNS method cannot
work because the `github.io` zone belongs to GitHub. The privacy policy must be
reachable without signing in; it is a static page with no JavaScript requirement.

## Decisions Owen made (do not change these without him)

- **Contact for privacy and legal notices:** `oceaster@gmail.com` — 2026-10-19.
- **Governing law:** Scotland, courts of Scotland, with UK and EU consumer protections
  preserved — 2026-10-19.
- **Minimum age:** 13, matching the Minecraft account requirement — 2026-10-19.
- **Entity:** Easter LTD, with "Easter Company" and "Easter Co. SMP" as trading names,
  taken from `LICENSE`.

## Where the factual claims in the copy were verified

| Claim in the copy | Verified against |
| --- | --- |
| Passwords stored as a salted scrypt verifier (n=32768, r=8, p=3) | `/root/easter-co-cloud/api/passwords.py` |
| Session tokens stored only as hashes | `db/migrations/001_easter_schema.sql` |
| Provider identities, one link per provider per account | `db/migrations/002`, `005` |
| Verified addresses, lower-case, globally unique, one login email | `db/migrations/004_verified_emails.sql` |
| Sign-in rate-limit counter and ten-minute flow state | `db/migrations/002`, `005` |
| Microsoft refresh token sealed with AES-256-GCM, key outside the database, wiped on revocation | `db/migrations/009_microsoft_sessions.sql` |
| Google scopes are `openid profile email`; Discord `identify email` | `doc/provider-accounts.md` |
| Account service and database in AWS `us-east-2` | `/root/easter-co-cloud/infra/easter_accounts_stack.py` |
| No cookies, analytics or trackers; localStorage and IndexedDB only | search of `site/` |
| Public map and data exclude player positions and player records | `scripts/validate.py` allowlist |
| "Sign out of Minecraft everywhere" revokes the stored session | `doc/launcher-states.md` |
| Installers are unsigned, so SmartScreen warns | recorded launcher release evidence |
| The account cluster is NOT encrypted at rest, so the copy makes no such claim | `rds describe-db-clusters e-server-cloud-db`, us-east-2, 2026-10-19: `StorageEncrypted: false`, `BackupRetentionPeriod: 1`, `DeletionProtection: false` |

## Security gaps found while verifying the copy (Owen's call, not done here)

Writing a policy that is true meant checking the infrastructure, and three things the
account cluster does not have today came back from `DescribeDBClusters`:

- **No encryption at rest** on `e-server-cloud-db` (`StorageEncrypted: false`). Aurora
  cannot enable this in place: it means snapshotting the cluster, restoring into an
  encrypted cluster, repointing `CLUSTER_ARN`/`DB_HOST` in the CDK stack and migrating
  the rows. The copy therefore claims only what is true — private storage, role-split
  database access, managed secrets, and AES-256-GCM on the Microsoft refresh token.
- **Backup retention of one day.** A bad migration is recoverable for a day.
- **No deletion protection** on the cluster.

None of this was changed. It is production infrastructure and needs Owen's decision.

## Operational commitments the copy now makes

These are promises in a published policy. Easter LTD has to be able to keep them.

- **Server logs** (chat, commands, connection records): normally no more than 90 days.
  If the production server never rotates its logs, that row is not true. Rotating them,
  or softening that row, is Owen's call.
- **Moderation and ban records**: while the restriction lasts and up to 12 months after.
- **Messages sent to us**: up to 24 months after the matter is closed.
- **Rights requests**: answered within one month (UK GDPR).
- **Deletion requests**: account and attached personal data, subject to the retention rows.

## Updating the documents

1. Change `Last updated` in both files (`site/legal/privacy/index.html`,
   `site/legal/terms/index.html`). Change `Effective` too when the change is material,
   and announce it on the site and in the launcher first.
2. Keep the two documents in step: a change to what is collected belongs in both.
3. Run the gate: `scripts/validate.py site`, the unittest suite, `npm test`,
   `node tests/legal-browser.mjs`, and `xvfb-run -a node tests/desktop/legal.electron.mjs`.

## Where this stands: living until locked in (2026-10-23)

Owen's instruction, verbatim: *"Please adjust the legal stuff to suit our every changing design
as we go. We don't need to take it too seriously right now, just as long as we're wrapped up and
locked-in by next month."*

So, until that lock-in:

- **The documents track the shipped design, not a launch snapshot.** A change that removes,
  renames or adds something a page describes — a control, a stored value, a route — corrects
  that page in the same commit and bumps its `Last updated` date. No ticket of its own, no
  design review, no ceremony, and no announcement: the announcement above is for changes that
  materially affect what is collected or how it is used, not for keeping the pages true.
- **Player-facing prose states what is true today**, one fact per sentence. No release dates, no
  "as of …" archaeology, no recounting which button used to exist — that belongs in `doc/`.
- **Locked-in means a deliberate final pass by 2026-11-30**, and this paragraph is the item that
  tracks it: read both documents against the shipped launcher and site and correct every claim;
  every control named must exist, or be described as something you ask us for; the
  `Effective`/`Last updated` dates current; the Google OAuth consent-screen fields still matching
  what the site publishes; then Owen reads them once and they stop moving.

## Limits

This is written to be accurate, specific and defensible, and it is deliberately grounded
in what the code actually does rather than in boilerplate. It is not legal advice and no
solicitor has reviewed it. If payments, a registered company address, staff other than
the family or a materially larger player base arrive, have it reviewed properly, and
consider ICO registration and a data processing record.

## Verification and review record

- The frontend review pass (ticket 9dc0e9b0, commit f501f47) is the sign-off this
  change needed before production. It set the prose to a 640px reading measure while
  leaving the contents box and tables full width, raised the effective-date line from
  3.39:1 to 5.5:1, brought the documents' footer hover in line with the site's, and
  fixed a pre-existing 26px sideways scroll of the privacy policy at 320px.
- Live check on 2026-10-19 after c851bcb: `/legal/privacy/` and `/legal/terms/` both
  200 with the real documents, `legal.css` 200, the home/map/wiki footers carry both
  links, and a missing path still serves `404.html` with its root-absolute legal links.
- Open design question, deliberately left for its own decision: the two three-column
  tables are strong at 1440 and become the weakest thing on the page at 390 (cells of
  8 to 9 lines). Stacking them would cost screen-reader table semantics unless role
  attributes go into the HTML, so it is not a CSS-only change.
