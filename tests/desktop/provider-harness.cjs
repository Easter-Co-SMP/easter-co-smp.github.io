'use strict';
const {shell,safeStorage}=require('electron');
// This synthetic journey has no desktop keyring. Exercise vault encryption and
// restart loading with an explicit test-only AES-GCM safeStorage implementation.
if(process.env.EASTER_VAULT_FIXTURE_KEY){
 const crypto=require('node:crypto'),key=Buffer.from(process.env.EASTER_VAULT_FIXTURE_KEY,'hex');
 safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=> 'fixture-encrypted';
 safeStorage.encryptString=value=>{const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]);};
 safeStorage.decryptString=value=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');};
}
shell.openExternal=async target=>{
 const url=new URL(target);
 if(['accounts.google.com','discord.com','steamcommunity.com'].includes(url.hostname)){
  const state=url.searchParams.get('state')||new URL(url.searchParams.get('openid.return_to')).searchParams.get('state');
  const provider=url.hostname==='discord.com'?'discord':url.hostname==='accounts.google.com'?'google':'steam';
  const response=await fetch(process.env.EASTER_API_BASE_URL+'/v2/accounts/providers/'+provider+'/callback?'+new URLSearchParams({state,code:'fixture-code-'+process.env.EASTER_IDENTITY_FIXTURE_SEED}));
  if(!response.ok)throw Error('Fixture callback failed.');
 }
};
require('./company-harness.cjs');
