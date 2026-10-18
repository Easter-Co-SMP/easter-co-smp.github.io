'use strict';
const {setTimeout:delay}=require('node:timers/promises');
const {randomUUID,createHash}=require('node:crypto');
const AUTHORITY='https://login.microsoftonline.com/consumers/oauth2/v2.0';
// The Xbox Live scope first: Microsoft issues the device-code response for the first
// resource it is asked about, and that response is what signs in to Xbox Live.
// User.Read is asked for in the same consent so the account service can read the
// Microsoft account's own email. It is requested separately, below, and its token is
// transient: it is never stored, never logged and never leaves this process except on
// the one account request that carries it.
const SCOPE='XboxLive.signin offline_access https://graph.microsoft.com/User.Read';
const GRAPH_SCOPE='https://graph.microsoft.com/User.Read';
// Same public client configuration as /opt/minecraft/launch/mc-auth.py.
// Microsoft displays Prism Launcher for this inherited registration.
// Set EASTER_MICROSOFT_CLIENT_ID when Easter Company has its own approved registration.
const DEFAULT_CLIENT_ID='c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
class AuthError extends Error{constructor(message,code){super(message);this.code=code;}}
class MicrosoftAuth{
 constructor({clientId=DEFAULT_CLIENT_ID,request=fetch,wait=delay}={}){this.clientId=clientId;this.request=request;this.wait=wait;}
 async json(url,options={},signal){
  const response=await this.request(url,{...options,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  let data;try{data=await response.json();}catch{throw new AuthError('The sign-in service returned an unreadable response. Try again.','response');}
  if(!response.ok){
   const xerr=Number(data.XErr);
   const messages={2148916233:'Create an Xbox profile for this Microsoft account, then sign in again.',2148916238:'This account needs Microsoft Family approval before Minecraft can connect.',2148916235:'Xbox Live is unavailable for this account’s country.',2148916236:'Complete the age verification on your Microsoft account.',2148916237:'Complete the age verification on your Microsoft account.'};
   const error=new AuthError(messages[xerr]||(data.error==='invalid_grant'?'Your saved sign-in has expired. Please sign in again.':'Sign-in could not finish. Please try again.'),data.error||String(xerr||response.status));
   error.status=response.status;throw error;
  }
  return data;
 }
 form(endpoint,body,signal){return this.json(AUTHORITY+endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)},signal);}
 post(url,body,signal){return this.json(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},signal);}
 async signIn(notify,signal){
  const code=await this.form('/devicecode',{client_id:this.clientId,scope:SCOPE},signal);
  if(!code.device_code||!code.user_code||!code.verification_uri)throw new AuthError('Microsoft did not return a sign-in code.','response');
  // Only the short-lived user code reaches the UI; never device_code or tokens.
  notify({code:code.user_code,url:code.verification_uri,expiresAt:Date.now()+code.expires_in*1000});
  const deadline=Date.now()+Math.min(code.expires_in,1800)*1000;
  let interval=Math.max(1,code.interval||5)*1000;
  while(Date.now()<deadline){
   await this.wait(interval,undefined,{signal});
   try{
    const msa=await this.form('/token',{grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:this.clientId,device_code:code.device_code},signal);
    return await this.exchange(msa,undefined,signal);
   }catch(error){
    if(error.code==='authorization_pending')continue;
    if(error.code==='slow_down'){interval+=5000;continue;}
    if(error.code==='expired_token')throw new AuthError('The sign-in code expired. Start sign-in again.','expired_token');
    if(error.code==='authorization_declined')throw new AuthError('Sign-in was cancelled in Microsoft.','authorization_declined');
    throw error;
   }
  }
  throw new AuthError('The sign-in code expired. Start sign-in again.','expired_token');
 }
 // Signing in to Xbox Live needs a token for its own audience. Now that the same consent
 // also covers Graph, the audience of the device-code response is Microsoft's choice, so a
 // token Xbox Live refuses is re-issued for the Xbox Live scope from the same refresh token
 // and tried once more rather than failing the player out of a sign-in that did work.
 async xboxSignIn(accessToken,refresh,signal){
  try{return await this.post('https://user.auth.xboxlive.com/user/authenticate',{Properties:{AuthMethod:'RPS',SiteName:'user.auth.xboxlive.com',RpsTicket:'d='+accessToken},RelyingParty:'http://auth.xboxlive.com',TokenType:'JWT'},signal);}
  catch(error){
   if(error.name==='AbortError'||signal?.aborted||!refresh)throw error;
   let scoped;
   try{scoped=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:refresh,scope:'XboxLive.signin'},signal);}catch{throw error;}
   if(!scoped||typeof scoped.access_token!=='string'||!scoped.access_token)throw error;
   return this.post('https://user.auth.xboxlive.com/user/authenticate',{Properties:{AuthMethod:'RPS',SiteName:'user.auth.xboxlive.com',RpsTicket:'d='+scoped.access_token},RelyingParty:'http://auth.xboxlive.com',TokenType:'JWT'},signal);
  }
 }
 // A transient Microsoft Graph token for the account service. The server treats it as
 // optional, so every failure here answers null and the player still signs in.
 async graphAccessToken(refreshToken,signal){
  if(typeof refreshToken!=='string'||!refreshToken)return null;
  try{
   const data=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:refreshToken,scope:GRAPH_SCOPE},signal);
   const token=typeof data?.access_token==='string'&&data.access_token.length<=8192?data.access_token:'';
   return token||null;
  }catch(error){
   if(error.name==='AbortError')return null;
   return null;
  }
 }
 async refresh(session,signal,recheck=false,force=false){
  if(!force&&session.expiresAt>Date.now()+300000)return recheck?this.checkAccess(session,signal):session;
  const msa=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:session.refreshToken,scope:SCOPE},signal);
  return {...await this.exchange(msa,session.refreshToken,signal),accountId:session.accountId||session.profile?.id||'xbox:'+session.xuid};
 }
 async exchange(msa,oldRefresh,signal){
  if(!msa.access_token)throw new AuthError('Microsoft did not return a session.','response');
  const xbox=await this.xboxSignIn(msa.access_token,msa.refresh_token||oldRefresh,signal);
  const xsts=await this.post('https://xsts.auth.xboxlive.com/xsts/authorize',{Properties:{SandboxId:'RETAIL',UserTokens:[xbox.Token]},RelyingParty:'rp://api.minecraftservices.com/',TokenType:'JWT'},signal);
  const uhs=xsts.DisplayClaims?.xui?.[0]?.uhs;
  if(!xsts.Token||!uhs)throw new AuthError('Xbox did not return a Minecraft session.','response');
  const mc=await this.post('https://api.minecraftservices.com/authentication/login_with_xbox',{identityToken:'XBL3.0 x='+uhs+';'+xsts.Token},signal);
  if(!mc.access_token)throw new AuthError('Minecraft did not return a session.','response');
  const xuid=/^\d{1,20}$/.test(String(xsts.DisplayClaims.xui[0].xid||''))?String(xsts.DisplayClaims.xui[0].xid):'0';
  // The user hash is present even when the optional Xbox ID is omitted.
  // Hash it into a stable, non-credential account key; never invent a Java profile.
  const microsoftId='msa:'+createHash('sha256').update(this.clientId+'\0'+String(uhs)).digest('hex');
  return this.checkAccess({clientId:this.clientId,xuid,microsoftId,companySubject:createHash('sha256').update('xbox-uhs:'+String(uhs)).digest('hex'),xboxUserToken:xbox.Token,xboxExpiresAt:Date.parse(xbox.NotAfter)||0,accountId:microsoftId,refreshToken:msa.refresh_token||oldRefresh,accessToken:mc.access_token,expiresAt:Date.now()+(mc.expires_in||86400)*1000,profile:null},signal);
 }
 async checkAccess(session,signal){
  const headers={Authorization:'Bearer '+session.accessToken};
  try{
   const license=await this.json('https://api.minecraftservices.com/entitlements/license?requestId='+randomUUID(),{headers,cache:'no-store'},signal);
   if(!Array.isArray(license.items)||!license.items.every(item=>item&&typeof item.name==='string'))throw new AuthError('The Java access response is invalid.','response');
   const entitled=license.items.some(item=>['game_minecraft','product_minecraft'].includes(item.name));
   if(!entitled)return {...session,minecraftAccess:'missing'};
   let profile;
   try{profile=await this.json('https://api.minecraftservices.com/minecraft/profile',{headers,cache:'no-store'},signal);}
   catch(error){if(error.status===404)return {...session,profile:null,minecraftAccess:'profile-required'};throw error;}
   if(!/^[a-f0-9]{32}$/i.test(profile.id)||!/^\w{1,16}$/.test(profile.name))throw new AuthError('The Java profile response is invalid.','response');
   return {...session,minecraftAccess:'owned',profile:{id:profile.id,name:profile.name,skin:session.profile?.id===profile.id?session.profile.skin:undefined,skinURL:profile.skins?.find(s=>s.state==='ACTIVE')?.url||null}};
  }catch(error){
   if(error.name==='AbortError'||signal?.aborted)throw error;
   // Network/service/auth failures never prove non-ownership.
   return {...session,minecraftAccess:'unknown',expiresAt:[401,403].includes(error.status)?0:session.expiresAt};
  }
 }
}
module.exports={MicrosoftAuth,AuthError,DEFAULT_CLIENT_ID};
