// THE SITE'S PAGE SCRIPT. Everything this file used to do inline now lives in one of two places,
// because a second first-party site needs the same account control:
//
//   site/account-control.mjs  the button, its menu, the dialogs and the face's precedence - shared,
//                             imported by the corporate site from this origin.
//   here                      the three things that belong to THIS site: the ?app= / ?next= return
//                             target a page may be opened with, the Store entry its shared header
//                             carries, and the Stripe return fragment that routes a paying
//                             visitor back into site/store/.
//
// What did NOT move: the return-target handling (an app asking to be brought back is a request made
// to the launcher site, not to whoever imports the control) and the store's routes into this site.
//
// THE STORE IS SHARED WITH THE WEBSITE AGAIN (Owen, 2026-10-29: *"yes, return the store to the
// website"*). It left on 2026-10-27 only while the Easter Company app registration went to Mojang
// for the Java Edition Game Service API approval; that approval arrived on 2026-10-28, so the two
// routes this file stopped providing come back unchanged. doc/web-accounts-store.md keeps that
// history.
import {webAccount} from './web-account.mjs';
import {rememberReturnTarget} from './auth-return.mjs';
import {mountAccountControl} from './account-control.mjs';

if (webAccount) {
  document.documentElement.classList.add('web-mode');
  // Every page's own way into the store, resolved against the SITE ROOT rather than the page:
  // web.js is served from the site root on every page and from no other depth, so this one base is
  // right for /, /minecraft/map/, /minecraft/wiki/<guide>/, /account/ and the legal pages alike. A
  // page-relative './store/' would be /minecraft/wiki/store/ on a guide.
  const base = new URL('./', import.meta.url);
  // Stripe's return URL is a routing signal only. Orders are re-read from the API, so a visitor
  // forging the fragment cannot create a payment-success claim: all this decides is which view of
  // the store the address bar opens.
  if (/^#store-paid(?:\/|$)/.test(location.hash) || location.hash === '#store-cancelled') {
    const destination = new URL('store/', base);
    destination.hash = location.hash === '#store-cancelled' ? 'catalogue' : 'orders';
    location.replace(destination.href);
  } else {
    // WHAT THIS PAGE WAS ASKED TO RETURN TO. `?app=<id>` and `?next=<url>` are a request to be
    // brought back to that app once this tab has signed in; site/auth-return.mjs owns the allow-list,
    // the one storage key and the consume-once rule, and its header says what this must never become
    // (a token handoff). A page opened without either parameter writes nothing at all.
    rememberReturnTarget(location.search);
    const nav = document.querySelector('.site-header nav');
    // The pages carry their Store entry in their own markup, so this is the safety net that has been
    // here since the store was first shared: a page whose nav lacks one still gets one, and matching
    // on the href rather than on a class keeps the header to exactly ONE Store entry wherever a page
    // already carries its own.
    if (nav && !nav.querySelector('a[href$="store/"]')) {
      const link = document.createElement('a');
      link.href = new URL('store/', base).href;
      link.textContent = 'Store';
      link.className = 'store-entry';
      nav.append(link);
    }
    await mountAccountControl({nav, seam: webAccount});
  }
}
