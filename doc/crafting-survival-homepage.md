# Crafting and survival homepage additions

The current homepage adds two illustrated chapters after sailing, before law.
The existing launcher still removes their .home-below container.

The personal mechanics copy follows Owen's 2026-10-26 request: four starting
hearts, progression through crafting/exploration, possible heart loss on death,
no natural regeneration, food healing restricted by fullness, starvation affecting
vitality/stamina rather than damaging health, ordinary backpack loss with surviving
worn gear and hotbar retained, and full equipment/inventory loss on a bounty claim.
No game rules or wiki articles are changed by this marketing-page task.

Crafting sources:
- Existing site/wiki/pages.mjs cooking-and-crafting and equipment-and-enchanting;
  their installed-pack evidence is recorded in doc/wiki-content-sources.md.
- Author's project page: https://modrinth.com/datapack/matcha-flavoured
- Author's source repository, branch 26.2, commit
  8728d9acfc7b7e6357a367ac8fe244dccba858f0:
  https://github.com/kleiwright/matcha-flavoured/tree/8728d9acfc7b7e6357a367ac8fe244dccba858f0
  Tutorial advancements and matching MF_resourcepack en_us strings establish grass
  drying, kiln, blast furnace, Carbon-Rich Iron, Steel Alloy and smithing stages.
  MF_datapack/data/matcha/recipe/crafting/carbon_rich_iron.json,
  recipe/blast/steel_alloy.json and smithing recipes confirm the material route.
  This upstream branch is supplemental; exact recipe counts and timings are not
  promised on the homepage. Server-specific health/death follows Owen's brief.

Validation: 146 Python tests passed (one existing skip), validate.py passed, and
whitespace checks passed. Independent frontend review approved the desktop and
real 320px/390px iframe layouts, both full artwork compositions, numbered crafting
steps, survival/bounty rules, chapter anchors and all three wiki links. No
horizontal overflow at any reviewed width. The CLI browser suite's hardcoded
Chromium/Playwright installation is absent here, so interactive review used the
supported cloud browser. No packaged launcher release is part of this change.
