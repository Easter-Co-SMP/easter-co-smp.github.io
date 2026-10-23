# Easter Co. public site

This is a buildless GitHub Pages site, not an e-server page. Read README.md before changes.
Keep shared Home, Download, Map, and Wiki navigation. The public map is view-only.
Secondary branding is "The Ultimate Minecraft Experience". Welcome veterans, pros and absolute
beginners. Keep the rich casual early game and cooking/baking/brewing contributions
alongside the harder progression, team encounters, and crime/punishment mechanics.
The endgame includes weekly 20+ player Ender Dragon raids, boss world buffs and weekly
boss resets. Do not display the elytra limit or first-elytra house prize on the website;
tests/test_site_assets.py enforces that removal against site/.

The server's own name is the Easter Co. Survival Multiplayer Server, written "Easter Co. SMP"
wherever the short form fits; a first mention, a legal definition or a document title may spell
it out in full. Nothing invents an alternative name for the server or for the world it runs: the
world is "the world", "the server" or "Easter Co. SMP", whichever the sentence wants, and no
second place name is coined beside it (Owen, 2026-10-23). This is the one place the rule is
stated; player-facing copy in site/, the launcher's strings and doc/ follow it.

Player data must never enter site/ or Git history. Use scripts/export_world.py and its
strict allowlist. Never use the private snapshot endpoint as a public export. Keep
credentials and runtime state outside this repository. Do not publish third-party JARs.

scripts/sync.py owns generated site/data/ and site/downloads/. It must preserve durable
local commits when pushes fail, catch up after boot without inventing historical states,
and never force-push or discard changes to hand-written files. Run recovery and privacy
tests after exporter or sync changes; validate the complete site before pushing.

The atlas pipeline (`scripts/atlas/`, `.github/workflows/atlas.yml`, doc/atlas-pipeline.md)
is the cloud replacement for that timer's map half. It is only the *committer*: the capture and
the render happen in `easter-co-cloud/pipeline/atlas/` (a scheduled Lambda), because GitHub OIDC
is denied in this account and a workflow here therefore cannot hold an AWS credential. Rules
that hold for this half: it holds no AWS credential and no secret, and reads the bundle from a
public HTTPS URL into `site/data` and `site/downloads` only; it commits the client half and the
map half as two independent commits, client first; a bundle whose `snapshot_day` is not later
than the published one commits nothing and says so in one line, leaving `site/data/world.json`
byte for byte unchanged; and `site/data/` is not edited by hand while the scheduled run owns it.

Never restart e-server, DSH, or Minecraft for a public-site update. The public-site timer
has its own service. No console mutations, world generation, or changes to game rules.

Keep the mist arrival exclusive to the homepage. Map and future Wiki use regular utility
interfaces. The intro must be skippable, bounded, and respect reduced-motion preferences.
The desktop launcher omits the website's skip control and relies on Escape plus that bound.

Hero copy is "Easter Co. SMP" and "The Ultimate Minecraft Experience".
Download Launcher is the primary gold CTA, left of the secondary View Map action. The
custom launcher is built separately. The nav always opens the shared dropdown. The hero is a split control: main button
auto-selects Windows x64 or Linux AppImage; attached arrow opens that shared platform
dropdown (Windows 10+, Ubuntu, Arch, AppImage), not a download page. Use the real installer URLs in site/downloads.js. Both automatic and manual selections open the Setup & Install modal
after starting the download. Instruction copy must describe the actual downloaded package, including platform dependencies and commands.
Wire real release URLs in site/downloads.js; do not mislabel the server mod as a launcher. Write release copy with no Coming soon badges or availability placeholders.
The download will include the custom Easter Company launcher and Minecraft client.

Do not display Source, source code bundles, standalone client/server bundle options, or the old direct-mod download section.

The store is a page at site/store/, reached from the header nav on Home, Map, Wiki and itself
like Map and Wiki are — never a dialog over the launcher. It is named "The Community store",
stays `noindex`, is a labelled mock (sample products and USD prices, no real payment, nothing
delivered to the game), and its mock notice is pinned so it stays visible at every scroll
position. Its views are hash routes (#catalogue, #item/<id>, #cart, #checkout, #receipt/<id>,
#orders); doc/launcher-store.md is the record.

Role headings are Navy Conscript, Pirate Raider, and Bounty Hunter.
Public map controls are zoom in/out, centre, and fullscreen; refresh is automatic.
The public map key lists Regions and exactly the published marker categories: Ships, Sea
Patrols, Land Patrols, Villagers and Mobs. Player factions (navy, citizen, criminal, pirate,
prisoner) are private map layers and must never be added to the public key or the export.
Keep the compass to the LEFT of the map key. Personal drawings use world coordinates
and IndexedDB on the visitor's device. They must never enter exports or Git history.
Keep middle-mouse drag exclusively for camera movement, including in drawing mode.

The Electron desktop entry is desktop/main.cjs. Reuse site/ for the UI. Native capabilities
must stay behind the isolated preload and origin-checked IPC; do not enable renderer Node
or expose arbitrary commands, tokens, file access, or remote privileged web content.
`handle()` refuses a sender frame that is not yet the app's own, so the first ask of a launch
can be refused once and the refusal is deliberately recorded nowhere. A read the home screen
starts on mount must therefore be warmed in main (or retried by the renderer) rather than read
as an outage — that is what 1.0.36 got wrong and 1.0.37 fixed. A read like that one is also
answered while the mandatory-update gate is still closed (`REACHABLE_BEFORE_STARTUP` in
`desktop/main.cjs`), because gating it told every returning player "News unavailable" over a
document main was already holding (1.0.36 through 1.0.38). Reads are bounded: an 8 s
timeout, a 64 KiB body ceiling, schema validation and a 30-minute cache is the shape
(`desktop/discovery.cjs`, `doc/launcher-discovery.md`).
A launcher release must carry the current site/, because the packaged app bundles site/ into
its own app.asar; scripts/verify_app_bundle.py gates that before publishing.
Authentication matches /opt/minecraft/launch/mc-auth.py, including its inherited Prism
public-client registration. EASTER_MICROSOFT_CLIENT_ID overrides it. Never borrow existing
users' saved tokens. Save sessions only with OS-backed safeStorage; basic_text is refused.
Use a dedicated app-owned Minecraft directory as the default, offer the player a different
installation location, and keep checksum-verified upstream downloads. Never write into an existing
.minecraft, another launcher's files, the server or the world.
Installing the launcher adds a launcher shortcut for all users of the machine, with an optional
toggle offered at install time. An installed game gets no shortcut that starts it directly: the
client is started by the launcher, and the optional desktop and Start menu entries Settings offers
run the launcher with its `--play` auto-start argument so the mandatory updater still runs. Leave
the existing drun shortcut and installed clients alone as part of launcher work.
First run promotes downloading the client, and Play is gated on both a fully installed client and a
connected account; neither alone is enough. A sticky, minimisable progress bar carries pause,
resume, speed and percentage across every page. doc/launcher-states.md holds the frozen state
contract between the main process and the shared UI; change it before changing either side.
- **The game server's row is four sentences of the launcher's own, never the service's.** One
  table in `desktop/game.cjs` decides both halves: `Server Online, N active players`,
  `Server Online, 0 active players` (also the sleeping host: asleep is not offline),
  `Status pending…` and `Server Offline`. While the launcher is still waiting for the first
  status answer the row reads `Status pending…` with a spinning ring, **never** `Server
  Offline` — that line belongs only to a read that happened and failed. No bracket, no
  duration, no service detail, and no view words a state or picks a tone for itself.
Real platform installers are published as GitHub Release assets. No source download option.
Releases follow doc/releasing.md: the tag comes from package.json, the workflow is dispatched by
hand, the packaged app is checked against site/ before publishing, and /releases/latest ignores
prereleases, so a launcher release must not be marked prerelease while it is the only one.
- **Cut and verify a release only with `scripts/release.sh`.** `--check` runs the
preconditions and the fast suites; `--cut <version> --notes <file>` runs the packaged build
and `scripts/check-packaged-first-screen.mjs` before bumping, then commits, pushes, dispatches
the workflow, watches it and verifies the published assets; `--verify <tag>` checks
SHA256SUMS, both update ASARs and the AppImage's ASAR against `site/` byte for byte, and the
published AppImage's own first screen. Never type the bump, the dispatch or the asset checks
by hand: every step in that script exists because a hand-run release once skipped it.
Before bumping the version, run the packaged build and look at its first screen
(`doc/releasing.md` 1a). 1.0.36 shipped a start-up failure that every unit, browser and Electron
journey passed, because the unpackaged app was fine and only the package was wrong.

The Privacy Policy and Terms of Service live in site/legal/privacy/ and site/legal/terms/ (layout
in site/legal/legal.css) and every footer links to both; they are the URLs the Google OAuth consent
screen names, so they stay reachable without signing in and keep their effective date current. The
legal links sit in the span BEFORE the motto in .home-footer: the launcher writes "Launcher
<version>" into `.home-footer>span:last-child`, so a legal span placed last is replaced on every
render. tests/test_legal_pages.py guards that and the footers; 404.html needs root-absolute legal
hrefs because Pages serves it for any missing path. doc/legal-pages.md records why the documents say
what they say and the retention promises Easter LTD has to keep.

The legal pages are living documents, not a launch artefact: when a design change removes, renames
or adds something a legal page describes — a control, a stored value, a route — correct that page in
the same commit and bump its "Last updated" date (Owen, 2026-10-23: "adjust the legal stuff to suit
our every changing design as we go"). Player-facing prose states what is true today, one fact per
sentence, with no release dates and no engineering history in it; that belongs in doc/. The final
read-through that locks the documents by the end of November 2026 is a dated item in
doc/legal-pages.md, not a promise to remember.

The website's one hand-written data document is site/home.json: the latest dispatch and a
curated store highlight for the launcher's home cards (`doc/launcher-discovery.md` holds the
schema, the bounds and the commerce boundary). Nothing in it may invent a post, a price, a
product or an ownership claim, and the website itself carries none of it.

Artwork belongs to Owen and is not redrawn: take the file he supplies, keep its geometry, and
serve it at the size the page draws it. Measure before choosing a format — the hero backdrop is
blurred 3px, so it ships as a JPEG (2.3 MB of PNG became 306 KB, indistinguishable through the
blur), and the crest ships at 1024 for a 157–252 px slot. Masters stay in Git history rather than
in the payload. Clamp over-long copy; refuse an identifier rather than truncating it.

Frontend work under site/ gets its final visual and interaction pass from the designated frontend
reviewer before it reaches production. Passing tests, the browser suite and even the packaged-app
bundle check are necessary but not sufficient: they prove behaviour, not design. Do not ship a
site/ change on test evidence alone, and do not treat a green gate as the sign-off.

Owen has standing authority to diagnose and fix launcher bugs and ship patch releases end to end:
investigate, ticket, delegate, verify, publish, report, including the follow-up work a fix needs.
Work that leaves this repository's own release process — world or player data, another person's
machine, credentials, restarting a service — still needs its own authorization.

Text line endings are pinned to LF in .gitattributes and tests/test_line_endings.py enforces it.
scripts/verify_app_bundle.py compares the packaged app.asar against site/ byte for byte, and the
Windows installer is built on a Windows runner where Git's default autocrlf would rewrite every
site/ text asset to CRLF, so the bundle check would fail on a bundle that is not stale at all.
That is exactly what happened to launcher-v1.0.2 run 38835252575. Keep the pin and the guard.
