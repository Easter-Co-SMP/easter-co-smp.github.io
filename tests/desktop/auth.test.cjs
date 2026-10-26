const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {MicrosoftAuth,SignInLog}=require('../../desktop/auth.cjs');
const profile={id:'1234567890abcdef1234567890abcdef',name:'TestCaptain'};

// ---- Fixtures -------------------------------------------------------------------
// Every value below is synthetic and is scanned for in both the sentence and the log.
// A fixture answer is `{status, data}`; `unreadable` makes the body fail to parse, which
// is exactly what user.auth.xboxlive.com returns with a refused ticket (HTTP 401, empty).
const SECRETS=['ms-secret','refresh-secret','rotated-refresh-secret','private-refresh','device-secret','TEST-CODE','xbox-scope-secret','xbox-secret','xsts-secret','minecraft-secret','graph-secret','stored-refresh-secret','stored-xbox-user-token','graph-audience-token','xbox-audience-token','captain@example.test'];
const logDir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signin-log-'));
const read=file=>{try{return fs.readFileSync(file,'utf8');}catch{return '';}};
const lines=file=>read(file).split('\n').filter(Boolean);
const steps=file=>lines(file).map(line=>/step=(\S+)/.exec(line)?.[1]);
const failed=file=>lines(file).filter(line=>line.includes('outcome=failed'));
function scanFile(file,secrets=SECRETS){
 const text=read(file);
 for(const secret of secrets)assert(!text.includes(secret),'the sign-in log carries '+secret+':\n'+text);
 assert(!text.includes('@'),'the sign-in log carries no address:\n'+text);
 return text;
}
// The sentence is scanned as well as the file: an address, a credential or the word
// "token" in a message would be scrubbed by main.cjs's safeError() before the player saw
// it, and the point of naming the step is that the player does see it.
// A provider code is not for the player either. The HTTP status, the AAD error string, the
// XErr number and the internal step name belong in userData/signin.log, where the owner
// diagnoses from; in the sentence they are jargon the player cannot act on. The last
// alternative is a bare four-digit-or-longer number, so an XErr number cannot reach a
// sentence even without its "XErr" prefix. Every sentence this file asserts goes through
// here, so no test can quietly reintroduce one.
const JARGON=/HTTP \d|invalid_[a-z]|unauthorized_[a-z]|XErr|\b[45]\d\d\b|\b\d{4,}\b/;
const INTERNALS=/(device code|code completion|XSTS|entitlement|provider|scope)/i;
// The launcher's own loopback address is not jargon and its port is not a provider code: it is
// the address this run asked Microsoft to answer to, which is exactly what a refusal has to
// name. Everything that inspects a sentence looks at it with that address set aside.
const plainly=message=>String(message).replace(/http:\/\/localhost:\d+\/callback/g,'<the launcher’s return address>');
function scanMessage(message,secrets=SECRETS){
 const text=plainly(message);
 for(const secret of secrets)assert(!text.includes(secret),'the sentence carries '+secret+': '+text);
 assert(!text.includes('@'),'the sentence carries no address: '+text);
 assert(!/token|Bearer/i.test(text),'the sentence survives safeError(): '+text);
 assert(!JARGON.test(text),'the sentence carries a status or a provider code: '+text);
 assert(!INTERNALS.test(text),'the sentence carries an internal step name: '+text);
 return text;
}
const refused=async(promise,pattern)=>{
 let caught;
 await assert.rejects(promise,error=>{caught=error;return true;});
 scanMessage(caught.message);
 assert.match(caught.message,pattern);
 return caught;
};
// The authority, stubbed at the queue, with two legs that are not queued because they are the
// thing under test:
//
//   * THE REDIRECT CHECK, which is the two-hop shape MEASURED against the real authority on
//     2026-10-26: a 302 to login.live.com for every redirect URI, and then a page that either is
//     Microsoft's sign-in page (`redirect:'accepted'`, the default) or says in so many words
//     that the redirect URI is not valid (`redirect:'refused'`). Nothing else is ever asked;
//   * THE BROWSER, which `openExternal` stands in for. 'complete' (the default) has Microsoft
//     issue a code and delivers it to the launcher's own loopback listener over a real
//     connection; 'closed' does nothing at all, which is the player shutting the tab; and a
//     function is handed the address so a test can do something else with it.
//
// Everything after that — the token exchange and the Xbox Live chain — is the queue, in order.
const SIGNED_IN_PAGE='<!doctype html><html><head><title>Sign in to your account</title></head><body><div id="lightbox">Microsoft account requires JavaScript to sign in. This web browser either does not support JavaScript, or scripts are being blocked.</div></body></html>';
// The measured refusal, in the authority's own words. On the modern path the same refusal
// arrives as an AADSTS50011 page; both are here because both are real.
const REFUSED_PAGE="<!doctype html><html><body><h2>We're unable to complete your request</h2><p>invalid_request: The provided value for the input parameter 'redirect_uri' is not valid. The expected value is a URI which matches a redirect URI registered for this client application.</p></body></html>";
function fixture(responses,{logPath=path.join(logDir(),'signin.log'),version='9.9.9',browser='complete',redirect='accepted',timeoutMs=5000}={}){
 const calls=[],opened=[],checks=[];
 let issued=0;
 const page=(body,status=200)=>({ok:status<400,status,json:async()=>({}),text:async()=>body,headers:{get:()=>null}});
 const request=async(url,options={})=>{
  const at=new URL(String(url));
  // The two redirect-check hops, and nothing else that is not the authority's own exchange.
  if(at.hostname==='login.live.com'){
   checks.push(String(url));
   return redirect==='refused'?page(REFUSED_PAGE):page(SIGNED_IN_PAGE);
  }
  if(at.hostname==='login.microsoftonline.com'&&at.pathname.endsWith('/oauth2/v2.0/authorize')){
   checks.push(String(url));
   const back='https://login.live.com/oauth20_authorize.srf?client_id=test-app&redirect_uri='+encodeURIComponent(at.searchParams.get('redirect_uri')||'');
   return {ok:false,status:302,json:async()=>({}),text:async()=>'',headers:{get:name=>(String(name).toLowerCase()==='location'?back:null)}};
  }
  calls.push({url,options});
  const next=responses.shift();
  assert(next,'unexpected auth request: '+url);
  return {ok:next.status===undefined||next.status<400,status:next.status||200,json:async()=>{if(next.unreadable)throw SyntaxError('empty body');return next.data;}};
 };
 const openExternal=async url=>{
  opened.push({url:String(url),asked:new URL(url).searchParams.get('redirect_uri')||''});
  if(browser==='closed')return;
  if(typeof browser==='function')return browser(url);
  const query=new URL(url).searchParams;
  issued+=1;
  await fetch(query.get('redirect_uri')+'?code=fixture-code-'+issued+'&state='+encodeURIComponent(query.get('state')||''),{redirect:'manual'});
 };
 const auth=new MicrosoftAuth({clientId:'test-app',request,wait:async()=>{},logPath,version,openExternal,loopbackTimeoutMs:timeoutMs});
 return {auth,calls,opened,checks,file:logPath,log:()=>read(logPath)};
}
// An access token whose own claims prove it was minted for Xbox Live, and one that proves
// it was minted for Graph instead. Neither is a credential: both are unsigned fixtures.
const claim=claims=>['eyJhbGciOiJub25lIn0',Buffer.from(JSON.stringify(claims)).toString('base64url'),'sig'].join('.');
const forXbox=claim({aud:'http://auth.xboxlive.com'});
const forGraph=claim({aud:'https://graph.microsoft.com'});
const xboxToken=()=>({data:{Token:'xbox-secret',NotAfter:new Date(Date.now()+86400000).toISOString()}});
const xstsToken=()=>({data:{Token:'xsts-secret',DisplayClaims:{xui:[{uhs:'hash',xid:'1234'}]}}});
const minecraftToken=()=>({data:{access_token:'minecraft-secret',expires_in:86400}});
const licence=()=>({data:{items:[{name:'game_minecraft'},{name:'product_minecraft'}]}});
const chain=()=>[xboxToken(),xstsToken(),minecraftToken(),licence(),{data:profile}];

// ---- The six steps --------------------------------------------------------------
test('a full sign-in writes one line per step and carries nothing secret into either',async()=>{
 const {auth,calls,authorize,file,log}=fixture([
  {data:{access_token:forXbox,refresh_token:'refresh-secret'}},
  ...chain()
 ]);
 const messages=[];
 const session=await auth.signIn(value=>messages.push(value));
 assert.equal(session.profile.name,'TestCaptain');
 assert.equal(session.accessToken,'minecraft-secret');
 assert.deepEqual(steps(file),['browser-sign-in','code-completion','xbox-live','xsts','minecraft','java-profile']);
 assert.equal(failed(file).length,0);
 // Every field the log promises is there, on every line, and the version travels with it.
 for(const line of lines(file)){
  assert.match(line,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z v9\.9\.9 step=[a-z-]+ outcome=(ok|failed) http=(\d{3}|-) code=(\S+)$/,line);
 }
 assert(read(file).endsWith('\n')&&!read(file).includes('\r'),'LF endings, one line each');
 // One resource per request: the sign-in's scope must never name Microsoft Graph, or
 // Microsoft refuses the exchange with invalid_scope after the player has already
 // approved the sign-in. The Graph token is asked for separately, later.
 assert.equal(calls[0].options.body.get('scope'),'XboxLive.signin offline_access');
 assert(!/graph\.microsoft\.com/i.test(calls[0].options.body.get('scope')));
 // THE HAND-OFF IS GONE. What the UI is told is one flag and nothing else: no code to copy,
 // no address, no expiry. This is the assertion that keeps the deleted step deleted — a
 // payload that grew a `code` back would put the copy back on the screen.
 assert.deepEqual(messages,[{browser:true}],'the sign-in tells the UI the page is open, and nothing more');
 for(const secret of SECRETS)assert(!JSON.stringify(messages).includes(secret),'nothing secret reaches the UI in the hand-off');
 // The code the browser brought back is spent on the exchange and is not kept anywhere.
 assert.equal(calls[0].options.body.get('grant_type'),'authorization_code');
 assert.match(String(calls[0].options.body.get('code_verifier')),/^[-_A-Za-z0-9]{43,128}$/,'the exchange carries the PKCE verifier');
 scanFile(file);
});

test('the redirect URI says localhost on this run’s port, and no request carries a secret',async()=>{
 // The registration holds two loopback redirects — `http://localhost/callback` and
 // `http://localhost` — and only the localhost literal: 127.0.0.1 is NOT registered and would be
 // refused at the token endpoint even though it is the same machine as the socket. The socket
 // binding is asserted in tests/desktop/loopback.test.cjs; this is the other half of that split,
 // on the wire.
 const {auth,opened,calls}=fixture([{data:{access_token:forXbox,refresh_token:'refresh-secret'}},...chain()]);
 await auth.signIn(()=>{});
 const authorize=new URL(opened[0].url);
 const asked=authorize.searchParams.get('redirect_uri');
 assert.match(asked,/^http:\/\/localhost:\d+\/callback$/,'the launcher emits localhost, the /callback path and an ephemeral port: '+asked);
 assert.equal(asked,calls[0].options.body.get('redirect_uri'),'and the exchange echoes that address byte for byte');
 // A public client: there is no secret in this flow, and a path that expected one would be a
 // different registration. Nothing here may name 127.0.0.1 either.
 const scanned=[opened[0].url,...calls.map(call=>call.url+' '+(call.options&&call.options.body?String(call.options.body):''))];
 for(const text of scanned){
  assert.equal(/client_secret|clientsecret/i.test(text),false,'no request carries a secret: '+text.slice(0,140));
  assert.equal(text.includes('127.0.0.1'),false,'no request names 127.0.0.1: '+text.slice(0,140));
 }
 assert.equal(calls[0].options.body.has('client_secret'),false,'the exchange is a public client’s, with no secret field at all');
});

test('the sign-in scope names one resource only',()=>{
 // The 1.0.22-1.0.25 regression: Microsoft Graph rode along in the sign-in scope,
 // Microsoft accepted the request, and the token exchange was then refused with
 // invalid_scope - the player was told the sign-in service refused it after Microsoft had
 // already said yes. One resource per request; the Graph token is separate and optional.
 const source=fs.readFileSync(path.join(__dirname,'../../desktop/auth.cjs'),'utf8');
 const found=source.match(/const SCOPE='([^']+)'/);
 assert.ok(found,'the sign-in scope is a literal');
 assert.equal(found[1],'XboxLive.signin offline_access');
 assert.ok(!/graph\.microsoft\.com/i.test(found[1]),'the sign-in scope may not name Graph');
 // And the authorize request carries that same scope, because the consent is what decides
 // whether the exchange brings a refresh token back at all.
 assert.match(source,/scope:SCOPE,/,'the authorize address asks for it');
 assert.match(source,/const GRAPH_SCOPE='https:\/\/graph\.microsoft\.com\/User\.Read'/);
 // And the Graph token is fetched on its own path, which tolerates every failure.
 assert.match(source,/async graphAccessToken\(refreshToken,signal\)\{/);
 const graph=source.slice(source.indexOf('async graphAccessToken('));
 assert.match(graph.slice(0,600),/return null;/, 'a Graph failure still signs the player in');
});

test('the Microsoft sign-in steps name themselves and keep the provider code in the log',async()=>{
 // A redirect Microsoft will not accept. Measured 2026-10-26: it never says so before the
 // player has signed in, so the two places it can say so are the exchange and the callback —
 // and both must name the exact address this run asked for, so it can be put beside whatever
 // the portal holds. Nothing is asked of the authority in advance.
 const MISMATCH='AADSTS50011: The redirect URI http://localhost:1234/callback specified in the request does not match the redirect URIs configured for the application.';
 const exchange=fixture([{status:400,data:{error:'invalid_grant',error_description:MISMATCH}}]);
 const exchangeRefusal=await refused(exchange.auth.signIn(()=>{}),/Microsoft did not accept the launcher’s return address/);
 assert.equal(exchangeRefusal.code,'redirect_uri_mismatch','a failure with a fix carries the code the owner acts on');
 const askedInExchange=exchange.opened[0].asked;
 assert.match(exchangeRefusal.message,new RegExp(askedInExchange.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'the sentence names the exact address this run asked for: '+exchangeRefusal.message);
 assert.match(exchangeRefusal.message,/Add http:\/\/localhost\/callback as a redirect URI/,'and the form that has to be registered');
 assert.match(lines(exchange.file).at(-1),/step=code-completion outcome=failed http=- code=redirect_uri_mismatch$/,'the log names the failure, not the provider\'s sentence');
 assert.equal(read(exchange.file).includes('AADSTS50011'),false,'and the provider text never reaches the log');
 scanFile(exchange.file);
 // The same problem reported in the browser, which is the other way it arrives.
 const callback=fixture([],{browser:async url=>{
  const query=new URL(url).searchParams;
  await fetch(query.get('redirect_uri')+'?error=invalid_request&error_description='+encodeURIComponent(MISMATCH)+'&state='+encodeURIComponent(query.get('state')||''),{redirect:'manual'});
 }});
 const callbackRefusal=await refused(callback.auth.signIn(()=>{}),/Microsoft did not accept the launcher’s return address/);
 assert.equal(callbackRefusal.code,'redirect_uri_mismatch');
 assert.match(callbackRefusal.message,new RegExp(callback.opened[0].asked.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 scanFile(callback.file);
 // Code completion: the exchange of the code the browser brought back is refused for another
 // reason. A fresh sign-in has nothing saved behind it, so this is not "your saved sign-in has
 // expired".
 const completion=fixture([{status:400,data:{error:'invalid_grant'}}]);
 await refused(completion.auth.signIn(()=>{}),/^Microsoft sign-in did not finish: the sign-in service refused it\. Start sign-in again\.$/);
 assert.deepEqual(steps(completion.file),['browser-sign-in','code-completion']);
 assert.equal(failed(completion.file).length,1);
 assert.match(lines(completion.file)[1],/outcome=failed http=400 code=invalid_grant$/);
 scanFile(completion.file);
 // An unreadable body still names the step, and says the service would not explain itself;
 // the status it no longer shows is on the line.
 const unreadable=fixture([{status:200,unreadable:true}]);
 await refused(unreadable.auth.signIn(()=>{}),/Microsoft sign-in did not finish: the sign-in service refused it without saying why\. Start sign-in again\./);
 assert.match(lines(unreadable.file)[1],/outcome=failed http=200 code=unreadable$/);
 scanFile(unreadable.file);
});

test('a page that says the redirect URI is not valid refuses at once, naming the exact address',async()=>{
 // Measured 2026-10-26: the second hop of the check is where the authority says this, and it is
 // the only answer the launcher acts on. The player is told before a browser opens.
 const {auth,opened,checks,file}=fixture([],{redirect:'refused'});
 const refusal=await refused(auth.signIn(()=>{}),/Microsoft did not accept the launcher’s return address/);
 assert.equal(refusal.code,'redirect_uri_mismatch','the failure carries the code an owner acts on');
 assert.equal(opened.length,0,'no browser is opened for an address Microsoft has already refused');
 const asked=checks.length?'':'';
 assert.equal(checks.length,2,'two hops and no more: '+(checks.length)+' request(s)');
 assert.match(checks[0],/^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/authorize\?/,'the question is asked of the authority itself first');
 assert.match(checks[1],/^https:\/\/login\.live\.com\//,'and read onward only to Microsoft’s own sign-in host');
 assert.match(refusal.message,/Add http:\/\/localhost\/callback as a redirect URI/,'the sentence names the form to register');
 assert.match(refusal.message,/this sign-in asked for http:\/\/localhost:\d+\/callback/,'and the exact address this run asked for');
 assert.deepEqual(steps(file),['code-completion'],'one line, at the step that would have finished the sign-in');
 assert.match(lines(file)[0],/outcome=failed http=- code=redirect_uri_mismatch$/);
 assert.equal(read(file).includes('not valid'),false,'the provider’s own sentence never reaches the log');
 scanFile(file);
});

test('a clean sign-in page proves nothing and never refuses: the browser opens anyway',async()=>{
 // The other half of the measurement, and the reason the check is asymmetric: a page that is
 // simply Microsoft's sign-in page is NOT evidence that the redirect URI is registered. It must
 // never stop a sign-in, and this is the regression that would.
 const {auth,opened,checks}=fixture([{data:{access_token:forXbox,refresh_token:'refresh-secret'}},...chain()]);
 const session=await auth.signIn(()=>{});
 assert.equal(session.profile.name,'TestCaptain','the sign-in completes');
 assert.equal(opened.length,1,'the browser is opened exactly once');
 assert.equal(checks.length,2,'and the check cost two requests, not a retry loop');
 const asked=new URL(opened[0].url).searchParams.get('redirect_uri');
 assert.match(asked,/^http:\/\/localhost:\d+\/callback$/,'the address asked for is the loopback callback on this run’s port: '+asked);
 // And with the authority unreachable while the check runs, the sign-in still goes ahead: a
 // check that cannot read an answer has proven nothing, and proving nothing is not a refusal.
 const offline=fixture([{data:{access_token:forXbox,refresh_token:'refresh-secret'}},...chain()]);
 const answered=offline.auth.request;
 offline.auth.request=(url,options)=>String(url).includes('/oauth2/v2.0/authorize')
  ? Promise.reject(Object.assign(Error('fetch failed'),{name:'TypeError'}))
  : answered(url,options);
 const stillSignedIn=await offline.auth.signIn(()=>{});
 assert.equal(stillSignedIn.profile.name,'TestCaptain','a check that could not reach the authority refuses nothing');
 assert.equal(offline.opened.length,1,'and the browser is still opened');
});

test('the Xbox Live step names itself, including the empty 401 body a refused ticket returns',async()=>{
 const {auth,file}=fixture([{status:401,unreadable:true}]);
 await refused(auth.exchange({access_token:forXbox}),/^Xbox Live did not accept the Microsoft sign-in: the sign-in service refused it without saying why\. Try again\.$/);
 assert.deepEqual(steps(file),['xbox-live']);
 assert.match(lines(file)[0],/outcome=failed http=401 code=401$/);
 scanFile(file);
});

test('the XSTS step names itself and carries XErr in the log, not in the sentence',async()=>{
 const {auth,file}=fixture([xboxToken(),{status:401,data:{XErr:2148916238,Token:'xsts-secret'}}]);
 await refused(auth.exchange({access_token:forXbox}),/Xbox Live authorisation did not accept the sign-in: this account is waiting for Microsoft Family approval\. Ask your Microsoft Family organiser to approve Minecraft for this account, then sign in again\./);
 assert.deepEqual(steps(file),['xbox-live','xsts']);
 assert.equal(failed(file).length,1);
 assert.match(lines(file)[1],/outcome=failed http=401 code=XErr2148916238$/);
 scanFile(file);
});

test('every Xbox Live cause with a fix carries its own instruction, and the number stays in the log',async()=>{
 // "Try again." is advice for a refusal with no known cause. For these it is wrong: the
 // same retry fails the same way until the player does the one thing that fixes it, so
 // each cause says that thing instead of sharing the step's retry.
 const causes=[
  [2148916233,/^Xbox Live authorisation did not accept the sign-in: this Microsoft account does not have an Xbox profile yet\. Create an Xbox profile for this account at xbox\.com, then sign in again\.$/],
  [2148916235,/^Xbox Live authorisation did not accept the sign-in: Xbox Live is not available in this account’s country\. Sign in with a different Microsoft account\.$/],
  [2148916236,/^Xbox Live authorisation did not accept the sign-in: this Microsoft account has not completed its age verification\. Finish the age verification at xbox\.com, then sign in again\.$/],
  [2148916237,/^Xbox Live authorisation did not accept the sign-in: this Microsoft account has not completed its age verification\. Finish the age verification at xbox\.com, then sign in again\.$/],
  [2148916238,/^Xbox Live authorisation did not accept the sign-in: this account is waiting for Microsoft Family approval\. Ask your Microsoft Family organiser to approve Minecraft for this account, then sign in again\.$/]
 ];
 const sentences=new Map();
 for(const [xerr,expected] of causes){
  const {auth,file}=fixture([xboxToken(),{status:401,data:{XErr:xerr}}]);
  const error=await refused(auth.exchange({access_token:forXbox}),expected);
  assert.doesNotMatch(error.message,/Try again\.$/,xerr+' says what to do instead of retrying: '+error.message);
  // The number the player no longer sees is still on the line for whoever diagnoses it.
  assert.deepEqual(steps(file),['xbox-live','xsts']);
  assert.match(lines(file)[1],new RegExp('outcome=failed http=401 code=XErr'+xerr+'$'));
  assert(!error.message.includes(String(xerr)),xerr+' is not in the sentence, even bare: '+error.message);
  scanFile(file);
  sentences.set(xerr,error.message);
 }
 // Four causes, four sentences; the two age-verification numbers word the one thing to
 // finish, so they share theirs rather than splitting it in two.
 assert.equal(new Set(sentences.values()).size,4,'each cause that has a fix reads differently');
 assert.equal(sentences.get(2148916236),sentences.get(2148916237),'age verification is one instruction');
 // The country cause is a property of the account, so the one action it names is a
 // different account. An account's country is not something the launcher can change and
 // usually not something the player can change either, so telling them to sign in "from a
 // country where Xbox Live is available" sent them somewhere that does not exist.
 const country=sentences.get(2148916235);
 assert.match(country,/\. Sign in with a different Microsoft account\.$/,country+' asks for the one thing that clears it: '+country);
 assert.doesNotMatch(country,/country where|change .*country|country .*change/i,'the country cause does not send the player to edit a country: '+country);
 // A number the launcher does not know stays a plain refusal with the step's own advice.
 const unknown=fixture([xboxToken(),{status:401,data:{XErr:2148916299}}]);
 await refused(unknown.auth.exchange({access_token:forXbox}),/^Xbox Live authorisation did not accept the sign-in: Xbox Live refused this sign-in\. Try again\.$/);
 assert.match(lines(unknown.file)[1],/outcome=failed http=401 code=XErr2148916299$/);
 scanFile(unknown.file);
});

test('Minecraft refusals are one sentence each and keep 401, 403, 429 and 5xx apart',async()=>{
 const sentences={};
 for(const [status,data,expected] of [
  [401,{error:'UNAUTHORIZED'},/^Minecraft sign-in failed: the Xbox Live session was not accepted\. Sign in again\.$/],
  [403,{error:'FORBIDDEN'},/^Minecraft sign-in failed: this Microsoft account may not play Minecraft: Java Edition\. If you do own the game, sign in with the Microsoft account you play it with\.$/],
  [429,{error:'TOO_MANY_REQUESTS'},/^Minecraft sign-in failed: there have been too many sign-in attempts in a short time\. Wait a few minutes and try again\.$/],
  [503,{error:'UNAVAILABLE'},/^Minecraft sign-in is temporarily unavailable: the service is not answering right now\. Try again in a few minutes\.$/]
 ]){
  const {auth,file}=fixture([xboxToken(),xstsToken(),{status,data}]);
  await refused(auth.exchange({access_token:forXbox}),expected);
  assert.deepEqual(steps(file),['xbox-live','xsts','minecraft']);
  assert.equal(failed(file).length,1);
  assert.match(lines(file)[2],new RegExp('outcome=failed http='+status+' code='+data.error+'$'));
  sentences[status]=read(file);
  scanFile(file);
 }
 // Four statuses, four different sentences: the distinction is not flattened.
 assert.equal(new Set(Object.values(sentences)).size,4);
});

test('the Java profile step names itself and the state still never claims a purchase',async()=>{
 const outage=fixture([{status:503,data:{}},{status:503,data:{}}]);
 await refused(outage.auth.javaAccess({accessToken:'minecraft-secret'}),/^The Java profile could not be read: the sign-in service is having trouble right now\. Try again\.$/);
 // The state contract is unchanged: an outage is `unknown`, and the log still names the step.
 assert.equal((await outage.auth.checkAccess({accessToken:'minecraft-secret'})).minecraftAccess,'unknown');
 assert.deepEqual(steps(outage.file),['java-profile']);
 assert.equal(failed(outage.file).length,1);
 assert.match(lines(outage.file)[0],/outcome=failed http=503/);
 scanFile(outage.file);
 for(const response of [{data:{}},{data:{items:'bad'}},{data:{items:[null]}}]){
  const {auth}=fixture([response]);
  await refused(auth.javaAccess({accessToken:'minecraft-secret'}),/The Java profile could not be read: the answer did not say which games this account owns/);
  assert.equal((await auth.checkAccess({accessToken:'minecraft-secret'})).minecraftAccess,'unknown');
 }
 const noProfile=fixture([licence(),{status:404,data:{error:'NOT_FOUND'}}]);
 assert.equal((await noProfile.auth.checkAccess({accessToken:'minecraft-secret'})).minecraftAccess,'profile-required');
 assert.match(lines(noProfile.file)[0],/outcome=ok http=200 code=profile-required$/);
 const owned=fixture([licence(),{data:profile}]);
 assert.equal((await owned.auth.checkAccess({accessToken:'minecraft-secret'})).minecraftAccess,'owned');
 assert.match(lines(owned.file)[0],/outcome=ok http=200 code=owned$/);
});

// ---- The route the owner is actually on: the saved session ----------------------
test('the saved-session refresh route is instrumented and never quotes the stored session',async()=>{
 const stored={accountId:'xbox:1234',xuid:'1234',accessToken:'minecraft-secret',refreshToken:'stored-refresh-secret',xboxUserToken:'stored-xbox-user-token',xboxExpiresAt:0,expiresAt:Date.now()+86400000,profile};
 // An opaque token cannot prove its audience, so the Xbox Live scope is minted first; then
 // Minecraft refuses the session exactly as the owner's 1.0.17 launcher saw it.
 const {auth,file,log}=fixture([
  {data:{access_token:'ms-secret',refresh_token:'rotated-refresh-secret'}},
  {data:{access_token:'xbox-scope-secret'}},
  xboxToken(),xstsToken(),
  {status:401,data:{path:'/authentication/login_with_xbox',error:'UNAUTHORIZED'}}
 ]);
 await refused(auth.refresh(stored,undefined,false,true),/Minecraft sign-in failed: the Xbox Live session was not accepted\. Sign in again\./);
 assert.deepEqual(steps(file),['code-completion','xbox-live','xsts','minecraft']);
 assert.equal(failed(file).length,1,'the failing step writes exactly one line');
 assert.match(lines(file)[1],/step=xbox-live outcome=ok http=200 code=ok note=reissued$/);
 // Nothing from the stored session, the renewed session or the Xbox chain is in the log.
 scanFile(file,['stored-refresh-secret','stored-xbox-user-token','rotated-refresh-secret','ms-secret','xbox-scope-secret','xbox-secret','xsts-secret']);
 assert(!log().includes('1234'));
});

// ---- The Xbox Live scope before user.auth.xboxlive.com --------------------------
test('a token proven for Xbox Live is presented as-is, with no extra exchange',async()=>{
 const {auth,calls,file}=fixture(chain());
 await auth.exchange({access_token:forXbox,refresh_token:'refresh-secret'});
 assert.equal(calls[0].url,'https://user.auth.xboxlive.com/user/authenticate','the first leg is Xbox Live itself');
 assert.equal(JSON.parse(calls[0].options.body).Properties.RpsTicket,'d='+forXbox);
 assert.match(lines(file)[0],/step=xbox-live outcome=ok http=200 code=ok$/,'no reissue note when none was needed');
 scanFile(file);
});

test('a token for another audience is exchanged for XboxLive.signin before it is used',async()=>{
 const {auth,calls,file}=fixture([{data:{access_token:'xbox-scope-secret',refresh_token:'rotated-refresh-secret'}},...chain()]);
 const session=await auth.exchange({access_token:forGraph,refresh_token:'refresh-secret'});
 assert.equal(calls[0].url,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
 assert.equal(calls[0].options.body.get('grant_type'),'refresh_token');
 // The reissue SPENDS the refresh token it sends, so it asks for offline_access too: without
 // it Microsoft answers a new access token and no replacement refresh token, and the copy the
 // launcher keeps would be the one this exchange just invalidated (ticket 3027a681, measured
 // against the account service's `outcome=absent`).
 assert.equal(calls[0].options.body.get('scope'),'XboxLive.signin offline_access');
 assert.equal(calls[0].options.body.get('refresh_token'),'refresh-secret');
 assert.equal(calls[1].url,'https://user.auth.xboxlive.com/user/authenticate');
 assert.equal(JSON.parse(calls[1].options.body).Properties.RpsTicket,'d=xbox-scope-secret','the Xbox Live token is what signs in');
 assert.match(lines(file)[0],/step=xbox-live outcome=ok http=200 code=ok note=reissued$/);
 // The reissued token is used, not stored; the rotated refresh token is what is kept.
 assert(!JSON.stringify(session).includes('xbox-scope-secret'));
 assert.equal(session.refreshToken,'rotated-refresh-secret');
 assert.equal(session.minecraftAccess,'owned');
 scanFile(file);
});

test('a refused exchange for the Xbox Live scope is one step failure, not a silent retry',async()=>{
 const {auth,calls,file}=fixture([{status:400,data:{error:'invalid_grant'}}]);
 await refused(auth.exchange({access_token:forGraph,refresh_token:'refresh-secret'}),/^Xbox Live did not accept the Microsoft sign-in: your saved sign-in has expired\. Try again\.$/);
 // The old path swallowed the exchange failure, retried the same leg and rethrew the
 // original: Xbox Live was never even asked this time.
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
 assert.deepEqual(steps(file),['xbox-live']);
 assert.equal(failed(file).length,1);
 assert.match(lines(file)[0],/outcome=failed http=400 code=invalid_grant$/);
 scanFile(file);
});

test('without a refresh token the token in hand is used and the step still names itself',async()=>{
 const {auth,calls,file}=fixture([xboxToken(),xstsToken(),{status:403,data:{error:'FORBIDDEN'}}]);
 await refused(auth.exchange({access_token:'private'}),/Minecraft sign-in failed: this Microsoft account may not play/);
 assert.equal(calls[0].url,'https://user.auth.xboxlive.com/user/authenticate');
 assert.equal(failed(file).length,1);
});

// ---- Retention: the behaviour 1.0.17 already had --------------------------------
test('a successful chain is still owned, missing or profile-required, never invented',async()=>{
 const missing=fixture([xboxToken(),xstsToken(),minecraftToken(),{data:{items:[{name:'game_minecraft_bedrock'}]}}]);
 const session=await missing.auth.exchange({access_token:forXbox});
 assert.equal(session.minecraftAccess,'missing');assert.equal(session.profile,null);
 assert.match(session.accountId,/^msa:[a-f0-9]{64}$/);
 const pass=fixture([xboxToken(),xstsToken(),minecraftToken(),licence(),{data:profile}]);
 assert.equal((await pass.auth.exchange({access_token:forXbox})).minecraftAccess,'owned');
});

test('a refusal on Microsoft’s own page and a page that never came back are told apart',async()=>{
 // The player pressed Cancel on Microsoft's page: Microsoft says so, with this sign-in's state,
 // and it is the cancellation sentence this launcher has always used for it.
 const declined=fixture([],{browser:async url=>{
  const query=new URL(url).searchParams;
  await fetch(query.get('redirect_uri')+'?error=access_denied&state='+encodeURIComponent(query.get('state')||''),{redirect:'manual'});
 }});
 const cancelled=await refused(declined.auth.signIn(()=>{}),/the sign-in was cancelled in Microsoft/);
 assert.equal(cancelled.code,'authorization_declined');
 assert.equal(failed(declined.file).length,1);
 scanFile(declined.file);
 // The browser was closed, or Microsoft refused the page and never called back: the wait runs
 // out. The sentence names what to do about it, including the registration to check, because
 // from here those two look identical.
 const closed=fixture([],{browser:'closed',timeoutMs:60});
 const expired=await refused(closed.auth.signIn(()=>{}),/the Microsoft sign-in page was not completed/);
 assert.equal(expired.code,'expired_token');
 assert.match(expired.message,/add http:\/\/localhost\/callback as a redirect URI/,'the timeout names the registration to check');
 assert.equal(failed(closed.file).length,1);
 assert.match(lines(closed.file).at(-1),/step=code-completion outcome=failed http=- code=expired_token$/);
 scanFile(closed.file);
 // Not a half-state: nothing was exchanged, so no token exists and no session was made.
 assert.equal(closed.calls.length,0,'a sign-in that never came back asked Microsoft for nothing');
});

test('cancellation interrupts the wait without writing a failure, and closes the socket',async()=>{
 const controller=new AbortController();
 const {auth,calls,file}=fixture([],{browser:'closed',timeoutMs:30000});
 const opened=[];
 // The player presses Cancel: the abort arrives while the launcher is waiting on its socket.
 const failing=reason=>{opened.push(reason);};
 const run=auth.signIn(failing,controller.signal);
 setTimeout(()=>controller.abort(),20);
 await assert.rejects(run,{name:'AbortError'});
 assert.equal(calls.length,0,'no token was asked for after a cancel');
 assert.deepEqual(steps(file),['browser-sign-in'],'the step that succeeded is recorded');
 assert.equal(failed(file).length,0,'cancellation is not a step failure');
 scanFile(file);
});

test('an unexpired session avoids the network and a stale one rotates its refresh token',async()=>{
 const {auth,calls,file}=fixture([{data:{access_token:forXbox,refresh_token:'rotated-refresh-secret'}},...chain()]);
 const saved={expiresAt:Date.now()+600000,refreshToken:'refresh-secret'};
 assert.equal(await auth.refresh(saved),saved);assert.equal(calls.length,0);assert.equal(read(file),'');
 const fresh=await auth.refresh({...saved,expiresAt:0});
 assert.equal(fresh.refreshToken,'rotated-refresh-secret');
 assert.equal(calls[0].options.body.get('refresh_token'),'refresh-secret');
 scanFile(file);
});

test('a recheck after purchase preserves the Microsoft identity without another sign-in',async()=>{
 const {auth,calls}=fixture([{data:{items:[]}},{data:{items:[{name:'product_minecraft'}]}},{data:profile}]);
 const signed={accountId:'xbox:1234',xuid:'1234',accessToken:'minecraft-secret',refreshToken:'refresh-secret',expiresAt:Date.now()+86400000,profile:null};
 const missing=await auth.refresh(signed,undefined,true);assert.equal(missing.minecraftAccess,'missing');
 const owned=await auth.refresh(missing,undefined,true);assert.equal(owned.minecraftAccess,'owned');assert.equal(owned.accountId,signed.accountId);
 assert.equal(calls.length,3);assert(calls.every(call=>call.url.startsWith('https://api.minecraftservices.com/')));
});

test('the Microsoft identity survives an XSTS answer with no optional Xbox ID',async()=>{
 const terminal=[{data:{Token:'xsts-secret',DisplayClaims:{xui:[{uhs:'stable-user'}]}}},minecraftToken(),{data:{items:[]}}];
 const first=fixture([xboxToken(),...terminal]),second=fixture([xboxToken(),...terminal]);
 const a=await first.auth.exchange({access_token:forXbox}),b=await second.auth.exchange({access_token:forXbox});
 assert.equal(a.xuid,'0');assert.equal(a.accountId,b.accountId);
 assert.match(a.accountId,/^msa:[a-f0-9]{64}$/);assert(!a.accountId.includes('stable-user'));
});

test('the Graph token is asked for on its own scope, is optional, and records one line',async()=>{
 // 1.0.31 asked for this token and logged nothing at all when it failed, which is how the
 // owner ended up with an account that had no email address and no way to find out why.
 // The leg still never fails a sign-in; it now says what happened in one whitelisted line.
 const {auth,calls,file}=fixture([{data:{access_token:'graph-secret'}}]);
 // It answers both tokens: this grant spends the refresh token it is given, so the answer's
 // own `refresh_token` is the only live copy left (ticket 3027a681). A grant with no
 // successor answers null for it — never the spent copy it was sent.
 assert.deepEqual(await auth.graphAccessToken('refresh-secret'),{accessToken:'graph-secret',refreshToken:null});
 assert.equal(calls[0].options.body.get('scope'),'https://graph.microsoft.com/User.Read offline_access');
 assert.equal(calls[0].options.body.get('refresh_token'),'refresh-secret');
 assert.match(read(file),/step=email outcome=ok http=200/);
 assert(!read(file).includes('graph-secret'),'the token is never written');
 const rotated=fixture([{data:{access_token:'graph-secret',refresh_token:'graph-refresh-successor'}}]);
 assert.deepEqual(await rotated.auth.graphAccessToken('refresh-secret'),{accessToken:'graph-secret',refreshToken:'graph-refresh-successor'},'the successor is what the caller keeps');
 assert(!read(rotated.file).includes('graph-refresh-successor'),'and it is never written either');
 assert.equal(await new MicrosoftAuth({clientId:'test-app',request:async()=>assert.fail('no request without a refresh token')}).graphAccessToken(''),null);
 for(const [response,pattern] of [[{status:400,data:{error:'invalid_grant'}},/step=email outcome=failed http=400/],[{status:200,data:{}},/step=email outcome=failed/],[{status:500,data:{}},/step=email outcome=failed http=500/]]){
  const broken=fixture([response]);
  assert.equal(await broken.auth.graphAccessToken('refresh-secret'),null);
  assert.match(read(broken.file),pattern);
 }
 const aborted=fixture([{data:{access_token:'graph-secret'}}]);
 aborted.auth.request=async()=>{throw Object.assign(Error('aborted'),{name:'AbortError'});};
 assert.equal(await aborted.auth.graphAccessToken('refresh-secret'),null);
 assert.equal(read(aborted.file),'','a cancelled sign-in writes nothing');
});

// ---- Sentences, log shape and the bound -----------------------------------------
test('the generic sentence is kept for a step the launcher does not know, and only that',async()=>{
 const unknown=fixture([{status:400,data:{error:'something_new'}}]);
 await assert.rejects(unknown.auth.json('https://example.test/unknown',{},undefined),{message:'Sign-in could not finish. Please try again.'});
 assert.equal(read(unknown.file),'','an unknown step writes no step line');
 // No known step falls back to it: six steps, six different sentences.
 const sentences=new Set();
 for(const [step,response] of [['browser-sign-in',{status:400,data:{}}],['code-completion',{status:400,data:{}}],['xbox-live',{status:400,data:{}}],['xsts',{status:400,data:{}}],['minecraft',{status:400,data:{}}],['java-profile',{status:400,data:{}}]]){
  const {auth}=fixture([response]);
  const error=await refused(auth.json('https://example.test/'+step,{},undefined,step),/./);
  assert.notEqual(error.message,'Sign-in could not finish. Please try again.');
  sentences.add(error.message);
 }
 assert.equal(sentences.size,6,'each step has its own sentence');
});

test('a network failure names the step it happened at, and every step reads the same way',async()=>{
 // The step the player was on when the connection failed. It leads like every other
 // sentence and says what could not be reached, rather than opening its own way and
 // saying the verb twice ("Sign-in stopped while signing in to Xbox Live").
 const {auth,file}=fixture([]);
 auth.request=async()=>{throw new TypeError('fetch failed');};
 await refused(auth.exchange({access_token:forXbox}),/^Minecraft sign-in failed: the launcher could not reach Xbox Live\. Check your connection and try again\.$/);
 assert.deepEqual(steps(file),['xbox-live']);
 assert.match(lines(file)[0],/outcome=failed http=- code=network$/);
 scanFile(file);
 // All six steps share that shape, name their own step, and stay distinct from each other.
 const sentences=new Map();
 for(const [step,reached] of [
  ['browser-sign-in',/could not reach the Microsoft sign-in page\./],
  ['code-completion',/could not reach Microsoft to finish the sign-in\./],
  ['xbox-live',/could not reach Xbox Live\./],
  ['xsts',/could not reach Xbox Live to authorise the sign-in\./],
  ['minecraft',/could not reach the Minecraft service\./],
  ['java-profile',/could not reach the Java profile service\./]
 ]){
  const offline=fixture([]);
  offline.auth.request=async()=>{throw new TypeError('fetch failed');};
  let caught;
  await assert.rejects(offline.auth.json('https://example.test/'+step,{},undefined,step),error=>{caught=error;return true;});
  scanMessage(caught.message);
  assert.match(caught.message,/^Minecraft sign-in failed: the launcher could not reach /,step+': '+caught.message);
  assert.match(caught.message,reached,step+' names its own step: '+caught.message);
  assert.match(caught.message,/\. Check your connection and try again\.$/,step+' gives the same instruction: '+caught.message);
  assert.doesNotMatch(caught.message,/Sign-in stopped while|while signing in/i,step+' does not repeat the verb: '+caught.message);
  assert.match(lines(offline.file)[0],/outcome=failed http=- code=network$/,step+' still writes its one line');
  assert.equal(read(offline.file).includes('fetch failed'),false,'the failure itself is not written out');
  sentences.set(step,caught.message);
 }
 assert.equal(new Set(sentences.values()).size,6,'six steps, six sentences');
 assert.notEqual(sentences.get('xbox-live'),'Sign-in could not finish. Please try again.','and none is the unknown-step fallback');
});

// ---- What the player reads carries no code, and the log still carries it ----------
// Every failure the launcher can word, for the same reason: the sentence is what a player
// sees and the line is what the owner reads. The status and the provider's code are moved,
// never lost.
const sentenceOf=async(responses,run,options={})=>{
 const {auth,file}=fixture(responses.map(response=>({...response})),options);
 let caught;
 await assert.rejects(run(auth),error=>{caught=error;return true;});
 scanMessage(caught.message);
 return {message:caught.message,line:lines(file).at(-1)||''};
};
test('no sentence carries a status or a provider code, and the log for that failure still does',async()=>{
 const failures=[
  // The two halves of a browser sign-in that Microsoft itself refuses: a redirect URI the app
  // will not accept (the sentence names the exact address this run asked for) and the exchange
  // of the code the browser brought back for any other reason.
  ['a refused return address',[{status:400,data:{error:'invalid_request',error_description:'AADSTS50011: The provided value for the input parameter redirect_uri does not match the redirect URIs configured for the application.'}}],auth=>auth.signIn(()=>{}),/outcome=failed http=- code=redirect_uri_mismatch$/],
  ['a refused completion',[{status:400,data:{error:'invalid_grant'}}],auth=>auth.signIn(()=>{}),/outcome=failed http=400 code=invalid_grant$/],
  ['a refused Xbox Live ticket',[{status:401,unreadable:true}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=401$/],
  ['a refusal with a provider code',[{status:401,data:{error:'UNAUTHORIZED'}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=UNAUTHORIZED$/],
  ['a Microsoft Family refusal',[xboxToken(),{status:401,data:{XErr:2148916238}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=XErr2148916238$/],
  // Every other Xbox Live cause a player can act on, each with its own advice and its own
  // number on the line. Age verification has two numbers for one cause, so it appears once.
  ['an account with no Xbox profile',[xboxToken(),{status:401,data:{XErr:2148916233}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=XErr2148916233$/],
  ['a country Xbox Live does not serve',[xboxToken(),{status:401,data:{XErr:2148916235}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=XErr2148916235$/],
  ['an unverified age',[xboxToken(),{status:401,data:{XErr:2148916236}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=XErr2148916236$/],
  ['a refused Minecraft session',[xboxToken(),xstsToken(),{status:401,data:{error:'UNAUTHORIZED'}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=UNAUTHORIZED$/],
  ['an account that may not play',[xboxToken(),xstsToken(),{status:403,data:{error:'FORBIDDEN'}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=403 code=FORBIDDEN$/],
  ['rate limiting',[xboxToken(),xstsToken(),{status:429,data:{error:'TOO_MANY_REQUESTS'}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=429 code=TOO_MANY_REQUESTS$/],
  ['an unavailable Minecraft',[xboxToken(),xstsToken(),{status:503,data:{error:'UNAVAILABLE'}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=503 code=UNAVAILABLE$/],
  // The Java legs word the sentence themselves but checkAccess writes their one line, and
  // it turns the failure into `unknown` rather than rethrowing: the log is read after it.
  ['an unreadable Java profile',[{status:503,data:{}},{status:503,data:{}}],async auth=>{try{await auth.javaAccess({accessToken:'minecraft-secret'});}catch(error){assert.equal((await auth.checkAccess({accessToken:'minecraft-secret'})).minecraftAccess,'unknown');throw error;}},/outcome=failed http=503 code=503$/],
  ['a refused Xbox Live scope',[{status:400,data:{error:'invalid_grant'}}],auth=>auth.exchange({access_token:forGraph,refresh_token:'refresh-secret'}),/outcome=failed http=400 code=invalid_grant$/]
 ];
 const seen=new Map();
 for(const [name,responses,run,logged,options] of failures){
  const {message,line}=await sentenceOf(responses,run,options);
  assert.doesNotMatch(plainly(message),JARGON,name+': '+message);
  assert.doesNotMatch(plainly(message),INTERNALS,name+': '+message);
  assert.match(line,logged,name+' kept its status and code in the log: '+line);
  assert.match(line,/http=(\d{3}|-) code=\S+$/,name+': the line still carries both fields: '+line);
  assert(!seen.has(message),name+' reads the same as '+seen.get(message)+': '+message);
  seen.set(message,name);
 }
 assert.equal(seen.size,failures.length,'every failure in the table has its own sentence');
});

test('the five causes a player can tell apart still read differently, and each says what to do',async()=>{
 const refusedSession=await sentenceOf([xboxToken(),xstsToken(),{status:401,data:{error:'UNAUTHORIZED'}}],auth=>auth.exchange({access_token:forXbox}));
 const mayNotPlay=await sentenceOf([xboxToken(),xstsToken(),{status:403,data:{error:'FORBIDDEN'}}],auth=>auth.exchange({access_token:forXbox}));
 const unavailable=await sentenceOf([xboxToken(),xstsToken(),{status:503,data:{error:'UNAVAILABLE'}}],auth=>auth.exchange({access_token:forXbox}));
 const limited=await sentenceOf([xboxToken(),xstsToken(),{status:429,data:{error:'TOO_MANY_REQUESTS'}}],auth=>auth.exchange({access_token:forXbox}));
 const offline=await (async()=>{
  const {auth,file}=fixture([]);
  auth.request=async()=>{throw new TypeError('fetch failed');};
  let caught;
  await assert.rejects(auth.exchange({access_token:forXbox}),error=>{caught=error;return true;});
  scanMessage(caught.message);
  return {message:caught.message,line:lines(file).at(-1)};
 })();
 const causes={refusedSession,mayNotPlay,unavailable,limited,offline};
 assert.equal(new Set(Object.values(causes).map(cause=>cause.message)).size,5,'five causes, five sentences');
 // And every one of them tells the player something they can act on.
 assert.match(refusedSession.message,/Sign in again\.$/);
 assert.match(mayNotPlay.message,/If you do own the game, sign in with the Microsoft account you play it with\.$/);
 assert.match(unavailable.message,/Try again in a few minutes\.$/);
 assert.match(limited.message,/Wait a few minutes and try again\.$/);
 assert.match(offline.message,/Check your connection and try again\.$/);
 // The log is where the four answers are still told apart, for whoever diagnoses later.
 assert.match(refusedSession.line,/http=401 code=UNAUTHORIZED$/);
 assert.match(mayNotPlay.line,/http=403 code=FORBIDDEN$/);
 assert.match(unavailable.line,/http=503 code=UNAVAILABLE$/);
 assert.match(limited.line,/http=429 code=TOO_MANY_REQUESTS$/);
 assert.match(offline.line,/http=- code=network$/);
});

test('the log is bounded by one rotation however often it is written',async()=>{
 const file=path.join(logDir(),'signin.log');
 const log=new SignInLog({file,version:'1.0.17',maxBytes:300,now:()=>new Date('2026-10-18T04:52:31.123Z')});
 for(let index=0;index<200;index++)log.append({step:'xsts',outcome:'failed',status:400,code:'XErr2148916238'});
 assert(fs.statSync(file).size<=300,'the live file never exceeds its cap');
 const rotated=fs.statSync(file+'.1');
 assert(rotated.size<=300,'and neither does the one rotation it keeps');
 assert(!fs.existsSync(file+'.2'),'rotation is a single file, not an ever-growing set');
 assert.equal(fs.readFileSync(file,'utf8').split('\n')[0],'2026-10-18T04:52:31.123Z v1.0.17 step=xsts outcome=failed http=400 code=XErr2148916238');
 // A log file that cannot be written never breaks a sign-in.
 // A regular file as the parent fails with ENOTDIR on every platform, even as root.
 // Avoid special filesystems: Node 24 can spin inside recursive mkdir on /proc.
 const blockedParent=path.join(logDir(),'not-a-directory');
 fs.writeFileSync(blockedParent,'fixture');
 const unwritable=new SignInLog({file:path.join(blockedParent,'signin.log'),version:'1.0.17'});
 assert.doesNotThrow(()=>{unwritable.append({step:'xsts',outcome:'failed',status:400,code:'x'});unwritable.append({step:'xsts',outcome:'ok',status:200,code:'ok'});});
});

// ---- state.error is announced once ---------------------------------------------
// The main process itself, with Electron stubbed: this is the rule the owner's report
// points at — a stale sentence in the state is repainted by every later broadcast.
function loadMainProcess(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'launcher-state-'));
 const sends=[],handlers=new Map();
 const app={
  setName(){},setAppUserModelId(){},setPath(){},isPackaged:false,
  getPath(name){return name==='desktop'?path.join(root,'Desktop'):name==='appData'?root:root;},
  requestSingleInstanceLock(){return true;},quit(){},on(){},whenReady(){return Promise.resolve();}
 };
 class BrowserWindow{
  constructor(){
   this.webContents={send(channel,state){sends.push(JSON.parse(JSON.stringify(state)));},session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},setWindowOpenHandler(){},on(){}};
  }
  once(){}on(){}loadURL(){}show(){}isDestroyed(){return false;}
  static getAllWindows(){return [];}
 }
 const electron={
  app,BrowserWindow,
  protocol:{registerSchemesAsPrivileged(){},handle(){}},
  net:{fetch:async()=>{throw Error('offline');}},
  ipcMain:{handle(name,fn){handlers.set(name,fn);}},
  shell:{openExternal:async()=>{},openPath:async()=>''},
  safeStorage:{isEncryptionAvailable:()=>false,getSelectedStorageBackend:()=>'basic_text',encryptString:()=>{throw Error('unavailable');},decryptString:()=>{throw Error('unavailable');}},
  dialog:{showOpenDialog:async()=>({canceled:true,filePaths:[]})},
  screen:{getPrimaryDisplay:()=>({size:{width:1920,height:1080},scaleFactor:1})},
  Tray:class{constructor(){}destroy(){}setToolTip(){}setContextMenu(){}on(){}},
  Menu:{buildFromTemplate:()=>null}
 };
 const load=Module._load;
 Module._load=function(request,parent,isMain){if(request==='electron')return electron;return load.call(this,request,parent,isMain);};
 try{require('../../desktop/main.cjs');}
 catch(error){Module._load=load;throw error;}
 // The hook stays installed: main.cjs reaches for electron lazily in shortcuts.cjs.
 const frame={url:'easter://easter/index.html'};
 const event={sender:{mainFrame:frame},senderFrame:frame};
 // The registered wrapper answers {ok,value} or {ok,error} itself; a request from an
 // untrusted frame is the only path that throws.
 const call=async(name,...args)=>{
  const handler=handlers.get('launcher:'+name);
  assert(handler,'the launcher registered no '+name+' handler');
  try{return await handler(event,...args);}
  catch(error){return {ok:false,error:error?.message};}
 };
 return {root,sends,call,ready:()=>Boolean(handlers.size)&&sends.length>0};
}
test('state.error is announced once and no later broadcast can repaint it',async()=>{
 const main=loadMainProcess();
 const deadline=Date.now()+60000;
 while(!main.ready()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
 assert(main.ready(),'the launcher finished starting up');
 assert.equal(main.sends[0].error,null,'a first broadcast carries no failure');
 // A failing account action: an account that is not saved is refused before any network.
 const refused=await main.call('provider-sign-in','invalid-fixture-provider');
 assert.equal(refused.ok,false);
 const sentence='Choose a sign-in provider.';
 assert.equal(refused.error,sentence);
 assert.equal(main.sends.filter(state=>state.error===sentence).length,1,'the account failure is announced once before operation teardown');
 assert.equal((await main.call('status')).value.error,null,'account teardown clears the announcement');
 // Any later broadcast drops it — including the ones that carry a message of their own...
 await main.call('sign-out');
 assert.equal(main.sends.at(-1).error,null,'an unrelated broadcast cannot repaint the old failure');
 assert.equal((await main.call('status')).value.error,null,'and it is gone from the state, not just from one frame');
 // ...and the ones that carry no message at all: this action settles its own failure and
 // then broadcasts its teardown, and the state is left clean either way.
 const second=await main.call('continue-microsoft');
 assert.equal(second.ok,false);
 assert.equal(second.error,'Sign in with Microsoft to continue.');
 assert.equal(main.sends.filter(state=>state.error===second.error).length,1,'this failure is announced once too');
 for(const state of main.sends.slice(-2))assert.notEqual(state.error,sentence,'no later frame repaints the old one');
 assert.equal((await main.call('status')).value.error,null,'the state ends with no failure in it');
 // Across the whole run the first sentence was announced exactly once.
 assert.equal(main.sends.filter(state=>state.error===sentence).length,1,'one announcement, never a repaint');
});


test('the stages a browser sign-in announces are the same four, and carry no provider payload',async()=>{
 const {auth}=fixture([
  {data:{access_token:forXbox,refresh_token:'refresh-secret'}},...chain()
 ]);
 const stages=[];await auth.signIn(()=>{},undefined,stage=>stages.push(stage));
 assert.deepEqual(stages,['microsoft-opening','microsoft-waiting','microsoft-verifying','java-checking'],'the stages the launcher paints are unchanged by the flow that feeds them');
 for(const secret of SECRETS)assert(!JSON.stringify(stages).includes(secret));
});

test('a valid saved session checking Java access announces only the access step',async()=>{
 const {auth}=fixture([licence(),{data:profile}]);const stages=[];
 await auth.refresh({accessToken:'stored-access',expiresAt:Date.now()+86400000},undefined,true,false,stage=>stages.push(stage));
 assert.deepEqual(stages,['java-checking']);
});
