# Launcher state contract

Frozen interface between the Electron main process (`desktop/`) and the shared UI
(`site/`). The UI renders whatever this state says and never invents its own
requirements; the main process never decides what the hero looks like.

## Required flow

1. **Fresh install.** The hero's primary action is **Download the game** (the
   custom Easter Company client bundle, not the launcher). The user chooses an
   installation location or accepts the default, and toggles **Include enhanced
   graphics + shaders**. Starting the download is what creates investment.
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
- Chunks are absent until they have real content. There is no `graphics` chunk yet,
  because the shader stack has not been chosen; an optional chunk that is switched off
  is simply absent, and its absence invalidates nothing else.

## Rules that still hold

- Downloads stay checksum verified, and an unverified or failed download replaces
  nothing.
- Sessions are only ever stored through OS-backed `safeStorage`.
- The client install is its own tree and never touches an existing `~/.minecraft`,
  another launcher's files, the server or the world.
- Personal drawings, player data and credentials never enter `site/` or Git.

## Launcher startup update gate

This section is frozen before any UI is built against it. It extends the state
object; it does not change any field above it.

The launcher updates itself on launch, so the next manually installed release is
the last one. The startup gate is a desktop-only, per-window block: while it is
not `ready`, the launcher's own UI must not be revealed. The website ignores this
field entirely, because a browser has no launcher to update.

| Field | Type | Meaning |
|---|---|---|
| `launcherUpdate` | object | `{phase, percent, version, message}`. Always present in desktop mode |

`launcherUpdate.phase` is one of:

| Value | Meaning |
|---|---|
| `checking` | Asking the release feed whether a newer launcher exists. Indeterminate |
| `downloading` | Fetching the new launcher. `percent` is 0-100 once a total size is known, otherwise null |
| `installing` | Verified and staged; being applied. Indeterminate |
| `restarting` | The old process is handing over to the new one. The old UI must not be revealed |
| `ready` | The **running** launcher is safe to use. This is the only phase that reveals the UI |

`percent` is `0`-`100` or `null`, and is `null` whenever the phase is not a
measurable download. It is never a placeholder number. `version` is the version
being fetched or installed, or `null` when there is nothing to install.
`message` is a short human sentence suitable for direct display.

### Rules

1. **`ready` is the only revealing phase.** `checking`, `downloading`,
   `installing` and `restarting` all keep the launcher's own UI hidden. At 100%
   the UI is revealed only once the phase is `ready`, never at 99%, and never
   while a process handover is in flight.
2. **Nothing about the game changes.** `launcherUpdate` never writes to `phase`,
   `progress`, `paused`, `install`, `actions`, `canPlay` or `bar`. The sticky bar
   and the Play gate read exactly what they read before. A launcher update must
   never interrupt a running game and must not start while `phase` is `running`.
3. **Failure is never fatal and never blocks.** An unreachable feed, a timeout, a
   checksum mismatch or a failed handover settles on `ready` against the version
   already running, which stays usable. A failure may carry a `message`, but it
   must not hold the gate at `checking` or `downloading`.
4. **The check is bounded.** The feed lookup has a finite timeout; exceeding it is
   rule 3, not an indefinite spinner.
5. **Always emitted.** The desktop main process publishes `launcherUpdate` on
   every state broadcast from the first one onward, including in development and
   under the test harness, so no run can hang waiting for a phase that never
   arrives. An unpackaged or dev run reports `ready` immediately.
6. **Updates are verified before they are used.** The downloaded payload is
   checksum verified against the release manifest before it is staged, and an
   unverified or corrupt payload replaces nothing.
7. **The player's data survives an update.** Settings, the saved session, the
   client tree and its chunks live outside the replaced application files and are
   never migrated, rewritten or removed by an update.
8. **`version` describes the incoming launcher, not the installed client.**
   `install.version` remains the game client's version and is unrelated.

### Platform behaviour

| Install kind | Self-updates | Notes |
|---|---|---|
| Windows NSIS | yes | Per-user install, so no elevation prompt |
| Linux AppImage | yes | Replaced in place; the AppImage is the application |
| Linux deb, pacman | **no** | Owned by the system package manager. The launcher must report that and settle `ready` rather than attempting an update that would need elevation |

A build that cannot update itself for these reasons is a normal, non-error
outcome: the gate still reaches `ready`.
