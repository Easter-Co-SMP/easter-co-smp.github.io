// The account page in a browser: the whole Microsoft sign-in, with a stubbed authority.
//
//   EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18118 node tests/account-browser.mjs
//
// site/ is served statically (python3 -m http.server --directory site 18118) and every request to
// the account API or to Microsoft is answered by a fixture below, so no live service, no real
// Microsoft account and no Company credential is involved. What is proved here is what a player
// sees at each of the three widths: the sign-in options - the same ones the nav's dialog draws,
// from the same module - the busy state while a flow is in flight, a cancelled sign-in, a refused
// one, a replayed one, a callback with no state, and the page's refusal to start a flow from any
// address but its own.
//
// THE ONE RULE THIS SUITE MEASURES ABOUT SUCCESS (Owen, 2026-10-26, signed in on /account/:
// "should redirect back to the / page once signed in. Do not show whatever this is."): a sign-in
// that succeeds never paints an account here. The document ends on the SITE ROOT with the account
// named in the nav, by all three routes that can succeed on this page - the Microsoft callback, a
// provider, and the direct Company username/password form - and by opening /account/ while already
// signed in. Nothing is refused any differently than before: every refusal still ends on /account/
// with its sentence in the one alert region. Sign-out is the nav's, on every page
// (site/web.js:81), so it is exercised from the root rather than from this page.
//
// THE RETURNING WINDOW, which is the other half of a sign-in. A provider sign-in that finishes in
// the popup comes back to the site root as `/?signed-in=1`, and Owen's rule (2026-10-26) is that
// that window shows a `Login Successful` splash instead of the homepage and its arrival intro for
// the second or two before it closes. Journeys 16a-16d measure that from the first animation frame
// of each document: the real popup, a window the browser refuses to close, an ordinary tab that is
// handed back in place, and the homepage with no flag at all.
//
// THE RETURN TARGET, which is what makes this the household's sign-in rather than only the site's
// (Owen, 2026-10-26: "easter-co-smp.github.io should have generic flags to handle redirects and other
// e apps using the same auth flows."). Section 17 at the end drives `?app=` and `?next=` through the
// real flows against fixture copies of the two allow-listed origins, including the Microsoft round
// trip: the callback's address cannot carry a parameter, so what the browser keeps in the tab
// between leaving for Microsoft and coming back is measured there rather than assumed.
//
// It also counts DOCUMENT LOADS per step and prints them: a full page load is the cost Owen felt
// after a real sign-in ("too many full page loads", 2026-10-26), and a number is the only way to
// keep it from creeping back. The only unavoidable ones are the authorize redirect to Microsoft
// and Microsoft's return to /account/, which are one contract with the Azure registration.
import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import {API_ORIGIN} from '../site/account-client.mjs';
import {REDIRECT_URI,ACCOUNT_PATH} from '../site/account/microsoft-signin.mjs';
import {SIGN_IN,SIGN_IN_WAIT,PROVIDER_WAIT,PROVIDER_ORDER,providerLabel} from '../site/signin-options.mjs';
// The name a provider popup carries back from the provider, taken from the module that gives it: the
// site root reads that literal in its own inline head script, which cannot import anything, so the
// popup journey below is what keeps the pair from drifting apart.
import {SIGN_IN_WINDOW} from '../site/web-account.mjs';
// The return target's own module, so this suite is not a second author of the address a sign-in is
// sent back to: `?app=e-server` is resolved here by the same table and the same validator the site
// ships, and the storage key is the module's one key rather than a literal copied into a test.
import {RETURN_KEY,appUrl} from '../site/auth-return.mjs';
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18118';
// Where a success must leave the document, resolved from /account/ the way the page resolves it
// (site/account/account.mjs, `new URL('../', location.href)`), so this suite is not the second
// author of that address: it is the site root of whichever origin is serving site/.
const SITE_ROOT=origin+'/';
// The account's name as the nav prints it (site/account-client.mjs:274, publicAccount `name`: the
// display name first), which is the account a visitor sees after a success now.
const NAV_NAME='CaptainFixture';
// A returning player: the Microsoft account already has an Easter Company username, so the
// sign-in lands on the account itself rather than on the first-time setup the launcher and the
// site both run. The new-account shape is its own step at the end, because that is the other
// thing a browser sign-in can produce.
const ACCOUNT={id:42,companyId:'EC-42',username:'fixture_player',minecraftUuid:'01234567-89ab-cdef-0123-456789abcdef',minecraftName:'CaptainFixture',displayName:'CaptainFixture',roles:['member'],createdAt:'2026-10-26T12:00:00+00:00',passwordRequired:false,microsoftLinked:true,microsoftSubject:'a'.repeat(64),providers:['microsoft'],primaryProvider:'microsoft',picture:null,providerDetails:{microsoft:{gamertag:'Fixture Gamer'}}};
const NEW_ACCOUNT={...ACCOUNT,id:43,companyId:'EC-43',username:null,passwordRequired:true};
const SESSION_TOKEN='fixture-company-session-not-a-real-credential';
const signed=account=>({created:true,account,session:{token:SESSION_TOKEN,expiresAt:new Date(Date.now()+3600000).toISOString()},emailStatus:'stored'});
const NOT_REGISTERED='Microsoft does not accept this sign-in yet: the redirect URI is not registered on the Easter Company Microsoft application. Add '+REDIRECT_URI+' as a Web redirect URI in the Azure portal, then try again.';
// A provider that does not confirm the sign-in is a refusal, never a success, so it must be read on
// the page rather than answered with a navigation. The sentence itself belongs to the seam
// (site/account-client.mjs picks it), so this suite asserts that one was drawn rather than pinning
// the words.
const STATE='Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5'.slice(0,43).padEnd(43,'a');
const CALLBACK_CODE='M.C523_BAY.2.U.fixture-code';
// The exact address Microsoft comes back to, built once so every journey arrives the same way and
// the loads this suite counts can be named.
const CALLBACK_URL=origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE;
// The sentences the busy state is allowed to say. One action, one sentence: they are the nav's
// dialog's own (site/signin-options.mjs), so the page adds no words to the product.
const BUSY_SIGN_IN=SIGN_IN_WAIT;
const BUSY_PROVIDER=PROVIDER_WAIT;
const PROVIDER_LABELS=PROVIDER_ORDER.map(providerLabel);
// The steps whose document loads are counted and printed, in journey order. `before` is what the
// same step cost on main (f386139), measured with this same counter: the dialog used to send the
// browser to /account/?provider=microsoft and let that page start the flow, which was one whole
// document load that answered nothing.
//
// A SUCCESS NOW COSTS ONE MORE LOAD THAN IT DID, and that load is the feature rather than a
// regression: the sign-in no longer answers on /account/ (a document that was already loaded), it
// sends the browser to the site root, which is a document. So the callback and a direct visit to
// /account/ while signed in are 2 (arrive, then leave), and the provider and direct Company
// sign-ins that used to answer in place with no load at all are 1 (leave). The refusal rows are
// untouched at what they always cost, because a refusal still navigates nowhere.
const BUDGET=[
 {step:'nav Sign in -> dialog',before:1,after:1},
 {step:'dialog start refused by the service',before:1,after:0},
 {step:'dialog "Sign in with Microsoft" -> Microsoft',before:2,after:1},
 {step:'Microsoft -> /account/ callback with a code',before:1,after:2},
 {step:'/account/ "Sign in with Microsoft" -> Microsoft',before:1,after:1},
 {step:'a signed-in visit to /account/ -> the site root',before:1,after:2},
 {step:'a refused exchange, re-rendered in place',before:1,after:1},
 {step:'a direct username/password sign-in -> the site root',before:null,after:1},
 {step:'a refused direct sign-in, re-rendered in place',before:null,after:0},
 {step:'a provider sign-in -> the site root',before:0,after:1},
 {step:'a provider refusal, re-rendered in place',before:0,after:0},
];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
let checks=0;
// WHAT THE PAGE SAYS ABOUT THE SIGN-IN SPLASH, read out of the document rather than off a
// screenshot: `visible` is the page's own answer - laid out, and neither display:none nor
// visibility:hidden - so a splash that is merely present in the markup is told apart from one that
// is painted. Every journey below reads the same object, and the frame sampler records it too.
function splashState(){
 const visible=selector=>{
  const node=document.querySelector(selector);
  if(!node)return false;
  const style=getComputedStyle(node);
  return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0;
 };
 const box=selector=>{
  const node=document.querySelector(selector);
  if(!node)return null;
  const rect=node.getBoundingClientRect();
  return {x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)};
 };
 const fallback=document.getElementById('signed-in-splash-fallback');
 return {
  url:location.href,name:window.name,
  attr:document.documentElement.getAttribute('data-signed-in'),
  splash:visible('#signed-in-splash'),hero:visible('.home-hero'),mist:visible('.arrival-mist'),skip:visible('.skip-arrival'),
  title:document.querySelector('.signed-in-splash-title')?.textContent??null,
  fallback:visible('#signed-in-splash-fallback'),fallbackText:fallback?(fallback.textContent||'').trim():'',
  arriving:Boolean(document.body?.classList.contains('is-arriving')),
  // Geometry, because the splash has to be the screen: the box of the splash, of the mark the
  // wordmark uses and of the heading, plus the viewport it has to fill.
  splashBox:box('#signed-in-splash'),markBox:box('.signed-in-splash-mark'),titleBox:box('.signed-in-splash-title'),
  viewport:{w:innerWidth,h:innerHeight,scrollWidth:document.documentElement.scrollWidth},
  // The sampler's whole record for this document, so one call reads the live state and the first
  // paint together.
  frames:Array.isArray(window.__frames)?window.__frames.slice():[],
 };
}
// The main frame's document requests are exactly a full page load: a same-document history change
// (stripAddress) is not one, and neither is a fetch.
function watcher(page,loads){
 page.on('request',request=>{
  try{
   if(request.isNavigationRequest()&&request.resourceType()==='document'&&request.frame()===page.mainFrame())loads.push(request.url());
  }catch{}
 });
}
// Everything the page shows while a flow is in flight, as whole statements: one spinner, one
// sentence, and nothing a second flow could be started from.
async function assertBusy(page,{width,label,sentence}){
 await page.locator('#account-panel[data-busy="true"]').waitFor();
 const panelText=(await page.locator('#account-panel').innerText()).replace(/\s+/g,' ').trim();
 assert.equal(panelText,sentence,'the busy state says one sentence and shows no other content ('+label+', '+width+'): '+panelText);
 const spinner=page.locator('#account-wait .wait-feedback-mark');
 assert.equal(await spinner.isVisible(),true,'the spinner is drawn ('+label+')');
 assert.equal(await spinner.getAttribute('aria-hidden'),'true','the spinner is decorative ('+label+')');
 assert.equal(await page.locator('#account-root').isVisible(),false,'the options are not on screen ('+label+')');
 assert.equal(await page.locator('#account-error').isVisible(),false,'no refusal is carried into the flow ('+label+')');
 // Nothing interactive: every control inside the panel is out of the layout, and so out of the
 // tab order, rather than merely invisible.
 const focusable=await page.locator('#account-panel').evaluate(panel=>[...panel.querySelectorAll('button,input,a[href],[tabindex]')].filter(node=>node.getClientRects().length>0).map(node=>node.textContent||node.name));
 assert.deepEqual(focusable,[],'nothing in the panel can be pressed or tabbed to ('+label+'): '+JSON.stringify(focusable));
 // The nav's own Sign in is the other place a second flow could start, and it is disabled for as
 // long as the seam says a request is in progress.
 assert.equal(await page.locator('.web-account-nav').isDisabled(),true,'the nav cannot start a second flow ('+label+')');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'the busy state does not overflow at '+width+' ('+label+')');
 const mark=await spinner.evaluate(node=>{const style=getComputedStyle(node);return {animation:style.animationName,border:style.borderTopColor,width:node.getBoundingClientRect().width};});
 assert(mark.width>0,'the spinner is laid out, never nothing ('+label+')');
 return mark;
}
// A SUCCESS, read back from the finished page: the document is the SITE ROOT, the address bar holds
// no query, the account page is not there, and the account is named in the nav. Nothing here is
// inferred from the load that produced it; every line is a value read back from the settled page.
async function assertLeftForRoot(page,label){
 assert.equal(page.url(),SITE_ROOT,label+' ends on the site root, not on /account/: '+page.url());
 assert.equal(new URL(page.url()).search,'',label+' leaves no query in the address bar: '+page.url());
 assert.equal(await page.locator('#account-panel').count(),0,label+' is not left on the account page');
 await page.waitForFunction(name=>document.querySelector('.web-account-name')?.textContent.trim()===name,NAV_NAME);
 assert.equal((await page.locator('.web-account-name').textContent()).trim(),NAV_NAME,'the nav names the account ('+label+')');
 assert.equal(await page.locator('.web-account-nav').isVisible(),true,'and the named account control is on screen ('+label+')');
 // The panel this page used to paint after a success exists nowhere in the product now, which is
 // what Owen's "do not show whatever this is" means for a later reader of this suite.
 assert.equal(await page.locator('.account-identity').count(),0,'no "Signed in as" line is drawn ('+label+')');
 assert.equal(await page.locator('.account-note').count(),0,'and no note about Play ('+label+')');
 assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).count(),0,'and no page-level Sign out is drawn - the one in the product is the nav menu\'s, and it is closed ('+label+')');
}
// EVERY FRAME OF EVERY DOCUMENT IN A CONTEXT, FROM THE FIRST ONE. The sign-in splash is a first-paint
// claim, so it is measured as one: the sampler records what was on screen in each animation frame of
// each document - the popup included - and the journeys assert over that history instead of trusting
// a screenshot taken after the fact. The interval chain is the same record for a window whose
// animation frames are throttled, which is how a background popup would otherwise look unsampled
// rather than unflashed. Installed by both the per-width contexts and the return-target one.
function framesSampler(){
 const frames=[];
 window.__frames=frames;
 const visible=selector=>{
  const node=document.querySelector(selector);
  if(!node)return false;
  const style=getComputedStyle(node);
  return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0;
 };
 const snapshot=()=>({splash:visible('#signed-in-splash'),hero:visible('.home-hero'),mist:visible('.arrival-mist'),skip:visible('.skip-arrival'),arriving:Boolean(document.body?.classList.contains('is-arriving')),attr:document.documentElement.getAttribute('data-signed-in'),body:Boolean(document.body),t:Math.round(performance.now())});
 const frame=()=>{frames.push(snapshot());if(frames.length<240)requestAnimationFrame(frame);};
 requestAnimationFrame(frame);
 let ticks=0;
 const timer=setInterval(()=>{frames.push(snapshot());if(++ticks>60)clearInterval(timer);},50);
}
// Sign out is the nav's account menu, on every page of the site (site/web.js:81, `action('Sign out')`):
// the page-level button went with the panel, so this is the surface a signed-in visitor has, and it
// is exercised from the root rather than from /account/.
async function signOutFromNav(page,label){
 await page.locator('.web-account-nav').click();
 const out=page.locator('#web-account-menu button').filter({hasText:'Sign out'});
 await out.waitFor();
 await out.click();
 await page.waitForFunction(()=>document.querySelector('.web-account-name')?.textContent.trim()==='Sign in');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null,label+': the nav\'s sign-out clears the session this tab holds');
 assert.equal(await page.locator('.web-account-nav').getAttribute('aria-label'),'Sign in or create an Easter Company account',label+': and the control is the signed-out one again');
}
try{
 for(const width of [1440,834,390]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  await context.addInitScript(framesSampler);
  const page=await context.newPage(),errors=[],calls=[],loads=[],counted={};
  // One stub authority. `exchange` decides what the exchange says and `startRefusal` what the
  // start says, so one journey can be signed in, refused and replayed without a second server.
  // `hold` slows one answer down so the busy state can be read while it is on screen rather than
  // guessed at afterwards.
  // `meName` is what GET /v2/accounts/me calls the account, so one journey can prove the nav shows
  // the name the SERVICE answered with rather than the one the tab happens to have stored.
  // `providerReturn` is what the provider's own page does with the popup it was given. null is the
  // plain fixture page the provider journeys use; 'signed-in' answers 302 to the site root with the
  // flag, which is exactly what the account API's callback does with a finished provider sign-in.
  let exchange='ok',hold=0,startRefusal=null,password='ok',meName=null,providerRefusal=false,providerReturn=null;
  page.on('pageerror',error=>errors.push(error.message));
  watcher(page,loads);
  await context.route(API_ORIGIN+'/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   calls.push({path,method:request.method(),body:request.postDataJSON?.()??null});
   if(hold)await new Promise(done=>setTimeout(done,hold));
   let status=200,value={};
   if(path==='/v2/oauth/microsoft/start'){
    if(startRefusal){status=503;value={error:'redirect_uri_not_registered',message:NOT_REGISTERED};}
    else value={state:STATE,authorizeUrl:'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=fixture&response_type=code&redirect_uri='+encodeURIComponent(REDIRECT_URI)+'&scope=XboxLive.signin+offline_access&state='+STATE+'&code_challenge=fixture-challenge&code_challenge_method=S256',expiresIn:600,redirectUri:REDIRECT_URI};
   }
   else if(path==='/v2/oauth/microsoft/exchange'){
    if(exchange==='ok')value=signed(ACCOUNT);
    else if(exchange==='new-account')value=signed(NEW_ACCOUNT);
    else if(exchange==='replay'){status=401;value={error:'oauth_state_invalid',message:'This sign-in has expired or was already used. Start again.'};}
    else{status=503;value={error:'redirect_uri_not_registered',message:NOT_REGISTERED};}
   }
   else if(path==='/v2/accounts/providers')value={providers:['microsoft','steam','google']};
   else if(path==='/v2/accounts/providers/start')value={flow:'f'.repeat(43),url:'https://steamcommunity.com/openid/login?fixture=1',expiresIn:600};
   else if(path==='/v2/accounts/providers/finish'){
    if(providerRefusal){status=403;value={error:'provider_refused',message:'Steam did not confirm the sign-in.'};}
    else value=signed(ACCOUNT);
   }
   else if(path==='/v2/accounts/password/login'){
    // The direct Company sign-in this page shares with the dialog. The refusal is the service's
    // own 401, which the seam turns into its own sentence; this suite asserts the page shows it
    // rather than pinning the words, which belong to site/account-client.mjs.
    if(password==='refused'){status=401;value={error:'invalid_credentials'};}
    else value=signed(ACCOUNT);
   }
   // The boot read answers with the account this flow produced: the name `meName` asks for, the
   // account with no username yet while that is the exchange's shape, and ACCOUNT otherwise.
   else if(path==='/v2/accounts/me')value={account:meName?{...ACCOUNT,displayName:meName}:exchange==='new-account'?NEW_ACCOUNT:ACCOUNT};
   else if(path==='/v2/accounts/logout')value={};
   else throw Error('Unexpected API request '+path);
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  // Microsoft's own sign-in page, as a fixture: what matters is that the browser was sent to the
  // authorize address carrying this page's registered redirect, not that Microsoft drew anything.
  await context.route('https://login.microsoftonline.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture Microsoft sign-in</title><p>Fixture authority</p>'}));
  await context.route('https://steamcommunity.com/**',route=>providerReturn==='signed-in'
   ?route.fulfill({status:302,headers:{location:origin+'/?signed-in=1'},body:''})
   :route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture provider</title><p>Fixture provider complete</p>'}));

  const atAccount=()=>page.goto(origin+'/account/');
  const exchangeCalls=()=>calls.filter(call=>call.path==='/v2/oauth/microsoft/exchange');
  const startCalls=()=>calls.filter(call=>call.path==='/v2/oauth/microsoft/start');
  const noOverflow=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow at '+width+' during '+label);
  // One counted step: how many document loads it cost, and which.
  const step=async(name,run)=>{const before=loads.length;const value=await run();const count=loads.length-before;const urls=loads.slice(before);counted[name]={count,urls};return {count,urls,value};};

  await step('nav Sign in -> dialog',()=>page.goto(origin+'/'));
  // 2. A start the service refuses is read in the dialog the player pressed, and costs no page
  //    load at all: nothing is navigated away from and no second surface appears.
  startRefusal='not-registered';
  const startRefused=await step('dialog start refused by the service',async()=>{
   await page.getByRole('button',{name:'Sign in or create an Easter Company account',exact:true}).click();
   await page.locator('#desktop-company-signin[open]').waitFor();
   await page.locator('#desktop-company-signin .company-microsoft').click();
   await page.locator('#desktop-company-signin .company-error').filter({hasText:'does not accept this sign-in yet'}).waitFor();
  });
  assert.equal(startRefused.count,0,'a refused start costs no document load: '+JSON.stringify(startRefused.urls));
  assert.equal(await page.locator('#desktop-company-signin').evaluate(dialog=>dialog.open),true,'the refusal is read in the dialog the player pressed');
  assert((await page.locator('#desktop-company-signin .company-error').innerText()).includes(NOT_REGISTERED),'in the service\'s own words');
  assert.equal(await page.getByRole('button',{name:'Sign in with Steam',exact:true}).isDisabled(),false,'and the options are usable again afterwards');
  startRefusal=null;
  await page.locator('#desktop-company-signin .dialog-close').click();
  await page.locator('#desktop-company-signin').waitFor({state:'hidden'});

  // 3. The dialog on any other page starts the flow where the player is and reaches Microsoft in
  //    ONE document load. It used to send the browser to /account/?provider=microsoft and let that
  //    page start the flow - a load that answered nothing, and one the Back button re-entered.
  const toMicrosoft=await step('dialog "Sign in with Microsoft" -> Microsoft',async()=>{
   await page.getByRole('button',{name:'Sign in or create an Easter Company account',exact:true}).click();
   await page.locator('#desktop-company-signin[open]').waitFor();
   hold=400;
   await page.locator('#desktop-company-signin .company-microsoft').click();
   // While the service is being asked to begin a flow the dialog reports it, rather than sitting
   // still and then leaving.
   await page.locator('#desktop-company-signin .company-wait').filter({hasText:BUSY_SIGN_IN}).waitFor();
   await page.waitForURL('https://login.microsoftonline.com/**');
   hold=0;
  });
  assert.equal(toMicrosoft.count,1,'the dialog reaches Microsoft in one document load: '+JSON.stringify(toMicrosoft.urls));
  assert(!toMicrosoft.urls.some(url=>url.includes('/account/')),'and does not bounce through /account/ first: '+JSON.stringify(toMicrosoft.urls));
  assert.equal(startCalls().length,2,'the refused start and this one: two asks, and no more');
  assert.equal(page.url().includes(encodeURIComponent(REDIRECT_URI)),true,'the authorize address carries the registered redirect');

  // 2. The page offers the same options as the dialog, in the same words and the same order - and
  //    that is a statement about the markup: both are one renderer's node.
  await step('Microsoft -> /account/ with no code',()=>atAccount());
  await page.getByRole('heading',{name:'Easter Company account',exact:true}).waitFor();
  const microsoft=page.getByRole('button',{name:SIGN_IN.microsoft,exact:true});
  await microsoft.waitFor();
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).waitFor();
  const pageOptions=(await page.locator('#account-root .company-signin').innerText()).replace(/\s+/g,' ').trim();
  const pageButtons=await page.locator('#account-root .company-signin button').allInnerTexts();
  assert.deepEqual(pageButtons,[SIGN_IN.microsoft,...PROVIDER_LABELS,SIGN_IN.submit],'the page draws Microsoft, then the providers in the one order, then Sign in: '+JSON.stringify(pageButtons));
  assert.equal(await page.locator('#account-root input[name=identifier]').count(),1,'the page has the direct Company username field');
  assert.equal(await page.locator('#account-root input[name=password]').count(),1,'and the password field beside it');
  // Discord is not configured in this fixture: it is drawn, disabled, saying so - exactly as the
  // dialog draws it, because it is the same renderer.
  const discord=page.getByRole('button',{name:'Sign in with Discord',exact:true});
  assert.equal(await discord.isDisabled(),true,'an unconfigured provider is shown as unconfigured, not left out');
  assert.equal(await discord.getAttribute('title'),SIGN_IN.providerUnconfigured);
  assert.equal(await page.evaluate(()=>Boolean(window.easterDesktop)),false);
  assert.equal(await page.locator('footer.account-footer a[href$="legal/privacy/"]').count(),1);
  // This page draws no sign-out of its own any more, and it carries no signed-in panel in its
  // markup either: both went with the panel a success used to paint. Sign-out is the nav's, on
  // every page (site/web.js:81), which is why there is no page-level button to find here.
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).count(),0,'the account page has no Sign out of its own');
  assert.equal(await page.locator('.account-identity, .account-note').count(),0,'no signed-in panel exists on this page');
  // And what the panel was built from - the sentence about Play, the identity line, the constant
  // and the classes - is DELETED rather than moved: none of it exists in the file this server just
  // served, so a later reader cannot find it parked somewhere else. The rendered page is asserted
  // the same way below, which is the check that matters: a comment could still say the words.
  const served=await page.evaluate(()=>fetch('account.mjs').then(answer=>answer.text()));
  for(const gone of ['Signing in here does not start Minecraft','Play stays in the launcher','Signed in as','account-note','account-identity','PLAY_NOTE'])
   assert.equal(served.includes(gone),false,'the account page no longer carries '+JSON.stringify(gone));
  assert(served.includes("location.replace(takeTarget()||new URL('../',location.href))"),'and a success is a navigation to the return target this tab stored, or to the site root when it stored none');
  const drawn=(await page.locator('#account-panel').innerText()).replace(/\s+/g,' ');
  for(const gone of ['Signing in here does not start Minecraft','Play stays in the launcher','Signed in as'])
   assert.equal(drawn.includes(gone),false,'the page draws no '+JSON.stringify(gone)+': '+drawn);
  await noOverflow('the sign-in choices');
  // The dialog, on this same page, draws the same node: this comparison is the whole of point one.
  await page.getByRole('button',{name:'Sign in or create an Easter Company account',exact:true}).evaluate(button=>button.click());
  await page.locator('#desktop-company-signin[open]').waitFor();
  const dialogOptions=(await page.locator('#desktop-company-signin .company-signin').innerText()).replace(/\s+/g,' ').trim();
  assert.equal(dialogOptions,pageOptions,'the dialog and the page carry one list of options, word for word:\n dialog: '+dialogOptions+'\n  page: '+pageOptions);
  assert.equal((await page.locator('#desktop-company-signin h2').innerText()).trim(),(await page.locator('.account-heading').innerText()).trim(),'and one heading');
  await page.locator('#desktop-company-signin .dialog-close').click();
  await page.locator('#desktop-company-signin').waitFor({state:'hidden'});

  // 3. Keyboard: the options are reachable in the order they are drawn, and Enter on the focused
  //    Microsoft button starts the flow - the primary action is not a pointer-only one. Discord is
  //    not configured in this fixture, so Tab steps over it: a control that cannot be pressed is
  //    not a stop in the keyboard order either.
  const order=[];
  await page.locator('#account-root .company-signin button').first().focus();
  for(let index=0;index<6;index++){
   order.push(await page.evaluate(()=>{const node=document.activeElement;return node.tagName==='INPUT'?node.name:(node.textContent||'').trim();}));
   await page.keyboard.press('Tab');
  }
  assert.deepEqual(order,[SIGN_IN.microsoft,...PROVIDER_LABELS.slice(0,2),'identifier','password',SIGN_IN.submit],'Tab walks the options in the order they are drawn, skipping the one option that is disabled: '+JSON.stringify(order));
  await page.locator('#account-root .company-microsoft').focus();
  hold=300;
  const byKeyboard=await step('/account/ "Sign in with Microsoft" -> Microsoft',async()=>{
   await page.keyboard.press('Enter');
   await page.waitForURL('https://login.microsoftonline.com/**');
   hold=0;
  });
  assert.equal(byKeyboard.count,1,'the page reaches Microsoft in one document load: '+JSON.stringify(byKeyboard.urls));

  // 4. THE CALLBACK. The code and the state it arrived with are posted, the Company session is
  //    kept - and the page paints no account: it replaces itself with the SITE ROOT, with the
  //    account named in the nav. While the exchange is in flight the page is the busy state and
  //    nothing else, which is unchanged.
  exchange='ok';
  hold=400;
  const callback=await step('Microsoft -> /account/ callback with a code',async()=>{
   await page.goto(CALLBACK_URL);
   const mark=await assertBusy(page,{width,label:'the exchange',sentence:BUSY_SIGN_IN});
   // Reduced motion is the context this suite runs in: the spinner must still be something - a
   // still gold ring rather than an invisible or empty element.
   assert.equal(mark.animation,'none','reduced motion stops the rotation');
   assert.equal(mark.border,'rgb(228, 196, 134)','and paints the ring solid gold instead: '+JSON.stringify(mark));
   // A success is a navigation now, so this is what the end of the flow looks like.
   await page.waitForURL(SITE_ROOT);
  });
  hold=0;
  assert.equal(callback.urls.filter(url=>url.includes('/account/')).length,1,'the callback is one document load and the exchange never reloads it: '+JSON.stringify(callback.urls));
  assert.equal(callback.count,2,'and it leaves for the site root - one more document load, which is the feature: '+JSON.stringify(callback.urls));
  await assertLeftForRoot(page,'the Microsoft callback');
  assert.equal(exchangeCalls().length,1);
  assert.deepEqual(exchangeCalls()[0].body,{code:CALLBACK_CODE,state:STATE,client:'website/1'});
  assert.equal(new URL(page.url()).search,'','the code is not left in the address bar');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')!==null),true);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-company-session')),false);
  assert.equal(await page.getByRole('button',{name:'Play',exact:true}).count(),0);
  await noOverflow('the site root after a sign-in');
  // The entry the callback arrived on was REPLACED, not added to - which is why the page uses
  // location.replace: Back from the root must not re-enter /account/ carrying a spent code.
  // Measured, then the root is restored for the journeys that follow.
  await page.goBack({waitUntil:'load'});
  assert.equal(page.url().includes('/account/'),false,'Back from the site root does not return to the callback: '+page.url());
  await page.goForward({waitUntil:'load'});
  await page.waitForURL(SITE_ROOT);

  // 5. OPENING /account/ WHILE SIGNED IN IS THE SAME SUCCESS - a refresh, a bookmark, a typed
  //    address - and it leaves for the root too. The account is not trusted on faith: the nav ends
  //    up with the name the SERVICE answered, not the one the tab has stored.
  meName='RefreshedFixture';
  const meBefore=calls.filter(call=>call.path==='/v2/accounts/me').length;
  const revisit=await step('a signed-in visit to /account/ -> the site root',async()=>{
   await page.goto(origin+'/account/');
   await page.waitForURL(SITE_ROOT);
   await page.waitForFunction(()=>document.querySelector('.web-account-name')?.textContent.trim()==='RefreshedFixture');
  });
  meName=null;
  assert.equal(revisit.count,2,'the account page and the root it sends the browser to: '+JSON.stringify(revisit.urls));
  assert.deepEqual(revisit.urls.map(url=>url.replace(origin,'')),['/account/','/'],'the account page is loaded once and replaced by the root: '+JSON.stringify(revisit.urls));
  assert(calls.filter(call=>call.path==='/v2/accounts/me').length>meBefore,'the session is read from the service, not trusted: '+JSON.stringify(calls.filter(call=>call.path==='/v2/accounts/me').length));
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')!==null),true,'and the session survives the visit');
  await noOverflow('the site root after a signed-in visit to the account page');

  // 6. SIGN OUT IS THE NAV'S, ON EVERY PAGE. The panel's own button went with the panel; the menu
  //    the nav opens on the root is what clears the session, and it still does.
  await signOutFromNav(page,'signing out from the site root');
  await noOverflow('the site root after signing out');
  // And the account page meets a signed-out visitor with the shared options panel again.
  await page.goto(origin+'/account/');
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await page.locator('#account-root .company-signin').count(),1,'signing out draws the shared panel again');
  assert.equal(await page.locator('.account-identity').count(),0,'with no signed-in panel anywhere on it');
  await noOverflow('the sign-in choices after signing out');

  // 7. A provider sign-in started on this page: the page is the busy state and says which flow it
  //    waits on, and a success leaves for the site root - one document load, where answering in
  //    place used to cost none.
  const providerStep=await step('a provider sign-in -> the site root',async()=>{
   await page.getByRole('button',{name:'Sign in with Steam',exact:true}).click();
   await assertBusy(page,{width,label:'the provider sign-in',sentence:BUSY_PROVIDER});
   await page.waitForURL(SITE_ROOT,{timeout:20000});
  });
  assert.equal(providerStep.count,1,'a provider sign-in leaves for the site root in one document load: '+JSON.stringify(providerStep.urls));
  assert.equal(new URL(providerStep.urls[0]).pathname,'/','and the load it costs is the root: '+JSON.stringify(providerStep.urls));
  await assertLeftForRoot(page,'a provider sign-in');
  await signOutFromNav(page,'signing out after a provider sign-in');
  await page.goto(origin+'/account/');
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();

  // 7b. A PROVIDER REFUSAL IS NOT A SUCCESS, and it must not become one: the page stays where it
  //     is, draws the service's own sentence in the one alert region, and ends the busy state.
  providerRefusal=true;
  const providerRefused=await step('a provider refusal, re-rendered in place',async()=>{
   await page.getByRole('button',{name:'Sign in with Steam',exact:true}).click();
   await assertBusy(page,{width,label:'the refused provider sign-in',sentence:BUSY_PROVIDER});
   await page.locator('.account-error').waitFor({timeout:20000});
   await page.waitForTimeout(300);
  });
  providerRefusal=false;
  assert.equal(providerRefused.count,0,'a provider refusal navigates nowhere: '+JSON.stringify(providerRefused.urls));
  assert.equal(new URL(page.url()).pathname,ACCOUNT_PATH,'and it ends on the account page: '+page.url());
  assert.equal(await page.locator('#account-panel').getAttribute('data-busy'),'false','the busy state ended with the flow');
  assert.equal(await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).isVisible(),true,'and the options are drawn beside the refusal');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null,'and nobody was signed in');
  const providerRefusalText=(await page.locator('.account-error').innerText()).trim();
  assert(providerRefusalText.length>0,'the refusal is drawn as a sentence, not left blank: '+JSON.stringify(providerRefusalText));
  assert.equal(await page.locator('.account-identity').count(),0,'and no account is painted for it');
  await noOverflow('a provider refusal');

  // 8. The direct Company sign-in, on this page: the option Owen found missing. It is the same form
  //    the dialog draws, it is a busy state while it runs, and it leaves for the site root too. The
  //    refusal is unchanged: it ends on this page, in the one alert region, password cleared.
  await page.locator('#account-root input[name=identifier]').fill('fixture_player');
  await page.locator('#account-root input[name=password]').fill('fixture-passphrase');
  hold=400;
  const direct=await step('a direct username/password sign-in -> the site root',async()=>{
   await page.locator('#account-root button[type=submit]').click();
   await assertBusy(page,{width,label:'the direct sign-in',sentence:BUSY_SIGN_IN});
   await page.waitForURL(SITE_ROOT);
  });
  hold=0;
  assert.equal(direct.count,1,'the direct sign-in leaves for the site root in one document load: '+JSON.stringify(direct.urls));
  await assertLeftForRoot(page,'a direct Company sign-in');
  await signOutFromNav(page,'signing out after a direct sign-in');
  await page.goto(origin+'/account/');
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  password='refused';
  const refusedPassword=await step('a refused direct sign-in, re-rendered in place',async()=>{
   await page.locator('#account-root input[name=identifier]').fill('fixture_player');
   await page.locator('#account-root input[name=password]').fill('not-the-passphrase');
   await page.locator('#account-root button[type=submit]').click();
   await page.locator('.account-error').waitFor();
   await page.waitForTimeout(300);
  });
  assert.equal(refusedPassword.count,0,'a refused sign-in navigates nowhere: '+JSON.stringify(refusedPassword.urls));
  assert.equal(page.url(),origin+'/account/','a refused sign-in ends on the account page: '+page.url());
  assert.equal(await page.locator('#account-panel').getAttribute('data-busy'),'false','a refusal is not a busy state');
  assert.equal(await page.locator('#account-root input[name=password]').inputValue(),'','the password is not left on screen after a refusal');
  assert.equal(await page.locator('#account-root input[name=identifier]').inputValue(),'fixture_player','and what was typed as the identifier is kept');
  assert.equal(await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).isVisible(),true,'the options are drawn beside the refusal');
  assert.equal(await page.locator('.account-identity').count(),0,'and a refusal paints no account');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null,'and it signs nobody in');
  password='ok';

  // 9. A cancelled sign-in is the authority's own shape: error plus description, no code, and no
  //    exchange is attempted. Nothing was in flight, so the options are readable beside it.
  const before=exchangeCalls().length;
  await page.goto(origin+'/account/?error=access_denied&error_description='+encodeURIComponent('AADSTS50011: the player cancelled the sign-in.'));
  await page.getByText('Sign-in cancelled.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,ACCOUNT_PATH,'a cancelled sign-in stays on the account page: '+page.url());
  assert.equal(await page.locator('#account-panel').getAttribute('data-busy'),'false','a refusal is not a busy state');
  assert.equal(await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).isVisible(),true,'and the options are drawn beside it');
  assert.equal(exchangeCalls().length,before,'a refusal has no code to exchange');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await noOverflow('a cancelled sign-in');

  // 9. A refusal the service made is drawn in the service's own words, in place: the page loads
  //    once for the callback it answered and not again to show the answer.
  exchange='not-registered';
  const refused=await step('a refused exchange, re-rendered in place',async()=>{
   await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
   await page.locator('.account-error').filter({hasText:'not registered'}).waitFor();
   const settled=loads.length;
   await page.waitForTimeout(300);
   assert.equal(loads.length,settled,'a refusal navigates nowhere: '+JSON.stringify(loads.slice(settled)));
  });
  assert.equal(refused.count,1,'a refused exchange costs the one document load it arrived on: '+JSON.stringify(refused.urls));
  assert.equal(new URL(page.url()).pathname,ACCOUNT_PATH,'a refused exchange stays on the account page: '+page.url());
  const refusal=await page.locator('.account-error').innerText();
  assert(refusal.includes(NOT_REGISTERED),'the service sentence is drawn verbatim: '+refusal);
  assert(refusal.includes('does not accept this sign-in yet'));
  assert.equal(await page.locator('#account-panel').getAttribute('data-busy'),'false','the refusal is read on the ordinary page, not on a spinner');
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await noOverflow('a refusal');

  // 10. A replayed state is refused by the service and reads as start again.
  exchange='replay';
  const beforeReplay=exchangeCalls().length;
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
  await page.getByText('This sign-in has expired or was already used. Start again.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,ACCOUNT_PATH,'a replayed state stays on the account page: '+page.url());
  assert.equal(exchangeCalls().length,beforeReplay+1);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);

  // 11. A callback with no state is refused before anything is sent, and the page says so in place
  //     rather than bouncing anywhere.
  exchange='ok';
  const beforeNoState=exchangeCalls().length;
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE));
  await page.getByText('This sign-in has expired or was already used. Start again.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,ACCOUNT_PATH,'a callback with no state stays on the account page: '+page.url());
  assert.equal(exchangeCalls().length,beforeNoState,'no exchange is asked for without a state');

  // 12. The flow belongs to one address. Loaded anywhere else, the page says so and offers no
  //     Microsoft button at all, rather than sending the authority a URI nobody registered.
  const beforeWrong=startCalls().length;
  await page.goto(origin+'/account/index.html');
  await page.getByText('Browser Microsoft sign-in is not configured yet.',{exact:true}).waitFor();
  await page.getByText('Sign in at '+REDIRECT_URI+'.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).count(),0);
  assert.equal(startCalls().length,beforeWrong);
  await noOverflow('the wrong address');

  // 13. A Microsoft account with no Easter Company username yet reaches the existing first-time
  //     setup, exactly as a provider sign-up on this site does: the page does not invent a second
  //     way to claim a name. Closing that setup with the account signed in is a success like any
  //     other, so it leaves for the site root - where the nav offers the setup rather than a name.
  exchange='new-account';
  await page.goto(CALLBACK_URL);
  await page.locator('#desktop-company-username[open]').waitFor();
  await page.getByRole('heading',{name:'Choose your Easter Company username',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close username setup',exact:true}).click();
  await page.waitForURL(SITE_ROOT);
  assert.equal(page.url(),SITE_ROOT,'an account with no name yet leaves for the site root too: '+page.url());
  await page.waitForFunction(()=>document.querySelector('.web-account-name')?.textContent.trim()==='Finish setup');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')!==null),true,'and the session it created is still the tab\'s');
  exchange='ok';

  // 14. Nothing on this path may ask for a Minecraft session, and no Microsoft token is stored.
  const routes=new Set(calls.map(call=>call.path));
  for(const path of routes)assert(['/v2/oauth/microsoft/start','/v2/oauth/microsoft/exchange','/v2/accounts/providers','/v2/accounts/providers/start','/v2/accounts/providers/finish','/v2/accounts/password/login','/v2/accounts/me','/v2/accounts/logout'].includes(path),'unexpected API route '+path);
  // What the tab keeps is one Company session, in the launcher's own shape: the token, the expiry and
  // the account document the service returned, so the next cold load paints the account on its first
  // frame instead of saying `Sign in` until /me answers (Owen, 2026-10-26, signed in: "I hit
  // ctrl+shift+r and now it says 'sign in'"). The account is the projection sanitizeAccount already
  // produced - a projection, not a credential - and the token is still the only secret here. What is
  // never kept is asserted next: no Microsoft token, and neither the callback's code nor its state.
  const stored=await page.evaluate(()=>Object.entries({...sessionStorage}));
  assert.equal(stored.length,1);
  assert.equal(stored[0][0],'easter-company-web-session-v1');
  const kept=JSON.parse(stored[0][1]);
  assert.deepEqual(Object.keys(kept).sort(),['account','expiresAt','token']);
  assert.equal(kept.token,SESSION_TOKEN);
  assert.equal(kept.account.displayName,ACCOUNT.displayName,'and it is the account the session belongs to');
  for(const secret of [CALLBACK_CODE,STATE,'access_token','refresh_token','id_token'])assert(!JSON.stringify(stored).includes(secret),'nothing of Microsoft\'s is kept: '+secret);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-company-session')),false);

  // 15. The three widths keep their layout: nothing overflows, and every option keeps a
  //     thumb-sized target. Measured rather than looked at, because these are numbers a reviewer
  //     can re-run.
  // The signed-out page is what these three widths are about, and it is asked for explicitly: this
  // tab is signed in, so it is cleared rather than raced (site/web-account.mjs paints a saved session
  // on the first frame now, so a check that did not clear would simply measure the account).
  await page.evaluate(()=>sessionStorage.clear());
  await page.goto(origin+'/account/');
  await page.locator('#account-root .company-signin').waitFor();
  await page.waitForFunction(()=>document.getElementById('account-panel')?.dataset.busy==='false');
  assert.equal(await page.locator('.account-identity').count(),0,'the signed-out options are what these widths measure, on a page that paints no account at all');
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).waitFor();
  await noOverflow('the final sign-in choices');
  const controlHeights=await page.locator('#account-root .company-signin button, #account-root .company-signin input').evaluateAll(nodes=>nodes.map(node=>({label:(node.textContent||node.name||'').trim(),height:Math.round(node.getBoundingClientRect().height)})));
  for(const control of controlHeights)assert(control.height>=44,'every option is at least 44px tall at '+width+': '+JSON.stringify(control));
  const panelBox=await page.locator('#account-panel').evaluate(node=>{const rect=node.getBoundingClientRect();return {width:Math.round(rect.width),height:Math.round(rect.height),right:Math.round(rect.right)};});
  assert(panelBox.right<=width,'the panel stays inside the viewport at '+width+': '+JSON.stringify(panelBox));

  // 16. THE SIGN-IN SPLASH. A provider sign-in that finishes in the window site/web-account.mjs
  //     opened comes back to the SITE ROOT as `/?signed-in=1` (the account API's callback), and
  //     Owen's rule of 2026-10-26 is that that window shows `Login Successful` instead of the
  //     homepage and its arrival intro for the second or two before it closes. Four journeys, one
  //     per case, and each of them reads the frame history the sampler above recorded: "the splash
  //     was the first paint" is a measurement here, not a screenshot taken afterwards.
  //
  //     (a) THE REAL POPUP, driven through site/web-account.mjs exactly as a player drives it: the
  //     nav's dialog, the provider, the API's 302 back to the root with the flag. What must hold is
  //     that the splash is what that window painted - never the hero, never the mist, never the Skip
  //     intro button - and that the window then closed itself.
  providerReturn='signed-in';
  const popupSplash=await step('a provider popup returns with ?signed-in=1, then closes itself',async()=>{
   await page.goto(origin+'/');
   const opened=page.waitForEvent('popup');
   await page.getByRole('button',{name:'Sign in or create an Easter Company account',exact:true}).click();
   await page.locator('#desktop-company-signin[open]').waitFor();
   await page.getByRole('button',{name:'Sign in with Steam',exact:true}).click();
   const popup=await opened;
   // The popup is its own document, so its errors are the suite's errors too.
   popup.on('pageerror',error=>errors.push('popup: '+error.message));
   const closed=popup.waitForEvent('close',{timeout:20000});
   await popup.locator('#signed-in-splash').waitFor();
   // Everything is read in ONE evaluation, before the window closes itself a moment later: the
   // address as it stands, the name it still carries, the whole frame history, and the live state.
   await popup.waitForFunction(()=>Array.isArray(window.__frames)&&window.__frames.length>2);
   const shot=await popup.evaluate(splashState);
   await closed;
   // The sign-in itself is untouched: the window closed itself and the poll behind it saved the
   // account, which the root paints in the nav without leaving the page.
   await page.waitForFunction(name=>document.querySelector('.web-account-name')?.textContent.trim()===name,NAV_NAME);
   return {shot,url:page.url()};
  });
  providerReturn=null;
  {
   const {shot,url}=popupSplash.value;
   assert.equal(popupSplash.count,1,'the popup costs the opener the root it was opened from, and no more: '+JSON.stringify(popupSplash.urls.map(url=>url.replace(origin,''))));
   assert.equal(url,SITE_ROOT,'the opener stayed on the site root: '+url);
   // The name site/web-account.mjs gives the window before navigating it is the whole distinction:
   // it survived about:blank, the provider's own origin and the API's 302 back here.
   assert.equal(shot.name,SIGN_IN_WINDOW,'the returning popup still carries the name site/web-account.mjs gave it: '+JSON.stringify(shot.name));
   assert.equal(shot.url,SITE_ROOT,'and its address is already the ordinary homepage: '+shot.url);
   assert.equal(shot.attr,'1','the splash is the attribute-keyed rule, not a module that arrived later');
   assert.equal(shot.splash,true,'the returning window paints the splash');
   assert.equal(shot.title,'Login Successful','in the owner\'s own words: '+JSON.stringify(shot.title));
   assert.equal(shot.hero,false,'and never the hero at '+width);
   assert.equal(shot.mist,false,'nor the arrival mist at '+width);
   assert.equal(shot.skip,false,'nor the Skip intro button at '+width);
   assert.equal(shot.fallback,false,'a window that closed itself is told nothing about closing');
   // It is the whole screen of that window, not a banner over a homepage: the box is the viewport,
   // the phoenix mark the wordmark uses and the heading are both laid out, and nothing overflows.
   console.log('  the returning popup at '+width+': viewport '+shot.viewport.w+'x'+shot.viewport.h+', splash '+JSON.stringify(shot.splashBox)+', mark '+JSON.stringify(shot.markBox)+', heading '+JSON.stringify(shot.titleBox));
   assert.deepEqual([shot.splashBox.x,shot.splashBox.y,shot.splashBox.w,shot.splashBox.h],[0,0,shot.viewport.w,shot.viewport.h],'the splash is the whole viewport of that window');
   assert(shot.markBox.w>0&&shot.titleBox.w>0,'the phoenix mark and the heading are laid out, not empty boxes');
   assert(shot.viewport.scrollWidth<=shot.viewport.w,'and nothing overflows its window: '+JSON.stringify(shot.viewport));
   // The frame history is the first-paint claim: sampled from the first animation frame of the
   // document, so a flash of the homepage or of the intro would be in here.
   const framed=shot.frames.filter(frame=>frame.body);
   assert(framed.length>=2,'frames were sampled from the first paint: '+shot.frames.length);
   assert(framed.some(frame=>frame.splash),'the splash is in the recorded frames');
   const flashed=framed.filter(frame=>frame.hero||frame.mist||frame.skip);
   assert.deepEqual(flashed,[],'no frame of the popup ever showed the homepage, the mist or Skip intro: '+JSON.stringify(flashed));
   assert.equal(framed.every(frame=>!frame.arriving),true,'the arrival intro never started inside the splash');
   assert.equal(framed.every(frame=>frame.attr==='1'),true,'from its very first frame this was the flag\'s page, not a later decision');
   // AND IT CLOSED ITSELF. The opener cannot be the one that closed it: site/web-account.mjs waits
   // 2000ms between finish polls and closes in its `finally`, so a window still holding this record
   // at 1500ms of its own document would be closed by the opener rather than by the splash.
   const last=shot.frames.at(-1);
   assert(last.t<1500,'the returning window acted on itself, before the opener\'s first 2000ms poll could: last frame at '+last.t+'ms');
   await signOutFromNav(page,'signing out after the popup splash');
  }

  //     (b) A WINDOW THE BROWSER WILL NOT CLOSE. window.close() is refused for any window no script
  //     opened, which is the case the one fallback sentence exists for; this journey puts the marker
  //     on an ordinary tab, so it is that branch exactly: the splash stays, readable, carrying
  //     Owen's line - and the line appears nowhere else.
  const refusedClose=await step('a window that cannot be closed keeps the splash and its one line',async()=>{
   await page.evaluate(name=>{window.name=name;},SIGN_IN_WINDOW);
   await page.goto(origin+'/?signed-in=1');
   await page.locator('#signed-in-splash').waitFor();
   await page.locator('#signed-in-splash-fallback').waitFor({timeout:10000});
   await page.waitForTimeout(120);
   return page.evaluate(splashState);
  });
  {
   const state=refusedClose.value;
   assert.equal(refusedClose.count,1,'the flag costs the one document load it arrived on: '+JSON.stringify(refusedClose.urls));
   assert.equal(state.name,SIGN_IN_WINDOW,'the marker is what made this the popup branch');
   assert.equal(state.url,SITE_ROOT,'and the address is cleaned anyway: '+state.url);
   assert.equal(state.splash,true,'the splash is still up: a refused close must not hide it');
   assert.equal(state.hero,false,'with the homepage still behind it');
   assert.equal(state.fallback,true,'and the one fallback line is drawn');
   assert(state.fallbackText.length>0,'as a sentence rather than an empty box');
   assert(state.fallbackText.length<=200,'one short sentence: '+JSON.stringify(state.fallbackText));
   console.log('  the fallback sentence a refused close shows: '+JSON.stringify(state.fallbackText));
   await noOverflow('the splash with its fallback line');
   // Nothing to hand back and nothing to reload: leave the marker behind for the next journey.
   await page.evaluate(()=>{window.name='';});
  }

  //     (c) AN ORDINARY TAB: nobody opened it for the sign-in, which is how the Microsoft flow
  //     returns the whole tab and how the launcher's provider window arrives. It shows the splash
  //     and then hands the page back IN PLACE - no second document load, no sentence telling the
  //     reader to close the window they are using, and nothing left hidden.
  const handedBack=await step('an ordinary tab with ?signed-in=1 hands back to the homepage in place',async()=>{
   await page.goto(origin+'/?signed-in=1');
   const beforeHandBack=loads.length;
   await page.locator('#signed-in-splash').waitFor();
   const during=await page.evaluate(splashState);
   await page.locator('#signed-in-splash').waitFor({state:'hidden',timeout:15000});
   await page.waitForTimeout(200);
   const after=await page.evaluate(splashState);
   const handBackLoads=loads.length-beforeHandBack;
   // And a reload of the address the hand-back left behind is the ordinary homepage: the flag is
   // not in it any more, so it cannot come back for a refresh, a bookmark or a copied link.
   await page.reload();
   await page.locator('.home-hero').waitFor();
   await page.waitForTimeout(250);
   const reloaded=await page.evaluate(splashState);
   return {during,after,reloaded,handBackLoads};
  });
  {
   const {during,after,reloaded,handBackLoads}=handedBack.value;
   const frames=after.frames;
   assert.equal(handBackLoads,0,'handing back is not a navigation - no document load between the splash and the homepage: '+JSON.stringify(handedBack.urls.map(url=>url.replace(origin,''))));
   assert.equal(handedBack.count,2,'the flag costs its one document load, and the reload its own: '+JSON.stringify(handedBack.urls.map(url=>url.replace(origin,''))));
   assert.notEqual(during.name,SIGN_IN_WINDOW,'this tab was not opened by the site: '+JSON.stringify(during.name));
   assert.equal(during.splash,true,'so it shows the splash too');
   assert.equal(during.url,SITE_ROOT,'with the flag already stripped: '+during.url);
   assert.equal(during.hero,false,'and nothing of the homepage under it at '+width);
   assert.equal(during.mist,false,'no arrival mist at '+width);
   assert.equal(during.attr,'1','the first paint was the splash');
   assert.equal(after.splash,false,'and then the splash goes');
   assert.equal(after.hero,true,'leaving the ordinary homepage');
   assert.equal(after.attr,null,'with no trace of the flag left on the document');
   assert.equal(after.url,SITE_ROOT,'and the address still the ordinary homepage');
   assert.equal(after.fallback,false,'an ordinary tab is never told to close itself');
   assert.equal(after.fallbackText,'','and the fallback sentence is not even in the page as text: '+JSON.stringify(after.fallbackText));
   // The frame history again: the page was never the homepage until the hand-back, and never the
   // homepage-and-splash at once.
   const flagged=frames.filter(frame=>frame.attr==='1');
   assert(flagged.some(frame=>frame.splash),'the splash is in the frames the flag owned');
   const early=flagged.filter(frame=>frame.hero||frame.mist||frame.skip);
   assert.deepEqual(early,[],'no frame before the hand-back showed the homepage or the intro: '+JSON.stringify(early));
   const settled=frames.filter(frame=>frame.attr!=='1');
   assert(settled.some(frame=>frame.hero&&!frame.splash),'and the hand-back is in the frames too, homepage without the splash');
   assert.deepEqual([during.splashBox.x,during.splashBox.y,during.splashBox.w,during.splashBox.h],[0,0,during.viewport.w,during.viewport.h],'the splash filled the viewport of this tab too: '+JSON.stringify(during.splashBox));
   assert.equal(reloaded.url,SITE_ROOT,'a reload asks for the cleaned address: '+reloaded.url);
   assert.equal(reloaded.splash,false,'and it is the ordinary homepage, with no splash');
   assert.equal(reloaded.attr,null,'and no attribute');
   assert(reloaded.frames.length>2,'frames were sampled on the reload: '+reloaded.frames.length);
   assert(reloaded.frames.every(frame=>frame.splash===false),'no frame of the reload showed the splash');
   await noOverflow('the homepage after the hand-back');
  }

  //     (d) WITHOUT THE FLAG, `/` IS THE HOMEPAGE IT ALWAYS WAS: no splash in the markup's paint,
  //     no attribute on the document, and the arrival intro free to run. A `signed-in` that is not
  //     `1` is the same ordinary visit, because the value is part of the flag.
  const noFlag=await step('the homepage without the flag, and with a flag that is not 1',async()=>{
   await page.goto(origin+'/');
   await page.locator('.home-hero').waitFor();
   await page.waitForTimeout(250);
   const root=await page.evaluate(splashState);
   await page.goto(origin+'/?signed-in=0');
   await page.locator('.home-hero').waitFor();
   const otherValue=await page.evaluate(splashState);
   return {root,otherValue};
  });
  {
   const {root,otherValue}=noFlag.value;
   const frames=root.frames;
   assert.equal(noFlag.count,2,'an ordinary visit and a wrong value: '+JSON.stringify(noFlag.urls.map(url=>url.replace(origin,''))));
   assert.equal(root.splash,false,'no splash without the flag');
   assert.equal(root.hero,true,'the hero is the page at '+width);
   assert.equal(root.attr,null,'and no data-signed-in attribute is ever set');
   assert.equal(root.fallback,false,'with no fallback line anywhere');
   assert(frames.length>2,'frames were sampled on this visit too: '+frames.length);
   assert(frames.every(frame=>frame.splash===false),'and no frame of it showed the splash: '+JSON.stringify(frames.filter(frame=>frame.splash)));
   assert(frames.every(frame=>frame.attr===null),'nor set the attribute for a frame: '+JSON.stringify(frames.filter(frame=>frame.attr!==null)));
   assert.equal(otherValue.splash,false,'?signed-in=0 is the ordinary homepage');
   assert.equal(otherValue.attr,null,'and sets nothing either');
  }

  // The counted table, printed before it is asserted: a change is visible in the log even when
  // nothing fails.
  console.log('document loads at '+width+':');
  for(const row of BUDGET){
   const countedRow=counted[row.step];
   if(!countedRow)continue;
   // `before: null` is a step the page could not do at all on f386139: the direct Company sign-in
   // was the option Owen found missing, so there is no number to compare it with.
   console.log('  '+row.step+': '+countedRow.count+' ('+(row.before===null?'no such option on f386139':'was '+row.before+' on f386139')+')'+(countedRow.urls.length?' - '+countedRow.urls.map(url=>url.replace(origin,'')).join(' , '):''));
  }
  for(const row of BUDGET){
   const countedRow=counted[row.step];
   if(!countedRow)continue;
   assert.equal(countedRow.count,row.after,row.step+' costs '+row.after+' document load(s), not '+countedRow.count);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS account page: one shared options panel, one busy state, counted document loads, chooser hand-off, choices, start by pointer and by keyboard, callback -> the site root, session, a signed-in visit -> the site root, sign out from the nav, provider -> the site root, direct -> the site root, cancelled, not registered, refused password, replay, no state, wrong address, the sign-in splash from the first frame (popup, refused close, ordinary tab, no flag) at '+width);
  checks++;await context.close();
 }
 // 17. THE RETURN TARGET: another of the household's apps sends the browser here to sign in and
 //     gets it back afterwards (Owen, 2026-10-26: "easter-co-smp.github.io should have generic flags
 //     to handle redirects and other e apps using the same auth flows"). site/auth-return.mjs owns
 //     the allow-list, the one storage key and the consume-once rule; this section is the composed
 //     proof, in a real browser, that a target survives the flows and that nothing else is followed.
 //     It is measured rather than assumed: sessionStorage is per tab and per origin, and the
 //     Microsoft flow leaves this origin entirely before it comes back.
 //
 //     The two allow-listed origins are answered by fixtures here: what is proved is where the
 //     browser was sent and what its address carries, not what that app does when it arrives.
 {
  const app=appUrl('e-server');
  const COMPANY_PAGE='https://easter.company/linked/';
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.addInitScript(framesSampler);
  const page=await context.newPage(),errors=[],loads=[];
  page.on('pageerror',error=>errors.push(error.message));
  watcher(page,loads);
  let password='ok';
  await context.route(API_ORIGIN+'/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   let status=200,value={};
   if(path==='/v2/oauth/microsoft/start')value={state:STATE,authorizeUrl:'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=fixture&response_type=code&redirect_uri='+encodeURIComponent(REDIRECT_URI)+'&state='+STATE+'&code_challenge=fixture-challenge&code_challenge_method=S256',expiresIn:600,redirectUri:REDIRECT_URI};
   else if(path==='/v2/oauth/microsoft/exchange')value=signed(ACCOUNT);
   else if(path==='/v2/accounts/providers')value={providers:['microsoft','steam','google']};
   else if(path==='/v2/accounts/providers/start')value={flow:'f'.repeat(43),url:'https://steamcommunity.com/openid/login?fixture=1',expiresIn:600};
   else if(path==='/v2/accounts/providers/finish')value=signed(ACCOUNT);
   else if(path==='/v2/accounts/password/login'){
    if(password==='refused'){status=401;value={error:'invalid_credentials'};}
    else value=signed(ACCOUNT);
   }
   else if(path==='/v2/accounts/me')value={account:ACCOUNT};
   else if(path==='/v2/accounts/logout')value={};
   else throw Error('Unexpected API request '+path);
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  await context.route('https://login.microsoftonline.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture Microsoft sign-in</title><p>Fixture authority</p>'}));
  await context.route('https://steamcommunity.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture provider</title><p>Fixture provider complete</p>'}));
  const appPage=title=>route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>'+title+'</title><p>'+title+'</p>'});
  await context.route('https://easter-server.char-istrian.ts.net:8443/**',appPage('Fixture e-server'));
  await context.route('https://easter.company/**',appPage('Fixture easter.company'));
  const storedTarget=()=>page.evaluate(key=>sessionStorage.getItem(key),RETURN_KEY);
  // BACK ON THIS ORIGIN BEFORE CLEARING IT: sessionStorage is per origin, so a clear run while the
  // tab is sitting on one of the returned apps' own origins would leave this tab's real session in
  // place and /account/ would boot signed in - which is exactly the bug this helper exists to keep
  // out of the journeys below.
  const clearTab=async()=>{
   await page.goto(origin+'/');
   await page.evaluate(()=>sessionStorage.clear());
  };
  const signedOutPage=async()=>{
   await clearTab();
   await page.goto(origin+'/account/');
   await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  };
  const directSignIn=async()=>{
   await page.locator('#account-root input[name=identifier]').fill('fixture_player');
   await page.locator('#account-root input[name=password]').fill('fixture-passphrase');
   await page.locator('#account-root button[type=submit]').click();
  };

  // (a) ?app=e-server SURVIVES THE MICROSOFT ROUND TRIP. The registered redirect is a fixed literal,
  //     so the app's name cannot travel in the callback's query string: it has to be in this tab's
  //     storage when the browser comes back, and this journey leaves the origin for
  //     login.microsoftonline.com and returns to prove that it is.
  await page.goto(origin+'/account/?app=e-server');
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await storedTarget(),app,'?app=e-server stores the allow-listed address before anything is signed in: '+await storedTarget());
  await page.locator('#account-root .company-microsoft').click();
  await page.waitForURL('https://login.microsoftonline.com/**');
  assert.equal(new URL(page.url()).searchParams.get('app'),null,'the authorize address carries no app: the callback cannot be given one');
  const callbackLoads=loads.length;
  await page.goto(CALLBACK_URL);
  await page.waitForURL(app,{timeout:20000});
  assert.equal(page.url(),app,'the callback leaves for the allow-listed app, not the site root: '+page.url());
  assert.deepEqual(loads.slice(callbackLoads),[CALLBACK_URL,app],'the callback is its own document and the return is one more: '+JSON.stringify(loads.slice(callbackLoads)));
  assert.equal(new URL(page.url()).search,'','the return address carries no query string');
  assert.equal(new URL(page.url()).hash,'','and no fragment');
  for(const secret of [SESSION_TOKEN,CALLBACK_CODE,STATE,'access_token','refresh_token','id_token','code='])
   assert.equal(page.url().includes(secret),false,'nothing of the sign-in travels in the return address: '+JSON.stringify(secret));
  assert.equal(await page.title(),'Fixture e-server','the tab really is on the app it was sent to');
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),RETURN_KEY),null,'and the target was spent by the sign-in that used it');
  // CONSUMED ONCE: the same tab, still signed in, with no target left, goes where it always did.
  const secondLoads=loads.length;
  await page.goto(origin+'/account/');
  await page.waitForURL(SITE_ROOT);
  assert.deepEqual(loads.slice(secondLoads).map(url=>url.replace(origin,'')),['/account/','/'],'a second visit is the account page and the site root: '+JSON.stringify(loads.slice(secondLoads)));
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),RETURN_KEY),null,'and it stored nothing of its own');

  // (b) ?next= IS ACCEPTED ONLY WHEN THE SAME VALIDATOR PASSES. A refused address is not an error:
  //     the visit is the visit it always was, and a sign-in ends on the site root.
  await signedOutPage();
  await page.goto(origin+'/account/?next='+encodeURIComponent('https://evil.example/signed-in'));
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await storedTarget(),null,'a next the validator refuses stores nothing');
  await directSignIn();
  await page.waitForURL(SITE_ROOT);
  assert.equal(page.url(),SITE_ROOT,'so the sign-in ends on the site root, exactly as it does with no parameter');
  await signedOutPage();
  await page.goto(origin+'/account/?next='+encodeURIComponent(COMPANY_PAGE));
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await storedTarget(),COMPANY_PAGE,'?next= on an easter.company host is stored');
  await directSignIn();
  await page.waitForURL(COMPANY_PAGE);
  assert.equal(new URL(page.url()).search,'','and the tab is left on that address with nothing appended');
  assert.equal(await page.title(),'Fixture easter.company','on the app the parameter named');

  // (c) A REFUSED SIGN-IN NAVIGATES NOWHERE AND LEAVES NO TARGET BEHIND - neither the service's
  //     refusal nor the authority's cancellation.
  await signedOutPage();
  await page.goto(origin+'/account/?app=e-server');
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await storedTarget(),app,'the request is stored while the visitor signs in');
  password='refused';
  await directSignIn();
  await page.locator('.account-error').waitFor();
  await page.waitForTimeout(300);
  password='ok';
  assert.equal(new URL(page.url()).pathname,ACCOUNT_PATH,'a refused sign-in navigates nowhere: '+page.url());
  assert.equal(await storedTarget(),null,'and drops the request instead of carrying it into the next sign-in');
  await page.goto(origin+'/account/?app=e-server');
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await storedTarget(),app,'the request is stored again for the next attempt');
  await page.goto(origin+'/account/?error=access_denied&error_description='+encodeURIComponent('AADSTS50011: the player cancelled the sign-in.'));
  await page.getByText('Sign-in cancelled.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,ACCOUNT_PATH,'a cancelled sign-in navigates nowhere: '+page.url());
  assert.equal(await storedTarget(),null,'and leaves no stored target behind either');

  // (d) THE SPLASH'S ORDINARY TAB LEAVES FOR THE TARGET instead of settling on the homepage, and the
  //     splash stays the page while the target is resolved - nothing of the homepage flashes behind
  //     it. No frame of that document showed the hero, the mist or the Skip intro button.
  await clearTab();
  await page.goto(origin+'/?app=e-server');
  assert.equal(await storedTarget(),app,'the site root records the app it was asked for too');
  const splashLoads=loads.length;
  await page.goto(origin+'/?signed-in=1');
  await page.locator('#signed-in-splash').waitFor();
  await page.waitForFunction(()=>Array.isArray(window.__frames)&&window.__frames.length>2);
  const during=await page.evaluate(splashState);
  assert.equal(during.splash,true,'the splash is the page while the target is resolved');
  assert.equal(during.attr,'1','and it is still the flag\'s page, never a settled homepage');
  assert.equal(during.hero,false,'with the homepage never shown behind it');
  const flashed=during.frames.filter(frame=>frame.body&&(frame.hero||frame.mist||frame.skip));
  assert.deepEqual(flashed,[],'no frame of the returning tab showed the homepage or the intro: '+JSON.stringify(flashed));
  await page.waitForURL(app,{timeout:20000});
  assert.deepEqual(loads.slice(splashLoads),[origin+'/?signed-in=1',app],'the flagged document and the app it handed the tab to: '+JSON.stringify(loads.slice(splashLoads)));
  await page.goto(origin+'/');
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),RETURN_KEY),null,'the site origin keeps no target after the hand-back: it was consumed');

  // (e) A POPUP CLOSES ITSELF AND NAVIGATES NOWHERE, even holding a target: only an ordinary tab
  //     leaves. The marker is the one site/web-account.mjs puts on the window it opens; a window it
  //     cannot in fact close is the same branch here, and either way it must not be sent to the app.
  await clearTab();
  await page.goto(origin+'/?app=e-server');
  assert.equal(await storedTarget(),app,'a target is stored for this tab');
  await page.evaluate(name=>{window.name=name;},SIGN_IN_WINDOW);
  await page.goto(origin+'/?signed-in=1');
  await page.locator('#signed-in-splash').waitFor();
  await page.locator('#signed-in-splash-fallback').waitFor({timeout:10000});
  await page.waitForTimeout(250);
  assert.equal(page.url(),SITE_ROOT,'the window the site opened for a sign-in is not sent to the app: '+page.url());
  assert.equal(await storedTarget(),app,'and it does not spend the target an ordinary tab would have used');
  await page.evaluate(()=>{window.name='';});

  // (f) A PROVIDER SIGN-IN ON THIS PAGE, which answers in place instead of leaving: the seam saves
  //     the session, the state change is what navigates, and that funnel is signedIn() - so it
  //     resolves the same stored target. The popup it opens is the provider's page, not the return.
  await signedOutPage();
  await page.goto(origin+'/account/?app=e-server');
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).waitFor();
  assert.equal(await storedTarget(),app,'the request is stored for a provider sign-in too');
  const popupOpened=page.waitForEvent('popup');
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).click();
  const providerPopup=await popupOpened;
  await page.waitForURL(app,{timeout:25000});
  assert.equal(page.url(),app,'a provider sign-in leaves for the allow-listed app as well');
  // THE POPUP IS NEVER THE WINDOW THAT GOES. The seam closes the provider window when the poll
  // settles, and this tab's own navigation can outrun that last close - which is the width
  // journey's business, not this section's - so what is asserted here is the rule: the window the
  // site opened for the provider did not follow the target.
  const providerPopupURL=providerPopup.isClosed()?null:providerPopup.url();
  assert.equal(providerPopupURL===null||providerPopupURL.startsWith('https://steamcommunity.com/'),true,'the provider window is not the one that returned to the app: '+JSON.stringify(providerPopupURL));
  await page.goto(origin+'/');
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),RETURN_KEY),null,'and it spent the target on that one visit');

  assert.deepEqual(errors,[]);
  console.log('PASS the return target: ?app=e-server stored in the tab, carried through the Microsoft round trip and spent on exactly one visit to the allow-listed origin with an address carrying nothing appended, ?next accepted only on an easter.company host, a refused and a cancelled sign-in each leaving no target, the splashed ordinary tab leaving for the app with no frame of the homepage behind it, a popup closing itself instead, and a provider sign-in answering in place and leaving for the same app');
  checks++;await context.close();
 }
 // 16. No motion preference: the same busy state, and the spinner actually turns. Reduced motion
 //     was the context above; this is the run that proves the two differ by the rotation alone.
 const moving=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'no-preference'});
 const page=await moving.newPage();
 watcher(page,[]);
 await moving.route(API_ORIGIN+'/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  let status=200,value={};
  if(path==='/v2/oauth/microsoft/exchange'){await new Promise(done=>setTimeout(done,400));value=signed(ACCOUNT);}
  else if(path==='/v2/accounts/providers')value={providers:['microsoft','steam','google']};
  else value={};
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
 const mark=await assertBusy(page,{width:1440,label:'the exchange, no motion preference',sentence:BUSY_SIGN_IN});
 assert.equal(mark.animation,'update-spin','without a motion preference the spinner rotates: '+JSON.stringify(mark));
 await page.waitForURL(SITE_ROOT);
 console.log('PASS the spinner rotates with no motion preference and is a still gold ring under reduced motion, and the success leaves for the site root');
 checks++;await moving.close();
}finally{await browser.close();}
console.log(checks+' responsive account journeys passed; every authority, account and session was a fixture.');
