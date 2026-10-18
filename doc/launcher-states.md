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
| `bar` | object | `{visible}`: progress/action dock availability. The renderer omits an idle dock on Home because Home already provides the action; utility pages retain it. The minimised preference stays renderer-local. |
| `settings` | object | The saved settings, exactly as `status()` already returned them, so the Settings dialog refreshes from a broadcast as well as from a read. |
| `error` | string \| null | Safe operation failure text for a visible notice. Cleared by the next operation or a new ordinary message. Cancellation is not an error. Older states without this field still render. |

`canPlay` is the single source of truth for the Play action. No view may compute
its own version of the gate, and no view may enable Play on install completion
alone.

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
memory and Java as client settings, preferences and the version footer. Account
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

**Easter Company is the primary identity.** The profile popover leads with the
Company name and ID, then names Microsoft/Xbox as its linked provider. Signed-out
users get a sign-in chooser with Microsoft signup/sign-in and Company ID/password
login. New and migrated accounts without a password must complete setup before
Play. The memory control remains an explained advanced setting.

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
The state includes `accounts` (public Company IDs/names only) and an optional skin PNG data
URL in each public profile. Tokens remain in the main process. Switching is refused
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

Settings and Microsoft sign-in use separate dialogs. Settings contains the server,
preferences and collapsed advanced fields, with one Save action; account management
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

## Company identity and password login

This replaces the earlier separate-account presentation: Easter Company is the primary identity. State.account exposes Company ID/name, passwordRequired and microsoftLinked; companyReady and microsoftConnected are separate gates. Provider proofs, link subjects, passwords and session tokens never appear in state. Microsoft signup validates an Xbox user token on the server and copies only available public Minecraft profile data. Accounts without Java profiles can register. Existing account IDs are retained when verified Minecraft ownership migrates their Xbox link.

The sign-in chooser offers Continue with Microsoft (automatic signup/sign-in) and Company ID/password login. Signup and existing accounts without a password must complete password setup. Company ID is displayed for subsequent direct login. Password setup/reset uses a recent Microsoft-authenticated Company session; reset revokes other sessions. Closing setup leaves Play blocked and a Create password action available. Passwords are never persisted on the client.

Company login restores only a matching cached Microsoft session. Otherwise Sign in to Minecraft asks for the linked Microsoft identity. Wrong-provider login cannot replace the active Company identity. Play requires a complete Company account, a matching Microsoft link, current launcher/client and confirmed Java access. Revoked Java access retains the Company identity and shows Buy Now. Add/switch/cancel/failure retain the current account until a new login succeeds. Logout signs out the primary identity. Provider storage supports future Steam linking; no Steam button or unverified linking is shipped.
