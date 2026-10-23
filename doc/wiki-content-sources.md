# Wiki content: scope, evidence and maintenance

## Editorial contract

The twelve real guides replace the six layout demos. Document only installed changes that affect a vanilla player's decision. Use 300–600 words normally, at most five substantive sections, and two or three related guides. Place common rules on one owner page rather than duplicating a manual of vanilla Minecraft. Entries for recipes, NPCs and places stay inside their parent article.

The earlier authoring kit is the scope baseline. The complete public catalogue is `site/wiki/pages.mjs`; the website and launcher use the same file. Private source notes, production paths and open implementation questions never belong in the player copy.

The renderer uses textContent for all authored content, with optional paragraphs, ordered steps, flat lists, tables, notes, section guide links and a map action. It does not parse arbitrary HTML or Markdown. Search includes every player-facing text field. Mobile tables scroll inside their container; article pages must not widen the document.

## Reviewed deployment

Read-only source/content audit on 2026-10-18:

- Mod source: `/opt/minecraft/navy-mod`, `d934a0b`.
- Built and installed mod JARs are byte-identical: SHA256 `7eb1c239b9e82768a4a92afe05438f3bc4181dffb6e8ca7d7db8895f9e85df7d`.
- Patch chain: `/opt/minecraft/pack-patches`, `4c76d94`; only active patches from build_pack.sh were used.
- Loaded world pack: `/opt/minecraft/server/world/datapacks/MF_DP_1_12_4_26_2.zip`, SHA256 `a2df5f46a2d50afc5e8fa1e0e58648289918631143dc982299f328c31c731552`.
- Display names checked against `/opt/minecraft/resourcepack/MatchaFlavoured_1_12_3.zip` where needed, notably resin_brick -> Steel Alloy.
- Latest prior full canonical mod build: all 42 Java harnesses passed. The production source changed only in test/build reporting in that commit. Earlier focused bank, law/fleet and live client evidence is recorded in /opt/minecraft/NOTES.md and the mod's deployment records.

These are source/deployment claims, not a claim that this wiki task performed every gameplay interaction. No production scores, entities, terrain, inventory, world rules or server processes were changed to research the wiki.

## Article evidence matrix

| Guide | Source anchors checked | Material claims / decisions |
|---|---|---|
| Getting started | StarterKit.onJoin; client.MainMenuScreen; client.TabMenu; loaded setup | One-time £50 wallet/bank grants, empty-inventory gear condition, direct reconnect, orientation rather than class selection. |
| Health & death | Loaded death_drop output; reset/run; heart_container/hpdown, set_max_hp, decrease_minimum_hearts, use_crystal_heart; setup floors; XP patch; VillagerShop.heal | Ordinary backpack-only drop, bounty/reset exceptions, XP persistence, death removes 2/4 health points, two points per heart, per-player floor outside Easy, 60-point ceiling, Zuri cooldown. Do not flatten the personal floor into “everyone starts on two hearts.” |
| The world and its regions | AreaDefinitions; MapZones.enforce; RegionNotice.describe; SafeZoneGuard.pvpCancelled; Law.applies; public map exporter | Independent flags, Overworld jurisdiction, Wilds naming, hostile-type eviction, pirate and explosion PVP exceptions, cross-boundary protection, public snapshot without player positions. |
| Ships & sailing | Rowing; SailingHandling; ShipInventoryControls; ShipControls; EasterFleet.claim/capture/name/abandon/scuttle; ShipRegistry.acquire; VesselAbandonment | Movement controls, zero-speed backward stroke, no spin without travel, pilot/cargo binding, defending-crew gate, 1–48-char name, one ownership registration, lawful seizure exception for pirate-owned hulls, destructive scuttle and strict >24,000-tick cleanup with all four empty conditions. |
| Wildlife & pets | Crime; PropertyLaw; animal_crime_patch; Wildlife.PROTECTED, registered maps, strayedFromOwner and clocks; HorseStableHarness, CatClockHarness, ChickenNameHarness, BullGuardHarness | Named vs owned vs registered, owner/pirate exceptions, pet 20/200p and livestock 10/100p bases, selected island respawns, cat extinction rule, two horses and >=512-block same-dimension/online-owner return. Do not publish private account UUIDs or household ownership. |
| Law & bounties | Law; SafeZoneGuard; loaded faction functions; TntCrime; PortalCrime; Crime claim/arrest; Jail; Prisoner; NavyService/Day; Absolution; Bounty | 5p/100p bands, mark versus balance, ordinary multiplier vs flat charges, TNT 100/500/2500p, portal 1250p, five-minute tags, global eligible claims, pirate payout exclusion, full carried loss, arrest debt, 15p/cell minute, service 5p days1–6 and continuity, 1/8 posted tax. |
| Money & banking | Money.CAP/START/privilegesRevoked; Bank.START/deposit/withdraw/buyObols/sellPence; StarterKit; VillagerDialogs.banker; VillagerCommands.menu | Wallet10000p, initial5000p each, bounty>0 blocks bank/shop, bank not auto-spendable, dialog input units, multiples-of-four exchange, capacity/refusal conditions. |
| Crews & property | CrewCommands.build; HouseAccess.role/mayEdit; HouseGuard.check/verdict; ShipPolicy.theft/pilotCrime; HouseCommands | Mutual non-transitive alliances; exact six player commands; doors versus reachable-container theft; owner interior furniture only, not structure; no player purchase command behind For Sale. |
| Cooking & crafting | Loaded recipes food/oven/baked_apple,baked_pumpkin,grilled_melon; item components/modifiers; advancement recipe_unlocks; food_nutrition patch | 1 input -> 1 output, smelting100ticks, no food component on the dishes, resistance600ticks/fire resistance200ticks and healing effects. Some discoveries unlock subsequent recipes; no claim that every recipe is unlocked at first join. |
| Village services | VillagerCommands registration/menu; VillagerDialogs; VillagerShop stock/openForBusiness/heal/bless; Bank; Jail/Bounty guards | All menu commands are player-level and do not require a nearby physical NPC. Cast roster currently contains only Zuri: do not publish a fictional walking-location directory. Shops/bank check bounty>0, not a blanket “marked users cannot shop after paying.” Mend5min, Bless1p/regenerationII30s/absorptionII120s; clean helper/poster checks; no working harbour passage sale. |
| Equipment & enchanting | XP patch and loaded set_xp; empty in_enchanting_table tag; smithing/steel_sword,steel_pickaxe; intrinsic_enchants functions; resourcepack en_us | Anvil only tops levels up, no normal enchanting-table offers, Mending not removed, template-free iron+Steel Alloy smithing recipes, custom tooltips and intrinsic effects. Do not promise all repair is free or all effects transfer. |
| Raids & expeditions | Loaded hardmode/tick, buff_nether, buff_dragon; first_dragon_killed_reward and current function chain | Type-based doubled mob baselines and supported melee attributes, dragon max1600 without an attack-attribute increase, dragon-kill advancement-triggered centre-End drop. No fixed20-player entry gate, weekly reset or world-buff schedule was established; those marketing/intended features are not published as current instructions. |

## Corrections found while authoring

- Tag.toString quotes from the old horse harness were syntax, not corrupt in-world names; the wiki does not repeat that false diagnosis.
- PVP Safe is not an explosion or pirate immunity guarantee. PVE Safe evicts covered hostile types rather than preventing all damage.
- Accessible storage is not a locked permission boundary. Stranger withdrawals can be theft; owner/crew access and law jurisdiction are separate.
- `Money.privilegesRevoked` currently checks bounty>0. Older prose describes the Criminal timer itself as a shopping ban; the current executable predicate wins.
- The physical cast NPC roster is incomplete. The existing player menu commands are the working service entry path, so the guide explicitly supplies them rather than inventing merchant coordinates or spawning NPCs.
- The dragon function sets maximum health, not an attack multiplier. The wiki does not infer stronger contact damage from it.
- Existing marketing references to weekly resets/world buffs or 20+ players are not evidence of an implemented schedule or entry requirement.

## Links and review

Article and section IDs are permanent once published, and old section routes such as raids-and-expeditions/prepare-together redirect to their replacement sections. One deliberate exception, dated 2026-10-23: the article about the world's regions was published under an older place name for the server, and Owen retired that name on 2026-10-23 — his rule is that the server is the Easter Co. Survival Multiplayer Server (Easter Co. SMP) and that the copy invents no other name for it — so it is retitled "The world and its regions" with the ID `the-world-and-its-regions`, and the world is called "the world", "the server" or "Easter Co. SMP" from then on. A bookmark to the retired ID now lands on "That page isn't on the chart.", and its old section route cannot be redirected without keeping the retired name in the catalogue, so it lands there too. Unit checks validate page IDs, section IDs, table shapes, guide links and old alias targets, and require the twelve completed articles without demo placeholders. Browser checks exercise original routes, rich tables and guide links; Electron checks deny network requests and use an isolated test home.

The designated independent frontend reviewer approved the final visual/interaction pass on 2026-10-18: all12 at1440/390/320, no document overflow or page JS errors, keyboard topics/search/focus/skip, table scrolling and offline Electron. Internal screenshots /tmp/wiki-review-*; reviewer-owned processes and test home cleaned up. Public content contains no review machinery.

## Maintenance

Update the owner page after a gameplay-rule deployment, then recheck its short summaries/links. Preserve public IDs. Keep new questions in this editorial record instead of public “coming soon” sections. Recheck recipe quantities and displayed ingredient names from the loaded pack/resourcepack, not only raw item IDs. Verify website and packaged-launcher content separately when publishing.

Final claim corrections: the Criminal mark decrements only on online players in easter:money/tick. The dragon drop is a reward function on matcha:end/kill_dragon, a per-player advancement completion; the function name “first_dragon_killed_reward” alone does not establish a world-once gate. Public copy follows the advancement trigger and does not promise a payout to every participant.
