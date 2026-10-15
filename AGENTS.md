# Easter Co. public site

This is a buildless GitHub Pages site, not an e-server page. Read README.md before changes.
Preserve the landing page’s lack of top navigation. The public map is view-only.
Secondary branding is "The Ultimate MC Experience". Welcome veterans, pros and absolute
beginners. Keep the rich casual early game and cooking/baking/brewing contributions
alongside the harder progression, team encounters, and crime/punishment mechanics.
The endgame includes weekly 20+ player Ender Dragon raids, boss world buffs and weekly
boss resets. The elytra limit is one per week across the entire server. The best spawn
island player house is the first-elytra prize; do not invent a recurring house award.

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
