'use strict';
// Easter Company account API client, main process only. The renderer never talks
// to this: every call comes through an origin-checked IPC handler. The Mojang
// access token and the returned Easter Company session token exist in memory here
// and in the safeStorage vault, never in the UI, a log line or an error message.
const {apiOrigin}=require('./config.cjs');
const {apiFetch}=require('./security.cjs');
const DEFAULT_TIMEOUT=10000;
class AccountError extends Error{
 constructor(code,message){super(message);this.name='AccountError';this.code=code;}
}
// Error messages and codes from the frozen contract, mapped to one actionable line.
const MESSAGES={
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
 if(!Number.isInteger(id)||id<1||!/^\w{1,16}$/.test(minecraftName)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid))throw new AccountError('invalid_response',FALLBACK);
 const displayName=typeof account.displayName==='string'&&account.displayName.trim()?account.displayName.trim().slice(0,64):null;
 const roles=Array.isArray(account.roles)?account.roles.filter(role=>typeof role==='string'&&role.length<=32).slice(0,16):[];
 const createdAt=typeof account.createdAt==='string'?account.createdAt:null;
 return {id,minecraftUuid:uuid.toLowerCase(),minecraftName,displayName,roles,createdAt};
}
// The renderer needs a name to show, nothing more. No UUID, no id, no token.
function publicAccount(session){return session?.account?{name:session.account.displayName||session.account.minecraftName,roles:session.account.roles||[]}:null;}
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
 async login(minecraftAccessToken,signal){
  if(typeof minecraftAccessToken!=='string'||!minecraftAccessToken)throw new AccountError('invalid_request',MESSAGES.invalid_request);
  const created=await this.call('/v1/accounts/login',{method:'POST',body:{minecraftAccessToken,client:this.client},signal});
  const account=sanitizeAccount(created?.account);
  const token=created?.session?.token;
  if(typeof token!=='string'||!token)throw new AccountError('invalid_response',FALLBACK);
  const expiresAt=Date.parse(created.session.expiresAt);
  if(!Number.isFinite(expiresAt))throw new AccountError('invalid_response',FALLBACK);
  return {created:created.created===true,account,session:{token,expiresAt}};
 }
 async me(token,signal){
  const found=await this.call('/v1/accounts/me',{token,signal});
  return sanitizeAccount(found?.account);
 }
 async logout(token,signal){
  // Revocation is best effort. A refusal or a dead network must still let the
  // launcher forget the session locally, so this resolves either way.
  try{await this.call('/v1/accounts/logout',{method:'POST',token,signal:signal??undefined,timeout:Math.min(this.timeout,8000)});}catch{}
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
module.exports={AccountClient,AccountError,sanitizeAccount,publicAccount,MESSAGES,companySession,storedSession,companyVaultName};
