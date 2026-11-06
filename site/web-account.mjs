import {AccountClient,AccountError,publicAccount,companySession} from './account-client.mjs';
import * as store from './store-contract.mjs';
import {createMicrosoftSignIn,readCallback,ACCOUNT_PATH,NOT_CONFIGURED,START_AGAIN} from './account/microsoft-signin.mjs';
// What this browser keeps: the WHOLE companySession document - {token,expiresAt,account} - not just the
// token. That is the launcher's own shape (company.enc holds the account document too), and it is
// why the launcher never flashes a signed-out control on a cold start: it can paint the account
// before anything is asked of the service. A page that kept only the token had to say `Sign in`
// until /me answered, which on a cold Aurora resume is 18-22 seconds of a false signed-out control
// (Owen, 2026-10-26, signed in: `Even though I am signed in, I hit ctrl+shift+r and now it says
// "sign in"`) - and the sign-in it offered was refused, because the saved session made the seam
// refuse a second one (startMicrosoftSignIn below). The account here is a projection, never a
// credential: the token is still the only secret in this storage.
const SESSION_KEY='easter-company-web-session-v1';
// The name a provider popup carries back from the provider. The site root reads it to tell the
// window this module opened apart from an ordinary tab (site/index.html's head script, whose inline
// copy cannot import anything), so the pair is one literal in two files rather than one constant:
// tests/account-browser.mjs drives the whole flow, which is what keeps them from drifting.
export const SIGN_IN_WINDOW='easter-company-signin';
// How long a callback waits for the request in front of it before taking the seam's own refusal
// (completeMicrosoftSignIn). Two numbers, named rather than bare: ten seconds is longer than any
// account read this page makes is allowed to take, and fifty milliseconds is short enough that a
// read which settles at once costs the player nothing.
const CALLBACK_SLOT_WAIT_MS=10000,CALLBACK_SLOT_STEP_MS=50;
const PROVIDERS={google:['https://accounts.google.com','/o/oauth2/v2/auth'],discord:['https://discord.com','/oauth2/authorize'],steam:['https://steamcommunity.com','/openid/login']};
// Where a browser may sign in with Microsoft, and what a callback must look like, are one
// contract: site/account/microsoft-signin.mjs holds both, because the registered redirect
// literal has to be compared in the same file that sends the flow (doc/BROWSER_SIGN_IN.md
// section 6 in the cloud repository).
const atRedirect=where=>{
 try{return where.pathname===ACCOUNT_PATH;}
 catch{return false;}
};
// Browser-only account capability. Never assigned to window.easterDesktop. No native,
// game, filesystem, updater or shell operation is available to the website.
export function createWebAccount({storage,client=new AccountClient({client:'website/1'}),openWindow=(...args)=>window.open(...args),navigate=url=>location.assign(url),changed=()=>{},microsoftBrowser=createMicrosoftSignIn(),where=globalThis.location}={}){
 let persistent=false;
 if(storage===undefined){
  try{
   storage=globalThis.localStorage;
   if(storage){
    const probe=SESSION_KEY+'-storage-probe';
    storage.setItem(probe,'1');storage.removeItem(probe);
    // Preserve an existing tab session when upgrading to persistent storage.
    let legacy;try{legacy=globalThis.sessionStorage;}catch{/* The tab store may be denied. */}
    let old;try{old=legacy?.getItem(SESSION_KEY);}catch{/* Continue with persistent storage. */}
    if(old&&!storage.getItem(SESSION_KEY))storage.setItem(SESSION_KEY,old);
    if(old)try{legacy.removeItem(SESSION_KEY);}catch{/* The new copy is already safe. */}
    persistent=true;
   }
  }catch{try{storage=globalThis.sessionStorage;}catch{storage=null;}}
 }
 let session=null,working=false,providerAbort=null,generation=0,expiryTimer=null,booting=false;
 const listeners=new Set();
 // `startupReady` is what a view asks before it treats this seam as answered. It is true unless a
 // saved session exists that this load cannot paint yet - the one load after a storage-shape change
 // ships, when the tab holds a token but no account document. In that state the account control must
 // not offer the sign-in a click would refuse, so it says so here instead of guessing.
 const state=()=>({account:publicAccount(session),accountWorking:working,startupReady:!booting,activity:null});
 const emit=()=>{for(const fn of listeners)fn(state());changed(state());};
 function forget(){generation++;session=null;clearTimeout(expiryTimer);try{storage?.removeItem(SESSION_KEY);}catch{}emit();}
 // The expiry timer is armed from whatever session is in hand, cached document or fresh answer: a
 // cached document must never outlive the token it was stored with.
 function arm(){clearTimeout(expiryTimer);if(session)expiryTimer=setTimeout(forget,Math.min(session.expiresAt-Date.now(),2147483647));}
 // Written from the session in hand, so every path that changes the account document - a sign-in,
 // the boot read's reconciliation, a profile edit - keeps the next cold load honest. A storage that
 // will not take it (quota, denial) costs nothing but the next load's head start: the boot read
 // still answers.
 function remember(){try{storage?.setItem(SESSION_KEY,JSON.stringify({token:session.token,expiresAt:session.expiresAt,account:session.account}));}catch{}}
 function save(signed){
  const next=companySession(signed);
  if(next.expiresAt<=Date.now())throw new AccountError('invalid_session','Your Easter Company session expired. Sign in again.');
  session=next;remember();arm();emit();
 }
 // Reading the stored document back is the same validation that produced it, because it is the
 // player's own data and this page must not trust a hand-edited storage: companySession runs the
 // stored shape through sanitizeAccount and returns null for anything it refuses. No cache is always
 // a usable answer; this never throws into the boot.
 function storedSession(saved){
  try{return companySession({session:{token:saved.token,expiresAt:saved.expiresAt},account:saved.account});}catch{return null;}
 }
 if(persistent&&typeof globalThis.addEventListener==='function'){
  globalThis.addEventListener('storage',event=>{
   if(event.storageArea!==storage||(event.key!==SESSION_KEY&&event.key!==null))return;
   generation++;clearTimeout(expiryTimer);
   let saved;try{saved=event.newValue&&JSON.parse(event.newValue);}catch{}
   session=storedSession(saved);
   if(session&&session.expiresAt<=Date.now())session=null;
   arm();emit();
  });
 }
 function token(){
  if(!session||session.expiresAt<=Date.now()){if(session)forget();throw new AccountError('store_signed_out','Sign in to buy.');}
  return session.token;
 }
 async function read(action){
  const mark=generation;
  try{const value=await action();if(mark!==generation)throw new AccountError('invalid_session','Your Easter Company session changed. Try again.');return value;}
  catch(error){if(error.status===401||error.code==='invalid_session'){if(mark===generation)forget();}throw error;}
 }
 async function run(action){
  if(working)return {ok:false,error:'Another account request is in progress.'};
  working=true;emit();
  try{return {ok:true,value:await action()};}
  catch(error){return {ok:false,error:error.name==='AbortError'?'Sign-in cancelled.':error.message,code:error.code};}
  finally{working=false;emit();}
 }
 const ready=(async()=>{
  let saved;try{saved=JSON.parse(storage?.getItem(SESSION_KEY)||'null');}catch{}
  if(!saved)return;
  if(typeof saved.token!=='string'||!saved.token||saved.token.length>8192||!Number.isFinite(saved.expiresAt)||saved.expiresAt<=Date.now()){forget();return;}
  // PAINT FROM WHAT THIS TAB ALREADY HOLDS, synchronously and before the first await: the stored
  // document is the account the last page load confirmed, so the control is the account on its very
  // first frame and /me only reconciles the name, the face and the expiry. A token whose expiry has
  // passed never reaches here (above), so a cached document cannot outlive its token.
  const known=storedSession(saved);
  if(known){session=known;arm();}
  // With no document to paint there is nothing to show and nothing a click could honour: the boot is
  // not ready until the read settles. That is the one load after this change ships.
  else booting=true;
  const mark=generation;
  emit();
  try{
   const account=await client.me(saved.token);
   if(mark===generation)save({session:{token:saved.token,expiresAt:saved.expiresAt},account});
  }catch(error){
   // ONLY THE SERVICE MAY END A SESSION. A boot read that was ABORTED because this document is
   // being navigated away from is not a refusal of the credential - and this page now does exactly
   // that on purpose: a Stripe return fragment (`/#store-paid/...`) is forwarded by site/web.js the
   // moment it lands, so the landing document starts this read and then dies. Forgetting the
   // session there signed a paying player out on the store page the fragment was routing them to
   // (measured 2026-10-29 against site/ on 127.0.0.1:18104: the tab's stored session gone, the
   // orders view reading "Sign in to buy." one load after a checkout). It is also the rule `read()`
   // above already applies: 401 and `invalid_session` end a session, nothing else does.
   if(mark===generation&&(error?.status===401||error?.code==='invalid_session'))forget();
  }
  finally{booting=false;emit();}
 })();
 const bridge={
  mode:'web',ready,getState:state,subscribe(fn){listeners.add(fn);fn(state());return()=>listeners.delete(fn);},
  loginCompany:(identifier,password)=>run(async()=>{await ready;if(session)throw Error('Sign out before using another account.');save(await client.loginPassword(identifier,password));}),
  checkCompanyUsername:username=>run(async()=>client.usernameAvailable(username)),
  setCompanyPassword:(password,replace=false,username)=>run(async()=>save(await read(()=>client.setPassword(token(),password,replace,username)))),
  // WHICH PROVIDERS THIS SURFACE CAN OFFER A CONNECT FOR, and that is a wider list than the
  // popup broker's. `PROVIDERS` above is the broker table - Google, Discord and Steam, the three
  // that run in a window this page opens - and Microsoft is deliberately not in it because it
  // signs in on its own page (see startMicrosoftSignIn). Filtering the service's answer through
  // that table therefore deleted Microsoft from the availability answer, and the Linked Accounts
  // dialog draws an unavailable provider's Connect disabled (site/company-profile.mjs,
  // `data-unavailable`): Owen's "does nothing useful" was a disabled button as well as a refusal.
  // The service answers "microsoft" unconditionally (api/provider_routes.py prepends it), so the
  // honest filter is "what this surface can offer", which includes the one sign-in that leaves
  // the page. The launcher answers the same list to the same dialog.
  accountProviders:async()=>{
   const found=await client.providers();
   return {providers:Array.isArray(found.providers)?found.providers.filter(p=>p==='microsoft'||Object.hasOwn(PROVIDERS,p)):[]};
  },
  profileEmails:()=>read(()=>client.emails(token())),
  selectLoginEmail:email=>run(()=>read(()=>client.selectLoginEmail(token(),email))),
  updateProfile:displayName=>run(async()=>{const account=await read(()=>client.updateProfile(token(),{displayName}));session={...session,account};remember();emit();}),
  setProfilePicture:async remove=>{
   if(remove)return run(async()=>{const account=await read(()=>client.updateProfile(token(),{picture:null}));session={...session,account};remember();emit();});
   // Native file picking is replaced by the browser's own picker. Decode locally,
   // draw into a bounded canvas and send PNG pixels only, without file metadata.
   const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';
   const file=await new Promise(resolve=>{input.onchange=()=>resolve(input.files?.[0]||null);input.oncancel=()=>resolve(null);input.click();});
   if(!file)return {ok:true,value:{cancelled:true}};
   return run(async()=>{
    if(file.size>10*1024*1024)throw Error('Choose a picture smaller than 10 MiB.');
    const bitmap=await createImageBitmap(file);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
    const side=Math.min(bitmap.width,bitmap.height);
    canvas.getContext('2d').drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,256,256);bitmap.close();
    const picture=canvas.toDataURL('image/png');
    if(picture.length>349600)throw Error('Choose a simpler picture smaller than 256 KiB.');
    const account=await read(()=>client.updateProfile(token(),{picture}));session={...session,account};remember();emit();
   });
  },
  signInProvider:(provider,link=false)=>{
   if(working)return Promise.resolve({ok:false,error:'Another account request is in progress.'});
   const allowed=PROVIDERS[provider];
   // Microsoft is not in the broker's list because it is not run through the popup broker at
   // all: it has its own browser flow at site/account/ (doc/BROWSER_SIGN_IN.md), which this page
   // cannot drive from here. The sentence points there rather than claiming it is impossible.
   if(!allowed)return Promise.resolve({ok:false,error:'Sign in with Microsoft on your account page.'});
   const popup=openWindow('about:blank','_blank');
   if(!popup)return Promise.resolve({ok:false,error:'Allow a sign-in window for this site and try again.'});
   // THE WINDOW NAMES ITSELF, AND THAT NAME IS THE ONLY WAY THE RETURNED SITE ROOT CAN TELL IT IS
   // THE POPUP. When this provider sign-in finishes, the account API's callback sends this window
   // to `/?signed-in=1` and the site root paints a "Login Successful" splash there instead of the
   // homepage and its arrival intro (site/index.html's head script, site/styles.css). The address
   // cannot carry that distinction - the Microsoft flow and the launcher's provider window arrive
   // at the same root as ordinary tabs, and must never be told to close themselves - but
   // window.name survives every navigation in this window, including the cross-origin ones to the
   // provider and back. Set before the first navigation, exactly as the root reads it.
   popup.name=SIGN_IN_WINDOW;
   popup.opener=null;
   return run(async()=>{
    const abort=new AbortController();providerAbort=abort;
    const timeout=setTimeout(()=>abort.abort(),600000);
    try{
     await ready;
     if(Boolean(session)!==link)throw Error('Your account changed. Start sign-in again.');
     const mark=generation,linkedToken=link?token():undefined;
     const verifier=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
     const flow=await client.attempt('/v2/accounts/providers/start',{method:'POST',token:linkedToken,signal:abort.signal,body:{provider,verifier,client:'website/1'}});
     const url=new URL(flow.url);
     if(url.origin!==allowed[0]||url.pathname!==allowed[1]||url.username||url.password||!/^[-_a-zA-Z0-9]{43}$/.test(flow.flow||''))throw Error('The sign-in address is invalid.');
     popup.location.href=url.href;
     while(!abort.signal.aborted){
      await new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',stop);resolve();},2000);if(abort.signal.aborted)stop();else abort.signal.addEventListener('abort',stop,{once:true});});
      // COOP may sever the WindowProxy. Only finish, Cancel or timeout decides the flow.
      const result=await client.attempt('/v2/accounts/providers/finish',{method:'POST',token:linkedToken,signal:abort.signal,body:{flow:flow.flow,verifier,client:'website/1'}});
      if(result?.pending===true)continue;
      if(mark!==generation)throw Error('Your account changed. Start sign-in again.');
      save(client.signed(result));return;
     }
    }finally{clearTimeout(timeout);providerAbort=null;popup.close();}
   });
  },
  // Microsoft, which is the one sign-in that leaves this page. The flow starts here, Microsoft
  // answers on the registered redirect address (site/account/), and the two values it brought
  // back are posted once to the service's exchange. Nothing of Microsoft's is kept: what is
  // saved below is the Company session the service minted, through the same seam a password
  // sign-in uses. No Minecraft session is asked for anywhere on this path - the exchange stores
  // no provider token, so Play stays in the launcher - and this page therefore holds no
  // Microsoft token, of either kind, to lose.
  //
  // STARTING IS NOT BOUND TO THE CALLBACK'S ADDRESS. The nav's dialog starts the flow on whatever
  // page the player is on and sends the browser straight to Microsoft, which is one page load
  // rather than two (Owen, 2026-10-26, after signing in for real: "too many full page loads").
  // What the Azure registration pins is the address the answer comes back to, and that is
  // checked where it can be: the answer below must name the registered redirect literal (start()
  // in site/account/microsoft-signin.mjs), and completeMicrosoftSignIn refuses a callback anywhere
  // but that path. A mirror of site/ still signs nobody in - site/account/account.mjs offers no
  // sign-in at all off the registered path - and nothing here may navigate anywhere but the
  // Microsoft authority.
  // LINKING AND SIGNING IN ARE THE SAME FLOW, AND THE DIFFERENCE IS THE SESSION.
  //
  // `options.link` is the Linked Accounts row's Connect: the player is already signed in and is
  // proving Microsoft for the account they hold. That is the case the account service applies a
  // proof to (api/identity_store.login_microsoft: an account is repaired only by a proof that
  // OWNS it, and a live session for that same account is ownership), so this refuses only when
  // there is no session to prove it for. A plain sign-in still refuses while a session exists,
  // exactly as it always has: signing in on top of an account is how an account gets switched
  // under somebody.
  //
  // NOTHING IS STARTED TWICE. `run` refuses a second account request while one is in flight, and
  // on success the browser has already been sent to Microsoft by the time this answers - which
  // is why the answer carries `started`: the surface that pressed the control is about to be
  // replaced by Microsoft's page and must not pretend it saved anything.
  startMicrosoftSignIn:(options={})=>run(async()=>{
   await ready;
   if(options?.link===true&&!session)throw new AccountError('invalid_session','Sign in before connecting Microsoft.');
   if(options?.link!==true&&session)throw new AccountError('invalid_request','Sign out before using another account.');
   const flow=await microsoftBrowser.start();
   // A full-page navigation, not a popup: Microsoft's sign-in page refuses to be framed, and
   // the answer comes back to this page rather than to a window we would have to poll.
   navigate(flow.authorizeUrl);
   return {...flow,started:true};
  }),
  // Finish a callback this page received, from the query string it actually arrived with. The
  // state posted is the state received, and a callback that carried none is refused here
  // instead of being sent to a service that could only refuse it too.
  //
  // THE SESSION THIS TAB HOLDS TRAVELS WITH THE EXCHANGE. The browser restores the stored
  // account after the round trip through Microsoft, so a player
  // who pressed Connect is still the account that asked: the service applies the proof to that
  // account when the proof owns it and refuses it with the existing conflict answer when the
  // proof belongs to somebody else. A tab with no session sends nothing and is an ordinary
  // sign-in, which is the answer this has always given.
  // THE CALLBACK TAKES ITS TURN RATHER THAN BEING REFUSED ITS TURN. This seam answers one account
  // request at a time and refuses a concurrent one ("Another account request is in progress."),
  // which is right for every action a person can press twice. The callback is not one of those:
  // the page it arrives on mounts the shared account control, whose theme read is itself an
  // account request, so on a signed-in tab - which is every linking tab - the exchange could
  // arrive while that read was in flight and be refused with a sentence about a request the
  // player never made (measured 2026-11-01, the link flow in a browser). So it waits, for one
  // named and bounded moment, for the request in front of it, and then runs exactly as it always
  // did; a read that never settles still ends in the seam's own refusal.
  completeMicrosoftSignIn:search=>(async()=>{
   // THE WAIT AND THE REQUEST ARE ONE JOB, with no microtask between them: a gap there is enough
   // for another account request to take the seam first, which is exactly the collision this wait
   // exists to avoid (measured 2026-11-01, "Another account request is in progress." on the
   // callback). A seam still held past the wait ends in the seam's own refusal, unchanged.
   const deadline=Date.now()+CALLBACK_SLOT_WAIT_MS;
   while(working&&Date.now()<deadline)await new Promise(done=>setTimeout(done,CALLBACK_SLOT_STEP_MS));
   return run(async()=>{
    await ready;
    if(!atRedirect(where))throw new AccountError('not_configured',NOT_CONFIGURED);
    const callback=readCallback(search);
    // The authority's own refusal - the player cancelled, consent was withheld, the tenant said
    // no - is not an exchange and never becomes one: there is no code to redeem.
    if(callback.kind==='refused')throw new AccountError(callback.error||'invalid_request','Sign-in cancelled.');
    if(callback.kind!=='code')throw new AccountError('oauth_state_invalid',START_AGAIN);
    save(client.signed(await microsoftBrowser.exchange(callback.code,callback.state,session?.token)));
   });
  })(),
  cancelSignIn:async()=>providerAbort?.abort(),
  signOut:async()=>{providerAbort?.abort();const previous=session?.token;forget();if(previous)await client.logout(previous);},
  storeCatalogue:async()=>{await ready;try{return store.catalogue(await read(()=>client.storeCatalogue(token())));}catch(error){throw error.code==='store_signed_out'?error:store.refusal(error);}},
  storeOrders:async()=>{await ready;try{return store.orders(await read(()=>client.storeOrders(token())));}catch(error){throw error.code==='store_signed_out'?error:store.refusal(error);}},
  storeCheckout:async key=>{
   await ready;
   if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key))throw Error('The store is unavailable right now.');
   try{
    const answer=store.checkout(await read(()=>client.storeCheckout(token(),key)));
    // Full-page navigation: no popup blocker and no opener shared with Stripe.
    // The return fragment is never accepted as proof of payment.
    navigate(answer.url);return {outcome:'cancelled'};
   }catch(error){throw error.code==='store_signed_out'?error:store.refusal(error);}
  },
  // ---- the account's settings document -----------------------------------------
  // site/user-settings.mjs draws the panel; these three calls are what it draws it from, and they
  // go through the session this tab already holds. The panel therefore never sees the token, and
  // the token never reaches an address: no second sign-in, no credential in a URL.
  //
  // A save that loses the revision race is an ANSWER, not an exception: `saveSettings` in the
  // shared client re-reads and hands back the document that is stored with `conflict:true`, so
  // the panel can keep every draft, say the save did not happen, and let a second press replace
  // the revision it was holding. Everything else arrives as the ordinary `{ok:false}` with the
  // one sentence the account service is allowed to say.
  settingsRead:()=>run(()=>read(()=>client.settings(token()))),
  settingsSave:(document,revision)=>run(()=>read(()=>client.saveSettings(token(),document,revision))),
  // The picker's catalogue needs no session (the route answers before authorization, on purpose),
  // so this one carries no token and is not an account action: it neither paints nor locks the
  // account control, and the panel treats a failure as "the picker cannot be offered".
  settingsLanguages:()=>client.settingsLanguages()
 };
 return bridge;
}
export const webAccount=typeof window!=='undefined'&&!window.easterDesktop?createWebAccount():null;
