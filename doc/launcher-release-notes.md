# Easter Company launcher 1.0.23

Steam can now create and sign in to an Easter Company account, alongside Microsoft/Xbox. Discord and Google support is included and becomes available when valid owned OAuth registrations are configured. Discord remains disabled because its supplied credential was rejected by Discord during the live check.

- New accounts choose a unique Company username and password after provider sign-in. Linked providers can also recover a forgotten Company password.
- Profile & linked accounts lets you connect providers, edit your display name, and upload or remove a picture. Provider links are permanent and cannot be used to merge or switch Company accounts.
- The first provider supplies the initial profile where available; your Company name and picture can then be changed independently.
- Sessions renew while valid and remain in the same OS-encrypted launcher vault across updates. Systems without OS-backed encryption still require sign-in again after restart.
- Minecraft still requires a linked Microsoft/Xbox account with Minecraft Java access. Signing in with Discord or Steam does not grant game ownership.
- Add account and Switch Account have been removed. Interactive Microsoft reauthentication stays bound to the current Company account, including after a saved session fails.

Validation includes backend unit and disposable PostgreSQL tests, launcher unit tests, browser and real-preload Electron journeys, bundle freshness checks, and independent frontend review. The complete signup, linking, profile, restart and recovery journey uses synthetic upstream provider responses and an explicitly test-only encrypted vault. Live provider configuration is checked separately; these fixture tests do not prove a real user consent flow or a real desktop OS-keyring restart.
