const test=require('node:test'),assert=require('node:assert/strict');
const {MicrosoftAuth}=require('../../desktop/auth.cjs');
const profile={id:'1234567890abcdef1234567890abcdef',name:'TestCaptain'};
function fixture(responses){const calls=[];const request=async(url,options)=>{calls.push({url,options});const next=responses.shift();assert(next,'unexpected auth request');return {ok:next.status===undefined||next.status<400,status:next.status||200,json:async()=>next.data};};return {auth:new MicrosoftAuth({clientId:'test-app',request,wait:async()=>{}}),calls};}
const exchange=[{data:{Token:'xbox-token'}},{data:{Token:'xsts-token',DisplayClaims:{xui:[{uhs:'hash',xid:'1234'}]}}},{data:{access_token:'minecraft-secret',expires_in:86400}},{data:{items:[{name:'game_minecraft'},{name:'product_minecraft'}]}},{data:profile}];
test('device code, pending, slow down, Xbox and Minecraft profile; only user code reaches UI',async()=>{
 const {auth,calls}=fixture([{data:{device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://microsoft.com/link',expires_in:900,interval:1}},{status:400,data:{error:'authorization_pending'}},{status:400,data:{error:'slow_down'}},{data:{access_token:'ms-secret',refresh_token:'refresh-secret'}},...exchange]);
 const messages=[];const session=await auth.signIn(value=>messages.push(value));
 assert.equal(session.profile.name,'TestCaptain');assert.equal(session.accessToken,'minecraft-secret');assert.equal(session.refreshToken,'refresh-secret');assert.equal(session.clientId,'test-app');
 assert(!JSON.stringify(messages).includes('secret'));assert.equal(messages[0].code,'TEST-CODE');
 assert(calls.some(c=>c.url.includes('xsts')));assert.equal(calls[0].options.body.get('scope'),'XboxLive.signin offline_access https://graph.microsoft.com/User.Read');
});
test('unexpired session avoids network, expired session rotates refresh token',async()=>{
 const {auth,calls}=fixture([{data:{access_token:'new-ms',refresh_token:'new-refresh'}},...exchange]);
 const saved={expiresAt:Date.now()+600000,refreshToken:'old-refresh'};
 assert.equal(await auth.refresh(saved),saved);assert.equal(calls.length,0);
 const fresh=await auth.refresh({...saved,expiresAt:0});assert.equal(fresh.refreshToken,'new-refresh');assert.equal(calls[0].options.body.get('refresh_token'),'old-refresh');
});
test('Xbox family errors are actionable and never include tokens',async()=>{
 const {auth}=fixture([{data:{Token:'xbox'}},{status:401,data:{XErr:2148916238,Token:'secret'}}]);
 await assert.rejects(auth.exchange({access_token:'private'}),/Microsoft Family/);
});
test('missing Java ownership is a signed-in account, not a failed Microsoft login',async()=>{
 const {auth}=fixture([...exchange.slice(0,3),{data:{items:[]}}]);
 const session=await auth.exchange({access_token:'private',refresh_token:'private-refresh'});
 assert.equal(session.minecraftAccess,'missing');assert.equal(session.profile,null);assert.match(session.accountId,/^msa:[a-f0-9]{64}$/);
});
test('Java entitlement without profile offers setup; subscription entitlement permits play',async()=>{
 const setup=fixture([...exchange.slice(0,3),{data:{items:[{name:'game_minecraft'}]}},{status:404,data:{error:'NOT_FOUND'}}]);
 assert.equal((await setup.auth.exchange({access_token:'private'})).minecraftAccess,'profile-required');
 const pass=fixture([...exchange.slice(0,3),{data:{items:[{name:'game_minecraft'}]}},{data:profile}]);
 assert.equal((await pass.auth.exchange({access_token:'private'})).minecraftAccess,'owned');
});
test('access service failures, invalid JSON shapes and profile failures never imply a purchase',async()=>{
 for(const response of [{status:503,data:{}},{status:401,data:{}},{data:{}},{data:{items:'bad'}},{data:{items:[null]}}]){
  const {auth}=fixture([response]);
  assert.equal((await auth.checkAccess({accessToken:'private'})).minecraftAccess,'unknown');
 }
 const {auth}=fixture([{data:{items:[{name:'game_minecraft'}]}},{status:503,data:{}}]);
 assert.equal((await auth.checkAccess({accessToken:'private'})).minecraftAccess,'unknown');
});
test('recheck after purchase preserves Microsoft identity and avoids another device-code login',async()=>{
 const {auth,calls}=fixture([{data:{items:[]}},{data:{items:[{name:'product_minecraft'}]}},{data:profile}]);
 const signed={accountId:'xbox:1234',xuid:'1234',accessToken:'private',refreshToken:'private-refresh',expiresAt:Date.now()+86400000,profile:null};
 const missing=await auth.refresh(signed,undefined,true);assert.equal(missing.minecraftAccess,'missing');
 const owned=await auth.refresh(missing,undefined,true);assert.equal(owned.minecraftAccess,'owned');assert.equal(owned.accountId,signed.accountId);
 assert.equal(calls.length,3);assert(calls.every(call=>call.url.startsWith('https://api.minecraftservices.com/')));
});
test('Bedrock-only access is not accepted as Java access',async()=>{
 const {auth}=fixture([{data:{items:[{name:'game_minecraft_bedrock'}]}}]);
 assert.equal((await auth.checkAccess({accessToken:'private'})).minecraftAccess,'missing');
});
test('declined and expired device codes produce clear errors',async()=>{
 for(const error of ['authorization_declined','expired_token']){
  const {auth}=fixture([{data:{device_code:'secret',user_code:'TEST',verification_uri:'https://microsoft.com/link',expires_in:600}},{status:400,data:{error}}]);
  await assert.rejects(auth.signIn(()=>{}),error==='expired_token'?/expired/:/cancelled/);
 }
});
test('cancellation interrupts waiting without exchanging a session',async()=>{
 const controller=new AbortController();
 const {auth,calls}=fixture([{data:{device_code:'secret',user_code:'TEST',verification_uri:'https://microsoft.com/link',expires_in:600}}]);
 auth.wait=async(_ms,_value,{signal})=>{signal.throwIfAborted();};
 await assert.rejects(auth.signIn(()=>controller.abort(),controller.signal),{name:'AbortError'});assert.equal(calls.length,1);
});

test('Microsoft account identity remains stable when XSTS omits its optional Xbox ID',async()=>{
 const chain=[{data:{Token:'xbox'}},{data:{Token:'xsts',DisplayClaims:{xui:[{uhs:'stable-user'}]}}},{data:{access_token:'private'}},{data:{items:[]}}];
 const first=fixture([...chain]),second=fixture([...chain]);
 const a=await first.auth.exchange({access_token:'private'}),b=await second.auth.exchange({access_token:'private'});
 assert.equal(a.minecraftAccess,'missing');assert.equal(a.accountId,b.accountId);assert.equal(a.xuid,'0');
 assert.match(a.accountId,/^msa:[a-f0-9]{64}$/);assert(!a.accountId.includes('stable-user'));
});

test('the Graph token is asked for on its own scope and stays out of the session',async()=>{
 const {auth,calls}=fixture([{data:{access_token:'graph-secret'}}]);
 const token=await auth.graphAccessToken('refresh-secret');
 assert.equal(token,'graph-secret');
 assert.equal(calls[0].url,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
 assert.equal(calls[0].options.body.get('scope'),'https://graph.microsoft.com/User.Read');
 assert.equal(calls[0].options.body.get('refresh_token'),'refresh-secret');
 assert.equal(calls[0].options.body.get('grant_type'),'refresh_token');
 const session=await (fixture([{data:{access_token:'ms'},...exchange[0]},...exchange.slice(1)]).auth.exchange({access_token:'private',refresh_token:'private-refresh'}));
 assert(!JSON.stringify(session).includes('graph'),'the Graph token never enters the session');
});

test('a Graph token that cannot be obtained never blocks the sign-in',async()=>{
 // No refresh token at all, a refusal, an unreadable answer and an abort all answer null.
 assert.equal(await new MicrosoftAuth({clientId:'test-app',request:async()=>assert.fail('no request without a refresh token')}).graphAccessToken(''),null);
 for(const response of [{status:400,data:{error:'invalid_grant'}},{status:200,data:{}},{status:500,data:{}}]){
  const {auth}=fixture([response]);
  assert.equal(await auth.graphAccessToken('refresh-secret'),null);
 }
 const broken=fixture([{data:{access_token:'graph-secret'}}]);
 broken.auth.request=async()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});};
 assert.equal(await broken.auth.graphAccessToken('refresh-secret'),null);
});

test('an Xbox refusal of a token for another audience is re-issued once for Xbox Live',async()=>{
 const {auth,calls}=fixture([{status:401,data:{error:'invalid_token'}},{data:{access_token:'xbox-audience-token'}},{data:{Token:'xbox',NotAfter:new Date(Date.now()+86400000).toISOString()}},...exchange.slice(1)]);
 const session=await auth.exchange({access_token:'graph-audience-token',refresh_token:'refresh-secret'});
 assert.equal(session.minecraftAccess,'owned');
 assert.equal(calls[1].options.body.get('scope'),'XboxLive.signin');
 assert.equal(calls[1].options.body.get('refresh_token'),'refresh-secret');
 assert.equal(JSON.parse(calls[2].options.body).Properties.RpsTicket,'d=xbox-audience-token');
 assert(!JSON.stringify(session).includes('xbox-audience-token'),'the re-issued token is used, not stored');
});
