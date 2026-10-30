// ── THE PAGE'S THEME, AS ONE IMPLEMENTATION ──────────────────────────────────────────
//
// A preference is `light`, `dark` or `system`; what a page can use is `light` or `dark`.
// `system` is the browser's own `prefers-color-scheme`, resolved when asked — never cached — so
// a live OS change is followed by asking again.
//
// The result is published the only way both Easter Company surfaces agree to read it:
// `html[data-easter-theme="light"|"dark"]` (Diana's site/page-theme.css keys its light palette on
// exactly that) with `style.color-scheme` beside it for the browser's own furniture. There is no
// second key and no page-local copy of the preference: the account document is the store, and
// this is the publication.
//
// WHO CALLS IT, and why this file exists at all rather than living inside the settings panel:
//   · site/user-settings.mjs — the panel, on open, preview, save and discard;
//   · site/account-control.mjs — on load and on every account change, which is what fixed a
//     signed-in page wearing the OS default until somebody opened the panel;
//   · site/web.js — the page itself, once, the moment it runs, so a signed-out visitor's first
//     answer is `system` and not whatever the stylesheet defaults to.
// It is a module of its own because site/web.js is loaded by every page: importing the whole
// settings panel there would put 30 KB on all nineteen of them for two functions.

/** `light` | `dark` | `system` → the palette a page can paint. */
export function resolveTheme(theme, win = globalThis.window) {
  if (theme === 'light' || theme === 'dark') return theme;
  try { return win?.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

/** Publish that resolution on the document. Returns what was published. */
export function publishTheme(theme, doc = globalThis.document, win = globalThis.window) {
  const resolved = resolveTheme(theme, win);
  try {
    doc.documentElement.dataset.easterTheme = resolved;
    doc.documentElement.style.colorScheme = resolved;
  } catch { /* a host that refuses the attribute keeps its own look; the preference is stored */ }
  return resolved;
}
