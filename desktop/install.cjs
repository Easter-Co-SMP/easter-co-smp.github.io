'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {Version,generateArguments,launch}=require('@xmcl/core');
const installer=require('@xmcl/installer');
const {Agent,interceptors}=require('undici');
const {locationProblem,MARKER,clientOrigin,serverAddress}=require('./config.cjs');
const {qualitySettings,applyQualitySettings,recordQuality,applyDisplayDefaults,SHADER_PACK_NAME}=require('./hardware.cjs');
const {configureVisuals,disableShaders}=require('./visuals.cjs');
const dispatcher=new Agent({connections:8,connect:{family:4,timeout:30000},headersTimeout:45000,bodyTimeout:90000}).compose(interceptors.retry({maxRetries:3}));
const ORIGIN='https://easter-co-smp.github.io/';
const FABRIC='0.19.5';
const LOOPBACK=new Set(['127.0.0.1','[::1]','::1','localhost']);
const MAX_DOWNLOAD=256*1024*1024;
const HASH=/^(sha256|sha512):([a-f0-9]+)$/;
// Content reads and transferred bytes, counted so a test can prove that a run
// which found nothing to do performed no reads of the frozen files.
const stats={hashReads:0,bytesFetched:0};
function transferStats(){return {...stats};}
function resetTransferStats(){stats.hashReads=0;stats.bytesFetched=0;}
async function exists(file){try{await fs.stat(file);return true;}catch{return false;}}
// ---- progress ---------------------------------------------------------------
// One meter per step. Speed is measured from the samples actually observed, never
// assumed: with no sample window, or too little data, every derived field stays
// null and the UI says nothing rather than guessing.
const SPEED_WINDOW_MS=10000,SPEED_MIN_MS=600,SPEED_MIN_BYTES=32*1024;
class Transfer{
 constructor({now=Date.now,windowMs=SPEED_WINDOW_MS,minElapsedMs=SPEED_MIN_MS,minBytes=SPEED_MIN_BYTES}={}){
  this.now=now;this.windowMs=windowMs;this.minElapsedMs=minElapsedMs;this.minBytes=minBytes;
  this.label='';this.total=null;this.done=0;this.samples=[];this.startedAt=null;this.bytes=false;
 }
 reset(label=this.label){this.label=label;this.total=null;this.done=0;this.samples=[];this.startedAt=null;this.bytes=false;return this;}
 begin(label,total=null){
  this.reset(label);
  this.bytes=true;
  this.total=Number.isFinite(total)&&total>0?Math.floor(total):null;
  this.startedAt=this.now();
  return this;
 }
 add(bytes){return this.set(this.done+bytes);}
 // Absolute progress, because the underlying tasks report a running total.
 set(value,total){
  const next=Math.max(0,Number.isFinite(value)?Math.floor(value):0);
  if(next<this.done)this.samples=[];
  const delta=next-this.done;
  this.done=next;this.bytes=true;
  if(Number.isFinite(total)&&total>0)this.total=Math.floor(total);
  if(this.startedAt===null)this.startedAt=this.now();
  if(delta>0)this.record(delta);
  return this;
 }
 record(bytes){
  const at=this.now();
  this.samples.push({at,bytes});
  const cutoff=at-this.windowMs;
  while(this.samples.length>1&&this.samples[0].at<cutoff)this.samples.shift();
 }
 get elapsedMs(){return this.startedAt===null?0:this.now()-this.startedAt;}
 get bytesPerSecond(){
  if(!this.bytes||this.startedAt===null)return null;
  if(this.elapsedMs<this.minElapsedMs||this.done<this.minBytes)return null;
  const recent=this.samples.filter(sample=>sample.at>=this.now()-this.windowMs);
  const sample=recent.length?recent:this.samples;
  if(!sample.length)return null;
  const moved=sample.reduce((sum,item)=>sum+item.bytes,0);
  const span=sample[sample.length-1].at-sample[0].at;
  if(span>0)return moved*1000/span;
  return this.elapsedMs>0?this.done*1000/this.elapsedMs:null;
 }
 get percent(){return this.total===null?null:Math.max(0,Math.min(100,Math.round(this.done/this.total*100)));}
 get etaSeconds(){
  const rate=this.bytesPerSecond;
  if(this.total===null||rate===null||rate<=0)return null;
  return Math.max(0,Math.round((this.total-this.done)/rate));
 }
 snapshot(){return {label:this.label,percent:this.percent,bytesDone:this.bytes?this.done:null,bytesTotal:this.bytes?this.total:null,bytesPerSecond:this.bytesPerSecond,etaSeconds:this.etaSeconds};}
}
// Progress for a task whose unit is not bytes (an item count, an extraction step).
function countProgress(label,percent){
 return {label,percent:Number.isFinite(percent)?Math.max(0,Math.min(100,Math.round(percent))):null,bytesDone:null,bytesTotal:null,bytesPerSecond:null,etaSeconds:null};
}
// ---- pause, resume and cancel ----------------------------------------------
class Cancelled extends Error{constructor(){super('The download was cancelled.');this.name='CancelledError';this.code='cancelled';}}
// A transfer that can be parked and let go again. While parked, a byte transfer
// stops pulling from its socket, so no further bytes are fetched for the install
// and progress cannot advance; the same response resumes where it stopped instead
// of downloading the file again.
class TransferControl{
 constructor({onChange=()=>{}}={}){
  this.paused=false;this.cancelled=false;this.waiting=[];this.task=null;this.onChange=onChange;
 }
 get active(){return !this.cancelled;}
 get resumable(){return this.paused&&!this.cancelled;}
 setTask(task){
  this.task=task;
  if(task&&this.paused)Promise.resolve(task.pause?.()).catch(()=>{});
 }
 clearTask(task){if(this.task===task)this.task=null;}
 pause(){
  if(this.cancelled||this.paused)return false;
  this.paused=true;
  const task=this.task;if(task)Promise.resolve(task.pause?.()).catch(()=>{});
  this.onChange();
  return true;
 }
 resume(){
  if(!this.paused)return false;
  this.paused=false;
  const task=this.task;if(task)Promise.resolve(task.resume?.()).catch(()=>{});
  for(const release of this.waiting.splice(0))release();
  this.onChange();
  return true;
 }
 cancel(){
  if(this.cancelled)return false;
  this.cancelled=true;this.paused=false;
  const task=this.task;if(task)Promise.resolve(task.cancel?.()).catch(()=>{});
  for(const release of this.waiting.splice(0))release();
  this.onChange();
  return true;
 }
 async gate(){
  while(this.paused&&!this.cancelled)await new Promise(resolve=>this.waiting.push(resolve));
  if(this.cancelled)throw new Cancelled();
 }
}
function createControl(options){return new TransferControl(options);}
// ---- download failures, worded for the player and recorded for the owner -----
// A download failure is one sentence about what stopped and what to do about it. The HTTP
// status is not part of that sentence: the player cannot act on a number, and the same rule
// already applies to every sign-in sentence (desktop/auth.cjs). The status rides on the error
// instead (`httpStatus`, plus the `host` and `step` that produced it), and one line per failure
// goes to the launcher's failure record, which is where an owner diagnoses from.
//
// This file owns no log file and no paths: main.cjs owns those, and hands in the launcher's
// existing bounded, redacted line log (`SignInLog` in desktop/auth.cjs, `append({step,outcome,
// status,code,note})`) through setFailureLog(). Until it does, a failure still carries its status
// and simply writes nothing, so a build wired to an older main is never worse than before.
let failureLog=null;
function setFailureLog(log){failureLog=log&&typeof log.append==='function'?log:null;}
function downloadFault(message,{step='download',status,host}={}){
 const fault=Error(message);
 // Never an HTTP status, a URL or a response body in the sentence; those stay on the error.
 if(Number.isInteger(status))fault.httpStatus=status;
 if(typeof host==='string'&&host)fault.host=host;
 fault.step=step;
 try{failureLog?.append({step,outcome:'failed',status:Number.isInteger(status)?status:undefined,note:host});}catch{}
 return fault;
}
// ---- downloads --------------------------------------------------------------
function originBase(value){return String(value||'').replace(/\/+$/,'')+'/';}
async function json(url,origin){
 const response=await fetch(url,{signal:AbortSignal.timeout(45000),headers:{'User-Agent':'EasterCompanyLauncher/1.0 (easter-co-smp.github.io)'}});
 if(!response.ok)throw downloadFault('Could not download '+new URL(url).hostname+' data. Try again.',{step:'data',status:response.status,host:new URL(url).hostname});
 return response.json();
}
async function atomicJSON(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
async function checksum(file,algorithm){
 stats.hashReads++;
 try{const hash=crypto.createHash(algorithm);for await(const chunk of require('node:fs').createReadStream(file))hash.update(chunk);return hash.digest('hex');}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function partPath(file){return file+'.part';}
function partState(file){return file+'.part.json';}
// The single-file primitive. The checksum gates every byte: a transfer only ever
// becomes the real file after its digest matches, so a failed, cancelled or
// mismatched download replaces nothing.
//
// An interrupted transfer keeps its partial data and the running digest is seeded
// from those bytes on the next attempt, which then asks for the rest with a Range
// request. A corrupt or truncated prefix cannot survive that: the whole-file
// checksum still decides, and a mismatch discards the partial file and fetches it
// again from the start rather than trusting it.
async function downloadVerified(url,file,hash,algorithm='sha256',options={}){
 const {control=null,meter=null,onProgress=null,onBytes=null,idleTimeoutMs=180000,attempt=0}=options;
 const target=new URL(url);
 // Checksums gate every byte here, so a plaintext source is only accepted on the
 // loopback interface, where the traffic never leaves the machine. No upstream
 // host is ever fetched over http.
 if(target.protocol!=='https:'&&!(target.protocol==='http:'&&LOOPBACK.has(target.hostname.toLowerCase())))throw Error('Insecure download refused.');
 if(!/^[a-f0-9]+$/i.test(hash)||hash.length!==({sha1:40,sha256:64,sha512:128})[algorithm])throw Error('Missing download checksum.');
 if(await checksum(file,algorithm)===hash)return false;
 await fs.mkdir(path.dirname(file),{recursive:true});
 const part=partPath(file),state=partState(file);
 // Resume only from a partial file this launcher wrote for this exact download.
 let prefix=0;
 try{
  const saved=JSON.parse(await fs.readFile(state,'utf8'));
  const size=(await fs.stat(part)).size;
  if(saved&&saved.url===url&&saved.hash===hash&&saved.algorithm===algorithm&&size>0&&(!saved.total||size<saved.total))prefix=size;
 }catch{}
 if(!prefix)await fs.rm(part,{force:true});
 let digest=crypto.createHash(algorithm);
 const abort=new AbortController();
 const handle=await fs.open(part,prefix?'r+':'w',0o600);
 let position=prefix,idle=null,complete=false,received=0;
 const report=()=>{if(onProgress&&meter)onProgress(meter.snapshot());};
 // A stalled transfer is still bounded, but time spent parked does not count.
 const arm=()=>{clearTimeout(idle);idle=setTimeout(()=>abort.abort(Object.assign(Error('The download stopped responding.'),{name:'TimeoutError'})),idleTimeoutMs);};
 try{
  // Seed the digest from the bytes already on disk, so the finished file is still
  // verified as a whole rather than trusting the prefix.
  if(prefix)for await(const chunk of require('node:fs').createReadStream(part))digest.update(chunk);
  await fs.writeFile(state,JSON.stringify({url,hash,algorithm}),{mode:0o600});
  await control?.gate();
  const response=await fetch(url,{signal:abort.signal,headers:prefix?{Range:'bytes='+prefix+'-'}:{}});
  if(prefix&&response.status===200){
   // The source ignored the range: start this attempt over rather than append to
   // a prefix the server did not agree to continue from. The body is the whole
   // file, so it is read from the beginning as usual.
   await handle.truncate(0);
   prefix=0;position=0;received=0;
   digest=crypto.createHash(algorithm);
  }else if(prefix&&response.status!==206&&response.status!==416){
   await response.body?.cancel?.().catch(()=>{});
   throw downloadFault('The download could not be resumed. Your installed files are unchanged.',{step:'resume',status:response.status,host:target.hostname});
  }
  // 416 means the partial file is already at least as long as the source, so there
  // is nothing left to append and the whole file is judged by its checksum below.
  if(response.status!==416){
   if(!response.ok)throw downloadFault('The download stopped before it finished. Your installed files are unchanged.',{step:'download',status:response.status,host:target.hostname});
   if(!response.body)throw downloadFault('The download stopped before it finished. Your installed files are unchanged.',{step:'download',host:target.hostname});
   const declared=Number(response.headers.get('content-length'));
   if(!prefix&&meter)meter.begin(meter.label,Number.isFinite(declared)&&declared>0?declared+prefix:null);
   report();arm();
   const reader=response.body.getReader();
   for(;;){
    if(control){
     if(control.paused&&idle){clearTimeout(idle);idle=null;}
     await control.gate();
     if(!idle)arm();
    }
    const {done,value}=await reader.read();
    if(done)break;
    received+=value.length;
    if(position+received>MAX_DOWNLOAD)throw Error('Download exceeds its size limit.');
    digest.update(value);
    await handle.write(value,0,value.length,position+received-value.length);
    stats.bytesFetched+=value.length;
    if(onBytes)onBytes(value.length);
    if(meter)meter.add(value.length);
    report();
   }
  }
  if(digest.digest('hex')!==hash){
   // Either the source sent something wrong or the resumed prefix was not the
   // bytes it claimed to be. Nothing is trusted: drop it and fetch once cleanly.
   await handle.close();
   await fs.rm(part,{force:true});await fs.rm(state,{force:true});
   if(prefix&&attempt<1)return downloadVerified(url,file,hash,algorithm,{...options,attempt:attempt+1,meter:meter?meter.reset(meter.label):null});
   throw Error('Download checksum did not match. The previous file was kept.');
  }
  complete=true;
  await fs.rename(part,file);
  await fs.rm(state,{force:true});
  return true;
 }finally{
  clearTimeout(idle);
  try{await handle.close();}catch{}
  if(!complete)abort.abort();
 }
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
// ---- content chunks ---------------------------------------------------------
// doc/launcher-states.md: the manifest describes the client as named chunks, each
// with its own content-derived version, an optional flag and an immutable flag.
// A manifest with no chunk list stays valid, so the flat fields still work.
function chunkList(published,origin=clientOrigin()){
 if(published?.chunks===undefined||published?.chunks===null)return null;
 if(!Array.isArray(published.chunks)||!published.chunks.length)throw Error('The client release manifest has an invalid chunk list.');
 if(published.chunks.length>16)throw Error('The client release manifest has too many chunks.');
 const seen=new Set();
 return published.chunks.map(chunk=>{
  if(!chunk||typeof chunk!=='object')throw Error('The client release manifest has an invalid chunk.');
  const id=String(chunk.id||'');
  if(!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)||seen.has(id))throw Error('The client release manifest has an invalid chunk id.');
  seen.add(id);
  const optional=Boolean(chunk.optional),immutable=Boolean(chunk.immutable);
  // A required chunk that is not immutable could let a stale copy pass as current.
  if(!optional&&!immutable)throw Error('The required '+id+' chunk must be immutable.');
  // The version is the chunk's identity and is derived from its content, but it is
  // consumed as an opaque string: it is compared with what the installed marker
  // records and never parsed, so a future digest scheme cannot break the launcher.
  const version=chunk.version;
  if(typeof version!=='string'||!version.trim())throw Error('The '+id+' chunk has no version.');
  const name=String(chunk.name??'').trim();
  if(!name)throw Error('The '+id+' chunk has no name.');
  if(!Array.isArray(chunk.files)||!chunk.files.length)throw Error('The '+id+' chunk has no files.');
  const files=chunk.files.map(entry=>{
   const relative=String(entry?.path||'');
   if(!relative||relative.startsWith('/')||relative.includes('\\')||relative.split('/').includes('..'))throw Error('The '+id+' chunk describes an invalid file path.');
   const match=HASH.exec(String(entry?.hash||''));
   if(!match)throw Error('The '+id+' chunk is missing a verified checksum for '+relative+'.');
   const algorithm=match[1],digest=match[2];
   if((algorithm==='sha256'&&digest.length!==64)||(algorithm==='sha512'&&digest.length!==128))throw Error('The '+id+' chunk has a truncated checksum for '+relative+'.');
   const size=Number(entry?.size);
   if(!Number.isInteger(size)||size<=0)throw Error('The '+id+' chunk is missing the size of '+relative+'.');
   const location=String(entry?.url||'').trim();
   if(!location)throw Error('The '+id+' chunk is missing the location of '+relative+'.');
   let url;
   try{url=new URL(location,origin);}catch{throw Error('The '+id+' chunk has an invalid file location.');}
   if(url.protocol!=='https:'&&!(url.protocol==='http:'&&LOOPBACK.has(url.hostname.toLowerCase())))throw Error('The '+id+' chunk has an insecure file location.');
   return {id:String(entry.id||''),name:String(entry.name||''),version:String(entry.version||''),path:relative.endsWith('.jar')?'mods/'+path.posix.basename(relative):relative,url:url.href,hash:digest,algorithm,size};
  });
  if(chunk.fabric!==undefined&&chunk.fabric!==null&&typeof chunk.fabric!=='string')throw Error('The '+id+' chunk has an invalid fabric pin.');
  if(chunk.java!==undefined&&chunk.java!==null&&!Number.isInteger(chunk.java))throw Error('The '+id+' chunk has an invalid Java pin.');
  return {id,name,optional,immutable,version,files,fabric:chunk.fabric??null,java:chunk.java??null};
 });
}
function selectedChunks(chunks,includeGraphics){return chunks.filter(chunk=>!chunk.optional||includeGraphics);}
// A chunk whose recorded version still matches is not fetched and not re-verified.
function pendingChunks(chunks,record,includeGraphics){
 const recorded=record?.chunks||{};
 return chunks.filter(chunk=>recorded[chunk.id]?.version!==chunk.version||chunk.files.some(file=>!recorded[chunk.id]?.files?.includes(file.path)));
}
function chunkFileTarget(root,relative){
 const base=path.resolve(root),target=path.resolve(base,relative);
 if(target!==base&&!target.startsWith(base+path.sep))throw Error('Invalid chunk file path.');
 return target;
}
// Enhanced graphics + shaders travel as the optional graphics chunk. Nothing is
// downloaded until the manifest declares it: the payload is Owen's decision, and an
// install without one reports that instead of pretending it installed shaders.
function graphicsEntry(graphics,origin=clientOrigin()){
 if(!graphics||typeof graphics!=='object')return null;
 const filename=String(graphics.filename||'');
 if(!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(filename))throw Error('The published graphics payload has an invalid filename.');
 const base=originBase(origin);
 const url=new URL(String(graphics.url||''),base);
 if(url.origin!==new URL(base).origin||url.username||url.password)throw Error('Unexpected graphics location.');
 if(typeof graphics.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(graphics.sha256))throw Error('The published graphics payload is missing its checksum.');
 return {name:String(graphics.name||'Enhanced graphics'),version:String(graphics.version||''),filename,hash:graphics.sha256,url:url.href};
}
function graphicsPlan(published,includeGraphics,origin=clientOrigin()){
 if(!includeGraphics)return {state:'skipped',entry:null,message:null};
 const entry=graphicsEntry(published?.graphics,origin);
 if(!entry)return {state:'not-published',entry:null,message:'Enhanced graphics are not published yet, so the client was installed without them.'};
 return {state:'install',entry,message:entry.name+' installed.'};
}
// The client's own jar is published as a relative path beside the manifest, so it
// is resolved against the client origin and must stay on it.
function modFile(client,origin=clientOrigin()){
 const base=originBase(origin);
 const url=new URL(String(client?.mod?.url||''),base);
 if(url.origin!==new URL(base).origin||url.username||url.password||url.pathname!=='/downloads/easter-navy.jar')throw Error('Unexpected custom mod location.');
 return url.href;
}
async function javaMajor(javaPath){
 const {stderr,stdout}=await promisify(execFile)(javaPath,['-version'],{timeout:15000,windowsHide:true,maxBuffer:16384});
 const match=(stderr+stdout).match(/(?:openjdk|java) version "(\d+)/);
 if(!match)throw Error('The selected executable did not report a Java version.');
 return Number(match[1]);
}
// A @xmcl task reports its own totals. Downloads report bytes, so a known total
// gives bytesDone/bytesTotal/speed/ETA; an extraction or count-based task reports
// only a percentage and leaves every byte field null.
async function tracked(task,label,notify,{control=null,phase='installing',meter=new Transfer()}={}){
 let last=0,seen=-1,begun=false;
 const publish=force=>{
  const at=Date.now();
  if(!force&&at-last<150)return;
  last=at;
  const total=Number(task.total)>0?Math.floor(task.total):null;
  if(total===null){meter.reset(label);notify({phase,message:label,progress:countProgress(label,null)});return;}
  const done=Math.max(0,Math.floor(Number(task.progress)||0));
  if(done===seen&&!force)return;
  seen=done;
  if(!begun){meter.begin(label,total);begun=true;}
  meter.set(done,total);
  notify({phase,message:label,progress:meter.snapshot()});
 };
 publish(true);
 control?.setTask(task);
 try{await task.startAndWait({onUpdate(){if(control?.paused)return;publish(false);}});}
 finally{control?.clearTask(task);publish(true);}
}
async function installAssets(root,assetIndex,notify,{control=null,mode='install'}={}){
 if(!assetIndex||!/^[a-z0-9._-]+$/i.test(assetIndex.id)||!/^https:\/\//.test(assetIndex.url))throw Error('Invalid asset index.');
 const phase=mode==='update'?'updating':'downloading',label='Verifying game sounds & textures';
 const indexFile=path.join(root,'assets','indexes',assetIndex.id+'.json');
 await downloadVerified(assetIndex.url,indexFile,assetIndex.sha1,'sha1',{control});
 const index=JSON.parse(await fs.readFile(indexFile,'utf8'));
 const entries=Object.values(index.objects),unique=[...new Map(entries.map(row=>[row.hash,row])).values()];
 if(unique.length>100000||unique.some(row=>!/^[a-f0-9]{40}$/.test(row.hash)))throw Error('Invalid asset catalogue.');
 let next=0,finished=0,last=0,failure,moved=false;
 notify({phase,message:label,progress:countProgress(label,0)});
 async function worker(){
  while(next<unique.length&&!failure){
   try{await control?.gate();}catch(error){failure=error;return;}
   const row=unique[next++];
   try{
    const wrote=await downloadVerified('https://resources.download.minecraft.net/'+row.hash.slice(0,2)+'/'+row.hash,path.join(root,'assets','objects',row.hash.slice(0,2),row.hash),row.hash,'sha1',{control});
    moved=moved||wrote;
   }catch(error){failure=error;}
   finished++;
   if(Date.now()-last>150){last=Date.now();notify({phase,message:label,progress:countProgress(label,finished/unique.length*100)});}
  }
 }
 await Promise.all(Array.from({length:6},worker));
 if(failure)throw failure;
 // Nothing had to be fetched: this was verification, not a download.
 if(!moved)notify({phase:mode==='update'?'updating':'verifying',message:label,progress:countProgress(label,100)});
}
// Play joins one address, and it is the launcher's own constant, not a setting: the
// player no longer has a server field to read (doc/launcher-states.md, "The one server
// the launcher targets"). `server` is a parameter only so a test can pass the same
// value explicitly; the default is config.cjs serverAddress(), which is also what the
// wake flow targets, so the client is sent to the host that was just started.
function launchOptions({root,version,javaPath,session,settings={},server=serverAddress(),launchEnv=null}){
 const extraMCArgs=[];
 if(server)extraMCArgs.push('--quickPlayMultiplayer',server);
 return {gamePath:root,resourcePath:root,version,javaPath,gameProfile:session.profile,accessToken:session.accessToken,userType:'msa',launcherName:'Easter Company',launcherBrand:'1.0.0',maxMemory:settings.memoryMB,minMemory:1024,extraMCArgs,features:{easter_identity:{clientid:session.clientId||require('./auth.cjs').DEFAULT_CLIENT_ID,auth_xuid:session.xuid||'0'}},extraExecOption:execOptions(launchEnv)};
}
// spawn replaces the whole environment when one is given, so the launched client gets
// the launcher's environment with the display-GPU pin on top of it. With nothing to
// pin, the options are exactly what they were before.
function execOptions(launchEnv){
 const base={shell:false,windowsHide:true};
 if(!launchEnv||typeof launchEnv!=='object')return base;
 const extra=Object.fromEntries(Object.entries(launchEnv).filter(([,value])=>typeof value==='string'&&value));
 return Object.keys(extra).length?{...base,env:{...process.env,...extra}}:base;
}
async function writeMarker(root){
 const marker=path.join(root,MARKER);
 try{await fs.writeFile(marker,new Date().toISOString()+'\n',{mode:0o600});}catch{}
}
// ---- installed marker -------------------------------------------------------
async function publishedManifest(origin=clientOrigin()){return json(originBase(origin)+'data/client.json');}
async function readInstalled(root){
 try{
  const record=JSON.parse(await fs.readFile(path.join(root,'installed.json'),'utf8'));
  if(!record||typeof record.version!=='string'||!record.version)return null;
  return record;
 }catch{return null;}
}
function recordedFile(entry){
 const value=String(entry||'');
 if(!value)return null;
 return value.includes('/')?value:path.join('mods',value);
}
async function isInstalled(root){
 const record=await readInstalled(root);
 if(!record)return false;
 const base=path.resolve(root);
 try{await fs.stat(path.join(base,'versions',record.version,record.version+'.json'));}catch{return false;}
 for(const entry of Array.isArray(record.files)?record.files:[]){
  const relative=recordedFile(entry);
  if(!relative)return false;
  const target=path.resolve(base,relative);
  if(target!==base&&!target.startsWith(base+path.sep))return false;
  try{await fs.stat(target);}catch{return false;}
 }
 return true;
}
async function clientStatus(root){
 try{
  const record=await readInstalled(root);
  const installed=Boolean(record)&&await isInstalled(root);
  return {installed,version:installed?(record.mod||record.version):null,updatedAt:installed?(record.updatedAt||null):null,record:installed?record:null};
 }catch{return {installed:false,version:null,updatedAt:null,record:null};}
}
// ---- what differs -----------------------------------------------------------
function sameDependencies(published,installed){
 const key=list=>(Array.isArray(list)?list:[]).map(item=>String(item?.id)+'@'+String(item?.version)).sort();
 const left=key(published),right=key(installed);
 return left.length===right.length&&left.every((value,index)=>value===right[index]);
}
// What differs between the published manifest and what is on disk. A record that
// matches in every published respect is the quiet case: nothing to report at all.
function installDiff(published,record,{includeGraphics=false,fabric=FABRIC,origin=clientOrigin()}={}){
 if(!record)return {changed:true,changes:['missing']};
 const changes=[],chunks=chunkList(published,origin);
 if(chunks){
  const recorded=record.chunks||{};
  for(const chunk of selectedChunks(chunks,includeGraphics))if(recorded[chunk.id]?.version!==chunk.version||chunk.files.some(file=>!recorded[chunk.id]?.files?.includes(file.path)))changes.push('chunk:'+chunk.id);
  const pinned=gamePins(chunks,published?.fabric===undefined?fabric:published.fabric);
  if(record.game?.minecraft!==published?.minecraft||record.game?.fabric!==pinned.fabric)changes.push('game');
  return {changed:changes.length>0,changes};
 }
 if(String(published?.minecraft||'')!==String(record.minecraft||''))changes.push('minecraft');
 if(fabric!==record.fabric)changes.push('fabric');
 if(String(published?.mod?.sha256||'')!==String(record.modSha256||''))changes.push('mod');
 if(!sameDependencies(published?.dependencies,record.dependencies))changes.push('dependencies');
 const publishedGraphics=graphicsEntry(published?.graphics,origin);
 if(includeGraphics&&publishedGraphics&&publishedGraphics.hash!==record.graphics)changes.push('graphics');
 return {changed:changes.length>0,changes};
}
// The base chunk carries the pins for the component the launcher installs; the
// manifest's flat field mirrors them for launchers that predate chunks. If the two
// disagree the manifest is inconsistent, and guessing which one is current would
// install the wrong loader, so it is refused instead.
function gamePins(chunks,manifestFabric){
 const base=(chunks||[]).find(chunk=>chunk.id==='base');
 const declared=typeof manifestFabric==='string'?manifestFabric.trim():'';
 const pinned=typeof base?.fabric==='string'?base.fabric.trim():'';
 if(declared&&pinned&&declared!==pinned)throw Error('The client release manifest disagrees about the Fabric pin ('+pinned+' in the base chunk, '+declared+' in the manifest).');
 return {fabric:pinned||declared||FABRIC,java:Number.isInteger(base?.java)?base.java:null};
}
// ---- the game itself --------------------------------------------------------
// Java, the frozen Minecraft version, its assets and the Fabric libraries. Recorded
// as one verified unit so a later run that finds it unchanged touches none of it.
async function installGame({root,settings={},client,chunks,notify,control=null,mode='install'}){
 const updating=mode==='update',step=kind=>updating?'updating':kind;
 const pins=gamePins(chunks,client.fabric);
 const list=await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
 const meta=list.versions.find(v=>v.id===client.minecraft);
 if(!meta)throw Error('Minecraft '+client.minecraft+' is not in Mojang’s release catalogue.');
 const vanilla=await json(meta.url);
 const major=pins.java||vanilla.javaVersion?.majorVersion||25;
 let javaPath=settings.javaPath;
 if(javaPath){
  if(await javaMajor(javaPath)!==major)throw Error('This client requires Java '+major+'. Choose the matching Java executable or use the automatic runtime.');
 }else{
  const runtimeRoot=path.join(root,'runtime',vanilla.javaVersion?.component||'java-runtime-epsilon');
  javaPath=path.join(runtimeRoot,...(process.platform==='darwin'?['jre.bundle','Contents','Home','bin','java']:['bin',process.platform==='win32'?'java.exe':'java']));
  let usable=false;try{usable=await javaMajor(javaPath)===major;}catch{}
  if(!usable){
   notify({phase:step('downloading'),message:'Preparing Java '+major,progress:countProgress('Preparing Java '+major,null)});
   const target=vanilla.javaVersion?.component||'java-runtime-epsilon';
   const runtimes=await json(installer.DEFAULT_RUNTIME_ALL_URL);
   const platformKey=process.platform==='win32'?'windows-x64':process.platform==='darwin'?'mac-os':'linux';
   const entry=runtimes[platformKey]?.[target]?.[0];
   if(!entry)throw Error('Mojang does not provide this Java runtime for your platform. Choose a Java '+major+' executable in Client settings.');
   const runtime={...await json(entry.manifest.url),target,version:entry.version};
   for(const [file,item] of Object.entries(runtime.files)){
    const destination=path.resolve(runtimeRoot,file);
    if(!destination.startsWith(runtimeRoot+path.sep))throw Error('Invalid Java runtime path.');
    if(item.type==='link'&&!path.resolve(path.dirname(destination),item.target).startsWith(runtimeRoot+path.sep))throw Error('Invalid Java runtime link.');
   }
   await tracked(installer.installJavaRuntimeTask({destination:runtimeRoot,manifest:runtime,dispatcher}),'Installing Java '+major,notify,{control,phase:step('downloading')});
   for(const [file,item] of Object.entries(runtime.files)){
    const destination=path.join(runtimeRoot,file);
    if(item.type==='file'&&item.executable&&process.platform!=='win32')await fs.chmod(destination,0o755);
    if(item.type==='link'){try{await fs.lstat(destination);}catch(error){if(error.code!=='ENOENT')throw error;await fs.symlink(item.target,destination);}}
   }
   if(await javaMajor(javaPath)!==major)throw Error('The downloaded Java runtime does not match this Minecraft version.');
  }
 }
 await control?.gate();
 await tracked(installer.installVersionTask(meta,root,{dispatcher}),'Verifying Minecraft',notify,{control,phase:step('downloading')});
 await installAssets(root,vanilla.assetIndex,notify,{control,mode});
 await control?.gate();
 notify({phase:step('installing'),message:'Preparing Fabric '+pins.fabric,progress:countProgress('Preparing Fabric '+pins.fabric,null)});
 const version=await installer.installFabric({minecraftVersion:client.minecraft,version:pins.fabric,minecraft:root});
 const resolved=await Version.parse(root,version);
 await tracked(installer.installLibrariesTask(resolved,{dispatcher}),'Verifying Fabric libraries',notify,{control,phase:step('downloading')});
 return {version,javaPath,fabric:pins.fabric};
}
// ---- the client's own quality settings --------------------------------------
// Owen's goal is that the client works out the highest quality settings it can
// push for the hardware, so the settings are derived from the video memory the
// machine reported and written into the app-owned client tree only: options.txt
// and config/iris.properties. A tree without the launcher's own marker file is
// refused, which is the same rule that keeps an existing ~/.minecraft, another
// launcher and the server untouched.
function deriveQuality(hardware){return qualitySettings({vramMB:hardware?.vramMB??null,tier:hardware?.tier||'unknown'});}
// What was actually written, never what was intended: a failed write leaves the
// tuned record untouched and says so. `shaders` may be forced off when the shader
// payload is not published, because naming a shader pack that was never installed
// would be a claim the client cannot honour.
async function applyQuality(root,hardware,notify,{shaders}={}){
 const quality={...deriveQuality(hardware),...(typeof shaders==='boolean'?{shaders}:{})};
 if(typeof shaders==='boolean'&&!shaders)quality.shaderPack=null;
 if(typeof shaders==='boolean'&&shaders)quality.shaderPack=quality.shaderPack||SHADER_PACK_NAME;
 try{
  await applyQualitySettings(root,quality);
  await recordQuality(root,quality);
 }catch(error){
  await disableShaders(root);
  throw Error('The client’s quality settings could not be written into the client folder.',{cause:error});
 }
 return {quality,tuned:quality?{renderDistance:quality.renderDistance,shadowDistance:quality.shadowDistance,shaders:Boolean(quality.shaders)}:null,message:null};
}
// The display defaults are not a graphics choice: a player's first launch is already
// fullscreen at the GUI scale their own display asks for whether enhanced graphics are
// on or off, so every install path seeds them and the optional graphics chunk is never
// required for them. `guiScale` is that display's answer, resolved by the caller in the
// main process and passed straight through; the seed itself decides whether it writes
// anything. A write that fails never fails an install that has already succeeded,
// exactly like the quality step; nothing is added to the status contract for it.
async function seedDisplayDefaults(root,notify,guiScale=null){
 try{return await applyDisplayDefaults(root,{guiScale});}
 catch(error){
  if(notify)notify({message:'The client’s display settings could not be written into the client folder.'});
  return null;
 }
}
// The graphics chunk is the optional half of the same pipeline: it is fetched only
// while the toggle is on, its files are checksum verified like every other file,
// and switching the toggle off fetches nothing and invalidates nothing.
function graphicsSelection(chunks,includeGraphics){
 if(!chunks)return {selected:null,graphics:null,selectedGraphics:null};
 const selected=selectedChunks(chunks,includeGraphics);
 return {selected,graphics:chunks.find(chunk=>chunk.id==='graphics')||null,selectedGraphics:selected.find(chunk=>chunk.id==='graphics')||null};
}
function graphicsMessageFor({includeGraphics,graphicsChunk,pending,record,only=null}){
 // A graphics-only run is about the optional chunk. When there is no such chunk to
 // install, saying so would be off-topic: the toggle's own handler reports it.
 if(only&&only.size&&!only.has('graphics'))return null;
 if(!includeGraphics)return null;
 if(pending)return 'Enhanced graphics are not published yet, so the client was installed without them.';
 const installed=Boolean(graphicsChunk)&&(pending===undefined?Boolean(record?.chunks?.graphics):true);
 return installed?graphicsChunk.name+' installed.':null;
}
// ---- installing a chunk's files --------------------------------------------
async function installChunkFiles(chunk,{root,notify,control,step}){
 const label='Downloading '+chunk.name;
 const total=chunk.files.reduce((sum,entry)=>sum+entry.size,0);
 const meter=new Transfer();
 meter.begin(label,total);
 let moved=false,last=Date.now();
 const publish=()=>{last=Date.now();notify({phase:step('downloading'),message:label,progress:meter.snapshot()});};
 publish();
 for(const entry of chunk.files){
  await control?.gate();
  const target=chunkFileTarget(root,entry.path);
  const wrote=await downloadVerified(entry.url,target,entry.hash,entry.algorithm,{control,onBytes:bytes=>{moved=true;meter.add(bytes);if(Date.now()-last>150)publish();}});
  // A file that already matches its checksum still counts as part of the chunk.
  if(!wrote)meter.add(entry.size);
  if(Date.now()-last>150)publish();
  await fs.rm(partPath(target),{force:true});
  await fs.rm(partState(target),{force:true});
 }
 notify({phase:step('downloading'),message:label,progress:meter.snapshot()});
 if(!moved)notify({phase:step('verifying'),message:'Verifying '+chunk.name,progress:countProgress('Verifying '+chunk.name,100)});
}
// ---- the pipeline -----------------------------------------------------------
// `only` restricts the run to named chunks. The graphics toggle uses it, so
// switching enhanced graphics on or off never re-fetches or re-verifies the frozen
// game even when the base chunk is not installed from this run.
async function installChunked({root,client,chunks,record,settings,notify,control,includeGraphics,mode,origin,only=null,hardware=null,guiScale=null}){
 const updating=mode==='update',step=kind=>updating?'updating':kind;
 const scope=only&&only.size?new Set(only):null;
 const selection=graphicsSelection(chunks,includeGraphics);
 const pending=selection.selected?pendingChunks(selection.selected,record):[];
 const baseMissing=pending.some(chunk=>chunk.id==='base');
 const gameIncomplete=pending.length>0&&selection.selected?.some(chunk=>chunk.id==='base')&&!(record?.chunks?.base);
 const pins=gamePins(chunks,client.fabric);
 const gameCurrent=Boolean(record&&record.game&&record.game.minecraft===client.minecraft&&record.game.fabric===pins.fabric&&record.java)&&await exists(record.java)&&await exists(path.join(root,'versions',record.version,record.version+'.json'));
 const graphicsChunk=selection.graphics;
 const graphicsPending=!graphicsChunk;
 const graphicsMessage=graphicsMessageFor({includeGraphics,graphicsChunk,pending:graphicsPending,record,only:scope});
 // Nothing published changed and the game is whole: report the client as ready
 // without downloading or re-verifying anything. This is also the honest answer
 // when the manifest has no graphics chunk and the toggle is on.
 if(!pending.length&&gameCurrent){
  const quality=includeGraphics?await applyQuality(root,hardware,notify,{shaders:Boolean(graphicsChunk)&&deriveQuality(hardware).shaders}):{quality:null,tuned:null,message:null};
  await seedDisplayDefaults(root,notify,guiScale);
  if(!includeGraphics)await disableShaders(root);
  await configureVisuals(root,{record,includeGraphics});
  const installedGraphics=record.chunks?.graphics||null;
  return {version:record.version,javaPath:record.java,updatedAt:record.updatedAt,includeGraphics,graphics:installedGraphics?.version||null,message:updating?'Client is up to date.':'Client ready.',unchanged:true,graphicsMessage,graphicsApplied:Boolean(installedGraphics),quality:quality.tuned,qualityMessage:quality.message,qualitySettings:quality.quality};
 }
 const installing=pending.filter(chunk=>!scope||scope.has(chunk.id));
 const installingBase=installing.some(chunk=>chunk.id==='base');
 if(!installing.length){
  const quality=includeGraphics?await applyQuality(root,hardware,notify,{shaders:Boolean(record?.chunks?.graphics)&&Boolean(graphicsChunk)&&deriveQuality(hardware).shaders}):{quality:null,tuned:null,message:null};
  if(!includeGraphics)await disableShaders(root);
  await configureVisuals(root,{record,includeGraphics});
  return {version:record?.version??null,javaPath:record?.java??null,updatedAt:record?.updatedAt??null,includeGraphics,graphics:record?.chunks?.graphics?.version||null,message:'Graphics settings applied.',unchanged:true,graphicsMessage:null,skipped:pending.map(chunk=>chunk.id),quality:quality.tuned,qualitySettings:quality.quality};
 }
 let version=record?.version,javaPath=record?.java,fabric=record?.fabric;
 // The game component is only touched when it is not already whole. A chunk-scoped
 // run (the graphics toggle) still installs it when the client has never had one,
 // because there would otherwise be nothing to apply settings to.
 if(!gameCurrent&&(installingBase||gameIncomplete||baseMissing)){
  const game=await installGame({root,settings,client,chunks,notify,control,mode});
  version=game.version;javaPath=game.javaPath;fabric=game.fabric;
 }
 const records={...(record?.chunks||{})};
 let graphicsMessageOut=graphicsMessage,graphicsInstalled=false;
 for(const chunk of installing){
  await control?.gate();
  await installChunkFiles(chunk,{root,notify,control,step});
  records[chunk.id]={id:chunk.id,version:chunk.version,immutable:chunk.immutable,files:chunk.files.map(entry=>entry.path),verified:true,updatedAt:new Date().toISOString()};
  if(chunk.id==='graphics'){graphicsMessageOut=chunk.name+' installed.';graphicsInstalled=true;}
 }
 const files=[...new Set(Object.values(records).flatMap(chunk=>chunk.files||[]))];
 const updatedAt=new Date().toISOString();
 const quality=(includeGraphics||(!record?.quality&&hardware?.tunable))?await applyQuality(root,hardware,notify,{shaders:includeGraphics&&Boolean(graphicsChunk)&&deriveQuality(hardware).shaders}):{quality:null,tuned:null,message:null};
 await seedDisplayDefaults(root,notify,guiScale);
 if(!includeGraphics)await disableShaders(root);
 await configureVisuals(root,{record:{chunks:records},includeGraphics});
 await atomicJSON(path.join(root,'installed.json'),{
  version,minecraft:client.minecraft,fabric,mod:client.mod?.version,modSha256:client.mod?.sha256,
  dependencies:(client.dependencies||[]).map(entry=>({id:entry.id,version:entry.version})),
  files,chunks:records,game:{minecraft:client.minecraft,fabric,verified:true},graphics:records.graphics?.version||null,includeGraphics,java:javaPath,updatedAt,
  ...(quality.quality?{quality:{...quality.tuned,graphicsMode:quality.quality.graphicsMode,shaderPack:quality.quality.shaders?quality.quality.shaderPack:null,updatedAt}}:{})});
 // An install only replaces settings when the quality step knows the launcher owns
 // the tree; a graphics-only run never touches the marker's own chunk records.
 const message=[(updating?'Client updated.':'Client ready.'),graphicsMessageOut,quality.message].filter(Boolean).join(' ');
 notify({phase:'ready',message,progress:countProgress('Client ready',100)});
 return {version,javaPath,updatedAt,includeGraphics,graphics:records.graphics?.version||null,message,graphicsMessage:graphicsMessageOut,graphicsApplied:graphicsInstalled,quality:quality.tuned,qualityMessage:quality.message,qualitySettings:quality.quality};
}
// The flat manifest: no chunk list, so every pinned release is resolved from its
// publisher on each run, exactly as the launcher has always done.
async function installFlat({root,client,settings,notify,control,includeGraphics,mode,origin,hardware=null,guiScale=null}){
 const updating=mode==='update',step=kind=>updating?'updating':kind;
 const game=await installGame({root,settings,client,chunks:null,notify,control,mode});
 const mods=[{name:'Easter Co. client',url:modFile(client,origin),hash:client.mod.sha256,algorithm:'sha256',filename:'easter-navy.jar'}];
 for(const dependency of client.dependencies)mods.push(await resolveMod(dependency,client.minecraft));
 // Resolve every pinned version first. Only verified downloads replace managed files.
 const meter=new Transfer();
 let moved=false;
 for(let index=0;index<mods.length;index++){
  await control?.gate();
  const mod=mods[index],label='Downloading '+mod.name;
  meter.begin(label,null);
  notify({phase:step('downloading'),message:'Verifying '+mod.name,progress:meter.snapshot()});
  const wrote=await downloadVerified(mod.url,path.join(root,'mods',mod.filename),mod.hash,mod.algorithm,{control,meter,onProgress:snapshot=>{if((snapshot.bytesDone||0)>0)moved=true;notify({phase:step('downloading'),message:label,progress:snapshot});}});
  moved=moved||wrote;
  await fs.rm(partPath(path.join(root,'mods',mod.filename)),{force:true});
  await fs.rm(partState(path.join(root,'mods',mod.filename)),{force:true});
 }
 if(!moved)notify({phase:step('verifying'),message:'Verifying the client files',progress:countProgress('Verifying the client files',100)});
 let graphics=null,graphicsMessage=null,graphicsFile=null;
 const plan=graphicsPlan(client,includeGraphics,origin);
 if(plan.state!=='skipped'){
  if(plan.state==='not-published'){graphics='not-published';graphicsMessage=plan.message;}
  else{
   const entry=plan.entry;
   await control?.gate();
   const label='Downloading '+entry.name;
   meter.begin(label,null);
   notify({phase:step('downloading'),message:label,progress:meter.snapshot()});
   await downloadVerified(entry.url,path.join(root,'shaderpacks',entry.filename),entry.hash,'sha256',{control,meter,onProgress:snapshot=>notify({phase:step('downloading'),message:label,progress:snapshot})});
   graphics=entry.hash;graphicsFile='shaderpacks/'+entry.filename;
   graphicsMessage=plan.message;
  }
 }
 const updatedAt=new Date().toISOString();
 // The quality settings follow the same rule on a manifest without chunks: they
 // are written when the toggle is on, and the payload's own absence is reported
 // rather than papered over by turning shaders on with no shader pack to load.
 const quality=includeGraphics?await applyQuality(root,hardware,notify,{shaders:Boolean(graphicsFile)&&deriveQuality(hardware).shaders}):{quality:null,tuned:null,message:null};
 await seedDisplayDefaults(root,notify,guiScale);
 if(!includeGraphics)await disableShaders(root);
 await configureVisuals(root,{record:null,includeGraphics});
 await atomicJSON(path.join(root,'installed.json'),{version:game.version,minecraft:client.minecraft,fabric:game.fabric,mod:client.mod.version,modSha256:client.mod.sha256,dependencies:client.dependencies.map(d=>({id:d.id,version:d.version})),files:[...mods.map(m=>'mods/'+m.filename),...(graphicsFile?[graphicsFile]:[])],game:{minecraft:client.minecraft,fabric:game.fabric,verified:true},graphics:graphics==='not-published'?null:graphics,includeGraphics,java:game.javaPath,updatedAt,...(quality.quality?{quality:{...quality.tuned,graphicsMode:quality.quality.graphicsMode,shaderPack:quality.quality.shaders?quality.quality.shaderPack:null,updatedAt}}:{})});
 const message=[(updating?'Client updated.':'Client ready.'),graphicsMessage,quality.message].filter(Boolean).join(' ');
 notify({phase:'ready',message,progress:countProgress('Client ready',100)});
 return {version:game.version,javaPath:game.javaPath,updatedAt,includeGraphics,graphics,message,graphicsMessage,quality:quality.tuned,qualityMessage:quality.message,qualitySettings:quality.quality};
}
async function installClient({root,settings={},notify=()=>{},control=null,includeGraphics=false,mode='install',published=null,origin=clientOrigin(),only=null,hardware=null,guiScale=null,fetchManifest=publishedManifest}={}){
 origin=originBase(origin);
 const problem=locationProblem(root,{});
 if(problem)throw Error(problem);
 const updating=mode==='update';
 const client=published||await fetchManifest(origin);
 if(!client||typeof client!=='object'||typeof client.minecraft!=='string'||!/^\d[\w.+-]*$/.test(client.minecraft))throw Error('The client release manifest is invalid.');
 const chunks=chunkList(client,origin);
 // A chunked manifest carries its own pinned files; the flat fields only have to
 // be present for a manifest without chunks.
 if(!chunks&&(!Array.isArray(client.dependencies)||client.dependencies.length>30||!client.mod))throw Error('The client release manifest is invalid.');
 if(chunks&&(!Array.isArray(client.dependencies)||client.dependencies.length>30))throw Error('The client release manifest is invalid.');
 // Claim the tree before writing anything into it, so a root the launcher owns can
 // always be recognised again even if the install is interrupted.
 await fs.mkdir(root,{recursive:true});
 await writeMarker(root);
 const record=await readInstalled(root);
 const options={root,client,chunks,record,settings,notify,control,includeGraphics,mode,origin,updating,only,hardware,guiScale};
 return chunks?installChunked(options):installFlat(options);
}
// The graphics toggle's own entry point: the optional chunk is fetched and applied
// through the checksum-verified pipeline, and nothing else in the client is
// downloaded, re-hashed or invalidated by switching it on or off. The installed
// client is required, because there is no settings file to tune without it.
async function applyGraphics({root,settings={},notify=()=>{},control=null,includeGraphics=false,enabled=includeGraphics,hardware=null,guiScale=null,origin=clientOrigin(),fetchManifest=publishedManifest,published=null}={}){
 const record=await readInstalled(root);
 if(!record)throw Error('Download the game before changing its graphics settings.');
 // Off is a local settings operation and must work even without a network.
 if(!enabled){
  await disableShaders(root);
  await configureVisuals(root,{record,includeGraphics:false});
  const updated={...record,includeGraphics:false,...(record.quality?{quality:{...record.quality,shaders:false,shaderPack:null}}:{})};
  await atomicJSON(path.join(root,'installed.json'),updated);
  return {unchanged:true,applied:true,includeGraphics:false,graphicsAvailable:Boolean(record.chunks?.graphics||record.graphics),graphics:record.chunks?.graphics?.version||record.graphics||null,message:'Enhanced graphics are off.',graphicsMessage:null,quality:updated.quality?{renderDistance:updated.quality.renderDistance,shadowDistance:updated.quality.shadowDistance,shaders:false}:null,qualitySettings:updated.quality||null};
 }
 const manifest=published||await fetchManifest(originBase(origin));
 const chunks=chunkList(manifest,clientOrigin(origin));
 const graphicsChunk=(chunks||[]).find(chunk=>chunk.id==='graphics')||null;
 if(!chunks){
  // A manifest that predates chunks has no optional graphics chunk at all, and the
  // flat `graphics` payload is published under the same URL. Either way, nothing is
  // invented and the caller reports what is available.
  const quality=await applyQuality(root,hardware,notify,{shaders:false});
  await configureVisuals(root,{record,includeGraphics:false});
  return {unchanged:true,applied:false,includeGraphics:Boolean(enabled),graphicsAvailable:Boolean(graphicsEntry(manifest?.graphics,origin)),graphics:record.graphics||null,message:quality.message||(enabled?'Enhanced graphics are not published yet, so the toggle is on but no shader pack was fetched.':'Enhanced graphics are off.'),graphicsMessage:enabled&&!graphicsEntry(manifest?.graphics,origin)?'Enhanced graphics are not published yet, so the toggle is on but no shader pack was fetched.':null,quality:quality.tuned,qualitySettings:quality.quality};
 }
 // The render settings are still the machine's answer even when the shader payload
 // is missing: the client's own options are tuned, and only shaders are withheld
 // because there is no pack to name.
 if(enabled&&!graphicsChunk){
  const message='Enhanced graphics are not published yet, so the toggle is on but no shader pack was fetched.';
  const quality=await applyQuality(root,hardware,notify,{shaders:false});
  await configureVisuals(root,{record,includeGraphics:false});
  return {unchanged:true,applied:Boolean(quality.tuned),includeGraphics:true,graphicsAvailable:false,graphics:record.chunks?.graphics?.version||null,message:quality.message||message,graphicsMessage:message,quality:quality.tuned,qualitySettings:quality.quality};
 }
 const result=await installClient({root,settings,notify,control,includeGraphics:true,mode:'update',published:manifest,origin,only:new Set(['graphics']),hardware,guiScale,fetchManifest});
 return {...result,applied:!result.unchanged||Boolean(result.quality),graphicsAvailable:true};
}
// Backwards-compatible entry point used by the launch path.
async function prepare(root,settings,notify){return installClient({root,settings,notify,mode:'install'});}
// The update check runs one manifest comparison against what is installed. When
// every published field already matches, it returns without notifying anything at
// all: no phase change and no progress bar, so the UI never flashes work that is
// not happening.
async function checkForUpdates({root,settings={},notify=()=>{},control=null,includeGraphics=false,fetchManifest=publishedManifest,install=installClient,origin=clientOrigin(),hardware=null,guiScale=null}={}){
 origin=originBase(origin);
 const record=await readInstalled(root);
 if(!record)return {checked:false,changed:true,applied:false,changes:['missing'],result:null};
 const published=await fetchManifest(origin);
 const diff=installDiff(published,record,{includeGraphics,origin});
 if(!diff.changed)return {checked:true,changed:false,applied:false,changes:[],result:null};
 const result=await install({root,settings,notify,control,includeGraphics,mode:'update',published,origin,hardware,guiScale});
 return {checked:true,changed:true,applied:true,changes:diff.changes,result};
}
// The Play gate, computed here in the main process and nowhere else.
function canPlay(install,profile){return Boolean(install?.installed)&&profile!==null&&profile!==undefined;}
module.exports={setFailureLog,downloadFault,execOptions,ORIGIN,FABRIC,MARKER,HASH,originBase,modFile,Transfer,TransferControl,Cancelled,createControl,countProgress,json,atomicJSON,checksum,partPath,partState,downloadVerified,resolveMod,chunkList,selectedChunks,pendingChunks,gamePins,graphicsEntry,graphicsPlan,graphicsSelection,graphicsMessageFor,deriveQuality,applyQuality,seedDisplayDefaults,javaMajor,tracked,installAssets,launchOptions,publishedManifest,readInstalled,isInstalled,clientStatus,sameDependencies,installDiff,installChunkFiles,installGame,installClient,applyGraphics,prepare,checkForUpdates,canPlay,transferStats,resetTransferStats,generateArguments,launch};
