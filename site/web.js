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
// THE STORE IS OFFERED ONLY TO A PLAYER WITH AN EASTER COMPANY SESSION. Owen, 2026-10-29, the day
// after he asked for the storefront back: *"hide the store from non-signed-in users."* Every page's
// Store entry is hidden by site/desktop.css until site/store-access.mjs proves a session by putting
// `store-signed-in` on <html>, and this file is what proves it: the account seam's state, now and on
// every change - which is also how signing out takes the entry away again in the same tab without a
// reload. doc/web-accounts-store.md keeps the history.
import {webAccount} from './web-account.mjs';
import {rememberReturnTarget} from './auth-return.mjs';
import {mountAccountControl} from './account-control.mjs';
import {paintStoreAccess} from './store-access.mjs';
import {publishTheme} from './theme-publish.mjs';

// THE PAGE'S THEME, BEFORE THE ACCOUNT IS ASKED ANYTHING. With no document read yet the only
// answer is the OS's, and saying so here — synchronously, at the top of the one module every page
// loads — is what keeps a signed-out visitor from wearing whatever the stylesheet defaulted to.
// The control mounted below publishes the account's own choice as soon as it has read it, and
// this statement never runs again; the two never disagree because both go through publishTheme.
// (easter.company does the same thing in its <head>, because that page HAS a light palette to
// flash and a module runs too late for it.)
publishTheme('system');

if (webAccount) {
  document.documentElement.classList.add('web-mode');
  // Every page's own way into the store, resolved against the SITE ROOT rather than the page:
  // web.js is served from the site root on every page and from no other depth, so this one base is
  // right for /, /minecraft/map/, /minecraft/wiki/<guide>/, /account/ and the legal pages alike. A
  // page-relative './store/' would be /minecraft/wiki/store/ on a guide.
  const base = new URL('./', import.meta.url);
  // Stripe's return URL is a routing signal only. Orders are re-read from the API, so a visitor
  // forging the fragment cannot create a payment-success claim: all this decides is which view of
  // the store the address bar opens - and with no session that view is the sign-in gate, because
  // site/store/store.mjs decides what /store/ paints from the same seam this file reads.
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
    // THE ENTRY FOLLOWS THE SESSION, in both directions and without a reload. The pages carry their
    // Store entry in their own markup, so all this has to do is say whether the header may show it;
    // the safety net from the first shared iteration stays for a nav that has no entry at all, and
    // adds one only to a visitor who has a session. Matching on the href rather than on a class
    // keeps the header to exactly one Store entry wherever a page carries its own.
    const paint = state => {
      if (!paintStoreAccess(state)) return;
      if (nav && !nav.querySelector('a[href$="store/"]')) {
        const link = document.createElement('a');
        link.href = new URL('store/', base).href;
        link.textContent = 'Store';
        link.className = 'store-entry';
        nav.append(link);
      }
    };
    // The seam calls this immediately with the state it already holds and again on every change: a
    // signed-out visitor paints nothing, a returning visitor's cached account paints on the first
    // frame, and a sign-out removes the class that reveals the entry.
    webAccount.subscribe(paint);
    await mountAccountControl({nav, seam: webAccount});
  }
}
