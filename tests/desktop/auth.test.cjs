const test=require('node:test'),assert=require('node:assert/strict');
const {MicrosoftAuth}=require('../../desktop/auth.cjs');
const profile={id:'1234567890abcdef1234567890abcdef',name:'TestCaptain'};
function fixture(responses){const calls=[];const request=async(url,options)=>{calls.push({url,options});const next=responses.shift();assert(next,'unexpected auth request');return {ok:next.status===undefined||next.status<400,status:next.status||200,json:async()=>next.data};};return {auth:new MicrosoftAuth({clientId:'test-app',request,wait:async()=>{}}),calls};}
const exchange=[{data:{Token:'xbox-token'}},{data:{Token:'xsts-token',DisplayClaims:{xui:[{uhs:'hash',xid:'1234'}]}}},{data:{access_token:'minecraft-secret',expires_in:86400}},{data:profile}];
test('device code, pending, slow down, Xbox and Minecraft profile; only user code reaches UI',async()=>{
 const {auth,calls}=fixture([{data:{device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://microsoft.com/link',expires_in:900,interval:1}},{status:400,data:{error:'authorization_pending'}},{status:400,data:{error:'slow_down'}},{data:{access_token:'ms-secret',refresh_token:'refresh-secret'}},...exchange]);
 const messages=[];const session=await auth.signIn(value=>messages.push(value));
 assert.equal(session.profile.name,'TestCaptain');assert.equal(session.accessToken,'minecraft-secret');assert.equal(session.refreshToken,'refresh-secret');assert.equal(session.clientId,'test-app');
 assert(!JSON.stringify(messages).includes('secret'));assert.equal(messages[0].code,'TEST-CODE');
 assert(calls.some(c=>c.url.includes('xsts')));assert.equal(calls[0].options.body.get('scope'),'XboxLive.signin offline_access');
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
test('missing ownership/profile is refused',async()=>{
 const {auth}=fixture([...exchange.slice(0,3),{status:404,data:{}}]);
 await assert.rejects(auth.exchange({access_token:'private'}),/no Minecraft Java profile/);
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
