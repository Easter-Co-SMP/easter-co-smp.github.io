import {AccountClient,AccountError,publicAccount,companySession} from './account-client.mjs';
import * as store from './store-contract.mjs';
import {createMicrosoftSignIn,readCallback,ACCOUNT_PATH,NOT_CONFIGURED,START_AGAIN} from './account/microsoft-signin.mjs';
// What this tab keeps: the WHOLE companySession document - {token,expiresAt,account} - not just the
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
 if(storage===undefined){try{storage=globalThis.sessionStorage;}catch{storage=null;}}
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
  // Every account action gets the cluster waking behind it: the visitor about to sign in
  // pays the resume on the button otherwise (16.49 s measured cold against 0.57-0.62 s
  // warm). Fired, not awaited, so a slow wake cannot delay the request it precedes.
  client.wake?.();
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
  // The returning visitor's stall: this page reconciles the stored account with /me, and after an
  // idle spell that read is the request that pays Aurora's resume (20.11 s cold measured
  // 2026-10-28 against 0.32-0.40 s warm). Start the wake in parallel with the read, never awaited.
  client.wake?.();
  emit();
  try{
   const account=await client.me(saved.token);
   save({session:{token:saved.token,expiresAt:saved.expiresAt},account});
  }catch{forget();}
  finally{booting=false;emit();}
 })();
 const bridge={
  mode:'web',ready,getState:state,subscribe(fn){listeners.add(fn);fn(state());return()=>listeners.delete(fn);},
  loginCompany:(identifier,password)=>run(async()=>{await ready;if(session)throw Error('Sign out before using another account.');save(await client.loginPassword(identifier,password));}),
  checkCompanyUsername:username=>run(async()=>client.usernameAvailable(username)),
  setCompanyPassword:(password,replace=false,username)=>run(async()=>save(await read(()=>client.setPassword(token(),password,replace,username)))),
  accountProviders:async()=>{const found=await client.providers();return {providers:Array.isArray(found.providers)?found.providers.filter(p=>Object.hasOwn(PROVIDERS,p)):[]};},
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
  startMicrosoftSignIn:()=>run(async()=>{
   await ready;
   if(session)throw new AccountError('invalid_request','Sign out before using another account.');
   const flow=await microsoftBrowser.start();
   // A full-page navigation, not a popup: Microsoft's sign-in page refuses to be framed, and
   // the answer comes back to this page rather than to a window we would have to poll.
   navigate(flow.authorizeUrl);
   return flow;
  }),
  // Finish a callback this page received, from the query string it actually arrived with. The
  // state posted is the state received, and a callback that carried none is refused here
  // instead of being sent to a service that could only refuse it too.
  completeMicrosoftSignIn:search=>run(async()=>{
   await ready;
   if(!atRedirect(where))throw new AccountError('not_configured',NOT_CONFIGURED);
   const callback=readCallback(search);
   // The authority's own refusal - the player cancelled, consent was withheld, the tenant said
   // no - is not an exchange and never becomes one: there is no code to redeem.
   if(callback.kind==='refused')throw new AccountError(callback.error||'invalid_request','Sign-in cancelled.');
   if(callback.kind!=='code')throw new AccountError('oauth_state_invalid',START_AGAIN);
   save(client.signed(await microsoftBrowser.exchange(callback.code,callback.state)));
  }),
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
  }
 };
 return bridge;
}
export const webAccount=typeof window!=='undefined'&&!window.easterDesktop?createWebAccount():null;
