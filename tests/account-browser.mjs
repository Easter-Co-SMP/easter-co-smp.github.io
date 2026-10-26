// The account page in a browser: the whole Microsoft sign-in, with a stubbed authority.
//
//   EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18118 node tests/account-browser.mjs
//
// site/ is served statically (python3 -m http.server --directory site 18118) and every request to
// the account API or to Microsoft is answered by a fixture below, so no live service, no real
// Microsoft account and no Company credential is involved. What is proved here is what a player
// sees at each of the three widths: the choices, the signed-in account, a cancelled sign-in, a
// refused one, a replayed one, a callback with no state, and the page's refusal to start a flow
// from any address but its own.
import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import {API_ORIGIN} from '../site/account-client.mjs';
import {REDIRECT_URI} from '../site/account/microsoft-signin.mjs';
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
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
let checks=0;
try{
 for(const width of [1440,834,390]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],calls=[];
  // One stub authority. `exchange` decides what the exchange says, so one journey can be signed
  // in, refused, replayed and told the redirect is not registered without a second server.
  let exchange='ok';
  page.on('pageerror',error=>errors.push(error.message));
  await context.route(API_ORIGIN+'/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   const body=request.postDataJSON?.()??null;
   calls.push({path,method:request.method(),body});
   let status=200,value={};
   if(path==='/v2/oauth/microsoft/start')value={state:STATE,authorizeUrl:'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=fixture&response_type=code&redirect_uri='+encodeURIComponent(REDIRECT_URI)+'&scope=XboxLive.signin+offline_access&state='+STATE+'&code_challenge=fixture-challenge&code_challenge_method=S256',expiresIn:600,redirectUri:REDIRECT_URI};
   else if(path==='/v2/oauth/microsoft/exchange'){
    if(exchange==='ok')value=signed(ACCOUNT);
    else if(exchange==='new-account')value=signed(NEW_ACCOUNT);
    else if(exchange==='replay'){status=401;value={error:'oauth_state_invalid',message:'This sign-in has expired or was already used. Start again.'};}
    else{status=503;value={error:'redirect_uri_not_registered',message:NOT_REGISTERED};}
   }
   else if(path==='/v2/accounts/providers')value={providers:['microsoft','steam','google']};
   else if(path==='/v2/accounts/me')value={account:ACCOUNT};
   else if(path==='/v2/accounts/logout')value={};
   else throw Error('Unexpected API request '+path);
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  // Microsoft's own sign-in page, as a fixture: what matters is that the browser was sent to the
  // authorize address carrying this page's registered redirect, not that Microsoft drew anything.
  await context.route('https://login.microsoftonline.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture Microsoft sign-in</title><p>Fixture authority</p>'}));

  const atAccount=()=>page.goto(origin+'/account/');
  const exchangeCalls=()=>calls.filter(call=>call.path==='/v2/oauth/microsoft/exchange');
  const startCalls=()=>calls.filter(call=>call.path==='/v2/oauth/microsoft/start');
  const noOverflow=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow at '+width+' during '+label);

  // 0. The chooser on any other page sends the browser here and the flow starts on arrival. That
  //    button used to be hidden behind a sentence saying Microsoft was launcher-only; both are
  //    gone, so this asserts the button works: website -> account page -> Microsoft.
  await page.goto(origin+'/');
  await page.getByRole('button',{name:'Sign in or create an Easter Company account',exact:true}).click();
  await page.locator('#desktop-company-signin .company-microsoft').click();
  await page.waitForURL('**/account/?provider=microsoft');
  await page.waitForURL('https://login.microsoftonline.com/**');
  assert.equal(startCalls().length,1,'the chooser Microsoft button starts the browser flow');
  assert.equal(await page.locator('#desktop-company-signin').count(),0,'the account page does not carry the chooser');

  // 1. The page offers Microsoft first, and the other configured providers beside it.
  await atAccount();
  await page.getByRole('heading',{name:'Easter Company account',exact:true}).waitFor();
  const microsoft=page.getByRole('button',{name:'Sign in with Microsoft',exact:true});
  await microsoft.waitFor();
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>Boolean(window.easterDesktop)),false);
  assert.equal(await page.locator('footer.account-footer a[href$="legal/privacy/"]').count(),1);
  await noOverflow('the sign-in choices');

  // 2. Pressing it asks the service to start a flow and sends the browser to Microsoft with this
  //    page's registered redirect in the address. Nothing about a token is sent.
  const startsBefore=startCalls().length;
  await microsoft.click();
  await page.waitForURL('https://login.microsoftonline.com/**');
  assert.equal(startCalls().length,startsBefore+1);
  const lastStart=startCalls().at(-1);
  assert.deepEqual(lastStart.body,{});
  assert.equal(lastStart.method,'POST');
  assert(page.url().includes(encodeURIComponent(REDIRECT_URI)),'the authorize address carries the registered redirect');

  // 3. The callback: the code and the state it arrived with are posted, the Company session is
  //    kept, the account is shown, and the code leaves the address bar.
  exchange='ok';
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
  await page.locator('.account-identity').waitFor();
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

  // 4. A refresh keeps the session, and it is read from the service rather than trusted.
  await page.reload();
  await page.locator('.account-identity').waitFor();
  assert.equal(calls.filter(call=>call.path==='/v2/accounts/me').length,1);

  // 5. Sign out clears it, here and in the tab's storage.
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await noOverflow('the sign-in choices after signing out');

  // 6. A cancelled sign-in is the authority's own shape: error plus description, no code, and no
  //    exchange is attempted.
  const before=exchangeCalls().length;
  await page.goto(origin+'/account/?error=access_denied&error_description='+encodeURIComponent('AADSTS50011: the player cancelled the sign-in.'));
  await page.getByText('Sign-in cancelled.',{exact:true}).waitFor();
  assert.equal(exchangeCalls().length,before,'a refusal has no code to exchange');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await noOverflow('a cancelled sign-in');

  // 7. A refusal the service made is drawn in the service's own words, and the redirect one reads
  //    as "not configured yet" rather than as a broken sign-in.
  exchange='not-registered';
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
  await page.locator('.account-error').filter({hasText:'not registered'}).waitFor();
  const refusal=await page.locator('.account-error').innerText();
  assert(refusal.includes(NOT_REGISTERED),'the service sentence is drawn verbatim: '+refusal);
  assert(refusal.includes('does not accept this sign-in yet'));
  await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await noOverflow('a refusal');

  // 8. A replayed state is refused by the service and reads as start again.
  exchange='replay';
  const beforeReplay=exchangeCalls().length;
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
  await page.getByText('This sign-in has expired or was already used. Start again.',{exact:true}).waitFor();
  assert.equal(exchangeCalls().length,beforeReplay+1);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);

  // 9. A callback with no state is refused before anything is sent.
  exchange='ok';
  const beforeNoState=exchangeCalls().length;
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE));
  await page.getByText('This sign-in has expired or was already used. Start again.',{exact:true}).waitFor();
  assert.equal(exchangeCalls().length,beforeNoState,'no exchange is asked for without a state');

  // 10. The flow belongs to one address. Loaded anywhere else, the page says so and offers no
  //     Microsoft button at all, rather than sending the authority a URI nobody registered.
  const beforeWrong=startCalls().length;
  await page.goto(origin+'/account/index.html');
  await page.getByText('Browser Microsoft sign-in is not configured yet.',{exact:true}).waitFor();
  await page.getByText('Sign in at '+REDIRECT_URI+'.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).count(),0);
  assert.equal(startCalls().length,beforeWrong);
  await noOverflow('the wrong address');

  // 11. A Microsoft account with no Easter Company username yet reaches the existing first-time
  //     setup, exactly as a provider sign-up on this site does: the page does not invent a second
  //     way to claim a name.
  exchange='new-account';
  await page.goto(origin+'/account/?code='+encodeURIComponent(CALLBACK_CODE)+'&state='+STATE);
  await page.locator('#desktop-company-username[open]').waitFor();
  await page.getByRole('heading',{name:'Choose your Easter Company username',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close username setup',exact:true}).click();
  await page.locator('.account-identity').waitFor();
  exchange='ok';

  // 12. Nothing on this path may ask for a Minecraft session, and no Microsoft token is stored.
  const routes=new Set(calls.map(call=>call.path));
  for(const path of routes)assert(['/v2/oauth/microsoft/start','/v2/oauth/microsoft/exchange','/v2/accounts/providers','/v2/accounts/me','/v2/accounts/logout'].includes(path),'unexpected API route '+path);
  // What the tab keeps is one Company session - a token and an expiry - and nothing else: no
  // Microsoft token, no subject, no callback code, and not the account document.
  const stored=await page.evaluate(()=>Object.entries({...sessionStorage}));
  assert.equal(stored.length,1);
  assert.equal(stored[0][0],'easter-company-web-session-v1');
  assert.deepEqual(Object.keys(JSON.parse(stored[0][1])).sort(),['expiresAt','token']);
  assert(!JSON.stringify(stored).toLowerCase().includes('microsoft'));
  assert(!JSON.stringify(stored).includes(CALLBACK_CODE));
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-company-session')),false);
  assert.deepEqual(errors,[]);
  console.log('PASS account page: chooser hand-off, choices, start, callback, session, refresh, sign out, cancelled, not registered, replay, no state, wrong address at '+width);
  checks++;await context.close();
 }
}finally{await browser.close();}
console.log(checks+' responsive account journeys passed; every authority, account and session was a fixture.');
