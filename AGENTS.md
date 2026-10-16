# Easter Co. public site

This is a buildless GitHub Pages site, not an e-server page. Read README.md before changes.
Keep shared Home, Download, Map, and disabled Wiki navigation. The public map is view-only.
Secondary branding is "The Ultimate Minecraft Experience". Welcome veterans, pros and absolute
beginners. Keep the rich casual early game and cooking/baking/brewing contributions
alongside the harder progression, team encounters, and crime/punishment mechanics.
The endgame includes weekly 20+ player Ender Dragon raids, boss world buffs and weekly
boss resets. Do not display the elytra limit or first-elytra house prize on the website;
tests/test_site_assets.py enforces that removal against site/.

Player data must never enter site/ or Git history. Use scripts/export_world.py and its
strict allowlist. Never use the private snapshot endpoint as a public export. Keep
credentials and runtime state outside this repository. Do not publish third-party JARs.

scripts/sync.py owns generated site/data/ and site/downloads/. It must preserve durable
local commits when pushes fail, catch up after boot without inventing historical states,
and never force-push or discard changes to hand-written files. Run recovery and privacy
tests after exporter or sync changes; validate the complete site before pushing.

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
after starting the download. Instruction copy is a placeholder by user request.
Wire real release URLs in site/downloads.js; do not mislabel the server mod as a launcher. Write release copy with no Coming soon badges or availability placeholders.
The download will include the custom Easter Company launcher and Minecraft client.

Do not display Source, source code bundles, standalone client/server bundle options, or the old direct-mod download section.

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
A launcher release must carry the current site/, because the packaged app bundles site/ into
its own app.asar; scripts/verify_app_bundle.py gates that before publishing.
Authentication matches /opt/minecraft/launch/mc-auth.py, including its inherited Prism
public-client registration. EASTER_MICROSOFT_CLIENT_ID overrides it. Never borrow existing
users' saved tokens. Save sessions only with OS-backed safeStorage; basic_text is refused.
Use a dedicated app-owned Minecraft directory as the default, offer the player a different
installation location, and keep checksum-verified upstream downloads. Never write into an existing
.minecraft, another launcher's files, the server or the world.
Installing the launcher adds a launcher shortcut for all users of the machine, with an optional
toggle offered at install time. An installed game gets no system shortcut of its own: the client is
started from the launcher. Leave the existing drun shortcut and installed clients alone as part of
launcher work.
First run promotes downloading the client, and Play is gated on both a fully installed client and a
connected account; neither alone is enough. A sticky, minimisable progress bar carries pause,
resume, speed and percentage across every page. doc/launcher-states.md holds the frozen state
contract between the main process and the shared UI; change it before changing either side.
Real platform installers are published as GitHub Release assets. No source download option.
