# Easter Co. public site

This is a buildless GitHub Pages site, not an e-server page. Read README.md before changes.
Preserve the landing page’s lack of top navigation. The public map is view-only.

Player data must never enter site/ or Git history. Use scripts/export_world.py and its
strict allowlist. Never use the private snapshot endpoint as a public export. Keep
credentials and runtime state outside this repository. Do not publish third-party JARs.

scripts/sync.py owns generated site/data/ and site/downloads/. It must preserve durable
local commits when pushes fail, catch up after boot without inventing historical states,
and never force-push or discard changes to hand-written files. Run recovery and privacy
tests after exporter or sync changes; validate the complete site before pushing.

Never restart e-server, DSH, or Minecraft for a public-site update. The public-site timer
has its own service. No console mutations, world generation, or changes to game rules.
