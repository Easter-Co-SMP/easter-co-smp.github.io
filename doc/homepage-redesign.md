# Illustrated public homepage

The 2026-10-26 redesign replaces the compact marketing block below the hero with
four illustrated chapters: Overworld sailing and starting out; law, factions and
crime consequences; Nether expeditions; and the weekly End encounter.

Owen's current gameplay dump is the source for the new copy. Its Dragon guidance
supersedes the old homepage's 20+ player marketing claim: at least three very strong
players, with ten or more recommended for an average group. It describes weekly
End regeneration and the end of hostile Overworld surface spawning until the next
Wednesday reset around 04:00 EST. It does not change game rules or the wiki.

The native details/summary control reveals crime, wallet, debt and prison rules.
Chapter anchors and wiki/map links work without JavaScript. The new styles are in
site/world-journal.css; the whole section retains .home-below so the existing
launcher removes it before rendering its own home. Shared hero, account and store
controls retain their existing behaviour. Artwork and prompts are documented in ART.md.

Validation: 146 Python tests passed (one existing skip), site validation and git
diff checks passed. Independent frontend review approved desktop and real 320px
and 390px iframe viewports, including chapter anchors, expanded crime details,
art framing and zero horizontal overflow. Browser verification used the supported
cloud browser. The repository's Playwright CLI suite could not run here because
its hardcoded browser/runtime paths are absent. No packaged launcher exists in
this checkout; verify_app_bundle.py therefore reports nothing to compare.
