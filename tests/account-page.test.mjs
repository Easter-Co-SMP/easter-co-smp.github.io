// The browser Microsoft sign-in seam: what it sends, what it refuses, and what it never does.
//
// Every case below runs the real transport in site/account/microsoft-signin.mjs against a stub
// request, and the real session seam in site/web-account.mjs against in-memory storage, so the
// assertions are about the code the page ships rather than about a copy of it. The fixtures are
// the account envelope the exchange documents (doc/BROWSER_SIGN_IN.md, section 1), and no
// Microsoft token of any kind appears in one, because the page is never given one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createWebAccount} from '../site/web-account.mjs';
import {AccountClient} from '../site/account-client.mjs';
import {createMicrosoftSignIn,readCallback,REDIRECT_URI,ACCOUNT_PATH} from '../site/account/microsoft-signin.mjs';

// The state the service mints: 43 characters of urlsafe base64 from 32 bytes.
const STATE='Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5'.slice(0,43).padEnd(43,'a');
const CODE='M.C523_BAY.2.U.fixture-code';
const AUTHORIZE='https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=fixture&response_type=code&redirect_uri='+encodeURIComponent(REDIRECT_URI)+'&code_challenge=fixture-challenge&code_challenge_method=S256&state='+STATE;
const ACCOUNT={id:42,companyId:'EC-42',username:null,minecraftUuid:'01234567-89ab-cdef-0123-456789abcdef',minecraftName:'CaptainFixture',displayName:'CaptainFixture',roles:['member'],createdAt:'2026-10-26T12:00:00+00:00',passwordRequired:true,microsoftLinked:true,microsoftSubject:'a'.repeat(64),providers:['microsoft'],primaryProvider:'microsoft',picture:null,providerDetails:{microsoft:{gamertag:'Fixture Gamer'}}};
const EXPIRES='2026-11-25T12:00:00+00:00';
const signedAccount=()=>({created:true,account:ACCOUNT,session:{token:'fixture-company-session',expiresAt:EXPIRES},emailStatus:'stored'});
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};};
const atAccountPage={pathname:ACCOUNT_PATH};
const elsewhere={pathname:'/account/index.html'};

// One stub authority: `answer` decides what each route says, and every call is recorded so a test
// can ask what was sent and, just as often, what was not.
function authority(answer){
 const calls=[];
 const request=async (url,options)=>{
  const body=options?.body?JSON.parse(options.body):null;
  calls.push({url,pathname:new URL(url).pathname,method:options?.method,body,options});
  const [status,value]=answer(new URL(url).pathname,body)||[200,signedAccount()];
  return {ok:status>=200&&status<300,status,json:async()=>value};
 };
 return {calls,request,paths:()=>calls.map(call=>call.pathname)};
}
const startAnswer=()=>[200,{state:STATE,authorizeUrl:AUTHORIZE,expiresIn:600,redirectUri:REDIRECT_URI}];
// One bridge per test, with the transport pointed at the stub and the location named explicitly:
// the redirect check is part of what is under test, so it cannot be left to a global. A test that
// signs in signs out again: the seam arms a timer for the session's expiry, and a fixture session
// dated a month out would keep this process alive until the run was killed.
// The account client is the real generated one, with a request that refuses to reach the network:
// `signed()` and the session rules under test are its own, while a sign-out - which asks the
// service to revoke a session - has nothing to talk to and is as harmless as it is in the field
// when the service is unreachable.
const offline=async()=>{throw new TypeError('no network in a unit test');};
// A stub clock for the wait-out: the delays are asserted, not slept through.
function waitsFor(){
 const waits=[];
 return {waits,waitFor:async ms=>{waits.push(ms);}};
}
function bridgeFor({answer,storage=memory(),where=atAccountPage,...rest}={}){
 const stub=authority(answer),visits=[];
 const microsoftBrowser=createMicrosoftSignIn({request:stub.request,baseUrl:'https://api.fixture',waitFor:rest.waitFor});
 const client=new AccountClient({client:'website/1',request:offline,retryBudget:0});
 const bridge=createWebAccount({storage,client,microsoftBrowser,where,navigate:url=>visits.push(url)});
 return {bridge,storage,visits,stub};
}

test('the redirect literal is the one the Azure registration must carry',()=>{
 assert.equal(REDIRECT_URI,'https://easter-co-smp.github.io/account/');
 assert.equal(ACCOUNT_PATH,'/account/');
});

test('start posts no token, navigates to the authorize address, and sends the browser nowhere else',async()=>{
 const {bridge,stub,visits}=bridgeFor({answer:path=>path.endsWith('/microsoft/start')?startAnswer():null});
 const result=await bridge.startMicrosoftSignIn();
 assert.equal(result.ok,true,result.error);
 assert.deepEqual(visits,[AUTHORIZE]);
 assert.deepEqual(stub.paths(),['/v2/oauth/microsoft/start']);
 const [call]=stub.calls;
 assert.equal(call.method,'POST');
 assert.deepEqual(call.body,{});
 // The transport rules the rest of this site already uses.
 assert.equal(call.options.credentials,'omit');
 assert.equal(call.options.cache,'no-store');
 assert.equal(call.options.redirect,'error');
 assert.equal(call.options.referrerPolicy,'no-referrer');
 assert.equal(result.value.state,STATE);
});

test('a start from any page of the site sends the browser to the authorize address and nowhere else',async()=>{
 // The nav's dialog starts the flow on whatever page the player is on, so Microsoft is one
 // document load away rather than two (Owen, 2026-10-26: "too many full page loads"). What the
 // Azure registration pins is the address the answer comes back to, and that is checked on the
 // answer - the redirect literal below - and on the callback's own address, in the next test.
 const {bridge,stub,visits}=bridgeFor({answer:path=>path.endsWith('/microsoft/start')?startAnswer():null,where:elsewhere});
 const result=await bridge.startMicrosoftSignIn();
 assert.equal(result.ok,true,result.error);
 assert.deepEqual(visits,[AUTHORIZE],'the one navigation is to Microsoft');
 assert.deepEqual(stub.paths(),['/v2/oauth/microsoft/start']);
 assert.deepEqual(stub.calls[0].body,{});
});

test('a callback is refused anywhere but the registered path, before it is sent',async()=>{
 const {bridge,stub,visits}=bridgeFor({answer:path=>path.endsWith('/microsoft/exchange')?[200,signedAccount()]:null,where:elsewhere});
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
 assert.equal(result.ok,false);
 assert.equal(result.code,'not_configured');
 assert.equal(result.error,'Browser Microsoft sign-in is not configured yet.');
 assert.equal(stub.calls.length,0,'no exchange may be asked for from an address Microsoft does not answer at');
 assert.deepEqual(visits,[]);
});

test('a start answer naming another redirect is not followed, and says not configured rather than broken',async()=>{
 const {bridge,stub,visits}=bridgeFor({answer:path=>path.endsWith('/microsoft/start')?[200,{state:STATE,authorizeUrl:AUTHORIZE.replace(REDIRECT_URI,'https://elsewhere.invalid/account/'),expiresIn:600,redirectUri:'https://elsewhere.invalid/account/'}]:null});
 const result=await bridge.startMicrosoftSignIn();
 assert.equal(result.ok,false);
 assert.equal(result.code,'not_configured');
 assert.equal(result.error,'Browser Microsoft sign-in is not configured yet.');
 assert.deepEqual(visits,[],'the browser is not sent to a URI nobody registered');
 assert.equal(stub.paths().length,1);
});

test('an authorize address off the Microsoft authority is refused rather than followed',async()=>{
 const {bridge,visits}=bridgeFor({answer:path=>path.endsWith('/microsoft/start')?[200,{state:STATE,authorizeUrl:AUTHORIZE.replace('https://login.microsoftonline.com','https://login.microsoftonline.example'),expiresIn:600,redirectUri:REDIRECT_URI}]:null});
 const result=await bridge.startMicrosoftSignIn();
 assert.equal(result.ok,false);
 assert.equal(result.error,'The sign-in address is invalid.');
 assert.deepEqual(visits,[]);
});

test('the callback exchange posts exactly the code and the state it received, and stores the Company session',async()=>{
 const {bridge,storage,stub}=bridgeFor({answer:path=>path.endsWith('/microsoft/exchange')?[200,signedAccount()]:null});
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
 assert.equal(result.ok,true,result.error);
 assert.deepEqual(stub.paths(),['/v2/oauth/microsoft/exchange']);
 assert.deepEqual(stub.calls[0].body,{code:CODE,state:STATE,client:'website/1'});
 // A Company session in the seam's own storage, in the shape the launcher's encrypted vault holds:
 // the whole companySession document, not the token alone. With only the token a cold load had
 // nothing to paint and said `Sign in` until /me answered, which on a cold Aurora resume is 18-22
 // seconds (Owen, 2026-10-26, signed in: "I hit ctrl+shift+r and now it says 'sign in'"). The
 // account is the projection sanitizeAccount already produced - a projection, not a credential -
 // and the session token stays the only secret this storage holds.
 const saved=JSON.parse(storage.getItem('easter-company-web-session-v1'));
 assert.deepEqual(Object.keys(saved).sort(),['account','expiresAt','token']);
 assert.equal(saved.token,'fixture-company-session');
 assert.equal(saved.account.displayName,'CaptainFixture','the stored document is the account the session was signed in with');
 assert.equal(saved.account.id,42);
 // What the page is never given, and so never keeps: no Microsoft token of either kind, and neither
 // the callback's code nor its state. The account's own record that it is linked to Microsoft - the
 // provider name and the hashed subject - is the account document's, and the page already shows it.
 assert.equal(bridge.getState().account.name,'CaptainFixture');
 assert.equal(bridge.getState().account.minecraftName,'CaptainFixture');
 const everything=JSON.stringify([...storage.values]);
 for(const secret of ['access_token','refresh_token','id_token',CODE,STATE])assert(!everything.includes(secret),'nothing of Microsoft\'s is stored: '+secret);
 await bridge.signOut();
});

test('the state that was received is the state that is sent, even a state this page has never seen',async()=>{
 const other='B'.repeat(43);
 const {bridge,stub}=bridgeFor({answer:path=>path.endsWith('/microsoft/exchange')?[401,{error:'oauth_state_invalid',message:'This sign-in has expired or was already used. Start again.'}]:null});
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+other);
 assert.equal(result.ok,false);
 assert.equal(stub.calls[0].body.state,other,'the state is passed through, never replaced by one this page holds');
});

test('a refused authority callback is never exchanged, and keeps its own description',async()=>{
 const {bridge,storage,stub}=bridgeFor({answer:()=>[200,signedAccount()]});
 const search='?error=access_denied&error_description='+encodeURIComponent('AADSTS50011: The user cancelled the sign-in.');
 const callback=readCallback(search);
 assert.deepEqual(callback,{kind:'refused',error:'access_denied',description:'AADSTS50011: The user cancelled the sign-in.'});
 const result=await bridge.completeMicrosoftSignIn(search);
 assert.equal(result.ok,false);
 assert.equal(result.code,'access_denied');
 assert.equal(result.error,'Sign-in cancelled.');
 assert.equal(stub.calls.length,0,'a refusal has no code, so there is nothing to exchange');
 assert.equal(storage.getItem('easter-company-web-session-v1'),null);
});

test('a replayed state is refused by the service and leaves no session behind',async()=>{
 const {bridge,storage,stub}=bridgeFor({answer:path=>path.endsWith('/microsoft/exchange')?[401,{error:'oauth_state_invalid',message:'This sign-in has expired or was already used. Start again.'}]:null});
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
 assert.equal(result.ok,false);
 assert.equal(result.code,'oauth_state_invalid');
 // The sentence is the service's own, not one this page made up.
 assert.equal(result.error,'This sign-in has expired or was already used. Start again.');
 assert.equal(stub.calls.length,1);
 assert.equal(storage.getItem('easter-company-web-session-v1'),null);
 assert.equal(bridge.getState().account,null);
});

test('a callback with no state is refused here, before any request is made',async()=>{
 const {bridge,storage,stub}=bridgeFor({answer:()=>[200,signedAccount()]});
 assert.equal(readCallback('?code='+encodeURIComponent(CODE)).kind,'state-missing');
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE));
 assert.equal(result.ok,false);
 assert.equal(result.code,'oauth_state_invalid');
 assert.equal(result.error,'This sign-in has expired or was already used. Start again.');
 assert.equal(stub.calls.length,0);
 assert.equal(storage.getItem('easter-company-web-session-v1'),null);
});

test('a state of the wrong shape counts as no state at all',async()=>{
 const {bridge,stub}=bridgeFor({answer:()=>[200,signedAccount()]});
 for(const state of ['short','x'.repeat(129),'has space']){
  assert.equal(readCallback('?code='+encodeURIComponent(CODE)+'&state='+encodeURIComponent(state)).kind,'state-missing',state);
 }
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state=nope');
 assert.equal(result.ok,false);
 assert.equal(stub.calls.length,0);
});

test('the redirect_uri_not_registered refusal is drawn as the service wrote it, and reads as not configured',async()=>{
 const message='Microsoft does not accept this sign-in yet: the redirect URI is not registered on the Easter Company Microsoft application. Add https://easter-co-smp.github.io/account/ as a Web redirect URI in the Azure portal, then try again.';
 const {bridge,storage}=bridgeFor({answer:path=>path.endsWith('/microsoft/exchange')?[503,{error:'redirect_uri_not_registered',message}]:null});
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
 assert.equal(result.ok,false);
 assert.equal(result.code,'redirect_uri_not_registered');
 assert.equal(result.error,message,'the service owns this sentence; the page does not paraphrase it');
 assert.match(result.error,/not registered/);
 assert.match(result.error,/not accept this sign-in yet/);
 assert.equal(storage.getItem('easter-company-web-session-v1'),null);
});

test('the exchange holds no token and asks for no Minecraft session',async()=>{
 const {bridge,stub}=bridgeFor({answer:path=>path.endsWith('/microsoft/exchange')?[200,signedAccount()]:null});
 await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
 // Two routes exist on this path and no third: start and exchange. The mint is not reachable
 // from a browser session, and nothing here can reach it.
 for(const call of stub.calls){
  assert.match(call.pathname,/^\/v2\/oauth\/microsoft\/(start|exchange)$/);
  assert(!JSON.stringify(call.body??{}).includes('microsoftRefreshToken'));
  assert(!JSON.stringify(call.body??{}).includes('accessToken'));
 }
 assert(!stub.paths().some(path=>path.includes('/v2/game/session')));
 await bridge.signOut();
});

test('a rate-limited start and a rate-limited exchange keep the launcher sentence',async()=>{
 for(const [path,status] of [['/v2/oauth/microsoft/start',429],['/v2/oauth/microsoft/exchange',429]]){
  const {bridge}=bridgeFor({answer:()=>[status,{error:'rate_limited'}]});
  const result=path.endsWith('start')?await bridge.startMicrosoftSignIn():await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
  assert.equal(result.ok,false);
  assert.equal(result.code,'rate_limited');
  assert.equal(result.error,'Too many account requests just now. Wait a moment and try again.');
 }
});

test('an unreachable service says so instead of pretending the sign-in failed',async()=>{
 const request=async ()=>{throw new TypeError('Failed to fetch');};
 const microsoftBrowser=createMicrosoftSignIn({request,baseUrl:'https://api.fixture'});
 const bridge=createWebAccount({storage:memory(),client:new AccountClient({client:'website/1',request:offline,retryBudget:0}),microsoftBrowser,where:atAccountPage,navigate:()=>{}});
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
 assert.equal(result.ok,false);
 assert.equal(result.code,'unreachable');
 assert.equal(result.error,'The Easter Company account service could not be reached.');
});

test('a signed-in visitor cannot start a second Microsoft sign-in over the first',async()=>{
 const {bridge,stub}=bridgeFor({answer:path=>path.endsWith('/microsoft/start')?startAnswer():path.endsWith('/microsoft/exchange')?[200,signedAccount()]:null});
 assert.equal((await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE)).ok,true);
 const before=stub.calls.length;
 const result=await bridge.startMicrosoftSignIn();
 assert.equal(result.ok,false);
 assert.equal(result.error,'Sign out before using another account.');
 assert.equal(stub.calls.length,before,'no second flow is asked for');
 assert.equal(stub.calls[before-1].pathname,'/v2/oauth/microsoft/exchange');
 await bridge.signOut();
});

test('the website no longer says Microsoft sign-in is launcher-only, or hides its button',async()=>{
 const web=await readFile(new URL('../site/web.js',import.meta.url),'utf8');
 // The sentence this ticket deletes, and the hack that went with it: the chooser's Microsoft
 // button is visible on the website now, and pressing it opens the flow rather than an excuse.
 assert(!web.includes('available in the launcher'),'the launcher-only note is gone');
 assert(!web.includes('.company-microsoft'),'the hidden-button hack is gone');
 // And it opens the flow on the page the player is already on, rather than sending the browser
 // through a second address first: one click, one navigation, and that navigation is Microsoft.
 assert(web.includes('webAccount.startMicrosoftSignIn()'),'the chooser starts the flow here');
 assert(!web.includes("destination.search='provider=microsoft'"),'and no longer sends the browser through /account/?provider=microsoft');
 assert(!web.includes('location.assign(destination.href)'),'there is no other navigation left in the chooser');
 assert(web.includes('startsOnPage:true'),'and the dialog reports the start while it is in flight');
 // The account page is where the flow lives, and it carries the address it belongs to.
 const page=await readFile(new URL('../site/account/account.mjs',import.meta.url),'utf8');
 assert(page.includes("import {webAccount} from '../web-account.mjs'"),'the page uses the existing browser seam');
 assert(!/easterDesktop\s*=/.test(page),'the page never forges the launcher bridge');
 assert(!page.includes('/v2/game/session'),'the page never asks for a Minecraft session');
});

test('the dialog and the account page draw their sign-in options from one module',async()=>{
 // Owen, 2026-10-26, after signing in for real: the account page "does not show the same content
 // as the sign-in modal, but it should (missing direct sign in options)". The answer is one
 // renderer and one copy table, so this gate is about authorship rather than about looks: any of
 // these sentences appearing in a surface again means a second author has appeared.
 const shared=await readFile(new URL('../site/signin-options.mjs',import.meta.url),'utf8');
 const dialog=await readFile(new URL('../site/company-auth.mjs',import.meta.url),'utf8');
 const page=await readFile(new URL('../site/account/account.mjs',import.meta.url),'utf8');
 assert(dialog.includes("from './signin-options.mjs'"),'the dialog draws the shared options');
 assert(page.includes("from '../signin-options.mjs'"),'the account page draws the shared options');
 assert(dialog.includes('createSignInOptions('),'the dialog builds them from the shared renderer');
 assert(page.includes('createSignInOptions('),'and so does the account page');
 for(const sentence of ['Sign in with Microsoft','Please sign up using an existing online account provider','there is no reset','Username or Email','Signing in to Easter Company…','Complete sign-in in your browser…','This provider is not configured.']){
  assert(shared.includes(sentence),'the shared module owns this sentence: '+sentence);
  assert(!dialog.includes(sentence),'the dialog does not spell it again: '+sentence);
  assert(!page.includes(sentence),'the account page does not spell it again: '+sentence);
 }
 // The provider buttons, in one order, drawn by both surfaces.
 const {PROVIDER_ORDER,providerLabel}=await import('../site/signin-options.mjs');
 assert.deepEqual(PROVIDER_ORDER,['google','steam','discord']);
 assert.equal(providerLabel('steam'),'Sign in with Steam');
 assert(!dialog.includes("for(const provider of ['google','steam','discord'])"),'neither surface keeps a second provider list');
 assert(!page.includes('PROVIDER_NAMES'),'nor a second table of provider names');
});

test('a successful sign-in leaves the account page for the site root instead of painting an account',async()=>{
 // Owen, 2026-10-26, signed in on /account/: the page "should redirect back to the / page once
 // signed in. Do not show whatever this is." signedIn() is the one funnel every success passes
 // through - the Microsoft callback, an in-place provider sign-in, the direct Company form, and a
 // stored session re-validated on boot - so this gate is about the answer it gives rather than
 // about one journey: a navigation, and nothing painted.
 //
 // The one exception is the other rule of the same day - "easter-co-smp.github.io should have
 // generic flags to handle redirects and other e apps using the same auth flows" - so the
 // destination is the return target this tab stored, and the site root when there is none. The
 // fallback is resolved from the page, so a preview server is the same answer.
 const page=await readFile(new URL('../site/account/account.mjs',import.meta.url),'utf8');
 assert(page.includes("location.replace(takeTarget()||new URL('../',location.href))"),'a success navigates to the stored return target, or to the site root when this tab asked for none');
 assert(page.includes("from '../auth-return.mjs'"),'and both the allow-list and the storage are that one module, not a second copy here');
 assert(page.includes('rememberReturnTarget(location.search)'),'the target this address asks for is stored before the first paint can answer with it');
 assert(page.includes('forgetTarget()'),'and a refused sign-in drops it rather than carrying it into the next one');
 assert(!page.includes('location.assign'),'and the entry is replaced rather than added to, so Back cannot re-enter the page it left');
 // One navigation in the whole module, and it is this one: a refusal cannot navigate even by
 // accident, because there is no second place a document could be sent from.
 assert.equal((page.match(/location\.(replace|assign)\(/g)||[]).length,1,'the page has exactly one navigation, the success above');
 assert(!/location\.href\s*=/.test(page),'and nothing assigns the address directly');
 assert(page.includes("shown='in'"),'the state is recorded before the navigation, so a repaint cannot redraw the options behind it');
 assert(!page.includes('Signed in as'),'the page paints no account line any more');
 assert(!page.includes('PLAY_NOTE'),'and the note constant is gone');
 // The stylesheet cannot keep a rule for an element nothing draws.
 const css=await readFile(new URL('../site/account/account.css',import.meta.url),'utf8');
 for(const gone of ['.account-identity','.account-note'])assert(!css.includes(gone),'the stylesheet drops '+gone+' too');
 // Sign-out did not go with the panel: the one in the product is the nav's account menu, on every
 // page of the site, and it still clears the session through the same seam.
 const web=await readFile(new URL('../site/web.js',import.meta.url),'utf8');
 assert(web.includes("action('Sign out'"),'sign-out is still the nav account menu\'s, on every page');
 // The sentence is DELETED, not moved: the words a player could read on this page exist in no file
 // the site serves. A copy parked on another page would be a second author of player-facing copy.
 const site=new URL('../site/',import.meta.url);
 const files=(await readdir(site,{recursive:true})).filter(name=>/\.(mjs|js|html|css)$/.test(name));
 assert(files.includes('account/account.mjs')&&files.includes('web.js')&&files.length>30,'the scan read the whole site tree and the pages it names: '+files.length+' files');
 for(const name of files){
  const text=await readFile(new URL(name,site),'utf8');
  for(const moved of ['Signing in here does not start Minecraft'])
   assert(!text.includes(moved),'the Play sentence was removed rather than relocated, but site/'+name+' carries it');
 }
});

test('a waking account service is waited out on its own declared answer, and nothing else is retried',async()=>{
 // The 503 database_unavailable is the service saying it claimed nothing, so the same code may be
 // offered again while the cluster resumes. This is the launcher's window: three seconds, then
 // six, inside four attempts.
 const {waits,waitFor}=waitsFor();
 let answered=0;
 const stub=authority(path=>{
  if(path.endsWith('/microsoft/exchange')){
   answered++;
   if(answered<3)return [503,{error:'database_unavailable',message:'Account service temporarily unavailable.'}];
   return [200,signedAccount()];
  }
  return null;
 });
 const microsoftBrowser=createMicrosoftSignIn({request:stub.request,baseUrl:'https://api.fixture',waitFor});
 const bridge=createWebAccount({storage:memory(),client:new AccountClient({client:'website/1',request:offline,retryBudget:0}),microsoftBrowser,where:atAccountPage,navigate:()=>{}});
 const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
 assert.equal(result.ok,true,result.error);
 assert.equal(answered,3);
 assert.deepEqual(waits,[3000,6000]);
 assert.equal(bridge.getState().account.name,'CaptainFixture');
 await bridge.signOut();
});

test('a refusal and an outage that is not the declared one are never asked again',async()=>{
 for(const [status,body] of [[401,{error:'oauth_state_invalid',message:'This sign-in has expired or was already used. Start again.'}],[503,{error:'identity_provider_unavailable',message:'Microsoft sign-in is temporarily unavailable.'}],[503,{error:'redirect_uri_not_registered',message:'Add the URI.'}]]){
  const {waits,waitFor}=waitsFor();
  const stub=authority(()=>[status,body]);
  const microsoftBrowser=createMicrosoftSignIn({request:stub.request,baseUrl:'https://api.fixture',waitFor});
  const bridge=createWebAccount({storage:memory(),client:new AccountClient({client:'website/1',request:offline,retryBudget:0}),microsoftBrowser,where:atAccountPage,navigate:()=>{}});
  const result=await bridge.completeMicrosoftSignIn('?code='+encodeURIComponent(CODE)+'&state='+STATE);
  assert.equal(result.ok,false);
  assert.equal(result.error,body.message);
  assert.equal(stub.calls.length,1,body.error+' must not be retried');
  assert.deepEqual(waits,[]);
 }
});
