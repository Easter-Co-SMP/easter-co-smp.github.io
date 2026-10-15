'use strict';
const {setTimeout:delay}=require('node:timers/promises');
const AUTHORITY='https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE='XboxLive.signin offline_access';
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
   throw new AuthError(messages[xerr]||(data.error==='invalid_grant'?'Your saved sign-in has expired. Please sign in again.':response.status===404?'This account has no Minecraft Java profile. Check that it owns Minecraft Java Edition.':'Sign-in could not finish. Please try again.'),data.error||String(xerr||response.status));
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
 async refresh(session,signal){
  if(session.expiresAt>Date.now()+300000)return session;
  const msa=await this.form('/token',{grant_type:'refresh_token',client_id:this.clientId,refresh_token:session.refreshToken,scope:SCOPE},signal);
  return this.exchange(msa,session.refreshToken,signal);
 }
 async exchange(msa,oldRefresh,signal){
  if(!msa.access_token)throw new AuthError('Microsoft did not return a session.','response');
  const xbox=await this.post('https://user.auth.xboxlive.com/user/authenticate',{Properties:{AuthMethod:'RPS',SiteName:'user.auth.xboxlive.com',RpsTicket:'d='+msa.access_token},RelyingParty:'http://auth.xboxlive.com',TokenType:'JWT'},signal);
  const xsts=await this.post('https://xsts.auth.xboxlive.com/xsts/authorize',{Properties:{SandboxId:'RETAIL',UserTokens:[xbox.Token]},RelyingParty:'rp://api.minecraftservices.com/',TokenType:'JWT'},signal);
  const uhs=xsts.DisplayClaims?.xui?.[0]?.uhs;
  if(!xsts.Token||!uhs)throw new AuthError('Xbox did not return a Minecraft session.','response');
  const mc=await this.post('https://api.minecraftservices.com/authentication/login_with_xbox',{identityToken:'XBL3.0 x='+uhs+';'+xsts.Token},signal);
  if(!mc.access_token)throw new AuthError('Minecraft did not return a session.','response');
  const profile=await this.json('https://api.minecraftservices.com/minecraft/profile',{headers:{Authorization:'Bearer '+mc.access_token}},signal);
  if(!/^[a-f0-9]{32}$/i.test(profile.id)||!/^\w{1,16}$/.test(profile.name))throw new AuthError('This account has no valid Minecraft Java profile.','profile');
  return {clientId:this.clientId,xuid:xsts.DisplayClaims.xui[0].xid||'0',refreshToken:msa.refresh_token||oldRefresh,accessToken:mc.access_token,expiresAt:Date.now()+(mc.expires_in||86400)*1000,profile:{id:profile.id,name:profile.name}};
 }
}
module.exports={MicrosoftAuth,AuthError,DEFAULT_CLIENT_ID};
