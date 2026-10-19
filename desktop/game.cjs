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
// dot repeats. So no view words a server state for itself, no view re-derives the rule that
// turns a state into a tone, and the dot can be lost to colour blindness, to a screen
// reader or to a test that asserts only text without the state being lost with it
// (doc/launcher-states.md, *The LED and the status line*).
//
// Owen's three sentences are the ordinary cases, character for character:
//   Server Online (2 Active Players)
//   Server Asleep Zzz (0 Active Players)
//   Server Offline (Update in progress...)   <- the service's own detail, in the brackets
// and none of them is invented: gameStatusLine below is the whole rule.
const MESSAGES={
 // The player count follows, or nothing at all: a null count gets no brackets rather than
 // a false zero.
 online:'Server Online',
 // A stopped host is the credit-saving sleep the family sees every night. Normal,
 // expected, and never a fault.
 asleep:'Server Asleep Zzz',
 // Red, and only ever with a reason the service itself stated in `detail`.
 offline:'Server Offline',
 // A cold start is normal behaviour too: amber and pulsing, never red, never offline.
 starting:'Server Starting (about a minute)',
 stopping:'Server Stopping (finishing the last session)',
 // Neutral, and neither of these says a server is down: the launcher could not look, or
 // has not looked. Both are complete sentences, so neither takes a bracket of its own.
 unknown:'Server Status Unknown (the launcher could not read it just now)',
 unchecked:'Server Status Unknown (checked when you press Play)',
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
// which is silence rather than a zero.
function playerCount(count){return count===1?'1 Active Player':count+' Active Players';}
function withBrackets(line,brackets){return brackets?line+' ('+brackets+')':line;}
// The row's two halves, from the one table above: the sentence a player reads and the
// meaning the dot repeats. What decides each line, and why:
//
// - `ready` is the launcher's own readiness rule (doc/launcher-states.md), so **Online**
//   is only ever printed for a server Play would actually join. A `running` answer whose
//   port never confirmed a real Minecraft status exchange reads as starting, because that
//   is what a server still coming up looks like, and printing Online would promise a join
//   the launcher has already decided not to make.
// - a stopped server has nobody on it, so its count is 0 whatever integer it last sent.
//   `detail` is the one thing that separates the ordinary credit-saving sleep from a host
//   the service is doing something to, so a stopped server that sent one reads **Offline**
//   with the service's own words in the brackets and nothing invented in their place.
// - `unknown` is never offline and never online: the launcher says it could not look, and
//   says whether it has looked at all, so a server nobody asked about is never called down.
function gameStatusLine({state='unknown',ready=false,players=null,detail=null}={},{waking=false,checked=false}={}){
 // The cold start owns its own wait line, so these two are what that line prints.
 if(waking)return {message:state==='stopping'?MESSAGES.wakingStopping:MESSAGES.waking,tone:state==='stopping'?'stopping':'starting'};
 if(state==='running'&&ready)return {message:withBrackets(MESSAGES.online,Number.isInteger(players)?playerCount(players):''),tone:'online'};
 if(state==='stopped'){
  if(detail)return {message:withBrackets(MESSAGES.offline,detail),tone:'offline'};
  return {message:withBrackets(MESSAGES.asleep,playerCount(0)),tone:'asleep'};
 }
 if(state==='stopping')return {message:MESSAGES.stopping,tone:'stopping'};
 // `starting`, and `running` without `ready`.
 if(state==='running'||state==='starting')return {message:MESSAGES.starting,tone:'starting'};
 return {message:checked?MESSAGES.unknown:MESSAGES.unchecked,tone:'unknown'};
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
