# Website artwork

The hero crest at `site/assets/crest.jpg` is generated promotional artwork, using
`site/assets/favicon.png` as the reference for Easter Company's rising phoenix.
Its navy enamel shield, antique-gold bird and block-built
sailing ship bring the server identity into the website's navy, teal and gold palette.
The phoenix is the primary silhouette; lettering and maritime details are secondary.
This replaces the original scene-heavy server artwork. The company favicon remains
the canonical emblem reference.

The crest is served at 1024 × 1024, re-encoded from the 1254 × 1254 master that was
committed with it (`git log -- site/assets/crest.jpg`), stripped of metadata, at JPEG
quality 86. The hero draws the crest at 157–252 CSS px, so 1024 still covers a 3×
display and the file also serves as the `og:image` share card; measured against the
master at 504 px the re-encode is indistinguishable (PSNR 37.4 dB) and 42% smaller
(286 KB against 490 KB), which matters on a phone and inside the packaged launcher.
Every master behind it — swords, no swords, cleaned harbour — stays in the history
rather than in the payload.

The opening environment is promotional concept art, not a precise view or map of the
actual saved world. The public atlas always uses real saved terrain.

Generated background destination: `site/assets/harbour.jpg`.
Mode: built-in image generation, `stylized-concept`.

Brief: a wide cinematic Minecraft-style archipelago at blue-hour dusk; teal ocean and
dark navy sky, a Royal Navy sailing ship with cream sails on the right, a warm island
harbour with stone waterfront, timber bakeries and cottages, distant green islands and
mountains, volumetric mist, water reflections and crisp voxel geometry. Keep the left
and centre atmospheric and open for text. Restrained navy, teal, wood and amber palette.
No lettering, logos, oversized characters, interface, frame or watermark.

The harbour cleanup simplifies the ship to two masts, clearer square sails and
purposeful rigging. Street lamps and rows of glowing deck fixtures are removed
from the ship; a single cabin lantern remains. Quayside lighting, simpler harbour
buildings and a clearer ship silhouette retain the original blue-hour composition.
The site and launcher share this asset; packaged launchers need a new build to
include the updated background.

The background ships as a JPEG at quality 84 rather than the PNG it was generated as:
2.3 MB of PNG sat on the critical path behind a `preload`, and the same image is
306 KB as a JPEG. `site/styles.css` blurs it 3px at the size the page draws it, and
through that blur the two files measure 48.8 dB apart — identical to the eye. The
generated PNG stays in the history (`git log -- site/assets/harbour.*`).

## Illustrated website chapters (2026-10-26)

Four new promotional illustrations accompany the public homepage: a working harbour
and sailing home, Navy law and bounty hunting, a Nether expedition, and an Ender
Dragon encounter. Generated with the built-in image tool (`stylized-concept`),
using the complete prompts preserved in `doc/homepage-art-prompts.json`. Existing
crest and background artwork are unchanged. The source brief is Owen's gameplay
dump of 2026-10-26; these images illustrate the experience, not the saved terrain.

Final assets: `site/assets/world-harbour.webp`, `world-law.webp`,
`world-nether.webp`, and `world-end.webp` (all in `site/assets/`). Each is
1536 × 1024, encoded as WebP quality 86, metadata stripped, and lazy-loaded with
reserved dimensions. Total transferred artwork is approximately 1.24 MiB.
The chapters live inside `.home-below`, which desktop.js removes for the launcher's
separate home. No launcher version bump is needed for the public homepage change.

Owen's artwork refinements remove all repeated banners and masthead flags from
the law scene, dress the three Navy officers in British redcoat-like scarlet
uniforms, and replace the End scene's background island archipelago with one
continuous main arena and a restrained ring of obsidian pillars. Each edit's
exact prompt is preserved alongside the original generation brief.

## Crafting and personal survival chapters

Two additional illustrations use the built-in image tool, stylized-concept mode.
`site/assets/world-crafting.webp` depicts a small coastal workshop and the gradual
move from kiln to metalworking. `site/assets/world-survival.webp` shows companions
sharing food and maintaining equipment at camp. Both preserve full 1536 × 1024
compositions, use quality-86 WebP and lazy loading, and avoid banners and repetitive
scenery. Exact briefs are in `doc/crafting-survival-art-prompts.json`. These are
promotional illustrations, not screenshots or exact workstation models.

## Ships and naval combat chapters

Two new promotional illustrations accompany the Ships & crews and Ship combat
chapters. Generated with the built-in image tool in stylized-concept mode; final
assets are `site/assets/world-ships.webp` and `site/assets/world-ship-combat.webp`.
Both are 1536 × 1024 quality-86 WebP, lazy-loaded without cropping. Exact prompts
are in `doc/ships-homepage-art-prompts.json`; content notes are in
`doc/ships-homepage.md`. Existing artwork is unchanged.
