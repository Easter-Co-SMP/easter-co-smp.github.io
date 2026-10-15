'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {Version,generateArguments,launch}=require('@xmcl/core');
const installer=require('@xmcl/installer');
const {Agent,interceptors}=require('undici');
const dispatcher=new Agent({connections:8,connect:{family:4,timeout:30000},headersTimeout:45000,bodyTimeout:90000}).compose(interceptors.retry({maxRetries:3}));
const ORIGIN='https://easter-co-smp.github.io/';
const FABRIC='0.19.5';
async function json(url){
 const response=await fetch(url,{signal:AbortSignal.timeout(45000),headers:{'User-Agent':'EasterCompanyLauncher/1.0 (easter-co-smp.github.io)'}});
 if(!response.ok)throw Error('Could not download '+new URL(url).hostname+' data (HTTP '+response.status+'). Try again.');
 return response.json();
}
async function atomicJSON(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
async function checksum(file,algorithm){try{const hash=crypto.createHash(algorithm);for await(const chunk of require('node:fs').createReadStream(file))hash.update(chunk);return hash.digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function downloadVerified(url,file,hash,algorithm='sha256'){
 if(new URL(url).protocol!=='https:')throw Error('Insecure download refused.');
 if(!/^[a-f0-9]+$/i.test(hash)||hash.length!==({sha1:40,sha256:64,sha512:128})[algorithm])throw Error('Missing download checksum.');
 if(await checksum(file,algorithm)===hash)return false;
 await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.part';
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw Error('Download failed (HTTP '+response.status+'). Your installed files are unchanged.');
  const handle=await fs.open(temp,'wx',0o600);
  const digest=crypto.createHash(algorithm);
  let size=0;
  try{for await(const chunk of response.body){size+=chunk.length;if(size>256*1024*1024)throw Error('Download exceeds its size limit.');digest.update(chunk);await handle.writeFile(chunk);}}finally{await handle.close();}
  if(digest.digest('hex')!==hash)throw Error('Download checksum did not match. The previous file was kept.');
  await fs.rename(temp,file);return true;
 }finally{await fs.rm(temp,{force:true});}
}
async function resolveMod(mod,minecraft){
 if(!/^[a-z0-9-]{1,80}$/.test(mod.id)||typeof mod.version!=='string'||!mod.version)throw Error('Invalid pinned mod release.');
 const versions=await json('https://api.modrinth.com/v2/project/'+encodeURIComponent(mod.id)+'/version');
 const match=versions.find(v=>v.game_versions.includes(minecraft)&&v.loaders.includes('fabric')&&(v.version_number===mod.version||v.files.some(f=>f.filename.includes(mod.version))));
 if(!match)throw Error('The pinned '+mod.name+' version is unavailable for Minecraft '+minecraft+'.');
 const file=match.files.find(f=>f.primary)||match.files[0];
 if(!file||!file.hashes?.sha512||new URL(file.url).hostname!=='cdn.modrinth.com')throw Error('The mod publisher did not provide a verified download.');
 return {name:mod.name,url:file.url,hash:file.hashes.sha512,algorithm:'sha512',filename:mod.id+'.jar'};
}
async function javaMajor(javaPath){
 const {stderr,stdout}=await promisify(execFile)(javaPath,['-version'],{timeout:15000,windowsHide:true,maxBuffer:16384});
 const match=(stderr+stdout).match(/(?:openjdk|java) version "(\d+)/);
 if(!match)throw Error('The selected executable did not report a Java version.');
 return Number(match[1]);
}
async function tracked(task,label,notify){
 let last=0;
 notify({phase:'installing',message:label,progress:null});
 await task.startAndWait({onUpdate(){if(Date.now()-last<150)return;last=Date.now();notify({phase:'installing',message:label,progress:task.total>0?Math.min(100,Math.round(task.progress/task.total*100)):null});}});
}
async function installAssets(root,assetIndex,notify){
 if(!assetIndex||!/^[a-z0-9._-]+$/i.test(assetIndex.id)||!/^https:\/\//.test(assetIndex.url))throw Error('Invalid asset index.');
 const indexFile=path.join(root,'assets','indexes',assetIndex.id+'.json');
 await downloadVerified(assetIndex.url,indexFile,assetIndex.sha1,'sha1');
 const index=JSON.parse(await fs.readFile(indexFile,'utf8'));
 const entries=Object.values(index.objects),unique=[...new Map(entries.map(row=>[row.hash,row])).values()];
 if(unique.length>100000||unique.some(row=>!/^[a-f0-9]{40}$/.test(row.hash)))throw Error('Invalid asset catalogue.');
 let next=0,finished=0,last=0,failure;
 notify({phase:'installing',message:'Verifying game sounds & textures',progress:0});
 async function worker(){
  while(next<unique.length&&!failure){
   const row=unique[next++];
   try{await downloadVerified('https://resources.download.minecraft.net/'+row.hash.slice(0,2)+'/'+row.hash,path.join(root,'assets','objects',row.hash.slice(0,2),row.hash),row.hash,'sha1');}
   catch(error){failure=error;}
   finished++;
   if(Date.now()-last>150){last=Date.now();notify({phase:'installing',message:'Verifying game sounds & textures',progress:Math.round(finished/unique.length*100)});}
  }
 }
 await Promise.all(Array.from({length:6},worker));
 if(failure)throw failure;
}
function launchOptions({root,version,javaPath,session,settings}){
 const extraMCArgs=[];
 if(settings.server)extraMCArgs.push('--quickPlayMultiplayer',settings.server);
 return {gamePath:root,resourcePath:root,version,javaPath,gameProfile:session.profile,accessToken:session.accessToken,userType:'msa',launcherName:'Easter Company',launcherBrand:'1.0.0',maxMemory:settings.memoryMB,minMemory:1024,extraMCArgs,features:{easter_identity:{clientid:session.clientId||require('./auth.cjs').DEFAULT_CLIENT_ID,auth_xuid:session.xuid||'0'}},extraExecOption:{shell:false,windowsHide:true}};
}
async function prepare(root,settings,notify){
 const client=await json(ORIGIN+'data/client.json');
 if(!/^\d[\w.+-]*$/.test(client.minecraft)||!Array.isArray(client.dependencies)||client.dependencies.length>30)throw Error('The client release manifest is invalid.');
 const list=await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
 const meta=list.versions.find(v=>v.id===client.minecraft);
 if(!meta)throw Error('Minecraft '+client.minecraft+' is not in Mojang’s release catalogue.');
 const vanilla=await json(meta.url);
 const major=vanilla.javaVersion?.majorVersion||25;
 await fs.mkdir(root,{recursive:true});
 let javaPath=settings.javaPath;
 if(javaPath){
  if(await javaMajor(javaPath)!==major)throw Error('This client requires Java '+major+'. Choose the matching Java executable or use the automatic runtime.');
 }else{
  const runtimeRoot=path.join(root,'runtime',vanilla.javaVersion?.component||'java-runtime-epsilon');
  javaPath=path.join(runtimeRoot,...(process.platform==='darwin'?['jre.bundle','Contents','Home','bin','java']:['bin',process.platform==='win32'?'java.exe':'java']));
  let usable=false;try{usable=await javaMajor(javaPath)===major;}catch{}
  if(!usable){
   notify({phase:'installing',message:'Preparing Java '+major,progress:null});
   const target=vanilla.javaVersion?.component||'java-runtime-epsilon';
   const runtimes=await json(installer.DEFAULT_RUNTIME_ALL_URL);
   const platformKey=process.platform==='win32'?'windows-x64':process.platform==='darwin'?'mac-os':'linux';
   const entry=runtimes[platformKey]?.[target]?.[0];
   if(!entry)throw Error('Mojang does not provide this Java runtime for your platform. Choose a Java '+major+' executable in Client settings.');
   const runtime={...await json(entry.manifest.url),target,version:entry.version};
   for(const [file,entry] of Object.entries(runtime.files)){
    const destination=path.resolve(runtimeRoot,file);
    if(!destination.startsWith(runtimeRoot+path.sep))throw Error('Invalid Java runtime path.');
    if(entry.type==='link'&&!path.resolve(path.dirname(destination),entry.target).startsWith(runtimeRoot+path.sep))throw Error('Invalid Java runtime link.');
   }
   await tracked(installer.installJavaRuntimeTask({destination:runtimeRoot,manifest:runtime,dispatcher}),'Installing Java '+major,notify);
   for(const [file,entry] of Object.entries(runtime.files)){
    const destination=path.join(runtimeRoot,file);
    if(entry.type==='file'&&entry.executable&&process.platform!=='win32')await fs.chmod(destination,0o755);
    if(entry.type==='link'){try{await fs.lstat(destination);}catch(error){if(error.code!=='ENOENT')throw error;await fs.symlink(entry.target,destination);}}
   }
   if(await javaMajor(javaPath)!==major)throw Error('The downloaded Java runtime does not match this Minecraft version.');
  }
 }
 await tracked(installer.installVersionTask(meta,root,{dispatcher}),'Verifying Minecraft',notify);
 await installAssets(root,vanilla.assetIndex,notify);
 notify({phase:'installing',message:'Preparing Fabric '+FABRIC,progress:null});
 const version=await installer.installFabric({minecraftVersion:client.minecraft,version:FABRIC,minecraft:root});
 const resolved=await Version.parse(root,version);
 await tracked(installer.installLibrariesTask(resolved,{dispatcher}),'Verifying Fabric libraries',notify);
 const customURL=new URL(client.mod.url,ORIGIN);
 if(customURL.origin!==new URL(ORIGIN).origin||customURL.pathname!=='/downloads/easter-navy.jar')throw Error('Unexpected custom mod location.');
 const mods=[{name:'Easter Co. client',url:customURL.href,hash:client.mod.sha256,algorithm:'sha256',filename:'easter-navy.jar'}];
 for(const dependency of client.dependencies)mods.push(await resolveMod(dependency,client.minecraft));
 // Resolve every pinned version first. Only verified downloads replace managed files.
 for(let index=0;index<mods.length;index++){
  const mod=mods[index];notify({phase:'installing',message:'Verifying '+mod.name,progress:Math.round(index/mods.length*100)});
  await downloadVerified(mod.url,path.join(root,'mods',mod.filename),mod.hash,mod.algorithm);
 }
 await atomicJSON(path.join(root,'installed.json'),{version,minecraft:client.minecraft,fabric:FABRIC,mod:client.mod.version,files:mods.map(m=>m.filename),updatedAt:new Date().toISOString()});
 notify({phase:'ready',message:'Client ready',progress:100});
 return {version,javaPath};
}
module.exports={ORIGIN,FABRIC,atomicJSON,checksum,downloadVerified,resolveMod,javaMajor,tracked,installAssets,launchOptions,prepare,generateArguments,launch};
