# Easter Company launcher 1.0.10

This release overhauls the launcher interface while retaining the harbour, crest, shared Map and bundled Wiki.

- A compact Home panel with one primary action. The idle dock no longer duplicates Play or sign-in on Home; transfers stay available across every page, and Map/Wiki keep their idle launch action.
- Settings with aligned preference switches, collapsed advanced options, keyboard saving and a client-folder shortcut. Settings can be saved during gameplay and apply to the next launch.
- Separate Microsoft sign-in with a clear connecting state, device code and browser action. Escape, close and Cancel abort authentication without revealing Settings or replacing an existing account.
- Account management in the profile menu, with Microsoft and Easter Company identities labelled separately. Account changes are disabled while authentication or Minecraft is running.
- Visible, dismissible operation errors, including asynchronous game-process failures. A failed launch no longer opens Settings.
- Quieter styling, shorter setup copy, collapsed graphics diagnostics, and layouts reviewed at 1360×920 and 800×600. The launcher update preference accurately describes checking for updates; in-place launcher updating is not included.

Install the package for your platform. The launcher installs its own client and matching Java into an app-owned directory and does not reuse another launcher's Minecraft files.

Validation covers unit, browser and real Electron fixture suites, transfer/account API loopbacks, site validation and packaged-bundle verification. Microsoft authentication and game execution were tested with fixtures, not real player credentials. Windows installers are built natively in CI; a clean Windows installation and real Microsoft approval/gameplay remain manual checks.

Installers are unsigned. Windows SmartScreen or Linux package-manager warnings may appear.

SHA256SUMS covers all four installers. Verify downloaded files with `sha256sum -c SHA256SUMS`.
