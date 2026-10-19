'use strict';
// Easter Company account API client, main process only. The renderer never talks
// to this: every call comes through an origin-checked IPC handler. The Mojang
// access token and the returned Easter Company session token exist in memory here
// and in the safeStorage vault, never in the UI, a log line or an error message.
const {apiOrigin,GAME_STATUS_TIMEOUT_MS,GAME_WAKE_REQUEST_TIMEOUT_MS}=require('./config.cjs');
const {sanitizeGameStatus,endpointMatches,MESSAGES:GAME_MESSAGES}=require('./game.cjs');
const {apiFetch}=require('./security.cjs');
const {setTimeout:wait}=require('node:timers/promises');
const DEFAULT_TIMEOUT=30000;
const DATABASE_RESUME_BACKOFF_MS=3000;
const DATABASE_RESUME_BUDGET_MS=90000, DATABASE_RESUME_ATTEMPTS=4;
class AccountError extends Error{
 constructor(code,message){super(message);this.name='AccountError';this.code=code;}
}
// An Easter Company username is the player's public handle: 3-20 characters of
// [a-z0-9_-], chosen once and immutable afterwards. The server owns the rule; this
// copy of it refuses a payload the UI could not render and saves a round trip.
const USERNAME_PATTERN=/^[a-z0-9_-]{3,20}$/;
// The availability probe's reason words, mapped to the launcher's own codes. The deployed
// service sends 'taken'/'policy'; the contract named the same answers 'username_taken'/
// 'username_policy'. Either spelling lands on one message.
const PROBE_REASONS={taken:'username_taken',username_taken:'username_taken',policy:'username_policy',username_policy:'username_policy'};
// The account service's answer about the Microsoft account's own email address: stored,
// unavailable, or none when no Microsoft Graph permission was granted. It is a status word,
// never an address, and it is the only email-shaped thing this module ever sees.
const EMAIL_STATUSES=['stored','unavailable','none'];
// Error messages and codes from the frozen contract, mapped to one actionable line.
const MESSAGES={
 database_unavailable:'The account service is still waking up. Please try signing in again in a moment.',
 provider_not_configured:'This sign-in provider is not available yet.',
 invalid_provider_token:'Your provider sign-in was not accepted. Try again.',
 invalid_credentials:'The username or email, or the password, is incorrect.',
 username_taken:'That username is already taken. Try another.',
 username_policy:'Use 3 to 20 characters: letters, numbers, underscores or dashes. Capitals become lowercase.',
 invalid_microsoft_token:'Your Microsoft sign-in needs to be renewed. Sign in again.',
 identity_conflict:'That provider belongs to a different Easter Company account, or this account already has a different link. Sign out to use another account.',
 password_policy:'Use a password or passphrase of 8 to 128 characters. Avoid common passwords.',
 reauthentication_required:'Sign in with a linked provider to set or reset your password.',
 invalid_minecraft_token:'Microsoft signed you in, but Minecraft did not accept that session. Sign in again.',
 invalid_session:'Your Easter Company session expired. Sign in again.',
 invalid_request:'The account service rejected the request. Update the launcher and try again.',
 identity_provider_unavailable:'Minecraft sign-in is unavailable right now. Try again in a moment.',
 // The address the player chose is not one this account may sign in with: it is either
 // not verified for this account or another Easter Company account already uses it. It is
 // reported as an unavailable address, never as a failure to sign in.
 email_not_yours:'That address cannot be your login email. It is not verified for this account, or another Easter Company account already uses it to sign in.',
 rate_limited:'Too many account requests just now. Wait a moment and try again.'
};
const FALLBACK='The Easter Company account service could not complete that request.';
function serverMessage(status,body){
 const code=typeof body?.error==='string'?body.error:'';
 // Only our own fixed wording ever leaves this module; the API body never does.
 if(MESSAGES[code])return new AccountError(code,MESSAGES[code]);
 if(status===429)return new AccountError('rate_limited',MESSAGES.rate_limited);
 if(status===401)return new AccountError('invalid_session',MESSAGES.invalid_session);
 return new AccountError('service_'+(status||'error'),FALLBACK);
}
// The fields a linked provider may describe itself with, and nothing else. Microsoft is listed
// with its gamertag only: the Minecraft name the row shows is the account's own
// `minecraftName`, which is already validated here and already names the account, so the copy
// the cloud may carry inside providerDetails is never read - one source, or the two can
// disagree and the row prints whichever arrived last.
const PROVIDER_DETAIL_FIELDS={microsoft:['gamertag'],google:['email'],steam:['persona'],discord:['username','displayName']};
const PROVIDER_DETAIL_MAX=64;
// Control and bidi-override characters are dropped rather than trimmed: a gamertag is one
// visible word, and a value that could reorder the text around it is not a gamertag.
const PROVIDER_DETAIL_INVISIBLE=/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
function providerDetailString(value){
 if(typeof value!=='string')return null;
 const text=value.replace(PROVIDER_DETAIL_INVISIBLE,'').trim();
 return text?text.slice(0,PROVIDER_DETAIL_MAX):null;
}
// A payload this launcher cannot read is "no details", never an error: the dialog then draws
// what it drew before providerDetails existed. Everything kept is rebuilt from the whitelist
// above, so an unknown key, a number, an object or a provider that is not linked never reaches
// state.
function sanitizeProviderDetails(value,providers){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const details={};
 for(const [provider,fields] of Object.entries(PROVIDER_DETAIL_FIELDS)){
  if(!providers.includes(provider))continue;
  const entry=value[provider];
  if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
  const detail={};
  for(const field of fields)detail[field]=field==='email'?sanitizeEmail(entry.email):providerDetailString(entry[field]);
  // A provider whose values are all unknown adds nothing: it is left out, so providerDetails
  // itself is null until some linked provider actually has something to show.
  if(Object.values(detail).some(Boolean))details[provider]=detail;
 }
 return Object.keys(details).length?details:null;
}
function sanitizeAccount(account){
 if(!account||typeof account!=='object'||Array.isArray(account))throw new AccountError('invalid_response',FALLBACK);
 const id=Number(account.id),minecraftName=String(account.minecraftName||''),uuid=String(account.minecraftUuid||'');
 if(!Number.isSafeInteger(id)||id<1||(minecraftName&&!/^\w{1,16}$/.test(minecraftName))||(uuid&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)))throw new AccountError('invalid_response',FALLBACK);
 const displayName=typeof account.displayName==='string'&&account.displayName.trim()?account.displayName.trim().slice(0,64):null;
 const roles=Array.isArray(account.roles)?account.roles.filter(role=>typeof role==='string'&&role.length<=32).slice(0,16):[];
 const createdAt=typeof account.createdAt==='string'?account.createdAt:null;
 const microsoftSubject=/^[a-f0-9]{64}$/.test(account.microsoftSubject||'')?account.microsoftSubject:null;
 if(account.microsoftLinked===true&&!microsoftSubject)throw new AccountError('invalid_response',FALLBACK);
 // The username is null until the player claims one, which happens together with the
 // first password. Anything else the payload carries (an email address above all) is
 // dropped here: only the fields named below ever leave this module.
 const username=typeof account.username==='string'&&account.username?account.username:null;
 if(username&&!USERNAME_PATTERN.test(username))throw new AccountError('invalid_response',FALLBACK);
 const passwordRequired=account.passwordRequired!==false;
 // No password needed means a username was claimed, so the two cannot disagree. A
 // payload that says so is a server bug and is refused rather than shown blank.
 if(!passwordRequired&&!username)throw new AccountError('invalid_response',FALLBACK);
 const providers=Array.isArray(account.providers)?account.providers.filter(p=>['microsoft','google','steam','discord'].includes(p)):account.microsoftLinked?['microsoft']:[];
 const primaryProvider=providers.includes(account.primaryProvider)?account.primaryProvider:providers[0]||null;
 const picture=typeof account.picture==='string'&&account.picture.length<=360000&&(account.picture.startsWith('data:image/png;base64,')||/^https:\/\//.test(account.picture))?account.picture:null;
 // What each linked provider holds. These are the first values in the launcher that came from
 // Microsoft, Steam and Discord, so the payload's own shape is rebuilt field by field below and
 // nothing else is kept. A provider that is not linked on this account carries no details at
 // all, whatever the payload says; a malformed object is no details, never a refusal.
 const providerDetails=sanitizeProviderDetails(account.providerDetails,providers);
 return {providers,primaryProvider,providerDetails,picture,id,companyId:'EC-'+id,username,passwordRequired,minecraftUuid:uuid?uuid.toLowerCase():null,minecraftName:minecraftName||null,displayName,roles,createdAt,microsoftLinked:account.microsoftLinked===true,microsoftSubject};
}
// The renderer needs a name to show, nothing more. No UUID, no token, and the Company
// ID travels only as the opaque account handle the account menu switches on: it is
// never a label the player reads. The Minecraft name and the linked providers' own details
// are here because the profile dialog draws them, and both are already the sanitized ones.
function publicAccount(session){
 if(!session?.account)return null;
 const account=session.account,details=account.providerDetails;
 return {id:account.companyId,username:account.username,name:account.displayName||account.minecraftName||account.username||'Company member',minecraftName:account.minecraftName||null,roles:account.roles||[],passwordRequired:account.passwordRequired,microsoftLinked:account.microsoftLinked,providers:account.providers||[],primaryProvider:account.primaryProvider||null,providerDetails:details&&Object.keys(details).length?details:null,picture:account.picture?.startsWith('data:image/png;base64,')?account.picture:null};
}

// The verified-address list is the only payload the launcher asks for because of an email, and
// it is handed straight to the profile section and nowhere else. (The account document carries
// the Google link's own address in providerDetails; that is the provider's record of itself,
// not this list, and it is rebuilt field by field above.) Nothing here is stored: the shape is
// checked, the address the account service reports as its login email is the only one
// flagged, and every other field of the response is dropped. An address the launcher could
// not render (empty, whitespace, no @) is dropped from the list rather than shown, so the
// UI can never display something that is not an address, and the login address is only
// ever one the list agrees with.
const EMAIL_MAX=254,EMAILS_MAX=20;
function sanitizeEmail(value){
 if(typeof value!=='string')return null;
 const email=value.trim();
 if(!email||email.length>EMAIL_MAX||!/^[^\s@]+@[^\s@]+$/.test(email))return null;
 return email;
}
function verifiedEmails(payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new AccountError('invalid_response',FALLBACK);
 const list=Array.isArray(payload.emails)?payload.emails:[];
 const emails=[],seen=new Set();
 for(const entry of list.slice(0,EMAILS_MAX)){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
  const email=sanitizeEmail(entry.email);
  if(!email||seen.has(email.toLowerCase()))continue;
  seen.add(email.toLowerCase());
  emails.push({email,provider:typeof entry.provider==='string'&&entry.provider?entry.provider.trim().slice(0,32):null,verifiedAt:typeof entry.verifiedAt==='string'?entry.verifiedAt:null,login:entry.login===true});
 }
 // The top-level loginEmail is the account service's own answer, so it wins over the
 // per-entry flag and is the only address the list marks; when it names an address the
 // list does not carry, nothing is selected rather than a phantom.
 const named=sanitizeEmail(payload.loginEmail);
 const loginEmail=named?emails.find(entry=>entry.email.toLowerCase()===named.toLowerCase())?.email||null:emails.find(entry=>entry.login)?.email||null;
 for(const entry of emails)entry.login=Boolean(loginEmail)&&entry.email===loginEmail;
 return {emails,loginEmail};
}
class AccountClient{
 constructor({baseUrl=apiOrigin(),client='launcher/0.0.0',request=apiFetch,timeout=DEFAULT_TIMEOUT,waitFor=wait,now=Date.now}={}){
  this.baseUrl=String(baseUrl).replace(/\/+$/,'');this.client=client;this.request=request;this.timeout=timeout;this.waitFor=waitFor;this.now=now;
 }
 async call(pathname,{method='GET',body,token,timeout=this.timeout,signal}={}){
  // Every call is bounded: an unresponsive API must never hang sign-in or launch.
  const headers={Accept:'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(token)headers.Authorization='Bearer '+token;
  const deadline=AbortSignal.timeout(timeout);
  let response;
  try{
   response=await this.request(this.baseUrl+pathname,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,deadline]):deadline});
  }catch(error){
   if(error.name==='AbortError'&&signal?.aborted)throw error;
   // Unreachable host, DNS failure, refused connection or elapsed timeout.
   // The cause is deliberately dropped so it can never reach the renderer.
   throw new AccountError('unreachable','The Easter Company account service could not be reached.');
  }
  let data=null;
  if(response.status!==204){
   try{data=await response.json();}catch{throw new AccountError('invalid_response',FALLBACK);}
  }
  signal?.throwIfAborted();
  if(!response.ok){
   const error=serverMessage(response.status,data);
   // Only a declared database failure is safe to retry. A lost response could
   // have committed, and an unrelated service failure must keep its own meaning.
   error.databaseUnavailable=response.status===503&&data?.error==='database_unavailable';
   throw error;
  }
  return data;
 }
 // The Microsoft Graph token is optional in the contract and transient here: it is put in
 // this one request body, never stored, never returned and never logged. An empty or
 // missing token means the request is sent without it and the server still answers.
 async login(xboxUserToken,signal,token,microsoftAccessToken,onWait){
  if(typeof xboxUserToken!=='string'||!xboxUserToken)throw new AccountError('invalid_request',MESSAGES.invalid_request);
  const graph=typeof microsoftAccessToken==='string'&&microsoftAccessToken?microsoftAccessToken:null;
  const options={method:'POST',body:{xboxUserToken,...(graph?{microsoftAccessToken:graph}:{}),client:this.client},signal,token};
  // Aurora can take longer to resume than one bounded API request allows.
  // A declared database_unavailable response can be retried with the same
  // verified identity while that cluster continues waking. Never retry a network
  // error or a malformed success, whose write outcome is unknown.
  let created;
  const deadline=this.now()+DATABASE_RESUME_BUDGET_MS;
  for(let attempt=1;attempt<=DATABASE_RESUME_ATTEMPTS;attempt++){
   signal?.throwIfAborted();
   const remaining=deadline-this.now();
   if(remaining<=0)throw new AccountError('database_unavailable',MESSAGES.database_unavailable);
   try{created=await this.call('/v2/accounts/microsoft',{...options,timeout:Math.min(this.timeout,DEFAULT_TIMEOUT,remaining)});break;}
   catch(error){
    if(!error.databaseUnavailable||attempt===DATABASE_RESUME_ATTEMPTS)throw error;
    const delay=Math.min(DATABASE_RESUME_BACKOFF_MS*attempt,deadline-this.now());
    if(delay<=0)throw error;
    // Only this safe stage identifier leaves the retry path, never a response body.
    try{onWait?.('company-waking');}catch{}
    await this.waitFor(delay,undefined,{signal});
   }
  }
  return this.signed(created);
 }
 // Direct sign-in. The identifier is the Easter Company username or the email the
 // account was created with; the server decides which, and this module never sees an
 // email come back. A Company ID is not accepted here by contract.
 async loginPassword(identifier,password,signal){
  if(typeof identifier!=='string'||!identifier||typeof password!=='string')throw new AccountError('invalid_credentials',MESSAGES.invalid_credentials);
  const created=await this.call('/v2/accounts/password/login',{method:'POST',body:{identifier,password,client:this.client},signal});
  return this.signed(created);
 }
 // Whether a username can still be claimed, asked before the player types a password.
 // The answer is one boolean and a reason word: no account, no email, no hint.
 // The deployed probe says 'taken' or 'policy'; the frozen contract named the same two
 // answers after its error codes ('username_taken', 'username_policy'). Both spellings
 // are accepted here and always leave as the launcher's own codes, so the wording that
 // the player reads stays in one table and a reserved word is never reported as a name
 // someone else holds.
 async usernameAvailable(username,signal){
  const folded=typeof username==='string'?username.trim().toLowerCase():'';
  if(!USERNAME_PATTERN.test(folded))return {available:false,reason:'username_policy'};
  const found=await this.call('/v2/accounts/username/available',{method:'POST',body:{username:folded},signal,timeout:Math.min(this.timeout,10000)});
  // Anything that is not a plain yes is a refusal; an unknown reason word is reported as
  // a taken name rather than being read as availability.
  if(found?.available===true)return {available:true,reason:null};
  return {available:false,reason:PROBE_REASONS[found?.reason]||'username_taken'};
 }
 // The username travels only on the call that claims it, together with the first
 // password. It is never sent again once the account has one.
 async setPassword(token,password,replace=false,username=null){
  const body={...(username?{username}:{}),password,replace,client:this.client};
  const created=await this.call('/v2/accounts/password',{method:'POST',token,body});
  return this.signed(created);
 }
 signed(created){
  const account=sanitizeAccount(created?.account);
  const token=created?.session?.token;
  if(typeof token!=='string'||!token)throw new AccountError('invalid_response',FALLBACK);
  const expiresAt=Date.parse(created.session.expiresAt);
  if(!Number.isFinite(expiresAt))throw new AccountError('invalid_response',FALLBACK);
  // Whether the account service could read the Microsoft account's own address. It is one
  // of three words and never an address, so the sign-in dialog can say what happened
  // without ever receiving or printing an email. A server that says nothing leaves the
  // field out rather than claiming 'none', which would assert more than it knows.
  const emailStatus=EMAIL_STATUSES.includes(created?.emailStatus)?created.emailStatus:undefined;
  return {created:created.created===true,account,session:{token,expiresAt},...(emailStatus?{emailStatus}:{})};
 }
 async me(token,signal){
  const found=await this.call('/v2/accounts/me',{token,signal});
  return sanitizeAccount(found?.account);
 }
 // The player's own verified addresses, and the one the account service signs them in
 // with. Owner-only: the call carries the Company session and no account handle, and its
 // answer is checked into the shape the profile section renders. Nothing here caches it.
 async emails(token,signal){
  const found=await this.call('/v2/accounts/emails',{token,signal,timeout:Math.min(this.timeout,10000)});
  return verifiedEmails(found);
 }
 // Select one of those addresses as the login email, or clear the selection with null.
 // The body is exactly `{email}` (or `{email:null}`): no account handle, no token in a
 // field, nothing the renderer could use to name someone else's account.
 async selectLoginEmail(token,email,signal){
  if(email!==null&&(typeof email!=='string'||!sanitizeEmail(email)))throw new AccountError('invalid_request',MESSAGES.invalid_request);
  const body={email:email===null?null:sanitizeEmail(email)};
  await this.call('/v2/accounts/emails/login',{method:'POST',token,body,signal,timeout:Math.min(this.timeout,15000)});
  // The list is re-read rather than trusted from the write's own answer, so what the
  // profile shows is always the record the account service holds. It is also what makes
  // the choice survive a restart: it is asked for, never remembered.
  return this.emails(token,signal);
 }
 async providers(signal){return this.call('/v2/accounts/providers',{signal});}
 // ---- the game server, on this same origin and this same session --------------
 // Two routes, frozen with the cloud side: the status read and the wake request. They
 // are methods of this client rather than a second HTTP client, so a sleeping game
 // server can never be reached by a code path that skips this module's own bounded
 // timeout, its HTTPS-only origin rule, or its rule that a response body never
 // reaches the renderer. The game server is a different service from the account, and
 // nothing here is ever described to the player as an account problem: the only code
 // that crosses into the game's own failure copy is `invalid_session`, where the
 // account really is the news.
 //
 // The status is the frozen shape (state, ready, endpoint, since, players, detail) and
 // `ready` is the only field that authorises a launch. A body this launcher cannot
 // read in that shape is refused here rather than guessed at.
 async gameStatus(token,signal){
  const found=await this.call('/v2/game/status',{token,signal,timeout:Math.min(this.timeout,GAME_STATUS_TIMEOUT_MS)});
  if(!endpointMatches(found?.endpoint))throw new AccountError('game_target_mismatch',GAME_MESSAGES.target);
  const status=sanitizeGameStatus(found);
  if(!status)throw new AccountError('invalid_response',FALLBACK);
  return status;
 }
 // Waking is the player's own Play press and nothing else: no launch, sign-in or page
 // visit ever calls this. The service answers with the same status shape, which is
 // already the first poll; an accepted request with no body is reported as no answer
 // and the launcher waits for the poll to say what happened.
 async wakeGame(token,signal){
  const found=await this.call('/v2/game/wake',{method:'POST',token,body:{client:this.client},signal,timeout:Math.min(this.timeout,GAME_WAKE_REQUEST_TIMEOUT_MS)});
  if(!endpointMatches(found?.endpoint))throw new AccountError('game_target_mismatch',GAME_MESSAGES.target);
  return found===null?null:sanitizeGameStatus(found);
 }
 async refreshSession(token,signal){return this.signed(await this.call('/v2/accounts/session/refresh',{method:'POST',token,signal,body:{client:this.client}}));}
 async updateProfile(token,body){const found=await this.call('/v2/accounts/profile',{method:'POST',token,body});return sanitizeAccount(found?.account);}
 async logout(token,signal){
  // Revocation is best effort. A refusal or a dead network must still let the
  // launcher forget the session locally, so this resolves either way.
  try{await this.call('/v2/accounts/logout',{method:'POST',token,signal:signal??undefined,timeout:Math.min(this.timeout,8000)});}catch{}
 }
}
// Vault session shape and its acceptance check. These live here, next to the
// contract they mirror, so a vault written by one build is read the same way by
// the next and a malformed vault is treated as absent rather than trusted.
function companyVaultName(){return 'company.enc';}
// The vault holds the flat {token, expiresAt, account} shape; the API response
// nests the session, so a successful login is unwrapped into it here.
function companySession(signed){
 const stored=signed?.session?storedSession({token:signed.session.token,expiresAt:signed.session.expiresAt,account:signed.account}):null;
 if(!stored)throw new AccountError('invalid_response',FALLBACK);
 return stored;
}
function storedSession(value){
 if(!value||typeof value.token!=='string'||!value.token||!Number.isFinite(value.expiresAt))return null;
 try{return {token:value.token,expiresAt:value.expiresAt,account:sanitizeAccount(value.account)};}catch{return null;}
}
module.exports={AccountClient,AccountError,sanitizeAccount,publicAccount,verifiedEmails,MESSAGES,USERNAME_PATTERN,companySession,storedSession,companyVaultName};
