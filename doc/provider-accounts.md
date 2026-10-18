# Provider accounts: implementation and rollout

This contract supersedes Microsoft-only enrolment statements in ACCOUNT_IDENTITY.md
and PROJECT.md. All four providers are signup, login and permanent linking options:
Microsoft/Xbox, Google, Steam and Discord. Company account IDs remain stable.
No account is merged by display name or email, and no unlink/transfer route exists.

## Account lifecycle

1. Sign in with a provider. Its identity is verified server-side.
2. Choose a unique Company username and a Company password before continuing.
3. Use the provider, username/password, or selected verified email/password later.
4. Link other providers from Profile & linked accounts. A provider identity belongs
   to one Company account, and each Company account has at most one link per provider.
5. Recover a forgotten Company password by reauthenticating through a linked provider.
   Reset requires a provider session created within 15 minutes and revokes older sessions.

The first provider is recorded as primaryProvider. Initial display name/picture are
imported when available, then remain independent of the provider's later profile.
Google and Discord expose public profile metadata through the verified OAuth flow.
Microsoft imports the Xbox gamertag/gamerpic when Xbox profile access is available.
Steam public profile import uses an optional Web API key. Without a provider image,
the launcher shows initials; uploading/removing a picture is always independent.

Minecraft still requires the linked Microsoft/Xbox identity and verified Java access.
Google, Discord or Steam sign-in alone does not grant Minecraft access. Steam sign-in
does not itself prove ownership of a future Steam game; product ownership checks
must be implemented for each future Steam product.

## Browser protocol

Google and Discord use the confidential authorization-code flow. Codes are exchanged
on the server for OUR registered client and exact callback; tokens are never saved.
Steam uses OpenID 2.0 with direct check_authentication at the fixed Steam endpoint.
Endpoint, identity, claimed_id, signed fields, return_to and nonce age are checked.

POST /v2/accounts/providers/start takes provider and a 32-byte random verifier;
an optional Company bearer means link/reauthenticate this account. The server stores
hashes of state and verifier, plus the bearer hash binding and a ten-minute expiry.
It returns flow, url, expiresIn. The launcher validates the provider URL and opens
the system browser. No credential or session bearer is placed in that URL.

GET /v2/accounts/providers/{provider}/callback verifies the single-use browser state
and provider response. It stores only verified profile data, never an access token.
The browser gets a static completion page with no Company credential.

POST /v2/accounts/providers/finish takes flow and verifier, plus the SAME optional
Company bearer used at start. Pending returns 202. Success transactionally consumes
the flow, resolves a unique provider identity and issues the Company session. Wrong
verifier, expiry, replay, revoked bearer and mismatched binding are refused.
Concurrent completion issues at most one session. Provider conflicts never merge.

GET /v2/accounts/providers returns configured options, always including Microsoft.
Unconfigured choices are disabled in the launcher.

POST /v2/accounts/session/refresh renews an unexpired, unrevoked bearer for thirty
days and returns account plus session. It preserves original created_at/auth_method,
so renewal cannot grant recent-proof authority for a password reset.
The launcher renews at startup and every six hours while idle, keeps the existing
userData directory across updates and saves only to OS-encrypted safeStorage.
Missing OS encryption/basic_text causes persistence to be refused. Expired/revoked
sessions still require sign-in; network errors do not discard an otherwise valid vault.

POST /v2/accounts/profile takes optional displayName and/or picture. null picture
means remove, PNG data URI means upload. PNGs are limited to 256px and 256 KiB,
CRC/structure/decompression checked and metadata stripped. The Electron file picker
decodes/crops/resizes uploads before sending. Only main-process allowed-host fetches
load initial provider pictures; the renderer receives a local PNG, never a remote URL.

## Deployment prerequisites

No production deployment or live provider authorization has been performed for this
change. The source lives in isolated worktrees and the installed launcher is unchanged.

Apply migrations through 005 before deploying this backend. Run tests and synth, then
deploy the backend and compatible launcher together. New tables explicitly revoke
the publisher role's inherited reads.

Register owned Google and Discord OAuth apps with these exact redirect URLs:

- https://jyjshd22z3.execute-api.us-east-2.amazonaws.com/v2/accounts/providers/google/callback
- https://jyjshd22z3.execute-api.us-east-2.amazonaws.com/v2/accounts/providers/discord/callback

Google scopes: openid profile email. Discord scopes: identify email.
Store each app's clientId/clientSecret in the approved server-side secret store;
pass only its secret ARN through CDK's GoogleOAuthSecretArn/DiscordOAuthSecretArn
parameters. CloudFormation resolves references at deployment; neither synth nor the
Lambda reads secret values. Empty parameters disable those providers.
An optional SteamProfileSecretArn secret with apiKey enables Steam profile metadata;
OpenID sign-in itself needs no Steam client secret or API key.
EASTER_AUTH_ORIGIN comes from the deployed HTTP API endpoint in CDK.

Do not put provider secrets in Electron, site/, Git, tests, command-line arguments,
or logs. No new paid provider service has been provisioned. Before publication,
complete real consent/sign-in/link/recovery checks for each configured provider and
verify OS-keyring persistence on an installed build.

## Verification

- Full Python suite includes disposable PostgreSQL tests for migration/links,
  verifier binding, replay, concurrency, conflicts, proof freshness and revocation.
- Node tests cover browser URL restrictions, verifier handling, cancellation,
  account response sanitization, encrypted-vault refusal and picture fetch restrictions.
- providers.electron.mjs uses the real API/SQL through launcher_api_fixture.py with
  EASTER_PROVIDER_FIXTURE=1 and EASTER_API_FIXTURE_PORT=18797. It covers Discord signup,
  required setup, Google linking, display name/picture changes, logout, password login,
  process restart and provider-based password reset. Provider responses are synthetic.
  The restart journey uses an explicit test-only AES-GCM safeStorage implementation
  because the isolated X session has no OS keyring; production refusal remains intact.
- Independent frontend reviewer approved desktop and 390px/320px renderer checks,
  including provider availability, failed operations, keyboard scrolling and cancellation.
