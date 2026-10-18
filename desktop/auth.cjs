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
const SCOPE='XboxLive.signin offline_access https://graph.microsoft.com/User.Read';
const GRAPH_SCOPE='https://graph.microsoft.com/User.Read';
// The one scope a token must have been minted for before it may be presented to
// user.auth.xboxlive.com. It is asked for on its own when the token in hand cannot
// prove it (see xboxSignIn).
const XBOX_SCOPE='XboxLive.signin';
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
// A provider code (HTTP status, XErr number, AAD error string) is carried because it is
// safe to carry; a token, a refresh token, a device code, a user code, an email address
// and the response body never are, which is why nothing below interpolates a value it
// has not whitelisted first. Every sentence is free of the word "token" on purpose:
// main.cjs's safeError() replaces any message that contains it with a generic refusal.
const STEPS={
 'device-code':{title:'Microsoft sign-in (device code)',verb:'could not start',advice:'Try again.'},
 'code-completion':{title:'Microsoft sign-in (code completion)',verb:'failed',advice:'Start sign-in again.'},
 'xbox-live':{title:'Xbox Live',verb:'did not accept the Microsoft sign-in',advice:'Try again.'},
 xsts:{title:'Xbox Live authorisation (XSTS)',verb:'did not accept the sign-in',advice:'Try again.'},
 minecraft:{title:'Minecraft sign-in',verb:'failed',advice:'Try again.'},
 'java-profile':{title:'The Java profile',verb:'could not be read',advice:'Try again.'}
};
// Kept for a step the launcher does not know, and for that alone.
const GENERIC='Sign-in could not finish. Please try again.';
const XERR={
 2148916233:'create an Xbox profile for this Microsoft account, then sign in again',
 2148916235:'Xbox Live is unavailable for this account’s country',
 2148916236:'complete the age verification on your Microsoft account',
 2148916237:'complete the age verification on your Microsoft account',
 2148916238:'this account needs Microsoft Family approval before Minecraft can connect'
};
// Only these characters may reach a sentence or the log. A provider code is a short
// identifier (invalid_grant, UNAUTHORIZED, XErr2148916238); anything else is dropped
// rather than echoed, so a value derived from a credential cannot be written out.
function clean(value,limit=48){
 const text=typeof value==='string'?value.trim():'';
 return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)&&text.length<=limit?text:'';
}
function reason({status,code,xerr,unreadable,step}={}){
 if(Number.isInteger(xerr))return (XERR[xerr]?XERR[xerr]:'Xbox Live refused this sign-in')+' (XErr '+xerr+')';
 const provider=clean(code);
 // A refused refresh grant is a saved sign-in that has expired; the same answer on the
 // device-code step is not, because a fresh sign-in has nothing saved behind it.
 if(provider==='invalid_grant'&&step!=='device-code')return 'your saved sign-in has expired (invalid_grant)';
 if(provider&&Number.isInteger(status))return 'the provider answered '+provider+' (HTTP '+status+')';
 if(provider)return 'the provider answered '+provider;
 if(Number.isInteger(status))return 'the provider answered HTTP '+status+(unreadable?' with no readable detail':'');
 return 'the provider gave no readable answer';
}
function sentence(step,detail){
 const name=STEPS[step];
 if(!name)return GENERIC;
 return name.title+' '+name.verb+': '+detail+'. '+name.advice;
}
function reachedSentence(step){
 const name=STEPS[step];
 return name?name.title+' could not be reached: the connection failed. Check your network and try again.':GENERIC;
}
// Minecraft's own refusals are worth telling apart: an unauthenticated Xbox Live session,
// an account that may not sign in, and an outage are three different answers.
function minecraftSentence({status,code}={}){
 const provider=clean(code);
 const suffix=provider?' '+provider:'';
 if(status===401)return 'Minecraft sign-in failed: the Xbox Live session was refused (HTTP 401'+suffix+'). Try again.';
 if(status===403)return 'Minecraft sign-in failed: this account is not allowed to sign in to Minecraft (HTTP 403'+suffix+'). Check that it owns Minecraft: Java Edition.';
 if(status===429)return 'Minecraft sign-in failed: sign-in is being rate limited (HTTP 429'+suffix+'). Wait a moment and try again.';
 if(Number.isInteger(status)&&status>=500)return 'Minecraft sign-in is temporarily unavailable (HTTP '+status+suffix+'). Try again shortly.';
 return sentence('minecraft',reason({status,code}));
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
   const error=new AuthError(step==='minecraft'?minecraftSentence({status:response.status,code}):sentence(step,reason({status:response.status,code,xerr,unreadable:!readable,step})),clean(code)||String(xerr||response.status),step);
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
 async signIn(notify,signal){
  const code=await this.form('/devicecode',{client_id:this.clientId,scope:SCOPE},signal,'device-code');
  if(!code.device_code||!code.user_code||!code.verification_uri){
   this.record('device-code','failed',{status:200,code:'response'});
   throw new AuthError(sentence('device-code','Microsoft answered without a sign-in code'),'response','device-code');
  }
  this.record('device-code','ok',{status:200,code:'ok'});
  // Only the short-lived user code reaches the UI; never device_code or tokens.
  notify({code:code.user_code,url:code.verification_uri,expiresAt:Date.now()+code.expires_in*1000});
  const deadline=Date.now()+Math.min(code.expires_in,1800)*1000;
  let interval=Math.max(1,code.interval||5)*1000;
  while(Date.now()<deadline){
   await this.wait(interval,undefined,{signal});
   try{
    const msa=await this.microsoftSession({grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:this.clientId,device_code:code.device_code},signal,{ignoreCodes:['authorization_pending','slow_down']});
    return await this.exchange(msa,undefined,signal);
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
 async refresh(session,signal,recheck=false,force=false){
  if(!force&&session.expiresAt>Date.now()+300000)return recheck?this.checkAccess(session,signal):session;
  const msa=await this.microsoftSession({grant_type:'refresh_token',client_id:this.clientId,refresh_token:session.refreshToken,scope:SCOPE},signal);
  return {...await this.exchange(msa,session.refreshToken,signal),accountId:session.accountId||session.profile?.id||'xbox:'+session.xuid};
 }
 // Xbox Live needs a token minted for its own resource. The device code asks for Xbox Live
 // and Graph in one consent and Microsoft, not the launcher, decides which one an answer is
 // for, so the token is checked by its own claims and — when that is not proof — reissued for
 // `XboxLive.signin` from the same refresh token first. One deterministic path, one log line;
 // the previous silent retry that swallowed its own failure and rethrew the original is gone.
 async xboxSignIn(msa,oldRefresh,signal){
  const held=typeof msa?.access_token==='string'?msa.access_token:'';
  let access=held,reissued=false;
  let refresh=typeof msa?.refresh_token==='string'&&msa.refresh_token?msa.refresh_token:(typeof oldRefresh==='string'?oldRefresh:null);
  if(!provenForXboxLive(held)&&refresh){
   let scoped;
   try{scoped=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:refresh,scope:XBOX_SCOPE},signal,'xbox-live');}
   catch(error){
    if(error.name==='AbortError'||signal?.aborted||error.code==='network')throw error;
    // The step's own line has been written by the leg above; the sentence says what the
    // player needs to know, which is that this Microsoft sign-in could not become an Xbox
    // Live session. The refused session itself is never quoted.
    throw new AuthError(sentence('xbox-live','this Microsoft sign-in could not be exchanged for Xbox Live ('+reason({status:error.status,code:error.code,step:'xbox-live'})+')'),'xbox_scope','xbox-live');
   }
   if(!scoped||typeof scoped.access_token!=='string'||!scoped.access_token){
    this.record('xbox-live','failed',{status:200,code:'response'});
    throw new AuthError(sentence('xbox-live','the Xbox Live scope answered without a session'),'response','xbox-live');
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
 async exchange(msa,oldRefresh,signal){
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
  return this.checkAccess({clientId:this.clientId,xuid,microsoftId,companySubject:createHash('sha256').update('xbox-uhs:'+String(uhs)).digest('hex'),xboxUserToken:xbox.Token,xboxExpiresAt:Date.parse(xbox.NotAfter)||0,accountId:microsoftId,refreshToken,accessToken:mc.access_token,expiresAt:Date.now()+(mc.expires_in||86400)*1000,profile:null},signal);
 }
 // A transient Microsoft Graph token for the account service. The server treats it as
 // optional, so every failure here answers null and the player still signs in. It is not a
 // sign-in step, so it writes no line and names no step.
 async graphAccessToken(refreshToken,signal){
  if(typeof refreshToken!=='string'||!refreshToken)return null;
  try{
   const data=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:refreshToken,scope:GRAPH_SCOPE},signal,undefined,{log:false});
   const token=typeof data?.access_token==='string'&&data.access_token.length<=8192?data.access_token:'';
   return token||null;
  }catch(error){
   if(error.name==='AbortError')return null;
   return null;
  }
 }
 // The Java legs: entitlements and the Java profile are one step and one line, written by
 // checkAccess below, so a failure that the state contract turns into `unknown` is still
 // named in the log and in the sentence it throws.
 async javaAccess(session,signal){
  const headers={Authorization:'Bearer '+session.accessToken};
  const license=await this.json('https://api.minecraftservices.com/entitlements/license?requestId='+randomUUID(),{headers,cache:'no-store'},signal,'java-profile',{log:false});
  if(!Array.isArray(license.items)||!license.items.every(item=>item&&typeof item.name==='string'))throw new AuthError(sentence('java-profile','the access answer carried no entitlement list'),'response','java-profile');
  const entitled=license.items.some(item=>['game_minecraft','product_minecraft'].includes(item.name));
  if(!entitled)return {...session,minecraftAccess:'missing'};
  let profile;
  try{profile=await this.json('https://api.minecraftservices.com/minecraft/profile',{headers,cache:'no-store'},signal,'java-profile',{log:false});}
  catch(error){if(error.status===404)return {...session,profile:null,minecraftAccess:'profile-required'};throw error;}
  if(!/^[a-f0-9]{32}$/i.test(profile.id)||!/^\w{1,16}$/.test(profile.name))throw new AuthError(sentence('java-profile','the profile answer was not a Java profile'),'response','java-profile');
  return {...session,minecraftAccess:'owned',profile:{id:profile.id,name:profile.name,skin:session.profile?.id===profile.id?session.profile.skin:undefined,skinURL:profile.skins?.find(s=>s.state==='ACTIVE')?.url||null}};
 }
 async checkAccess(session,signal){
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
