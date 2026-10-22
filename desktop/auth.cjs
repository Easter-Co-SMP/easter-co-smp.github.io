'use strict';
const {setTimeout:delay}=require('node:timers/promises');
const {randomUUID,createHash}=require('node:crypto');
const {appendFileSync,mkdirSync,statSync,renameSync}=require('node:fs');
const path=require('node:path');
const AUTHORITY='https://login.microsoftonline.com/consumers/oauth2/v2.0';
// Both resources are asked for in one consent: Xbox Live, which is what signs in to
// Xbox Live, and User.Read, which the account service needs to read the Microsoft
// account's own email. Microsoft — not the launcher — decides which resource a token is
// minted for, so nothing below assumes the device-code answer is already an Xbox Live
// token: xboxSignIn proves that from the token's own claims and reissues it when it
// cannot. The Graph token is requested separately, below, and is transient: it is never
// stored, never logged and never leaves this process except on the one account request
// that carries it.
// ONE RESOURCE, ONE REQUEST. Xbox Live and Microsoft Graph are different resources, and
// Microsoft's token endpoint refuses a device-code exchange whose granted scopes span
// both. Measured, not guessed: this string carried the Graph scope from 1.0.22 to 1.0.25
// and every fresh Microsoft sign-in in that window failed with `400 invalid_scope` at
// code completion (signin.log, 2026-10-18T22:10 and 2026-10-19T06:53) - the device-code
// request is accepted, the ticket is entered, and then the exchange is refused, which is
// why it looked like a failure after Microsoft had already said yes. The Graph token is
// requested on its own afterwards, with the refresh token this exchange returns, and
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
// a device code, a user code, an email address and the response body never appear in
// either, which is why nothing below interpolates a value it has not whitelisted first.
// Every sentence is free of the word "token" on purpose: main.cjs's safeError() replaces
// any message that contains it with a generic refusal.
//
// `reach` is how the step reads in a sentence about a connection that never arrived,
// because "Xbox Live did not accept the sign-in: the connection failed" would claim a
// refusal that never happened. That sentence also leads the way every other sentence does
// and names what could not be reached, so it never repeats the verb the way "sign-in
// stopped while signing in to Xbox Live" did. It is still the same step in plain words,
// and still one sentence per step.
const STEPS={
 'device-code':{title:'Microsoft sign-in',verb:'could not start',advice:'Try again.',reach:'Microsoft to ask for a sign-in code'},
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
function reason({status,code,xerr,unreadable,step}={}){
 if(Number.isInteger(xerr))return XERR[xerr]||{detail:'Xbox Live refused this sign-in'};
 const provider=clean(code);
 // A refused refresh grant is a saved sign-in that has expired; the same answer on the
 // device-code step is not, because a fresh sign-in has nothing saved behind it.
 if(provider==='invalid_grant'&&step!=='device-code')return {detail:'your saved sign-in has expired'};
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
 constructor({clientId=DEFAULT_CLIENT_ID,request=fetch,wait=delay,log=null,logPath=null,version='',maxLogBytes}={}){
  this.clientId=clientId;this.request=request;this.wait=wait;
  this.log=log||new SignInLog({file:logPath,version,maxBytes:maxLogBytes});
 }
 record(step,outcome,info={}){if(!step)return;try{this.log.append({step,outcome,...info});}catch{}}
 // One HTTP leg. `step` is what a failure is recorded and worded as; `ignoreCodes` are the
 // answers that are not step outcomes at all (the poll's "not finished yet"), and `log`
 // is off for the two Java legs, whose single line is written by checkAccess instead.
 async json(url,options={},signal,step,{ignoreCodes=null,log=true}={}){
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
   const error=new AuthError(step==='minecraft'?minecraftSentence({status:response.status}):sentence(step,reason({status:response.status,code,xerr,unreadable:!readable,step})),clean(code)||String(xerr||response.status),step);
   error.status=response.status;
   if(Number.isInteger(xerr))error.xerr=xerr;
   throw error;
  }
  if(!readable){
   if(log)this.record(step,'failed',{status:response.status,code:'unreadable'});
   const error=new AuthError(sentence(step,reason({status:response.status,unreadable:true})),'response',step);
   error.status=response.status;
   throw error;
  }
  return body;
 }
 form(endpoint,body,signal,step,options){return this.json(AUTHORITY+endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)},signal,step,options);}
 post(url,body,signal,step,options){return this.json(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},signal,step,options);}
 // The Microsoft token exchange: the device-code poll and the refresh of a saved session
 // are the same step, and both write their one line here.
 async microsoftSession(body,signal,{ignoreCodes=null}={}){
  const data=await this.form('/token',body,signal,'code-completion',{ignoreCodes});
  if(!data||typeof data.access_token!=='string'||!data.access_token){
   this.record('code-completion','failed',{status:200,code:'response'});
   throw new AuthError(sentence('code-completion','Microsoft answered without a session'),'response','code-completion');
  }
  this.record('code-completion','ok',{status:200,code:'ok'});
  return data;
 }
 async signIn(notify,signal,onStage){
  onStage?.('microsoft-opening');
  const code=await this.form('/devicecode',{client_id:this.clientId,scope:SCOPE},signal,'device-code');
  if(!code.device_code||!code.user_code||!code.verification_uri){
   this.record('device-code','failed',{status:200,code:'response'});
   throw new AuthError(sentence('device-code','Microsoft answered without a sign-in code'),'response','device-code');
  }
  this.record('device-code','ok',{status:200,code:'ok'});
  // Only the short-lived user code reaches the UI; never device_code or tokens.
  notify({code:code.user_code,url:code.verification_uri,expiresAt:Date.now()+code.expires_in*1000});
  onStage?.('microsoft-waiting');
  const deadline=Date.now()+Math.min(code.expires_in,1800)*1000;
  let interval=Math.max(1,code.interval||5)*1000;
  while(Date.now()<deadline){
   await this.wait(interval,undefined,{signal});
   try{
    const msa=await this.microsoftSession({grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:this.clientId,device_code:code.device_code},signal,{ignoreCodes:['authorization_pending','slow_down']});
    onStage?.('microsoft-verifying');
    return await this.exchange(msa,undefined,signal,onStage);
   }catch(error){
    if(error.code==='authorization_pending')continue;
    if(error.code==='slow_down'){interval+=5000;continue;}
    if(error.code==='expired_token')throw new AuthError(sentence('code-completion','the sign-in code expired before it was used'),'expired_token','code-completion');
    if(error.code==='authorization_declined')throw new AuthError(sentence('code-completion','the sign-in was cancelled in Microsoft'),'authorization_declined','code-completion');
    throw error;
   }
  }
  throw new AuthError(sentence('code-completion','the sign-in code expired before it was used'),'expired_token','code-completion');
 }
 // The saved-session route, and the one that enrols the account on every sign-in: the same
 // six steps as a fresh device code, from the refresh flow rather than from a poll.
 async refresh(session,signal,recheck=false,force=false,onStage){
  if(!force&&session.expiresAt>Date.now()+300000)return recheck?this.checkAccess(session,signal,onStage):session;
  onStage?.('microsoft-verifying');
  const msa=await this.microsoftSession({grant_type:'refresh_token',client_id:this.clientId,refresh_token:session.refreshToken,scope:SCOPE},signal);
  return {...await this.exchange(msa,session.refreshToken,signal,onStage),accountId:session.accountId||session.profile?.id||'xbox:'+session.xuid};
 }
 // Xbox Live needs a token minted for its own resource. The device code asks for Xbox Live
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
module.exports={MicrosoftAuth,AuthError,SignInLog,DEFAULT_CLIENT_ID};
