# Easter Co. public site

This is a buildless GitHub Pages site, not an e-server page. Read README.md before changes.
Keep shared Home, Download, Map, and disabled Wiki navigation. The public map is view-only.
Secondary branding is "The Ultimate MC Experience". Welcome veterans, pros and absolute
beginners. Keep the rich casual early game and cooking/baking/brewing contributions
alongside the harder progression, team encounters, and crime/punishment mechanics.
The endgame includes weekly 20+ player Ender Dragon raids, boss world buffs and weekly
boss resets. Do not display the elytra limit or first-elytra house prize on the website.

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

Hero copy is "Easter Co. SMP" and "The Ultimate Multiplayer Minecraft Experience".
Download Launcher is the primary gold CTA, left of the secondary View Map action. The
custom launcher is built separately. The nav always opens the shared dropdown. The hero is a split control: main button
auto-selects Windows x64 or Linux AppImage; attached arrow opens that shared platform
dropdown (Windows 64bit Version, Ubuntu, Arch, AppImage, Source), not a download page. Use the authorized dummy TXT download in site/assets/launcher-placeholder.txt until
real builds exist. Both automatic and manual selections open the Setup & Install modal
after starting the download. Instruction copy is a placeholder by user request.
Wire real release URLs in site/downloads.js; do not mislabel the server mod as a launcher. Write release copy with no Coming soon badges or availability placeholders.
The download will include the custom Easter Company launcher and Minecraft client.
