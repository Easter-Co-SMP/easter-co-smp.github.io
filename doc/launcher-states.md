> Account behavior is updated by [Provider accounts](provider-accounts.md). The new
> contract supersedes Microsoft-only signup and Add/Switch account descriptions below.

## Provider account state

Account state adds public providers, primaryProvider and a PNG picture data URI or null.
Provider subjects, tokens and email addresses remain out of broadcasts. The state carries no
account list: `account` is the one signed-in Easter Company account, switchAccount is removed
from the preload and IPC handlers, and signing in while signed in is refused until the player
signs out. (Releases 1.0.23 to 1.0.31 still published an `accounts` array, empty in every
state; the field is deleted, and no view ever read it.)
Only the active Microsoft game credential is retained when migrating old vaults.
The sign-in chooser offers Microsoft, Google, Steam and Discord, with unconfigured
providers disabled. Product access is independent of Company sign-in.

New origin-checked main-process actions are account-providers, provider-sign-in(provider,
link), profile-update(displayName), and profile-picture(remove). File picking and decoding
stay in main; renderer input cannot supply a file path. Provider login without a linking
intent refuses replacement of an active account. Logout is the boundary before a new login.
The existing Company vault name and userData directory are stable across updates.
Startup and idle renewal extend valid sessions without changing recent-authentication time.

# Launcher state contract

Frozen interface between the Electron main process (`desktop/`) and the shared UI
(`site/`). The UI renders whatever this state says and never invents its own
requirements; the main process never decides what the hero looks like.

## Required flow

1. **Fresh install.** The hero's primary action is **Download the game** (the
   custom Easter Company client bundle, not the launcher). It is the only download
   control on the screen and it starts the download itself; the details under it
   describe the first-run install covered by *Home actions, Settings and enhanced
   graphics*: the installation location it will use, with the folder picker as the
   only way to change it, and what the machine's graphics setting will be. Starting
   the download is what creates investment.
2. **Once the download starts**, a sticky bottom bar appears (bottom centre,
   contents left aligned, themed progress bar, pause and resume, transfer speed,
   percentage). The hero simultaneously switches to **Sign in with Microsoft**,
   so the account request lands while the user is already waiting.
3. **Play is gated on both.** The Play action must not become available until the
   account is connected *and* the client is fully downloaded, verified and
   installed. Either alone is not enough.
4. **Installed and idle.** When there is nothing to download or resume, the
   launcher checks for client updates and applies them through the same pipeline
   and the same bottom bar. "Verifying" is not "updating": an update that finds
   nothing must stay quiet and must not flash a progress bar at the user.
5. **Everything green.** The hero primary action becomes a single large **PLAY
   NOW** button, in the place login and download used to occupy.

## State fields

Broadcast to every window through the existing `launcher:state` channel, merged
into the object `desktop.status()` already returns. Existing fields keep their
meaning. These are added or extended:

| Field | Type | Meaning |
|---|---|---|
| `phase` | string | One of `uninstalled`, `downloading`, `paused`, `verifying`, `installing`, `updating`, `ready`, `launching`, `starting-game`, `running` |
| `progress` | object \| null | `{label, percent, bytesDone, bytesTotal, bytesPerSecond, etaSeconds}`; `percent` null when indeterminate, and byte fields null when the underlying task cannot report them |
| `paused` | boolean | True only while a paused transfer can still be resumed |
| `install` | object | `{location, defaultLocation, installed, includeGraphics, version, updatedAt}`; `location` is the chosen root, `defaultLocation` the value shown as "default" |
| `actions` | array | Ordered remaining requirements, each `download` or `signin`. Empty means nothing is required |
| `canPlay` | boolean | Exactly `install.installed && profile !== null` |
| `bar` | object | `{visible}`: progress/action dock availability. The renderer omits an idle dock on Home because Home already provides the action; utility pages retain it. The minimised preference stays renderer-local. |
| `settings` | object | The saved settings, exactly as `status()` already returned them, so the Settings dialog refreshes from a broadcast as well as from a read. It carries no server address: the launcher's target is a constant, not a setting (*The one server the launcher targets*). |
| `game` | object | The game server's own state, always present in desktop mode: `{state, ready, endpoint, since, players, detail, message, waking, checkedAt}`. It is a different service from the account and shares no field with it; see *The game server, which may be asleep*. |
| `error` | string \| null | Safe operation failure text, announced in the one broadcast that carries it and dropped from the next, so no later unrelated broadcast can repaint an old failure; a new account action clears it as it starts. A sign-in failure names its step (see *Sign-in steps, sentences and the redacted log*). **It has exactly one home, and the UI decides it, not the state:** while the sign-in dialog is on screen the failure belongs to that dialog's own error area and to nothing else; otherwise it belongs to the page notice, with its dismiss control — but **not while any modal dialog is open**, because a notice under a modal is a message the player can neither read nor dismiss. For that time the sentence is held with no surface at all, and the last modal to close gives it back once. The Settings dialog is never an error surface. The renderer owns the sentence once delivered — it keeps it without re-reading this field, and only a dismissal or a new action (sign-in, Play, download, save settings) takes it away. A failure already given a home is never shown again by a later broadcast, a re-open or a close. Cancellation is not an error. Older states without this field still render. |

`canPlay` is the single source of truth for the Play action. No view may compute
its own version of the gate, and no view may enable Play on install completion
alone.

## The game server, which may be asleep (2026-10-18)

The game server is stopped whenever nobody is playing, because the hosting credit is a
limited one. In any given session the first player to press Play therefore pays a cold
start of about 60 to 90 seconds. Owen's requirement, verbatim: "we simply give the first
person to login a cold start load period simple."

The account service and the game server are two different services. Nothing about a
sleeping, starting or stopping server may ever present as an account problem, a purchase
problem or an installation problem, and nothing about the account may be described as a
server problem. That separation is why the game server gets its own state field, its own
sentence and its own failure, rather than a meaning borrowed from `actions`, `error` or
`phase: 'launching'`.

### The two routes, frozen with the cloud side

Both are on the **existing account API origin** (the constant in `desktop/config.cjs`,
overridable with `EASTER_API_BASE_URL` under the HTTPS-only rule), authenticated with the
existing Company session token as `Authorization: Bearer <token>`. There is no new host
and no new service. `desktop/accounts.cjs` owns the two calls, so they reuse that
module's bounded timeout, its HTTPS-only origin rule and its rule that no response body
ever reaches the renderer; `desktop/game.cjs` owns the rule below and its copy.

```
GET  /v2/game/status
POST /v2/game/wake

{state: "running" | "starting" | "stopping" | "stopped" | "unknown",
 ready: bool,
 endpoint: "smp.easter.company:25565",
 since: ISO-8601,
 players: int,
 detail: string}
```

Both routes answer with that shape; the wake's answer is already the first poll, and a
`204` with no body is accepted as "the request was taken" rather than guessed at.

- **`ready` is the only field that authorises a launch.** It is true only when the
  port answered a real Minecraft status exchange, so the launcher never infers it: a body
  that claims `ready: true` with any state other than `running` is refused and read as
  not ready. A ready server is joined at once.
- **`stopping` is not `stopped`.** It is never joined and never woken: waking a server
  that is on its way down is a second shutdown in the way, and joining it cannot work.
- Anything the launcher cannot read — an unreachable host, a 5xx, a body that is not this
  shape, an unrecognised `state` word — is `unknown`. It is never displayed as online,
  and an unrecognised state word is never acted on.

### The new field

| Field | Type | Meaning |
|---|---|---|
| `game.state` | string | One of `running`, `starting`, `stopping`, `stopped`, `unknown`, exactly as the service said. `unknown` also means "the launcher could not read the status". Never a claim of being online. |
| `game.ready` | boolean | The frozen `ready` flag, and the only thing that authorises a launch. `false` while `unknown`, while `stopping`, and whenever the answer is not `running`. |
| `game.endpoint` | string \| null | Unless nothing has been asked yet, the address the launcher will join: the one fixed target in `desktop/config.cjs` (`smp.easter.company:25565`, or the test-only override). **It is the launch target, not an echo of the answer:** a value the status service names is not read at all, because a launcher that woke one host and joined another would be worse than one that woke nothing. See *The one server the launcher targets*. |
| `game.since` | string \| null | The service's ISO-8601 timestamp, kept as written and dropped when it is not one. |
| `game.players` | number \| null | The service's player count, an integer or null. Published; not printed today, because a stopped server has nobody on it and the joinable case says nothing at all. |
| `game.detail` | string \| null | The service's own detail sentence, bounded to 200 characters, shown below the launcher's sentence. Never replaces it, and the service's other fields are dropped. |
| `game.message` | string | The launcher's own sentence for this state, from one table in `desktop/game.cjs`. The UI prints it and never composes or re-words it. |
| `game.waking` | boolean | True while this launcher is waking the server and polling it — the first player's cold start. |
| `game.checkedAt` | string \| null | ISO-8601 local time of the last status read attempt, or null when nothing has been asked yet in this session. |

### One Play press, one answer

The wake is requested **only** when the player presses Play (or the game shortcut, which
is the same path). It is never requested on app launch, on sign-in, on page navigation or
by a view. The only other thing the launcher does on its own is one read, at launch when
a Company session was restored and after an interactive sign-in, so the hero can say
honestly that the server is off before anyone presses anything.

The wait starts the moment Play is pressed, so the cold start overlaps the session
re-check and the client verification instead of being paid after them. Then:

1. **Warm (`ready: true`).** The game is launched immediately with the same arguments as
   before this change, including `--quickPlayMultiplayer <the launcher's one address>`.
   No wake, no prompt, no progress bar, no line on screen. This is the common case once
   somebody is online.
2. **`stopped`, `starting`, or the service's own `unknown`.** One `POST /v2/game/wake`,
   then `GET /v2/game/status` **every 3 seconds**. The instant an answer is ready the
   game is launched — inside the same Play press, so the player never presses Play twice.
   `phase` is `starting-game` for that time, the hero offers no second Play, and the
   sticky bar on every page says the same sentence.
3. **`stopping`.** Polled and waited out, never woken. If it turns ready it is joined; if
   it turns stopped it is woken, once.
4. **No answer at all.** `game.state` is `unknown` and `game.ready` is false. The
   launcher has no answer to respect, so it keeps the behaviour it had before this
   feature existed: it launches the client with its one fixed address, wakes nothing,
   and claims nothing. The player sees the unknown sentence, and the game's own
   connection result is the truth. **This is the one case where a launch happens without
   `ready`**, and it exists so that an unreachable status service can never leave the
   family unable to play at all.
5. **Still not joinable after 180 seconds.** The press fails honestly with
   `Your server did not become joinable within three minutes. Press Play to try it again.` No
   launch happens, no wake is sent a second time, and Play is the retry. A status
   service that answers `invalid_session` fails the press with the account's own
   sentence instead, because there the account really is the news.

`canPlay` is unchanged: Play is gated on the account and the installed client, and never
on the server, because pressing it is what starts the server. Nothing about the game
state disables sign-in, a download, an update, Settings or any account screen.

### The sentences

One table, in `desktop/game.cjs`, so every surface reads the same words. The copy is
fixed: it carries no time, no address and no number, so no view has to fill a blank in.

| State | Sentence |
|---|---|
| running and ready | `Your server is online.` (not printed: the line is absent when the server is joinable) |
| stopped | `Your server is offline right now. Play starts it.` |
| starting | `Your server is starting. This takes about a minute.` |
| stopping | `Your server is finishing its last session. It is never joined while it stops.` |
| unknown, after a read | `The launcher could not read the game server status just now.` |
| unknown, before any read | `Your server is checked when you press Play.` |
| waking | `Starting your server… the first player in a session waits about a minute.` |
| waking while stopping | `Your server is finishing its last session. It starts as soon as that is done.` |
| timeout (a failure) | `Your server did not become joinable within three minutes. Press Play to try it again.` |
| expired session (a failure) | `Your Easter Company session expired. Sign in again.` |

### The username and the password, as of 1.0.27

Two of Owen's rules, applied in every layer that states them:

- **A capital letter in a username is folded, never refused.** The username is stored and
  matched in lowercase, so the field converts as the player types (keeping the caret where
  it was), the client folds again before the availability probe, and the main process folds
  before validating. The help text says capitals are saved as lowercase. A name that is
  genuinely illegal is still refused with its own sentence; case alone never is.
- **The password floor is 8 characters, not 15.** The dialog's own `minlength`, the main
  process check, the client's copy of the sentence and the account service all say 8, and
  `tests/desktop/accounts.test.cjs` fails if any layer drifts. The service refuses the
  obvious short passwords by name (password, 12345678, qwertyui, minecraft and their
  neighbours), which a 15 character floor made unnecessary.

### How long each call is given, and why (1.0.25)

Two client ceilings, both owned here rather than derived, and both larger than the
service bound they must outlive. They are raised in 1.0.25 because the account cluster
they run on is **Aurora Serverless v2 at minimum capacity 0**, which scales to zero after
five idle minutes; the first request after a quiet spell waits for that resume, measured
on this cluster at **twelve to twenty seconds** (a first request after nineteen idle
minutes was still resuming when a twelve second retry budget ran out; the next request,
0.4 s later, took 3.5 s; the one after that took 0.46 s).

| call | ceiling | must outlive |
|---|---|---|
| `GET /v2/game/status` | `GAME_STATUS_TIMEOUT_MS` = 29 s | the service's 22 s resume retry plus its 4 s status probe, inside a 28 s function timeout and the stage's 30 s limit |
| `POST /v2/game/wake` | `GAME_WAKE_REQUEST_TIMEOUT_MS` = 27 s | the service's 12 s resume retry plus 6 s of watching a stopping host, inside the same 28 s function timeout |

The status ceiling matters most: it is the one read a player waits on with nothing else
in flight, so a ceiling below the resume aborts it, `game.cjs` reports `unknown`, and the
caller falls back to the bare join this feature exists to replace - against a host that
is asleep. A warm read still answers in about half a second, so a real player pays
nothing for the higher ceiling.

### Where it is shown

- **One line under the hero action** (`site/desktop.js`, `.desktop-game-status`), which
  carries `game.message` and, below it, `game.detail` when the service sent one. It is
  the only surface a game state is ever written on, and it is **absent** while the server
  answers ready, so a warm server looks exactly as it did before this feature existed.
- **The hero action** says `Starting your server…` with the note `The first player in a
  session waits about a minute` while `phase` is `starting-game`, and offers no second
  Play. It is disabled for that time, as it is during `launching`.
- **The sticky bar** carries the same `game.message` while `game.waking`, so the news
  follows the player to the map and the wiki.
- **A wake timeout is an ordinary operation failure**: it settles through `error`, so it
  reaches the player through the page notice with its dismiss control, exactly like every
  other failure, and the sentence keeps its one home. It is never written into Settings.
- The game line is never dimmed, always visible on Home, and never opens a dialog.

### What is proven, and what is not

The cloud side does not exist yet, so the two routes are proven against a local stub
(`tests/desktop/stub-game-api.mjs`) that can be told to answer any of the five states, that
records every wake call, and that refuses a request without the Company session token.
`tests/desktop/wake.test.cjs` proves the frozen shape, the copy table, the ready rule, the
`stopping` rule, the 3-second polling, the single wake per Play, the 180-second failure and
the unknown fallback, against a fake clock and against that stub over a real socket.

Not verified here, and not verifiable from this repository alone: the real cloud routes
(their existence, authentication, latency and the readiness probe behind `ready`), a real
cold start of the real server, and a real launch on Windows or macOS.

## The one server the launcher targets (2026-10-18)

Owen's instruction, verbatim: *"The launcher has a 'server address' settings option,
remove that, and make it only target the new production 'smp.easter.company' or ip
directly."* This supersedes the earlier published server choice — the `servers` state
field, the three bundled entries and the settings row that offered them — which is gone
from the contract, the state and the view.

**One address, in one place.** `desktop/config.cjs` owns it:

```js
const PRODUCTION_SERVER='smp.easter.company:25565';
function serverAddress(override=process.env.EASTER_SERVER_ADDRESS){ … }
```

The production host is live at `smp.easter.company:25565` (Elastic IP `3.151.255.100`,
DNS verified 2026-10-18), and the **hostname is the constant, not the IP**: the name
survives the address changing, and a number baked into a launcher release does not.

Two things read it and nothing else does: `desktop/install.cjs`'s `launchOptions()`, which
is what becomes `--quickPlayMultiplayer`, and `desktop/game.cjs`, which publishes it as
`game.endpoint`. That is the whole point of the change: the wake/cold-start path and the
launch path cannot be aimed at two different hosts, which a launcher that woke one server
and joined another would be. `tests/desktop/wake.test.cjs` asserts both sides together,
override included.

**A status answer never moves the launch target.** The two game routes answer with an
`endpoint`, and this launcher ignores it: the field is not read, `game.endpoint` is the
launcher's own address, and Play joins that. A service that named a different host — a
stale task definition, a second server, a mistake — must not be able to send a player's
client somewhere the launcher did not wake, and publishing an address the launcher will
not join is a claim waiting to be believed. If the service ever needs to serve two hosts,
that is a decision for this document and a second launcher release, not something an
HTTP response decides on its own.

**What was removed, everywhere.** No user-facing control lets a player choose or type an
address:

- the settings dialog's server row (`select[name=serverSelect]`, `input[name=server]`), its
  Custom-address option and its pending-entry note;
- the three bundled entries: `100.100.1.0:25565` (the tailnet address) as the default,
  `127.0.0.1:25565` as "This machine", and the `smp.easter.company:25565` placeholder that
  was `pending` because that name had no DNS record yet;
- the `servers` field of the state, so the renderer has nothing to build a choice from.
  A renderer handed a stale `servers` list by an older main process paints nothing: the
  browser suite asserts that;
- `server` from the saved settings, so `settings` in the state and in the settings file
  carries no address, and a save from the dialog sends none.

**An existing install keeps working, and its stored address is ignored.** Both household
settings files carry `"server": "100.100.1.0:25565"`. `cleanSettings` no longer validates
or returns that field: it is dropped, whatever it holds. It is deliberately *not* an error
case — a refused settings file would send a player through first-run setup again for a
field they can no longer edit — so a damaged or nonsensical value there is equally
harmless, because nothing reads it. The launcher starts normally, launches the client at
the production address, and drops the field the next time it writes the file. The
`settings` field of the state carries the same shape the file does: no address.

**The environment override is for tests and development only.** `EASTER_SERVER_ADDRESS`
exists because the suites need an address that is not production — the wake tests and the
loopback journey set it. It is read from the process environment, validated by the same
hostname/port rule that used to guard the settings field (`SERVER_ADDRESS` and
`checkServer` in `desktop/security.cjs`, now kept for this one caller), and it is:

- never exposed to the renderer: it is absent from `desktop/preload.cjs`, from
  `site/desktop.js`, and from every state field, so no view can read or set it;
- never a settings field: it is not written to `settings.json`, not sent by the dialog and
  not part of `settings` in the state;
- never set by a released launcher: an ordinary install always targets `PRODUCTION_SERVER`.

An invalid value is refused at the moment it is read, with
`EASTER_SERVER_ADDRESS must be a hostname or IPv4 address, with an optional port.`, so a
typo in a test run fails loudly instead of launching at a host nobody meant to name.

**What is proven, and what is not.** `tests/desktop/config.test.cjs` asserts the constant,
the removal of the three entries and `serverList`, the override's validation, that the
override is not reachable from the preload or the view, and that a stored address is
accepted and dropped. `tests/desktop/install.test.cjs` proves a settings payload naming
another server never becomes the launch argument. `tests/desktop/wake.test.cjs` proves the
wake state and the launch target are one value, with and without the override.
`tests/browser.mjs` proves the settings dialog has no address row and no mention of a
server at all, and that the save carries none. `tests/desktop/loopback.electron.mjs` starts
the real main process over a settings file that still holds the legacy address and asserts
the state carries no address and the file is not written back with one.

Not verified here: that the production host answers a real Minecraft join from a real
client. That is a playtest on a machine with an account, not something a suite can prove,
and the DNS record existing is not the same claim.

## One failure, one visible home (2026-10-18)

A single failed operation reaches the UI through two channels: `exclusively()` settles
one state carrying `error` and then rejects the account IPC promise with the same
sentence. The `error` field lives for that one broadcast — `notify()` drops an error a
broadcast does not itself carry, so a later unrelated broadcast can no longer repaint an
old failure — and the renderer dedupes by delivery, because the rejection carries the
same sentence. The UI must not turn that into two failures, two places, or a failure
that returns.

- **One home.** While the sign-in dialog is on screen, a failure belongs to that
  dialog's own error area (`.desktop-auth-error`) and to nothing else, because a
  failed sign-in is the sign-in dialog's news. With no sign-in dialog on screen the
  failure belongs to the page notice, once, with its dismiss control.
- **No page notice while any modal dialog is open (measured 2026-10-18).** A modal
  `<dialog>` — Settings, the mandatory update gate, the sign-in dialog, and the
  Easter Company account chooser, username and password dialogs — paints in the
  document's top layer and makes the rest of the page inert. A page notice under one
  is a message the player can neither read nor dismiss: dimmed by the modal's own
  backdrop at 1440 and 800 wide, completely covered at 390, with its Dismiss control
  behind the dialog box so that the click and the keyboard both go to the dialog. The
  earlier claim in this section — that the page notice keeps the sentence while
  Settings is open — was therefore false in the launcher, and it is withdrawn. The
  rule is: while **any** modal dialog is open, **no page notice is painted at all**
  and the held failure is drawn on no surface anywhere. The page notice is not dimmed,
  not covered and not made inert behind anything, because it is not there.
- **The last modal closing brings it back, once.** When the last modal dialog closes,
  the held failure returns on the page notice: the same sentence, exactly one surface,
  with its dismiss control, and keyboard reachable again now that the page is not
  inert. It then stays — through later broadcasts, re-renders, and other dialogs
  opening and closing — until the player dismisses it or starts a new action. A
  dismissed failure never comes back, and a modal opening again never duplicates it.
  The rule holds for every modal, not only Settings, and it is decided by the
  document's own open dialogs rather than by any one dialog's bookkeeping.
- **Settings is never an error surface.** The settings dialog carries the launch
  preferences, the shortcuts and the advanced client fields, and no status or failure
  area of any kind. A
  failure is never moved into it because it happened to be open, and opening or
  closing it never shows, repeats or brings back a failure — it takes the page notice
  away while it is open, and gives the same sentence back once when it closes.
- **Delivered once, then owned by the UI.** A failure is delivered when `error`
  becomes a sentence that has not been delivered yet, and the renderer keeps it from
  then on: it never re-reads `error` to decide whether the notice is still valid,
  because main drops the sentence from the next broadcast and a notice that depended
  on it would flash and vanish. Repeated broadcasts of the same sentence deliver
  nothing. Dismissing a failure, or starting a new action (sign-in, Play, download,
  save settings), clears what is on screen without making that sentence deliverable
  again — a stale repaint stays stale.
- **A running sign-in is never presented as failed.** While the sign-in dialog is
  showing its device code and browser action, or while a sign-in call is still
  outstanding, a sentence arriving from the state channel is not painted over them.
  A failure that really ends the flow arrives through the call that rejected, after
  which the dialog closes and the sentence takes its one home.
- **A closed dialog does not take its failure with it.** When the sign-in dialog
  closes while it was showing a failure, that sentence moves to the page notice as the
  last modal to close. It does not vanish, and no other dialog inherits it. If another
  modal dialog is still open at that moment the sentence stays held until the last one
  closes, exactly as the bullet above says.
- **The notice never sits on the copy.** The notice is a floating band above the sheet.
  Where the window is too narrow for the empty band above the hero card, the page
  reserves the height the notice needs, so at every width it reads above the hero card
  instead of covering the crest or the heading. A guide page has no hero card, and until
  2026-10-18 reserved nothing at all: the band landed on the guide's eyebrow line at 1440
  and on the sidebar's brand and search box at 800 and 390. The room is now reserved on
  the layout that holds the sidebar and the article (`site/wiki/wiki.css` reads the same
  `--launcher-notice-space`), measured from the first block of each column the band
  actually reaches, so no column starts under the band at any width.
  The map is neither case: it is a full-bleed chart with its controls docked on top of it,
  so the same variable moves that strip instead (`site/desktop.css`), measured from the
  topmost dock the band reaches — the map key, the drawing palette, the compass and the
  zoom controls. The band is narrower than the window, so a dock it does not reach at the
  current width moves with the others and the strip stays one row. The open key's legend is
  capped by the room left above **whichever edge it meets first — the chart's own footer or
  the launcher's sticky bar** — so it scrolls inside the key rather than sliding under
  either, with the bar counted only when it is laid out and standing over the key's own
  columns (at 1440 it is not, so the key there is untouched); one value
  (`--launcher-notice-key-space`) owns the rule and a key that already fits is published no
  cap at all. A dock the chart itself inserts after the notice is painted (the drawing
  palette, once its saved notes have loaded) re-measures it, and so does the bar when it
  moves, appears or goes away.
  The drawing palette's own panel follows the same rule rather than a viewport
  subtraction: it is capped by the room between its own top and the first edge under it —
  the chart's footer, or the sticky bar where the bar stands over the palette's columns —
  which `site/map/map.js` measures and publishes as `--drawing-panel-room` (the notice
  band's reserved height is already inside that number, because the band moves the whole
  strip), while `site/styles.css` keeps its own viewport subtraction as the other term of
  a `min()`, so a chart nobody has measured lays out exactly as it did and a measurement
  one frame stale during a resize can only tighten the panel. The palette's horizontal
  position is the stylesheet's at the width the window is at now, media query included:
  nothing caches the width the chart was loaded at, and an inline `left` is written only
  to clear the open map key.
- **Nothing is hard-coded.** The UI renders whatever sentence the state or the
  rejected call supplies; it does not compose or re-word failures.

**The identity conflict is the one refusal that stops the sign-in (measured 2026-10-18).**
`continue-microsoft` is an account action too, and it answers with the same whole result
(`{ok, value}`, or `{ok:false, error, code}`) instead of rejecting, because an Error
crossing the isolated preload arrives as its name and message only and a refusal decided
on its code must not be thrown. The refusal that stops the flow is `identity_conflict`:
the Microsoft account the service answered with belongs to a different Easter Company
account, so the chooser comes back carrying the refusal in three lines rather than one
paragraph. The account service's own sentence comes first — `Sign in with the Microsoft
account linked to this Easter Company account, or switch Easter Company accounts.`
(`desktop/accounts.cjs` MESSAGES.identity_conflict, which is also what the service's own
409 is mapped to, so the wording names both routes rather than the launcher-side one).
Then what did not happen, on its own line: `Nothing on your Easter Company account has
changed.` Then the action, which has to start by closing the dialog it is spoken from,
because the profile control it names is inert behind a modal: `Close this window first.
Then open your profile at the top of the page and choose Switch Account, or Add
account.` The sentence no longer uses "the linked account", which was an undefined noun
for someone who does not already understand a Company-account conflict, and it no longer
points at a control the player cannot reach. No device code opens, no second sign-in
starts, the signed-in account id is unchanged, and the failure is not announced on the
state channel at all — `state.error` stays null on that path, so the page notice never
paints the sentence, not even for one frame. Every other failure of the saved session
still falls through to the interactive sign-in with its device code. The account id
comparison stays server-driven, and no account identifier, token or address appears in
the sentence, the state or a log.
On a window too short to show all three lines at once, the chooser scrolls the refusal
into view rather than leaving its last line under the dialog's own edge: the least it can
scroll for the whole refusal to be inside the box, and nothing at all when the box
already shows it, so the refusal is still read above the form with Sign in and Forgot
your password below the fold. At the launcher's own 800x600 minimum the three lines fit
at once and the dialog keeps no scrollbar over space it cannot show.

**Microsoft's email answer is a notice, not a failure.** The sign-in answer may carry
`emailStatus` (`'stored'`, `'unavailable'`, `'none'`) at its own top level. Only
`'unavailable'` says anything: the sign-in dialog holds the sentence "We could not
read your Microsoft email address. You can sign in, and choose a login email later
from your profile." until the player closes the dialog, and `'stored'` and `'none'`
say nothing at all. No address is printed anywhere, and a build that answers without
the field renders exactly as before. The word comes from the account service's own
sign-in answer: `desktop/accounts.cjs` accepts only those three values and drops
anything else (including an address sent in that field), `enrolAccount()` carries it
on the sign-in result, and `desktop/main.cjs` returns it from the `sign-in` action —
it is deliberately not part of `launcher:state`, so no broadcast ever carries it.

It is a notice and never a failure, so **no failure paint clears it**. An unrelated
failure landing in the sign-in dialog's own error area leaves the email sentence where
it is, and the dialog never ends up an empty box with only its close control; only
closing the dialog ends the notice.

**Two smaller rules from the same review.** A failure raised by the enhanced graphics
toggle has one surface, beside the toggle, exactly as a refused install location is
shown beside the download action that tried it — main settles the sentence in state and
rejects the call as well, and the page notice gives up its copy of it. And a failure
raised by an install or a graphics change is never a second surface on the page notice.

## Bar behaviour

- Visible during a download/install on every page. When idle, Home uses its own
  primary action and omits the dock; Map and Wiki retain the dock's action after
  installation. There is never a second Play or sign-in action on idle Home.
- Minimised, it collapses to a side tab and shows **percentages only** while a
  download or install is active. When nothing is transferring it shows **PLAY
  NOW** or the **LOGIN / sign-in** action instead, according to `actions`.
- It can be minimised and re-opened. Its chosen state persists across pages and
  across restarts.
- Pause and resume are only offered while a transfer can actually continue.
- Progress is presented in the launcher's own visual language, not a raw OS bar.

## IPC

Existing channel naming and the origin-checked handler pattern stay as they are.
New handlers: choose or set an installation location, start an install with
`{location, includeGraphics}`, pause, resume, cancel, and check for updates. The
renderer never touches the filesystem, and no handler takes a path from anything
other than the folder picker or the saved setting.

## One entry point

Players enter the game through the launcher. The launcher is the only thing that
gets a shortcut, and it gets one for all users of the machine, with an optional
toggle offered during installation. An installed game does not get a system
shortcut of its own: the client lives inside the launcher and is started from it.
There is exactly one player-facing entry, and it opens the launcher, not a game
that skips it.

## Content chunks

The published manifest describes the client as named chunks, not one blob. A chunk
is a component bundle with its own version, its own file list and its own hashes:

- `base` is the game itself: the pinned Minecraft version, its libraries, its assets
  and the required client mods. Its Minecraft version is frozen for this server and
  will never change, so it is marked immutable: it is verified once and then trusted,
  and an update must not re-hash or re-download it.
- `graphics` is the enhanced graphics and shaders bundle. It is optional and is only
  downloaded when the player turns the toggle on.
- Further chunks may be added later, each independently versioned.

Update rules:

- A chunk whose recorded version and hash still match what the manifest publishes is
  not downloaded and not re-verified; only changed chunks are fetched.
- An optional chunk that is switched off is never fetched, and switching it off must
  not invalidate anything else.
- Inside a chunk, files are still individually checksum verified, and a mismatched or
  failed download replaces nothing.
- The installed marker records which chunk version is installed, so "nothing to do"
  is provable rather than assumed.

Chunking here means component granularity, not byte segmentation: a chunk is fetched
as regular verified files. Byte-level segmentation would only pay off for a single
very large object that changes often, which we do not have.

### The published shape

`site/data/client.json` gains one field, `chunks`. Every field it already had —
`minecraft`, `mod` and `dependencies` — keeps its exact former meaning and value,
because the launcher already installed on a machine reads only those. The chunk list
is published alongside them, and a launcher built before this change keeps working
unchanged. A manifest with no `chunks` list stays valid for that reason.

```
client.json
├── minecraft      "26.2"                 unchanged
├── fabric         "0.19.5"               added: the loader this client launches
├── mod            {name, version, sha256, bytes, url}   unchanged
├── dependencies   [{id, name, version, url}]            unchanged
└── chunks         [chunk, ...]           added
```

Each chunk carries exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `base` is the required frozen game chunk; `graphics` is the optional enhanced graphics and shaders chunk |
| `name` | string | Human-readable label for progress text |
| `optional` | boolean | `false` on `base`: it is always installed. `true` on `graphics`: an optional chunk that is switched off is never fetched |
| `immutable` | boolean | `true` on `base`: the frozen game. Verified once, then trusted; an update must not re-hash or re-download it. A required chunk must be immutable, or a stale copy could pass as current |
| `version` | string | The chunk's identity: a content digest, `sha256:<hex>` over the chunk's own file list. It changes when any file in the chunk changes and is byte-identical when nothing does. It is deliberately NOT the Minecraft version |
| `files` | array | At least one file; an empty chunk is refused |
| `fabric` | string \| null | The pinned Fabric loader, only meaningful on `base` |
| `java` | integer \| null | The required Java major version, only meaningful on `base` |

A chunk version must be a function of content, and the validator recomputes the digest
from the published file list and refuses a version that is not it. The reason is concrete:
our own mod jar lives inside the base chunk and is updated on its own schedule while the
Minecraft version is frozen at 26.2. If the base chunk version were `26.2`, bumping our mod
would leave the published version unchanged, an installed client would compare equal, skip
the chunk, and keep the old jar permanently, with nothing reporting a problem. The pinned
Minecraft version stays fully visible without being the identity: it is the manifest's
`minecraft` field, it is written into the base chunk's `name`, and it is carried beside the
chunk's own `fabric` and `java` pins. The validator refuses a base chunk that does not
repeat the Minecraft version in its name.

Each file entry carries exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The Modrinth project id, or `easter-navy` for our own mod |
| `name` | string | Publisher's project name |
| `version` | string | The pinned version; on our own mod, the jar's own version |
| `path` | string | Relative path, never absolute: `downloads/easter-navy.jar` for our own jar, the publisher's own file name for a dependency. Paths that are absolute or contain `..` are refused |
| `url` | string | `https://` for anything at a publisher (`cdn.modrinth.com` for mods), or our own relative path for the jar we redistribute ourselves |
| `hash` | string | `"<algorithm>:<hex>"`, `sha256` or `sha512`, and nothing else. The hash is the one the upstream publishes; a fabricated or truncated digest is refused |
| `size` | integer | Bytes, required and positive |

Rules the exporter and validator hold to:

- The chunk list mirrors the flat fields rather than replacing them. Every pinned
  dependency and our own mod appears exactly once, in the required base chunk, with
  the manifest's own version and, for our own jar, the manifest's own sha256 and size.
- The Fabric pin is read out of the shipped launcher's own source at export time. A
  launcher source that is present but whose pin cannot be read fails the export: the
  built-in value is a substitute only for a checkout with no launcher source to read,
  and it is announced in the export output when it is used. A remembered loader that
  the launcher no longer installs is the same bug as a stale bundle, one layer down.
- No file is described unless its publisher publishes a verified one. A dependency
  that cannot be confirmed is not quietly dropped: the export fails instead, because
  an incomplete base chunk is a false assertion about what a player's client contains.
- A file entry never claims a checksum the upstream does not publish. Third-party jars
  are downloaded from their publisher and are never committed to the repository.
- Nothing local, private or absolute enters the manifest: no player data, no local
  filesystem paths, no credentials. Resolution state is runtime state and lives
  outside `site/`.
- The exporter is deterministic: re-running it on unchanged inputs produces a
  byte-identical `client.json`.
- Chunks are absent until they have real content. The `graphics` chunk is published as
  of 2026-10-16: it carries the one shader pack the server's look is built on,
  Complementary Unbound r5.9.3, taken from that publisher's own artifact — its project
  id, its CDN URL and its own published sha512 — and the version is pinned in the
  exporter rather than resolved to "latest". An optional chunk that is switched off is
  simply not fetched, and its absence invalidates nothing else, which is still what a
  player sees before they turn the toggle on.
- **The chunk carries the loader, not just the pack.** Since 2026-10-17 the `graphics`
  chunk also carries Iris Shaders and Sodium (fabric, `mods/`), pinned the same way and
  verified against the same publisher. The reason is a defect Owen hit in 1.0.8: the
  pack was installed and `config/iris.properties` written, but the client had no shader
  loader, so nothing read either and the game showed no shaders while the launcher said
  they were on. A shader pack without its loader is not a feature, so the two ship
  together and a loader that cannot be confirmed refuses the export rather than
  publishing half a payload.

## Rules that still hold

- Downloads stay checksum verified, and an unverified or failed download replaces
  nothing.
- Sessions are only ever stored through OS-backed `safeStorage`.
- The client install is its own tree and never touches an existing `~/.minecraft`,
  another launcher's files, the server or the world.
- Personal drawings, player data and credentials never enter `site/` or Git.


## Launcher update

The launcher updates itself, so the next manually installed release is the last
one a player needs to fetch by hand. This reuses the hero's existing action,
stage and progress machinery rather than adding a second mechanism: the launcher's
own requirement is simply the first entry in `actions`, and it is driven by the
same dialog, the same sticky bar and the same progress fields as the game install.

The launcher never blocks its own UI on this. A player on a slow connection can
use the launcher while an update downloads, and the download is not a reason to
withhold anything.

| Field | Type | Meaning |
|---|---|---|
| `launcherUpdate` | object | Always present in desktop mode |
| `actions[n]` | string | Gains one new value, `launcher`, ordered **before** `download` and `signin` |

`launcherUpdate` is:

| Field | Type | Meaning |
|---|---|---|
| `phase` | string | `idle`, `checking`, `available`, `downloading`, `verifying`, `staged`, `error` |
| `percent` | number \| null | `0`-`100` while a measurable download is running, otherwise null. Never a placeholder |
| `bytesDone`, `bytesTotal`, `bytesPerSecond`, `etaSeconds` | number \| null | The same meanings and the same null rules as `progress` |
| `version` | string \| null | The version being fetched |
| `installedVersion` | string | The launcher version actually running |
| `message` | string | One short human sentence, safe to display as-is |
| `canApply` | boolean | True only when a verified update is staged and applying it is safe |
| `bar` | object | `{visible}`: whether the sticky bar carries this transfer, exactly as the game's `bar` does |

`available` is the phase the hero depends on: an update exists and is waiting for
the player to ask for it, so `actions[0]` is `launcher` and the hero offers the
button. `checking` is deliberately **not** an action phase. A check in flight must
not put a launcher button in front of the player, because most launches will find
nothing and the hero must not flicker a requirement that immediately disappears.
Only `available`, `downloading`, `verifying` and `staged` put `launcher` into
`actions`.

There is no startup gate and no phase that hides the launcher's own UI. The mist
arrival and the hero are revealed immediately and normally; the launcher update
proceeds alongside whatever else the player is doing, exactly as the game's
download does. An earlier draft of this section described a blocking startup
overlay. That is withdrawn: Owen's instruction is that a player on a slow
connection can explore the launcher while the launcher downloads.

`percent` is `100` only when a download genuinely reached 100 while `phase` is
`staged`; it is null in every other phase, including `available`, `error` and
`idle`. A failed or offline check never shows a completed percentage.

### The update is the app bundle, not the installer

An ordinary launcher update replaces the application's own JavaScript, HTML and
CSS. It does **not** re-download a 116 MB installer, and it does not require
elevation or a package manager on any platform. The staged payload is the app
bundle published as its own release asset alongside the installers, checksum
verified before it is accepted, and applied from a per-user location.

Replacing the Electron and Chromium runtime is a separate, infrequent path that
still needs a real installer. That path is allowed to be manual; the routine
update is not.

### Rules

1. **The launcher stays usable, but a check is not a settings moment.** There is
   no blocking startup gate: `downloading` and `verifying` leave the player free to
   use the launcher. While `phase` is `checking`, however, **Settings is not
   offered** — Owen's decision of 2026-10-17. The client settings are what the
   launcher writes and the check is what it is doing at that moment, so the dialog
   is unreachable until the check settles into `available`, `current`, `idle` or
   `error`. Nothing else is gated: the map, the game download and Play behave
   exactly as they do in every other phase. `checking` is therefore a real
   published phase, not an internal step: the main process sets it before the
   request leaves and clears it when the answer arrives.
2. **The launcher's requirement comes first.** While the launcher has an update
   to apply, `actions[0]` is `launcher`, so the hero offers it before the game's
   `download`. The hero renders it from `actions` exactly as it renders every
   other requirement; no view invents its own ordering.
3. **Nothing about the game changes.** `launcherUpdate` never writes to `phase`,
   `progress`, `paused`, `install`, `actions`' other entries, `canPlay` or the
   game's `bar.visible`. The launcher must not apply an update while `phase` is
   `running`.
4. **Failure is quiet and non-blocking.** An unreachable feed, a timeout, a
   checksum mismatch or a failed apply leaves the running launcher untouched and
   usable, reports `error` with a `message`, and does not hold anything closed.
   The player keeps working on the version they have.
5. **Never left broken.** Before an update is applied it is staged and verified;
   if the staged bundle fails to start, the launcher falls back to the version it
   was installed with rather than failing to open. A corrupt or unverified
   payload replaces nothing.
6. **The check is bounded** by a finite timeout, so `checking` cannot hang.
7. **Always emitted.** The desktop main process publishes `launcherUpdate` on
   every broadcast from the first one onward, including development, unpackaged
   runs and the test harness, so nothing can wait forever on a phase that will
   never arrive. An unpackaged run reports `idle` with `canApply` false.
8. **The player's data survives, except where the version says otherwise.** Settings,
   the saved session, the client tree and its chunks live outside the replaced files
   and are never migrated or rewritten by a launcher update. What the version change
   itself clears is the next section, *What a version change clears*: nothing at all
   for a patch, the cache for a minor, and the stored session for a major.
9. **`version` is the launcher, `install.version` is the game client.** They are
   unrelated and must never be rendered as if they were the same thing.

### What a version change clears (2026-10-19)

Owen's rule: "if only the patch is incremented between current client and the target
during the update process, preserve client side cache and user auth session. For minor
updates, the launcher should clear cache but keep the minimum required user/auth cache.
For major updates, clear cache, and any locally stored user session data. This also
provides a baseline for deciding what kind of increment a new release should have."

The launcher's own version number is therefore the whole statement of what an update may
destroy. `updater.cjs` `classify(from, to)` reads the two versions and answers `patch`,
`minor` or `major`; that answer alone picks the names that are cleared. A version it
cannot read is refused by name (`LauncherVersionError`, code `invalid-version`) rather
than guessed at.

| Level | When | Cache | `settings.json` | `accounts.enc` and `company.enc` |
|---|---|---|---|---|
| `patch` | only the third number moved | nothing is removed, and no directory is even read | kept | kept |
| `minor` | the second number moved and not the first | cleared | kept | kept |
| `major` | the first number moved | cleared | kept | removed, so the player signs in again |

Equal versions and a same-field downgrade both answer `patch`, which clears nothing: the
level names the largest clearing the pair justifies, and a pair that moves no number up
justifies none. A downgrade across a field is decided by that field, and clearing more is
the safe answer. `update()` only ever applies a strictly newer release, so neither answer
reaches the clearing code in practice.

**The bump a release takes is this table's decision, not its author's judgement in the
moment.** A change that can require a cleared cache is a `minor`. A change that can
invalidate a stored session, or that a stored session must not survive, is a `major`.
Anything a new bundle fixes without either is a `patch`, and that is the only level that
promises the player an update costs them nothing at all.

**Exactly what is cleared is one list, and clearing iterates it.** The table is
`desktop/updater.cjs` `CLEAR`; each member carries the reason it is expendable. The data
directory is never enumerated as a whole, so a file the launcher did not think about — a
dialect dictionary Chromium keeps, `install.log`, `launcher-update.log`, anything the
player put there — survives by not being on the list. The members cleared at `minor`:

| Member | Why it may go |
|---|---|
| `minecraft` | The client tree the installer built: versions, libraries, assets, mods, resource packs and `installed.json`. Every file the launcher wrote into it is a copy of something the published client manifest describes, so a minor release gets a fresh client instead of a half-stale one. The tree is emptied one level deep, so three things inside it stay: `.easter-client` (the marker that proves the folder is the launcher's rather than another installation's), `saves` (the worlds the player made on this computer) and `screenshots` (the pictures they took). |
| `launcher-updates` | The downloaded launcher payloads, except the one the update has just staged. A payload is a release asset that can be fetched again; the staged one cannot, because `bootstrap.cjs` loads it from `current.json` on the relaunch, and removing it would relaunch into the version being replaced and re-download the same update on every start. So `current.json` and the payload it names stay, every older payload goes, and a stash whose record cannot be read is left entirely alone rather than guessed at. |
| `Cache`, `Code Cache`, `GPUCache`, `DawnGraphiteCache`, `DawnWebGPUCache`, `ShaderCache`, `GrShaderCache` | Electron's HTTP, compiled-script, GPU, pipeline and shader caches for the launcher's own pages. Their keys and artefacts belong to the bundle being replaced, and the new bundle rebuilds what it needs on the next start. |
| `blob_storage`, `Local Storage`, `Session Storage`, `WebStorage` | The bundled pages' renderer storage. Nothing the launcher needs across a version change lives here: settings are in `settings.json` and sessions are in the vaults. `IndexedDB` is deliberately **not** cleared at any level: it holds the map's drawing layer, and a drawing is content the player made rather than a copy of something we published. |
| `signin.log` | The bounded redacted record of the sign-in legs. Its steps belong to the code being replaced; it carries no credential, so removing it loses diagnoses and nothing else. |

A `major` adds exactly three members, the stored sessions: `accounts.enc` (the saved
accounts and the Microsoft/Minecraft session), `company.enc` (the Company session token,
the other half of the same sign-in) and `account.enc` (the single-account vault an install
from before the account list may have left behind).

**Nothing outside the launcher's own data directory is ever removed.** `configRoot()` is
`app.getPath('userData')`, the per-user `Easter Company` directory, and every path is
resolved inside it before anything is removed; a name that resolves anywhere else is
refused by `withinDataDirectory` rather than followed. There is no rule that reaches the
player's real `~/.minecraft`, another launcher's files, the server, the world, `Downloads`,
or an installation folder the player chose in Settings: a client tree outside the data
directory is the player's, and an update does not clear it. A listed entry that turns out to
be a symbolic link is removed as a link, and its target is never entered.

**One line per decision**, in `launcher-update.log` beside the other two logs. It has its
own file because the line has to carry the from/to pair and the names it cleared, and
`signin.log` and `install.log` are single-token-per-field logs that cannot hold that. The
values are a validated version, one of the three level words and the constants from `CLEAR`,
so no path, no player data and no credential can reach the line; anything else is written as
`-`. A real minor update writes one line like:

```
2026-10-19T12:00:00.000Z v1.0.28 step=update-policy outcome=ok level=minor from=1.0.27 to=1.1.0 cleared=minecraft|launcher-updates|Cache|...
```

**An update that cannot clear still applies.** The clear runs on the relaunch path only,
after the new bundle is staged and verified, and it is skipped while the game is running (a
client tree removed under a live Minecraft is a broken game; an update that waits for one
restart is not). One member that cannot be removed — a payload the old process still has open
on Windows is the real case — is recorded and the rest of the list still happens, so one
locked file cannot leave the session vault and the client tree behind. The line then reads
`outcome=failed` with `failed=` naming that member, and the update proceeds either way: the
player is never held on an old launcher by a cache the next start retries.

The clearing is drivable without Electron — `clearForLevel` takes an injected filesystem and
removal function — which is what lets `tests/desktop/updater.test.cjs` prove the matrix on a
fixture directory: a patch asserts zero removals and zero directory reads, a minor and a
major assert every listed member gone and every unlisted file, `settings.json`, the world
save and the pictures still there.


One exception stands outside that table: **`IndexedDB` is never cleared**, at any level. It
holds the map's drawing layer, and a drawing is something the player made rather than a copy
of something we published, so no version change may delete it. A future release that
genuinely needs it migrated gets a migration, not a silent wipe.

## Home actions, Settings and enhanced graphics

Owen's review of the shipped launcher on 2026-10-16 fixed where each control
belongs. The install actions and the settings are no longer the same surface, and
the graphics choice is a player-facing toggle instead of a checkbox buried in an
install form.

**Settings is a settings-only dialog, and only the Play Now stage has it.** It is
the hero's secondary action, exactly as *Account menu and installation recognition*
already said; the header has no client settings button and never had one in the
contract. The dialog contains client settings and nothing else: launch preferences,
the shortcuts and memory and Java as client settings, and the version footer. There is
no server address row at all — the launcher targets one fixed production server, see
*The one server the launcher targets* — and an existing file's stored address is never
offered back. Account
management belongs to the profile popover. The
installation folder is not one of them: choosing where the client lives belongs to
the download details that do the installing, and offering it in a dialog that cannot
install anything is how the shipped launcher ended up showing a bare "Default:
<path>" line with no purpose. It never carries a download, install, update or play
action, never carries the sticky bar's transfer, and never carries a status hint
about what the player still has to do. When the player is not yet at the Play Now
stage, Settings is not offered at all.

**One screen carries one action.** A screen never offers the same function twice, and
Home shows exactly one way to start the download: the hero's **Download the game**
action, which starts it. The first-run details under that action (installation
folder with its **Choose folder…** picker, and the machine's automatic graphics
answer) are supporting text with no action of their own, because a second *Start
download* button on the same screen is the first one again. The details carry no
status line either: the launcher must not print a second, vaguer hint such as
"Download the game to get started.", and a refused folder is reported beside the
folder choice it belongs to.

**Enhanced Graphics & Shaders is a themed toggle under the hero action.**
Visible once `install.installed` is true, placed below the hero's primary action,
labelled **Enable Enhanced Graphics & Shaders**. It is the only graphics control in
the launcher; the first-run details state what the automatic choice will be rather than
offering a second copy of the control. Flipping it on fetches the optional
`graphics` chunk through the existing verified pipeline and the sticky bar, and
writes the client's own quality settings. Flipping it off disables Iris shaders and
Grassier Grass without downloading anything or invalidating the base chunk; cached
shader files remain available for the next enable. Render distance and personal
settings survive switching the effect off.

**The machine decides the default, once, honestly.** "On unless the GPU is clearly
weak": integrated graphics and a software renderer (llvmpipe, SwiftShader) are
clearly weak, so enhanced graphics stay off there. An adapter the platform will not
identify is not known to be weak, so the toggle is offered on and the launcher says
so plainly instead of pretending to know; `tunable` is false for such a machine,
which means no quality level is promised and none is written. The player's explicit
choice always wins from then on and is never re-decided behind them.

| Field | Type | Meaning |
|---|---|---|
| `hardware` | object | Always present in desktop mode |
| `graphics` | object | Always present in desktop mode |

`hardware` is `{gpu, vendor, vramMB, tier, reason}`: `gpu` is the adapter string as
the OS reports it, `vramMB` is null when the platform will not say, `tier` is
`capable`, `weak` or `unknown`, and `reason` is one short sentence safe to display,
for example "Discrete GPU with 8192 MB of video memory."

**One GPU: the primary display GPU.** Owen's decision of 2026-10-17: the launcher
targets exactly one adapter, and it must be whichever adapter drives the display,
never a second card that happens to be present. The answer is resolved in this
order and stops at the first one that resolves:

1. the card with a connected display output (`/sys/class/drm/card*-<connector>/status`
   reading `connected` on Linux);
2. the firmware's primary VGA device (`boot_vga`, Linux) when no output reads
   connected, which is the case on a headless seat whose display is synthesised;
3. the adapter the platform itself reports as active (Chromium's `active` device),
   which is all Windows and macOS offer;
4. otherwise unknown, which is not the same as weak.

Order matters because `boot_vga` is not the display GPU on every machine: on this
household server it names the headless RTX 3060 while the monitor is wired to the
RTX 4060, so preferring it would describe and target the card the player is not
looking at. `reason` describes that one adapter and never mentions how many other
adapters exist: the launcher has one answer, so it gives one. The launched client
is pinned to the same adapter where the platform has a way to say so (the NVIDIA
and Mesa render-offload variables on Linux); where it does not, the operating
system's choice is the only one, and the launcher does not pretend to override it.
The quality ladder follows that adapter's own video memory, and it is allowed to be
more aggressive than the household's hand-tuned profile: the launcher's job is the
best settings the player's display GPU can carry.

`graphics` is `{enabled, recommended, tunable, tuned}`: `enabled` is
`install.includeGraphics` under its player-facing name, `recommended` is the
automatic answer for this machine, `tunable` is false when this platform cannot
report enough about the GPU to promise a quality level, and `tuned` is
`{renderDistance, shadowDistance, shaders}` actually written into the client.

**The display defaults come from the install and from startup, not from this toggle.**
Owen's requirement is that a new player's first launch is already fullscreen, at a GUI
scale their own display can read, so the launcher writes `guiScale` and
`fullscreen:true` into the client's own `options.txt` whether Enhanced Graphics is on or
off: from the install pipeline, and also from the startup path of a tree that is already
installed, because a returning player's update check finds nothing changed and never
reaches the install pipeline at all. The optional graphics chunk is never required for
them, and they are not part of the quality step `tuned` reports. The seed happens once
per client tree and is remembered by `.easter-client-display` inside that tree rather
than in `installed.json`, so it cannot race the pipeline's own atomic write of the
install marker. After the record covers a key the launcher never rewrites it: a value
the player or the game changed later is theirs, and the only later write is a repair of a
recorded key that has gone missing. A tree without the launcher's marker file is
refused, exactly like the quality files, and the seed never runs while a client process
is up, because a running client rewrites `options.txt` on exit. None of this adds a
field to the state contract, and the UI never mentions it.

**The seeded controls are the household's layout, and the whole approved set is pinned.**
The same once-per-tree seed writes the following into that client's `options.txt`:

| Key | Seeded value | Vanilla value | Why |
|---|---|---|---|
| `key_key.sneak` (crouch) | `key.keyboard.left.control` | `key.keyboard.left.shift` | swapped with sprint |
| `key_key.sprint` (sprint) | `key.keyboard.left.shift` | `key.keyboard.left.control` | the other half of that swap |
| `key_key.inventory` | `key.keyboard.tab` | `key.keyboard.e` | tab is where the household keeps it |
| `key_key.playerlist` | `key.keyboard.grave.accent` | `key.keyboard.tab` | frees tab for inventory |
| `key_key.togglePerspective` | `key.keyboard.r` | `key.keyboard.f5` | third person on R |
| `key_key.chat` | `key.keyboard.enter` | `key.keyboard.t` | chat opens on enter |
| `key_key.toggleGui` | `key.keyboard.f10` | `key.keyboard.f1` | the GUI toggle moves off F1 |
| `key_key.socialInteractions` | `key.keyboard.i` | `key.keyboard.p` | the social screen sits on I |
| `key_key.smoothCamera` | `key.keyboard.right.shift` | unbound | smooth camera gets a key of its own |
| `key_key.debug.*`, 22 actions | `key.keyboard.unknown` | F3 and its combinations | the debug keys are unbound |
| `key_key.shippy-ships.isPressingCtrl` | `key.keyboard.right.control` | none — the mod's own Left Ctrl | deferred, see below |

The 22 debug actions are pinned by name, because that is the set this client writes:
`debug.clearChat`, `copyLocation`, `copyRecreateCommand`, `crash`, `debugOptions`,
`dumpDynamicTextures`, `dumpVersion`, `focusPause`, `fpsCharts`, `lightmapTexture`,
`modifier`, `networkCharts`, `overlay`, `profiling`, `profilingChart`, `reloadChunk`,
`reloadResourcePacks`, `showAdvancedTooltips`, `showChunkBorders`, `showHitboxes`,
`spectate` and `switchGameMode`. `key.keyboard.unknown` is the client's own word for an
action with no key, so those 22 rows are unbinds and not invented bindings. An action the
client stops writing is a name to remove from that list rather than a key left half-bound.

The sprint/crouch pair is swapped on purpose, exactly as Owen asked, and that is the
point of the change rather than an accident or a player's rebind: sprint on Left Shift
and crouch on Left Ctrl is how the household and most other games are laid out, so
**Ctrl is crouch in a client this launcher installs**. The values were read off the real
clients rather than guessed: every row above except Shippy's is what Owen's own
`~/.minecraft` already plays while a launcher-installed tree is still vanilla, which is
the gap this seed closes, and Shippy's row is the one move his tree does not have yet
because that tree is not launcher-managed. A fresh tree gets everything in that table
except the one deferred row in a single write.

**Unbinding the debug keys is player-visible and deliberate.** The client's F3 debug
overlay is `debug.overlay`, and every other debug combination is one of those 22 actions
(`debug.modifier` is the F3 half of the F3+key chords). Unbound, a seeded client has **no
F3 debug overlay at all** — no chunk borders, hitboxes, chunk-reload or F3+ combinations —
until the player binds them again in the game's own controls screen, which is always
allowed: a key the record covers is theirs from then on. Anyone debugging a client this
launcher installed should expect that and rebind rather than assume a broken client.

**Inventory and the player list move together.** Inventory takes `tab`, which is
vanilla's player-list key, so applying one without the other would leave two actions on
one key. Whenever either member of that pair is written, the seed writes both; a member
the player is already carrying is only written when its present value is exactly the key
a sibling is taking, so a player-chosen player-list key of their own survives a repair.
After any seed, no two of the seeded actions share a key.

**The Shippy Ships hotkey moves off Left Ctrl, and waits for the mod to exist.**
`key.shippy-ships.isPressingCtrl` ("Quick Build (Use Stack)") is the mod's own binding and
it registers on Left Ctrl — every household `options.txt` carries it there — which crouch
now owns. The seed moves it to `key.keyboard.right.control`: that keeps the mod's Ctrl
intent, collides with no vanilla key and with no other seeded action, and leaves Left Ctrl
to crouch alone. But this row cannot be written like the others. A mod-provided binding does not exist in `options.txt`
until the mod has registered it, and the vanilla client only persists the key mappings it
read: a `key_` entry for an unknown action is dropped the next time the game saves, so
writing this key into a tree that has not run with the mod is silently lost — and worse,
marking it covered then would mean it is never seeded once the mod does arrive. So the
seed treats it as **deferred**: the key is written only when it is already present in
`options.txt`, it is not marked as covered in the record until it has actually been
written, and it is re-checked on every seed run. The net effect is that a new install
seeds everything else immediately, and the Shippy hotkey is fixed on the first launcher
start after the client has run once with the mod. Once it has been written it is a normal
covered key and is never rewritten. A tree whose `options.txt` is recreated loses the
line, so the record releases the key rather than keeping a claim on a binding the tree no
longer has, and the seed pins it again as soon as the client writes it again — which is
the same repair every other seeded key gets, deferred to the moment it becomes writable.
The one household tree whose free-camera mod keeps `hold_zoom` on Right Ctrl is Hannah's
own choice of key: the seed touches no mod key but Shippy's, so it stays where she put it.

Two further consequences to keep in mind when reading a bug report. Moving the player
list moves the Easter Navy crew menu with it: the mod registers no key of its own, it
opens while vanilla's player-list key is held (`client.options.keyPlayerList` in
`TabMenu`), so after a seed that menu follows the player list to the grave key and `tab`
is inventory. And no mod writes `options.txt`: the vanilla client owns that file and
persists whatever it finds there on exit, which is why seeding it is neither redundant nor
fighting a mod — and why a binding for a mod that has not registered it would not survive.

**Coverage is per key, and the record's schema is history.** The record is versioned, and
the schema records what each build added for a human reader: schema 1 covered `guiScale`
and `fullscreen`, schema 2 the five bindings Owen plays with, and schema 3 the rest of the
approved set above. The schema is metadata and nothing more. What decides whether a tree
is seeded is the record's `values`: they are the set of keys the launcher has had its say
over. A tree holding an older record therefore gets exactly the keys that record does not
cover, once — so a schema-2 tree gets the four new controls, the 22 debug unbinds and the
Shippy hotkey if the client has written it, and nothing else — while every value it
already covers, including ones the player has since changed or rebound, is left
byte-identical; the record keeps its original `appliedAt` and gains an `updatedAt` (and an
`upgradedAt` when the schema was raised). After that, a present key is the player's again:
a player who rebinds sprint back to Ctrl, or the player list onto a key of their own,
keeps it through every later launcher run and update, and the only write left is repair of
a covered key that has gone missing, bindings included. A record carrying a schema this
build does not know is left alone rather than pulled back down to it, and this build does
not extend it with keys it has never seeded for that tree.

**The GUI scale follows the display, and is read in physical pixels.** Owen's follow-up
of 2026-10-18: a flat GUI scale of 2 is right on an ordinary display and too small on a
high-resolution one. `displayGuiScale` in `desktop/hardware.cjs` is the whole rule, a
pure function of a pixel size:

| Physical height | `guiScale` |
|---|---|
| 2160 (2160p and up) | 4 |
| 1350 (1440p, 1600p) | 3 |
| anything shorter, down to the smallest display | 2 |
| no usable size reported | 2 |

Height is the axis that binds: a 21:9 1440p display is as tall as any other 1440p one,
and the interface a player runs out of room on is the vertical one. 1080p deliberately
stays on the bottom rung, so both household machines keep the 2 they are tuned to, and
the table stops at 4 because that is as far as the launcher is willing to go on a
high-resolution display we have not played on — a limit of ours, not a claim about what
the client itself allows. A rung the display cannot actually show is not written either:
the client needs 320x240 pixels per scale step, so a display too small to fit the wanted
rung gets the lower one it does fit (on a very small screen that is 1), rather than being
recorded at a scale the game would silently reduce. An unusable answer from the caller
is not invented into the file; the seed writes the documented fallback of 2.

The scale is computed from the display the client will actually open on, measured in
**physical** pixels: `screen.getPrimaryDisplay()` in the main process, inside
`app.whenReady()`, and `display.size * display.scaleFactor` rather than the
device-independent size, because a 2160p screen at 200% scaling describes itself as
1080p and its interface is still laid out in 2160 physical lines. The primary display is
meant: the client opens fullscreen, and a fullscreen window opens on the primary display,
the one the player is looking at. That value is passed through `installClient` into the
seed, so the startup seed and the install-pipeline seed cannot disagree. The record
stores the value that was applied, and a repair reuses it: a launcher moved to a second
screen never re-decides a tree that has already been seeded, and a player who changes the
scale in game keeps their choice.

There is no server field and no `servers` list. The launcher targets one fixed
production server, published by nothing and editable by no one: see *The one server the
launcher targets*.

**Easter Company is the primary identity.** The profile popover leads with the
Easter Company username, then names Microsoft/Xbox as its linked provider.
Signed-out users get a sign-in chooser offering Microsoft sign-in and a direct
username-or-email/password login. New accounts choose their username before their
first password, and accounts without a password must complete setup before Play.
No Company ID is shown or asked for anywhere in the sign-in flow. The memory
control remains an explained advanced setting.

**The launch-time preferences are the player's choice, and the two of them are linked.**
Both are persisted with the rest of the settings, both default off, and neither is ever
re-decided behind the player. The two update preferences are pinned on by *Mandatory
update gate*:

| Setting | Default | Meaning |
|---|---|---|
| `autoUpdateLauncher` | on | Keep the launcher itself current. Applying an update in place is not built yet, so this governs the version check and the notice in the settings dialog; nothing is installed by it. |
| `autoUpdateGame` | on | Keep the installed game client current. When off, no update starts on its own and a launch never begins a transfer the player did not ask for. |
| `exitOnLaunch` | off | Close the launcher when the game starts. |
| `trayOnLaunch` | off | Minimise the launcher to the system tray when the game starts, offering **Open launcher** and **Quit**, and bring the window back when the game ends. |
| `desktopShortcut` | off | Put a game shortcut on the desktop, and remove it again when unticked. |
| `startMenuShortcut` | off | Put a game shortcut in the Start menu (`~/.local/share/applications` on Linux, the per-user Start menu on Windows), and remove it again when unticked. |

**Starting the game moves the launcher exactly one way.** Owen's review of 2026-10-18: with
neither preference on, the window is left exactly as the player had it; with `exitOnLaunch`
the launcher quits behind the game as it always did; with `trayOnLaunch` it hides instead of
closing. The decision is one pure function, `launchBehaviour` in `desktop/security.cjs`, so
what the window does is testable without a window and without a tray.

**The two settings are mutually exclusive, and the main process enforces it.**
`cleanSettings` resolves the pair, so a payload that claims both is not left to the view:
both are resolved **off**. Once the migration below has run, a file carrying both cannot
even be a leftover from an older build — it is hand-edited or damaged — so neither
do-anything-visible behaviour is inferred from it, and quitting behind the game, the more
destructive of the two, is never read out of an ambiguous pair. The dialog enforces the
same rule from the other side: ticking either switch unticks the other, and a state that
somehow carried both never leaves the dialog showing both. A value that is not a boolean is
not coerced; it falls back to the documented default of off.

**The old default is migrated once, so the change actually reaches an existing install.**
A settings file written before `trayOnLaunch` existed came from a build whose default was
to close the launcher behind the game, and it cannot say whether that was ever chosen: both
of this household's machines carry `"exitOnLaunch": true` verbatim from `cleanSettings` on
that old default, in `/root/.config/Easter Company/settings.json` and
`/home/owen/.config/Easter Company/settings.json` alike. On load, a saved file with no
`trayOnLaunch` is therefore resolved to both off and **written back once** with the field
present — the write is what makes it happen once. From then on the file is the player's own
record: a file that already carries the field keeps whatever pair it holds, in both
directions, and is never migrated again. The write keeps the rest of the saved file, the
recorded graphics answer included. The cost, stated plainly: `true` that a player
deliberately chose in the old build looks exactly like the old default and is reset once,
after which their next choice sticks. A fresh install with no settings file migrates
nothing, because there is no recorded choice to reset.

**The tray is a game-start gesture, not a background mode.** With `trayOnLaunch` on, the
launcher creates the tray icon when the game starts, hides its window, and offers exactly
two actions: **Open launcher**, which shows the window again, and **Quit**, which exits the
launcher. Quit does not kill the game: the client keeps running, exactly as it does today
when the launcher quits behind a game with `exitOnLaunch`. The window comes back by itself
when the game exits — success and failure alike — and the exit handlers keep settling the
messages they always did ("Minecraft closed. Ready to play." and "Minecraft closed with code
N. Its log is in the client folder."). A hidden window is not a closed one, so
`window-all-closed` never fires while the launcher sits in the tray, and the existing
quit-on-last-window rule is untouched.

**Closing the window is still quitting, whatever the game is doing.** The tray belongs to
the moment the game starts, so it is not a place the launcher retreats to when the player
closes it. Closing the window ends the launcher and leaves a running game running, which is
what `exitOnLaunch` already does; a player who wants the launcher back mid-game opens it
from the tray where there is one, or starts the launcher again. The tray icon is destroyed
when the game ends, so no launcher icon is left behind after the game.

**A tray icon is only promised where one can be drawn, and the setting still works where it
cannot.** Electron creates a `Tray` object even on a desktop where no panel will ever draw
it, so on Linux the icon is only taken as real when a StatusNotifier host owns
`org.kde.StatusNotifierWatcher` on the session bus: KDE, the GNOME appindicator extension and
the XFCE and Cinnamon panels register it. A bare X server, a headless seat, a compositor with
no panel and Owen's own i3/polybar session — whose tray module is XEmbed — do not, so no
Electron tray icon would ever appear there. The answer is one `dbus-send` query with every
failure — missing binary, no session bus, timeout — treated as "no host"; Windows and macOS
need no probe because they always give the application a tray.

Where there is no host the launcher still steps aside, because the setting is not allowed to
be a silent no-op: the window hides and one sentence says why and how to come back — "This
desktop has no system tray, so start Easter Co. Launcher again to bring the window back."
Starting the launcher again is the way back: the second-instance handler shows, restores and
focuses the existing window instead of starting a second launcher, and it is the same path
the game shortcut uses. The game ending brings the window back by itself in both cases.
`EASTER_TEST_TRAY=0|1` overrides the probe in an unpackaged run, so a test seat with no panel
can prove both paths.

**The launcher Home carries no marketing title.** Owen's decision of 2026-10-17: the
crest and the small "Easter Co. SMP" eyebrow stay, and the large "The Ultimate
Minecraft Experience" headline is a website line that never appears in the launcher.
The site keeps it; the app shows the client controls instead.

**The launcher is an application window, not the website.** The promo blocks that
belong to visitors — the welcome blurb, the endgame note, the wiki and roles story
and the notes strip with the snapshot date — stay on the published site and never
enter the desktop DOM; Home keeps the crest, the name and the client controls.
Because nothing is left to scroll, Home fits the window instead of behaving like a
page: the shell is the viewport height, the hero takes whatever the header and
footer leave over, and neither axis overflows at any size the window allows
(`minWidth` 800, `minHeight` 600). No state field is added by this; it is a rule
about the surface. Utility pages that really are documents (the map today, the
coming wiki) keep their own scrolling. First run adds only a line of supporting
detail under the hero action, so the crest, the name, the single download action and
that detail all stay on screen at 800x600 without the shell ever scrolling. The
narrow-width fallback is the website's stacked layout, which only desktop mode in a
browser can reach.

## Game shortcuts and the auto-start argument

Owen's ask, and his own correction to it inside the same minute: a desktop shortcut and
a Start menu entry for the game — *not* a shortcut that skips the launcher. "We open the
launcher but the launcher then automatically opens the game (applying minimize or quit
options as well). because otherwise our auto-updater won't kick in." So both entries run
the launcher and nothing else, with one explicit argument:

    <the launcher the player has> --play

`--play` is the whole of it. There is no second form of the line: no client class, no
jar, no Minecraft version, no account argument, no token and no identifier of any kind,
and tests pin each of those absences. A shortcut that ran the client itself would skip
the mandatory launcher update, the client update gate and the account/access checks, so
the launcher never writes one; the entry it writes cannot start a game that the Play
action would not have started.

**One path starts a game.** `startGame()` in `desktop/main.cjs` is what the Play action
and the game shortcut both call. It waits for a background update, refuses while another
operation or a game is running, runs the launcher update check where the launcher is
packaged, refuses while the mandatory update gate is closed, and then runs the same
`exclusively(play)`. Because it is the same function, the launch-behaviour pair is
honoured exactly as pressing Play honours it — the window stays, closes behind the game
with `exitOnLaunch`, or steps into the tray with `trayOnLaunch` and comes back when the
game ends — and a second game can never be started while one is running.

**A shortcut launch waits for the gate instead of racing it.** `autoStart()` awaits the
startup update sequence (bounded at three minutes) and then asks one pure decision,
`autoStartDecision` in `desktop/shortcuts.cjs`, in the order a player experiences it: a
running game, then `startupReady`, then any other launcher operation, then the installed
client, then the Easter Company account (`signin`, `setup-password`,
`connect-microsoft`), then Java access (`buy`, `setup-profile`, `check-access`), and
finally the state contract's own `canPlay`. Only a yes starts a game; `actions` and
`canPlay` are the same list and the same gate the UI renders, computed in one place
(`remainingActions()` and `canPlayNow()`), so the shortcut cannot start what Play hides.

**A click that may not start a game does nothing else.** The window opens normally —
showing the sign-in action, the download action, the Java access notice or the running
game — and no second, vaguer sentence is printed at the player, because the state
already says what needs attention. The shortcut never opens the Settings dialog, never
starts a download and never offers itself as a second route to anything.

**A second launch is how this works while the launcher is running.** Clicking the entry
starts the launcher again; the single-instance lock refuses the second process, and the
`second-instance` event arrives at the first one carrying that process's own command
line. The handler shows, restores and focuses the window first — that is unchanged — and
then reads `--play` from the forwarded line. So a shortcut clicked while the launcher is
in the tray, hidden on a desktop that has no tray, or open on the map starts the game
once everything is ready, rather than silently doing nothing. The flag is never
persisted anywhere: it is read from the command line of the launch that carried it, which
is what makes the same click mean the same thing on the first and the second launch.

**Two settings, saved with the rest, off by default.** `desktopShortcut` and
`startMenuShortcut` are independent booleans in the settings file, validated by
`cleanShortcutPreferences` in `desktop/security.cjs` with the same rule as the launch
preferences: a value that is not a boolean is not coerced, and both default to off, so no
existing install gains an icon until the player ticks one. Saving the dialog is the only
thing that creates or removes a file — the launcher does not recreate a shortcut the
player deleted by hand on the next start, and the dialog says so instead of assuming it.

**Where the two files live.**

| Platform | Desktop shortcut | Start menu entry |
|---|---|---|
| Linux | `~/Desktop/easter-co-game.desktop` (`$XDG_DESKTOP_DIR` when a session names one) | `$XDG_DATA_HOME/applications/easter-co-game.desktop`, default `~/.local/share/applications/` |
| Windows | `Easter Co. Game.lnk` on the shell's desktop, written with `shell.writeShortcutLink` | `Easter Co. Game.lnk` in the per-user Start menu, same API |
| macOS | not offered | not offered |

Both Linux files are `[Desktop Entry]` files with `Type=Application`, the launcher as
`Exec`, `--play` beside it, `Terminal=false` and `Categories=Game;`, written mode `0755`
so a desktop that insists on an executable, trusted launcher will run them. Their `Icon`
is an absolute path to a copy of the launcher's own icon inside its data directory
(`easter-co-game.png`), so the entry does not depend on an icon a package may or may not
have installed, and that copy is removed when the last entry that used it goes. An
AppImage runs from a temporary mount, so the target is `$APPIMAGE` where it is set and
`process.execPath` otherwise: the file the player actually has, not a mount that will be
gone tomorrow. On Windows the entry is written by Electron's own shortcut API, carries
`--play` as its arguments, and carries `ltd.easter.company.launcher` as its
`appUserModelId`, the same identity `app.setAppUserModelId` gives the running launcher.

**Removal deletes exactly the files the launcher created.** Both files live at names the
launcher owns; the Linux entry also carries `X-Easter-Company=game-shortcut`, and removal
reads the file and refuses to delete one that does not carry it. A `.desktop` file a
player or a distribution put at that name is therefore left exactly where it is, and the
dialog says so rather than reporting a removal that did not happen. The applications
directory itself is created when it does not exist (it is the user's own, and harmless);
a `~/Desktop` that does not exist is **not** created. That case, and a folder this
computer will not let the launcher write, are reported in one plain sentence beside the
switches, and the preference for the entry that could not be written is turned back off,
so the saved setting and the file on disk never disagree.

**The dialog reports the files, not the preference.** Settings asks `status()` when it
opens, and that answer carries the two entries as they are *now*: the saved preference,
whether the file exists, and whether the file is one this launcher wrote. A shortcut the
player deleted by hand is visible instead of assumed to work; a file that is there with
the preference off is shown as one the launcher did not create and will not delete.

| Field | Type | Meaning |
|---|---|---|
| `shortcuts` | object | `{available, reason, message, desktop, startMenu}`; always present in desktop mode |
| `shortcuts.desktop`, `shortcuts.startMenu` | object | `{id, wanted, exists, ours}`: the saved preference, whether the file is there, and whether it is a file the launcher wrote |
| `shortcuts.message` | string \| null | The sentence a save that could not write an entry left behind; null otherwise |

`shortcuts.available` is false on a platform the launcher cannot write a shortcut for,
with `reason` naming why; the two switches are then hidden and the reason takes their
place rather than a dead control. **macOS is that platform**, and it is stated rather
than pretended: Electron's shortcut API is a Windows feature, and an alias the launcher
wrote would not survive its own update path, so no game shortcut is offered there.

**Nothing about an account reaches a shortcut file or a log line.** The entries carry the
launcher's own path, `--play`, their name, the launcher's comment, the icon path and the
marker; the launcher writes no log line about them at all, and the state it publishes
carries no path, no account and no token. A test reads both files back and fails on any
credential-shaped word.

**No new privileged surface.** The two preferences travel through the existing settings
action and their real state through the existing `status()` and broadcast. There is no
"create shortcut" channel, no renderer-chosen target and no renderer-reachable file
operation: the renderer sends two booleans, and the main process decides.

**What the uninstaller does and does not remove.** See `doc/releasing.md`.

## Account menu and installation recognition

Desktop Home uses Settings as its secondary hero action. The header has no client
settings button. Once signed in it shows the username followed by the skin face;
that control opens Add account, Switch Account and Logout. Add account keeps the
previous session until sign-in succeeds. Switch Account lists app-owned accounts
and refreshes the selected session before activation. Logout removes the active
account, including its saved session, without deleting other accounts. Account
sessions persist only in an OS-backed encrypted vault, otherwise for this process.
The state includes `accounts` (public usernames and display names only) and an optional skin
PNG data URL in each public profile. Tokens remain in the main process. Switching is refused
while Minecraft or authentication is running.

Manifest paths identify published files; JARs install under mods/ regardless of
their public download path. Old chunk records with different installation paths
require repair through the verified pipeline. Completion re-reads the installed
marker before reporting ready; installed but signed-out clients request sign-in.

## Launcher UI review, 2026-10-18

Home keeps the crest and small name in one compact control surface over the harbour.
It has one state-driven primary action. Graphics diagnostics are collapsed under
the graphics switch; the first-run folder and automatic graphics choice remain
visible. The marketing page and its large heading remain website-only.

Settings and Microsoft sign-in use separate dialogs. Settings contains preferences,
the shortcuts and collapsed advanced fields, with one Save action, and carries no
server address; account management
belongs to the header profile popover. The popover labels Microsoft and Easter
Company identity separately when present and disables account changes during
authentication or gameplay. The profile name and skin face retain their order.

Sign-in shows a pending state until a device code arrives, then the code and browser
action. Closing or cancelling that dialog aborts authentication and returns to the
previous view, retaining an existing account. It never reveals Settings mid-flow.
Errors appear in the active dialog or a visible page notice; a failed launch does
not open Settings. Save can be submitted by keyboard and cannot submit twice while
pending. Client settings may be opened during gameplay; changes apply on a later
launch. Graphics changes remain disabled while the game is running.

**Update 2026-10-18: one failure, one surface.** The line above used to allow both a
dialog and the notice at once, and nothing said which failure belonged where. The
rule is now the one under *One failure, one visible home*: a failure has one home,
delivered once, and it is never reproduced by reopening or closing a dialog.

**Update 2026-10-18, from the measured defect: no notice behind a modal.** "Errors
appear in the active dialog or a visible page notice" was only half true: a page
notice is in the page's own stacking order, so with Settings open it was dimmed at
1440 and 800 wide and completely covered at 390, and its Dismiss control was behind
the modal's box and unreachable by mouse or keyboard, because a modal dialog makes the
rest of the page inert. While any modal dialog is open the launcher now paints no page
notice at all; the last one to close gives the same sentence back once, with its
dismiss control and keyboard reachable, and it stays until dismissed or a new action
starts. See *One failure, one visible home* for the full rule.

## One verb, and sentences that carry no status (2026-10-18)

Three smaller findings from the second review, and the rule behind all three: the player
reads what happened and what to do about it, never a provider's label and never a status
code.

**One verb for the Microsoft action.** One action was called *Link Microsoft Account* on
the hero, *Login with Microsoft Account* in the chooser and *Login with Microsoft* in the
sign-in dialog, all on one screen. It is **Sign in with Microsoft** now, everywhere the
account is what the action is about — which is what *Required flow* has said since its
first draft: the hero's own action while a download runs, the chooser's Microsoft button,
and the sign-in dialog's title. The one button that is not that action is **Open the
Microsoft page**, because that is all it does: it opens Microsoft's page in the browser
and signs nobody in by itself. The sentences around the action already used the same verb
and are unchanged (`Sign in again.`, `Sign in with Microsoft or with your username.`,
`Sign in with Microsoft to continue.`), and so is the setup copy that names the account
service. These are strings, so the suites assert the labels themselves.

**A download or update failure carries no HTTP status.** The status is not something a
player can act on, so it has left the sentence and moved onto the error object
(`httpStatus`, alongside the `host` and `step` that produced it):

| Where it fails | What the player reads |
|---|---|
| Launcher update check | `The launcher update could not be checked. Check your connection and try again.` |
| Launcher update download | `The launcher update could not be downloaded. Try again.` |
| Client data request | `Could not download <host> data. Try again.` |
| A download the source would not resume | `The download could not be resumed. Your installed files are unchanged.` |
| A download that stopped, empty response included | `The download stopped before it finished. Your installed files are unchanged.` |

**The status is recorded in `userData/install.log`.** Install and update failures had no
record at all before this; the launcher's only such record was the sign-in's. One line per
failure is now appended to `userData/install.log` by the same class that writes
`userData/signin.log` (`SignInLog` in `desktop/auth.cjs`): the same bounded 64 KiB file and
the same single rotation to `install.log.1`, the same whitelisted fields, the same LF
endings, and the same rule that a log that cannot be written never affects the operation.
So `install.log` carries nothing but a timestamp, the launcher version, a step id, `failed`,
an HTTP status or `-`, a provider code or `-` (unused here), and the host or `-`:

```
2026-10-18T03:11:02.604Z v1.0.21 step=download outcome=failed http=503 code=- note=easter-co-smp.github.io
```

Step ids are `data` (a client-data request), `download`, `resume`, `launcher-update` and
`launcher-asset`. Nothing else in the launcher writes to `install.log`, it is never read
back, never broadcast and not part of this contract. `desktop/main.cjs` owns the path and
hands the log to `install.setFailureLog()` and `updater.setFailureLog()`; a build whose
main does not hand one in writes nothing and shows exactly the same sentences, because the
status travels on the error in either case.

## Mandatory update gate (2026-10-17)

This supersedes the optional update preferences and notification-only launcher check above.
`autoUpdateLauncher` and `autoUpdateGame` are always true, including when loading old
settings or accepting IPC input. Their switches and release-link notice are removed.
`exitOnLaunch` and `trayOnLaunch` remain preferences; both default off.

State adds `startupReady`. Packaged startup begins false. `launcherUpdate.phase` is
`checking`, `downloading`, `verifying`, `restarting`, `current` or `blocked`,
with optional `percent`, `version` and safe `message`. Launcher update work precedes
the game check. `canPlay` remains false during startup, transfers and checks.
The startup modal has no bypass; errors offer Retry through `retryUpdates()`.
Settings, install, sign-in and Play IPC are refused until the gate opens. Pause,
resume and cancel remain available for game transfers; cancelling a mandatory
startup transfer leaves the gate blocked. Home's bounded arrival starts after
startup succeeds. Before every Play, the launcher feed and game manifest are
checked again; a failure never launches the old client.

See [mandatory-updates.md](mandatory-updates.md) for the payload/bootstrap protocol.

## Microsoft account without Java access

See [minecraft-access.md](minecraft-access.md). State adds `minecraftAccess`
(signed-out, owned, missing, profile-required, unknown), `microsoftAccount`
(public identity only), and `accessChecking`. A successful Microsoft login need
not supply a Java profile. Play additionally requires confirmed Java access;
the authenticated session remains available for purchase/setup recovery.
Actions may include buy, setup-profile or check-access. The hero and utility-page
dock use Buy Now only for confirmed missing entitlement, never an outage.
Fixed-destination IPC opens the official store/profile pages; recheckAccess
reuses the Microsoft session and can return directly to Download or Play.

## Sign-in steps, sentences and the redacted log (2026-10-18)

A sign-in is six steps, in this order, whether it starts from a fresh device code or from
the saved session the account is already holding. Each step owns one sentence, so the
notice says which leg failed instead of collapsing every answer into "Sign-in could not
finish. Please try again."

| Step id | Sentence |
|---|---|
| `device-code` | `Microsoft sign-in could not start: …` |
| `code-completion` | `Microsoft sign-in did not finish: …` |
| `xbox-live` | `Xbox Live did not accept the Microsoft sign-in: …` |
| `xsts` | `Xbox Live authorisation did not accept the sign-in: …` |
| `minecraft` | `Minecraft sign-in failed: …` |
| `java-profile` | `The Java profile could not be read: …` |

A network failure leads like every other sentence and never claims a refusal that did not
happen: `Minecraft sign-in failed: the launcher could not reach <step>. Check your
connection and try again.`, where `<step>` is `Microsoft to ask for a sign-in code`,
`Microsoft to finish the sign-in`, `Xbox Live`, `Xbox Live to authorise the sign-in`,
`the Minecraft service`, or `the Java profile service`.
`code-completion` is the token exchange on both routes: the device-code poll and the
refresh of a saved session. The generic sentence is kept for a genuinely unknown step and
is not used by any of the six.

**A sentence never carries a provider code.** No HTTP status, no AAD `error` string
(`invalid_grant`, `invalid_scope`, `unauthorized_client`…), no `XErr` number and no
internal step id appears in what the player reads; the last section of this document's
contract is the log below, which keeps all of it. What the player gets instead is the
human cause and an instruction, and the five causes a person can act on read differently:

| Cause | What the player reads |
|---|---|
| A refused Xbox Live session | `Minecraft sign-in failed: the Xbox Live session was not accepted. Sign in again.` |
| An account that may not play | `Minecraft sign-in failed: this Microsoft account may not play Minecraft: Java Edition. If you do own the game, sign in with the Microsoft account you play it with.` |
| An outage | `Minecraft sign-in is temporarily unavailable: the service is not answering right now. Try again in a few minutes.` |
| Rate limiting | `Minecraft sign-in failed: there have been too many sign-in attempts in a short time. Wait a few minutes and try again.` |
| No connection | `Minecraft sign-in failed: the launcher could not reach <step>. Check your connection and try again.` |

**Each Xbox `XErr` cause carries its own instruction**, because retrying is not what fixes
any of them. The number is dropped and the sentence says what to do:

| `XErr` | What the player reads |
|---|---|
| 2148916233 | `… this Microsoft account does not have an Xbox profile yet. Create an Xbox profile for this account at xbox.com, then sign in again.` |
| 2148916235 | `… Xbox Live is not available in this account's country. Sign in with a different Microsoft account.` An account's country is not a setting the launcher can change, so the sentence names the property and the one thing that clears it. |
| 2148916236, 2148916237 | `… this Microsoft account has not completed its age verification. Finish the age verification at xbox.com, then sign in again.` (one cause, one sentence) |
| 2148916238 | `… this account is waiting for Microsoft Family approval. Ask your Microsoft Family organiser to approve Minecraft for this account, then sign in again.` |
| any other | the step's own `Try again.`, which is right for a cause the launcher cannot name |

Nothing from a response body, and no token, refresh token, device code, user code or email
address, is ever part of a sentence; a provider code that would itself contain the word
"token" is scrubbed by `main.cjs`'s safeError() rather than shown. Because a bare `XErr`
number is four digits or more, the jargon guard in the suite also refuses any sentence
containing one, so a number cannot reach a player even without its prefix.

**The log is `userData/signin.log`.** One line per step, appended, LF endings:

```
2026-10-18T04:52:31.123Z v1.0.17 step=xsts outcome=failed http=400 code=XErr2148916238
```

Fields: ISO-8601 UTC timestamp, launcher version, step, outcome (`ok` or `failed`), HTTP
status or `-`, provider code or `-`, and an optional `note=reissued` when the Xbox Live
token had to be minted first. A network failure is one line with `code=network`. The two
poll answers that only mean "the player has not finished on Microsoft's page yet"
(`authorization_pending`, `slow_down`) are not step outcomes and are not logged, so a
sign-in that is simply waiting writes nothing. A step that fails writes exactly one line,
before its sentence is thrown, and nothing else in the launcher writes to this file.

**`userData/install.log` is the same record for install and update failures**, written by
the same bounded, redacted class with the same 64 KiB cap and single rotation, so treating
it as unredacted would be a mistake: `2026-10-18T10:24:21.015Z v1.0.21 step=download
outcome=failed http=503 code=- note=cdn.modrinth.com`. The install and update messages the
player reads carry no HTTP status — "The download stopped before it finished. Your installed
files are unchanged." — and the status rides on the thrown error as `httpStatus`, `host` and
`step` so it reaches this line instead of the sentence. `step` is the install leg (`data`,
`download`, `resume`, `launcher-update`, `launcher-asset`), `code` is `-`, and `note`
carries the host.

The file is bounded: when a line would take it past 64 KiB it is rotated once to
`signin.log.1`, so at most two files exist however many times the launcher signs in. A log
that cannot be written never affects the sign-in. `signin.log` is a diagnostic for the
owner and is never read by the launcher, never broadcast, and not part of this contract.

**The Xbox Live leg always holds a token minted for its own scope.** The device code asks
for `XboxLive.signin offline_access https://graph.microsoft.com/User.Read` in one consent,
and Microsoft decides which of those resources an answer is minted for. Before
`user.auth.xboxlive.com` the launcher therefore checks the token's own claims: an Xbox Live
audience, or an Xbox Live scope claim, is proof that it may be presented as the RPS ticket.
Anything else — an opaque answer, a Graph audience, no audience — is not proof, and the
token is reissued for `XboxLive.signin` from the same refresh token first, with one
`xbox-live` log line and `note=reissued`. That replaces the earlier silent retry, which
swallowed its own failure and rethrew the original: the path is now deterministic, written
down, and the same on the saved-session route, which is where a failure is most likely to
appear because it re-runs the whole chain from a stored refresh token.

## Company identity and password login

This replaces the earlier separate-account presentation: Easter Company is the primary identity. State.account exposes the Easter Company `username`, a display `name`, `roles`, `passwordRequired` and `microsoftLinked`; companyReady and microsoftConnected are separate gates. Provider proofs, link subjects, passwords, session tokens and the Microsoft account's email address never appear in state. Microsoft signup validates an Xbox user token on the server and copies only available public Minecraft profile data. Accounts without Java profiles can register. Existing account identities are retained when verified Minecraft ownership migrates their Xbox link.

**The username is the account identifier the player deals with.** A Company ID in the
`EC-123` form is never displayed, asked for, or accepted anywhere in the launcher; the
`id`/`companyId` pair stays in the payload as the immutable handle that switch-account and
the skin cache are keyed on, and it simply never reaches a label. The server owns the
account payload, which carries `username` for an account that has one; the main process
passes the handle, the username, the display name, the roles and the two flags to the UI,
and it never passes or stores an email address. A username is 3–20 characters of `[a-z0-9_-]`
and is immutable once claimed. `passwordRequired` false guarantees a username exists; a
payload that claims no password is required and carries no username is a server bug the main
process refuses as `invalid_response` rather than showing a blank identity. Reaching the
account API needs no privileged surface beyond the account actions: the same company-login
and company-password actions carry the identifier and the username, and the availability
answer is one boolean with a reason code and no account data.

**Setup runs the username step before the password step.** The sign-in chooser offers
**Sign in with Microsoft** — the account is created from that Microsoft sign-in — and
a direct **Username or Email** field with a password. The chooser states: “Please sign up
using an existing online account provider, and then create an Easter Company account
username & password.” An account without a username is first asked for one (step 1 of 2);
the username step asks the server whether the name is available before the player types a
password, and says plainly when it is taken or does not meet the rules. The password step
(step 2 of 2) names the username the password is saved against. The username is claimed
together with the first password, so a `username_taken` or `username_policy` refusal from
that call reopens step 1 with the plain message and keeps what the player typed. An account
that already has a username goes straight to the password step, and a password change never
asks for a username again. Password setup and reset use a recent Microsoft-authenticated
Company session; reset revokes other sessions and never asks for the username. Closing setup
leaves Play blocked and a Create password action available. Passwords are never persisted on
the client, and the direct login field takes a username or the email the account was created
with, never a Company ID.

The account actions are `company-login(identifier, password)`,
`company-password(password, replace, username)`, `company-username-check(username)` and
`switch-account(id)`. `identifier` is posted as-is; `username` travels only on the call that
claims it; `company-username-check` posts the name and returns `{available, reason}`.

**The availability answer has exactly two refusals, and neither advances the flow.** The
deployed service answers `{available, reason}` with `reason` null, `"taken"` or `"policy"`;
the frozen contract named the same two answers after its error codes (`username_taken`,
`username_policy`) and the launcher accepts either spelling, always reporting its own code
so the wording stays in one table. A reserved word passes every rule the renderer can see
(`easter`, `admin`, `minecraft`…) and comes back as a policy refusal: it is reported as a
rule the player can fix, never as a name someone else holds. A refusal with no reason, or a
reason word the launcher does not know, is a refusal — the password step opens only on a
plain yes, so a taken name is never discovered after the password has been typed.

**The Microsoft account's email is read on the server, never carried by the launcher.** The
same interactive Microsoft sign-in also asks for `https://graph.microsoft.com/User.Read`, so
the account service can read the email the account was created with. The Graph token is
transient: it is obtained from the same refresh token, put in the single
`POST /v2/accounts/microsoft` body as `microsoftAccessToken`, and never written to the
vault or the session, never logged, never put in renderer state and never sent anywhere
else. It is optional in the contract, so a build that cannot obtain one signs in without it
rather than blocking the player.

Company login restores only a matching cached Microsoft session. Otherwise Sign in to Minecraft asks for the linked Microsoft identity. Wrong-provider login cannot replace the active Company identity. Play requires a complete Company account, a matching Microsoft link, current launcher/client and confirmed Java access. Revoked Java access retains the Company identity and shows Buy Now. Add/switch/cancel/failure retain the current account until a new login succeeds. Logout signs out the primary identity. Provider storage supports future Steam linking; no Steam button or unverified linking is shipped.

## Verified emails and the login email (2026-10-18)

The profile lists the addresses the account service has verified for the player's own
account and lets them choose which one is the login email. An account can hold several:
one per linked provider, so a second provider (Steam, Discord) needs no launcher change
here beyond the provider's own name. The launcher renders whatever the server reports and
groups no provider specially.

**No address enters the state contract.** `launcher:state`, `status()` and every other
broadcast carry no email: the account list, account switching, the skin cache, the profile
heading and every other renderer path keep using the account id, the username and the
display name. An address is asked for on demand, only for the profile section, through the
two account actions below; it is never written to the settings file or the vault, never
logged, never part of an error message, and never sent anywhere except the selection call.

**The routes are owner-only and are the only place an address comes back.**

- `GET /v2/accounts/emails` (Bearer Company session) →
  `{emails: [{email, provider, verifiedAt, login}], loginEmail}`. `login` marks the address
  the account service currently uses as the login email; `loginEmail` is that same address,
  or null when none is selected.
- `POST /v2/accounts/emails/login` (Bearer Company session) with `{email}` selects one of
  the player's own verified addresses; `{email:null}` clears the selection. Anything that is
  not one of the player's own verified addresses is refused with `400 email_not_yours`.

The launcher sends the chosen address and the session and nothing else. There is no route
by which a renderer names an account, and no other call returns an address.

**Only the selected address is a sign-in key.** The selected address plus the password
signs in; the other verified addresses stay recorded on the account and cannot be used to
sign in, so two accounts can never claim the same login address. An account whose verified
addresses are all unavailable signs in with Microsoft or with its username instead, which
is exactly what the empty state says.

**The profile section.** The account popover shows the login email in one line (or the
sentence for the state it is in) and offers **Verified emails**, which opens the section: a
one-at-a-time choice of the reported addresses, the current choice marked "signs you in",
the others marked "recorded, not a login key", one **Save selection** action and one
**Clear login email** action while a selection exists. The section says, in its own words,
that only the selected address is a login key. The saved choice is the server's record, not
a launcher preference: it is re-read from `GET /v2/accounts/emails` every time the section
opens, so it survives a restart by being asked for again rather than by being cached.

The four states are distinct and each is stated rather than implied:

- verified addresses, one selected → the list, with that address marked as the sign-in key;
- verified addresses, none selected → the list plus "No login email is selected. Sign in
  with Microsoft or with your username.";
- no verified address → no list and the sentence "No verified email is recorded for this
  account. Sign in with Microsoft or with your username.";
- the list could not be read → the failure sentence only. Nothing claims an address exists,
  and nothing claims the account has none, when the answer is unknown.

**Refusals are reported as what they are.** A selection the service refuses
(`email_not_yours`) is one sentence naming the address as unavailable — it is not verified
for this account, or another account already uses it as its login email — and the
selection the server already has is left in place, still marked. A refused selection is
never described as a sign-in failure, and the previous choice stays visible and current.

**The account actions are `emails()` and `login-email(email)`.** Both are owner-only, both
take their session from the main process and neither takes an account handle from the
renderer. `emails()` reads the list; `login-email(email)` selects (`email` is one of the
addresses the server just reported) or clears (`null`), re-reads the list and answers with
it. Both are refused while there is no live Company session, with the ordinary
`invalid_session` sentence. There is no new privileged surface beyond these two account
actions: no renderer-supplied path, no file access, no token and no other account handle.

## Client visual content (2026-10-19)

The required `visuals` chunk adds Smooth Third Person Camera, EMF, ETF, Skyboxify
and its YACL dependency, Fresh Animations, FA Player Extension and Dramatic Skys.
It is independently versioned so updating visual content never reinstalls Java,
libraries or the base game. `desktop/visuals.json` pins exact Minecraft 26.2
Modrinth releases, publisher URLs, sizes and SHA-512 hashes; binaries are fetched
from their publishers, never republished with the launcher. The three resource
packs are activated automatically, with Player Extension above Fresh Animations.
Other resource packs and unrelated options remain intact. Dramatic Skys stays
selected with or without Enhanced Graphics; shader packs can affect the final sky.

Grassier Grass is cached as a non-loadable `.jar.disabled` file in the optional
`graphics` chunk. Only when Enhanced Graphics is enabled AND Iris shaders are
actually enabled does the launcher activate its own managed JAR in `mods/`. On a
weak/unknown adapter, a missing shader payload, a failed quality write, or switching
the toggle off, that JAR is absent. This is reconciled after install, after a
graphics change and before every game launch, including a quiet content update.
The optional cache and the base game's verified chunk are retained. Turning the
toggle off works offline. A quality write failure fails the change visibly; it
cannot silently leave the expensive effect active.

Only the app-owned client tree is configured. No existing `.minecraft`, world,
server or household installation participates in this process. There are no new
player-facing controls or separate website graphics settings; the website continues
to distribute the launcher and its public client manifest.

Automatic vanilla quality writes Minecraft 26.2's actual split fields (ambient
occlusion, cutout leaves, entity shadows, transparency, mipmaps and particles),
with `graphicsPreset:"custom"` because distances follow the hardware ladder. The
obsolete `graphicsMode` line is removed. On a detected weak GPU the first install
also applies the conservative vanilla settings with shaders off; subsequent off
transitions keep the player's distances and personal settings.

## Stable Microsoft device code (2026-10-19)

Background download progress must never replace an unchanged Microsoft device-code
text node, disturb its selection, move focus, or reopen the sign-in dialog. The
code and provider text update only when their displayed values change; a newly
issued code still replaces the previous one. The progress bar continues updating
while the code is selected or copied. No copy control or extra sign-in step is added.

The error notice's dismiss control and desktop dialog close controls explicitly
center their glyphs without inherited button padding. Microsoft enrollment retries
only an explicit HTTP 503 `database_unavailable` response, under the bounded
policy below; it does not retry network errors, unknown failures, credentials, or
other account mutations. The backoff honours cancellation. Exhausted retries have
an actionable launcher-owned message. No token or server detail enters it.

## Quiet activity feedback and cold-start patience (2026-10-19)

The UI reacts immediately when an action starts. Waiting feedback stays beside the
relevant action or inside the dialog already open; a wait never opens a new modal,
paints an error toast or asks the player to click the same action twice. Downloads
keep the existing persistent transfer bar. A busy API request does not replace or
reset concurrent download progress.

The additive main-process field `activity` is `null` at rest or the following plain
object during an account operation:

| Field | Meaning |
|---|---|
| `stage` | A whitelisted stage below, never a provider response or URL |
| `message` | Fixed launcher-owned wording for that stage |
| `startedAt` | Epoch milliseconds when this operation began; stable through its stages |

| Stage | Message |
|---|---|
| `microsoft-opening` | Opening Microsoft sign-in… |
| `microsoft-waiting` | Complete sign-in on Microsoft’s page. |
| `microsoft-verifying` | Verifying your Microsoft sign-in… |
| `java-checking` | Checking Minecraft Java access… |
| `company-signing-in` | Connecting your Easter Company account… |
| `company-waking` | The account service is waking up. We’ll keep trying… |
| `account-working` | Contacting the account service… |

The Microsoft code remains selectable while browser approval is pending. Once that
approval is consumed, the same dialog shows verification and Company connection
feedback instead of continuing to ask the player to enter the consumed code.
Activity is scoped to its operation: success, failure and cancellation clear it;
late callbacks from an earlier operation cannot resurrect a finished wait.
Tokens, account identifiers, provider bodies and infrastructure names never enter
this field.

Each wait surface uses a small neutral/gold indicator and a short stage sentence.
After ten seconds it may add a quiet reassurance that work is continuing. Elapsed
time, if displayed, is not an ETA and is not announced every second. Stage text
updates only when it changes; timers never replace selectable text, reset focus,
restart the indicator, or move an active control. Status uses polite announcements
and reduced-motion preferences retain a visible static activity mark. Failures and
terminal states remove the activity indicator rather than leaving it spinning.
Fast actions finish normally; no fake minimum wait is added.

Company sign-in, username checks, password saves and verified-email reads/saves
have task-specific inline feedback immediately. Repeated submissions are guarded.
Cancellation is offered only where it can actually stop the operation. A mutation
that cannot safely be cancelled remains visibly pending until it has a definite
answer; it is never labelled cancelled while a write may still be underway.

Microsoft Company enrollment may keep trying an explicit HTTP 503
`database_unavailable` for up to ninety seconds and at most four attempts, including
the initial request. Each request and backoff stays within the remaining window,
with the normal thirty-second request ceiling. Cancellation stops requests and
backoff. This does not replay network errors, malformed successes, unknown
failures, credentials, or other account mutations. Other request budgets remain
bounded. Server wake already allows three minutes, polls its real state, and starts
the client automatically when ready; it receives the same quiet visual language
without inventing completion percentages or a promised finish time.
