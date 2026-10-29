// ONE PLACE DECIDES WHETHER THIS DOCUMENT MAY SHOW THE STORE.
//
// Owen, 2026-10-29, the day after he asked for the storefront back on the site: *"hide the store
// from non-signed-in users."* So the store is offered to a player who has an Easter Company session
// and to nobody else, and "nobody else" includes a visitor whose browser runs no scripts at all.
//
// THE CLASS IS THE WHOLE MECHANISM, AND ITS DEFAULT IS THE SAFE ONE. Every page carries its Store
// entry in static markup (the SEO work moved the map and the wiki under /minecraft/, so the entry
// is at a different depth on every page), and site/desktop.css hides `a.store-entry` unless
// something has PROVEN a session by putting `store-signed-in` on `<html>`. Nothing in the markup
// knows a session, so a page with no scripting shows no entry - which is the requirement, not a
// degradation: a page that cannot check a session must not claim one.
//
// Two surfaces read this module so the rule has one author: site/web.js paints the shared header's
// entry, and site/store/store.mjs paints the page itself (a signed-out visitor gets the sign-in gate
// instead of the shop). The launcher never uses it - `desktop-mode` shows the launcher's own entry
// and the app mounts the store with its own transport, which is out of this rule's scope.
export const STORE_ACCESS_CLASS = 'store-signed-in';

/**
 * Paint whether this document may show the store, from an account seam's state.
 * @returns {boolean} true when the seam reports an account, i.e. when the store is offered.
 */
export function paintStoreAccess(state, doc = globalThis.document) {
  const signedIn = Boolean(state?.account);
  doc.documentElement.classList.toggle(STORE_ACCESS_CLASS, signedIn);
  return signedIn;
}
