'use strict';
// Easter Company account API client, main process only. The renderer never talks
// to this: every call comes through an origin-checked IPC handler. The Mojang
// access token and the returned Easter Company session token exist in memory here
// and in the safeStorage vault, never in the UI, a log line or an error message.
const {apiOrigin}=require('./config.cjs');
const {apiFetch}=require('./security.cjs');
const DEFAULT_TIMEOUT=30000;
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
 invalid_credentials:'The username or email, or the password, is incorrect.',
 username_taken:'That username is already taken. Try another.',
 username_policy:'Use 3 to 20 characters: lowercase letters, numbers, underscores or dashes.',
 invalid_microsoft_token:'Your Microsoft sign-in needs to be renewed. Sign in again.',
 identity_conflict:'That Microsoft account belongs to a different Easter Company account. Use the linked account or switch Company accounts.',
 password_policy:'Use a password or passphrase of 15 to 128 characters. Avoid common passwords.',
 reauthentication_required:'Sign in with your linked Microsoft account to set or reset your password.',
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
 return {id,companyId:'EC-'+id,username,passwordRequired,minecraftUuid:uuid?uuid.toLowerCase():null,minecraftName:minecraftName||null,displayName,roles,createdAt,microsoftLinked:account.microsoftLinked===true,microsoftSubject};
}
// The renderer needs a name to show, nothing more. No UUID, no token, and the Company
// ID travels only as the opaque account handle the account menu switches on: it is
// never a label the player reads.
function publicAccount(session){return session?.account?{id:session.account.companyId,username:session.account.username,name:session.account.displayName||session.account.minecraftName||session.account.username||'Company member',roles:session.account.roles||[],passwordRequired:session.account.passwordRequired,microsoftLinked:session.account.microsoftLinked}:null;}

// The verified-address list is the one payload that carries an email, and it is handed
// straight to the profile section and nowhere else. Nothing here is stored: the shape is
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
 constructor({baseUrl=apiOrigin(),client='launcher/0.0.0',request=apiFetch,timeout=DEFAULT_TIMEOUT}={}){
  this.baseUrl=String(baseUrl).replace(/\/+$/,'');this.client=client;this.request=request;this.timeout=timeout;
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
  if(!response.ok)throw serverMessage(response.status,data);
  return data;
 }
 // The Microsoft Graph token is optional in the contract and transient here: it is put in
 // this one request body, never stored, never returned and never logged. An empty or
 // missing token means the request is sent without it and the server still answers.
 async login(xboxUserToken,signal,token,microsoftAccessToken){
  if(typeof xboxUserToken!=='string'||!xboxUserToken)throw new AccountError('invalid_request',MESSAGES.invalid_request);
  const graph=typeof microsoftAccessToken==='string'&&microsoftAccessToken?microsoftAccessToken:null;
  const created=await this.call('/v2/accounts/microsoft',{method:'POST',body:{xboxUserToken,...(graph?{microsoftAccessToken:graph}:{}),client:this.client},signal,token});
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
  if(typeof username!=='string'||!USERNAME_PATTERN.test(username))return {available:false,reason:'username_policy'};
  const found=await this.call('/v2/accounts/username/available',{method:'POST',body:{username},signal,timeout:Math.min(this.timeout,10000)});
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
