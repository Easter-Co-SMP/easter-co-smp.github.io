'use strict';
// This entry point is excluded from desktop packages. No production test bypass.
//
// The launcher signs in to an Easter Company account with a username and password against a
// loopback account service (the journey owns that stub), and this harness stubs the two things
// such a session has no other way of reaching:
//
//   1. Mojang's public profile and texture endpoints. Both are read by the main process for the
//      head of an account whose Microsoft leg is not live, so nothing about them touches the
//      account service. EASTER_HEAD_MODE decides the answer:
//        'head'    the frozen profile shape, naming a texture, and then that texture's PNG. The
//                  PNG is the same fixture skin tests/desktop/deslop.electron.mjs paints from,
//                  whose face is rgb(200,130,90), so the canvas can be read back exactly.
//        'refused' a 404 from the profile, after EASTER_HEAD_DELAY_MS.
//        'refused-texture' a profile that answers and names a texture, then a 404 for it.
//      Every read of those two endpoints is appended to EASTER_HEAD_LOG, one URL per line, so
//      the journey can prove how many were made, in what order, and over which scheme.
//      The profile names its texture over **http**, exactly as Mojang's own answer does, so the
//      journey also proves the launcher upgrades it: a plaintext request is refused here.
//   2. A safeStorage implementation, because the synthetic journey has no desktop keyring and
//      the account has to survive a restart to prove the head comes from its cache.
const {safeStorage,net}=require('electron');
const crypto=require('node:crypto'),fs=require('node:fs');
if(process.env.EASTER_VAULT_FIXTURE_KEY){
 const key=Buffer.from(process.env.EASTER_VAULT_FIXTURE_KEY,'hex');
 safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=>'fixture-encrypted';
 safeStorage.encryptString=value=>{const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]);};
 safeStorage.decryptString=value=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');};
}
// The fixture skin, byte for byte: a 64x64 PNG whose face is rgb(200,130,90) and whose hat
// layer is transparent, so "the head is on the canvas" is one pixel read rather than a guess.
const SKIN=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQUlEQVR4nO3QwQkAIAwEwdRpOVZnV6YC8xORzMD9j40AADhYc+xqr/9dJ4AAAggggACNAwAAAAAAAAAAAAAAAN9JOwCowfTmxIQAAAAASUVORK5CYII=','base64');
const UUID=process.env.EASTER_HEAD_UUID||'12345678-90ab-cdef-1234-567890abcdef';
// Mojang's own answer names the skin over http, so the fixture does too: the launcher must
// upgrade it, and a plaintext request is refused below rather than quietly answered.
const TEXTURE_HTTP='http://textures.minecraft.net/texture/'+'ab'.repeat(32);
const TEXTURE_HTTPS=TEXTURE_HTTP.replace('http:','https:');
const PROFILE='https://sessionserver.mojang.com/session/minecraft/profile/'+UUID.replace(/-/g,'');
const MODE=process.env.EASTER_HEAD_MODE||'head';
const DELAY=Number(process.env.EASTER_HEAD_DELAY_MS||0);
const LOG=process.env.EASTER_HEAD_LOG||null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const jsonResponse=payload=>({ok:true,status:200,json:async()=>payload});
const pngResponse=bytes=>({ok:true,status:200,body:{getReader(){let sent=false;return {
 async read(){if(sent)return {done:true};sent=true;return {done:false,value:new Uint8Array(bytes)};},
 async cancel(){sent=true;}
};}}});
// What the real profile endpoint answers: the skin texture, base64-wrapped in the `textures`
// property, which is the only part the launcher reads.
const profileAnswer=()=>jsonResponse({id:UUID.replace(/-/g,''),name:'FixtureCaptain',properties:[{name:'textures',value:Buffer.from(JSON.stringify({timestamp:0,profileId:UUID.replace(/-/g,''),profileName:'FixtureCaptain',textures:{SKIN:{url:TEXTURE_HTTP,metadata:{model:'classic'}}}})).toString('base64')}]});
const localFetch=net.fetch.bind(net);
net.fetch=async (resource,options)=>{
 const url=typeof resource==='string'?resource:String(resource?.url||resource);
 if(url!==PROFILE&&url!==TEXTURE_HTTPS&&!url.startsWith('http://textures.minecraft.net/'))
  // Anything else the launcher reads is not part of this proof: the bundled site's own data
  // and the update feed keep the network they always had, and are not recorded here.
  return localFetch(resource,options);
 if(LOG)fs.appendFileSync(LOG,url+'\n');
 if(url.startsWith('http://'))
  // The launcher rewrites the scheme before it asks, so this branch is only reached by a
  // build that would make a plaintext request for a player's skin. It fails rather than
  // answering over the secure scheme, so the mistake cannot pass as success.
  throw Object.assign(new Error('plaintext skin request'),{name:'TypeError'});
 if(url===PROFILE){
  await sleep(DELAY);
  return MODE==='refused'?{ok:false,status:404,json:async()=>({error:'Not Found'})}:profileAnswer();
 }
 await sleep(DELAY);
 return MODE==='head'?pngResponse(SKIN):{ok:false,status:404};
};
require('./harness.cjs');
