# Easter Company launcher 1.0.15

Easter Company is now your primary account, with a unique Microsoft/Xbox link.

- Continue with Microsoft signs you in or creates your Company account from the available Minecraft profile. Registration also works without Java ownership.
- New accounts and existing accounts without a Company password must create one to finish setup. Your stable Company ID is shown for direct sign-in.
- Sign in directly with your Company ID and password. Minecraft still requires the linked Microsoft account and valid Java access.
- Reset your password through your linked Microsoft identity. Reset revokes previous Company sessions.
- A distinct gold compass and launch-symbol app icon identifies the launcher in windows, desktop shortcuts and Linux/Windows installers.
- The profile menu leads with your Company name and ID. Cancellation, failed login and conflicting Microsoft identities preserve the active account.
- The backend stores unique provider links so another verified provider, such as Steam, can be added later.

Validation covers Node and Python unit tests, migrations and real PostgreSQL transactions, a full Electron journey through the real API handler with a synthetic provider, existing launcher/browser/map/wiki/update checks, visual review and packaged-bundle verification. Cases include profile-less registration, required setup, wrong passwords, conflicting links, legacy ID migration, concurrent signup, password reset/revocation and no credentials in renderer state. No real Microsoft account authentication, password changes or game launches were performed during fixture testing. This host's unavailable OS keyring exercises the secure-vault refusal path.

The required updater delivers this release automatically to 1.0.11 and later. Users on 1.0.10 or earlier need the bootstrap installer once. Installers are unsigned; SHA256SUMS covers all installers and updater assets.
