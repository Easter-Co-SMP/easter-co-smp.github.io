# Easter Company launcher 1.0.19

The wiki now contains twelve complete guides to the custom rules of Easter Co. SMP.

- Getting started, Health & death, The Easter Isles, Ships & sailing, and Wildlife & pets.
- Law & bounties, Money & banking, Crews & property, Cooking & crafting, Village services, Equipment & enchanting, and Raids & expeditions.
- Search includes instructions, tables and warnings. Ordered steps, short rule tables and direct guide links make the articles easier to use.
- The wiki works offline in the launcher and shares its content with the website. Original article URLs and renamed section links keep working.

The guides focus on installed custom mechanics, including death-loss exceptions, reverse rowing, bounty jurisdiction, banking input units, crew permissions and custom food/equipment recipes. They replace all demo articles and demo notices.

Gameplay content was checked against the installed Easter Navy mod, the loaded Matcha datapack and existing focused tests. Publication does not change gameplay rules or require a server restart. Website/browser and offline Electron checks cover the wiki; no real Microsoft login, Windows installer interaction or production gameplay transaction is claimed by this release.

This release also preserves the preceding sign-in update: clearer step-specific failures, one visible home for each failure, a fresh-sign-in fallback for an unusable saved Microsoft session, redacted bounded sign-in diagnostics, and the service email notice.

Signing in now tells you what actually went wrong, once, in one place.

- **One message, one place.** A failed sign-in used to appear twice at the same moment — a notice floating over the window and a copy inside the Settings dialog — and it came back every time you opened or closed a dialog. A failure now has exactly one home: the sign-in dialog while it is open, the notice at the top of the window otherwise. Settings never shows an error, and a message you dismiss stays dismissed.
- **Each step of the sign-in names itself.** "Sign-in could not finish. Please try again." is gone. The launcher says which part of the chain stopped — asking Microsoft for a sign-in code, Microsoft finishing it, Xbox Live, Minecraft sign-in, or reading your Java profile — and tells you what to do about it in words you can act on. Minecraft's answers are told apart too: a refused session, an account that may not play Java Edition, a service that is temporarily unavailable, and too many attempts in a short time all read differently. None of those messages shows a status code or an error string; those belong in the sign-in record below, not in front of you.
- **Login with Microsoft Account can no longer dead-end.** If the Microsoft session the launcher already holds cannot finish — expired, refused, or unreachable — it now carries on to the normal Microsoft sign-in and shows you the code, exactly as Forgot your password always did.
- **The one case that must stop, does stop.** If the Microsoft account you sign in with belongs to a different Easter Company account, the launcher now stops and tells you, instead of quietly carrying on and signing you in as somebody else. Nothing on your account changes, and it points you at the account switcher.
- **A message is never hidden behind a dialog.** If something fails while a dialog is open, the message waits and appears once you close it — with its dismiss control, once, still there until you dismiss it. You will never be left with a sentence you cannot read or a button you cannot press.
- **A sign-in in progress is never shown as failed.** An old message can no longer appear over a device code you are in the middle of typing, which is what made a working sign-in look instantly broken.
- **The Xbox Live step always uses the right permission.** Microsoft, not the launcher, decides which resource a sign-in token is issued for, and the email permission added in 1.0.17 meant that answer could come back for the wrong one. The launcher now checks and exchanges it for an Xbox Live token before asking Xbox Live, every time, instead of retrying silently.
- **A sign-in record you can read.** Every step of a sign-in writes one line to `signin.log` in the launcher's own data folder — time, launcher version, step, result, HTTP status and the service's code. It never contains a token, a sign-in code, an email address or a response body, it is capped so it cannot grow, and nothing but a sign-in writes to it.
- **The email notice.** If Microsoft's sign-in does not let the launcher read the address on your Microsoft account, the launcher now says so in the sign-in dialog and carries on — you can still sign in, and choose a login email later from your profile.

Everything else from 1.0.17 is unchanged: choosing which verified email signs you in, username-before-password signup, sign-in by username or by your selected email, the optional game shortcuts that run the launcher so updates land first, and the client's display and control defaults.

Validation covers Node and Python unit tests, the browser suite against a local preview, and Electron journeys through the real main process, including the cross-repo signup and sign-in journey against the real account API handler with a synthetic provider. The failure that prompted this release could not be reproduced with a real Microsoft account here, so the fix is proven at the level it can be: the sign-in chain was exercised against injected Microsoft, Xbox Live and Minecraft answers at every step, and the provider endpoints were probed live with unauthenticated requests only. The launcher now records which step fails, so if anything still refuses, `signin.log` names it.
