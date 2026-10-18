'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {providerSignIn}=require('../../desktop/providers.cjs');
const {allowedPicture,hydratePicture}=require('../../desktop/profile.cjs');
test('provider browser flow keeps verifier and bearer in main process and polls until signed',async()=>{
 const calls=[],opened=[];let polls=0;
 const accounts={client:'fixture',call:async(path,options)=>{
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
 const accounts={call:async()=>({flow:'a'.repeat(43),url:'https://attacker.test/oauth',expiresIn:60})};
 await assert.rejects(providerSignIn(accounts,'google',{openExternal:()=>assert.fail('opened attacker URL')}),/address is invalid/);
});
test('cancellation stops provider polling',async()=>{
 const abort=new AbortController();
 const accounts={call:async()=>({flow:'a'.repeat(43),url:'https://steamcommunity.com/openid/login',expiresIn:60})};
 await assert.rejects(providerSignIn(accounts,'steam',{signal:abort.signal,openExternal:async()=>abort.abort()}),{name:'AbortError'});
});
test('profile pictures refuse arbitrary hosts and private destinations',async()=>{
 for(const url of ['http://cdn.discordapp.com/a','https://127.0.0.1/a','https://cdn.discordapp.com.attacker.test/a','https://a.googleusercontent.com@attacker.test/a','https://cdn.discordapp.com:8443/a'])assert.equal(allowedPicture(url),false,url);
 assert(allowedPicture('https://lh3.googleusercontent.com/fixture'));
 const result=await hydratePicture({picture:'https://127.0.0.1/a'},{request:()=>assert.fail('SSRF'),nativeImage:{}});
 assert.equal(result.picture,null);
});
