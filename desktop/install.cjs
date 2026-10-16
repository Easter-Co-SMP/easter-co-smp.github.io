'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {Version,generateArguments,launch}=require('@xmcl/core');
const installer=require('@xmcl/installer');
const {Agent,interceptors}=require('undici');
const {locationProblem,MARKER,clientOrigin}=require('./config.cjs');
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
// ---- downloads --------------------------------------------------------------
function originBase(value){return String(value||'').replace(/\/+$/,'')+'/';}
async function json(url,origin){
 const response=await fetch(url,{signal:AbortSignal.timeout(45000),headers:{'User-Agent':'EasterCompanyLauncher/1.0 (easter-co-smp.github.io)'}});
 if(!response.ok)throw Error('Could not download '+new URL(url).hostname+' data (HTTP '+response.status+'). Try again.');
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
   throw Error('Download failed (HTTP '+response.status+'). Your installed files are unchanged.');
  }
  // 416 means the partial file is already at least as long as the source, so there
  // is nothing left to append and the whole file is judged by its checksum below.
  if(response.status!==416){
   if(!response.ok)throw Error('Download failed (HTTP '+response.status+'). Your installed files are unchanged.');
   if(!response.body)throw Error('Download failed (empty response). Your installed files are unchanged.');
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
  const version=String(chunk.version||'');
  if(!HASH.test(version))throw Error('The '+id+' chunk version is not a content digest.');
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
   return {id:String(entry.id||''),name:String(entry.name||''),version:String(entry.version||''),path:relative,url:url.href,hash:digest,algorithm,size};
  });
  return {id,name:String(chunk.name||id),optional,immutable,version,files,fabric:chunk.fabric??null,java:chunk.java??null};
 });
}
function selectedChunks(chunks,includeGraphics){return chunks.filter(chunk=>!chunk.optional||includeGraphics);}
// A chunk whose recorded version still matches is not fetched and not re-verified.
function pendingChunks(chunks,record,includeGraphics){
 const recorded=record?.chunks||{};
 return selectedChunks(chunks,includeGraphics).filter(chunk=>recorded[chunk.id]?.version!==chunk.version);
}
function chunkFileTarget(root,relative){
 const base=path.resolve(root),target=path.resolve(base,relative);
 if(target!==base&&!target.startsWith(base+path.sep))throw Error('Invalid chunk file path.');
 return target;
}
// Enhanced graphics + shaders travel as the optional graphics chunk. Nothing is
// downloaded until the manifest declares it: the payload is Owen's decision, and an
// install without one reports that instead of pretending it installed shaders.
function graphicsEntry(graphics){
 if(!graphics||typeof graphics!=='object')return null;
 const filename=String(graphics.filename||'');
 if(!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(filename))throw Error('The published graphics payload has an invalid filename.');
 const url=new URL(String(graphics.url||''),clientOrigin());
 if(url.origin!==new URL(clientOrigin()).origin||url.username||url.password)throw Error('Unexpected graphics location.');
 if(typeof graphics.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(graphics.sha256))throw Error('The published graphics payload is missing its checksum.');
 return {name:String(graphics.name||'Enhanced graphics'),version:String(graphics.version||''),filename,hash:graphics.sha256,url:url.href};
}
function graphicsPlan(published,includeGraphics){
 if(!includeGraphics)return {state:'skipped',entry:null,message:null};
 const entry=graphicsEntry(published?.graphics);
 if(!entry)return {state:'not-published',entry:null,message:'Enhanced graphics are not published yet, so the client was installed without them.'};
 return {state:'install',entry,message:entry.name+' installed.'};
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
function launchOptions({root,version,javaPath,session,settings}){
 const extraMCArgs=[];
 if(settings.server)extraMCArgs.push('--quickPlayMultiplayer',settings.server);
 return {gamePath:root,resourcePath:root,version,javaPath,gameProfile:session.profile,accessToken:session.accessToken,userType:'msa',launcherName:'Easter Company',launcherBrand:'1.0.0',maxMemory:settings.memoryMB,minMemory:1024,extraMCArgs,features:{easter_identity:{clientid:session.clientId||require('./auth.cjs').DEFAULT_CLIENT_ID,auth_xuid:session.xuid||'0'}},extraExecOption:{shell:false,windowsHide:true}};
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
  for(const chunk of selectedChunks(chunks,includeGraphics))if(recorded[chunk.id]?.version!==chunk.version)changes.push('chunk:'+chunk.id);
  const pinned=gamePins(chunks,fabric);
  if(record.game?.minecraft!==published?.minecraft||record.game?.fabric!==pinned.fabric)changes.push('game');
  return {changed:changes.length>0,changes};
 }
 if(String(published?.minecraft||'')!==String(record.minecraft||''))changes.push('minecraft');
 if(fabric!==record.fabric)changes.push('fabric');
 if(String(published?.mod?.sha256||'')!==String(record.modSha256||''))changes.push('mod');
 if(!sameDependencies(published?.dependencies,record.dependencies))changes.push('dependencies');
 const publishedGraphics=graphicsEntry(published?.graphics);
 if(includeGraphics&&publishedGraphics&&publishedGraphics.hash!==record.graphics)changes.push('graphics');
 return {changed:changes.length>0,changes};
}
function gamePins(chunks,fallback=FABRIC){
 const base=(chunks||[]).find(chunk=>chunk.id==='base');
 return {fabric:base?.fabric||fallback,java:Number.isInteger(base?.java)?base.java:null};
}
// ---- the game itself --------------------------------------------------------
// Java, the frozen Minecraft version, its assets and the Fabric libraries. Recorded
// as one verified unit so a later run that finds it unchanged touches none of it.
async function installGame({root,settings={},client,chunks,notify,control=null,mode='install'}){
 const updating=mode==='update',step=kind=>updating?'updating':kind;
 const pins=gamePins(chunks);
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
async function installChunked({root,client,chunks,record,settings,notify,control,includeGraphics,mode,origin}){
 const updating=mode==='update',step=kind=>updating?'updating':kind;
 const selected=selectedChunks(chunks,includeGraphics);
 const pending=pendingChunks(selected,record,includeGraphics);
 const pins=gamePins(chunks);
 const gameCurrent=Boolean(record&&record.game&&record.game.minecraft===client.minecraft&&record.game.fabric===pins.fabric&&record.java)&&await exists(record.java);
 const graphicsChunk=selected.find(chunk=>chunk.id==='graphics');
 const graphicsMessage=includeGraphics&&!chunks.some(chunk=>chunk.id==='graphics')?'Enhanced graphics are not published yet, so the client was installed without them.':null;
 if(!pending.length&&gameCurrent){
  return {version:record.version,javaPath:record.java,updatedAt:record.updatedAt,includeGraphics,graphics:record.chunks?.graphics?.version||null,message:updating?'Client is up to date.':'Client ready.',unchanged:true,graphicsMessage};
 }
 let version=record?.version,javaPath=record?.java,fabric=record?.fabric;
 if(!gameCurrent){
  const game=await installGame({root,settings,client,chunks,notify,control,mode});
  version=game.version;javaPath=game.javaPath;fabric=game.fabric;
 }
 const records={...(record?.chunks||{})};
 let graphicsMessageOut=graphicsMessage;
 for(const chunk of pending){
  await control?.gate();
  await installChunkFiles(chunk,{root,notify,control,step});
  records[chunk.id]={id:chunk.id,version:chunk.version,immutable:chunk.immutable,files:chunk.files.map(entry=>entry.path),verified:true,updatedAt:new Date().toISOString()};
  if(chunk.id==='graphics')graphicsMessageOut=chunk.name+' installed.';
 }
 const files=[...new Set(Object.values(records).flatMap(chunk=>chunk.files||[]))];
 const updatedAt=new Date().toISOString();
 await atomicJSON(path.join(root,'installed.json'),{
  version,minecraft:client.minecraft,fabric,mod:client.mod?.version,modSha256:client.mod?.sha256,
  dependencies:(client.dependencies||[]).map(entry=>({id:entry.id,version:entry.version})),
  files,chunks:records,game:{minecraft:client.minecraft,fabric,verified:true},graphics:records.graphics?.version||null,includeGraphics,java:javaPath,updatedAt
 });
 const message=(updating?'Client updated.':'Client ready.')+(graphicsMessageOut?' '+graphicsMessageOut:'');
 notify({phase:'ready',message,progress:countProgress('Client ready',100)});
 return {version,javaPath,updatedAt,includeGraphics,graphics:records.graphics?.version||null,message,graphicsMessage:graphicsMessageOut};
}
// The flat manifest: no chunk list, so every pinned release is resolved from its
// publisher on each run, exactly as the launcher has always done.
async function installFlat({root,client,settings,notify,control,includeGraphics,mode,origin}){
 const updating=mode==='update',step=kind=>updating?'updating':kind;
 const game=await installGame({root,settings,client,chunks:null,notify,control,mode});
 const customURL=new URL(client.mod.url,origin);
 if(customURL.origin!==new URL(origin).origin||customURL.pathname!=='/downloads/easter-navy.jar')throw Error('Unexpected custom mod location.');
 const mods=[{name:'Easter Co. client',url:customURL.href,hash:client.mod.sha256,algorithm:'sha256',filename:'easter-navy.jar'}];
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
 const plan=graphicsPlan(client,includeGraphics);
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
 await atomicJSON(path.join(root,'installed.json'),{version:game.version,minecraft:client.minecraft,fabric:game.fabric,mod:client.mod.version,modSha256:client.mod.sha256,dependencies:client.dependencies.map(d=>({id:d.id,version:d.version})),files:[...mods.map(m=>'mods/'+m.filename),...(graphicsFile?[graphicsFile]:[])],game:{minecraft:client.minecraft,fabric:game.fabric,verified:true},graphics:graphics==='not-published'?null:graphics,includeGraphics,java:game.javaPath,updatedAt});
 const message=(updating?'Client updated.':'Client ready.')+(graphicsMessage?' '+graphicsMessage:'');
 notify({phase:'ready',message,progress:countProgress('Client ready',100)});
 return {version:game.version,javaPath:game.javaPath,updatedAt,includeGraphics,graphics,message};
}
async function installClient({root,settings={},notify=()=>{},control=null,includeGraphics=false,mode='install',published=null,origin=clientOrigin()}={}){
 origin=originBase(origin);
 const problem=locationProblem(root,{});
 if(problem)throw Error(problem);
 const updating=mode==='update';
 const client=published||await publishedManifest(origin);
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
 const options={root,client,chunks,record,settings,notify,control,includeGraphics,mode,origin,updating};
 return chunks?installChunked(options):installFlat(options);
}
// Backwards-compatible entry point used by the launch path.
async function prepare(root,settings,notify){return installClient({root,settings,notify,mode:'install'});}
// The update check runs one manifest comparison against what is installed. When
// every published field already matches, it returns without notifying anything at
// all: no phase change and no progress bar, so the UI never flashes work that is
// not happening.
async function checkForUpdates({root,settings={},notify=()=>{},control=null,includeGraphics=false,fetchManifest=publishedManifest,install=installClient,origin=clientOrigin()}={}){
 origin=originBase(origin);
 const record=await readInstalled(root);
 if(!record)return {checked:false,changed:true,applied:false,changes:['missing'],result:null};
 const published=await fetchManifest(origin);
 const diff=installDiff(published,record,{includeGraphics,origin});
 if(!diff.changed)return {checked:true,changed:false,applied:false,changes:[],result:null};
 const result=await install({root,settings,notify,control,includeGraphics,mode:'update',published,origin});
 return {checked:true,changed:true,applied:true,changes:diff.changes,result};
}
// The Play gate, computed here in the main process and nowhere else.
function canPlay(install,profile){return Boolean(install?.installed)&&profile!==null&&profile!==undefined;}
module.exports={ORIGIN,FABRIC,MARKER,HASH,originBase,Transfer,TransferControl,Cancelled,createControl,countProgress,json,atomicJSON,checksum,partPath,partState,downloadVerified,resolveMod,chunkList,selectedChunks,pendingChunks,gamePins,graphicsEntry,graphicsPlan,javaMajor,tracked,installAssets,launchOptions,publishedManifest,readInstalled,isInstalled,clientStatus,sameDependencies,installDiff,installChunkFiles,installGame,installClient,prepare,checkForUpdates,canPlay,transferStats,resetTransferStats,generateArguments,launch};
