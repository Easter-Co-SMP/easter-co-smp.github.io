// One transparent, local sprite: silver coinage and a brass lantern. The two
// square cells share lighting and materials; the original master stays outside
// the published payload. At 320px per cell this covers the 140px detail art at 2x.
// Selection is decorative and depends only on kind, never a product key or price.
export function productArt(kind) {
  const x = kind === "flag" ? 100 : 0;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} 0 100 100" aria-hidden="true" focusable="false">` +
    '<image href="./product-art.webp" width="200" height="100"/>' +
    '</svg>'
  );
}
