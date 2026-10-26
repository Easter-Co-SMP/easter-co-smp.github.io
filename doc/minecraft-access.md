# Microsoft sign-in and Java access

Microsoft authentication can succeed without Minecraft Java access or a configured Java profile. It is a valid signed-in session, not a generic sign-in failure.

State exposes only `minecraftAccess` (signed-out, owned, missing, profile-required, unknown) and `microsoftAccount` (public id/name). Tokens and entitlement responses stay in the main process. Legacy sessions with a valid profile are rechecked before launch. Access is checked from Minecraft's license endpoint; game_minecraft or product_minecraft grants Java access, including subscription access. Only a successful well-formed license response without either entitlement selects missing. An entitled account with profile HTTP 404 selects profile-required; transport/server/malformed responses select unknown and never a sales prompt.

Missing access: Home and utility-page idle dock show Buy Now, opening the fixed official Java & Bedrock PC store in the external browser. Supporting copy names the requirement, offers Check again after purchase and Use a different account. Profile-required offers the official profile page and recheck. Unknown offers retry, not Buy Now. Checking again refreshes the existing Microsoft session if needed and re-queries access/profile without another pass through the browser sign-in while the session remains valid.

Sessions without profiles use their Xbox identity in the same OS-encrypted vault; there is no plaintext fallback or fake Minecraft profile. Switching, logout and account addition preserve existing account semantics. Newly added accounts replace the active account only after Microsoft authentication succeeds. Cancellation and authentication failure retain the previous active account.

Play requires current launcher/game, Java access, and a valid Java profile. Every launch rechecks access; a revoked/expired entitlement cannot launch or enrol an Easter Company account. Recheck transitions the same account to Download or Play once its entitlement and profile are ready, without duplicate saved entries.

These rules supplement doc/launcher-states.md.
