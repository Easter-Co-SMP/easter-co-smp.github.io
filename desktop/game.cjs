'use strict';
// The Easter Co. game server, as the launcher sees it. Main process only: the
// renderer never asks for a status and never wakes anything, it renders the
// `game` field of the ordinary state broadcast (doc/launcher-states.md).
//
// The service is the account API's own origin and its own session token; the transport
// and the two routes live in accounts.cjs (its gameStatus and wakeGame methods), so there
// is one HTTP client in this launcher, not two.
// Everything in this module is pure or clock-injected, so tests/desktop/wake.test.cjs
// can prove the whole wake rule without a network and without Electron.
const {GAME_STATES,serverAddress,GAME_POLL_MS,GAME_WAKE_TIMEOUT_MS,GAME_DETAIL_MAX}=require('./config.cjs');
// The address the launcher joins comes from the validated deployment metadata.
// A service endpoint can confirm that target, never redirect the launch elsewhere.
// The account service's own wording for an expired session is restated in this table,
// so this module needs no import from accounts.cjs (which imports this one).
// One table of copy, so every surface reads the same sentence and no view composes
// its own. These are the launcher's words about the game server; none of them says
// anything about an account, a purchase or a client install, because a server that is
// off is not an account problem. `detail` from the service is shown beside them when
// the service sends one.
const MESSAGES={
 running:'Your server is online.',
 starting:'Your server is starting. This takes about a minute.',
 stopping:'Your server is finishing its last session. It is never joined while it stops.',
 stopped:'Your server is offline right now. Play starts it.',
 unknown:'The launcher could not read the game server status just now.',
 // Said only when no status has ever been asked for in this launcher session, so the
 // player is never told a server is off when nobody has looked.
 unchecked:'Your server is checked when you press Play.',
 // Said while this launcher is waking it and polling, which is the first player's
 // cold start: about 60-90 seconds, and the reason Play is not offered twice.
 waking:'Starting your server… the first player in a session waits about a minute.',
 wakingStopping:'Your server is finishing its last session. It starts as soon as that is done.',
 // The failures. They leave this module as a GameWaitError and reach the player
 // through the page notice, with Play as the retry.
 timeout:'Your server did not become joinable within three minutes. Press Play to try it again.',
 session:'Your Easter Company session expired. Sign in again.',
 target:'The game server address could not be confirmed. Try again shortly.',
 unavailable:'The game server status could not be checked. Try Play again shortly.'
};
// ISO-8601 only, kept as the string the service wrote: the launcher never re-times a
// server's own clock, and a value it cannot parse is dropped rather than shown.
function sanitizeSince(value){
 if(typeof value!=='string')return null;
 const since=value.trim();
 if(!since||since.length>40||Number.isNaN(Date.parse(since)))return null;
 return /^\d{4}-\d{2}-\d{2}T/.test(since)?since:null;
}
function sanitizeDetail(value){
 if(typeof value!=='string')return null;
 const detail=value.trim();
 return detail?detail.slice(0,GAME_DETAIL_MAX):null;
}
// What the service answered, in the frozen shape, or null when it answered nothing
// the launcher is willing to call an answer. `ready` is the only field that authorises
// a launch and it is never inferred: a body that claims readiness for a server that is
// not running is refused, because the port answering a real Minecraft status exchange
// is the server being running.
function endpointMatches(endpoint){
 // Older APIs omitted the endpoint; current APIs must describe the very target
 // the manifest selected. A mismatch never redirects the client to another host.
 if(endpoint===undefined||endpoint===null)return true;
 if(typeof endpoint!=='string')return false;
 const key=value=>{const address=String(value).toLowerCase();return address.includes(':')?address:address+':25565';};
 return key(endpoint)===key(serverAddress());
}
function sanitizeGameStatus(payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
 // A body that does not even name a state is not an answer, however well formed the
 // rest of it is: the launcher would be inventing the one word it acts on.
 if(typeof payload.state!=='string')return null;
 const state=GAME_STATES.includes(payload.state)?payload.state:'unknown';
 const players=Number.isInteger(payload.players)&&payload.players>=0&&payload.players<=10000?payload.players:null;
 return {
  state,
  ready:payload.ready===true&&state==='running'&&endpointMatches(payload.endpoint),
  // Publish the manifest target; disagreement with the service refuses readiness.
  endpoint:serverAddress(),
  since:sanitizeSince(payload.since),
  players,
  detail:sanitizeDetail(payload.detail)
 };
}
// The one sentence for the state a view renders. `checked` is what separates "we have
// not looked" from "we looked and could not reach the service", so the launcher never
// asserts an offline server it never asked about.
function gameMessage({state='unknown',ready=false}={},{waking=false,checked=false}={}){
 if(waking)return state==='stopping'?MESSAGES.wakingStopping:MESSAGES.waking;
 if(!checked&&state==='unknown')return MESSAGES.unchecked;
 if(ready&&state==='running')return MESSAGES.running;
 return MESSAGES[state]||MESSAGES.unknown;
}
class GameWaitError extends Error{
 constructor(code,message){super(message);this.name='GameWaitError';this.code=code;}
}
function abortError(){return Object.assign(Error('Cancelled'),{name:'AbortError'});}
function defaultSleep(ms,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(abortError());
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
  const onAbort=()=>{clearTimeout(timer);reject(abortError());};
  signal?.addEventListener('abort',onAbort,{once:true});
 });
}
// One Play press, one answer.
//
// `read` and `wake` are the two routes, injected: each resolves to {ok:true,status}
// (the sanitized shape, possibly with state 'unknown') or {ok:false,code} when the
// service did not answer at all. Everything else here is the rule:
//
// 1. Ask once. A server that answers ready is joined immediately, exactly as the
//    launcher joined it before this feature existed: no wake, no prompt, no wait.
// 2. An unreadable or unknown answer refuses launch and leaves Play as the retry.
//    The deployed control service must confirm readiness; there is no bare join.
// 3. An answer that is not ready is respected. `stopping` is waited out and never
//    woken and never joined; everything else is woken exactly once, then polled every
//    GAME_POLL_MS until the server answers ready, and the caller launches straight
//    away so the player never presses Play a second time.
// 4. If it is still not joinable at the deadline the wait fails honestly, with no
//    launch, and Play stays available as the retry.
async function wakeServer({read,wake,onUpdate=()=>{},signal,now=Date.now,sleep=defaultSleep,timeoutMs=GAME_WAKE_TIMEOUT_MS,pollMs=GAME_POLL_MS}={}){
 if(typeof read!=='function'||typeof wake!=='function')throw Error('A game status client is required.');
 const deadline=now()+timeoutMs;
 let known=null,answered=false,sent=false;
 const report=waking=>onUpdate({status:known,waking,sent});
 // A refusal of the account session is not a game status problem, and it is never
 // dressed as one: the session really is expired, so its own sentence is thrown.
 const call=async(fn)=>{
  const result=await fn();
  if(!result||result.ok!==true){
   if(result?.code==='game_target_mismatch')throw new GameWaitError('game_target_mismatch',MESSAGES.target);
   if(result?.code==='invalid_session')throw new GameWaitError('game_session_expired',MESSAGES.session);
   return false;
  }
  if(!result.status)return false;
  answered=true;
  known=result.status;
  return true;
 };
 await call(read);
 report(false);
 if(!answered)throw new GameWaitError('game_status_unavailable',MESSAGES.unavailable);
 while(true){
  if(known.state==='unknown')throw new GameWaitError('game_status_unavailable',MESSAGES.unavailable);
  if(known.ready)return {outcome:'ready',status:known,woke:sent};
  // `stopping` is a server on its way down: waking it would be a second shutdown in
  // the way, and joining it is not possible. Wait for the state to change instead.
  if(known.state!=='stopping'&&!sent){
   sent=true;
   const answeredWake=await call(wake);
   report(true);
   if(answeredWake)continue;
  }
  if(now()>=deadline)throw new GameWaitError('game_wake_timeout',MESSAGES.timeout);
  await sleep(Math.min(pollMs,Math.max(1,deadline-now())),signal);
  await call(read);
  report(true);
  if(!known.ready&&now()>=deadline)throw new GameWaitError('game_wake_timeout',MESSAGES.timeout);
 }
}
module.exports={endpointMatches,GameWaitError,sanitizeGameStatus,sanitizeSince,gameMessage,wakeServer,MESSAGES,GAME_STATES,serverAddress,GAME_POLL_MS,GAME_WAKE_TIMEOUT_MS};
