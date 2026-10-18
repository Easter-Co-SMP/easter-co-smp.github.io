# Easter Company launcher 1.0.11

Launcher and game updates are now required. The two update switches and the Settings release-link notice have been removed. Legacy saved opt-outs are ignored; closing the launcher when Minecraft starts remains optional.

Startup checks the latest launcher app-file manifest, downloads a newer application bundle with progress, verifies its byte length and SHA-256, activates it atomically in the user's application directory, and restarts automatically. It then checks the game client before enabling Play. Both feeds are checked again before a game launch. Failed checks/downloads keep Play blocked and offer Retry; offline mode does not bypass the version requirement.

A persistent bootstrap loads verified downloaded app bundles on subsequent starts. Routine application updates do not overwrite installed program files, open an installer, or change account vaults/Minecraft files. Payloads are specific to platform, architecture, bootstrap protocol and Electron runtime. An incompatible runtime/bootstrap requires installing a newer base launcher; incompatible code is never loaded.

**One bootstrap installation is required for users on 1.0.10 or earlier:** those releases contain only an update notice and cannot install this updater themselves. Install 1.0.11 once to enable app-file updates.

The update screen appears before the bounded Home arrival. Settings now contains the server, launch preference and advanced fields, without update opt-outs.

Validation includes 96 Node tests; Python/site/browser checks; Electron installation, sign-in/account, state, transfer, mandatory-gate and downloaded-ASAR/bootstrap tests. Windows and Linux packaging and bundled-site verification run in CI. Real Microsoft approval/gameplay and clean-machine Windows update execution remain manual checks; fixtures were used for authentication/game execution.

Installers are unsigned. SHA256SUMS covers the four installers and four update payload/manifest files.
