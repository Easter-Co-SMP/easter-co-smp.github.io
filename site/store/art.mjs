// Local, static vector emblems. No remote images, tracking or supplied SVG.
//
// They are cut for Sol's circular coin medallion: a square 100x100 viewBox, composition inside the
// circle's inscribed area, and nothing in the corners, because the medallion clips to a circle.
// Two emblems is the whole set, and neither says anything about the product: a pack of Sterling is
// drawn as coins and anything the server calls a donation is drawn as a heart above gifted coins. The card's words
// are the server's; this is decoration, and a kind with no emblem of its own still gets one.
const emblems = {
  coins:
    '<g fill="#b99552" stroke="#f0d399" stroke-width="2">' +
    '<ellipse cx="50" cy="78" rx="26" ry="9"/>' +
    '<path d="M24 62v16q26 19 52 0V62"/>' +
    '<ellipse cx="50" cy="62" rx="26" ry="9"/>' +
    '<path d="M24 46v16q26 19 52 0V46"/>' +
    '<ellipse cx="50" cy="46" rx="26" ry="9"/>' +
    "</g>" +
    '<circle cx="50" cy="29" r="19" fill="#b99552" stroke="#f0d399" stroke-width="2"/>' +
    '<path d="M50 18l3.4 7.6 8.3 1-6 5.7 1.5 8.2L50 36.6l-7.2 3.9 1.5-8.2-6-5.7 8.3-1z" fill="#f5dfac"/>',
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
    (emblems[kind] || emblems.coins) +
    "</svg>"
  );
}
