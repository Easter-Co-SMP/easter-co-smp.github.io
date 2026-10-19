const test=require('node:test'),assert=require('node:assert/strict');
const {startStub,send,client,rejects,ACCOUNT}=require('./fixtures.cjs');
const fs=require('node:fs'),path=require('node:path');
const repoRoot=path.resolve(__dirname,'../..');
const readRepo=file=>fs.readFileSync(path.join(repoRoot,file),'utf8');
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

test('the optional Graph token rides on the Microsoft signup request and nothing else',async()=>{
 const stub=await startStub(({response})=>send(response,200,loginBody(false)));
 try{
  const api=client(stub.origin);
  await api.login(TOKEN,undefined,undefined,'graph-access-token-private');
  await api.login(TOKEN,undefined,undefined);
  await api.login(TOKEN,undefined,undefined,'');
 }finally{await stub.close();}
 const bodies=stub.calls.map(call=>JSON.parse(call.body));
 assert.deepEqual(bodies[0],{xboxUserToken:TOKEN,microsoftAccessToken:'graph-access-token-private',client:'launcher/1.0.1'});
 assert.deepEqual(bodies[1],{xboxUserToken:TOKEN,client:'launcher/1.0.1'},'a sign-in without one sends no empty field');
 assert.deepEqual(bodies[2],{xboxUserToken:TOKEN,client:'launcher/1.0.1'});
 assert(stub.calls.every(call=>call.url==='/v2/accounts/microsoft'));
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

test('the renderer only ever sees a name, a username and roles',async()=>{
 const {publicAccount,companySession,storedSession}=require('../../desktop/accounts.cjs');
 const signed=companySession({created:true,account:ACCOUNT,session:{token:SESSION,expiresAt:Date.parse('2026-02-01T00:00:00Z')}});
 assert.equal(signed.token,SESSION);
 assert.equal(signed.expiresAt,Date.parse('2026-02-01T00:00:00Z'));
 // The username is the identity the player sees; the Company ID rides along only as the
 // opaque handle the account menu switches on, and an email never leaves the server.
 assert.deepEqual(publicAccount(signed),{id:'EC-42',username:'testcaptain',name:'Captain Testbeard',roles:['crew'],passwordRequired:false,microsoftLinked:true,providers:['microsoft'],primaryProvider:'microsoft',picture:null});
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

test('the account payload carries the claimed username and refuses a contradictory one',()=>{
 const {sanitizeAccount,publicAccount}=require('../../desktop/accounts.cjs');
 // A brand new Microsoft account has no username and is asked for one before a password.
 const fresh=sanitizeAccount({...ACCOUNT,username:null,passwordRequired:true});
 assert.equal(fresh.username,null);assert.equal(sanitizeAccount(ACCOUNT).username,'testcaptain');
 // A payload that needs no password and carries no username is a server bug, not a blank
 // identity: it is refused instead of shown.
 assert.throws(()=>sanitizeAccount({...ACCOUNT,username:null,passwordRequired:false}),(error)=>error.code==='invalid_response');
 assert.throws(()=>sanitizeAccount({...ACCOUNT,username:null}),(error)=>error.code==='invalid_response');
 // The username rules, so nothing the username field accepts can break the account view.
 for(const bad of ['ab','a'.repeat(21),'Has Space','UPPER','has.dot','has@sign'])assert.throws(()=>sanitizeAccount({...ACCOUNT,username:bad}),(error)=>error.code==='invalid_response',bad);
 assert.equal(publicAccount({account:sanitizeAccount({...ACCOUNT,username:'a_b-c9'})}).username,'a_b-c9');
});

test('an email in the payload never reaches the renderer or the vault',()=>{
 const {sanitizeAccount,publicAccount,storedSession}=require('../../desktop/accounts.cjs');
 const withEmail={...ACCOUNT,email:'player@example.test',providerEmail:'player@example.test'};
 const account=sanitizeAccount(withEmail);
 const view=publicAccount({account});
 assert(!JSON.stringify(view).includes('example.test'),'the account view carries no email');
 assert(!JSON.stringify(account).includes('example.test'),'the sanitized account carries no email');
 assert(!JSON.stringify(storedSession({token:SESSION,expiresAt:1,account:withEmail})).includes('example.test'),'a vaulted session carries no email');
});

test('direct login posts the typed identifier, never a Company ID',async()=>{
 const secret='fixture password passphrase';
 const stub=await startStub(({response})=>send(response,200,loginBody(false)));
 try{
  const api=client(stub.origin);
  const signed=await api.loginPassword('testcaptain',secret);
  assert.equal(signed.account.passwordRequired,false);
  await api.loginPassword('player@example.test',secret);
 }finally{await stub.close();}
 // The exact bodies leave this client, and nothing else does.
 assert.deepEqual(stub.calls.map(call=>JSON.parse(call.body)),[
  {identifier:'testcaptain',password:secret,client:'launcher/1.0.1'},
  {identifier:'player@example.test',password:secret,client:'launcher/1.0.1'}
 ]);
 assert(stub.calls.every(call=>call.url==='/v2/accounts/password/login'&&call.method==='POST'));
 assert(stub.calls.every(call=>call.headers.authorization===undefined),'direct login is authenticated by the password, not a Bearer header');
 assert(stub.calls.every(call=>!('companyId' in JSON.parse(call.body))),'no Company ID is ever posted');
});

test('the availability probe answers one boolean and a reason the launcher understands',async()=>{
 // The deployed probe says 'taken'/'policy' (api/identity_routes.py); the frozen contract
 // named the same two answers after their error codes. Both spellings must land on the
 // launcher's codes, because the message the player reads is chosen from them.
 const stub=await startStub(({response,body})=>{
  const {username}=JSON.parse(body);
  const answers={
   free:{available:true,reason:null,email:'leak@example.test'},
   taken:{available:false,reason:'taken',account:{id:9,email:'leak@example.test'}},
   policy:{available:false,reason:'policy'},
   contract_taken:{available:false,reason:'username_taken'},
   contract_policy:{available:false,reason:'username_policy'},
   silent:{available:false},
   unknown:{available:false,reason:'something_new'}
  };
  send(response,200,answers[username]||answers.free);
 });
 try{
  const api=client(stub.origin);
  assert.deepEqual(await api.usernameAvailable('free'),{available:true,reason:null});
  assert.deepEqual(await api.usernameAvailable('taken'),{available:false,reason:'username_taken'},'the deployed service says taken');
  assert.deepEqual(await api.usernameAvailable('policy'),{available:false,reason:'username_policy'},'and policy for a reserved word');
  assert.deepEqual(await api.usernameAvailable('contract_taken'),{available:false,reason:'username_taken'});
  assert.deepEqual(await api.usernameAvailable('contract_policy'),{available:false,reason:'username_policy'});
  // A refusal with no reason and a reason nobody has learned yet are both refusals, never
  // availability: the player is never advanced on a maybe.
  assert.deepEqual(await api.usernameAvailable('silent'),{available:false,reason:'username_taken'});
  assert.deepEqual(await api.usernameAvailable('unknown'),{available:false,reason:'username_taken'});
  // A name that fails the rules never becomes a request at all.
  assert.deepEqual(await api.usernameAvailable('Bad Name'),{available:false,reason:'username_policy'});
 }finally{await stub.close();}
 assert.deepEqual(stub.calls.map(call=>JSON.parse(call.body)),[{username:'free'},{username:'taken'},{username:'policy'},{username:'contract_taken'},{username:'contract_policy'},{username:'silent'},{username:'unknown'}]);
 assert(stub.calls.every(call=>call.url==='/v2/accounts/username/available'&&call.method==='POST'));
 assert(stub.calls.every(call=>call.headers.authorization===undefined),'the probe carries no session');
 assert(!JSON.stringify(stub.calls).includes('leak@example.test'),'nothing in the probe answer is forwarded');
});

test('a reserved or malformed username reads as policy, not as a name someone holds',async()=>{
 // End to end through the main-process handler, because the wording lives in its table.
 const {MESSAGES}=require('../../desktop/accounts.cjs');
 // Capitals are folded, so the sentence promises that rather than forbidding them.
 assert.equal(MESSAGES.username_policy,'Use 3 to 20 characters: letters, numbers, underscores or dashes. Capitals become lowercase.');
 assert.equal(MESSAGES.username_taken,'That username is already taken. Try another.');
 assert.notEqual(MESSAGES.username_policy,MESSAGES.username_taken);
 const stub=await startStub(({response,body})=>{
  const {username}=JSON.parse(body);
  send(response,200,username==='easter'?{available:false,reason:'policy'}:{available:false,reason:'taken'});
 });
 try{
  const api=client(stub.origin);
  for(const name of ['easter','taken']){
   const answer=await api.usernameAvailable(name);
   assert.equal(answer.available,false);
   assert.equal(MESSAGES[answer.reason],name==='easter'?MESSAGES.username_policy:MESSAGES.username_taken);
  }
 }finally{await stub.close();}
});

test('the username is posted once, with the first password, and the reset posts none',async()=>{
 const secret='fixture password passphrase';
 const stub=await startStub(({response})=>send(response,200,loginBody(false)));
 try{
  const api=client(stub.origin);
  await api.setPassword(SESSION,secret,false,'testcaptain');
  await api.setPassword(SESSION,secret,true);
 }finally{await stub.close();}
 assert.deepEqual(stub.calls.map(call=>JSON.parse(call.body)),[
  {username:'testcaptain',password:secret,replace:false,client:'launcher/1.0.1'},
  {password:secret,replace:true,client:'launcher/1.0.1'}
 ]);
 assert(stub.calls.every(call=>call.url==='/v2/accounts/password'&&call.headers.authorization==='Bearer '+SESSION));
});

test('a rejected username and a wrong identifier read as plain sentences',async()=>{
 const cases=[[409,'username_taken',/That username is already taken\. Try another\./],[400,'username_policy',/Use 3 to 20 characters/],[401,'invalid_credentials',/The username or email, or the password, is incorrect\./]];
 for(const [status,code,match] of cases){
  const stub=await startStub(({response})=>send(response,status,{error:code,detail:'server detail that must not surface'}));
  try{
   const api=client(stub.origin);
   const error=code==='invalid_credentials'?await rejects(assert,api.loginPassword('testcaptain','wrong passphrase here'),code):await rejects(assert,api.setPassword(SESSION,'fixture password passphrase',false,'testcaptain'),code);
   assert.match(error.message,match);
   assert(!error.message.includes('server detail'));
  }finally{await stub.close();}
 }
});

// ---- Verified emails ---------------------------------------------------------
// The one place an address crosses the launcher, and the shape it must have. The routes
// are owner-only: they take the Company session and no account handle, and the launcher
// posts nothing but the address the player chose.
const EMAIL_ONE='captain@example.test',EMAIL_TWO='crew@example.test',EMAIL_LOST='lost@example.test';
function emailList(loginEmail){
 return {emails:[
  {email:EMAIL_ONE,provider:'microsoft',verifiedAt:'2026-01-01T00:00:00Z',login:loginEmail===EMAIL_ONE},
  {email:EMAIL_TWO,provider:'microsoft',verifiedAt:'2026-01-02T00:00:00Z',login:loginEmail===EMAIL_TWO}
 ],loginEmail};
}

test('the verified emails are read from the owner-only route and carry only the four fields',async()=>{
 const stub=await startStub(({response})=>send(response,200,{
  emails:[
   {email:EMAIL_ONE,provider:'microsoft',verifiedAt:'2026-01-01T00:00:00Z',login:true,id:7,accountId:'EC-7',token:'should-never-surface'},
   {email:EMAIL_TWO,provider:'microsoft',verifiedAt:'2026-01-02T00:00:00Z',login:false}
  ],
  loginEmail:EMAIL_ONE,
  account:{id:7,email:EMAIL_ONE}
 }));
 let listed;
 try{listed=await client(stub.origin).emails(SESSION);}finally{await stub.close();}
 assert.deepEqual(listed,{emails:[
  {email:EMAIL_ONE,provider:'microsoft',verifiedAt:'2026-01-01T00:00:00Z',login:true},
  {email:EMAIL_TWO,provider:'microsoft',verifiedAt:'2026-01-02T00:00:00Z',login:false}
 ],loginEmail:EMAIL_ONE},'nothing but the four fields and the login address leaves the client');
 assert.equal(stub.calls.length,1);
 assert.equal(stub.calls[0].url,'/v2/accounts/emails');
 assert.equal(stub.calls[0].method,'GET');
 assert.equal(stub.calls[0].headers.authorization,'Bearer '+SESSION,'the route is asked for with the Company session');
 assert(!JSON.stringify(listed).includes('should-never-surface'));
 assert(!JSON.stringify(listed).includes('EC-7'),'no account handle is carried in a list of addresses');
});

test('the login address the service names is the only one marked, and a phantom one marks nothing',()=>{
 const {verifiedEmails}=require('../../desktop/accounts.cjs');
 // The top-level answer wins over a per-entry flag that disagrees with it.
 let listed=verifiedEmails({emails:[{email:EMAIL_ONE,provider:'microsoft',login:false},{email:EMAIL_TWO,provider:'microsoft',login:true}],loginEmail:EMAIL_ONE});
 assert.equal(listed.loginEmail,EMAIL_ONE);
 assert.deepEqual(listed.emails.map(entry=>entry.login),[true,false]);
 // No top-level address: the entry flag is what the answer says, and it is honoured.
 listed=verifiedEmails({emails:[{email:EMAIL_ONE,provider:'microsoft',login:false},{email:EMAIL_TWO,provider:'microsoft',login:true}]});
 assert.equal(listed.loginEmail,EMAIL_TWO);
 assert.deepEqual(listed.emails.map(entry=>entry.login),[false,true]);
 // An address named as the login one but absent from the list is not invented: nothing is
 // selected rather than a row that is not there.
 listed=verifiedEmails({emails:[{email:EMAIL_ONE,provider:'microsoft',login:true}],loginEmail:'elsewhere@example.test'});
 assert.equal(listed.loginEmail,null);
 assert.deepEqual(listed.emails.map(entry=>entry.login),[false]);
 // No addresses at all is the empty state, not a failure.
 assert.deepEqual(verifiedEmails({emails:[],loginEmail:null}),{emails:[],loginEmail:null});
 assert.deepEqual(verifiedEmails({}),{emails:[],loginEmail:null});
});

test('an address the launcher could not show is dropped rather than displayed',()=>{
 const {verifiedEmails}=require('../../desktop/accounts.cjs');
 const listed=verifiedEmails({emails:[
  {email:'not-an-address',provider:'microsoft'},
  {email:'',provider:'microsoft'},
  {email:'   ',provider:'microsoft'},
  null,
  'captain@example.test',
  {email:5,provider:'microsoft'},
  {email:EMAIL_ONE,provider:5,verifiedAt:7},
  {email:'CAPTAIN@example.test',provider:'microsoft'},
  {email:EMAIL_TWO}
 ],loginEmail:EMAIL_ONE});
 // Only renderable, unique addresses survive, and an unknown provider or date is named as
 // unknown rather than guessed.
 assert.deepEqual(listed.emails,[
  {email:EMAIL_ONE,provider:null,verifiedAt:null,login:true},
  {email:EMAIL_TWO,provider:null,verifiedAt:null,login:false}
 ]);
 assert.equal(listed.loginEmail,EMAIL_ONE);
 // A payload that is not an object at all is a broken answer, not an empty account.
 const {AccountError}=require('../../desktop/accounts.cjs');
 for(const bad of [null,undefined,'emails',42,[{email:EMAIL_ONE}]])assert.throws(()=>verifiedEmails(bad),(error)=>error instanceof AccountError&&error.code==='invalid_response');
 // A list longer than the profile could ever show is capped rather than rendered whole.
 const many=verifiedEmails({emails:Array.from({length:25},(_,index)=>({email:'crew'+index+'@example.test',provider:'microsoft'}))});
 assert.equal(many.emails.length,20);
});

test('selecting a login email posts the chosen address and re-reads the list',async()=>{
 let loginEmail=EMAIL_ONE;
 const stub=await startStub(({request,response,body})=>{
  if(request.url==='/v2/accounts/emails/login'&&request.method==='POST'){
   const chosen=JSON.parse(body).email;
   if(chosen===EMAIL_LOST)return send(response,400,{error:'email_not_yours',detail:'refused for '+chosen});
   loginEmail=chosen;
   return send(response,200,{ok:true});
  }
  if(request.url==='/v2/accounts/emails'&&request.method==='GET')return send(response,200,emailList(loginEmail));
  send(response,404,{error:'not_found'});
 });
 const api=client(stub.origin);
 try{
  const second=await api.selectLoginEmail(SESSION,EMAIL_TWO);
  assert.equal(second.loginEmail,EMAIL_TWO,'the answer is the record the service now holds');
  assert.deepEqual(second.emails.map(entry=>entry.login),[false,true]);
  const cleared=await api.selectLoginEmail(SESSION,null);
  assert.equal(cleared.loginEmail,null,'clearing leaves no selection');
  assert.deepEqual(cleared.emails.map(entry=>entry.login),[false,false]);
 }finally{await stub.close();}
 // The exact bodies: the chosen address, then an explicit null to clear, both with the
 // Company session and neither naming an account.
 const writes=stub.calls.filter(call=>call.url==='/v2/accounts/emails/login');
 assert.deepEqual(writes.map(call=>JSON.parse(call.body)),[{email:EMAIL_TWO},{email:null}]);
 assert(writes.every(call=>call.method==='POST'&&call.headers.authorization==='Bearer '+SESSION));
 assert(writes.every(call=>!('accountId' in JSON.parse(call.body))&&!('companyId' in JSON.parse(call.body))),'no account handle is posted');
 // Each write is followed by a read, which is where the profile's list comes from.
 assert.deepEqual(stub.calls.map(call=>call.method+' '+call.url),[
  'POST /v2/accounts/emails/login','GET /v2/accounts/emails',
  'POST /v2/accounts/emails/login','GET /v2/accounts/emails'
 ]);
});

test('a refused address is one honest sentence about that address',async()=>{
 const {MESSAGES}=require('../../desktop/accounts.cjs');
 assert.match(MESSAGES.email_not_yours,/cannot be your login email/);
 assert.match(MESSAGES.email_not_yours,/another Easter Company account/);
 assert(!MESSAGES.email_not_yours.includes('@'),'the refusal names no address');
 assert(!/sign-in failed|Sign in again|password/i.test(MESSAGES.email_not_yours),'a refused address is not a failed sign-in');
 const stub=await startStub(({response})=>send(response,400,{error:'email_not_yours',detail:'another account holds '+EMAIL_LOST}));
 try{
  const error=await rejects(assert,client(stub.origin).selectLoginEmail(SESSION,EMAIL_LOST),'email_not_yours');
  assert.equal(error.message,MESSAGES.email_not_yours);
  const surface=JSON.stringify({message:error.message,code:error.code,stack:String(error.stack)});
  assert(!surface.includes(EMAIL_LOST),'neither the address nor the response body reaches an error');
  assert(!surface.includes('another account holds'));
 }finally{await stub.close();}
 // An address the launcher cannot even post never becomes a request, and it is not
 // reported as a refusal by the service.
 const quiet=await startStub(({response})=>send(response,200,emailList(EMAIL_ONE)));
 try{
  const api=client(quiet.origin);
  for(const bad of ['',`  `,'not-an-address',undefined,null+'x',42])await rejects(assert,api.selectLoginEmail(SESSION,bad),'invalid_request');
  assert.equal(quiet.calls.length,0,'nothing is sent for an address that is not one');
 }finally{await quiet.close();}
});

test('a malformed list is refused rather than half-rendered',async()=>{
 for(const status of [200]){
  const stub=await startStub(({response})=>send(response,status,'{"emails":'));
  try{await rejects(assert,client(stub.origin).emails(SESSION),'invalid_response');}finally{await stub.close();}
 }
 // An expired session is the same sentence the rest of the account surface uses.
 const expired=await startStub(({response})=>send(response,401,{error:'invalid_session'}));
 try{
  const error=await rejects(assert,client(expired.origin).emails(SESSION),'invalid_session');
  assert.match(error.message,/session expired/);
 }finally{await expired.close();}
 // An unreachable service is still bounded and still says nothing about the cause.
 const gone=await startStub(()=>{});
 const origin=gone.origin;await gone.close();
 const error=await rejects(assert,client(origin,{timeout:1500}).emails(SESSION),'unreachable');
 assert.equal(error.message,'The Easter Company account service could not be reached.');
 assert(!error.message.includes(EMAIL_ONE));
});

test('the account service email answer rides the sign-in as a status word, never an address',async()=>{
 // The sign-in dialog can only say "we could not read your Microsoft email address" if the
 // service's own answer reaches it. It travels as one of three words: no address, and an
 // answer this launcher does not recognise is dropped rather than echoed.
 const statuses=[['stored','stored'],['unavailable','unavailable'],['none','none']];
 for(const [sent,expected] of statuses){
  const stub=await startStub(({response})=>send(response,200,{...loginBody(false),emailStatus:sent}));
  try{assert.equal((await client(stub.origin).login(TOKEN)).emailStatus,expected);}finally{await stub.close();}
 }
 // A server that says nothing leaves the field out: absence is not a claim of 'none'.
 const silent=await startStub(({response})=>send(response,200,loginBody(false)));
 try{assert.equal('emailStatus' in await client(silent.origin).login(TOKEN),false);}finally{await silent.close();}
 // Neither an unknown word nor an address smuggled into the field can reach the renderer.
 for(const bogus of ['captain@example.test','unavailable:captain@example.test','STORED','']){
  const stub=await startStub(({response})=>send(response,200,{...loginBody(false),emailStatus:bogus}));
  try{
   const signed=await client(stub.origin).login(TOKEN);
   assert.equal('emailStatus' in signed,false,'only the three known words leave this module: '+JSON.stringify(bogus));
   assert(!JSON.stringify(signed).includes('captain@example.test'));
  }finally{await stub.close();}
 }
});

test('a capitalised username is folded before it is ever sent',async()=>{
 // Owen's rule: capitals are a keyboard habit, not an error. The name is lowercased in the
 // field, again in the client, and again on the account service, so every layer agrees and
 // "OwenEaster" and "oweneaster" are the same account.
 const stub=await startStub(({response})=>send(response,200,{available:true,reason:null}));
 try{
  const api=client(stub.origin);
  assert.deepEqual(await api.usernameAvailable('OwenEaster'),{available:true,reason:null});
  assert.deepEqual(await api.usernameAvailable('  MiXeD-Case_1  '),{available:true,reason:null});
 }finally{await stub.close();}
 assert.deepEqual(stub.calls.map(call=>JSON.parse(call.body).username),['oweneaster','mixed-case_1']);
});

test('the password floor is eight characters in every layer that states it',()=>{
 // One rule, four places: the dialog's own limits and sentence, the main process check,
 // the client's copy of the policy sentence, and the account service.
 const dialog=readRepo('site/company-auth.mjs');
 assert.equal(dialog.includes('minlength="15"'),false,'no dialog field may still demand 15');
 assert.equal((dialog.match(/minlength="8"/g)||[]).length,2,'both password fields ask for 8');
 assert.match(dialog,/Use 8–128 characters/);
 assert.match(dialog,/\[\.\.\.secret\]\.length<8/);
 const main=readRepo('desktop/main.cjs');
 assert.match(main,/length<8/);
 assert.equal(main.includes('length<15'),false);
 assert.match(main,/Use a password or passphrase of 8 to 128 characters/);
 const copy=require('../../desktop/accounts.cjs').MESSAGES;
 assert.match(copy.password_policy,/8 to 128 characters/);
 // The account service's own floor is asserted in its repository
 // (tests/test_identity.py::test_the_password_floor_is_eight_characters). A launcher test
 // may not read another repository: CI has no copy of it, and that is how this test broke
 // the 1.0.27 build.
});
