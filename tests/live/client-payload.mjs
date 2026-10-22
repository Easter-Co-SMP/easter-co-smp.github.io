// The gate over the real published payload: the client itself, every mod in it, and
// the enhanced graphics toggle, measured against the live origin and the real install
// pipeline instead of a fixture. Every other suite in this repository drives a stub,
// a loopback origin or a prepared tree; only this one answers "can the launcher
// download the client and every intended mod from what is published today".
//
// Run it with no arguments, twice, on a fresh root:
//
//     node tests/live/client-payload.mjs                       # fresh root, downloads
//     node tests/live/client-payload.mjs                       # same root, quiet
//     node tests/live/client-payload.mjs --root /var/tmp/other # another root
//     node tests/live/client-payload.mjs https://staging.example/    # another origin
//
// The origin may also come from EASTER_LIVE_ORIGIN and the root from EASTER_LIVE_ROOT
// (a positional argument wins over the environment, and --root wins over both).
//
// It is deliberately NOT part of `npm test`: it downloads about half a gigabyte from
// the public internet (508,051,649 bytes measured on 2026-10-22), it needs about 1 GB
// free for the tree, and it takes minutes. `npm test` must stay runnable on a runner with
// no network and in a couple of seconds.
//
// What this gate is careful about, because each one has bitten somebody:
// - It never writes into a folder it did not create. An empty or missing root is made;
//   a folder that already holds files is only used when it carries the launcher's own
//   `.easter-client` marker, which is the same rule the launcher applies to a player's
//   chosen folder (desktop/config.cjs). Anything else is refused rather than adopted.
// - It passes the manifest it verified into the install, so the gate checks the exact
//   bytes it read rather than whatever the origin serves a second later.
// - Its own file checks hash with a helper in this file. desktop/install.cjs counts
//   every hash read it performs in transferStats(), and that counter is what "the quiet
//   pass read no hashes" is measured with, so the gate must not inflate it.
// - The graphics-toggle checks compare against the chunk the origin actually delivered
//   (its shaderpack file name, its own byte total, its own hashes), never against a
//   constant that would pass on any pack.
// - The recorded 2026-10-22 numbers live in RECORDED and are reported, not smoothed
//   over: a difference is printed as a `drift` line and reported, never written back
//   into the expectation.
//
// Exit code: 0 when every check passes, 1 when any check fails or a phase throws.
'use strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';

const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'..','..');
const require=createRequire(import.meta.url);
const install=require(path.join(repo,'desktop','install.cjs'));
const hardware=require(path.join(repo,'desktop','hardware.cjs'));
const visuals=require(path.join(repo,'desktop','visuals.cjs'));
const {locationProblem}=require(path.join(repo,'desktop','config.cjs'));
const run=promisify(execFile);

const DEFAULT_ORIGIN='https://easter-co-smp.github.io/';
const DEFAULT_ROOT='/var/tmp/easter-live-payload';
// The server's frozen pins (doc/launcher-states.md, "Content chunks"). These are
// expectations, not values read back from the thing being checked: a manifest that
// said 26.3 would install happily and prove nothing.
const PINNED={minecraft:'26.2',fabric:'0.19.5',java:25};
// What the launcher installs for a capable 8 GB card, and the profile this gate passes
// to the install and to the toggle so the tuned settings are the same on every machine.
const PROFILE={vramMB:8188,tier:'capable'};
// The measurements recorded on 2026-10-22 on this machine (doc/releasing.md, "The live
// client payload gate"). They are reported as pins: a drift line says the published
// payload moved, which is a finding to read, not something to edit away.
const RECORDED={
 graphicsBytes:7631839,
 assetObjects:5057,
 modJars:15,
 naiveMissing:5,
 fabricApiNested:45
};
// The chunk shape the exporter publishes. `files` is the count each chunk declares.
const CHUNK_SHAPE={
 base:{files:6,optional:false,immutable:true},
 graphics:{files:4,optional:true},
 visuals:{files:9,optional:false,immutable:true}
};
const KNOT_MAIN_CLASS='net.fabricmc.loader.impl.launch.knot.KnotClient';
// Fabric's own pseudo-mods. A mod requires one of these of the loader, not of another
// mod jar, so they are never resolved against the set of installed jars: `minecraft`
// and Java are the pins this gate checks in the game phase.
const PLATFORM_MODS=new Set(['minecraft','java','fabricloader','fabric','forge','neoforge']);
const USAGE=[
 'The live client payload gate: the real published client, every mod in it, and the',
 'enhanced graphics toggle. Downloads about half a gigabyte; not part of `npm test`.',
 '',
 '  node tests/live/client-payload.mjs [origin] [--root <folder>]',
 '',
 '  origin           defaults to '+DEFAULT_ORIGIN+' (env EASTER_LIVE_ORIGIN)',
 '  --root <folder>  defaults to '+DEFAULT_ROOT+' (env EASTER_LIVE_ROOT)',
 '  --help           this text',
 '  --self-check     prove every refusal ends FAIL with a non-zero exit (no network)',
 '',
 'Run it twice on the same root: the first run downloads and verifies everything, the',
 'second proves the same tree is quiet (0 bytes, 0 hash reads, options.txt untouched).'
].join('\n');

// ---- reporting ---------------------------------------------------------------
const phases=[];
let current=null;
let drift=0;
const facts={};
function begin(title,note=''){
 current={title,note,checks:[],failures:0,summary:''};
 phases.push(current);
 console.log('\n'+title.toUpperCase()+(note?'  — '+note:''));
 return current;
}
function ok(name,detail=''){
 current.checks.push({status:'ok',name,detail});
 console.log('  ok    '+name+(detail?'  ['+detail+']':''));
}
function fail(name,detail=''){
 current.checks.push({status:'fail',name,detail});
 current.failures++;
 console.log('  FAIL  '+name+(detail?'  ['+detail+']':''));
}
function check(condition,name,detail=''){
 if(condition)ok(name,detail);else fail(name,detail);
 return Boolean(condition);
}
function skip(name,detail=''){
 current.checks.push({status:'skip',name,detail});
 console.log('  skip  '+name+(detail?'  ['+detail+']':''));
}
// A recorded number from the 2026-10-22 measurement, compared with what this run
// finds. A difference is printed loudly and counted, and never fails the gate on its
// own: the payload moving is a fact to report, not a broken launcher.
function pin(name,recorded,measured){
 const same=recorded===measured;
 current.checks.push({status:same?'ok':'drift',name,detail:same?String(measured):'recorded '+recorded+', measured '+measured});
 if(same){console.log('  pin   '+name+': '+measured);}
 else{drift++;console.log('  DRIFT '+name+': the 2026-10-22 record says '+recorded+', this run measured '+measured+' — report it, do not edit the pin to match');}
 return same;
}
function info(text){console.log('  ·     '+text);}
function summarise(text){if(current)current.summary=text;}
// What this run is about to do, before it does it: the origin, the folder, which of the
// two proofs this invocation is for, and the graphics profile the settings come from.
function printHeader({origin,clientRoot,state}){
 const mode={
  fresh:'fresh root: everything must download and the optional chunk must be absent',
  repeat:'finished tree from an earlier run: the quiet path is what this run proves',
  resume:'a tree an earlier run left unfinished: the files are verified, the counts only reported'
 }[state.mode];
 console.log('Easter Co. client payload gate');
 console.log('  origin  '+origin);
 console.log('  root    '+clientRoot+(state.created?'  (created by this run)':''));
 console.log('  mode    '+mode);
 console.log('  profile '+JSON.stringify(PROFILE)+', which the ladder turns into render distance '+hardware.qualitySettings(PROFILE).renderDistance);
 console.log('  This gate downloads about half a gigabyte from the public origin (measured 508,051,649 bytes) and needs about 1 GB free. Do not run it beside an Electron journey.');
}

// ---- small helpers -----------------------------------------------------------
const commas=value=>String(value).replace(/\B(?=(\d{3})+(?!\d))/g,',');
function bsize(value){
 if(!Number.isFinite(value))return 'unknown';
 if(value>=1024*1024*1024)return (value/(1024*1024*1024)).toFixed(2)+' GB';
 if(value>=1024*1024)return (value/(1024*1024)).toFixed(1)+' MB';
 if(value>=1024)return (value/1024).toFixed(1)+' kB';
 return value+' bytes';
}
const exact=value=>commas(value)+' bytes';
function duration(ms){
 if(!Number.isFinite(ms))return 'unknown';
 if(ms<1000)return Math.round(ms)+' ms';
 const seconds=ms/1000;
 if(seconds<60)return seconds.toFixed(1)+' s';
 const minutes=Math.floor(seconds/60);
 return minutes+'m '+Math.round(seconds-minutes*60)+'s';
}
function clock(date=new Date()){
 return [date.getHours(),date.getMinutes(),date.getSeconds()].map(value=>String(value).padStart(2,'0')).join(':');
}
async function exists(file){try{await fs.stat(file);return true;}catch{return false;}}
// This gate's own digest, so desktop/install.cjs's hashReads counter keeps meaning
// only "hashes the launcher itself read".
function hashFile(file,algorithm){
 return new Promise((resolve,reject)=>{
  const hash=crypto.createHash(algorithm);
  const stream=fsSync.createReadStream(file);
  stream.on('data',chunk=>hash.update(chunk));
  stream.on('error',reject);
  stream.on('end',()=>resolve(hash.digest('hex')));
 });
}
const properties=text=>hardware.parseProperties(text);
// One key of a properties file, replaced in place or appended when it is missing, so the
// simulated player edit is exactly the change a player makes to options.txt.
function setKey(text,key,value){
 const pattern=new RegExp('^'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+':.*$','m');
 if(pattern.test(text))return text.replace(pattern,key+':'+value);
 return (text.endsWith('\n')?text:text+'\n')+key+':'+value+'\n';
}
const declaredBytes=files=>files.reduce((sum,file)=>sum+file.size,0);

// One line per install phase, and only when the phase or its sentence changes: the
// progress patches arrive many times a second and would bury everything else.
function notifier(){
 let last='';
 return patch=>{
  if(!patch)return;
  const key=String(patch.phase||'')+'|'+String(patch.message||'');
  if(key===last)return;
  last=key;
  const progress=patch.progress;
  let detail='';
  if(progress&&Number.isFinite(progress.bytesTotal)&&progress.bytesTotal>0)detail=bsize(progress.bytesDone||0)+' of '+bsize(progress.bytesTotal);
  else if(progress&&Number.isFinite(progress.percent))detail=progress.percent+'%';
  console.log('    ·   '+String(patch.phase||'install')+': '+String(patch.message||'')+(detail?'  ('+detail+')':''));
 };
}

// ---- zip reading, so "every jar passes zip integrity" means every entry -------
const CRC_TABLE=(()=>{
 const table=new Int32Array(256);
 for(let index=0;index<256;index++){
  let value=index;
  for(let bit=0;bit<8;bit++)value=value&1?0xEDB88320^(value>>>1):value>>>1;
  table[index]=value;
 }
 return table;
})();
function crc32(buffer){
 let crc=-1;
 for(let index=0;index<buffer.length;index++)crc=CRC_TABLE[(crc^buffer[index])&0xff]^(crc>>>8);
 return (crc^-1)>>>0;
}
// A jar is a zip: read the central directory, then every entry through its local
// header, inflate it and check its CRC and length against the directory. A truncated
// download, a corrupt byte or a lying directory all fail here; `unzip -t` would prove
// the same thing and needs a binary this gate does not want to depend on.
function readZip(buffer,label){
 let end=-1;
 const floor=Math.max(0,buffer.length-65558);
 for(let index=buffer.length-22;index>=floor;index--)if(buffer.readUInt32LE(index)===0x06054b50){end=index;break;}
 if(end<0)throw Error('no end-of-central-directory record: the file is truncated or not a zip');
 const count=buffer.readUInt16LE(end+10);
 let offset=buffer.readUInt32LE(end+16);
 const entries=new Map();
 for(let index=0;index<count;index++){
  if(offset+46>buffer.length||buffer.readUInt32LE(offset)!==0x02014b50)throw Error('the central directory is truncated at entry '+(index+1)+' of '+count);
  const flags=buffer.readUInt16LE(offset+8);
  const method=buffer.readUInt16LE(offset+10);
  const crc=buffer.readUInt32LE(offset+16);
  const compressed=buffer.readUInt32LE(offset+20);
  const size=buffer.readUInt32LE(offset+24);
  const nameLength=buffer.readUInt16LE(offset+28);
  const extraLength=buffer.readUInt16LE(offset+30);
  const commentLength=buffer.readUInt16LE(offset+32);
  const local=buffer.readUInt32LE(offset+42);
  if(size===0xffffffff||compressed===0xffffffff||local===0xffffffff)throw Error('entry '+(index+1)+' needs ZIP64, which this reader does not implement');
  const name=buffer.toString('utf8',offset+46,offset+46+nameLength);
  offset+=46+nameLength+extraLength+commentLength;
  if(name.endsWith('/'))continue;
  if(flags&0x1)throw Error(name+' is encrypted');
  if(local+30>buffer.length||buffer.readUInt32LE(local)!==0x04034b50)throw Error('the local header for '+name+' is missing');
  const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);
  if(start+compressed>buffer.length)throw Error(name+' runs past the end of the file');
  const raw=buffer.subarray(start,start+compressed);
  let data;
  if(method===0)data=raw;
  else if(method===8)data=zlib.inflateRawSync(raw);
  else throw Error(name+' uses compression method '+method);
  if(data.length!==size)throw Error(name+' inflates to '+data.length+' bytes and the directory says '+size);
  if(crc32(data)!==crc)throw Error(name+' fails its CRC');
  entries.set(name,data);
 }
 return entries;
}
// Gson — the parser Fabric Loader reads mod metadata with — accepts a raw control
// character inside a string, and at least one published mod ships one: entity model
// features' fabric.mod.json carries a literal newline in its description, which strict
// JSON refuses. Escaping those characters and parsing again reads the file the way the
// loader will, instead of calling a mod that demonstrably loads corrupt.
function parseLenient(text){
 let output='',inString=false,escaped=false;
 for(const character of text){
  if(inString){
   if(escaped){output+=character;escaped=false;continue;}
   if(character==='\\'){output+=character;escaped=true;continue;}
   if(character==='"'){output+=character;inString=false;continue;}
   const code=character.charCodeAt(0);
   output+=code<0x20?'\\u'+code.toString(16).padStart(4,'0'):character;
   continue;
  }
  if(character==='"')inString=true;
  output+=character;
 }
 return JSON.parse(output);
}
function modMetadata(entries,label){
 const text=entries.get('fabric.mod.json');
 if(!text)return {meta:null,lenient:false};
 const raw=text.toString('utf8').replace(/^\ufeff/,'');
 let meta=null,lenient=false;
 try{meta=JSON.parse(raw);}
 catch{
  try{meta=parseLenient(raw);lenient=true;}
  catch(error){throw Error(label+': fabric.mod.json is not JSON ('+error.message+')');}
 }
 if(!meta||typeof meta!=='object')throw Error(label+': fabric.mod.json is not an object');
 const id=String(meta.id||'').trim();
 if(!id)throw Error(label+': fabric.mod.json has no id');
 const version=String(meta.version||'').trim();
 const provides=[];
 if(Array.isArray(meta.provides))for(const item of meta.provides){
  if(typeof item==='string')provides.push({id:item,version});
  else if(item&&item.id)provides.push({id:String(item.id),version:String(item.version||version)});
 }
 const depends=meta.depends&&typeof meta.depends==='object'&&!Array.isArray(meta.depends)?meta.depends:{};
 return {meta:{id,version,provides,depends},lenient};
}

// ---- arguments, origin and root ---------------------------------------------
function parseArguments(argv){
 const parsed={origin:'',root:'',help:false,selfCheck:false};
 const positional=[];
 for(let index=0;index<argv.length;index++){
  const arg=argv[index];
  if(arg==='--help'||arg==='-h')parsed.help=true;
  else if(arg==='--self-check')parsed.selfCheck=true;
  else if(arg==='--root'){
   const value=argv[++index];
   if(!value||value.startsWith('-'))throw Error('--root needs a folder.');
   parsed.root=value;
  }else if(arg.startsWith('--root='))parsed.root=arg.slice('--root='.length);
  else if(arg.startsWith('-'))throw Error('Unknown option '+arg+'. Use --help.');
  else positional.push(arg);
 }
 if(positional.length>1)throw Error('Only one origin may be given.');
 parsed.origin=positional[0]||process.env.EASTER_LIVE_ORIGIN||DEFAULT_ORIGIN;
 parsed.root=parsed.root||process.env.EASTER_LIVE_ROOT||DEFAULT_ROOT;
 if(!parsed.root)throw Error('--root needs a folder.');
 return parsed;
}
function originUrl(value){
 let url;
 try{url=new URL(String(value||''));}catch{throw Error('The origin must be an absolute URL: '+value);}
 const loopback=new Set(['127.0.0.1','[::1]','::1','localhost']);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback.has(url.hostname.toLowerCase())))throw Error('The origin must be https, or http on the loopback interface.');
 return url.href.replace(/\/+$/,'')+'/';
}
// `fresh` is a root this gate created or found empty: everything must download and
// the optional graphics chunk must be absent.
// `repeat` is a root that already holds a finished install marker: the quiet path is
// what has to be proven. `resume` is a marked but unfinished tree (an interrupted run).
async function prepareRoot(clientRoot){
 const listing=await fs.readdir(clientRoot).catch(error=>{
  if(error.code==='ENOENT')return null;
  throw error;
 });
 if(listing===null){await fs.mkdir(clientRoot,{recursive:true});return {mode:'fresh',created:true};}
 if(!listing.length)return {mode:'fresh',created:false};
 const owned=await exists(path.join(clientRoot,install.MARKER));
 if(!owned)throw Error('That folder already holds '+listing.length+' entries this gate did not create ('+listing.slice(0,5).join(', ')+(listing.length>5?', …':'')+'), and it carries no '+install.MARKER+' marker. This gate only writes into an empty folder or a client tree the launcher owns; refusing rather than adopting it.');
 const record=await install.readInstalled(clientRoot);
 return {mode:record?'repeat':'resume',created:false,record};
}
// Two runs at once on one root would corrupt each other's numbers, so the gate holds a
// lock beside the root. A lock left by a process that is gone is taken over.
async function lockRoot(clientRoot){
 const lock=clientRoot+'.lock';
 const held=Number(await fs.readFile(lock,'utf8').catch(()=>'0'));
 if(Number.isInteger(held)&&held>0&&held!==process.pid){
  let alive=false;
  try{process.kill(held,0);alive=true;}catch{}
  if(alive)throw Error('Another run of this gate holds '+lock+' (pid '+held+'). Do not run two of these at once.');
 }
 await fs.mkdir(path.dirname(lock),{recursive:true}).catch(()=>{});
 await fs.writeFile(lock,String(process.pid),{mode:0o600});
 const release=()=>{try{fsSync.rmSync(lock,{force:true});}catch{}};
 process.on('exit',release);
 return release;
}

// ---- the self-check ----------------------------------------------------------
// This gate's own ending is the part that failed once: a run that refused to start
// printed "gate PASS · none failed". The refusal paths are driven here in child
// processes, offline, and each one must end with a non-zero exit, exactly one verdict
// line, and that line saying FAIL. The inverse — a refusal printing PASS — is the bug,
// so that is what is asserted against.
function capture(args){
 return new Promise(resolve=>{
  const child=spawn(process.execPath,args,{cwd:repo});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=String(chunk);});
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  child.on('close',code=>resolve({code,stdout,stderr}));
 });
}
async function selfCheck(){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-gate-selfcheck-'));
 const self=fileURLToPath(import.meta.url);
 const cases=[];
 // The lock refusal: a root another run holds. This is the refusal that lied on
 // 2026-10-22, so our own pid stands in for the other run's.
 const held=path.join(temp,'held');
 await fs.mkdir(held,{recursive:true});
 await fs.writeFile(held+'.lock',String(process.pid),{mode:0o600});
 cases.push({name:'a root another run holds (the lock refusal)',args:['--root',held]});
 // A folder this gate did not create and must not adopt.
 const foreign=path.join(temp,'foreign');
 await fs.mkdir(foreign,{recursive:true});
 await fs.writeFile(path.join(foreign,'someone-elses-notes.txt'),'not ours\n');
 cases.push({name:'a folder the gate did not create',args:['--root',foreign]});
 // An argument that cannot be used at all: refused before anything is touched.
 cases.push({name:'an origin that is not a URL',args:['not a url','--root',path.join(temp,'a')]});
 // An origin nothing answers on, so the refusal happens inside the first phase.
 cases.push({name:'an origin nothing answers on',args:['http://127.0.0.1:1/','--root',path.join(temp,'b')]});
 console.log('gate self-check: every refusal must end with a FAIL verdict and a non-zero exit');
 let failures=0;
 for(const item of cases){
  const result=await capture([self,...item.args]);
  const verdicts=result.stdout.split('\n').filter(line=>line.startsWith('gate '));
  const verdict=verdicts[0]||'';
  const good=result.code!==0&&verdicts.length===1&&/^gate FAIL [?·]/.test(verdict)&&!/gate PASS/.test(result.stdout)&&!/none failed/.test(verdict);
  if(!good){
   failures++;
   console.log('  FAIL  '+item.name+' → exit '+result.code+', '+verdicts.length+' verdict line(s): '+(verdict||'(none printed)'));
   console.log(result.stdout.split('\n').slice(-4).map(line=>'        '+line).join('\n'));
  }else{
   console.log('  ok    '+item.name+' → exit '+result.code+', one verdict: '+verdict.trim());
  }
 }
 await fs.rm(temp,{recursive:true,force:true});
 console.log('self-check '+(failures?'FAIL':'PASS')+' · '+cases.length+' refusal paths · every one ended FAIL with a non-zero exit code');
 process.exitCode=failures?1:0;
}

// ---- the phases --------------------------------------------------------------
async function main(){
 const args=parseArguments(process.argv.slice(2));
 if(args.help){console.log(USAGE);return;}
 if(args.selfCheck)return selfCheck();
 const origin=originUrl(args.origin);
 const clientRoot=path.resolve(args.root);
 const refused=locationProblem(clientRoot,{});
 if(refused)throw Error('The client folder is refused: '+refused);
 const state=await prepareRoot(clientRoot);
 // `pristine` is the root this gate made or found empty: everything must download and
 // the optional chunk must be absent before the toggle. `settled` is a finished tree
 // from an earlier run: the quiet path and the cached graphics payload are what can be
 // proven there, so the download-shaped assertions are printed as skips instead.
 const pristine=state.mode==='fresh';
 const settled=state.mode==='repeat';
 const release=await lockRoot(clientRoot);
 try{
  printHeader({origin,clientRoot,state});

  // 1. the published manifest, as the launcher's own reader sees it
  begin('manifest','the live published client manifest');
  const manifest=await install.publishedManifest(origin);
  const chunks=install.chunkList(manifest,origin);
  check(manifest.minecraft===PINNED.minecraft,'minecraft is pinned at '+PINNED.minecraft,String(manifest.minecraft));
  check(manifest.fabric===PINNED.fabric,'fabric is pinned at '+PINNED.fabric,String(manifest.fabric));
  check(Array.isArray(chunks)&&chunks.length===3,'the manifest describes three chunks',chunks?chunks.map(chunk=>chunk.id).join(', '):'none');
  const byId=new Map((chunks||[]).map(chunk=>[chunk.id,chunk]));
  for(const [id,shape] of Object.entries(CHUNK_SHAPE)){
   const chunk=byId.get(id);
   if(!check(Boolean(chunk),'the '+id+' chunk is published'))continue;
   check(chunk.files.length===shape.files,'the '+id+' chunk declares '+shape.files+' files',String(chunk.files.length)+' declared');
   check(chunk.optional===shape.optional,'the '+id+' chunk is '+(shape.optional?'optional':'required'));
   if(typeof shape.immutable==='boolean')check(chunk.immutable===shape.immutable,'the '+id+' chunk is '+(shape.immutable?'immutable':'mutable'));
  }
  const baseChunk=byId.get('base');
  check(baseChunk?.fabric===PINNED.fabric,'the base chunk repeats the fabric pin',baseChunk?String(baseChunk.fabric):'none');
  check(baseChunk?.java===PINNED.java,'the base chunk requires Java '+PINNED.java,baseChunk?String(baseChunk.java):'none');
  const requiredChunks=(chunks||[]).filter(chunk=>!chunk.optional);
  const requiredFiles=requiredChunks.flatMap(chunk=>chunk.files);
  const graphicsChunk=byId.get('graphics')||null;
  const graphicsFiles=graphicsChunk?graphicsChunk.files:[];
  check(requiredFiles.length===15,'the required chunks declare 15 files in all',String(requiredFiles.length));
  check(graphicsFiles.length===4,'the optional graphics chunk declares 4 files',String(graphicsFiles.length));
  summarise('26.2 · fabric 0.19.5 · base '+requiredChunks.find(c=>c.id==='base')?.files.length+' + visuals '+requiredChunks.find(c=>c.id==='visuals')?.files.length+' = '+requiredFiles.length+' required, graphics '+graphicsFiles.length+' optional');
  if(!graphicsChunk){
   console.log('\nThe published manifest has no graphics chunk, so the toggle half of this gate has nothing to drive. Stopping here: that is itself a finding to report.');
   finish();
   return;
  }

  // 2. the install itself
  begin('install',state.mode==='fresh'?'a fresh root at '+clientRoot:state.mode==='resume'?'an interrupted tree at '+clientRoot:'an already-installed tree at '+clientRoot);
  install.resetTransferStats();
  const installClock=clock();
  const installStarted=Date.now();
  const installed=await install.installClient({root:clientRoot,settings:{},includeGraphics:false,hardware:PROFILE,origin,published:manifest,notify:notifier()});
  const installMs=Date.now()-installStarted;
  const installMoved=install.transferStats();
  const installEnded=clock();
  const expectedVersion=manifest.minecraft+'-fabric'+manifest.fabric;
  info('installClient started '+installClock+' and answered "'+installed.message+'" at '+installEnded+' ('+duration(installMs)+')');
  info('it fetched '+exact(installMoved.bytesFetched)+' ('+bsize(installMoved.bytesFetched)+') and read '+installMoved.hashReads+' hashes');
  check(/^Client ready\.$/.test(String(installed.message||'')),'the install reports "Client ready."',String(installed.message||''));
  check(installed.version===expectedVersion,'the installed version id is '+expectedVersion,String(installed.version||'none'));
  check(installed.includeGraphics===false,'enhanced graphics are off, as asked',String(installed.includeGraphics));
  if(pristine){
   check(installMoved.bytesFetched>0,'a fresh root downloads the payload',exact(installMoved.bytesFetched));
   check(installed.unchanged!==true,'and reports it installed rather than unchanged',installed.unchanged===true?'unchanged':'installed');
  }else if(settled){
   check(installMoved.bytesFetched===0,'a root that already holds the payload fetches 0 bytes',exact(installMoved.bytesFetched));
   check(installMoved.hashReads===0,'and reads 0 hashes',String(installMoved.hashReads));
   check(installed.unchanged===true,'and reports unchanged',String(installed.unchanged));
  }else{
   info('this root was left by an interrupted run, so neither "downloaded everything" nor "quiet" is asserted: what it fetched is reported above and every file is verified below');
  }
  facts.install={message:String(installed.message||''),ms:installMs,bytes:installMoved.bytesFetched,hashReads:installMoved.hashReads,fresh:pristine};
  summarise((pristine?'fresh root: ':'already installed: ')+exact(installMoved.bytesFetched)+', '+installMoved.hashReads+' hash reads in '+duration(installMs));

  // 3. every file of every required chunk, against its own declared size and hash
  begin('chunk files','every file the required chunks declare, verified against its own size and hash');
  for(const file of requiredFiles){
   const target=path.join(clientRoot,file.path);
   const stat=await fs.stat(target).catch(()=>null);
   if(!check(Boolean(stat),file.path+' is installed'))continue;
   check(stat.size===file.size,file.path+' is '+exact(file.size),exact(stat.size));
   if(stat.size!==file.size)continue;
   const digest=await hashFile(target,file.algorithm);
   check(digest===file.hash,file.path+' matches its '+file.algorithm,digest.slice(0,16)+'…');
  }
  const requiredBytes=declaredBytes(requiredFiles);
  if(pristine){
   for(const file of graphicsFiles){
    check(!(await exists(path.join(clientRoot,file.path))),file.path+' is absent while the toggle is off');
   }
  }else{
   skip('the optional graphics files are absent while the toggle is off','this root already held a previous run’s graphics payload, and switching the toggle off keeps it on disk by design; the fresh root is where the absence is asserted');
  }
  const marker=await install.readInstalled(clientRoot);
  const markerFiles=new Set(marker?.files||[]);
  check(requiredFiles.every(file=>markerFiles.has(file.path)),'the install marker records every required file',markerFiles.size+' recorded');
  const declaredPaths=new Set([...requiredFiles,...graphicsFiles].map(file=>file.path));
  const strays=[...markerFiles].filter(entry=>!declaredPaths.has(entry));
  check(!strays.length,'the install marker records nothing the manifest does not declare',strays.join(', ')||'nothing');
  check(marker?.chunks?.base?.verified===true&&marker?.chunks?.visuals?.verified===true,'the required chunks are recorded as verified',Object.keys(marker?.chunks||{}).join(', '));
  summarise(requiredFiles.length+' files · '+bsize(requiredBytes)+' verified · graphics '+(pristine?'absent, as the toggle is off':'already cached from a previous run'));

  // 4. the game itself, from the tree that was just installed
  begin('game','the client is whole: version json, loader, client jar, assets and the Java runtime');
  const versionPath=path.join(clientRoot,'versions',expectedVersion,expectedVersion+'.json');
  const versionText=await fs.readFile(versionPath,'utf8').catch(()=>null);
  const versionJson=versionText?JSON.parse(versionText):null;
  check(Boolean(versionJson),'versions/'+expectedVersion+'/'+expectedVersion+'.json parses',versionText?exact(versionText.length):'absent');
  check(versionJson?.mainClass===KNOT_MAIN_CLASS,'its mainClass is the Fabric knot client',String(versionJson?.mainClass||'none'));
  check(versionJson?.inheritsFrom===PINNED.minecraft,'it inherits from Minecraft '+PINNED.minecraft,String(versionJson?.inheritsFrom||'none'));
  const loaderName=(versionJson?.libraries||[]).map(library=>String(library.name||'')).find(name=>name.startsWith('net.fabricmc:fabric-loader:'));
  check(loaderName==='net.fabricmc:fabric-loader:'+PINNED.fabric,'the fabric-loader library is named at '+PINNED.fabric,loaderName||'absent');
  const clientJar=path.join(clientRoot,'versions',PINNED.minecraft,PINNED.minecraft+'.jar');
  const clientStat=await fs.stat(clientJar).catch(()=>null);
  check(Boolean(clientStat&&clientStat.size>0),'the Minecraft '+PINNED.minecraft+' client jar is installed',clientStat?bsize(clientStat.size):'absent');
  const vanillaText=await fs.readFile(path.join(clientRoot,'versions',PINNED.minecraft,PINNED.minecraft+'.json'),'utf8').catch(()=>null);
  const vanilla=vanillaText?JSON.parse(vanillaText):null;
  const assetId=vanilla?.assetIndex?.id||null;
  check(Boolean(assetId),'the version json names an asset index',String(assetId));
  const assetIndexPath=path.join(clientRoot,'assets','indexes',String(assetId)+'.json');
  const assetText=await fs.readFile(assetIndexPath,'utf8').catch(()=>null);
  check(Boolean(assetText),'assets/indexes/'+assetId+'.json parses',assetText?bsize(assetText.length):'absent');
  if(assetText){
   const index=JSON.parse(assetText);
   const objects=Object.values(index.objects||{});
   const unique=[...new Map(objects.map(row=>[row.hash,row])).values()];
   const objectRoot=path.join(clientRoot,'assets','objects');
   const prefixes=(await fs.readdir(objectRoot).catch(()=>[])).filter(name=>name.length===2);
   let onDisk=0;
   for(const prefix of prefixes)onDisk+=(await fs.readdir(path.join(objectRoot,prefix))).length;
   check(onDisk===objects.length,'the asset object count equals the index object count',commas(onDisk)+' objects for '+commas(objects.length)+' entries');
   const present=await Promise.all(unique.map(row=>exists(path.join(objectRoot,row.hash.slice(0,2),row.hash))));
   const missing=present.filter(value=>!value).length;
   check(missing===0,'every asset object the index names is on disk',commas(missing)+' missing of '+commas(unique.length));
   pin('asset objects',RECORDED.assetObjects,objects.length);
   facts.assets=objects.length;
  }
  const javaPath=marker?.java||null;
  check(typeof javaPath==='string'&&javaPath.startsWith(path.join(clientRoot,'runtime')+path.sep),'the recorded Java runtime is inside the client tree',String(javaPath||'none'));
  const component=vanilla?.javaVersion?.component||null;
  if(component&&typeof javaPath==='string'){
   check(path.basename(path.dirname(path.dirname(javaPath)))===component,'the runtime is Mojang’s '+component+' component for this version',path.basename(path.dirname(path.dirname(javaPath))));
  }
  if(typeof javaPath==='string'){
   const reported=await run(javaPath,['-version']).catch(error=>({stdout:'',stderr:String(error.stderr||error.message)}));
   const text=String(reported.stdout||'')+String(reported.stderr||'');
   const match=/(?:openjdk|java) version "([^"]+)"/.exec(text);
   const major=match?Number(match[1].split('.')[0]):null;
   check(major===PINNED.java,'the installed Java runtime reports major version '+PINNED.java,match?match[0]:text.trim().slice(0,120)||'no version line');
   info('the runtime it will actually start is '+javaPath);
  }
  check(marker?.game?.verified===true,'the install marker records the game as verified',JSON.stringify(marker?.game||null));
  summarise('Minecraft '+PINNED.minecraft+' + fabric '+PINNED.fabric+' · '+(facts.assets||'?')+' asset objects · Java '+PINNED.java);

  // 5. the enhanced graphics toggle, on
  begin('graphics on','the optional chunk through the toggle, and the client settings it writes');
  const ladder=hardware.qualitySettings(PROFILE);
  install.resetTransferStats();
  const graphicsStarted=Date.now();
  const on=await install.applyGraphics({root:clientRoot,settings:{},includeGraphics:true,hardware:PROFILE,origin,published:manifest,notify:notifier()});
  const graphicsMs=Date.now()-graphicsStarted;
  const graphicsMoved=install.transferStats();
  const graphicsDeclared=declaredBytes(graphicsFiles);
  info('applyGraphics(true) took '+duration(graphicsMs)+', fetched '+exact(graphicsMoved.bytesFetched)+' and ran '+graphicsMoved.hashReads+' hash reads');
  if(pristine){
   check(graphicsMoved.bytesFetched===graphicsDeclared,'the toggle fetched exactly the graphics chunk',exact(graphicsMoved.bytesFetched)+' of '+exact(graphicsDeclared));
  }else if(settled){
   check(graphicsMoved.bytesFetched===0,'nothing to fetch: the graphics payload is already installed',exact(graphicsMoved.bytesFetched));
  }else{
   info('an interrupted root, so how much of the graphics chunk was still missing is reported rather than asserted: '+exact(graphicsMoved.bytesFetched)+' of '+exact(graphicsDeclared));
  }
  pin('the graphics chunk’s declared size',RECORDED.graphicsBytes,graphicsDeclared);
  check(on.includeGraphics===true,'the toggle reports enhanced graphics on',String(on.includeGraphics));
  check(on.graphics===graphicsChunk.version,'it reports the published graphics chunk as applied',String(on.graphics||'none'));
  for(const file of graphicsFiles){
   const target=path.join(clientRoot,file.path);
   const stat=await fs.stat(target).catch(()=>null);
   if(!check(Boolean(stat),file.path+' landed'))continue;
   check(stat.size===file.size,file.path+' is '+exact(file.size),exact(stat.size));
   const digest=await hashFile(target,file.algorithm);
   check(digest===file.hash,file.path+' matches its '+file.algorithm,digest.slice(0,16)+'…');
  }
  const shaderPackFile=graphicsFiles.find(file=>/^shaderpacks\/.+\.zip$/.test(file.path));
  const shaderPackName=shaderPackFile?path.posix.basename(shaderPackFile.path):null;
  const irisFile=path.join(clientRoot,'config','iris.properties');
  const irisText=await fs.readFile(irisFile,'utf8').catch(()=>null);
  const iris=properties(irisText||'');
  check(iris.get('enableShaders')==='true','config/iris.properties enables shaders',String(iris.get('enableShaders')||'absent'));
  check(Boolean(shaderPackName)&&iris.get('shaderPack')===shaderPackName,'iris.properties names the pack the chunk delivered ('+String(shaderPackName)+')',String(iris.get('shaderPack')||'absent'));
  check(Number(iris.get('shadowDistance'))===ladder.shadowDistance,'iris.properties shadowDistance is '+ladder.shadowDistance,String(iris.get('shadowDistance')||'absent'));
  const optionsText=await fs.readFile(path.join(clientRoot,'options.txt'),'utf8').catch(()=>null);
  const options=properties(optionsText||'');
  check(Number(options.get('renderDistance'))===ladder.renderDistance,'options.txt renderDistance is '+ladder.renderDistance+', the ladder for an '+PROFILE.vramMB+' MB '+PROFILE.tier+' adapter',String(options.get('renderDistance')||'absent'));
  check(Number(on.quality?.renderDistance)===ladder.renderDistance&&Number(on.quality?.shadowDistance)===ladder.shadowDistance&&Boolean(on.quality?.shaders)===Boolean(ladder.shaders),'the tuned record read back is '+JSON.stringify({renderDistance:ladder.renderDistance,shadowDistance:ladder.shadowDistance,shaders:ladder.shaders}),JSON.stringify(on.quality||null));
  const grassCache=visuals.GRASS_CACHE;
  const cachedFile=graphicsFiles.find(file=>file.path.endsWith('.jar.disabled'));
  check(cachedFile?.path===grassCache,'the chunk’s cached foliage jar is '+grassCache,String(cachedFile?.path||'none'));
  const grassActive=path.join(clientRoot,visuals.GRASS_ACTIVE);
  const activeDigest=await hashFile(grassActive,'sha256').catch(()=>null);
  const cachedDigest=await hashFile(path.join(clientRoot,grassCache),'sha256').catch(()=>null);
  check(Boolean(activeDigest)&&activeDigest===cachedDigest,'mods/'+path.posix.basename(visuals.GRASS_ACTIVE)+' is the activated, byte-equal copy of '+grassCache,activeDigest?activeDigest.slice(0,16)+'…':'absent');
  summarise('+'+exact(graphicsMoved.bytesFetched)+' in '+duration(graphicsMs)+' · '+shaderPackName+' · tuned '+ladder.renderDistance+'/'+ladder.shadowDistance+'/'+ladder.shaders);
  facts.graphics={ms:graphicsMs,bytes:graphicsMoved.bytesFetched,hashReads:graphicsMoved.hashReads,declared:graphicsDeclared,shaderPack:shaderPackName,ladder};

  // 6. the jars: zip integrity, and the dependency closure with jar-in-jar counted
  begin('mods','every jar in mods/ is whole, and every require resolves against the installed set');
  const modsDir=path.join(clientRoot,'mods');
  const jarNames=(await fs.readdir(modsDir).catch(()=>[])).filter(name=>name.endsWith('.jar')).sort();
  const declaredJars=new Set([...requiredFiles,...graphicsFiles].filter(file=>file.path.endsWith('.jar')).map(file=>path.posix.basename(file.path)));
  if(await exists(grassActive))declaredJars.add(path.posix.basename(visuals.GRASS_ACTIVE));
  const extras=jarNames.filter(name=>!declaredJars.has(name));
  const absent=[...declaredJars].filter(name=>!jarNames.includes(name));
  check(!absent.length,'every jar the manifest installs is in mods/',absent.join(', ')||jarNames.length+' jars');
  check(!extras.length,'mods/ holds no jar the manifest does not declare',extras.join(', ')||'nothing extra');
  const installedMods=[];
  const nestedMods=[];
  const nestedCounts=new Map();
  const nestedProviders=new Map();
  const lenientFiles=[];
  for(const name of jarNames){
   const buffer=await fs.readFile(path.join(modsDir,name));
   let entries;
   try{entries=readZip(buffer,name);}catch(error){fail(name+' passes zip integrity',error.message);continue;}
   ok(name+' passes zip integrity',entries.size+' entries');
   let meta=null;
   try{
    const parsed=modMetadata(entries,name);
    meta=parsed.meta;
    if(parsed.lenient)lenientFiles.push(name);
   }catch(error){fail(name+' has a readable fabric.mod.json',error.message);}
   if(!meta){fail(name+' declares itself to Fabric');continue;}
   installedMods.push({...meta,from:'mods/'+name,jar:name});
   const nestedNames=[...entries.keys()].filter(entry=>/^META-INF\/jars\/[^/]+\.jar$/.test(entry));
   nestedCounts.set(meta.id,nestedNames.length);
   const providedHere=new Set();
   for(const nestedName of nestedNames){
    const label=name+'!'+path.posix.basename(nestedName);
    let nestedEntries;
    try{nestedEntries=readZip(entries.get(nestedName),label);}catch(error){fail(label+' passes zip integrity',error.message);continue;}
    let nestedMeta=null;
    try{
     const parsed=modMetadata(nestedEntries,label);
     nestedMeta=parsed.meta;
     if(parsed.lenient)lenientFiles.push(label);
    }catch(error){fail(label+' has a readable fabric.mod.json',error.message);}
    if(!nestedMeta)continue;
    nestedMods.push({...nestedMeta,from:label,jar:name});
    providedHere.add(nestedMeta.id);
    for(const alias of nestedMeta.provides)providedHere.add(alias.id);
   }
   nestedProviders.set(name,providedHere);
  }
  if(lenientFiles.length)info(lenientFiles.length+' fabric.mod.json '+(lenientFiles.length===1?'file is':'files are')+' not strict JSON and were read the lenient way Gson — and therefore Fabric — reads them: '+lenientFiles.join(', '));
  // The installed set, counted together: every top-level mod, every jar-in-jar module,
  // and the ids a mod also answers to through `provides`.
  const provided=new Map();
  const topLevelIds=new Set();
  for(const mod of installedMods){
   if(!provided.has(mod.id))provided.set(mod.id,mod);
   topLevelIds.add(mod.id);
   for(const alias of mod.provides){if(!provided.has(alias.id))provided.set(alias.id,{id:alias.id,version:alias.version,from:mod.from});topLevelIds.add(alias.id);}
  }
  for(const mod of nestedMods){
   if(!provided.has(mod.id))provided.set(mod.id,mod);
   for(const alias of mod.provides)if(!provided.has(alias.id))provided.set(alias.id,{id:alias.id,version:alias.version,from:mod.from});
  }
  const edges=[];
  const platformEdges=[];
  for(const mod of [...installedMods,...nestedMods]){
   for(const [id,predicate] of Object.entries(mod.depends)){
    const edge={from:mod.id,jar:mod.jar,id,predicate:String(predicate),nested:mod.from.includes('!')};
    if(PLATFORM_MODS.has(id))platformEdges.push(edge);else edges.push(edge);
   }
  }
  const unresolved=edges.filter(edge=>!provided.has(edge.id));
  // Two shapes of a check that ignores jar-in-jar mods, both of them ones somebody has
  // written, both of them wrong:
  //   - reading only mods/*.jar:  every nested id looks missing;
  //   - letting each jar see only its own nested modules, which is what a reader that
  //     unpacks one jar at a time does: a mod that needs a module from fabric-api's
  //     nested set still looks unsatisfied from sodium's jar.
  const blindTopLevel=[...new Set(edges.filter(edge=>!topLevelIds.has(edge.id)).map(edge=>edge.id))].sort();
  const blindOwnJar=[...new Set(edges.filter(edge=>!topLevelIds.has(edge.id)&&!nestedProviders.get(edge.jar)?.has(edge.id)).map(edge=>edge.id))].sort();
  const topEdges=edges.filter(edge=>!edge.nested);
  // One line per require edge a top-level mod declares, resolved against the whole
  // installed set. The nested modules' own edges are aggregated below: fabric-api alone
  // contributes too many to print, and none of them differ in kind.
  for(const edge of topEdges){
   const provider=provided.get(edge.id);
   if(provider)info(edge.from+' requires '+edge.id+' '+edge.predicate+' → '+provider.from+' holds '+provider.version);
   else fail(edge.from+' requires '+edge.id+' '+edge.predicate,'no installed mod provides '+edge.id);
  }
  const nestedEdges=edges.length-topEdges.length;
  info(nestedMods.length+' nested mods across '+nestedCounts.size+' jars declare '+nestedEdges+' more require edges, checked against the same set');
  check(!unresolved.length,'every require resolves once jar-in-jar mods are counted',unresolved.length?unresolved.length+' unresolved: '+[...new Set(unresolved.map(edge=>edge.id))].join(', '):edges.length+' edges, nested mods included');
  check(nestedMods.length>0,'jar-in-jar mods are part of the installed set',String(nestedMods.length)+' nested');
  // The nesting is load-bearing, and this is how the gate says so rather than trusting
  // its own reader. Three quantities, because "a check that ignores nested jars" is not
  // one check:
  //   - ids a top-level mod requires that only fabric-api's nested modules satisfy
  //     (5 on 2026-10-22, and the pin below: this is the number that measurement meant);
  //   - what reading only mods/*.jar reports missing;
  //   - what a reader that lets each jar see only its own nested modules reports.
  const fabricApi=installedMods.find(mod=>mod.id==='fabric-api')||null;
  const fabricApiNested=nestedProviders.get(fabricApi?.jar)||new Set();
  const nestedOnlyRequired=[...new Set(topEdges.filter(edge=>!topLevelIds.has(edge.id)&&fabricApiNested.has(edge.id)).map(edge=>edge.id))].sort();
  check(blindTopLevel.length>0||blindOwnJar.length>0,'a check that ignores nested jars is exercised by this tree',blindTopLevel.length+' ids look missing to one that reads only mods/*.jar, '+blindOwnJar.length+' to one that reads each jar alone');
  info('ids a top-level mod requires that only fabric-api’s nested modules satisfy: '+nestedOnlyRequired.length+(nestedOnlyRequired.length?' ('+nestedOnlyRequired.join(', ')+')':''));
  info('reading only mods/*.jar would report '+blindTopLevel.length+' missing: '+blindTopLevel.join(', '));
  info('letting each jar see only its own nested modules would report '+blindOwnJar.length+' missing: '+blindOwnJar.join(', '));
  pin('requires only fabric-api’s nested modules satisfy',RECORDED.naiveMissing,nestedOnlyRequired.length);
  for(const [id,count] of nestedCounts)if(count)info(id+' ships '+count+' nested '+(count===1?'mod':'mods'));
  pin('mods/ jars',RECORDED.modJars,jarNames.length);
  pin('fabric-api’s nested modules',RECORDED.fabricApiNested,nestedCounts.get('fabric-api')||0);
  info('a nested count is the number of META-INF/jars/*.jar entries: a text listing also shows the META-INF/jars/ directory entry, which is not a module');
  info(platformEdges.length+' platform requires (minecraft, java, fabricloader) are not mod lookups: the pins above cover them');
  summarise(jarNames.length+' jars whole · '+edges.length+' require edges ('+nestedEdges+' from nested mods) · 0 unresolved · reading only mods/*.jar would report '+blindTopLevel.length+' missing');

  // 7. the toggle, off
  begin('graphics off','switching the effect off downloads nothing and keeps what it cached');
  install.resetTransferStats();
  const offStarted=Date.now();
  const off=await install.applyGraphics({root:clientRoot,settings:{},includeGraphics:false,hardware:PROFILE,origin,published:manifest,notify:notifier()});
  const offMs=Date.now()-offStarted;
  const offMoved=install.transferStats();
  info('applyGraphics(false) took '+duration(offMs)+', fetched '+exact(offMoved.bytesFetched)+' and ran '+offMoved.hashReads+' hash reads');
  check(offMoved.bytesFetched===0,'switching off fetched 0 bytes',exact(offMoved.bytesFetched));
  check(offMoved.hashReads===0,'and read 0 hashes',String(offMoved.hashReads));
  check(off.includeGraphics===false,'the toggle reports enhanced graphics off',String(off.includeGraphics));
  const offIris=properties(await fs.readFile(irisFile,'utf8').catch(()=>''));
  check(offIris.get('enableShaders')==='false','config/iris.properties now says enableShaders:false',String(offIris.get('enableShaders')||'absent'));
  check(!(await exists(grassActive)),'the activated foliage jar is gone',visuals.GRASS_ACTIVE);
  if(shaderPackFile)check(await exists(path.join(clientRoot,shaderPackFile.path)),'the shader pack stays on disk for the next enable',shaderPackFile.path);
  if(cachedFile)check(await exists(path.join(clientRoot,cachedFile.path)),'and the .jar.disabled cache is kept',cachedFile.path);
  check((await install.readInstalled(clientRoot))?.includeGraphics===false,'the install marker records enhanced graphics as off');
  summarise('0 bytes, 0 hash reads, shaders off, shader pack and cache kept');
  facts.off={ms:offMs,bytes:offMoved.bytesFetched};

  // 8. a second install over the finished tree
  begin('quiet install','a second install over the finished tree does nothing at all');
  const optionsPath=path.join(clientRoot,'options.txt');
  const optionsBefore=await fs.stat(optionsPath);
  const optionsTextBefore=await fs.readFile(optionsPath,'utf8');
  install.resetTransferStats();
  const quietStarted=Date.now();
  const quiet=await install.installClient({root:clientRoot,settings:{},includeGraphics:false,hardware:PROFILE,origin,published:manifest,notify:notifier()});
  const quietMs=Date.now()-quietStarted;
  const quietMoved=install.transferStats();
  const optionsAfter=await fs.stat(optionsPath);
  info('the second install answered "'+quiet.message+'" in '+duration(quietMs)+' with '+exact(quietMoved.bytesFetched)+' and '+quietMoved.hashReads+' hash reads');
  check(quiet.unchanged===true,'it reports unchanged',String(quiet.unchanged));
  check(quietMoved.bytesFetched===0,'it fetched 0 bytes',exact(quietMoved.bytesFetched));
  check(quietMoved.hashReads===0,'it read 0 hashes',String(quietMoved.hashReads));
  check(/^Client ready\.$/.test(String(quiet.message||'')),'and still says "Client ready."',String(quiet.message||''));
  check(optionsAfter.mtimeMs===optionsBefore.mtimeMs,'options.txt’s mtime is untouched',new Date(optionsBefore.mtimeMs).toISOString());
  check(await fs.readFile(optionsPath,'utf8')===optionsTextBefore,'and its bytes are untouched');
  summarise(exact(quietMoved.bytesFetched)+', '+quietMoved.hashReads+' hash reads, unchanged, options.txt untouched, '+duration(quietMs));
  facts.quiet={ms:quietMs,bytes:quietMoved.bytesFetched,hashReads:quietMoved.hashReads,message:String(quiet.message||'')};

  // 9. a player's own edit survives the next pass
  begin('player edit','a simulated player edit survives the next install pass');
  const before=await fs.readFile(optionsPath,'utf8');
  const edited=setKey(setKey(before,'renderDistance','8'),'key_key.sneak','key.keyboard.left.alt');
  // A second run of the gate starts from the first run's edit, so "the edit changed the
  // file" is only worth asserting when it did.
  if(edited===before)info('options.txt already carried renderDistance:8 and the sneak rebind, so this run’s edit changes nothing');
  else ok('the gate rewrote the two lines a player would have changed','renderDistance:8, sneak on left alt');
  await fs.writeFile(optionsPath,edited,{mode:0o600});
  const editedStat=await fs.stat(optionsPath);
  install.resetTransferStats();
  const passStarted=Date.now();
  const pass=await install.installClient({root:clientRoot,settings:{},includeGraphics:false,hardware:PROFILE,origin,published:manifest,notify:notifier()});
  const passMs=Date.now()-passStarted;
  const passMoved=install.transferStats();
  const finalText=await fs.readFile(optionsPath,'utf8');
  check(/^renderDistance:8$/m.test(finalText),'the player’s renderDistance 8 survived');
  check(/^key_key\.sneak:key\.keyboard\.left\.alt$/m.test(finalText),'the player’s sneak rebind survived');
  check((await fs.stat(optionsPath)).mtimeMs===editedStat.mtimeMs,'the pass did not write options.txt at all',new Date(editedStat.mtimeMs).toISOString());
  check(passMoved.bytesFetched===0,'and it fetched 0 bytes',exact(passMoved.bytesFetched));
  info('the pass answered "'+pass.message+'" in '+duration(passMs));
  summarise('renderDistance 8 and the sneak rebind kept, options.txt untouched, '+exact(passMoved.bytesFetched));
  facts.edit={ms:passMs,bytes:passMoved.bytesFetched};

  finish();
 }finally{
  release();
 }
}

// ---- the final table and the summary ----------------------------------------
// One ending for every way this gate can stop: the normal path, an early stop, and a
// thrown refusal all come through finish(), and printSummary derives BOTH the verdict
// word and the exit code from the same failure count. They cannot disagree, which is
// the defect the coordinator hit on 2026-10-22: a run that refused to start printed
// "gate PASS · 0 checks · none failed" because it counted failures from an empty phase
// list while the throw sat outside it. A refusal is a failed gate, and it now says so.
function finish(){
 printTable();
 printSummary();
}
function printTable(){
 console.log('────────────────────────────────────────────────────────────────────────────────');
 console.log('  phase'.padEnd(20)+'result'.padEnd(9)+'checks'.padEnd(9)+'detail');
 console.log('────────────────────────────────────────────────────────────────────────────────');
 for(const phase of phases){
  const passed=phase.checks.filter(entry=>entry.status==='ok').length;
  const result=phase.failures?'FAIL':'ok';
  console.log('  '+phase.title.padEnd(18)+result.padEnd(9)+String(passed+'/'+phase.checks.length).padEnd(9)+phase.summary);
 }
 console.log('────────────────────────────────────────────────────────────────────────────────');
}
function printSummary(){
 const checks=phases.reduce((sum,phase)=>sum+phase.checks.length,0);
 const failed=phases.reduce((sum,phase)=>sum+phase.failures,0);
 const skipped=phases.reduce((sum,phase)=>sum+phase.checks.filter(entry=>entry.status==='skip').length,0);
 const totalBytes=(facts.install?.bytes||0)+(facts.graphics?.bytes||0)+(facts.quiet?.bytes||0)+(facts.edit?.bytes||0);
 const totalPretty=bsize(totalBytes);
 console.log('');
 if(facts.install)console.log('summary install ('+(facts.install.fresh?'fresh root':'same root')+')  "'+facts.install.message+'"  '+exact(facts.install.bytes)+' · '+facts.install.hashReads+' hash reads · '+duration(facts.install.ms));
 if(facts.graphics)console.log('summary graphics on            '+exact(facts.graphics.bytes)+' · '+duration(facts.graphics.ms)+' · '+facts.graphics.shaderPack);
 if(facts.off)console.log('summary graphics off           '+exact(facts.off.bytes)+' · '+duration(facts.off.ms));
 if(facts.quiet)console.log('summary second install         "'+facts.quiet.message+'"  '+exact(facts.quiet.bytes)+' · '+facts.quiet.hashReads+' hash reads · '+duration(facts.quiet.ms));
 if(facts.edit)console.log('summary player-edit pass       '+exact(facts.edit.bytes)+' · '+duration(facts.edit.ms));
 console.log('summary downloaded this run     '+exact(totalBytes)+(totalPretty===exact(totalBytes)?'':' ('+totalPretty+')'));
 console.log('');
 const failures=phases.flatMap(phase=>phase.checks.filter(entry=>entry.status==='fail').map(entry=>({phase:phase.title,...entry})));
 if(failures.length){
  console.log('the checks that failed:');
  for(const entry of failures)console.log('  · ['+entry.phase+'] '+entry.name+(entry.detail?'  ['+entry.detail+']':''));
  console.log('');
 }
 const verdict=failed?'FAIL':'PASS';
 const redRows=phases.reduce((sum,phase)=>sum+phase.checks.filter(entry=>entry.status==='fail').length,0);
 console.log('gate '+verdict+' · '+checks+' check'+(checks===1?'':'s')+' · '+(failed?failed+' failed':'none failed')+(skipped?' · '+skipped+' skipped':'')+(drift?' · '+drift+' recorded number'+(drift===1?'':'s')+' drifted from the 2026-10-22 measurement':''));
 // The invariant the sentence above depends on, asserted rather than assumed: a red
 // row and a PASS verdict can never be printed by the same run.
 if(redRows&&!failed)throw Error('the gate printed a FAIL row but counted no failure');
 if(failed&&redRows!==failed)throw Error('the gate counted '+failed+' failures and printed '+redRows+' FAIL rows');
 if(failed)console.log('A red check is a finding to read and report, never something to fix by editing this script’s expectations.');
 process.exitCode=failed?1:0;
}

// A thrown phase is a failure too, and it is reported in the same table: the gate ends
// with the phase name and the error rather than a bare stack trace and no summary. A
// refusal that happens before any phase started gets a phase of its own, so it is a
// counted failure and the verdict says FAIL.
try{
 await main();
}catch(error){
 const label=current?current.title+' did not finish':'the gate did not start';
 if(!current){
  begin('start-up','nothing was downloaded or written');
  summarise('refused before anything was downloaded or written');
 }
 fail(label,String(error.message||error));
 finish();
}
