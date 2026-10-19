const test=require('node:test'),assert=require('node:assert/strict');
const {GameWaitError,sanitizeGameStatus,sanitizeEndpoint,sanitizeSince,gameMessage,MESSAGES,GAME_POLL_MS,GAME_WAKE_TIMEOUT_MS}=require('../../desktop/game.cjs');
const {AccountClient}=require('../../desktop/accounts.cjs');
const {GAME_ENDPOINT}=require('../../desktop/config.cjs');
// The cloud side of the game-server contract does not exist yet, so the two routes are
// proven against a loopback stub (tests/desktop/stub-game-api.mjs) and the wait rule is
// proven against a fake clock. Nothing here touches the account API origin or a real
// server, and no token is printed or asserted on.
let stubApi;
test.before(async()=>{stubApi=await import('./stub-game-api.mjs');});

// ---- helpers ---------------------------------------------------------------
const answer=(state,extra={})=>({ok:true,status:sanitizeGameStatus({state,ready:extra.ready===undefined?state==='running':extra.ready,...extra})});
const noAnswer=code=>({ok:false,code});
// A clock whose sleep passes time instead of waiting, so a 180 s rule is provable in
// milliseconds and the poll interval can be asserted exactly.
function fakeClock(){
 let time=0;const sleeps=[];
 return {
  sleeps,
  now:()=>time,
  sleep:(ms,signal)=>new Promise((resolve,reject)=>{
   if(signal?.aborted)return reject(Object.assign(Error('Cancelled'),{name:'AbortError'}));
   sleeps.push(ms);time+=ms;resolve();
  })
 };
}
// One scripted sequence of answers, consumed by success in the order given; the last
// one repeats. `read` and `wake` share the sequence, exactly as the stub serves both
// routes from one state.
function scripted(answers){
 const list=answers.map(entry=>typeof entry==='string'?answer(entry):entry);
 const take=()=>list.length>1?list.shift():list[0];
 const api={reads:0,wakes:0};
 api.read=async()=>{api.reads++;return take();};
 api.wake=async()=>{api.wakes++;return take();};
 return api;
}
async function engine(api,clock,extra={}){
 return wakeServerOf(api,clock,extra);
}
// The module's own engine, named once so the helper above stays readable.
function wakeServerOf(api,clock,{timeoutMs=GAME_WAKE_TIMEOUT_MS,pollMs=GAME_POLL_MS,onUpdate,signal}={}){
 const {wakeServer}=require('../../desktop/game.cjs');
 return wakeServer({read:api.read,wake:api.wake,now:clock.now,sleep:clock.sleep,timeoutMs,pollMs,onUpdate,signal});
}
function client(origin){return new AccountClient({baseUrl:origin,client:'launcher/1.0.1'});}

// ---- the frozen shape ------------------------------------------------------
test('every frozen state word is accepted and readiness is never inferred',()=>{
 for(const state of ['running','starting','stopping','stopped','unknown']){
  const status=sanitizeGameStatus(stubApi.statusBody({state}));
  assert.equal(status.state,state);
  assert.equal(status.ready,state==='running','only a running server is ready');
 }
 // ready is the only field that authorises a launch, so a body that claims it for a
 // server that is not running is refused rather than believed.
 for(const state of ['starting','stopping','stopped','unknown'])assert.equal(sanitizeGameStatus({state,ready:true}).ready,false);
 assert.equal(sanitizeGameStatus({state:'running',ready:true}).ready,true);
 assert.equal(sanitizeGameStatus({state:'running',ready:'yes'}).ready,false,'a truthy string is not a ready flag');
});

test('a body that is not the frozen shape is no answer at all',()=>{
 for(const body of [null,undefined,[],'{"state":"running"}',42,{},{ready:true},{state:42}])assert.equal(sanitizeGameStatus(body),null,JSON.stringify(body));
 // An unrecognised state word is an answer the launcher will not act on: unknown.
 assert.equal(sanitizeGameStatus({state:'hibernating'}).state,'unknown');
 assert.equal(sanitizeGameStatus({state:'hibernating',ready:true}).ready,false);
});

test('endpoint, since, players and detail are bounded, and nothing else is kept',()=>{
 assert.equal(sanitizeEndpoint('smp.easter.company:25565'),'smp.easter.company:25565');
 assert.equal(sanitizeEndpoint('127.0.0.1:25565'),'127.0.0.1:25565');
 for(const value of ['smp.easter.company','smp.easter.company:0','smp.easter.company:70000','http://smp.easter.company:25565','',null,'a'.repeat(300)+':25565'])assert.equal(sanitizeEndpoint(value),null,String(value));
 assert.equal(sanitizeSince('2026-10-18T00:00:00Z'),'2026-10-18T00:00:00Z');
 for(const value of ['whenever','2026-10-18',123])assert.equal(sanitizeSince(value),null,String(value));
 const status=sanitizeGameStatus({state:'running',players:3,since:'2026-10-18T00:00:00Z',endpoint:GAME_ENDPOINT,detail:'  Warming up  ',token:'must-not-travel'});
 assert.deepEqual(Object.keys(status).sort(),['detail','endpoint','players','ready','since','state']);
 assert.equal(status.players,3);
 assert.equal(status.detail,'Warming up');
 assert.equal(status.token,undefined,'an unknown field never reaches the state');
 const odd=sanitizeGameStatus({state:'running',players:-1,detail:42,endpoint:'nonsense'});
 assert.equal(odd.players,null);
 assert.equal(odd.detail,null);
 assert.equal(odd.endpoint,GAME_ENDPOINT,'an unusable endpoint falls back to the frozen address');
 assert.equal(sanitizeGameStatus({state:'running',detail:'x'.repeat(400)}).detail.length,200);
});

test('the copy says what is true and never calls an unlooked-at server offline',()=>{
 assert.equal(gameMessage({state:'unknown'},{checked:false}),MESSAGES.unchecked);
 assert.equal(gameMessage({state:'unknown'},{checked:true}),MESSAGES.unknown);
 assert.equal(gameMessage({state:'stopped'},{checked:true}),MESSAGES.stopped);
 assert.equal(gameMessage({state:'starting'},{checked:true}),MESSAGES.starting);
 assert.equal(gameMessage({state:'stopping'},{checked:true}),MESSAGES.stopping);
 assert.equal(gameMessage({state:'running',ready:true},{checked:true}),MESSAGES.running);
 assert.equal(gameMessage({state:'stopped'},{checked:true,waking:true}),MESSAGES.waking);
 assert.equal(gameMessage({state:'stopping'},{checked:true,waking:true}),MESSAGES.wakingStopping);
 // No sentence about the server may name an account, a purchase or an install: a
 // stopped server is never presented as an account problem. The one exception is the
 // expired session, which really is the account's news and keeps the account's words.
 for(const [name,sentence] of Object.entries(MESSAGES).filter(([name])=>name!=='session'))
  assert(!/sign in|account|password|purchase|buy/i.test(sentence),sentence);
 assert.equal(GAME_POLL_MS,3000,'readiness is polled every three seconds');
 assert.equal(GAME_WAKE_TIMEOUT_MS,180000,'the wait fails honestly after three minutes');
});

// ---- the wait rule ---------------------------------------------------------
test('a warm server is joined at once: no wake, no wait, no prompt',async()=>{
 const clock=fakeClock(),api=scripted(['running']),updates=[];
 const result=await wakeServerOf(api,clock,{onUpdate:value=>updates.push(value)});
 assert.equal(result.outcome,'ready');
 assert.equal(api.wakes,0,'a running server is never woken');
 assert.deepEqual(clock.sleeps,[],'and nothing is waited for');
 assert.equal(updates[0].waking,false);
});

test('a stopped server is woken exactly once and joined the moment it is ready',async()=>{
 const clock=fakeClock(),api=scripted(['stopped','starting','starting','starting','running']),updates=[];
 const result=await wakeServerOf(api,clock,{onUpdate:value=>updates.push(value)});
 assert.equal(result.outcome,'ready');
 assert.equal(api.wakes,1,'one Play, one wake');
 assert.deepEqual(clock.sleeps,[3000,3000,3000],'readiness is polled every three seconds');
 assert.equal(updates.at(-1).status.ready,true);
 assert(updates.some(update=>update.waking===true),'the state says the server is being started');
});

test('stopping is never woken and never joined',async()=>{
 // It goes down, then comes back: the launcher waits it out and launches on ready.
 const clock=fakeClock(),api=scripted(['stopping','stopping','stopping','running']);
 const result=await wakeServerOf(api,clock);
 assert.equal(result.outcome,'ready');
 assert.equal(api.wakes,0,'a stopping server is not a stopped one');
 // And a stopping server that never comes back fails honestly instead of joining.
 const stuckClock=fakeClock(),stuck=scripted(['stopping']);
 const error=await wakeServerOf(stuck,stuckClock).then(()=>assert.fail('expected a timeout'),thrown=>thrown);
 assert.equal(error.code,'game_wake_timeout');
 assert.equal(stuck.wakes,0,'no wake storm against a server that is still stopping');
 assert(Math.max(...stuckClock.sleeps)<=3000,'the wait polls rather than blocking');
});

test('a wake that answers with the first poll is acted on without waiting',async()=>{
 const clock=fakeClock(),api=scripted(['stopped','running']);
 const result=await wakeServerOf(api,clock);
 assert.equal(result.outcome,'ready');
 assert.equal(api.wakes,1);
 assert.deepEqual(clock.sleeps,[],'the wake answer is already an answer');
});

test('three minutes without readiness fails honestly, with one wake and no launch',async()=>{
 const clock=fakeClock(),api=scripted(['stopped']),updates=[];
 const error=await wakeServerOf(api,clock,{onUpdate:value=>updates.push(value)}).then(()=>assert.fail('expected a timeout'),thrown=>thrown);
 assert(error instanceof GameWaitError);
 assert.equal(error.name,'GameWaitError');
 assert.equal(error.code,'game_wake_timeout');
 assert.equal(error.message,MESSAGES.timeout);
 assert.equal(api.wakes,1,'a timeout never starts a second wake');
 assert.equal(clock.now()>=GAME_WAKE_TIMEOUT_MS,true,'the deadline is three minutes');
 assert(clock.sleeps.every(ms=>ms>0&&ms<=3000),'every poll is three seconds or the last, shortened step');
 assert.equal(updates.at(-1).status.state,'stopped','the last thing said was the last thing known');
});

test('no answer at all is unknown, with no wake and no invented cold start',async()=>{
 const clock=fakeClock(),api=scripted([noAnswer('unreachable')]);
 const result=await wakeServerOf(api,clock);
 assert.equal(result.outcome,'unknown');
 assert.equal(result.status,null);
 assert.equal(api.wakes,0,'a service nobody can reach is asked nothing');
 assert.deepEqual(clock.sleeps,[]);
});

test('an expired account session keeps its own sentence and is never dressed as a server fault',async()=>{
 const clock=fakeClock(),api=scripted([noAnswer('invalid_session')]);
 const error=await wakeServerOf(api,clock).then(()=>assert.fail('expected a refusal'),thrown=>thrown);
 assert.equal(error.code,'game_session_expired');
 assert.equal(error.message,MESSAGES.session);
 assert.equal(api.wakes,0);
 // The same refusal from the wake itself.
 const late=fakeClock(),refused=scripted(['stopped',noAnswer('invalid_session')]);
 const lateError=await wakeServerOf(refused,late).then(()=>assert.fail('expected a refusal'),thrown=>thrown);
 assert.equal(lateError.code,'game_session_expired');
 assert.equal(refused.wakes,1);
});

test('a cancellation stops the wait instead of leaving a poll running behind it',async()=>{
 // play() aborts the wait when the press does not reach a launch (a sign-in the player
 // has to redo, a refused install), so nothing keeps polling behind the dialog.
 const controller=new AbortController();
 const clock={now:()=>0,sleep:()=>{controller.abort();return Promise.reject(Object.assign(Error('Cancelled'),{name:'AbortError'}));}};
 const api=scripted(['stopped']);
 const error=await wakeServerOf(api,clock,{signal:controller.signal}).then(()=>assert.fail('expected a cancellation'),thrown=>thrown);
 assert.equal(error.name,'AbortError','a cancellation is not a failure sentence');
 assert.equal(controller.signal.aborted,true);
 assert.equal(api.wakes,1,'the wake already sent is not repeated after the cancellation');
});

// ---- the real client against the loopback stub -----------------------------
test('the account client reads the status with the Company session and no other credential',async()=>{
 const stub=await stubApi.startGameStub({state:'running',players:2});
 try{
  const status=await client(stub.origin).gameStatus(stubApi.TOKEN);
  assert.deepEqual(status,{state:'running',ready:true,endpoint:stubApi.ENDPOINT,since:'2026-10-18T00:00:00Z',players:2,detail:null});
  assert.equal(stub.calls.length,1);
  assert.equal(stub.calls[0].method,'GET');
  assert.equal(stub.calls[0].url,'/v2/game/status');
  assert.equal(stub.calls[0].authorization,'Bearer '+stubApi.TOKEN,'the existing Company session token authenticates it');
  assert.equal(stub.wakes.length,0,'reading the status never wakes anything');
 }finally{await stub.close();}
});

test('a stopped server is woken once over HTTP and joined when the stub turns ready',async()=>{
 const stub=await stubApi.startGameStub({state:'stopped',script:['stopped','starting','starting','running']});
 try{
  const api=client(stub.origin);
  const result=await require('../../desktop/game.cjs').wakeServer({
   read:async()=>({ok:true,status:await api.gameStatus(stubApi.TOKEN)}),
   wake:async()=>({ok:true,status:await api.wakeGame(stubApi.TOKEN)}),
   pollMs:20,timeoutMs:4000
  });
  assert.equal(result.outcome,'ready');
  assert.equal(result.status.ready,true);
  assert.equal(stub.wakes.length,1,'exactly one wake for the one Play press');
  assert.equal(stub.wakes[0].method,'POST');
  assert.equal(stub.wakes[0].url,'/v2/game/wake');
  assert.equal(stub.wakes[0].authorization,'Bearer '+stubApi.TOKEN);
  assert.deepEqual(Object.keys(JSON.parse(stub.wakes[0].body)),['client'],'the wake carries the client name and nothing else');
  const paths=stub.calls.map(call=>call.method+' '+call.url);
  assert.equal(paths[0],'GET /v2/game/status');
  assert.equal(paths[1],'POST /v2/game/wake');
  assert(paths.slice(2).every(path=>path==='GET /v2/game/status'),'after the wake the launcher only polls');
 }finally{await stub.close();}
});

test('an accepted wake with no body is not mistaken for an answer',async()=>{
 const stub=await stubApi.startGameStub({state:'stopped',wakes:'empty',script:['stopped']});
 try{
  const api=client(stub.origin);
  const answer=await api.wakeGame(stubApi.TOKEN);
  assert.equal(answer,null,'a body-less acceptance is no answer');
  assert.equal(stub.wakes.length,1);
 }finally{await stub.close();}
});

test('an unreachable or refusing service is unknown, and its token never leaks',async()=>{
 const stub=await stubApi.startGameStub({state:'running'});
 const origin=stub.origin;
 await stub.close();
 const error=await client(origin,{timeout:1500}).gameStatus(stubApi.TOKEN).then(()=>assert.fail('expected a refusal'),thrown=>thrown);
 assert.equal(error.code,'unreachable');
 assert(!JSON.stringify({message:error.message,code:error.code,stack:String(error.stack)}).includes(stubApi.TOKEN));
 // A 5xx and a malformed body are the same kind of thing: no answer.
 const broken=await stubApi.startGameStub({statusError:503});
 try{
  const refused=await client(broken.origin).gameStatus(stubApi.TOKEN).then(()=>assert.fail('expected a refusal'),thrown=>thrown);
  assert.equal(refused.code,'service_503');
 }finally{await broken.close();}
});

test('the wake refuses a session the service does not accept',async()=>{
 const stub=await stubApi.startGameStub({state:'stopped'});
 try{
  const error=await client(stub.origin).wakeGame('some-other-token').then(()=>assert.fail('expected a refusal'),thrown=>thrown);
  assert.equal(error.code,'invalid_session','a 401 is the account session expiring, not a server fault');
  assert(!JSON.stringify({message:error.message,code:error.code}).includes('some-other-token'));
 }finally{await stub.close();}
});
