const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {writeEncrypted,readEncrypted,remove}=require('../../desktop/vault.cjs');

// Stand-in for Electron's safeStorage. The wrapped value is reversible here so the
// tests can prove the payload really was handed to the OS-backed encryptor.
function fakeSafeStorage({available=true,backend='gnome_libsecret'}={}){
 const calls=[];
 return {calls,isEncryptionAvailable:()=>available,getSelectedStorageBackend:()=>backend,
  encryptString:value=>{calls.push(value);return Buffer.concat([Buffer.from('sealed:'),Buffer.from(value)]);},
  decryptString:buffer=>buffer.toString('utf8').replace(/^sealed:/,'')};
}
async function tempFile(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easter-vault-'));return {dir,file:path.join(dir,'company.enc')};}

test('a session round-trips through the OS-backed vault',async()=>{
 const {dir,file}=await tempFile();
 const safeStorage=fakeSafeStorage();
 const session={token:'session-token-private',expiresAt:1,account:{id:1}};
 try{
  assert.equal(await writeEncrypted(file,session,{safeStorage,platform:'linux'}),true);
  assert.equal(safeStorage.calls.length,1);
  assert.deepEqual(await readEncrypted(file,{safeStorage,platform:'linux'}),session);
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await assert.rejects(fs.stat(file+'.tmp'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('basic_text is refused exactly like the Microsoft session',async()=>{
 const {dir,file}=await tempFile();
 const safeStorage=fakeSafeStorage({backend:'basic_text'});
 try{
  await assert.rejects(fs.stat(file));
  assert.equal(await writeEncrypted(file,{token:'never-written'},{safeStorage,platform:'linux'}),false);
  await assert.rejects(fs.stat(file),'nothing may be written when the backend is basic_text');
  assert.equal(safeStorage.calls.length,0,'the plaintext backend must never be handed a token');
  // A vault left behind by an older build is not read back either.
  await fs.writeFile(file,Buffer.from('sealed:{"token":"stale"}'));
  assert.equal(await readEncrypted(file,{safeStorage,platform:'linux'}),null);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('an unavailable OS vault stores and reads nothing',async()=>{
 const {dir,file}=await tempFile();
 const safeStorage=fakeSafeStorage({available:false});
 try{
  assert.equal(await writeEncrypted(file,{token:'never-written'},{safeStorage,platform:'darwin'}),false);
  assert.equal(await readEncrypted(file,{safeStorage,platform:'darwin'}),null);
  await assert.rejects(fs.stat(file));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a missing, unreadable or malformed vault is absent, not fatal',async()=>{
 const {dir,file}=await tempFile();
 const safeStorage=fakeSafeStorage();
 try{
  assert.equal(await readEncrypted(file,{safeStorage,platform:'linux'}),null);
  await fs.writeFile(file,crypto.randomBytes(32));
  assert.equal(await readEncrypted(file,{safeStorage,platform:'linux'}),null);
  await fs.writeFile(file,Buffer.from('sealed:not json'));
  assert.equal(await readEncrypted(file,{safeStorage,platform:'linux'}),null);
  await writeEncrypted(file,{token:'x'},{safeStorage,platform:'linux'});
  await remove(file);
  await assert.rejects(fs.stat(file));
  await remove(file);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
