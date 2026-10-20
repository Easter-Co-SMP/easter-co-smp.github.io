'use strict';
// A cold account service must not be read as a verdict (ticket 922eb7e2, Owen at launch on
// 1.0.33: "Checking your Minecraft session" settling on "Try again / The account service is
// busy right now", with no way in). Lambda cold starts and an Aurora cluster at minimum
// capacity 0 make one call bounce or time out, so the launcher here proves three things:
//
//  1. the calls that may safely be repeated ARE repeated — a dropped connection, the gateway's
//     own timeout and a declared `database_unavailable` each recover inside one bounded budget;
//  2. the calls that may not be repeated never are, and a 401, a 403 and a 429 are answers;
//  3. while the retries run the hero stays on "Checking your Minecraft session…", the post-budget
//     verdict is the existing "Try again" sentence, an answer for an account that has gone is
//     discarded, and the wait can always be given up.
//
// Nothing here reaches a real service: the client is driven through an injected request, a
// clock and a sleep, and main's own mint is driven in a sandbox with a stubbed account client.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {
 AccountClient,AccountError,OPERATIONS,transientFailure,UNREACHABLE_MESSAGE,
 RETRY_ATTEMPT_CEILING_MS,RETRY_BACKOFF_MS,RETRY_BACKOFF_MAX_MS,RETRY_ATTEMPTS_MAX,
 MINT_RETRY_BUDGET_MS,READ_RETRY_BUDGET_MS,GAME_SESSION_TIMEOUT_MS
}=require('../../desktop/accounts.cjs');
const readRepo=file=>fs.readFileSync(path.join(__dirname,'../..',file),'utf8');
const TOKEN='company-session-token-private';
const UUID='1234567890abcdef1234567890abcdef';
const MINTED={accessToken:'mojang-access-token-private',expiresAt:'2026-10-20T00:00:00Z',profile:{uuid:'12345678-90ab-cdef-1234-567890abcdef',name:'FixtureCaptain'}};

// A client whose clock and sleep are its own, so a three-minute budget is provable in
// milliseconds and the exact backoff sequence is an assertion rather than a wall-clock guess.
function frozenClient(request,options={}){
 let clock=1000;const waits=[];
 const api=new AccountClient({baseUrl:'http://127.0.0.1:1',client:'launcher/1.0.1',request,now:()=>clock,waitFor:async ms=>{waits.push(ms);clock+=ms;},...options});
 return {api,waits,advance:ms=>{clock+=ms;},time:()=>clock};
}
// The three failures a cold start actually produces, as the client sees them.
const failures={
 // The connection is dropped before anything answers.
 dropped:()=>{const error=new TypeError('fetch failed');error.cause=new Error('socket hang up');throw error;},
 // API Gateway answers for the service it did not reach in time: HTML, not JSON.
 gatewayTimeout:()=>new Response('<html><body>504 Gateway Time-out</body></html>',{status:504,headers:{'Content-Type':'text/html'}}),
 // The service reached its database and said so, which is the one write failure it declares safe.
 databaseUnavailable:()=>new Response(JSON.stringify({error:'database_unavailable'}),{status:503,headers:{'Content-Type':'application/json'}})
};

// ---- 1. what may be repeated recovers ------------------------------------------
for(const [name,fail] of Object.entries(failures)){
 test('a cold mint survives a '+name+' and answers the session',async()=>{
  let attempts=0;
  const {api,waits}=frozenClient(async()=>{attempts++;if(attempts<3)return fail();return new Response(JSON.stringify(MINTED),{status:200,headers:{'Content-Type':'application/json'}});});
  const session=await api.gameSession(TOKEN);
  assert.equal(attempts,3,'the transient answer is asked again rather than believed');
  assert.equal(session.profile.name,'FixtureCaptain');
  // Two seconds, then four: doubling, and never a hammer on a service that is resuming.
  assert.deepEqual(waits,[RETRY_BACKOFF_MS,RETRY_BACKOFF_MS*2]);
 });
}

test('the reads recover the same way: a status read, the account and the providers',async()=>{
 for(const [route,run] of [
  ['/v2/game/status',api=>api.gameStatus(TOKEN)],
  ['/v2/accounts/me',api=>api.me(TOKEN)],
  ['/v2/accounts/providers',api=>api.providers()],
  ['/v2/accounts/emails',api=>api.emails(TOKEN)]
 ]){
  let attempts=0;
  const body=route==='/v2/game/status'?{state:'running',ready:true,endpoint:'smp.easter.company:25565',since:'2026-10-19T00:00:00Z',players:0,detail:''}
   :route==='/v2/accounts/me'?{account:{id:42,username:'testcaptain',minecraftName:'TestCaptain',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',passwordRequired:false}}
   :route==='/v2/accounts/providers'?{providers:['microsoft']}
   :{emails:[],loginEmail:null};
  const {api}=frozenClient(async url=>{
   attempts++;
   if(attempts===1)return failures.gatewayTimeout();
   assert.equal(new URL(url).pathname,route);
   return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  });
  const answer=await run(api);
  assert.equal(attempts,2,route+' is a read, so one bounce is not its answer');
  assert(answer,route+' answered after the retry');
 }
});

test('the username probe is a question and is asked again, because it writes nothing',async()=>{
 let attempts=0;
 const {api}=frozenClient(async()=>{
  attempts++;
  if(attempts===1)return failures.dropped();
  return new Response(JSON.stringify({available:true}),{status:200,headers:{'Content-Type':'application/json'}});
 });
 assert.deepEqual(await api.usernameAvailable('Captain_Owen'),{available:true,reason:null});
 assert.equal(attempts,2);
});

// ---- 2. what may not be repeated is not ----------------------------------------
test('a write is one attempt, whatever went wrong: a lost answer may have committed',async()=>{
 const writes=[
  ['sign-in',api=>api.login('xbox-user-token-private')],
  ['password sign-in',api=>api.loginPassword('captainfixture','fixture secret passphrase')],
  ['password save',api=>api.setPassword(TOKEN,'fixture secret passphrase',false,'captainfixture')],
  ['email selection',api=>api.selectLoginEmail(TOKEN,'owen@example.test')],
  ['profile write',api=>api.updateProfile(TOKEN,{displayName:'Captain Fixture'})],
  ['revoke',api=>api.revokeGameSession(TOKEN)],
  ['session refresh',api=>api.refreshSession(TOKEN)]
 ];
 for(const [name,run] of writes){
  // The retry loop is not the only retry in this module, and it may not become one: these two
  // failures leave the write's outcome unknown, so each is exactly one attempt. The sign-in's
  // own declared `database_unavailable` rule is separate and is asserted below, unchanged.
  for(const [failure,make] of [['a gateway timeout',failures.gatewayTimeout],['a dropped connection',failures.dropped]]){
   let attempts=0;
   const {api}=frozenClient(async()=>{attempts++;return make();});
   await run(api).then(()=>assert.fail(name+' unexpectedly answered'),()=>{});
   assert.equal(attempts,1,name+' is a write: '+failure+' must not replay it');
  }
 }
});

test('every account journey waits out a waking service on the one answer that proves nothing happened',async()=>{
 // Owen, 2026-10-20: sign-up and sign-in "should fail loudly but also have generous timeouts
 // and retries especially when dealing with our own serverless infrastructure which will
 // frequently cold start". A declared 503 `database_unavailable` is the service saying it
 // carried nothing out, so every operation waits the same window the sign-in always had:
 // four attempts including the first, three seconds by attempt of backoff, ninety seconds.
 // This is the rule that replaced "every other write is one attempt"; the failure copy and
 // the stage both come from the same place (doc/launcher-states.md, *Every account journey
 // waits out a cold account service*).
 const operations=[
  ['sign-in',(api,onWait)=>api.login('xbox-user-token-private',undefined,undefined,undefined,onWait)],
  ['password sign-in',(api,onWait)=>api.loginPassword('captainfixture','fixture secret passphrase',undefined,onWait)],
  ['password save',(api,onWait)=>api.setPassword(TOKEN,'fixture secret passphrase',false,'captainfixture',onWait)],
  ['email selection',(api,onWait)=>api.selectLoginEmail(TOKEN,'owen@example.test',undefined,onWait)],
  ['profile write',(api,onWait)=>api.updateProfile(TOKEN,{displayName:'Captain Fixture'},onWait)],
  ['session refresh',(api,onWait)=>api.refreshSession(TOKEN,undefined,onWait)],
  ['revoke',(api,onWait)=>api.revokeGameSession(TOKEN,undefined,onWait)]
 ];
 for(const [name,run] of operations){
  let attempts=0;const stages=[];
  const {api,waits}=frozenClient(async()=>{attempts++;return failures.databaseUnavailable();});
  await run(api,stage=>stages.push(stage)).then(()=>assert.fail(name+' unexpectedly answered'),error=>{
   assert.equal(error.code,'database_unavailable',name+': the declared code reaches the player');
   assert.match(error.message,/still waking up, and nothing has changed/i,name+': and says what did not happen');
  });
  assert.equal(attempts,4,name+': four attempts including the first');
  assert.deepEqual(waits,[3000,6000,9000],name+': three seconds by attempt of backoff');
  assert.deepEqual(stages,['company-waking','company-waking','company-waking'],name+': the wait names itself every time it rests');
 }
});

test('the waking window still refuses every answer that is not a declaration',async()=>{
 // The patience above is for the one answer that proves nothing happened. A refusal is an
 // answer, an unreadable success is ambiguous, and a 500 is the service failing to say which:
 // none of them may cost a player ninety seconds, and none of them may re-send credentials.
 for(const [failure,label,make] of [
  ['a 401 refusal', 'a refusal', ()=>new Response(JSON.stringify({error:'invalid_credentials'}),{status:401,headers:{'Content-Type':'application/json'}})],
  ['a 429 limit', 'a refusal', ()=>new Response(JSON.stringify({error:'rate_limited'}),{status:429,headers:{'Content-Type':'application/json'}})],
  ['a 500', 'an unknown outcome', ()=>new Response(JSON.stringify({error:'internal'}),{status:500,headers:{'Content-Type':'application/json'}})],
  ['a gateway timeout', 'an unknown outcome', failures.gatewayTimeout],
  ['a dropped connection', 'an unknown outcome', failures.dropped]
 ]){
  let attempts=0;
  const {api,waits}=frozenClient(async()=>{attempts++;return make();});
  await api.loginPassword('captainfixture','fixture secret passphrase').then(
   ()=>assert.fail(label+' unexpectedly answered'),
   ()=>{});
  assert.equal(attempts,1,label+' is asked once, not four times: '+failure);
  assert.deepEqual(waits,[],label+' never rests: '+failure);
 }
});

test('the wake is one request per press: a repeat would be a second machine start',async()=>{
 let attempts=0,wakes=0;
 const {api}=frozenClient(async url=>{
  attempts++;
  if(new URL(url).pathname==='/v2/game/wake'){wakes++;return failures.gatewayTimeout();}
  return new Response(JSON.stringify({state:'stopped',ready:false,endpoint:'smp.easter.company:25565',since:null,players:0,detail:''}),{status:200,headers:{'Content-Type':'application/json'}});
 });
 await api.wakeGame(TOKEN).catch(()=>{});
 assert.equal(wakes,1,'the wake itself is never repeated');
 assert.equal(attempts,1);
});

test('a 401, a 403 and a 429 are answers: they are never asked again',async()=>{
 for(const [status,body,code] of [[401,{error:'reauth_required'},'reauth_required'],[403,{error:'forbidden'},'service_403'],[429,{error:'rate_limited'},'rate_limited']]){
  let attempts=0;
  const {api,waits}=frozenClient(async()=>{attempts++;return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Retry-After':'600'}});});
  const error=await api.gameSession(TOKEN).then(()=>assert.fail('expected '+code),thrown=>thrown);
  assert.equal(error.code,code);
  assert.equal(attempts,1,status+' is the service answering, not failing');
  assert.deepEqual(waits,[],'and the launcher does not even back off for it');
 }
});

test('a service that says its own key is missing is not cold: it is not waited on',async()=>{
 for(const code of ['session_key_unconfigured','microsoft_not_configured']){
  let attempts=0;
  const {api}=frozenClient(async()=>{attempts++;return new Response(JSON.stringify({error:code}),{status:503,headers:{'Content-Type':'application/json'}});});
  const error=await api.gameSession(TOKEN).then(()=>assert.fail('expected '+code),thrown=>thrown);
  assert.equal(error.code,code);
  assert.equal(attempts,1,'a declared configuration fault cannot resolve itself by waiting');
 }
});

test('the safety decision is the declared table, and every route the client calls is in it',()=>{
 const source=readRepo('desktop/accounts.cjs');
 const routes=[...new Set([...source.matchAll(/this\.(?:call|attempt)\('(\/v2\/[^']+)'/g)].map(match=>match[1]))].sort();
 assert(routes.length>=15,'the routes are read from the code, not from this test');
 for(const route of routes)assert(OPERATIONS[route],route+' must declare whether it may be repeated, and why');
 assert.deepEqual(routes.filter(route=>!OPERATIONS[route]),[]);
 // Exactly the reads and the mint are repeatable; every write is not.
 for(const [route,operation] of Object.entries(OPERATIONS)){
  assert(['read','mint','write'].includes(operation.kind),route);
  assert.equal(operation.repeat,operation.kind!=='write',route+' repeats if and only if it is a read or the mint');
  if(operation.repeat)assert(operation.budgetMs>0,route+' declares the window it is given');
  // Every operation states why, beside itself, so the decision can be argued with rather than
  // re-derived. A route with no reason is a route nobody has thought about.
  assert.equal(typeof operation.why,'string',route+' must state its reason');
  assert(operation.why.length>20,route+'\'s reason is an argument, not a label: '+operation.why);
 }
 assert.deepEqual(Object.entries(OPERATIONS).filter(([,value])=>value.kind==='mint').map(([route])=>route),['/v2/game/session']);
});

test('what the client treats as transient is fixed: no answer and 5xx yes, a refusal and a fault no',()=>{
 const yes=[new AccountError('unreachable',UNREACHABLE_MESSAGE),Object.assign(new AccountError('service_503','x'),{status:503}),Object.assign(new AccountError('service_502','x'),{status:502}),Object.assign(new AccountError('invalid_response','x'),{status:504}),Object.assign(new AccountError('database_unavailable','x'),{databaseUnavailable:true,status:503})];
 const no=[Object.assign(new AccountError('invalid_session','x'),{status:401}),Object.assign(new AccountError('service_403','x'),{status:403}),Object.assign(new AccountError('rate_limited','x'),{status:429}),Object.assign(new AccountError('service_400','x'),{status:400}),Object.assign(new AccountError('service_404','x'),{status:404}),new AccountError('session_key_unconfigured','x'),new AccountError('microsoft_not_configured','x'),new AccountError('route_absent','x')];
 for(const error of yes)assert.equal(transientFailure(error),true,error.code+' '+(error.status||''));
 for(const error of no)assert.equal(transientFailure(error),false,error.code+' '+(error.status||''));
});

// ---- 3. the window is bounded, generous, and always under the gateway ----------
test('no single attempt outlives the gateway ceiling, and the budget is the window',async()=>{
 const attemptTimeouts=[];
 const {api}=frozenClient(async url=>{attemptTimeouts.push(url);return failures.gatewayTimeout();},{timeout:60000});
 // API Gateway's own timeout arrives as a body this launcher cannot read, which keeps the
 // status that says what happened and is retried on that status.
 await api.gameSession(TOKEN).catch(error=>assert.equal(error.code,'invalid_response'));
 // The per-attempt ceiling is the gateway's own: a longer request is answered by API Gateway
 // before the service can, so no attempt may be given more than this.
 assert.equal(RETRY_ATTEMPT_CEILING_MS,29000);
 assert.equal(GAME_SESSION_TIMEOUT_MS,RETRY_ATTEMPT_CEILING_MS,'the mint keeps its ceiling under the gateway cutoff');
 assert(attemptTimeouts.length>=2,'a dead service is tried more than once before it is believed');
 assert(attemptTimeouts.length<=RETRY_ATTEMPTS_MAX);
});

test('a spent budget is the same honest answer the launcher already had, and it stops',async()=>{
 // The clock is advanced the way a real attempt spends it: a request against a dead gateway
 // uses its whole ceiling before it gives up, so the budget — not a guess — is what ends the
 // wait. Nothing here is a new failure mode: the error the player's path already understood is
 // what comes out the far end.
 const budgets=[];
 const {api,waits,advance,time}=frozenClient(async()=>failures.dropped());
 const call=api.call.bind(api);
 api.call=async(pathname,options)=>{budgets.push(options.timeout);advance(options.timeout);return call(pathname,options);};
 const started=time();
 const error=await api.gameSession(TOKEN).then(()=>assert.fail('expected a refusal'),thrown=>thrown);
 const spent=time()-started;
 assert.equal(error.code,'unreachable','exhaustion is not a new failure mode');
 assert.equal(error.message,UNREACHABLE_MESSAGE);
 assert(budgets.length>=2,'a dead service is asked more than once before it is believed');
 assert(budgets.length<=RETRY_ATTEMPTS_MAX,'and at most the declared number of attempts: '+budgets.length);
 assert(spent<=MINT_RETRY_BUDGET_MS,'the whole wait is bounded by the declared budget: '+spent);
 assert(spent>MINT_RETRY_BUDGET_MS-RETRY_ATTEMPT_CEILING_MS,'and the budget is actually spent, not abandoned: '+spent+' of '+MINT_RETRY_BUDGET_MS);
 assert(budgets.every(ms=>ms<=RETRY_ATTEMPT_CEILING_MS),'every attempt stays under the gateway ceiling: '+budgets.join(','));
 assert.equal(budgets.at(-1),RETRY_ATTEMPT_CEILING_MS,'no attempt is ever given more than the gateway allows: '+budgets.join(','));
 assert(waits.every(ms=>ms<=RETRY_BACKOFF_MAX_MS),'the backoff is capped: '+waits.join(','));
});

test('a read gets a shorter window than the mint, so a Play press stays inside its own',async()=>{
 assert(READ_RETRY_BUDGET_MS<MINT_RETRY_BUDGET_MS);
 const {api,time}=frozenClient(async()=>failures.gatewayTimeout());
 const started=time();
 await api.gameStatus(TOKEN).catch(()=>{});
 assert(time()-started<=READ_RETRY_BUDGET_MS);
});

test('a retried attempt is given the smaller of its ceiling and what is left of the budget',async()=>{
 // A short window, so the second attempt is the remainder rather than the ceiling: the wait
 // never widens a request as the budget runs out, and never asks for longer than the gateway
 // will wait anyway.
 const budgets=[];
 const {api,advance}=frozenClient(async()=>failures.gatewayTimeout(),{retryBudget:40000});
 const call=api.call.bind(api);
 api.call=async(pathname,options)=>{budgets.push(options.timeout);advance(options.timeout);return call(pathname,options);};
 await api.gameSession(TOKEN).catch(()=>{});
 assert.deepEqual(budgets,[RETRY_ATTEMPT_CEILING_MS,40000-RETRY_ATTEMPT_CEILING_MS-RETRY_BACKOFF_MS],'the second attempt is what the window has left: '+budgets.join(','));
});

// ---- 4. the player can always give up ------------------------------------------
test('cancelling ends the wait, and the cancellation is not retried',async()=>{
 const abort=new AbortController();
 let attempts=0;
 const api=new AccountClient({
  baseUrl:'http://127.0.0.1:1',client:'launcher/1.0.1',
  request:async()=>{attempts++;return failures.gatewayTimeout();},
  // The abort lands while the launcher is backing off, which is where a player actually gives up.
  waitFor:async()=>{abort.abort();throw Object.assign(new Error('This operation was aborted'),{name:'AbortError'});}
 });
 await assert.rejects(api.gameSession(TOKEN,abort.signal),{name:'AbortError'});
 assert.equal(attempts,1,'a cancelled wait makes no further request');
});

test('a request already cancelled makes none at all',async()=>{
 const abort=new AbortController();abort.abort();
 const api=new AccountClient({baseUrl:'http://127.0.0.1:1',client:'launcher/1.0.1',request:async()=>assert.fail('a cancelled call reached the transport')});
 await assert.rejects(api.gameSession(TOKEN,abort.signal),{name:'AbortError'});
});
// ---- 5. the two sentences, and which state earns which --------------------------
// main.cjs publishes one state word while the service is being asked and one after the budget
// is spent; site/desktop.js is what turns them into the two sentences Owen reads. They are
// different sentences for different moments, which is the whole point of the two states, and
// the end-to-end proof of the sequence is cold-start.electron.mjs.
test('the hero says it is checking while it is checking, and only blames the service afterwards',()=>{
 const renderer=readRepo('site/desktop.js');
 assert(renderer.includes("if(sessionState==='checking')return {kind:'busy',label:'Checking your Minecraft session…',note:'Asking your Easter Company account'}"),'the wait keeps the checking sentence');
 assert(renderer.includes("if(sessionState==='busy')return {kind:'retry-minecraft',label:'Try again',note:'The account service is busy right now'}"),'and the verdict is the existing busy sentence');
 // The wait is a busy action with no retry offered; the verdict is the retry. A player may not
 // be handed both at once, and while the launcher is still trying there is nothing to retry.
 assert(!/checking'\)return \{kind:'retry-minecraft'/.test(renderer),'the wait never offers the verdict');
 // The verdict is reachable by a press, which is what "Try again" means.
 assert(renderer.includes("if(action.kind==='retry-minecraft')return void Promise.resolve(desktop.refreshMinecraftSession?.())"));
});
