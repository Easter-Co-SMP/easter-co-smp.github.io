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
 // The answer is one boolean and a reason code: no account, no email, no hint.
 async usernameAvailable(username,signal){
  if(typeof username!=='string'||!USERNAME_PATTERN.test(username))return {available:false,reason:'username_policy'};
  const found=await this.call('/v2/accounts/username/available',{method:'POST',body:{username},signal,timeout:Math.min(this.timeout,10000)});
  const reason=['username_taken','username_policy'].includes(found?.reason)?found.reason:null;
  return {available:found?.available===true&&!reason,reason};
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
  return {created:created.created===true,account,session:{token,expiresAt}};
 }
 async me(token,signal){
  const found=await this.call('/v2/accounts/me',{token,signal});
  return sanitizeAccount(found?.account);
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
module.exports={AccountClient,AccountError,sanitizeAccount,publicAccount,MESSAGES,USERNAME_PATTERN,companySession,storedSession,companyVaultName};
