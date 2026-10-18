'use strict';
const path=require('node:path'),crypto=require('node:crypto');
let raw;try{raw=require('original-fs');}catch{raw=require('node:fs');}
const fs=raw.promises;
const REPO='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/download/';
const LATEST='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/latest/download/';
const BOOTSTRAP=1,MAX_BYTES=200*1024*1024;
function version(value){
 const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
 if(!match)throw Error('Invalid launcher release version.');
 const parts=match.slice(1).map(Number);if(!parts.every(Number.isSafeInteger))throw Error('Invalid launcher release version.');return parts;
}
function compare(a,b){const left=version(a),right=version(b);for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0;}
function validate(manifest,{release,platform,arch,runtime}){
 if(!manifest||manifest.schema!==1||manifest.version!==release||manifest.platform!==platform||manifest.arch!==arch)throw Error('The launcher update manifest does not match this release or device.');
 version(release);
 if(manifest.bootstrap!==BOOTSTRAP||manifest.runtime!==runtime)throw Error('This release needs a newer launcher runtime. Install the latest launcher to continue.');
 const asset='Easter-Company-Update-'+platform+'-'+arch+'.asar';
 if(manifest.asset!==asset||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!Number.isSafeInteger(manifest.size)||manifest.size<1||manifest.size>MAX_BYTES)throw Error('The launcher update manifest is invalid.');
 return {...manifest,url:REPO+'launcher-v'+release+'/'+asset};
}
async function json(fetch,url){
 const response=await fetch(url,{signal:AbortSignal.timeout(20000),cache:'no-store',headers:{Accept:'application/json'}});
 if(!response.ok)throw Error('The update service returned HTTP '+response.status+'.');
 const text=await response.text();if(text.length>65536)throw Error('The update response is too large.');
 return JSON.parse(text);
}
async function atomic(file,value){
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);}
 finally{await fs.rm(temp,{force:true});}
}
async function stage(manifest,{root,fetch,notify=()=>{}}){
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const target=path.join(root,manifest.sha256+'.asar'),temp=target+'.'+crypto.randomUUID()+'.part';
 let handle;
 try{
  const response=await fetch(manifest.url,{signal:AbortSignal.timeout(300000)});
  if(!response.ok||!response.body)throw Error('The launcher update could not be downloaded.');
  const length=response.headers.get('content-length');
  if(length!==null&&Number(length)!==manifest.size)throw Error('The launcher update size does not match the release.');
  handle=await fs.open(temp,'wx',0o600);
  const hash=crypto.createHash('sha256');let done=0;
  for await(const chunk of response.body){
   done+=chunk.length;if(done>manifest.size)throw Error('The launcher update exceeds its declared size.');
   hash.update(chunk);await handle.writeFile(chunk);
   notify({phase:'downloading',version:manifest.version,percent:Math.floor(done/manifest.size*100),message:'Updating launcher…'});
  }
  notify({phase:'verifying',version:manifest.version,percent:100,message:'Verifying launcher…'});
  if(done!==manifest.size||hash.digest('hex')!==manifest.sha256)throw Error('The launcher update failed verification. Retry to download a fresh copy.');
  await handle.sync();await handle.close();handle=null;
  // Validate package identity before activation; no downloaded code executes here.
  await fs.rename(temp,target);
  return target;
 }finally{await handle?.close();await fs.rm(temp,{force:true});}
}
async function update({current,platform=process.platform,arch=process.arch,runtime,root,fetch=globalThis.fetch,notify=()=>{},inspect=()=>{}}){
 notify({phase:'checking',percent:null,message:'Checking launcher updates…'});
 const name='Easter-Company-Update-'+platform+'-'+arch+'.json';
 const info=await json(fetch,LATEST+name);
 const release=info?.version;
 const manifest=validate(info,{release,platform,arch,runtime});
 if(compare(release,current)<=0){notify({phase:'current',version:current,percent:null,message:null});return null;}
 const target=await stage(manifest,{root,fetch,notify});
 await inspect(target,manifest);
 await atomic(path.join(root,'current.json'),manifest);
 notify({phase:'restarting',version:release,percent:100,message:'Restarting launcher…'});
 return target;
}
function selected(root,{bundled,runtime,platform=process.platform,arch=process.arch,inspect=()=>{}}){
 try{
  const manifest=JSON.parse(raw.readFileSync(path.join(root,'current.json'),'utf8'));
  validate(manifest,{release:manifest.version,platform,arch,runtime});
  if(compare(manifest.version,bundled)<=0)return null;
  const target=path.join(root,manifest.sha256+'.asar');
  if(raw.statSync(target).size!==manifest.size)return null;
  const bytes=raw.readFileSync(target);
  if(bytes.length!==manifest.size||crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)return null;
  inspect(target,manifest);return target;
 }catch{return null;}
}
function relaunchOptions({platform=process.platform,env=process.env,execPath=process.execPath}={}){
 return {execPath:platform==='linux'&&env.APPIMAGE?env.APPIMAGE:execPath,args:process.argv.includes('--no-sandbox')?['--no-sandbox']:[]};
}
module.exports={update,stage,selected,validate,compare,version,relaunchOptions,BOOTSTRAP};
