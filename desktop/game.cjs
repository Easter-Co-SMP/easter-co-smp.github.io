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
// The server's status line: one small LED and one sentence, and nothing else. Main owns
// both halves of it: `message` is every word the player reads, `tone` is the meaning the
// LED repeats — a filled dot for a known state, a rotating ring while nothing is known
// yet. So no view words a server state for itself, no view re-derives the rule that turns a
// state into a tone, and the LED can be lost to colour blindness, to a screen reader or to
// a test that asserts only text without the state being lost with it
// (doc/launcher-states.md, *The LED and the status line*).
//
// Owen's wording, verbatim (2026-10-22, extended 2026-10-23): the row says one of four
// things and carries no technical detail at all.
//   Server Online, 2 active players
//   Server Online, 0 active players   <- also the sleeping host: asleep is not offline
//   Status pending…                   <- nothing asked yet: the LED spins, it is not Offline
//   Server Offline                    <- only for a read that happened and failed
// No brackets, no "about a minute", no service sentence, no reason. The player is told
// whether they can play and how many people are on, and nothing else: what the launcher
// knows about wake times and shutdowns belongs in its own behaviour, not in this line.
const MESSAGES={
 // The state word and, when the service sent one, its own count: `Server Online, 2 active
 // players`. Silence rather than a false zero when it sent no count at all.
 online:'Server Online',
 // Said only for a status read that happened and failed: the launcher asked, got nothing it
 // can respect, and still cannot say the server is online. A read that has not happened at
 // all is not Offline — it is `pending` below.
 offline:'Server Offline',
 // Said when nothing has been asked yet, which is the launcher's first moment on the Play
 // Now stage. The player is waiting for an answer, not being told the server is down: the
 // LED is a rotating ring for this tone, never the red dot (2026-10-23).
 pending:'Status pending…',
 // Said while this launcher is waking it and polling, which is the first player's
 // cold start: about 60-90 seconds, and the reason Play is not offered twice. These two
 // belong to the cold start's own wait line; the status row stands down for them.
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
// A count is the service's own integer and is never a list: one player is singular, and
// every other count takes the plural. `null` means the service sent no count at all,
// which is silence rather than a zero: the line then says `Server Online` and stops.
function playerCount(count){return count===1?'1 active player':count+' active players';}
function onlineLine(players){return Number.isInteger(players)?MESSAGES.online+', '+playerCount(Math.max(0,players)):MESSAGES.online;}
// The row's two halves, from the one table above: the sentence a player reads and the
// meaning the LED repeats. What decides each line, and why:
//
// - **Online is the ordinary answer, including for a host that is only asleep.** Owen's
//   rule of 2026-10-22: a stopped host is not a fault, it starts when somebody presses
//   Play, so it reads `Server Online, 0 active players` like any empty server. The dot
//   still distinguishes the sleep (dim amber) from a warm empty server (green), and no
//   view has to say anything about wake times.
// - the count is the service's own integer. A `stopped` host has nobody on it, so its
//   count is 0 whatever it last sent; a `stopping` one may still have players and keeps
//   their count.
// - **Pending is said only before anything has been asked.** `checked` is whether a status
//   read has happened in this session, and it is the whole difference between the two
//   unknown lines: nothing asked yet is `Status pending…` with a rotating ring, because the
//   player is waiting for an answer and not being told the server is down (Owen,
//   2026-10-23: *"instead of defaulting to 'Server Offline' let's show [spinner] Status
//   pending…"*).
// - **Offline is said only for a read that happened and failed.** The service's `detail`
//   decides nothing and is never printed: it sends an explanatory sentence for the ordinary
//   sleep ("the SMP host is asleep, it starts when someone presses Play"), and a
//   parenthetical like that is exactly the slop Owen removed on 2026-10-22. A stopped host
//   is online with nobody on it whether or not the service feels chatty about it.
// - `starting`, and `running` without `ready` (the instance answers but its port has not
//   confirmed a real Minecraft status exchange), are still ordinary states with nobody
//   joinable yet, so they read online with nobody on.
function gameStatusLine({state='unknown',ready=false,players=null,detail=null}={},{waking=false,checked=false}={}){
 // The cold start owns its own wait line, so these two are what that line prints.
 if(waking)return {message:state==='stopping'?MESSAGES.wakingStopping:MESSAGES.waking,tone:state==='stopping'?'stopping':'starting'};
 if(state==='running'&&ready)return {message:onlineLine(players),tone:'online'};
 if(state==='stopped')return {message:onlineLine(0),tone:'asleep'};
 if(state==='stopping')return {message:onlineLine(Number.isInteger(players)?players:0),tone:'stopping'};
 if(state==='running'||state==='starting')return {message:onlineLine(0),tone:'starting'};
 // Nothing known, which is two different things: a read that has not happened yet is
 // pending (a spinning ring), and a read that happened and failed is Offline.
 if(!checked)return {message:MESSAGES.pending,tone:'pending'};
 return {message:MESSAGES.offline,tone:'offline'};
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
module.exports={endpointMatches,GameWaitError,sanitizeGameStatus,sanitizeSince,gameStatusLine,wakeServer,MESSAGES,GAME_STATES,serverAddress,GAME_POLL_MS,GAME_WAKE_TIMEOUT_MS};
