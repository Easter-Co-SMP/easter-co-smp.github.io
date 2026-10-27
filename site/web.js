// THE SITE'S PAGE SCRIPT. Everything this file used to do inline now lives in one of two places,
// because a second first-party site needs the same account control:
//
//   site/account-control.mjs  the button, its menu, the dialogs and the face's precedence - shared,
//                             imported by the corporate site from this origin.
//   here                      the two things that belong to THIS site: the ?app= / ?next= return
//                             target a page may be opened with, and the nav it mounts into.
//
// What did NOT move: the return-target handling (an app asking to be brought back is a request made
// to the launcher site, not to whoever imports the control), and the store gate, which is stated in
// site/store/store.mjs and needs nothing here - the website has no route into the store (2026-10-27)
// and this file no longer injects one.
import {webAccount} from './web-account.mjs';
import {rememberReturnTarget} from './auth-return.mjs';
import {mountAccountControl} from './account-control.mjs';

if (webAccount) {
  // WHAT THIS PAGE WAS ASKED TO RETURN TO. `?app=<id>` and `?next=<url>` are a request to be
  // brought back to that app once this tab has signed in; site/auth-return.mjs owns the allow-list,
  // the one storage key and the consume-once rule, and its header says what this must never become
  // (a token handoff). A page opened without either parameter writes nothing at all.
  rememberReturnTarget(location.search);
  document.documentElement.classList.add('web-mode');
  await mountAccountControl({nav: document.querySelector('.site-header nav'), seam: webAccount});
}
