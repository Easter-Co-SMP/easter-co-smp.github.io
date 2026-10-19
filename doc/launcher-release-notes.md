# Easter Company launcher 1.0.28

Launcher updates are now sized before they act. A small update costs you nothing, and the
bigger ones say what they will clear.

- A small fix - a patch release - changes nothing on your computer except the launcher
  itself. Your downloaded game, your settings and your sign-in are exactly where you left
  them, and nothing at all is deleted.
- An update that changes the launcher's own code - a minor release - clears only what the
  launcher can download again: the copy of the game it installed, the update files it had
  already fetched, and its own temporary caches. You keep your settings and your sign-in,
  and your worlds and screenshots stay where they are. It does mean the game downloads once
  more after such an update, because the client is rebuilt from scratch.
- A major release - one a saved sign-in may no longer be good for - also signs you out, so
  you sign in once and start clean. It removes nothing else of yours.
- Nothing outside the launcher's own folder is ever touched: not your own `.minecraft`, not
  a game folder you chose in Settings, not your Downloads, and not the Easter Co. server or
  world.
- Each launcher update writes one line to `launcher-update.log` in the launcher's folder
  saying which version you came from, which version you are on and what it cleared. It
  contains no account name, no password and no token.
- Which of the three an update is comes from the version numbers themselves, and
  `doc/launcher-states.md` publishes the table, so a release cannot quietly clear more than
  its own number says it will.
- One thing worth knowing: a map drawing you make in the launcher's own map is stored in the
  launcher's page storage, which a minor update clears with the rest of it.

# Easter Company launcher 1.0.27

Two things about signing in with a Company username:

- Capitals are no longer refused. Typing `OwenEaster` becomes `oweneaster` as you type,
  and the field tells you so, because that is the form you sign in with.
- The password minimum is 8 characters instead of 15, so a short password or a password
  manager's default both work. Very common passwords are still refused.

# Easter Company launcher 1.0.26

Microsoft sign-in works again.

- A fresh sign-in with a Microsoft account was being refused by Microsoft after you had
  already approved it in the browser: the launcher asked for the Xbox Live and Microsoft
  Graph permissions in one request, and Microsoft refuses that combination when it hands
  the sign-in back. The launcher now asks for Xbox Live only, and reads the account's
  email address separately, so signing in succeeds and the email is still shown when
  Microsoft allows it.
- Saved sign-ins and Company passwords are unaffected.

# Easter Company launcher 1.0.25

The first Play of the day now wakes the server instead of giving up on it.

- The launcher waits long enough for the account service to answer. That service scales
  itself to zero when nobody is playing, so the first request after a quiet night takes
  a few seconds to come back; the launcher used to stop waiting before it did, and Play
  then tried to join a server that was still asleep. It now waits for the answer, so Play
  starts the server and launches the game by itself once the server is up.
- Nothing else changes: same fixed server, same one-minute cold start, same retry, same
  honesty about a server that is not up.
- Warm sessions are unaffected - once someone is online the answer arrives in about half
  a second, exactly as before.

# Easter Company launcher 1.0.24

The launcher now points at one server, and that server can sleep between play sessions.

- The server address setting is gone. Every launch targets the Easter Co. SMP directly, so there is nothing to mistype and nothing to keep in step with the server. A launcher that already stored an address keeps working and simply ignores it.
- The server is stopped when nobody is playing. Pressing Play wakes it, shows an honest "starting your server" state, and launches the game by itself the moment the server answers. A first join in a session waits about a minute; once someone is online, everyone else launches immediately.
- If the server does not come up, the launcher says so once and Play is the retry. Signing in, downloads and updates never depend on the server being awake, and a sleeping server is never reported as online.
- The server now enforces real Minecraft authentication, so a player joins as their own account rather than as a name anyone could claim.

Validation covers the launcher unit and browser suites and the real-preload Electron journeys, including a cold start, a warm start, a wake timeout and an unreachable status service. The server side of the wake path is not enabled yet, so this release behaves exactly like 1.0.23 against a server that is running; the cold-start flow switches on when the wake service is deployed.
