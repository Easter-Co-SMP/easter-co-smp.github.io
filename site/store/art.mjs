// Local, static vector emblems. No remote images, tracking or supplied SVG.
//
// They are cut for Sol's circular coin medallion: a square 100x100 viewBox, composition inside the
// circle's inscribed area, and nothing in the corners, because the medallion clips to a circle.
// Two emblems is the whole set, and neither says anything about the product: a pack of Sterling is
// drawn as coins and anything the server calls a donation is drawn as a banner. The card's words
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
  flag:
    '<path d="M32 12v76M20 89h24" stroke="#c9a469" stroke-width="5" stroke-linecap="round" fill="none"/>' +
    '<path d="M36 18h36l-7 15 7 15H36z" fill="#234b55" stroke="#c9a469" stroke-width="2.5"/>' +
    '<path d="M55 28l3 6 6.5.8-4.8 4.5 1.2 6.5L55 42.6l-5.9 3.2 1.2-6.5-4.8-4.5 6.5-.8z" fill="#f5dfac"/>',
};
export function productArt(kind) {
  return (
    '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
    (emblems[kind] || emblems.coins) +
    "</svg>"
  );
}
