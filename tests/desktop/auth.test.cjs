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
// diagnoses from; in the sentence they are jargon the player cannot act on. Every sentence
// this file asserts goes through here, so no test can quietly reintroduce one.
const JARGON=/HTTP \d|invalid_[a-z]|unauthorized_[a-z]|XErr|\b[45]\d\d\b/;
const INTERNALS=/(device code|code completion|XSTS|entitlement|provider|scope)/i;
function scanMessage(message,secrets=SECRETS){
 const text=String(message);
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
function fixture(responses,{logPath=path.join(logDir(),'signin.log'),version='9.9.9'}={}){
 const calls=[];
 const request=async(url,options)=>{
  calls.push({url,options});
  const next=responses.shift();
  assert(next,'unexpected auth request: '+url);
  return {ok:next.status===undefined||next.status<400,status:next.status||200,json:async()=>{if(next.unreadable)throw SyntaxError('empty body');return next.data;}};
 };
 const auth=new MicrosoftAuth({clientId:'test-app',request,wait:async()=>{},logPath,version});
 return {auth,calls,file:logPath,log:()=>read(logPath)};
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
 const {auth,calls,file,log}=fixture([
  {data:{device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://microsoft.com/link',expires_in:900,interval:1}},
  {status:400,data:{error:'authorization_pending'}},
  {status:400,data:{error:'slow_down'}},
  {data:{access_token:forXbox,refresh_token:'refresh-secret'}},
  ...chain()
 ]);
 const messages=[];
 const session=await auth.signIn(value=>messages.push(value));
 assert.equal(session.profile.name,'TestCaptain');
 assert.equal(session.accessToken,'minecraft-secret');
 assert.deepEqual(steps(file),['device-code','code-completion','xbox-live','xsts','minecraft','java-profile']);
 assert.equal(failed(file).length,0);
 // Every field the log promises is there, on every line, and the version travels with it.
 for(const line of lines(file)){
  assert.match(line,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z v9\.9\.9 step=[a-z-]+ outcome=(ok|failed) http=(\d{3}|-) code=(\S+)$/,line);
 }
 assert(read(file).endsWith('\n')&&!read(file).includes('\r'),'LF endings, one line each');
 assert.equal(calls[0].options.body.get('scope'),'XboxLive.signin offline_access https://graph.microsoft.com/User.Read');
 // The waiting answers are not step outcomes: they wrote no line at all.
 assert(!read(file).includes('authorization_pending')&&!read(file).includes('slow_down'));
 // The short-lived user code is the only value that reaches the UI.
 assert.equal(messages[0].code,'TEST-CODE');
 assert(!JSON.stringify(messages).includes('device-secret'));
 scanFile(file);
});

test('the Microsoft sign-in steps name themselves and keep the provider code in the log',async()=>{
 // Device code.
 const startRefused=fixture([{status:400,data:{error:'invalid_scope'}}]);
 await refused(startRefused.auth.signIn(()=>{}),/^Microsoft sign-in could not start: the sign-in service refused it\. Try again\.$/);
 assert.equal(lines(startRefused.file).length,1,'a failure is exactly one line');
 assert.deepEqual(steps(startRefused.file),['device-code']);
 assert.match(lines(startRefused.file)[0],/outcome=failed http=400 code=invalid_scope$/);
 scanFile(startRefused.file);
 // Code completion: the poll answer that is not one of the two "keep waiting" answers.
 const completion=fixture([
  {data:{device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://microsoft.com/link',expires_in:900,interval:1}},
  {status:400,data:{error:'invalid_grant'}}
 ]);
 await refused(completion.auth.signIn(()=>{}),/Microsoft sign-in did not finish: your saved sign-in has expired\. Start sign-in again\./);
 assert.deepEqual(steps(completion.file),['device-code','code-completion']);
 assert.equal(failed(completion.file).length,1);
 scanFile(completion.file);
 // An unreadable body still names the step, and says the service would not explain itself;
 // the status it no longer shows is on the line.
 const unreadable=fixture([{status:400,unreadable:true}]);
 await refused(unreadable.auth.signIn(()=>{}),/Microsoft sign-in could not start: the sign-in service refused it without saying why\. Try again\./);
 assert.match(lines(unreadable.file)[0],/outcome=failed http=400 code=400$/);
 scanFile(unreadable.file);
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
 await refused(auth.exchange({access_token:forXbox}),/Xbox Live authorisation did not accept the sign-in: this account needs Microsoft Family approval before Minecraft can connect\. Try again\./);
 assert.deepEqual(steps(file),['xbox-live','xsts']);
 assert.equal(failed(file).length,1);
 assert.match(lines(file)[1],/outcome=failed http=401 code=XErr2148916238$/);
 scanFile(file);
});

test('Minecraft refusals are one sentence each and keep 401, 403, 429 and 5xx apart',async()=>{
 const sentences={};
 for(const [status,data,expected] of [
  [401,{error:'UNAUTHORIZED'},/^Minecraft sign-in failed: Minecraft would not accept the Xbox Live session\. Sign in again\.$/],
  [403,{error:'FORBIDDEN'},/^Minecraft sign-in failed: this account is not allowed to play Minecraft: Java Edition\. Check that this account owns the game\.$/],
  [429,{error:'TOO_MANY_REQUESTS'},/^Minecraft sign-in failed: Minecraft is receiving too many sign-in attempts right now\. Wait a few minutes and try again\.$/],
  [503,{error:'UNAVAILABLE'},/^Minecraft sign-in is temporarily unavailable: Minecraft is not answering right now\. Try again in a few minutes\.$/]
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
 await refused(auth.refresh(stored,undefined,false,true),/Minecraft sign-in failed: Minecraft would not accept the Xbox Live session\. Sign in again\./);
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
 assert.equal(calls[0].options.body.get('scope'),'XboxLive.signin');
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
 await refused(auth.exchange({access_token:'private'}),/Minecraft sign-in failed: this account is not allowed/);
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

test('declined and expired codes stay actionable and are not an error notification elsewhere',async()=>{
 for(const [code,expected] of [['authorization_declined',/the sign-in was cancelled in Microsoft/],['expired_token',/the sign-in code expired before it was used/]]){
  const {auth,file}=fixture([
   {data:{device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://microsoft.com/link',expires_in:600}},
   {status:400,data:{error:code}}
  ]);
  await refused(auth.signIn(()=>{}),expected);
  assert.equal(failed(file).length,1);
  scanFile(file);
 }
});

test('cancellation interrupts waiting without writing a failure',async()=>{
 const controller=new AbortController();
 const {auth,calls,file}=fixture([{data:{device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://microsoft.com/link',expires_in:600}}]);
 auth.wait=async(_ms,_value,{signal})=>{signal.throwIfAborted();};
 await assert.rejects(auth.signIn(()=>controller.abort(),controller.signal),{name:'AbortError'});
 assert.equal(calls.length,1);
 assert.deepEqual(steps(file),['device-code'],'the step that succeeded is recorded');
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

test('the Graph token is asked for on its own scope, is optional, and is never logged',async()=>{
 const {auth,calls,file}=fixture([{data:{access_token:'graph-secret'}}]);
 assert.equal(await auth.graphAccessToken('refresh-secret'),'graph-secret');
 assert.equal(calls[0].options.body.get('scope'),'https://graph.microsoft.com/User.Read');
 assert.equal(calls[0].options.body.get('refresh_token'),'refresh-secret');
 assert.equal(read(file),'','the optional token is not a sign-in step');
 assert.equal(await new MicrosoftAuth({clientId:'test-app',request:async()=>assert.fail('no request without a refresh token')}).graphAccessToken(''),null);
 for(const response of [{status:400,data:{error:'invalid_grant'}},{status:200,data:{}},{status:500,data:{}}]){
  const broken=fixture([response]);
  assert.equal(await broken.auth.graphAccessToken('refresh-secret'),null);
  assert.equal(read(broken.file),'');
 }
 const aborted=fixture([{data:{access_token:'graph-secret'}}]);
 aborted.auth.request=async()=>{throw Object.assign(Error('aborted'),{name:'AbortError'});};
 assert.equal(await aborted.auth.graphAccessToken('refresh-secret'),null);
});

// ---- Sentences, log shape and the bound -----------------------------------------
test('the generic sentence is kept for a step the launcher does not know, and only that',async()=>{
 const unknown=fixture([{status:400,data:{error:'something_new'}}]);
 await assert.rejects(unknown.auth.json('https://example.test/unknown',{},undefined),{message:'Sign-in could not finish. Please try again.'});
 assert.equal(read(unknown.file),'','an unknown step writes no step line');
 // No known step falls back to it: six steps, six different sentences.
 const sentences=new Set();
 for(const [step,response] of [['device-code',{status:400,data:{}}],['code-completion',{status:400,data:{}}],['xbox-live',{status:400,data:{}}],['xsts',{status:400,data:{}}],['minecraft',{status:400,data:{}}],['java-profile',{status:400,data:{}}]]){
  const {auth}=fixture([response]);
  const error=await refused(auth.json('https://example.test/'+step,{},undefined,step),/./);
  assert.notEqual(error.message,'Sign-in could not finish. Please try again.');
  sentences.add(error.message);
 }
 assert.equal(sentences.size,6,'each step has its own sentence');
});

test('a network failure names the step it happened at',async()=>{
 const {auth,file}=fixture([]);
 auth.request=async()=>{throw new TypeError('fetch failed');};
 await refused(auth.exchange({access_token:forXbox}),/^Sign-in stopped while signing in to Xbox Live: the connection failed\. Check your network and try again\.$/);
 assert.deepEqual(steps(file),['xbox-live']);
 assert.match(lines(file)[0],/outcome=failed http=- code=network$/);
 scanFile(file);
});

// ---- What the player reads carries no code, and the log still carries it ----------
// Every failure the launcher can word, for the same reason: the sentence is what a player
// sees and the line is what the owner reads. The status and the provider's code are moved,
// never lost.
const sentenceOf=async(responses,run)=>{
 const {auth,file}=fixture(responses.map(response=>({...response})));
 let caught;
 await assert.rejects(run(auth),error=>{caught=error;return true;});
 scanMessage(caught.message);
 return {message:caught.message,line:lines(file).at(-1)||''};
};
test('no sentence carries a status or a provider code, and the log for that failure still does',async()=>{
 const device={data:{device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://microsoft.com/link',expires_in:900,interval:1}};
 const failures=[
  ['a refused device code',[{status:400,data:{error:'invalid_scope'}}],auth=>auth.signIn(()=>{}),/outcome=failed http=400 code=invalid_scope$/],
  ['a refused completion',[device,{status:400,data:{error:'invalid_grant'}}],auth=>auth.signIn(()=>{}),/outcome=failed http=400 code=invalid_grant$/],
  ['a refused Xbox Live ticket',[{status:401,unreadable:true}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=401$/],
  ['a refusal with a provider code',[{status:401,data:{error:'UNAUTHORIZED'}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=UNAUTHORIZED$/],
  ['a Microsoft Family refusal',[xboxToken(),{status:401,data:{XErr:2148916238}}],auth=>auth.exchange({access_token:forXbox}),/outcome=failed http=401 code=XErr2148916238$/],
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
 for(const [name,responses,run,logged] of failures){
  const {message,line}=await sentenceOf(responses,run);
  assert.doesNotMatch(message,JARGON,name+': '+message);
  assert.doesNotMatch(message,INTERNALS,name+': '+message);
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
 assert.match(mayNotPlay.message,/Check that this account owns the game\.$/);
 assert.match(unavailable.message,/Try again in a few minutes\.$/);
 assert.match(limited.message,/Wait a few minutes and try again\.$/);
 assert.match(offline.message,/Check your network and try again\.$/);
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
 const unwritable=new SignInLog({file:path.join('/proc','nonexistent','signin.log'),version:'1.0.17'});
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
 const refused=await main.call('switch-account','EC-999');
 assert.equal(refused.ok,false);
 const sentence='That account is no longer saved. Use Add account.';
 assert.equal(refused.error,sentence);
 assert.equal(main.sends.at(-1).error,sentence,'the failure is announced by the broadcast that settles it');
 // A read straight afterwards still sees it: the announcement is the operation's last word.
 assert.equal((await main.call('status')).value.error,sentence);
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
