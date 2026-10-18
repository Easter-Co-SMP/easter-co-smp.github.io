# Easter Company launcher 1.0.17

You can now choose which of your verified emails signs you in.

- **Verified emails are listed in your profile.** Open your profile and choose **Verified emails**: every address the Easter Company account service has verified for your account is shown, with the provider it came from.
- **One of them is your login email.** The selected address is the one that works in the **Username or Email** field; the others are recorded on your account and cannot be used to sign in. Select a different one with **Save selection**, or clear the selection with **Clear login email** and sign in with Microsoft or your username instead.
- **Your address stays current.** Every Microsoft sign-in re-checks the address with Microsoft, so if you change the address on your Microsoft account the record follows it. If that address is already someone else's login email it cannot become yours — the launcher says so plainly and leaves your previous choice alone.
- **An address belongs to one account.** This is deliberate: an email can only ever be a login key for a single Easter Company account. If you have no free verified address, sign in with Microsoft or with your username.
- **Your username still leads.** The profile shows your Easter Company username, and your addresses appear only inside the Verified emails section.

Everything else from 1.0.16 is unchanged: username-before-password signup, sign-in by username, the optional game shortcuts that run the launcher so updates land first, and the client's display and control defaults.

Validation covers Node and Python unit tests, real PostgreSQL transactions through the repository's migration runner, and a full Electron journey against the real account API handler with a synthetic provider: signup with a username chosen first, sign-in by username, listing the verified addresses, selecting one, clearing it, and a password reset that never asks for the username. The deployed service was checked live with unauthenticated requests only. No real Microsoft approval and no real Graph consent were exercised, so address verification was proven with a synthetic provider, and no real account was created during testing.
