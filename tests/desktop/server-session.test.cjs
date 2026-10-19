'use strict';
// The frozen cloud half of the server-held Microsoft session (doc/launcher-states.md, "The
// Minecraft session the account service holds"). The routes are not deployed, so every test
// here runs against the loopback stub in tests/desktop/fixtures.cjs and nothing reaches a real
// service. What is proved: the two routes and their frozen shapes, the sanitizing of the minted
// session, the three answers the launcher distinguishes, the hand-over field travelling once,
// and the copy carrying no provider code, status or token.
const test=require('node:test'),assert=require('node:assert/strict');
const {startStub,send,client,rejects,ACCOUNT}=require('./fixtures.cjs');
const {AccountError,sanitizeGameSession,MESSAGES,sanitizeAccount,publicAccount,storedSession,GAME_SESSION_TIMEOUT_MS}=require('../../desktop/accounts.cjs');
const TOKEN='company-session-token-private';
const UUID='1234567890abcdef1234567890abcdef';
const PROFILE={uuid:'12345678-90ab-cdef-1234-567890abcdef',name:'TestCaptain'};
const minted=(over={})=>({accessToken:'mojang-access-token-private',expiresAt:'2026-10-20T00:00:00Z',profile:PROFILE,...over});
const gameSessionRoute=(payload,status=200)=>({response})=>send(response,status,payload);

// ---- the minted session's shape --------------------------------------------
test('the frozen minted shape is accepted, and its profile becomes the id a launch uses',()=>{
 const session=sanitizeGameSession(minted());
 assert.deepEqual(session.profile,{id:UUID,name:'TestCaptain'});
 assert.equal(session.accessToken,'mojang-access-token-private');
 assert.equal(session.expiresAt,Date.parse('2026-10-20T00:00:00Z'));
});

test('nothing else in the body survives, including a refresh token the contract does not allow',()=>{
 const session=sanitizeGameSession(minted({refreshToken:'microsoft-refresh-private',xuid:'2535410000000001',extra:{a:1}}));
 assert.deepEqual(Object.keys(session).sort(),['accessToken','expiresAt','profile']);
 assert.deepEqual(Object.keys(session.profile).sort(),['id','name']);
 assert(!JSON.stringify(session).includes('microsoft-refresh-private'));
});

test('a body that is not that shape is refused rather than guessed at',()=>{
 for(const body of [
  null,undefined,[],'string',{},
  minted({accessToken:''}),
  minted({accessToken:undefined}),
  minted({expiresAt:'not-a-date'}),
  minted({expiresAt:undefined}),
  minted({profile:null}),
  minted({profile:{name:'TestCaptain'}}),
  minted({profile:{uuid:UUID}}),
  minted({profile:{uuid:'not-a-uuid',name:'TestCaptain'}}),
  minted({profile:{uuid:UUID,name:'this name is far too long'}}),
  minted({profile:{uuid:UUID,name:'bad name'}})
 ])assert.equal(sanitizeGameSession(body),null,JSON.stringify(body));
});

// ---- the two routes --------------------------------------------------------
test('the mint is one authenticated POST and answers the session',async()=>{
 const stub=await startStub(gameSessionRoute(minted()));
 try{
  const session=await client(stub.origin).gameSession(TOKEN);
  assert.equal(session.profile.name,'TestCaptain');
  const call=stub.calls[0];
  assert.equal(call.method,'POST');
  assert.equal(call.url,'/v2/game/session');
  assert.equal(call.headers.authorization,'Bearer '+TOKEN);
  // The body carries the launcher's own name and nothing that could name an account.
  assert.deepEqual(JSON.parse(call.body),{client:'launcher/1.0.1'});
 }finally{await stub.close();}
});

test('reauth_required is its own code, with one sentence that names no provider and no token',async()=>{
 const stub=await startStub(({response})=>send(response,401,{error:'reauth_required',detail:'invalid_grant from login.live.com'}));
 try{
  const error=await rejects(assert,client(stub.origin).gameSession(TOKEN),'reauth_required');
  assert.equal(error.message,MESSAGES.reauth_required);
  assert.equal(error.message,'Microsoft needs you to sign in again before Minecraft starts.');
  const surface=JSON.stringify({message:error.message,code:error.code,name:error.name});
  for(const forbidden of ['invalid_grant','login.live','401','token','refresh'])assert(!surface.includes(forbidden),forbidden);
 }finally{await stub.close();}
});

test('a route that is not there is its own code, so nothing is reported as a session problem',async()=>{
 const stub=await startStub(({response})=>{response.writeHead(404,{'Content-Type':'text/html'});response.end('Not Found');});
 try{
  await rejects(assert,client(stub.origin).gameSession(TOKEN),'route_absent');
  await rejects(assert,client(stub.origin).revokeGameSession(TOKEN),'route_absent');
 }finally{await stub.close();}
});

test('a service failure or silence is no answer at all, never a reauthentication',async()=>{
 const stub=await startStub(({response})=>send(response,503,{error:'database_unavailable'}));
 try{
  const error=await rejects(assert,client(stub.origin).gameSession(TOKEN),'database_unavailable');
  assert.notEqual(error.code,'reauth_required');
 }finally{await stub.close();}
 const dead=await startStub(()=>{});
 const origin=dead.origin;await dead.close();
 const error=await rejects(assert,client(origin,{timeout:2000}).gameSession(TOKEN),'unreachable');
 assert.equal(error.message,'The Easter Company account service could not be reached.');
});

test('an unreadable success body is refused and reports nothing it read',async()=>{
 const stub=await startStub(({response})=>send(response,200,{accessToken:'mojang-access-token-private'}));
 try{
  const error=await rejects(assert,client(stub.origin).gameSession(TOKEN),'invalid_response');
  assert(!error.message.includes('mojang-access-token-private'));
 }finally{await stub.close();}
});

test('the revoke is one authenticated POST on its own route, and its answer is passed on',async()=>{
 // The cloud half froze this as a POST, not a DELETE: /v2/game/session/revoke answers
 // `{"revoked": true|false}`, and false is its honest "there was nothing stored".
 const stub=await startStub(({request,response})=>send(response,200,{revoked:request.url==='/v2/game/session/revoke'}));
 try{
  assert.deepEqual(await client(stub.origin).revokeGameSession(TOKEN),{revoked:true});
  const call=stub.calls[0];
  assert.equal(call.method,'POST');
  assert.equal(call.url,'/v2/game/session/revoke');
  assert.equal(call.headers.authorization,'Bearer '+TOKEN);
  assert.deepEqual(JSON.parse(call.body),{client:'launcher/1.0.1'});
  assert(stub.calls.every(entry=>entry.method!=='DELETE'),'the launcher never sends a DELETE for this');
 }finally{await stub.close();}
 const nothing=await startStub(({response})=>send(response,200,{revoked:false}));
 try{assert.deepEqual(await client(nothing.origin).revokeGameSession(TOKEN),{revoked:false});}
 finally{await nothing.close();}
});

test('a rate limit and a service that cannot answer are not a reauthentication',async()=>{
 // 429 with Retry-After, and the three 503s. None of them means the player's session died, so
 // none may be turned into the interactive Microsoft flow: they are their own codes, with the
 // service's own sentences.
 for(const [status,body] of [[429,{error:'rate_limited'}],[503,{error:'session_key_unconfigured'}],[503,{error:'microsoft_not_configured'}],[503,{error:'identity_provider_unavailable'}]]){
  const stub=await startStub(({response})=>send(response,status,body,status===429?{'Retry-After':'600'}:{}));
  try{
   const error=await rejects(assert,client(stub.origin).gameSession(TOKEN),body.error);
   assert.notEqual(error.code,'reauth_required',body.error+' must not be read as a dead session');
   assert(!/React|Microsoft account|sign in with/i.test(error.message)||body.error==='identity_provider_unavailable',body.error+' copy stays about the service');
   assert(error.status===status);
  }finally{await stub.close();}
 }
 const dead=await startStub(({response})=>send(response,401,{error:'invalid_session'}));
 try{
  const error=await rejects(assert,client(dead.origin).gameSession(TOKEN),'invalid_session');
  assert.notEqual(error.code,'reauth_required','a dead Company session is the account\'s news, not Microsoft\'s');
 }finally{await dead.close();}
});

test('every session call is bounded by the ceiling that outlives the cluster resume',()=>{
 assert.equal(GAME_SESSION_TIMEOUT_MS,29000);
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../desktop/accounts.cjs'),'utf8');
 // The two routes the cloud half froze, and no third one: the mint and the revoke.
 const routes=[...source.matchAll(/'\/v2\/game\/session[^']*'/g)].map(match=>match[0]);
 assert.deepEqual([...new Set(routes)].sort(),["'/v2/game/session'","'/v2/game/session/revoke'"]);
});

// ---- the hand-over ---------------------------------------------------------
test('the refresh token travels on the account sign-in request, under the agreed name, once',async()=>{
 const stub=await startStub(({response})=>send(response,200,{created:false,account:ACCOUNT,session:{token:'easter-session-private',expiresAt:'2026-11-01T00:00:00Z'}}));
 try{
  await client(stub.origin).login('xbox-user-token-private',undefined,undefined,'graph-token-private',undefined,'microsoft-refresh-private');
  const body=JSON.parse(stub.calls[0].body);
  assert.equal(body.microsoftRefreshToken,'microsoft-refresh-private');
  assert.equal(body.xboxUserToken,'xbox-user-token-private');
  assert.equal(body.microsoftAccessToken,'graph-token-private');
  // No second spelling of the field, and no field at all when there is nothing to hand over.
  assert.equal(Object.keys(body).filter(key=>/refresh/i.test(key)).length,1);
  await client(stub.origin).login('xbox-user-token-private');
  const plain=JSON.parse(stub.calls[1].body);
  assert(!Object.keys(plain).some(key=>/refresh/i.test(key)),'no refresh field without a token to hand over');
 }finally{await stub.close();}
});

test('the hand-over is in the one request the contract names, and nowhere else',()=>{
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../desktop/accounts.cjs'),'utf8');
 // One wire field, built in one place: the body of the account sign-in request. The prose may
 // name it (that is documentation) and the parameter carrying it is named after it, so the
 // assertion is about the object key — the thing actually sent — and about every use of the name
 // living inside login().
 const code=source.split('\n').filter(line=>!line.trim().startsWith('//'));
 const keys=code.filter(line=>/microsoftRefreshToken:\s*handOver/.test(line));
 assert.equal(keys.length,1,'the field is put in exactly one request body');
 assert(code.some(line=>line.includes("'/v2/accounts/microsoft'")),'and that body is the account sign-in request');
 const loginStart=code.findIndex(line=>/async login\(/.test(line));
 const loginEnd=code.findIndex((line,index)=>index>loginStart&&/return this\.signed\(created\)/.test(line));
 for(const [index,line] of code.entries())if(line.includes('microsoftRefreshToken'))assert(index>=loginStart&&index<loginEnd,'the name is used only inside login()');
 assert(!/refreshToken[^\n]*Authorization/.test(code.join('\n')));
});

// ---- what the state may carry ---------------------------------------------
test('the Company account the renderer receives still carries no token and no subject',()=>{
 const session=storedSession({token:'easter-session-private',expiresAt:Date.now()+1000,account:sanitizeAccount(ACCOUNT)});
 const published=publicAccount(session);
 const surface=JSON.stringify(published);
 for(const forbidden of ['easter-session-private','a'.repeat(64)])assert(!surface.includes(forbidden));
 assert.equal(published.microsoftLinked,true);
});

test('a refusal keeps its code, so the launcher can tell the three answers apart',()=>{
 const codes=[new AccountError('reauth_required',MESSAGES.reauth_required).code,new AccountError('route_absent',MESSAGES.route_absent).code];
 assert.deepEqual(codes,['reauth_required','route_absent']);
 assert(!MESSAGES.reauth_required.includes('reauth_required'));
 assert(!MESSAGES.route_absent.includes('route_absent'));
});
