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

## The cannon sentence is forward-looking, not a description of today

Owen, 2026-10-26, asked for this in so many words: **"keep it, we'll add the features later."**

That sentence in the Ship combat chapter — "Purchase or craft cannons to give your ship serious
firepower" — is therefore a promise, not a report, and nothing below it is implemented today.
Measured before it was published, 2026-10-26:

- Shippy Ships 1.0.23.1 (the only ship mod on the server and in the launcher's manifest) carries no
  `cannon` string in any class; what it does implement is ramming, as per-hull `*Rammer` subentities
  (`SailboatRammer`, `CogRammer`, `CogRammerSmall`, `CaravelRammer`), which is why the ramming
  warning in that chapter is accurate.
- The launcher's client manifest ships exactly five dependencies — Fabric API, Shippy Ships,
  IngeniumAPI, Tectonic, Lithostitched (site/data/client.json) — and no cannon mod.
- The ships wiki page (site/wiki/pages.mjs, `ships-and-sailing`) never mentions cannons.
- The only trace in the whole tree is IngeniumAPI's own description, "API for Shippy Ships and
  OldCannons": a sibling mod that is installed nowhere we can see.

So: do not cite this page as evidence that cannons exist, and if the feature never lands, the
sentence and its "Make room for the big guns" heading come out. Scuttling and ramming need no such
caveat — they are in the game (EasterFleet.scuttle / ShipControls, and the rammers above).

Validation: all 146 Python tests completed successfully (one existing skip), full
site validation passed with 129 files, and whitespace checks passed. Interactive
visual review uses the supported cloud browser; the CLI browser suite's hardcoded
runtime paths are absent in this environment. No packaged launcher release is
part of this change.
