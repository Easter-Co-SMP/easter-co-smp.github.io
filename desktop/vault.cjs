'use strict';
// App-owned encrypted vault. Sessions live here and nowhere else: OS-backed
// safeStorage only. basic_text is refused, exactly as the Microsoft session is.
const fs=require('node:fs/promises');
async function writeEncrypted(file,payload,{safeStorage,platform=process.platform}={}){
 if(!safeStorage?.isEncryptionAvailable())return false;
 if(platform==='linux'&&safeStorage.getSelectedStorageBackend?.()==='basic_text')return false;
 const temp=file+'.tmp';
 await fs.writeFile(temp,safeStorage.encryptString(JSON.stringify(payload)),{mode:0o600});
 await fs.rename(temp,file);
 return true;
}
async function readEncrypted(file,{safeStorage,platform=process.platform}={}){
 if(!safeStorage?.isEncryptionAvailable())return null;
 if(platform==='linux'&&safeStorage.getSelectedStorageBackend?.()==='basic_text')return null;
 try{return JSON.parse(safeStorage.decryptString(await fs.readFile(file)));}catch{return null;}
}
async function remove(file){await fs.rm(file,{force:true});}
module.exports={writeEncrypted,readEncrypted,remove};
