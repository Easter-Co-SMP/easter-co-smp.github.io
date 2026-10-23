// Local, static vector emblems. No remote images, tracking or supplied SVG.
//
// They are cut for Sol's circular coin medallion: a square 100x100 viewBox, composition inside the
// circle's inscribed area, and nothing in the corners, because the medallion clips to a circle.
// Currency illustrations progress from a few coins to a pouch and an overflowing chest.
// Donations have a heart above gifted coins. The product titles and prices remain the server's.
const emblems = {
  coins: `
    <ellipse cx="50" cy="82" rx="32" ry="5" fill="#102a2c" opacity=".6"/>
    <g stroke="#f3d79e" stroke-width="1.4">
      <path d="M20 63v10c0 11 38 11 38 0V63" fill="url(#sterling-gold)"/>
      <ellipse cx="39" cy="63" rx="19" ry="8" fill="#f0cf87"/>
      <ellipse cx="39" cy="63" rx="14" ry="4.8" fill="none" stroke="#ad7937"/>
      <path d="M47 61v10c0 9 34 9 34 0V61" fill="url(#sterling-gold)"/>
      <ellipse cx="64" cy="61" rx="17" ry="7" fill="#e9c579"/>
      <circle cx="52" cy="41" r="22" fill="url(#sterling-gold)"/>
      <circle cx="52" cy="41" r="17.5" fill="none" stroke="#97662e"/>
      <circle cx="52" cy="41" r="15.5" fill="none" stroke="#fff0b9" stroke-width=".6"/>
    </g>
    <path d="m52 29 3.1 7 7.6.9-5.5 5.2 1.4 7.5-6.6-3.6-6.6 3.6 1.4-7.5-5.5-5.2 7.6-.9Z" fill="#fff0bb" stroke="#b5813e" stroke-width=".7"/>
    <path d="M26 70v5m6-4v6m37-10v6m6-8v5" stroke="#946530" stroke-width="1.2"/>
  `,
  pouch: `
    <ellipse cx="50" cy="85" rx="31" ry="5" fill="#102a2c" opacity=".6"/>
    <path d="m35 15 7 4 8-5 8 5 8-4-6 18c11 12 19 24 18 35-1 19-55 23-57 1-1-12 8-24 19-36Z" fill="url(#sterling-leather)" stroke="#e1bc7d" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="m42 20 3 12m13-11-4 12M36 43c-6 10-10 18-8 26m34-27c7 12 10 21 7 30" fill="none" stroke="#f2cc8d" stroke-width="1.3" opacity=".5"/>
    <path d="M38 32q12 6 24 0m-23 4q12 5 22 0" fill="none" stroke="#f3d79e" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M60 35q16 2 12 11-7 4-12-11 12 13 10 23" fill="none" stroke="#d5a75a" stroke-width="2"/>
    <circle cx="49" cy="59" r="14" fill="url(#sterling-gold)" stroke="#f4dca6" stroke-width="1.3"/>
    <circle cx="49" cy="59" r="10.5" fill="none" stroke="#996a31"/>
    <path d="m49 51 2.3 5 5.4.6-4 3.8 1 5.3-4.7-2.6-4.7 2.6 1-5.3-4-3.8 5.4-.6Z" fill="#fff0bb"/>
    <ellipse cx="73" cy="79" rx="12" ry="4.5" fill="#dfb565" stroke="#f4dca6" stroke-width="1.2"/>
  `,
  chest: `
    <ellipse cx="50" cy="86" rx="35" ry="5" fill="#102a2c" opacity=".6"/>
    <path d="M20 42V27q0-12 29-14 28 0 29 12v18Z" fill="url(#sterling-wood)" stroke="#e5c082" stroke-width="1.4"/>
    <path d="M22 33q28-12 54-3M30 19v23m37-23v22" fill="none" stroke="#dab466" stroke-width="4"/>
    <path d="m18 48 30-7 34 9-4 29-29 8-28-10Z" fill="url(#sterling-wood)" stroke="#f0cf8c" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="m49 56 32-6-3 29-29 8Z" fill="#40332b" opacity=".65"/>
    <path d="m20 49 29 8 31-7" fill="none" stroke="#ffe5a4" stroke-width="3"/>
    <g fill="url(#sterling-gold)" stroke="#f4dba0" stroke-width="1">
      <ellipse cx="33" cy="44" rx="12" ry="5"/><ellipse cx="57" cy="44" rx="14" ry="5"/>
      <circle cx="43" cy="36" r="9"/><circle cx="64" cy="35" r="9"/>
      <ellipse cx="46" cy="47" rx="12" ry="5"/><ellipse cx="70" cy="47" rx="10" ry="4"/>
    </g>
    <path d="m29 53 2 26m35-25-2 28" stroke="#d7ac5d" stroke-width="5"/>
    <path d="m44 57 11-1v15l-11 2Z" fill="url(#sterling-gold)" stroke="#f4dba0"/>
    <path d="M49 61v6" stroke="#684a26" stroke-width="2.5" stroke-linecap="round"/>
    <path d="m83 23 1.5 4.5L89 29l-4.5 1.5L83 35l-1.5-4.5L77 29l4.5-1.5Z" fill="#ffe3a0"/>
  `,
  donation:
    `<defs>
      <linearGradient id="gift-gold" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#fff1c5"/><stop offset=".45" stop-color="#d9ad5b"/><stop offset="1" stop-color="#92652f"/>
      </linearGradient>
      <linearGradient id="gift-heart" x1="0" y1="0" x2=".7" y2="1">
        <stop stop-color="#f5b89c"/><stop offset=".5" stop-color="#cf7863"/><stop offset="1" stop-color="#874537"/>
      </linearGradient>
      <radialGradient id="gift-glow"><stop stop-color="#f5cd8170"/><stop offset="1" stop-color="#f5cd8100"/></radialGradient>
    </defs>
    <circle cx="50" cy="44" r="42" fill="url(#gift-glow)"/>
    <ellipse cx="50" cy="85" rx="30" ry="4" fill="#101f25" opacity=".5"/>
    <g stroke="#f3d79e" stroke-width="1.2" stroke-linejoin="round">
      <path d="M29 70v7c0 9 42 9 42 0v-7" fill="url(#gift-gold)"/>
      <ellipse cx="50" cy="70" rx="21" ry="7" fill="#e8c784"/>
      <path d="M33 61v8c0 8 34 8 34 0v-8" fill="url(#gift-gold)"/>
      <ellipse cx="50" cy="61" rx="17" ry="6" fill="#f1d59b"/>
    </g>
    <path d="M35 72v5m7-3v5m16-5v5m7-7v5" stroke="#80562f" stroke-width="1.1"/>
    <path d="M50 58C45 53 26 42 26 30c0-15 18-19 24-7 6-12 24-8 24 7 0 12-19 23-24 28Z" fill="url(#gift-heart)" stroke="#f0c197" stroke-width="1.5"/>
    <path d="M32 30c0-7 8-10 13-5" fill="none" stroke="#ffe0c3" stroke-width="2.5" stroke-linecap="round" opacity=".8"/>
    <path d="m50 30 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="#fff0c5"/>
    <g fill="#f8dfa8"><path d="m19 42 1.5 4.5L25 48l-4.5 1.5L19 54l-1.5-4.5L13 48l4.5-1.5Z"/><path d="m79 17 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/><circle cx="77" cy="57" r="1.5"/><circle cx="24" cy="19" r="1"/></g>`,
};
export function productArt(kind) {
  return (
    '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
    '<defs>' +
    '<linearGradient id="sterling-gold" x2=".8" y2="1"><stop stop-color="#fff1c3"/><stop offset=".4" stop-color="#dcb56b"/><stop offset="1" stop-color="#98672e"/></linearGradient>' +
    '<linearGradient id="sterling-leather" x2="1" y2=".7"><stop stop-color="#b38951"/><stop offset=".48" stop-color="#805b35"/><stop offset="1" stop-color="#443526"/></linearGradient>' +
    '<linearGradient id="sterling-wood" x2=".6" y2="1"><stop stop-color="#956338"/><stop offset=".5" stop-color="#67452e"/><stop offset="1" stop-color="#352d27"/></linearGradient>' +
    '</defs>' +
    (emblems[kind] || emblems.coins) +
    "</svg>"
  );
}
