# Easter Company launcher 1.0.12

A Microsoft login without Minecraft Java Edition access now has a complete recovery path.

- Confirmed missing Java access shows **Buy Now**, opening the official Java & Bedrock Edition for PC store in your browser.
- **Check again** reuses the Microsoft session after purchase and moves the same account to Download or Play once access and a Java profile are available.
- An entitled account without a configured Java profile gets **Set up Java profile**, with an official profile-page link.
- Service failures show **Retry account check**, never a prompt to buy another copy.
- Subscription-based Java access is accepted. Bedrock-only access is not treated as Java access.
- **Use a different account**, account switching and logout also work without a Java profile. Cancellation and failed account addition preserve the prior active account.
- Access is checked before every launch, so an expired/revoked entitlement cannot launch using a cached Java profile or enrol an Easter Company account.

Profile-less Microsoft sessions use stable public identity keys in the existing encrypted vault. Tokens never cross into the renderer. No plaintext persistence fallback is added.

Validation includes Node auth/identity tests; existing launcher/account/browser/site checks; a new real Electron journey using fixture Microsoft/Xbox/Minecraft responses; and packaged-bundle verification. Cases cover missing ownership, setup, outages, subscription access, purchase recovery, duplicate prevention, cancellation/failed-add retention, direct Play rejection and the Wiki action dock. Real player authentication/purchases were not performed; the host exercised the secure-vault refusal path because no OS keyring was available.

v1.0.11 can download this app-file update automatically. Users on 1.0.10 or earlier still need the bootstrap installer once. The existing required launcher/game update gate remains in effect.

Installers are unsigned. SHA256SUMS covers all installers and update payload/manifest files.
