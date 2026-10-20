'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {providerSignIn}=require('../../desktop/providers.cjs');
const {allowedPicture,hydratePicture}=require('../../desktop/profile.cjs');
test('provider browser flow keeps verifier and bearer in main process and polls until signed',async()=>{
 const calls=[],opened=[];let polls=0;
 const accounts={client:'fixture',attempt:async(path,options)=>{
  calls.push({path,options});
  if(path.endsWith('/start'))return {flow:'a'.repeat(43),url:'https://discord.com/oauth2/authorize?state=fixture',expiresIn:60};
  return ++polls===1?{pending:true}:{account:{id:1}};
 },signed:value=>value};
 const result=await providerSignIn(accounts,'discord',{token:'fixture-bearer',openExternal:async url=>opened.push(url),wait:async()=>{}});
 assert.equal(result.account.id,1);assert.equal(opened.length,1);
 assert.equal(calls[0].options.token,'fixture-bearer');
 assert.equal(calls[0].options.body.verifier,calls[1].options.body.verifier);
 assert(!opened[0].includes(calls[0].options.body.verifier));
});
test('browser flow rejects a foreign origin before opening any window',async()=>{
 const accounts={attempt:async()=>({flow:'a'.repeat(43),url:'https://attacker.test/oauth',expiresIn:60})};
 await assert.rejects(providerSignIn(accounts,'google',{openExternal:()=>assert.fail('opened attacker URL')}),/address is invalid/);
});
test('cancellation stops provider polling',async()=>{
 const abort=new AbortController();
 const accounts={attempt:async()=>({flow:'a'.repeat(43),url:'https://steamcommunity.com/openid/login',expiresIn:60})};
 await assert.rejects(providerSignIn(accounts,'steam',{signal:abort.signal,openExternal:async()=>abort.abort()}),{name:'AbortError'});
});
test('both halves of the broker wait out a waking service, and pending still means pending',async()=>{
 const {AccountClient}=require('../../desktop/accounts.cjs');
 const calls=[];let clock=1000;const waits=[];const stages=[];
 const api=new AccountClient({baseUrl:'http://127.0.0.1:1',now:()=>clock,waitFor:async ms=>{waits.push(ms);clock+=ms;},
  request:async url=>{
   calls.push(new URL(url).pathname);
   if(calls.filter(u=>u.endsWith('/start')).length<2&&calls.at(-1).endsWith('/start'))
    return new Response(JSON.stringify({error:'database_unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});
   if(calls.at(-1).endsWith('/start'))
    return new Response(JSON.stringify({flow:'a'.repeat(43),url:'https://discord.com/oauth2/authorize?state=fixture',expiresIn:60}),{status:200,headers:{'Content-Type':'application/json'}});
   return new Response(JSON.stringify({pending:true}),{status:200,headers:{'Content-Type':'application/json'}});
  }});
 const started=await api.attempt('/v2/accounts/providers/start',{method:'POST',body:{provider:'discord',verifier:'v'},onWait:s=>stages.push(s)});
 assert.equal(started.flow,'a'.repeat(43),'the start is retried past a waking service');
 assert.deepEqual(stages,['company-waking'],'and says so once per rest');
 assert.deepEqual(waits,[3000],'with the same three-second rest as every other journey');
});

test('profile pictures refuse arbitrary hosts and private destinations',async()=>{
 for(const url of ['http://cdn.discordapp.com/a','https://127.0.0.1/a','https://cdn.discordapp.com.attacker.test/a','https://a.googleusercontent.com@attacker.test/a','https://cdn.discordapp.com:8443/a'])assert.equal(allowedPicture(url),false,url);
 assert(allowedPicture('https://lh3.googleusercontent.com/fixture'));
 const result=await hydratePicture({picture:'https://127.0.0.1/a'},{request:()=>assert.fail('SSRF'),nativeImage:{}});
 assert.equal(result.picture,null);
});
