// The account page in a browser: the whole Microsoft sign-in, with a stubbed authority.
//
//   EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18118 node tests/account-browser.mjs
//
// site/ is served statically (python3 -m http.server --directory site 18118) and every request to
// the account API or to Microsoft is answered by a fixture below, so no live service, no real
// Microsoft account and no Company credential is involved. What is proved here is what a player
// sees at each of the three widths: the sign-in options - the same ones the nav's dialog draws,
// from the same module - the busy state while a flow is in flight, the signed-in account, a
// cancelled sign-in, a refused one, a replayed one, a callback with no state, and the page's
// refusal to start a flow from any address but its own.
//
// It also counts DOCUMENT LOADS per step and prints them: a full page load is the cost Owen felt
// after a real sign-in ("too many full page loads", 2026-10-26), and a number is the only way to
// keep it from creeping back. The only unavoidable ones are the authorize redirect to Microsoft
// and Microsoft's return to /account/, which are one contract with the Azure registration.
import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import {API_ORIGIN} from '../site/account-client.mjs';
import {REDIRECT_URI} from '../site/account/microsoft-signin.mjs';
import {SIGN_IN,SIGN_IN_WAIT,PROVIDER_WAIT,PROVIDER_ORDER,providerLabel} from '../site/signin-options.mjs';
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18118';
// A returning player: the Microsoft account already has an Easter Company username, so the
// sign-in lands on the account itself rather than on the first-time setup the launcher and the
// site both run. The new-account shape is its own step at the end, because that is the other
// thing a browser sign-in can produce.
const ACCOUNT={id:42,companyId:'EC-42',username:'fixture_player',minecraftUuid:'01234567-89ab-cdef-0123-456789abcdef',minecraftName:'CaptainFixture',displayName:'CaptainFixture',roles:['member'],createdAt:'2026-10-26T12:00:00+00:00',passwordRequired:false,microsoftLinked:true,microsoftSubject:'a'.repeat(64),providers:['microsoft'],primaryProvider:'microsoft',picture:null,providerDetails:{microsoft:{gamertag:'Fixture Gamer'}}};
const NEW_ACCOUNT={...ACCOUNT,id:43,companyId:'EC-43',username:null,passwordRequired:true};
const SESSION_TOKEN='fixture-company-session-not-a-real-credential';
const signed=account=>({created:true,account,session:{token:SESSION_TOKEN,expiresAt:new Date(Date.now()+3600000).toISOString()},emailStatus:'stored'});
const NOT_REGISTERED='Microsoft does not accept this sign-in yet: the redirect URI is not registered on the Easter Company Microsoft application. Add '+REDIRECT_URI+' as a Web redirect URI in the Azure portal, then try again.';
const STATE='Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5'.slice(0,43).padEnd(43,'a');
const CALLBACK_CODE='M.C523_BAY.2.U.fixture-code';
// The sentences the busy state is allowed to say. One action, one sentence: they are the nav's
// dialog's own (site/signin-options.mjs), so the page adds no words to the product.
const BUSY_SIGN_IN=SIGN_IN_WAIT;
const BUSY_PROVIDER=PROVIDER_WAIT;
const PROVIDER_LABELS=PROVIDER_ORDER.map(providerLabel);
// The steps whose document loads are counted and printed, in journey order. `before` is what the
// same step cost on main (f386139), measured with this same counter: the dialog used to send the
// browser to /account/?provider=microsoft and let that page start the flow, which was one whole
// document load that answered nothing.
const BUDGET=[
 {step:'nav Sign in -> dialog',before:1,after:1},
 {step:'dialog start refused by the service',before:1,after:0},
 {step:'dialog "Sign in with Microsoft" -> Microsoft',before:2,after:1},
 {step:'Microsoft -> /account/ callback with a code',before:1,after:1},
 {step:'/account/ "Sign in with Microsoft" -> Microsoft',before:1,after:1},
 {step:'a refused exchange, re-rendered in place',before:1,after:1},
 {step:'a direct username/password sign-in, re-rendered in place',before:null,after:0},
 {step:'a provider sign-in, re-rendered in place',before:0,after:0},
];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
let checks=0;
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
try{
 for(const width of [1440,834,390]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],calls=[],loads=[],counted={};
  // One stub authority. `exchange` decides what the exchange says and `startRefusal` what the
  // start says, so one journey can be signed in, refused and replayed without a second server.
  // `hold` slows one answer down so the busy state can be read while it is on screen rather than
  // guessed at afterwards.
  let exchange='ok',hold=0,startRefusal=null,password='ok';
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
   else if(path==='/v2/accounts/providers/finish')value=signed(ACCOUNT);
   else if(path==='/v2/accounts/password/login'){
    // The direct Company sign-in this page shares with the dialog. The refusal is the service's
    // own 401, which the seam turns into its own sentence; this suite asserts the page shows it
    // rather than pinning the words, which belong to site/account-client.mjs.
    if(password==='refused'){status=401;value={error:'invalid_credentials'};}
    else value=signed(ACCOUNT);
   }
   else if(path==='/v2/accounts/me')value={account:ACCOUNT};
   else if(path==='/v2/accounts/logout')value={};
   else throw Error('Unexpected API request '+path);
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  // Microsoft's own sign-in page, as a fixture: what matters is that the browser was sent to the
  // authorize address carrying this page's registered redirect, not that Microsoft drew anything.
  await context.route('https://login.microsoftonline.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture Microsoft sign-in</title><p>Fixture authority</p>'}));
  await context.route('https://steamcommunity.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture provider</title><p>Fixture provider complete</p>'}));

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

  // 4. The callback: the code and the state it arrived with are posted, the Company session is
  //    kept, the account is shown, and the code leaves the address bar. While the exchange is in
  //    flight the page is the busy state and nothing else.
  exchange='ok';
  hold=400;
  const callback=await step('Microsoft -> /account/ callback with a code',async()=>{
   await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
   const mark=await assertBusy(page,{width,label:'the exchange',sentence:BUSY_SIGN_IN});
   // Reduced motion is the context this suite runs in: the spinner must still be something - a
   // still gold ring rather than an invisible or empty element.
   assert.equal(mark.animation,'none','reduced motion stops the rotation');
   assert.equal(mark.border,'rgb(228, 196, 134)','and paints the ring solid gold instead: '+JSON.stringify(mark));
   await page.locator('.account-identity').waitFor();
  });
  assert.equal(callback.count,1,'the callback costs one document load: '+JSON.stringify(callback.urls));
  assert.equal(await page.locator('#account-panel').getAttribute('data-busy'),'false','the busy state ends with the flow');
  assert.equal(await page.locator('#account-wait').isVisible(),false,'and the spinner is gone');
  assert.match(await page.locator('.account-identity').innerText(),/^Signed in as/);
  assert.equal((await page.locator('.account-identity strong').textContent()).trim(),'CaptainFixture');
  assert.equal(exchangeCalls().length,1);
  assert.deepEqual(exchangeCalls()[0].body,{code:CALLBACK_CODE,state:STATE,client:'website/1'});
  assert.equal(new URL(page.url()).search,'','the code is not left in the address bar');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')!==null),true);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-company-session')),false);
  assert.equal(await page.getByRole('button',{name:'Play',exact:true}).count(),0);
  await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
  await noOverflow('the signed-in account');

  // 5. A refresh keeps the session, and it is read from the service rather than trusted.
  await page.reload();
  await page.locator('.account-identity').waitFor();
  assert.equal(calls.filter(call=>call.path==='/v2/accounts/me').length,1);

  // 6. Sign out clears it, here and in the tab's storage, and the shared panel comes back.
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  assert.equal(await page.locator('#account-root .company-signin').count(),1,'signing out draws the shared panel again');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await noOverflow('the sign-in choices after signing out');

  // 7. A provider sign-in started here: the page is the busy state and says which flow it waits
  //    on, and the answer is drawn in place - no document load of its own at all.
  const providerStep=await step('a provider sign-in, re-rendered in place',async()=>{
   await page.getByRole('button',{name:'Sign in with Steam',exact:true}).click();
   await assertBusy(page,{width,label:'the provider sign-in',sentence:BUSY_PROVIDER});
   await page.locator('.account-identity').waitFor({timeout:20000});
  });
  assert.equal(providerStep.count,0,'a provider sign-in costs no document load: '+JSON.stringify(providerStep.urls));
  assert.match(await page.locator('.account-identity').innerText(),/^Signed in as/);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();

  // 8. The direct Company sign-in, on this page: the option Owen found missing. It is the same
  //    form the dialog draws, it runs in place - no document load at all - and it is a busy state
  //    while it runs. A refusal ends on this page with the password field cleared.
  await page.locator('#account-root input[name=identifier]').fill('fixture_player');
  await page.locator('#account-root input[name=password]').fill('fixture-passphrase');
  hold=400;
  const direct=await step('a direct username/password sign-in, re-rendered in place',async()=>{
   await page.locator('#account-root button[type=submit]').click();
   await assertBusy(page,{width,label:'the direct sign-in',sentence:BUSY_SIGN_IN});
   await page.locator('.account-identity').waitFor();
  });
  assert.equal(direct.count,0,'the direct sign-in costs no document load: '+JSON.stringify(direct.urls));
  assert.match(await page.locator('.account-identity').innerText(),/^Signed in as/);
  hold=0;
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).waitFor();
  password='refused';
  await page.locator('#account-root input[name=identifier]').fill('fixture_player');
  await page.locator('#account-root input[name=password]').fill('not-the-passphrase');
  await page.locator('#account-root button[type=submit]').click();
  await page.locator('.account-error').waitFor();
  assert.equal(await page.locator('#account-panel').getAttribute('data-busy'),'false','a refusal is not a busy state');
  assert.equal(await page.locator('#account-root input[name=password]').inputValue(),'','the password is not left on screen after a refusal');
  assert.equal(await page.locator('#account-root input[name=identifier]').inputValue(),'fixture_player','and what was typed as the identifier is kept');
  assert.equal(await page.getByRole('button',{name:SIGN_IN.microsoft,exact:true}).isVisible(),true,'the options are drawn beside the refusal');
  password='ok';

  // 9. A cancelled sign-in is the authority's own shape: error plus description, no code, and no
  //    exchange is attempted. Nothing was in flight, so the options are readable beside it.
  const before=exchangeCalls().length;
  await page.goto(origin+'/account/?error=access_denied&error_description='+encodeURIComponent('AADSTS50011: the player cancelled the sign-in.'));
  await page.getByText('Sign-in cancelled.',{exact:true}).waitFor();
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
  assert.equal(exchangeCalls().length,beforeReplay+1);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);

  // 11. A callback with no state is refused before anything is sent, and the page says so in place
  //     rather than bouncing anywhere.
  exchange='ok';
  const beforeNoState=exchangeCalls().length;
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE));
  await page.getByText('This sign-in has expired or was already used. Start again.',{exact:true}).waitFor();
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
  //     way to claim a name.
  exchange='new-account';
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
  await page.locator('#desktop-company-username[open]').waitFor();
  await page.getByRole('heading',{name:'Choose your Easter Company username',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close username setup',exact:true}).click();
  await page.locator('.account-identity').waitFor();
  exchange='ok';

  // 14. Nothing on this path may ask for a Minecraft session, and no Microsoft token is stored.
  const routes=new Set(calls.map(call=>call.path));
  for(const path of routes)assert(['/v2/oauth/microsoft/start','/v2/oauth/microsoft/exchange','/v2/accounts/providers','/v2/accounts/providers/start','/v2/accounts/providers/finish','/v2/accounts/password/login','/v2/accounts/me','/v2/accounts/logout'].includes(path),'unexpected API route '+path);
  // What the tab keeps is one Company session - a token and an expiry - and nothing else: no
  // Microsoft token, no subject, no callback code, and not the account document.
  const stored=await page.evaluate(()=>Object.entries({...sessionStorage}));
  assert.equal(stored.length,1);
  assert.equal(stored[0][0],'easter-company-web-session-v1');
  assert.deepEqual(Object.keys(JSON.parse(stored[0][1])).sort(),['expiresAt','token']);
  assert(!JSON.stringify(stored).toLowerCase().includes('microsoft'));
  assert(!JSON.stringify(stored).includes(CALLBACK_CODE));
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-company-session')),false);

  // 15. The three widths keep their layout: nothing overflows, and every option keeps a
  //     thumb-sized target. Measured rather than looked at, because these are numbers a reviewer
  //     can re-run.
  // The signed-out page is what these three widths are about, and it is asked for explicitly: a
  // saved session is restored by the seam a moment after the first paint, so a check that raced
  // that could measure either answer.
  await page.evaluate(()=>sessionStorage.clear());
  await page.goto(origin+'/account/');
  await page.locator('#account-root .company-signin').waitFor();
  await page.waitForFunction(()=>document.getElementById('account-panel')?.dataset.busy==='false');
  assert.equal(await page.locator('.account-identity').count(),0,'the signed-out options are what these widths measure');
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).waitFor();
  await noOverflow('the final sign-in choices');
  const controlHeights=await page.locator('#account-root .company-signin button, #account-root .company-signin input').evaluateAll(nodes=>nodes.map(node=>({label:(node.textContent||node.name||'').trim(),height:Math.round(node.getBoundingClientRect().height)})));
  for(const control of controlHeights)assert(control.height>=44,'every option is at least 44px tall at '+width+': '+JSON.stringify(control));
  const panelBox=await page.locator('#account-panel').evaluate(node=>{const rect=node.getBoundingClientRect();return {width:Math.round(rect.width),height:Math.round(rect.height),right:Math.round(rect.right)};});
  assert(panelBox.right<=width,'the panel stays inside the viewport at '+width+': '+JSON.stringify(panelBox));

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
  console.log('PASS account page: one shared options panel, one busy state, counted document loads, chooser hand-off, choices, start by pointer and by keyboard, callback, session, refresh, sign out, provider sign-in, cancelled, not registered, replay, no state, wrong address at '+width);
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
 await page.locator('.account-identity').waitFor();
 console.log('PASS the spinner rotates with no motion preference and is a still gold ring under reduced motion');
 checks++;await moving.close();
}finally{await browser.close();}
console.log(checks+' responsive account journeys passed; every authority, account and session was a fixture.');
