# Ships and naval combat homepage chapters

Two new illustrated chapters follow the introductory Overworld/sailing chapter.
Ships & crews covers Navy aid for peaceful players/bounty hunters, patrol raids,
NPC pirate pillager vessels, cargo/helm controls, claiming/naming/scuttling,
crew permission and law protection without physical invulnerability. The next
chapter covers purchased/crafted cannons, bow crews, boarding and the risks of
ramming different hulls. No weapon damage values or undocumented controls are
invented. Existing sections, alignment work and revised encounter recommendations
are preserved; chapter numbering and navigation now cover all eight chapters.

Copy source: Owen's current ship and combat briefs. Existing ownership and crew
limits are documented in site/wiki/pages.mjs (ships-and-sailing, crews-and-property),
including one registered vessel per owner. Fleet expansion is described as a crew
effort rather than promising multiple personal registrations. This is website copy;
no game rules, player records or launcher release are changed. The .home-below
container still gives the launcher its separate home.

The built-in image tool produced two 1536x1024 promotional illustrations:
site/assets/world-ships.webp and site/assets/world-ship-combat.webp. Both use
quality-86 WebP, reserved dimensions, lazy loading, and full compositions. Briefs
are preserved in ships-homepage-art-prompts.json. They illustrate gameplay rather
than acting as screenshots or precise ship models. Navy crew retain redcoat-style
uniforms and the artwork avoids flags, banners and repetitive scenery.

Validation: all 146 Python tests completed successfully (one existing skip), full
site validation passed with 129 files, and whitespace checks passed. Interactive
visual review uses the supported cloud browser; the CLI browser suite's hardcoded
runtime paths are absent in this environment. No packaged launcher release is
part of this change.
