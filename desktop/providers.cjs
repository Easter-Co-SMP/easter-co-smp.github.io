'use strict';
const {randomBytes}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const ORIGINS={google:'https://accounts.google.com',discord:'https://discord.com',steam:'https://steamcommunity.com'};
async function providerSignIn(accounts,provider,{token,signal,openExternal,wait=delay}={}){
 if(!ORIGINS[provider])throw Error('Choose a sign-in provider.');
 const verifier=randomBytes(32).toString('base64url');
 const flow=await accounts.call('/v2/accounts/providers/start',{method:'POST',token,signal,body:{provider,verifier,client:accounts.client}});
 let url;try{url=new URL(flow.url);}catch{throw Error('The sign-in address is invalid.');}
 const paths={google:'/o/oauth2/v2/auth',discord:'/oauth2/authorize',steam:'/openid/login'};
 if(url.origin!==ORIGINS[provider]||url.pathname!==paths[provider]||url.username||url.password||!/^[-_a-zA-Z0-9]{43}$/.test(flow.flow||''))throw Error('The sign-in address is invalid.');
 await openExternal(url.href);
 const deadline=Date.now()+Math.min(Number(flow.expiresIn)||600,600)*1000;
 while(Date.now()<deadline){
  await wait(2000,undefined,{signal});
  const result=await accounts.call('/v2/accounts/providers/finish',{method:'POST',token,signal,body:{flow:flow.flow,verifier,client:accounts.client}});
  if(result?.pending===true)continue;
  return accounts.signed(result);
 }
 throw Error('Sign-in expired. Try again.');
}
module.exports={providerSignIn};
