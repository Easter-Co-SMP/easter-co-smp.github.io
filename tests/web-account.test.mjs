import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebAccount} from '../site/web-account.mjs';
import {AccountClient} from '../site/account-client.mjs';
const account={id:8,username:'fixture_player',passwordRequired:false,providers:['steam'],microsoftLinked:false};
const signed={account,session:{token:'fixture-only',expiresAt:Date.now()+60000}};
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};};
test('storage denied at property access still allows an in-memory sign-in and sign-out',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw new Error('Storage denied');}});
 try{
  const bridge=createWebAccount({client:{loginPassword:async()=>signed,logout:async()=>{}}});
  await bridge.ready;assert.equal((await bridge.loginCompany('fixture_player','fixture')).ok,true);
  assert.equal(bridge.getState().account.username,'fixture_player');await bridge.signOut();
 }finally{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete globalThis.sessionStorage;}
});
test('sign-out invalidates an in-flight private orders read and removes persisted session',async()=>{
 let resolve;const storage=memory();
 const bridge=createWebAccount({storage,client:{loginPassword:async()=>signed,logout:async()=>{},storeOrders:()=>new Promise(done=>{resolve=done;})}});
 await bridge.loginCompany('fixture_player','fixture');
 const pending=bridge.storeOrders();await new Promise(done=>setTimeout(done,0));
 await bridge.signOut();resolve({orders:[]});
 await assert.rejects(pending);
 assert.equal(bridge.getState().account,null);assert.equal(storage.values.size,0);
});
test('a signed-out store gets the sign-in sentence and makes no API call',async()=>{
 const bridge=createWebAccount({storage:null,client:{storeCatalogue(){throw Error('must not be called');}}});
 await assert.rejects(bridge.storeCatalogue(),{message:'Sign in to buy.'});
});
test('a foreign checkout destination is refused before navigation',async()=>{
 let navigated=false;
 const bridge=createWebAccount({storage:null,navigate:()=>{navigated=true;},client:{loginPassword:async()=>signed,logout:async()=>{},storeCheckout:async()=>({url:'https://evil.invalid/pay',sessionId:'fixture',product:'fixture'})}});
 await bridge.loginCompany('fixture_player','fixture');
 await assert.rejects(bridge.storeCheckout('fixture'),{message:'The store is unavailable right now.'});
 assert.equal(navigated,false);await bridge.signOut();
});
test('browser transport refuses redirects and uses no ambient cookies or referrer',async()=>{
 let seen;const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{seen={url,options};return {ok:true,status:200,json:async()=>({providers:[]})};};
 try{await new AccountClient().providers();assert.equal(seen.options.credentials,'omit');assert.equal(seen.options.redirect,'error');assert.equal(seen.options.referrerPolicy,'no-referrer');}
 finally{globalThis.fetch=oldFetch;}
});

// The cold load. Owen, signed in on the site: "Even though I am signed in, I hit ctrl+shift+r and
// now it says 'sign in'". The tab keeps the whole companySession document - {token,expiresAt,account},
// the shape the launcher's vault holds - so the account is painted from storage before the service
// answers, and /me only reconciles it. These three cases are the seam's own, without a browser.
const KEY='easter-company-web-session-v1';
test('a stored account document is painted synchronously, before the read answers',async()=>{
 const storage=memory();
 const kept={token:'fixture-only',expiresAt:Date.now()+60000,account:{...account,displayName:'Captain Fixture'}};
 storage.setItem(KEY,JSON.stringify(kept));
 let answer;const read=new Promise(resolve=>{answer=resolve;});
 const bridge=createWebAccount({storage,client:{me:async()=>read,logout:async()=>{}}});
 // No await anywhere: this is the first frame. The state a view paints from already has the account.
 assert.equal(bridge.getState().account.name,'Captain Fixture');
 assert.equal(bridge.getState().startupReady,true,'a document to paint means the control is ready, not waiting');
 answer({...account,displayName:'Reconciled Fixture'});
 await bridge.ready;
 assert.equal(bridge.getState().account.name,'Reconciled Fixture','and the read reconciles what it answers');
 assert.equal(JSON.parse(storage.getItem(KEY)).account.displayName,'Reconciled Fixture','including what the next cold load will paint');
 await bridge.signOut();
});
test('a document the contract refuses is no cache at all, and the boot says it is still reading',async()=>{
 const storage=memory();
 // microsoftLinked without a 64-hex microsoftSubject is exactly what sanitizeAccount refuses; a probe
 // whose fixture is in that shape measures the fallback, not the fix.
 storage.setItem(KEY,JSON.stringify({token:'fixture-only',expiresAt:Date.now()+60000,account:{...account,microsoftLinked:true}}));
 const bridge=createWebAccount({storage,client:{me:async()=>({...account,displayName:'Read Fixture'}),logout:async()=>{}}});
 assert.equal(bridge.getState().account,null,'a refused document paints nothing');
 assert.equal(bridge.getState().startupReady,false,'and the boot is honestly not ready: no sign-in is offered until it is');
 await bridge.ready;
 assert.equal(bridge.getState().account.name,'Read Fixture');
 assert.equal(bridge.getState().startupReady,true);
 assert.equal(JSON.parse(storage.getItem(KEY)).account.displayName,'Read Fixture','the refused document is replaced by the read one');
 await bridge.signOut();
});
test('an expired token is dropped with its document, and nothing is painted from it',async()=>{
 const storage=memory();
 storage.setItem(KEY,JSON.stringify({token:'fixture-only',expiresAt:Date.now()-1000,account:{...account,displayName:'Stale Fixture'}}));
 let asked=0;
 const bridge=createWebAccount({storage,client:{me:async()=>{asked++;return account;},logout:async()=>{}}});
 assert.equal(bridge.getState().account,null,'a document never outlives the token it was stored with');
 assert.equal(storage.getItem(KEY),null,'and it is cleared with the token');
 await bridge.ready;
 assert.equal(asked,0,'an expired session is not asked about');
});

// ---- LINKING MICROSOFT, FROM A TAB THAT IS ALREADY SIGNED IN --------------------
// Owen, 2026-11-01: "we need to re-enable microsoft account linking across all surfaces." The
// row starts the same flow a sign-in does; what makes it a LINK is the session carried to the
// exchange, which is the one thing the account service lets a proof repair
// (api/identity_store.login_microsoft, "what decides between refusing a proof and repairing a
// link"). These four cases are that seam's own rules, with the Microsoft half stubbed.
const microsoft=(overrides={})=>{
 const calls={start:0,exchange:[],navigated:[]};
 const browser={
  start:async()=>{calls.start++;return {state:'s'.repeat(43),authorizeUrl:'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=fixture'};},
  // A linked account is `microsoftLinked` AND a 64-hex `microsoftSubject`: the contract in
  // site/account-client.mjs refuses the flag without the subject, so the fixture carries both.
  exchange:async(...args)=>{calls.exchange.push(args);return overrides.answer||{account:{...account,microsoftLinked:true,microsoftSubject:'a'.repeat(64)},session:{token:'fixture-new',expiresAt:Date.now()+60000}};}
 };
 // The registered redirect is where a callback may be finished: the seam checks the page's own
 // path against the literal Microsoft is registered to return to, so the stub says where it is.
 const bridge=createWebAccount({storage:memory(),client:{me:async()=>account,loginPassword:async()=>signed,logout:async()=>{},signed:answer=>answer},microsoftBrowser:browser,navigate:url=>calls.navigated.push(url),where:{pathname:'/account/'}});
 return {bridge,calls};
};
test('a signed-in tab starts a Microsoft link, and the row is told it only started',async()=>{
 const {bridge,calls}=microsoft();
 await bridge.loginCompany('fixture_player','fixture');
 const answer=await bridge.startMicrosoftSignIn({link:true});
 assert.equal(answer.ok,true);
 assert.equal(answer.value.started,true,'a web surface sends the browser away: the row must not report a save');
 assert.equal(calls.start,1);
 assert.match(calls.navigated[0],/^https:\/\/login\.microsoftonline\.com\//);
 await bridge.signOut();
});
test('linking without a session is refused before any flow starts',async()=>{
 const {bridge,calls}=microsoft();
 const answer=await bridge.startMicrosoftSignIn({link:true});
 assert.deepEqual({ok:answer.ok,error:answer.error},{ok:false,error:'Sign in before connecting Microsoft.'});
 assert.equal(calls.start,0,'nothing was asked of the account service');
 assert.equal(calls.navigated.length,0,'and the browser stayed where it was');
 await bridge.signOut();
});
test('a plain sign-in is still refused while a session is live',async()=>{
 const {bridge,calls}=microsoft();
 await bridge.loginCompany('fixture_player','fixture');
 const answer=await bridge.startMicrosoftSignIn();
 assert.deepEqual({ok:answer.ok,error:answer.error},{ok:false,error:'Sign out before using another account.'});
 assert.equal(calls.start,0);
 await bridge.signOut();
});
test('the callback carries the tab\'s own session to the exchange',async()=>{
 const {bridge,calls}=microsoft();
 await bridge.loginCompany('fixture_player','fixture');
 const code='M.C523_BAY.2.U.fixture-code';
 await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(code)+'&state='+'s'.repeat(43));
 assert.equal(calls.exchange.length,1);
 assert.deepEqual(calls.exchange[0],[code,'s'.repeat(43),'fixture-only'],
  'the code, the state, and the session this tab holds - the account the proof is being applied to');
 assert.equal(bridge.getState().account.microsoftLinked,true,'the answer is saved as the tab\'s session, as it always was');
 await bridge.signOut();
});
test('a signed-out tab exchanges with no session at all, which is an ordinary sign-in',async()=>{
 const {bridge,calls}=microsoft();
 await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent('M.C523_BAY.2.U.fixture-code')+'&state='+'s'.repeat(43));
 assert.equal(calls.exchange[0][2],undefined,'nothing is claimed about an account this tab does not hold');
 await bridge.signOut();
});
test('the service\'s refusal reaches the caller unchanged, and nothing is saved',async()=>{
 const conflict=Object.assign(Error('This Microsoft account is already linked to a different Company account, or this Company account already has a Microsoft link.'),{code:'identity_conflict'});
 const browser=createWebAccount({storage:memory(),client:{me:async()=>account,loginPassword:async()=>signed,logout:async()=>{},signed:answer=>answer},
  microsoftBrowser:{start:async()=>({state:'s'.repeat(43),authorizeUrl:'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'}),exchange:async()=>{throw conflict;}},
  navigate:()=>{},where:{pathname:'/account/'}});
 await browser.loginCompany('fixture_player','fixture');
 const before=browser.getState().account;
 const answer=await browser.completeMicrosoftSignIn('?code=x&state='+'s'.repeat(43));
 assert.equal(answer.ok,false);
 assert.equal(answer.error,conflict.message,'the service\'s own sentence, in the row');
 assert.equal(browser.getState().account.id,before.id,'a refused link leaves the signed-in account exactly as it was');
 await browser.signOut();
});
