const test=require('node:test'),assert=require('node:assert/strict');
const {startStub,send,client,rejects,ACCOUNT}=require('./fixtures.cjs');
const TOKEN='mojang-access-token-private';
const SESSION='easter-session-token-private';
function loginBody(created){return {created,account:ACCOUNT,session:{token:SESSION,expiresAt:'2026-02-01T00:00:00Z'}};}
const loginRoute=created=>({request,response})=>send(response,200,loginBody(created));

test('an unreachable API fails fast and says nothing about the cause',async()=>{
 const stub=await startStub(()=>{});
 const origin=stub.origin;await stub.close();
 const error=await rejects(assert,client(origin,{timeout:2000}).login(TOKEN),'unreachable');
 assert.equal(error.message,'The Easter Company account service could not be reached.');
 assert(!JSON.stringify({message:error.message,name:error.name}).includes(TOKEN));
});

test('401 invalid_minecraft_token is actionable and leaks neither token nor body',async()=>{
 const stub=await startStub(({response})=>send(response,401,{error:'invalid_minecraft_token',detail:'Mojang said no for '+TOKEN}));
 try{
  const error=await rejects(assert,client(stub.origin).login(TOKEN),'invalid_minecraft_token');
  assert.match(error.message,/Minecraft did not accept/);
  const surface=JSON.stringify({message:error.message,code:error.code,name:error.name,stack:String(error.stack)});
  assert(!surface.includes(TOKEN),'the Mojang token must never reach an error');
  assert(!surface.includes(SESSION));
  assert(!surface.includes('Mojang said no'),'the API body must never reach an error');
 }finally{await stub.close();}
});

test('a malformed success body is refused instead of trusted',async()=>{
 const bodies=[{created:false,account:ACCOUNT},{created:false,account:ACCOUNT,session:{token:'',expiresAt:'2026-02-01T00:00:00Z'}},{created:false,account:{...ACCOUNT,minecraftUuid:'not-a-uuid'},session:{token:SESSION,expiresAt:'2026-02-01T00:00:00Z'}},{created:false,account:ACCOUNT,session:{token:SESSION,expiresAt:'whenever'}}];
 for(const body of bodies){
  const stub=await startStub(({response})=>send(response,200,body));
  try{await rejects(assert,client(stub.origin).login(TOKEN),'invalid_response');}finally{await stub.close();}
 }
 const broken=await startStub(({response})=>send(response,200,'{"created":'));
 try{await rejects(assert,client(broken.origin).login(TOKEN),'invalid_response');}finally{await broken.close();}
});

test('first sign-in creates the account and the next one logs in',async()=>{
 const logins=[];
 const stub=await startStub(({request,response,body})=>{
  if(request.url!=='/v2/accounts/microsoft')return send(response,404,{error:'not_found'});
  logins.push(JSON.parse(body));
  send(response,200,loginBody(logins.length===1));
 });
 try{
  const first=await client(stub.origin).login(TOKEN);
  assert.equal(first.created,true);
  assert.equal(first.session.token,SESSION);
  assert.equal(first.session.expiresAt,Date.parse('2026-02-01T00:00:00Z'));
  assert.equal(first.account.displayName,'Captain Testbeard');
  const second=await client(stub.origin).login(TOKEN);
  assert.equal(second.created,false);
  assert.deepEqual(logins,[{xboxUserToken:TOKEN,client:'launcher/1.0.1'},{xboxUserToken:TOKEN,client:'launcher/1.0.1'}]);
  assert.equal(stub.calls.length,2);
  assert.equal(stub.calls[0].headers['content-type'],'application/json');
  assert.equal(stub.calls[0].headers.authorization,undefined,'the login call is authenticated by the Minecraft token, not a Bearer header');
 }finally{await stub.close();}
});

test('me and logout send the session as a Bearer header',async()=>{
 const stub=await startStub(({request,response})=>{
  if(request.url==='/v2/accounts/me'&&request.method==='GET')return send(response,200,{account:ACCOUNT});
  if(request.url==='/v2/accounts/logout'&&request.method==='POST')return send(response,204);
  send(response,404,{error:'not_found'});
 });
 try{
  const api=client(stub.origin);
  assert.equal((await api.me(SESSION)).minecraftName,'TestCaptain');
  await api.logout(SESSION);
  assert.equal(stub.calls[0].headers.authorization,'Bearer '+SESSION);
  assert.equal(stub.calls[1].headers.authorization,'Bearer '+SESSION);
  assert.equal(stub.calls[0].method,'GET');
  assert.equal(stub.calls[1].method,'POST');
 }finally{await stub.close();}
});

test('an expired session logout still clears locally and a 401 me is reported',async()=>{
 const stub=await startStub(({request,response})=>send(response,request.url.endsWith('/logout')?500:401,{error:'invalid_session'}));
 try{
  const api=client(stub.origin);
  await api.logout(SESSION);
  await rejects(assert,api.me(SESSION),'invalid_session');
 }finally{await stub.close();}
});

test('an unresponsive API cannot hang login or logout past the timeout',async()=>{
 const slow=await startStub(()=>{});
 const silent=await startStub(({response})=>setTimeout(()=>send(response,200,loginBody(false)),1500));
 try{
  const started=Date.now();
  await rejects(assert,client(slow.origin,{timeout:300,request:(url,options)=>new Promise((resolve,reject)=>{
   // A connection that opens but never answers: only the bounded timeout can end it.
   const timer=setTimeout(()=>reject(new Error('the launcher waited past its timeout')),4000);
   options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(new Error('aborted'),{name:'AbortError'}));},{once:true});
  })}).login(TOKEN),'unreachable');
  assert(Date.now()-started<3000,'login must not wait for a stalled API');
  const api=client(silent.origin,{timeout:300});
  const logout=Date.now();await api.logout(SESSION);
  assert(Date.now()-logout<3000,'logout must not wait for a stalled API');
 }finally{await slow.close();await silent.close();}
});

test('cancelling sign-in surfaces AbortError rather than a network failure',async()=>{
 const stub=await startStub(()=>{});
 const controller=new AbortController();
 const pending=client(stub.origin,{request:(url,options)=>new Promise((resolve,reject)=>{
  options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
 })}).login(TOKEN,controller.signal);
 controller.abort();
 await assert.rejects(pending,{name:'AbortError'});
 await stub.close();
});

test('contract error codes map to fixed launcher wording',async()=>{
 for(const [status,code,match] of [[400,'invalid_request',/rejected the request/],[503,'identity_provider_unavailable',/unavailable right now/],[429,,/Too many account requests/],[500,,/could not complete/]]){
  const stub=await startStub(({response})=>send(response,status,code?{error:code}:{}));
  try{const error=await rejects(assert,client(stub.origin).login(TOKEN),code||(status===429?'rate_limited':'service_'+status));assert.match(error.message,match);}finally{await stub.close();}
 }
});

test('the transport path used in production is exercised against a real socket',async()=>{
 // No request injection: AccountClient uses its apiFetch default, so this covers
 // the transport, its bounded timeout and its cause-free transport errors.
 const {AccountClient}=require('../../desktop/accounts.cjs');
 const stub=await startStub(({request,response})=>{
  if(request.url==='/v2/accounts/microsoft')return send(response,200,loginBody(true));
  // Hold the socket open and never answer: only the bounded timeout can end it.
  if(request.url==='/v1/accounts/stall')return;
  send(response,500,{error:'boom'});
 });
 const api=timeout=>new AccountClient({baseUrl:stub.origin,client:'launcher/1.0.1',timeout});
 try{
  const signed=await api(800).login(TOKEN);
  assert.equal(signed.created,true);
  assert.equal(stub.calls[0].headers['content-type'],'application/json');
  assert.equal(JSON.parse(stub.calls[0].body).xboxUserToken,TOKEN);
  const started=Date.now();
  const error=await rejects(assert,api(400).call('/v1/accounts/stall',{method:'POST',body:{},timeout:400}),'unreachable');
  assert(Date.now()-started<3000,'a body that never ends must be bounded');
  assert(!JSON.stringify(error.message).includes(TOKEN));
 }finally{await stub.close();}
 const closed=await startStub(()=>{});
 const dead=closed.origin;await closed.close();
 const refused=await rejects(assert,new AccountClient({baseUrl:dead,client:'launcher/1.0.1',timeout:1500}).login(TOKEN),'unreachable');
 assert.equal(refused.message,'The Easter Company account service could not be reached.');
});

test('the renderer only ever sees a name and roles',async()=>{
 const {publicAccount,companySession,storedSession}=require('../../desktop/accounts.cjs');
 const signed=companySession({created:true,account:ACCOUNT,session:{token:SESSION,expiresAt:Date.parse('2026-02-01T00:00:00Z')}});
 assert.equal(signed.token,SESSION);
 assert.equal(signed.expiresAt,Date.parse('2026-02-01T00:00:00Z'));
 assert.deepEqual(publicAccount(signed),{id:'EC-42',name:'Captain Testbeard',roles:['crew'],passwordRequired:false,microsoftLinked:true});
 // A response that nests the session wrongly must be refused, not stored empty.
 assert.throws(()=>companySession({created:true,account:ACCOUNT,token:SESSION,expiresAt:1}),(error)=>error.code==='invalid_response');
 assert.throws(()=>companySession({created:true,account:ACCOUNT,session:{token:'',expiresAt:1}}),(error)=>error.code==='invalid_response');
 assert.equal(JSON.stringify(publicAccount(signed)).includes(SESSION),false);
 assert.equal(JSON.stringify(publicAccount(signed)).includes(ACCOUNT.minecraftUuid),false);
 assert.deepEqual(storedSession({token:SESSION,expiresAt:1,account:ACCOUNT}),{token:SESSION,expiresAt:1,account:signed.account});
 assert.equal(storedSession({token:SESSION,expiresAt:NaN,account:ACCOUNT}),null);
 assert.equal(storedSession({token:'',expiresAt:1,account:ACCOUNT}),null);
 assert.equal(storedSession({token:SESSION,expiresAt:1,account:{...ACCOUNT,roles:'admin'}}).account.roles.length,0);
 assert.equal(storedSession({token:SESSION,expiresAt:1,account:{...ACCOUNT,minecraftName:'x'.repeat(40)}}),null);
 assert.equal(publicAccount(null),null);
});

test('profile-less Company identity has a stable ID and keeps provider binding private',()=>{
 const {sanitizeAccount,publicAccount}=require('../../desktop/accounts.cjs');
 const account=sanitizeAccount({...ACCOUNT,minecraftUuid:null,minecraftName:null,passwordRequired:true});
 const view=publicAccount({account});
 assert.equal(view.id,'EC-42');assert.equal(view.passwordRequired,true);
 assert(!JSON.stringify(view).includes(ACCOUNT.microsoftSubject));
 assert.throws(()=>sanitizeAccount({...ACCOUNT,microsoftSubject:null}),(error)=>error.code==='invalid_response');
});

test('password login and reset use fixed Company routes and bearer-bound reset',async()=>{
 const secret='fixture password passphrase';
 const stub=await startStub(({request,response,body})=>{
  const payload=JSON.parse(body);
  if(request.url==='/v2/accounts/password/login'){
   assert.equal(payload.companyId,'EC-42');assert.equal(payload.password,secret);assert.equal(request.headers.authorization,undefined);
  }else{
   assert.equal(request.url,'/v2/accounts/password');assert.equal(request.headers.authorization,'Bearer '+SESSION);assert.equal(payload.replace,true);
  }
  send(response,200,loginBody(false));
 });
 try{
  const api=client(stub.origin);
  const signed=await api.loginPassword('EC-42',secret);
  assert.equal(signed.account.passwordRequired,false);
  await api.setPassword(SESSION,secret,true);
 }finally{await stub.close();}
});
