// Local, static vector illustrations. No remote images, tracking or supplied SVG.
const shapes = {
  sloop:
    '<path d="M36 144h188l-27 38H64z" fill="#74543a"/><path d="M46 152h164M69 167h129" stroke="#b7915c" stroke-width="3"/><path d="M132 35v108" stroke="#b7915c" stroke-width="5"/><path d="M120 51L61 129h59zM141 51l53 78h-53z" fill="#e6d9b8"/><path d="M51 192q20-12 40 0t40 0t40 0t40 0" stroke="#4b9f9e" stroke-width="4" fill="none"/><path d="M134 35h31l-10 13h-21" fill="#caad72"/>',
  ship: '<path d="M34 144h190l-27 38H64z" fill="#74543a"/><path d="M43 151h170M66 165h138" stroke="#b7915c" stroke-width="3"/><path d="M122 35v108M182 66v77" stroke="#b7915c" stroke-width="5"/><path d="M111 49L64 128h47zM131 49l46 79h-46zM189 77l29 52h-29z" fill="#e6d9b8"/><path d="M51 192q20-12 40 0t40 0t40 0t40 0" stroke="#4b9f9e" stroke-width="4" fill="none"/><path d="M123 35h32l-10 13h-22" fill="#caad72"/>',
  house:
    '<path d="M58 100h143v91H58z" fill="#b6aa8b"/><path d="M41 105l88-67 88 67z" fill="#596d70"/><path d="M70 105h119v86H70z" fill="#9c815a"/><path d="M129 72v119M70 135h119M70 175h119" stroke="#4b4034" stroke-width="7"/><path d="M150 145h22v46h-22" fill="#493d31"/><path d="M87 117h21v26H87zM149 112h22v22h-22z" fill="#ebc47a"/><path d="M59 191h144" stroke="#d0c7ab" stroke-width="7"/>',
  coins:
    '<g fill="#b99552" stroke="#f0d399" stroke-width="3"><ellipse cx="92" cy="164" rx="42" ry="17"/><path d="M50 142v22q42 31 84 0v-22"/><ellipse cx="92" cy="142" rx="42" ry="17"/><path d="M50 119v23q42 31 84 0v-23"/><ellipse cx="92" cy="119" rx="42" ry="17"/><path d="M132 151v23q40 30 80 0v-23"/><ellipse cx="172" cy="151" rx="40" ry="17"/><circle cx="165" cy="88" r="42"/></g><path d="M145 91l5-15 15 10 15-10 5 15-6 12h-28z" fill="#f5dfac"/>',
  upgrade:
    '<path d="M128 31l64 25v62q-5 44-64 76-59-32-64-76V56z" fill="#254951" stroke="#c7a86a" stroke-width="4"/><path d="M128 65l12 24 27 4-19 19 4 27-24-13-24 13 4-27-19-19 27-4z" fill="#e3c689"/><path d="M106 156l22-13 22 13M106 168l22-13 22 13" fill="none" stroke="#c7a86a" stroke-width="4"/>',
  flag: '<path d="M83 33v166M68 198h33" stroke="#b99552" stroke-width="6"/><path d="M87 42h119l-23 45 23 44H87z" fill="#234b55" stroke="#b99552" stroke-width="3"/><path d="M130 64l9 15 17-15-3 27-14 20-14-20-3-27z" fill="#e3c689"/><path d="M139 76l-22-12 7 31M140 76l22-12-7 31" fill="none" stroke="#e3c689" stroke-width="5"/>',
  supplies:
    '<path d="M60 77h139v112H60z" fill="#977149" stroke="#c5a66c" stroke-width="3"/><path d="M60 99h139M60 168h139M83 78v111M175 78v111" stroke="#4f4537" stroke-width="7"/><path d="M90 67V48h80v19" fill="none" stroke="#b99552" stroke-width="8"/><path d="M118 113h24v25h-24z" fill="#d5ba80"/><path d="M128 136v15" stroke="#d5ba80" stroke-width="5"/>',
};
export function productArt(kind) {
  return (
    '<svg viewBox="0 0 260 230" aria-hidden="true" focusable="false"><ellipse cx="130" cy="205" rx="95" ry="9" fill="#000" opacity=".16"/>' +
    (shapes[kind] || shapes.supplies) +
    "</svg>"
  );
}
