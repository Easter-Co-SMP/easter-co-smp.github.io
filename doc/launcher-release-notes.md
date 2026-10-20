# Easter Company launcher 1.0.37

The home cards load on the first launch, not the second.

- Launcher 1.0.36 could greet a first launch with "Dispatches unavailable" over the two
  new home cards, and then fill them in when the player pressed Try again. The first read
  of that document could arrive before the launcher window was trusted, and the refusal
  was never recorded anywhere, so the cards reported an outage that had not happened.
  The document is now read as soon as the launcher starts, so the answer is in hand
  before the home screen asks for it, and a first ask that still falls short is retried
  once, quietly, before the cards say anything is unavailable.
- Nothing else changed: the same document, the same bounds, the same honest empty and
  failure states, and the client controls are untouched.

# Easter Company launcher 1.0.36


The naval phoenix crest, a patient account service, and three cards on the home screen.
Includes custom mod 2.0.2 and preserves launcher settings, caches and sign-in sessions.

- The hero crest is a new piece of Easter Company art: an enamel shield in navy and
  antique gold with a block-built phoenix, a sailing ship on teal water and a printed
  `EASTER CO.` / `SMP` plate. The harbour behind it has been cleaned up too — two masts,
  clear square sails and purposeful rigging instead of a thicket of lamp posts and deck
  clutter, with the blue-hour palette untouched.
- Easter Company now has a mark rather than plain text: a fire-coloured phoenix sits
  beside the wordmark on every page, in the launcher header and in the browser tab, and
  the launcher, tray and desktop-entry icon are drawn from the same art.
- The launcher's home screen gains two cards beside the client controls: the latest
  dispatch from Easter Company, and a curated store highlight that opens a preview. They
  never block signing in, installing or playing, they load from the public site, and a
  preview says plainly that purchasing is not available yet.
- Every account journey now waits out a cold account service instead of calling it busy.
  Signing in with a password, claiming a username with the first password, changing a
  password, saving a profile and choosing a login email all keep trying a service that
  declares its database is still waking — up to ninety seconds across four attempts —
  with the same patience the Microsoft sign-in always had. Anything that could have
  changed something is still never replayed, and a refusal still ends the wait at once.
- A failure now says what happened and what did not: the account service is still waking
  up, nothing has changed, and the control that was pressed is the way to try again. The
  identifier already typed is kept; the password is not.
- The profile menu's own reads report inside the menu. Opening it used to put a spinner
  and "Contacting the account service" in the hero, a surface the player had not touched.
- Dialogs and their status lines fade in rather than cutting, and nothing moves at all
  when the system asks for reduced motion.
- An identity conflict reads the same way whichever sign-in path it arrives on: the
  account service's sentence, then what did not change, then the way out.

The website keeps its own headline and gains no launcher furniture; its hero is centred
as one unit. The crest and the harbour are served at the size the page draws them, which
took the launcher's first paint from 2.9 MB of imagery to 579 KB.

Validation covers 297 launcher unit tests, 104 site tests, site validation, the eight
browser suites and all 21 Electron journeys, including the cold-start recovery, provider
linking against the real account handler, and a journey that reads the dispatch document
through the real preload and main process with a hostile link and a duplicate in it.
As with every release, CI builds and packages the installers; it does not sign a person
in or launch the game, so the first real play on Windows remains manual.

# Easter Company launcher 1.0.35

The server row, the cold-start fix and the legal pages. Includes custom mod 2.0.2
and preserves launcher settings, caches and sign-in sessions.

- The server status paragraph is one small LED and one sentence: "Server Online
  (2 Active Players)", "Server Asleep Zzz (0 Active Players)", "Server Offline
  (Update in progress...)". Starting and stopping have their own words instead of
  being called offline, and an unreadable status says so rather than guessing. The
  dot repeats the meaning the sentence carries, so losing the colour loses nothing.
- A cold account service no longer reads as "The account service is busy right now".
  The launcher retries what is safe to retry inside a budget longer than one request,
  so the first launch of the day waits for the service to wake instead of failing on
  its first answer. Writes that are not safe to repeat are never silently replayed,
  and the server row keeps saying it is still checking rather than announcing a
  verdict it does not have.
- The Privacy Policy and Terms of Service are published, dated, and linked from every
  footer on the website and inside the launcher. They describe what the account
  actually stores, including the Microsoft session held server-side, and they state
  only the encryption the cluster really provides.
- The signed-out screen asks for the Easter Company account in one sentence, with no
  claim that signing in is a Microsoft sign-in. The account chooser stays usable in a
  short window, and a profile change cannot be made while a sign-in or a game is
  running.
- The map strip settles by measuring the room the notice band actually asked for,
  instead of waiting on a condition that never held, so the two stop overlapping.

Validation covers the launcher unit, browser and Electron suites, including journeys
that the release gate did not previously run: provider linking against the real account
handler, the username journey, the cold-start recovery path, and the legal links inside
the launcher. As with every release, CI builds and packages the installers; it does not
launch the game or sign a person in, so the first real play on Windows remains manual.

# Easter Company launcher 1.0.34

A standalone banking update, following the general client/UI release. Includes
custom mod 2.0.2 and preserves launcher settings, caches and sign-in sessions.

- The dedicated bank screen has separate transfer and coin-exchange tabs, private
  live balances, precise previews, safe Max amounts and transaction receipts.
  Keyboard input, focus and narration work in the native interface, including
  smaller windows. Successful transactions clear the submitted amount.
- Deposits, withdrawals and amount parsing refuse overflow instead of wrapping
  balances. Failed transfers preserve the original wallet and bank amounts.
- Coin exchanges check the exact available storage before charging. Compatible
  offhand stacks and partial stacks count correctly; empty equipment slots and
  incompatible named/component-bearing stacks do not create imaginary space.
  Coins are not silently dropped when an exchange cannot fit.
- Server-owned bank sessions reject duplicate, out-of-order, expired or invalid
  requests. Uncertain requests are not automatically repeated, and a late response
  cannot reopen a bank screen you closed.
- Existing balances and coin definitions stay unchanged. Older clients keep the
  native banker dialog and typed commands, using the same banking decisions.
- The inherited launcher sign-in chooser remains usable in short windows: every
  control can be reached by scrolling. Profile changes stay locked during sign-in
  and gameplay without discarding a focused control or draft.
- Authenticated launcher Play can wake the cloud server. Native in-game Play joins
  the configured public address but cannot wake a sleeping host; account credentials
  are not copied into Minecraft.

Validation includes all 45 mod harnesses with 586 banking assertions, real Fabric
keyboard/network tests of all four bank actions, replay/refusal and inventory
edge cases, a close/response race, and persistence after a clean server restart.
Launcher, public-export/privacy, browser and Electron release gates also run before
packaging. Minecraft's normal save/crash-durability rules still apply; these tests
do not represent native Windows gameplay or a fresh real-account Microsoft sign-in.

# Easter Company launcher 1.0.33

Signing in with your Easter Company username and password is now enough to play, on
any machine, without approving Microsoft again.

- Signing in with Microsoft once stores that session on your Easter Company account,
  held encrypted server-side. Signing in to the same account on another machine, or
  after logging out and back in, is ready to play with no Microsoft prompt of its own.
- A password sign-in no longer reads as an account with nothing attached. The launcher
  says "Sign in with Microsoft / Starts Minecraft as <your Minecraft name>" when it has
  to ask, and shows PLAY NOW when the account service already holds your session.
- Your Minecraft face is back in the header after a password sign-in. The launcher reads
  the head from your own Minecraft identity, which needs no credential, and caches it so
  a restart paints it immediately.
- An account with no Microsoft link at all is told to link one, in its own words, rather
  than being asked to sign in to something it has never connected.
- Profile & linked accounts gains "Sign out of Minecraft everywhere", which cuts every
  machine off at once. It reports only what the account service actually answered, and
  it is the deliberate way to end a stored session: signing out of the Easter Company
  account does not revoke it.
- When the account service cannot mint a session just now (it is busy, or rate-limiting),
  Play stays off and the launcher offers "Try again" instead of sending you through a
  Microsoft prompt that would not have helped.

Validation covers the launcher unit, browser and Electron suites, including a new
journey that signs in with a password against the real account handler and PostgreSQL,
plays from the server-held session, then signs Minecraft out everywhere and checks the
prompt comes back with Play off. As with every release, CI builds and packages the
installers; it does not launch the game or sign a person in, so the first real play on
Windows is still a manual step.

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
Start through the launcher for authenticated server wake; the native in-game menu
can connect to the configured host but cannot wake a sleeping host by itself.

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
