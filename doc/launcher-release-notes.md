# Easter Company launcher 1.0.16

Your Easter Company account now has a username, and the Company ID is gone.

- **Choose your username before your password.** A new account picks a username first — 3 to 20 characters, lowercase letters, numbers, underscores or dashes — and the name is unique to you. It is checked as you type it, so you find out it is taken before you write a password, and a name that is held or refused says so in plain words. A username cannot be changed later.
- **Sign in with your username or email.** The direct sign-in field is now **Username or Email**: your chosen username, or the Microsoft email address verified for your account. The **EC-123** Company ID is no longer shown or needed anywhere in the app.
- **Login with Microsoft Account** is the button in the sign-in dialog, and it does what it says: it signs you in or creates the Easter Company account for the Minecraft profile you already own. Registration still works without Java ownership, and you will be asked for a username and password to finish.
- **Resetting your password never asks for your username**, and it still requires your linked Microsoft account.
- The account menu, the profile menu and the account switcher all lead with your username.

Everything else from 1.0.15 is unchanged: the client installs with your display and control defaults, the launcher stays open unless you choose close or tray, the optional game shortcuts still run the launcher so updates land first, and Enhanced Graphics works the same way.

Validation covers Node and Python unit tests, real PostgreSQL transactions through the repository's migration runner, and a full Electron journey against the real account API handler with a synthetic Microsoft provider: username-before-password signup, sign-in by username, wrong-provider rejection, a matching Microsoft reconnect, a password reset that never asks for the username, the Play gate, and no credential or email in renderer state. The deployed backend was verified live with unauthenticated probes and sign-in refusals only; no real Microsoft approval and no real Graph consent were exercised, so the email sign-in key was proven with a synthetic provider, and no real account was created during testing.
