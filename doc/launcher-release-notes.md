# Easter Company launcher 1.0.32

The Easter Co. client gets a coordinated navy-and-brass interface and a more
reliable path from launcher to the public game server. Includes custom mod 2.0.1.

- The in-game main menu, NPC dialogue and shop item cards, crew scoreboard,
  boat cargo and ship-management screens share the Easter Co. visual theme.
- Crew, wallet and bounty displays receive private server-to-client updates.
- The launcher and in-game menu use the same published deployment metadata.
  A changed server target updates without reinstalling unchanged game content;
  the old in-game tailnet address is removed.
- Play requires confirmed server readiness for the current deployment. An outage
  or address mismatch leaves a clear retry instead of starting a disconnected game.
- Active downloads no longer fail merely because they last longer than three
  minutes. Stalled connections are bounded; pause suspends their deadline and
  cancel interrupts a blocked request immediately while preserving resumable bytes.
- Verified chunk updates retire obsolete managed files, preventing renamed mod
  JARs from loading alongside their replacements. Player-added files and files
  still shared by another installed chunk are preserved.
- A game shortcut's Play request survives a mandatory launcher update.
- The opening arrival plays once per launcher window session. Linked-provider
  details appear only when the account service supplies them.

This is a patch release: existing launcher caches, settings and sign-in sessions
are preserved. The required custom-mod payload updates through the normal verified
client update flow.

Validation includes launcher, publishing/privacy, browser and real Electron
journeys with isolated accounts and game-service fixtures, plus the custom mod's
Java harnesses and rendered UI review. These checks do not claim a fresh real-account
Microsoft sign-in, native Windows gameplay or a full multiplayer playtest.

# Easter Company launcher 1.0.31

Waiting for sign-in and account services now gives immediate, quiet feedback, and
the launcher knows who you are.

- Microsoft sign-in shows approval, verification, Minecraft access and Company
  connection stages. The code stays selectable while approval is pending, and the
  dialog stops asking for it as soon as approval lands.
- Slow account actions show an inline activity indicator and a patient reassurance
  after ten seconds, without extra popups or invented progress percentages.
- Account-database wakeups can retry an explicit temporary-unavailable response
  up to four attempts within ninety seconds. Cancellation stops the wait; unknown
  request outcomes and other account changes are never automatically replayed.
- Server startup keeps its existing three-minute readiness window and launches
  automatically once ready, with the same quiet waiting language.
- Your display name is what the launcher calls you, in the header and on your
  account, with your sign-in name kept as the smaller line beneath it.
- Until you upload a picture, a connected Minecraft account shows your character's
  own face as your avatar.
- An account that is already linked to Microsoft now says so, instead of offering
  a Verify button that could only ever be refused.
- Reduced-motion settings are respected and status updates preserve form focus.

Validation: automated account, desktop and browser checks plus an independent
visual and interaction review. Microsoft approval and server readiness are tested
with isolated fixtures; this does not represent a fresh real-account sign-in or
native Windows interaction test.

# Easter Company launcher 1.0.30

Microsoft sign-in works smoothly while the client downloads in the background.

- Selecting and copying the Microsoft code now survives download progress updates.
  A newly issued code still updates immediately.
- The error popup's close icon is centered, including on narrow windows.
- When the account database is waking from idle, Microsoft account setup retries
  its explicit temporary-unavailable response once instead of failing immediately.
  If it is still unavailable, the launcher asks you to try again in a moment.
- Cancelling sign-in cancels the retry too. Unrelated failures are not retried.

# Easter Company launcher 1.0.29

The client now installs and enables Smooth Third Person Camera, Fresh Animations,
its Player Extension and Dramatic Skys automatically, including their model,
texture and skybox dependencies. These remain enabled with Enhanced Graphics off.

- Grassier Grass accompanies the enhanced graphics download and activates only
  with Enhanced Graphics on and an installed shader pack selected in Iris.
- Switching Enhanced Graphics off now actually disables shaders and Grassier Grass,
  works offline, and keeps the downloads cached for next time.
- Automatic quality tuning writes Minecraft 26.2's current graphics options and
  applies conservative vanilla settings on a detected weak machine's first install.
- Resource packs load in dependency order and personal packs/options are preserved.
- All third-party content comes directly from publisher URLs with pinned releases
  and verified checksums. Updating visual content leaves the base game untouched.

Validation: automated desktop, publishing/privacy and browser checks; isolated
Minecraft 26.2 startup/resource reload with enhanced graphics off and on. This is
not a full in-world animation, sky or shader performance playtest. Native Windows
in-game rendering has not been exercised here.

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
