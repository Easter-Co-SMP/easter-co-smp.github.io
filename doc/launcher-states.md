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
| `phase` | string | One of `uninstalled`, `downloading`, `paused`, `verifying`, `installing`, `updating`, `ready`, `launching`, `running` |
| `progress` | object \| null | `{label, percent, bytesDone, bytesTotal, bytesPerSecond, etaSeconds}`; `percent` null when indeterminate, and byte fields null when the underlying task cannot report them |
| `paused` | boolean | True only while a paused transfer can still be resumed |
| `install` | object | `{location, defaultLocation, installed, includeGraphics, version, updatedAt}`; `location` is the chosen root, `defaultLocation` the value shown as "default" |
| `actions` | array | Ordered remaining requirements, each `download` or `signin`. Empty means nothing is required |
| `canPlay` | boolean | Exactly `install.installed && profile !== null` |
| `bar` | object | `{visible}`: the sticky bar's visibility. The bar's minimised state is a renderer-local preference and does not belong in this state |

`canPlay` is the single source of truth for the Play action. No view may compute
its own version of the gate, and no view may enable Play on install completion
alone.

## Bar behaviour

- Hidden until a download or install has started; visible from then on, on every
  page, including after the client is ready.
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

1. **The launcher is always usable.** No phase of `launcherUpdate` hides the
   launcher's own UI. There is no blocking startup gate. `checking`,
   `downloading` and `verifying` all leave the player free to look at the map,
   read their settings or queue the game download.
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
8. **The player's data survives.** Settings, the saved session, the client tree
   and its chunks live outside the replaced files and are never migrated,
   rewritten or removed by a launcher update.
9. **`version` is the launcher, `install.version` is the game client.** They are
   unrelated and must never be rendered as if they were the same thing.

## Home actions, Settings and enhanced graphics

Owen's review of the shipped launcher on 2026-10-16 fixed where each control
belongs. The install actions and the settings are no longer the same surface, and
the graphics choice is a player-facing toggle instead of a checkbox buried in an
install form.

**Settings is a settings-only dialog, and only the Play Now stage has it.** It is
the hero's secondary action, exactly as *Account menu and installation recognition*
already said; the header has no client settings button and never had one in the
contract. The dialog contains client settings and nothing else: the server choice,
memory and Java as client settings, the account lines and the version footer. The
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
writes the client's own quality settings; flipping it off stops nothing that is
already installed and never invalidates the base chunk.

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

`graphics` is `{enabled, recommended, tunable, tuned}`: `enabled` is
`install.includeGraphics` under its player-facing name, `recommended` is the
automatic answer for this machine, `tunable` is false when this platform cannot
report enough about the GPU to promise a quality level, and `tuned` is
`{renderDistance, shadowDistance, shaders}` actually written into the client.

The server field becomes a choice with a working default, and the entries are
published by the main process rather than hardcoded in the view:

| Field | Type | Meaning |
|---|---|---|
| `servers` | array | `{id, label, address, note, pending}` in display order |

`100.100.1.0:25565` is the default, `127.0.0.1:25565` is the local server, and
`smp.easter.company:25565` is listed as `pending` because that name has no DNS
record yet; a pending entry is shown as unavailable rather than silently failing to
connect. An entry the player types is kept as their own choice and is never
rewritten to an entry id.

**Two accounts are never rendered as one.** The Microsoft account and the Easter
Company account are separate systems, and the dialog labels them separately. A
signed-in Microsoft account must not be followed by "No Easter Company account on
this device yet." as bare, unlabelled copy: the company line is labelled, and when
nothing depends on a company account it is omitted rather than advertised. The
memory control is an explained advanced setting, not a bare slider under a heading
that says nothing about what it does.

**Automation is the player's choice, and it is stated in the settings.** Three
preferences are persisted with the rest of the settings, default on, and are never
re-decided behind the player:

| Setting | Meaning |
|---|---|
| `autoUpdateLauncher` | Keep the launcher itself current. Applying an update in place is not built yet, so this governs the version check and the notice in the settings dialog; nothing is installed by it. |
| `autoUpdateGame` | Keep the installed game client current. When off, no update starts on its own and a launch never begins a transfer the player did not ask for. |
| `exitOnLaunch` | Close the launcher after it starts the game, so the launcher is a doorway rather than a second window to manage. |

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

## Account menu and installation recognition

Desktop Home uses Settings as its secondary hero action. The header has no client
settings button. Once signed in it shows the username followed by the skin face;
that control opens Add account, Switch Account and Logout. Add account keeps the
previous session until sign-in succeeds. Switch Account lists app-owned accounts
and refreshes the selected session before activation. Logout removes the active
account, including its saved session, without deleting other accounts. Account
sessions persist only in an OS-backed encrypted vault, otherwise for this process.
The state includes `accounts` (public profiles only) and an optional skin PNG data
URL in each public profile. Tokens remain in the main process. Switching is refused
while Minecraft or authentication is running.

Manifest paths identify published files; JARs install under mods/ regardless of
their public download path. Old chunk records with different installation paths
require repair through the verified pipeline. Completion re-reads the installed
marker before reporting ready; installed but signed-out clients request sign-in.
