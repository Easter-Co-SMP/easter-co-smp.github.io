'use strict';
const {setTimeout:delay}=require('node:timers/promises');
const {randomUUID,createHash}=require('node:crypto');
const {appendFileSync,mkdirSync,statSync,renameSync}=require('node:fs');
const path=require('node:path');
const {LoopbackRedirect,pkcePair,stateToken,LOOPBACK_TIMEOUT_MS,REGISTERED_REDIRECT}=require('./loopback.cjs');
const AUTHORITY='https://login.microsoftonline.com/consumers/oauth2/v2.0';
// ---- NOBODY COPIES A CODE ANY MORE ----------------------------------------------
// This file used to sign in with the device code flow: ask Microsoft for a code, show the
// player the code, send them to a page and have them type it in. Owen's ask was to delete
// that step ("removing the step which requires the user to copy and paste the code manually
// would also be great"), so the code is acquired the way every native application acquires
// one: the launcher opens the player's own browser at Microsoft's sign-in page, Microsoft
// hands the answer back to a loopback socket this process is listening on for exactly one
// request, and the code is exchanged with a PKCE S256 verifier that never left memory.
// `desktop/loopback.cjs` owns that socket and says in one place what it accepts; the only
// things this file adds are the authorize address, the registration check below, and the
// exchange itself. Everything downstream — Xbox Live, XSTS, Minecraft — is untouched.
// Both resources are asked for in one consent: Xbox Live, which is what signs in to
// Xbox Live, and User.Read, which the account service needs to read the Microsoft
// account's own email. Microsoft — not the launcher — decides which resource a token is
// minted for, so nothing below assumes the authorize answer is already an Xbox Live
// token: xboxSignIn proves that from the token's own claims and reissues it when it
// cannot. The Graph token is requested separately, below, and is transient: it is never
// stored, never logged and never leaves this process except on the one account request
// that carries it.
// ONE RESOURCE, ONE REQUEST. Xbox Live and Microsoft Graph are different resources, and
// Microsoft's token endpoint refuses a code exchange whose granted scopes span both.
// Measured, not guessed: this string carried the Graph scope from 1.0.22 to 1.0.25 and
// every fresh Microsoft sign-in in that window failed with `400 invalid_scope` at code
// completion (signin.log, 2026-10-18T22:10 and 2026-10-19T06:53) - the sign-in request is
// accepted, the sign-in is completed, and then the exchange is refused, which is why it
// looked like a failure after Microsoft had already said yes. The Graph token is requested
// on its own afterwards, with the refresh token this exchange returns, and
// graphAccessToken tolerates every way that can fail.
const SCOPE='XboxLive.signin offline_access';
const GRAPH_SCOPE='https://graph.microsoft.com/User.Read';
// The one scope a token must have been minted for before it may be presented to
// user.auth.xboxlive.com. It is asked for on its own when the token in hand cannot
// prove it (see xboxSignIn).
const XBOX_SCOPE='XboxLive.signin';
// ---- A REFRESH TOKEN IS SPENT BY USING IT, SO EVERY GRANT ASKS FOR THE NEXT ONE --------
// Microsoft's refresh tokens are single use: the token a grant sends is invalidated by that
// grant, and the replacement comes back in the answer ONLY when the request asked for
// offline_access. Both of the grants below once asked for a resource and nothing else, so
// each one spent the only refresh token this launcher had and threw the successor away —
// and the token it then kept, vaulted, and handed to the account service was the one
// Microsoft had just destroyed. The account service sealed it, the first mint met
// `invalid_grant`, the stored row was revoked and wiped, and every later mint for account 34
// answered `absent` (CloudWatch /aws/lambda/easter-accounts-api, 2026-10-22 08:49-21:37:
// five mints, all `outcome=absent`), which the service reports to the launcher as
// `401 reauth_required` — Owen's "Reconnect Microsoft" on every launch, four days running.
//
// So the rule in this file is one sentence: NO REQUEST MAY SPEND A REFRESH TOKEN WITHOUT
// ASKING FOR ITS SUCCESSOR. Both grants add offline_access, which is not a resource and
// cannot make the request span two of them (the `400 invalid_scope` below is about two
// resources, not about this), and every answer's `refresh_token` replaces the one in hand.
const OFFLINE_ACCESS='offline_access';
const XBOX_REQUEST_SCOPE=XBOX_SCOPE+' '+OFFLINE_ACCESS;
const GRAPH_REQUEST_SCOPE=GRAPH_SCOPE+' '+OFFLINE_ACCESS;
// Same public client configuration as /opt/minecraft/launch/mc-auth.py.
// Microsoft displays Prism Launcher for this inherited registration.
// Set EASTER_MICROSOFT_CLIENT_ID when Easter Company has its own approved registration.
const DEFAULT_CLIENT_ID='c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
// The most requests the registration check will ever make, and the only hosts it will follow
// one to: the consumers authority hands the question to its own consumer sign-in host, and
// nothing else is ever asked.
const REGISTRATION_HOPS=2;
const REGISTRATION_HOSTS=Object.freeze(['login.microsoftonline.com','login.live.com']);
// How much of a refused page the registration check will read before deciding. The page is
// Microsoft's own error page, a few kilobytes; this is only here so an answer that is not
// one cannot be read forever.
const REGISTRATION_PAGE_LIMIT=65536;
// A sign-in that never came back, said so that a player who closed the tab can act on it and
// an owner whose app registration is missing the callback address can too. The address named
// is the one that has to be registered, without a port: Microsoft ignores the port of a
// localhost redirect URI when it matches one (desktop/loopback.cjs).
const TIMEOUT_CAUSE={detail:'the Microsoft sign-in page was not completed',advice:'Start sign-in again. If the browser showed a Microsoft error page instead of a sign-in page, add '+REGISTERED_REDIRECT+' as a redirect URI on the Microsoft app registration.'};
function abortFromSignal(){
 const error=Error('The sign-in was cancelled.');
 error.name='AbortError';
 return error;
}
// A token's audience is proven to be Xbox Live's only by an Xbox Live relying party;
// anything else is not proof and is reissued before it is used.
const XBOX_AUDIENCE=/^https?:\/\/([a-z0-9-]+\.)*xboxlive\.com\/?$/i;
class AuthError extends Error{constructor(message,code,step){super(message);this.code=code;if(step)this.step=step;}}

// ---- The six steps of a sign-in -------------------------------------------------
// One step, one sentence, one log line. The sentence names the step so a screenshot says
// which leg failed; the log says the same thing in one line for the owner to read later.
// The two are written for two different readers, and that is the whole point of this
// block: the sentence goes to a player who cannot act on a provider code, so it carries
// no HTTP status, no AAD error string, no XErr number and no internal step name. The log
// carries all of those, which is where an owner diagnoses from. A token, a refresh token,
// an authorization code, a PKCE verifier, an email address and the response body never
// appear in either, which is why nothing below interpolates a value it has not
// whitelisted first. Every sentence is free of the word "token" on purpose: main.cjs's
// safeError() replaces any message that contains it with a generic refusal.
//
// `browser-sign-in` is the step that used to be `device-code`: the launcher opening
// Microsoft's sign-in page in the player's own browser. The name changed with the flow, so
// a line in the log from either era still says which leg it was.
//
// `reach` is how the step reads in a sentence about a connection that never arrived,
// because "Xbox Live did not accept the sign-in: the connection failed" would claim a
// refusal that never happened. That sentence also leads the way every other sentence does
// and names what could not be reached, so it never repeats the verb the way "sign-in
// stopped while signing in to Xbox Live" did. It is still the same step in plain words,
// and still one sentence per step.
const STEPS={
 'browser-sign-in':{title:'Microsoft sign-in',verb:'could not start',advice:'Try again.',reach:'the Microsoft sign-in page'},
 'code-completion':{title:'Microsoft sign-in',verb:'did not finish',advice:'Start sign-in again.',reach:'Microsoft to finish the sign-in'},
 'xbox-live':{title:'Xbox Live',verb:'did not accept the Microsoft sign-in',advice:'Try again.',reach:'Xbox Live'},
 xsts:{title:'Xbox Live authorisation',verb:'did not accept the sign-in',advice:'Try again.',reach:'Xbox Live to authorise the sign-in'},
 minecraft:{title:'Minecraft sign-in',verb:'failed',advice:'Try again.',reach:'the Minecraft service'},
 'java-profile':{title:'The Java profile',verb:'could not be read',advice:'Try again.',reach:'the Java profile service'}
};
// Kept for a step the launcher does not know, and for that alone.
const GENERIC='Sign-in could not finish. Please try again.';
// An Xbox Live refusal that has a cause the player can act on: the cause is what the
// sentence says, and the number it arrived as stays on the log line for the owner. Each
// cause carries its own instruction rather than the step's shared "Try again.", because
// retrying is the one thing that does not help with any of them: an account with no Xbox
// profile, one in a country Xbox Live does not serve, one that has not verified its age
// and one waiting for Microsoft Family approval all fail again the same way. Two numbers
// word one cause, because age verification is one thing to go and finish.
// The country cause is the one a player cannot settle in place: an account's country is
// not something the launcher can change and, for most accounts, not something the player
// can change at all. Its sentence therefore names the property and then the only thing
// that clears it, a different Microsoft account — the same move the access panel already
// offers as "Use a different account" — instead of sending the player off to change a
// country they cannot change.
const AGE_UNVERIFIED={detail:'this Microsoft account has not completed its age verification',advice:'Finish the age verification at xbox.com, then sign in again.'};
const XERR={
 2148916233:{detail:'this Microsoft account does not have an Xbox profile yet',advice:'Create an Xbox profile for this account at xbox.com, then sign in again.'},
 2148916235:{detail:'Xbox Live is not available in this account’s country',advice:'Sign in with a different Microsoft account.'},
 2148916236:AGE_UNVERIFIED,
 2148916237:AGE_UNVERIFIED,
 2148916238:{detail:'this account is waiting for Microsoft Family approval',advice:'Ask your Microsoft Family organiser to approve Minecraft for this account, then sign in again.'}
};
// Only these characters may reach a sentence or the log. A provider code is a short
// identifier (invalid_grant, UNAUTHORIZED, XErr2148916238); anything else is dropped
// rather than echoed, so a value derived from a credential cannot be written out. A code
// is kept for the log, never for the sentence: the service's own answers are named below
// in words a player can use.
function clean(value,limit=48){
 const text=typeof value==='string'?value.trim():'';
 return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)&&text.length<=limit?text:'';
}
// What the player is told, and never how the provider labelled it. The five answers a
// person can tell apart stay apart: a sign-in that has expired, a refusal with an
// explanation, a refusal without one, a service in trouble, and no answer at all. An
// answer with a cause the player can act on also carries that cause's own instruction;
// every other answer returns a cause only and takes the step's advice.
//
// `fresh` says the refusal belongs to a sign-in the player has just made, which has no
// saved session behind it, so an `invalid_grant` there is a refused code and not an
// expired one. It used to be decided by the step's own name, because only one route could
// produce it; now the fresh route is the browser sign-in's exchange and the saved route is
// `refresh`, and both are the `code-completion` step.
function reason({status,code,xerr,unreadable,step,fresh=false}={}){
 if(Number.isInteger(xerr))return XERR[xerr]||{detail:'Xbox Live refused this sign-in'};
 const provider=clean(code);
 // A refused refresh grant is a saved sign-in that has expired; the same answer on a
 // fresh sign-in is not, because a fresh sign-in has nothing saved behind it.
 if(provider==='invalid_grant'&&!fresh)return {detail:'your saved sign-in has expired'};
 if(Number.isInteger(status)&&status>=500)return {detail:'the sign-in service is having trouble right now'};
 if(unreadable)return {detail:'the sign-in service refused it without saying why'};
 if(provider||Number.isInteger(status))return {detail:'the sign-in service refused it'};
 return {detail:'no readable answer came back'};
}
// One sentence from a cause and, when it has one, that cause's own instruction: "Try
// again." is advice for a refusal with no known cause, not for a cause that says what to
// do. A plain string is still accepted as the cause alone.
function sentence(step,detail){
 const name=STEPS[step];
 if(!name)return GENERIC;
 const cause=detail&&typeof detail==='object'?detail:{detail};
 return name.title+' '+name.verb+': '+cause.detail+'. '+(cause.advice||name.advice);
}
// A failure to reach anything is not a refusal: nothing was asked, so nothing refused it.
function reachedSentence(step){
 const name=STEPS[step];
 return name?'Minecraft sign-in failed: the launcher could not reach '+name.reach+'. Check your connection and try again.':GENERIC;
}
// Minecraft's own refusals are worth telling apart: an unauthenticated Xbox Live session,
// an account that may not play, an outage and rate limiting are four different answers
// with four different things to do about them. The commonest cause of "may not play" is
// the wrong Microsoft account signed in — an account that does not own the game says the
// same thing as an account that cannot play it — so the sentence points at the account
// and tells the player that owning the game on another account is the case to switch for,
// which is something they can do, rather than telling them to check something.
function minecraftSentence({status}={}){
 if(status===401)return 'Minecraft sign-in failed: the Xbox Live session was not accepted. Sign in again.';
 if(status===403)return 'Minecraft sign-in failed: this Microsoft account may not play Minecraft: Java Edition. If you do own the game, sign in with the Microsoft account you play it with.';
 if(status===429)return 'Minecraft sign-in failed: there have been too many sign-in attempts in a short time. Wait a few minutes and try again.';
 if(Number.isInteger(status)&&status>=500)return 'Minecraft sign-in is temporarily unavailable: the service is not answering right now. Try again in a few minutes.';
 return sentence('minecraft',reason({status}));
}

// ---- The redacted sign-in log ---------------------------------------------------
// One line per step, appended to userData/signin.log, bounded by a single rotation so a
// launcher that signs in every day for years cannot grow it without limit. Every field is
// whitelisted: a timestamp, the launcher's own version, the step id, ok or failed, an HTTP
// status and the provider's code, plus `reissued` when the Xbox Live scope had to be
// minted first. A line that cannot be written is dropped and never reaches the player.
const LOG_LIMIT=65536;
class SignInLog{
 constructor({file=null,version='',maxBytes=LOG_LIMIT,now=()=>new Date()}={}){
  this.file=file;this.version=clean(version,24);this.maxBytes=Number.isInteger(maxBytes)&&maxBytes>0?maxBytes:LOG_LIMIT;this.now=now;
 }
 append({step,outcome,status,code,note}={}){
  if(!this.file)return;
  const line=[this.now().toISOString(),'v'+(this.version||'unknown'),'step='+(clean(step)||'-'),'outcome='+(outcome==='failed'?'failed':'ok'),'http='+(Number.isInteger(status)?status:'-'),'code='+(clean(code)||'-')]
   .concat(note?['note='+(clean(note)||'-')]:[]).join(' ')+'\n';
  try{
   try{mkdirSync(path.dirname(this.file),{recursive:true});}catch{}
   let size=0;
   try{size=statSync(this.file).size;}catch{}
   if(size+Buffer.byteLength(line,'utf8')>this.maxBytes){
    try{renameSync(this.file,this.file+'.1');}catch{}
   }
   appendFileSync(this.file,line,{encoding:'utf8'});
  }catch{}
 }
}

// A token minted for Xbox Live is proven by its own claims: an Xbox Live audience, or an
// Xbox Live scope claim. Nothing else counts, including a token that cannot be read. The
// claims are read, never verified, and that is enough for what they decide here: whether
// an extra exchange is worth a round trip before Xbox Live is asked. They are never
// stored, logged or put in a session, and only the answer (a boolean) leaves this function.
function claimsOf(value){
 if(typeof value!=='string')return null;
 const parts=value.split('.');
 if(parts.length!==3)return null;
 try{
  const parsed=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  return parsed&&typeof parsed==='object'?parsed:null;
 }catch{return null;}
}
function provenForXboxLive(access){
 const claims=claimsOf(access);
 if(!claims)return false;
 const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
 if(audiences.some(audience=>typeof audience==='string'&&XBOX_AUDIENCE.test(audience)))return true;
 return [claims.scp,claims.scope].some(scope=>typeof scope==='string'&&scope.split(/\s+/).includes(XBOX_SCOPE));
}

class MicrosoftAuth{
 // `openExternal` is how the player's own browser is opened at Microsoft's sign-in page. It
 // is passed in rather than reached for, because this module must stay runnable outside
 // Electron (it is what the suite drives with a real socket and a stubbed authority), and
 // because opening a browser is the one part of the flow that belongs to the application.
 // `loopbackTimeoutMs` bounds the wait for the answer and exists so a test can watch a real
 // timeout without waiting five minutes for one.
 constructor({clientId=DEFAULT_CLIENT_ID,request=fetch,wait=delay,log=null,logPath=null,version='',maxLogBytes,openExternal=null,loopbackTimeoutMs=LOOPBACK_TIMEOUT_MS}={}){
  this.clientId=clientId;this.request=request;this.wait=wait;this.openExternal=openExternal;
  this.loopbackTimeoutMs=Number.isInteger(loopbackTimeoutMs)&&loopbackTimeoutMs>0?loopbackTimeoutMs:LOOPBACK_TIMEOUT_MS;
  // The Microsoft sign-in page currently waiting for an answer, so the launcher can offer to
  // open it again without minting a second sign-in (see `reopen`).
  this.pending=null;
  this.log=log||new SignInLog({file:logPath,version,maxBytes:maxLogBytes});
 }
 record(step,outcome,info={}){if(!step)return;try{this.log.append({step,outcome,...info});}catch{}}
 // One HTTP leg. `step` is what a failure is recorded and worded as; `ignoreCodes` are the
 // answers that are not step outcomes at all (the poll's "not finished yet"), and `log`
 // is off for the two Java legs, whose single line is written by checkAccess instead.
 async json(url,options={},signal,step,{ignoreCodes=null,log=true,fresh=false}={}){
  let response;
  try{
   response=await this.request(url,{...options,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  }catch(error){
   if(error.name==='AbortError'||signal?.aborted)throw error;
   if(error.name==='TypeError'||error.name==='TimeoutError'){
    if(log)this.record(step,'failed',{code:'network'});
    throw new AuthError(reachedSentence(step),'network',step);
   }
   throw error;
  }
  let data={},readable=true;
  try{data=await response.json();}catch{readable=false;}
  const body=data&&typeof data==='object'?data:{};
  const code=typeof body.error==='string'?body.error:undefined;
  const xerr=Number.isInteger(Number(body.XErr))&&body.XErr!==undefined&&body.XErr!==null?Number(body.XErr):undefined;
  if(!response.ok){
   // The provider's own code, and the HTTP status when it gave none: an empty-bodied 401
   // is a status-only failure and is recorded as one rather than as a blank.
   if(log&&!(ignoreCodes&&code&&ignoreCodes.includes(code)))this.record(step,'failed',{status:response.status,code:Number.isInteger(xerr)?'XErr'+xerr:(clean(code)||String(response.status))});
   const error=new AuthError(step==='minecraft'?minecraftSentence({status:response.status}):sentence(step,reason({status:response.status,code,xerr,unreadable:!readable,step,fresh})),clean(code)||String(xerr||response.status),step);
   error.status=response.status;
   if(Number.isInteger(xerr))error.xerr=xerr;
   throw error;
  }
  if(!readable){
   if(log)this.record(step,'failed',{status:response.status,code:'unreadable'});
   const error=new AuthError(sentence(step,reason({status:response.status,unreadable:true,fresh})),'response',step);
   error.status=response.status;
   throw error;
  }
  return body;
 }
 form(endpoint,body,signal,step,options){return this.json(AUTHORITY+endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)},signal,step,options);}
 post(url,body,signal,step,options){return this.json(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},signal,step,options);}
 // The Microsoft token exchange: the authorization code a browser sign-in brings back and
 // the refresh of a saved session are the same step, and both write their one line here.
 // `fresh` marks the first: its refusal cannot be an expired saved session.
 async microsoftSession(body,signal,{ignoreCodes=null,fresh=false}={}){
  const data=await this.form('/token',body,signal,'code-completion',{ignoreCodes,fresh});
  if(!data||typeof data.access_token!=='string'||!data.access_token){
   this.record('code-completion','failed',{status:200,code:'response'});
   throw new AuthError(sentence('code-completion','Microsoft answered without a session'),'response','code-completion');
  }
  this.record('code-completion','ok',{status:200,code:'ok'});
  return data;
 }
 // ---- A sign-in, from the player's own browser -----------------------------------
 // One sequence, whether the player asked for it from the sign-in dialog or the launcher
 // fell back to it because the stored session was dead (doc/launcher-states.md,
 // "`reauth_required`: one sentence, one fallback, never a loop"). Nothing is copied, nothing
 // is typed into the launcher:
 //
 //   1. a loopback listener is opened on 127.0.0.1, on an ephemeral port, before anything
 //      else happens (desktop/loopback.cjs says what it accepts);
 //   2. one `state` and one PKCE S256 pair are minted in memory;
 //   3. the app registration is asked, once, whether it will accept this launcher's callback
 //      address — because Microsoft answers an unregistered redirect URI with its own error
 //      page in the browser and never calls back at all, which from here looks exactly like
 //      a player who closed the tab (see `registration`);
 //   4. the browser is opened at Microsoft's sign-in page;
 //   5. the first callback carrying this sign-in's own `state` completes it, and the listener
 //      is closed in the same breath;
 //   6. the code is exchanged with the verifier, and everything downstream is the unchanging
 //      Xbox Live → XSTS → Minecraft path.
 //
 // A cancelled, timed-out, refused or closed-by-the-player sign-in ends here as a rejection
 // with nothing half-done: `finally` closes the socket, no token was minted, no session was
 // written, and `pending` is cleared, so the player is exactly as signed in as before.
 async signIn(notify,signal,onStage){
  onStage?.('microsoft-opening');
  // What the UI is told is one fact, at the one moment it becomes true: Microsoft's sign-in page
  // is open in the player's browser and the launcher is waiting. There is no code, no page
  // address and nothing to copy — the hand-off Owen asked to be rid of was this call's payload,
  // and it is gone, so the payload is a flag. It is said BEFORE the browser is handed the
  // address, which is the instant the player sees it appear, and not after the browser program
  // has finished being launched.
  const answer=await this.authorizationCode(signal,()=>{
   notify({browser:true});
   onStage?.('microsoft-waiting');
  });
  let granted;
  try{
   granted=await answer.wait(signal);
  }catch(error){
   if(error?.name==='TimeoutError'){
    this.record('code-completion','failed',{code:'expired_token'});
    throw new AuthError(sentence('code-completion',TIMEOUT_CAUSE),'expired_token','code-completion');
   }
   // Anything else is already a named refusal from the listener or from Microsoft's own
   // answer, and is rethrown as it is rather than relabelled as a connection failure.
   throw error;
  }
  onStage?.('microsoft-verifying');
  const msa=await this.microsoftSession({grant_type:'authorization_code',client_id:this.clientId,code:granted.code,redirect_uri:answer.redirectUri,code_verifier:answer.verifier,scope:SCOPE},signal,{fresh:true});
  return await this.exchange(msa,undefined,signal,onStage);
 }
 // Steps 1 to 4 of the sequence above, and nothing else: this answers with the two things the
 // wait needs (the listener and the verifier) or throws. It is the whole of `pending`, so a
 // caller that holds it can offer the player the page again.
 async authorizationCode(signal,onOpen){
  if(typeof this.openExternal!=='function'){
   this.record('browser-sign-in','failed',{code:'no-browser'});
   throw new AuthError(sentence('browser-sign-in','this launcher could not open a web browser'),'no-browser','browser-sign-in');
  }
  const redirect=new LoopbackRedirect({timeoutMs:this.loopbackTimeoutMs});
  try{
   await redirect.listen();
  }catch{
   this.record('browser-sign-in','failed',{code:'listener'});
   throw new AuthError(reachedSentence('browser-sign-in'),'network','browser-sign-in');
  }
  const {verifier,challenge}=pkcePair();
  const state=stateToken();
  redirect.state=state;
  const redirectUri=redirect.redirectUri;
  const url=this.authorizeURL({redirectUri,state,challenge});
  const pending={redirect,redirectUri,verifier,state,url};
  try{
   await this.registration(url,redirectUri,signal);
   this.record('browser-sign-in','ok',{status:200,code:'ok'});
   try{
    onOpen?.();
    await this.openExternal(url.href);
   }catch{
    if(signal?.aborted)throw abortFromSignal();
    this.record('browser-sign-in','failed',{code:'no-browser'});
    throw new AuthError(sentence('browser-sign-in','the web browser could not be opened'),'no-browser','browser-sign-in');
   }
  }catch(error){
   pending.redirect.close();
   throw error;
  }
  this.pending=pending;
  return {
   redirectUri,verifier,
   wait:async inner=>{
    try{
     const answer=await pending.redirect.wait(inner);
     // Microsoft's own refusal (the player pressed Cancel on its page) is the cancel sentence
     // this launcher has always used for it; anything else it can report is the exchange's
     // refusal, worded by the step.
     if(answer.error){
      const code=clean(answer.error);
      this.record('code-completion','failed',{code:code||'-'});
      if(code==='access_denied')throw new AuthError(sentence('code-completion','the sign-in was cancelled in Microsoft'),'authorization_declined','code-completion');
      throw new AuthError(sentence('code-completion',reason({code,step:'code-completion',fresh:true})),code||'refused','code-completion');
     }
     if(!answer.code){
      this.record('code-completion','failed',{code:'response'});
      throw new AuthError(sentence('code-completion','Microsoft answered without a sign-in code'),'response','code-completion');
     }
     return answer;
    }finally{
     pending.redirect.close();
     if(this.pending===pending)this.pending=null;
    }
   }
  };
 }
 // The address the player's browser is sent to. Every parameter is fixed here, and the
 // redirect URI is the loopback one this listener is actually holding.
 authorizeURL({redirectUri,state,challenge}){
  const query=new URLSearchParams({
   client_id:this.clientId,
   response_type:'code',
   redirect_uri:redirectUri,
   // One resource and the refresh token's successor, exactly as the exchange asks (see
   // SCOPE and OFFLINE_ACCESS above): the sign-in's consent is what decides whether a
   // refresh token comes back, so offline_access has to be in THIS request.
   scope:SCOPE,
   state,
   code_challenge:challenge,
   code_challenge_method:'S256',
   // The account chooser on every sign-in: a launcher that silently reuses whichever
   // Microsoft account the browser last held would sign the player in as someone else.
   prompt:'select_account'
  });
  return new URL(AUTHORITY+'/authorize?'+query.toString());
 }
 // ---- Is this launcher allowed to come back at all? ------------------------------
 // A loopback redirect URI has to exist on the Azure app registration, and when it does not,
 // Microsoft does not tell the launcher: it draws its own error page and never calls back,
 // so the failure arrives as a wait that ends in a timeout, indistinguishable from a player
 // who closed the tab. That is exactly the generic failure this launcher must not report.
 //
 // So the authorize endpoint is asked first, with `prompt=none` and no session, which is a
 // question with only two shapes of answer:
 //   * a redirect back to OUR callback carrying `error=login_required` — which proves the
 //     redirect URI is registered (it is the address Microsoft just chose to answer to);
 //   * a page instead of a redirect — Microsoft will not answer to that address, and the
 //     registration is what has to change.
 // The page's own AADSTS code decides which sentence the player gets: 50011 is the reply-URL
 // mismatch, which is a URI to add, and 700016 is a client id the authority does not know,
 // which is a different fix. Both are logged; neither reaches the sentence as a code.
 //
 // TWO HOPS, AND NO MORE, BECAUSE THAT IS WHAT THE AUTHORITY DOES. Measured on 2026-10-26
 // against `login.microsoftonline.com/consumers`: that endpoint does not answer the question
 // itself, it proxies the whole request to `login.live.com/oauth20_authorize.srf`, and only
 // there does the answer arrive — a page whose text is "invalid_request: The provided value for
 // the input parameter 'redirect_uri' is not valid ..." when the address is not registered, or
 // a redirect back to the address when it is. So a second hop is read, and ONLY to Microsoft's
 // own sign-in hosts, and only while the answer is not already our own callback. Every request
 // here is made with `redirect:'manual'`, so the probe never follows a redirect into the
 // listener: following one would hand the launcher a `login_required` answer and end a real
 // sign-in before the player had seen it.
 // Any answer this cannot read is `unknown` and the sign-in goes ahead: a probe must never be
 // the thing that refuses a sign-in it did not understand.
 async registration(url,redirectUri,signal){
  const probe=new URL(url.href);
  probe.searchParams.set('prompt','none');
  probe.searchParams.set('state',stateToken());
  let target=probe.href;
  let response=null;
  for(let hop=0;hop<REGISTRATION_HOPS;hop+=1){
   try{
    response=await this.request(target,{method:'GET',redirect:'manual',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
   }catch(error){
    if(error?.name==='AbortError'||signal?.aborted)throw abortFromSignal();
    return 'unknown';
   }
   if(!response)return 'unknown';
   const forwarded=typeof response.headers?.get==='function'?String(response.headers.get('location')||''):'';
   const redirecting=Number.isInteger(response.status)&&response.status>=300&&response.status<400;
   // Anything that is not a redirect is an answer, and is read below.
   if(!redirecting)break;
   // The authority's own hand-off to its consumer sign-in host: read what that answers, once.
   if(forwarded.startsWith(redirectUri))return 'registered';
   let host='';
   try{host=new URL(forwarded).hostname;}catch{break;}
   if(hop===REGISTRATION_HOPS-1||!REGISTRATION_HOSTS.includes(host))break;
   target=forwarded;
  }
  if(!response)return 'unknown';
  if(Number.isInteger(response.status)&&response.status>=500)return 'trouble';
  let body='';
  try{body=String(await response.text()).slice(0,REGISTRATION_PAGE_LIMIT);}catch{return 'unknown';}
  if(body.includes('AADSTS50011'))return this.refuseRegistration('reply-url','AADSTS50011');
  // The consumer authority's own wording for the same refusal, measured above: no AADSTS
  // number, so it is recognised by its sentence and logged under its own error name.
  if(/redirect_uri/i.test(body)&&/not valid/i.test(body))return this.refuseRegistration('reply-url','invalid_request');
  if(/AADSTS700016|AADSTS70001\b/.test(body))return this.refuseRegistration('client','AADSTS700016');
  // A JSON refusal from the authorize endpoint is an ordinary start-step refusal, worded and
  // logged exactly as one.
  let parsed=null;
  try{parsed=JSON.parse(body);}catch{}
  if(parsed&&typeof parsed.error==='string'){
   const code=clean(parsed.error)||String(response.status);
   this.record('browser-sign-in','failed',{status:response.status,code});
   throw new AuthError(sentence('browser-sign-in',reason({status:response.status,code:parsed.error,step:'browser-sign-in',fresh:true})),code,'browser-sign-in');
  }
  // A refused page that names no code this launcher knows is still a refused page.
  if(response.status>=400)return this.refuseRegistration('refused',String(response.status),response.status);
  return 'unknown';
 }
 // The one failure that has to name its own fix: the exact redirect URI to add to the
 // Microsoft app registration. It is the registered shape (localhost, no port), because that
 // is the value Microsoft matches against — not the ported address this run happens to hold.
 refuseRegistration(kind,code,status=200){
  this.record('browser-sign-in','failed',{status:Number.isInteger(status)?status:200,code});
  const cause=kind==='reply-url'?{detail:'the Microsoft app registration does not allow the launcher’s return address',advice:'Add '+REGISTERED_REDIRECT+' as a redirect URI on the Microsoft app registration, then start sign-in again.'}
   :kind==='client'?{detail:'the Microsoft app registration this launcher is using does not exist for these accounts',advice:'Set EASTER_MICROSOFT_CLIENT_ID to this launcher’s own application id, then start sign-in again.'}
   :{detail:'the sign-in service refused it',advice:'Try again.'};
  throw new AuthError(sentence('browser-sign-in',cause),kind==='reply-url'?'redirect_uri_unregistered':kind==='client'?'client_unregistered':'refused','browser-sign-in');
 }
 // The page the player is already looking at again, without minting a second sign-in: the
 // same state, the same PKCE challenge, the same listener. Nothing is re-minted, so a page
 // opened twice can only ever complete once, and a stale window cannot start a second flow.
 async reopen(){
  const pending=this.pending;
  if(!pending)return false;
  await this.openExternal(pending.url.href);
  return true;
 }
 // The saved-session route, and the one that enrols the account on every sign-in: the same
 // six steps as a fresh browser sign-in, from the refresh flow rather than from a browser.
 async refresh(session,signal,recheck=false,force=false,onStage){
  if(!force&&session.expiresAt>Date.now()+300000)return recheck?this.checkAccess(session,signal,onStage):session;
  onStage?.('microsoft-verifying');
  const msa=await this.microsoftSession({grant_type:'refresh_token',client_id:this.clientId,refresh_token:session.refreshToken,scope:SCOPE},signal);
  return {...await this.exchange(msa,session.refreshToken,signal,onStage),accountId:session.accountId||session.profile?.id||'xbox:'+session.xuid};
 }
 // Xbox Live needs a token minted for its own resource. The sign-in asks for Xbox Live
 // and Graph in one consent and Microsoft, not the launcher, decides which one an answer is
 // for, so the token is checked by its own claims and — when that is not proof — reissued for
 // `XboxLive.signin` from the same refresh token first. One deterministic path, one log line;
 // the previous silent retry that swallowed its own failure and rethrew the original is gone.
 // The reissue asks for XBOX_REQUEST_SCOPE, not XBOX_SCOPE: this grant SPENDS the refresh
 // token it sends, and without offline_access Microsoft answers with a new access token and
 // no replacement refresh token, so the copy kept here would be the one this exchange had
 // just destroyed (see OFFLINE_ACCESS above). `refresh` therefore always advances to the
 // token Microsoft returned.
 async xboxSignIn(msa,oldRefresh,signal){
  const held=typeof msa?.access_token==='string'?msa.access_token:'';
  let access=held,reissued=false;
  let refresh=typeof msa?.refresh_token==='string'&&msa.refresh_token?msa.refresh_token:(typeof oldRefresh==='string'?oldRefresh:null);
  if(!provenForXboxLive(held)&&refresh){
   let scoped;
   try{scoped=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:refresh,scope:XBOX_REQUEST_SCOPE},signal,'xbox-live');}
   catch(error){
    if(error.name==='AbortError'||signal?.aborted||error.code==='network')throw error;
    // The step's own line has been written by the leg above; the sentence says what the
    // player needs to know, which is why this Microsoft sign-in did not become an Xbox
    // Live session. The refused session itself is never quoted, and neither is the code.
    throw new AuthError(sentence('xbox-live',reason({status:error.status,code:error.code,step:'xbox-live'})),'xbox_scope','xbox-live');
   }
   if(!scoped||typeof scoped.access_token!=='string'||!scoped.access_token){
    this.record('xbox-live','failed',{status:200,code:'response'});
    throw new AuthError(sentence('xbox-live','Microsoft answered without an Xbox Live session'),'response','xbox-live');
   }
   access=scoped.access_token;reissued=true;
   if(typeof scoped.refresh_token==='string'&&scoped.refresh_token)refresh=scoped.refresh_token;
  }
  const xbox=await this.post('https://user.auth.xboxlive.com/user/authenticate',{Properties:{AuthMethod:'RPS',SiteName:'user.auth.xboxlive.com',RpsTicket:'d='+access},RelyingParty:'http://auth.xboxlive.com',TokenType:'JWT'},signal,'xbox-live');
  if(!xbox||!xbox.Token){
   this.record('xbox-live','failed',{status:200,code:'response'});
   throw new AuthError(sentence('xbox-live','the answer carried no Xbox Live session'),'response','xbox-live');
  }
  this.record('xbox-live','ok',{status:200,code:'ok',...(reissued?{note:'reissued'}:{})});
  return {xbox,refreshToken:refresh};
 }
 async xstsAuthorize(xbox,signal){
  const xsts=await this.post('https://xsts.auth.xboxlive.com/xsts/authorize',{Properties:{SandboxId:'RETAIL',UserTokens:[xbox.Token]},RelyingParty:'rp://api.minecraftservices.com/',TokenType:'JWT'},signal,'xsts');
  if(!xsts.Token||!xsts.DisplayClaims?.xui?.[0]?.uhs){
   this.record('xsts','failed',{status:200,code:'response'});
   throw new AuthError(sentence('xsts','the answer carried no Minecraft session'),'response','xsts');
  }
  this.record('xsts','ok',{status:200,code:'ok'});
  return xsts;
 }
 async minecraftSignIn(xsts,signal){
  const mc=await this.post('https://api.minecraftservices.com/authentication/login_with_xbox',{identityToken:'XBL3.0 x='+xsts.DisplayClaims.xui[0].uhs+';'+xsts.Token},signal,'minecraft');
  if(!mc||typeof mc.access_token!=='string'||!mc.access_token){
   this.record('minecraft','failed',{status:200,code:'response'});
   throw new AuthError(sentence('minecraft','Minecraft answered without a session'),'response','minecraft');
  }
  this.record('minecraft','ok',{status:200,code:'ok'});
  return mc;
 }
 async exchange(msa,oldRefresh,signal,onStage){
  if(!msa||typeof msa.access_token!=='string'||!msa.access_token){
   this.record('code-completion','failed',{status:200,code:'response'});
   throw new AuthError(sentence('code-completion','Microsoft answered without a session'),'response','code-completion');
  }
  const {xbox,refreshToken}=await this.xboxSignIn(msa,oldRefresh,signal);
  const xsts=await this.xstsAuthorize(xbox,signal);
  const mc=await this.minecraftSignIn(xsts,signal);
  const xuid=/^\d{1,20}$/.test(String(xsts.DisplayClaims.xui[0].xid||''))?String(xsts.DisplayClaims.xui[0].xid):'0';
  // The user hash is present even when the optional Xbox ID is omitted.
  // Hash it into a stable, non-credential account key; never invent a Java profile.
  const uhs=xsts.DisplayClaims.xui[0].uhs;
  const microsoftId='msa:'+createHash('sha256').update(this.clientId+'\0'+String(uhs)).digest('hex');
  return this.checkAccess({clientId:this.clientId,xuid,microsoftId,companySubject:createHash('sha256').update('xbox-uhs:'+String(uhs)).digest('hex'),xboxUserToken:xbox.Token,xboxExpiresAt:Date.parse(xbox.NotAfter)||0,accountId:microsoftId,refreshToken,accessToken:mc.access_token,expiresAt:Date.now()+(mc.expires_in||86400)*1000,profile:null},signal,onStage);
 }
 // A transient Microsoft Graph token for the account service. The server treats it as
 // optional, so every failure here answers null and the player still signs in. It is not a
 // sign-in step, so it writes no line and names no step.
 //
 // It answers with BOTH tokens, because the refresh token it is given is spent by this very
 // request: the answer's `refresh_token` is the only live copy left, and the caller needs it
 // to keep (and to hand over) the one Microsoft will still accept. This leg used to answer
 // the access token alone — which is how the sign-in request that followed carried a refresh
 // token Microsoft had destroyed a moment earlier (see OFFLINE_ACCESS above), and how the
 // account service came to store a session that could never mint.
 async graphAccessToken(refreshToken,signal){
  if(typeof refreshToken!=='string'||!refreshToken){this.record('email','failed',{code:'no-refresh'});return null;}
  try{
   const data=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:refreshToken,scope:GRAPH_REQUEST_SCOPE},signal,undefined,{log:false});
   const token=typeof data?.access_token==='string'&&data.access_token.length<=8192?data.access_token:'';
   if(!token){this.record('email','failed',{code:'no-token'});return null;}
   this.record('email','ok',{status:200});
   // `refreshToken` is null only when Microsoft answered a spent-credential grant with no
   // successor, which must never be replaced by the one just spent: an absent successor is
   // "this machine no longer holds a usable token", not "keep the dead one".
   const rotated=typeof data?.refresh_token==='string'&&data.refresh_token?data.refresh_token:null;
   return {accessToken:token,refreshToken:rotated};
  }catch(error){
   if(error.name==='AbortError')return null;
   // Optional leg: it never fails the sign-in. It used to fail SILENTLY, which is how an
   // account ended up with no email address and nothing anywhere saying why - so it now
   // writes one whitelisted line (status and provider code; never the token, never the
   // address) beside the steps that do gate the sign-in.
   this.record('email','failed',{status:Number.isInteger(error?.status)?error.status:undefined,code:clean(error?.code)||'failed'});
   return null;
  }
 }
 // The Java legs: entitlements and the Java profile are one step and one line, written by
 // checkAccess below, so a failure that the state contract turns into `unknown` is still
 // named in the log and in the sentence it throws.
 async javaAccess(session,signal){
  const headers={Authorization:'Bearer '+session.accessToken};
  const license=await this.json('https://api.minecraftservices.com/entitlements/license?requestId='+randomUUID(),{headers,cache:'no-store'},signal,'java-profile',{log:false});
  if(!Array.isArray(license.items)||!license.items.every(item=>item&&typeof item.name==='string'))throw new AuthError(sentence('java-profile','the answer did not say which games this account owns'),'response','java-profile');
  const entitled=license.items.some(item=>['game_minecraft','product_minecraft'].includes(item.name));
  if(!entitled)return {...session,minecraftAccess:'missing'};
  let profile;
  try{profile=await this.json('https://api.minecraftservices.com/minecraft/profile',{headers,cache:'no-store'},signal,'java-profile',{log:false});}
  catch(error){if(error.status===404)return {...session,profile:null,minecraftAccess:'profile-required'};throw error;}
  if(!/^[a-f0-9]{32}$/i.test(profile.id)||!/^\w{1,16}$/.test(profile.name))throw new AuthError(sentence('java-profile','the profile answer was not a Java profile'),'response','java-profile');
  return {...session,minecraftAccess:'owned',profile:{id:profile.id,name:profile.name,skin:session.profile?.id===profile.id?session.profile.skin:undefined,skinURL:profile.skins?.find(s=>s.state==='ACTIVE')?.url||null}};
 }
 async checkAccess(session,signal,onStage){
  onStage?.('java-checking');
  try{
   const next=await this.javaAccess(session,signal);
   this.record('java-profile','ok',{status:200,code:clean(next.minecraftAccess)||'ok'});
   return next;
  }catch(error){
   if(error.name==='AbortError'||signal?.aborted)throw error;
   this.record('java-profile','failed',{status:error.status,code:Number.isInteger(error.xerr)?'XErr'+error.xerr:clean(error.code)||undefined});
   // Network/service/auth failures never prove non-ownership.
   return {...session,minecraftAccess:'unknown',expiresAt:[401,403].includes(error.status)?0:session.expiresAt};
  }
 }
}
module.exports={MicrosoftAuth,AuthError,SignInLog,DEFAULT_CLIENT_ID,AUTHORITY,REGISTERED_REDIRECT};
