# Website artwork

The hero crest at `site/assets/crest.jpg` is generated promotional artwork, using
`site/assets/favicon.png` as the reference for Easter Company's rising phoenix.
Its navy enamel shield, antique-gold bird and block-built
sailing ship bring the server identity into the website's navy, teal and gold palette.
The phoenix is the primary silhouette; lettering and maritime details are secondary.
This replaces the original scene-heavy server artwork. The company favicon remains
the canonical emblem reference.

The crest is served at 1024 × 1024, re-encoded from the 1254 × 1254 master that was
committed with it (`git log -- site/assets/crest.jpg`), stripped of metadata, at
JPEG quality 86. The hero draws the crest at 157–252 CSS px, so 1024 still covers a
3× display and the file also serves as the `og:image` share card; measured against
itself at 504 px the re-encode is indistinguishable (PSNR 36.6 dB) and 43% smaller
(318 KB against 560 KB), which matters on a phone and inside the packaged launcher.

The opening environment is promotional concept art, not a precise view or map of the
actual saved world. The public atlas always uses real saved terrain.

Generated background destination: `site/assets/isles-harbour.png`.
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
