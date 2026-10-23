'use strict';
// The identity of a game that has to outlive the launcher that started it.
//
// Owen's design (2026-10-23): "the launcher can update while a game is open, in the background
// and resume that was a big part of my design." An update ends in a relaunch, and the relaunch
// must not take Minecraft with it. Two halves make that possible and they are the two exports
// the rest of the launcher uses:
//
//   * `remember(root, pid)` — written the moment a game is spawned, so the identity exists
//     before anything can restart. Nothing else changes: the client is already detached with no
//     inherited pipes (desktop/install.cjs `execOptions`), so the launcher's exit neither kills
//     it nor leaves a pipe behind for someone to service.
//   * `adopt(root)` — read at startup, so the new instance knows a game it did not start is
//     still playing and publishes the in-game state instead of offering Play.
//
// **A pid is not an identity.** Pids are reused, and "pid 4711 exists" is true of an unrelated
// browser an hour later. So the record carries the process's own start marker — the kernel's
// `starttime` for that pid on Linux, the process's creation time elsewhere — and it matches only
// when the process at that pid started at exactly that moment. A marker that does not match is a
// game that has ended: it is removed and the launcher starts in its ordinary state, never on a
// dead screen.
//
// **What this deliberately does not do.** It does not watch the game, kill it, or claim to know
// why it ended: the launcher owns the client only as far as "it is playing", which is the same
// claim the state's `running` phase makes. main.cjs watches liveness; this file only answers what
// the marker means.
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
const MARKER_FILE='running-game.json';
// A process question that takes longer than this is answered "unknown", which `adopt` treats as
// "not the game": coming back to a launcher that guesses wrong is worse than coming back to the
// ordinary state. `ps` and PowerShell both answer in tens of milliseconds in practice.
const PROBE_TIMEOUT_MS=4000;
function markerFile(root){return path.join(root,MARKER_FILE);}
// /proc/<pid>/stat, whose second field is the command name in parentheses and may itself contain
// spaces and parentheses. Everything after the last ')' is space-separated from field 3 on, so
// the kernel's `starttime` (field 22) is at index 19 of that tail.
function linuxStart(stat){
 const text=String(stat||''),tail=text.slice(text.lastIndexOf(')')+1).trim().split(/\s+/);
 const value=tail[19];
 return /^\d+$/.test(value||'')?value:null;
}
// The start marker of a live process, or null when there is no such process (or the platform
// cannot be asked). Injected reads and an injected exec keep this testable without a spawn.
async function startMark(pid,{platform=process.platform,readFile=fs.promises.readFile,exec=execFile,timeoutMs=PROBE_TIMEOUT_MS}={}){
 const id=Number(pid);
 if(!Number.isSafeInteger(id)||id<=0)return null;
 if(platform==='linux'){
  try{return linuxStart(await readFile('/proc/'+id+'/stat','utf8'));}catch{return null;}
 }
 if(platform==='darwin'){
  try{const out=await run(exec,'ps',['-o','lstart=','-p',String(id)],timeoutMs);const value=String(out||'').trim();return value||null;}catch{return null;}
 }
 if(platform==='win32'){
  // PowerShell rather than wmic: wmic is deprecated and absent from some Windows 11 images,
  // while PowerShell is present on every supported Windows. The value is the creation time in
  // UTC round-trip form, which is stable for the life of the process.
  try{
   const out=await run(exec,'powershell',['-NoProfile','-NonInteractive','-Command','(Get-Process -Id '+id+').StartTime.ToUniversalTime().ToString("o")'],timeoutMs);
   const value=String(out||'').trim();
   return value||null;
  }catch{return null;}
 }
 return null;
}
function run(exec,command,args,timeoutMs){
 return new Promise((resolve,reject)=>{
  exec(command,args,{timeout:timeoutMs,windowsHide:true},(error,stdout)=>error?reject(error):resolve(stdout));
 });
}
// The record the launcher writes and reads: the pid, the start marker that makes the pid mean
// something, and when the launcher started it (for the log, never for a decision). Nothing here
// is a path, a session or anything about the player: the marker is about a process.
function record(pid,start,{startedAt=new Date().toISOString()}={}){
 const id=Number(pid);
 if(!Number.isSafeInteger(id)||id<=0||typeof start!=='string'||!start)return null;
 return {pid:id,start,startedAt};
}
function valid(value){
 return Boolean(value)&&typeof value==='object'&&Number.isSafeInteger(value.pid)&&value.pid>0&&typeof value.start==='string'&&value.start.length>0&&value.start.length<=128;
}
function remember(root,pid,options={}){
 return startMark(pid,options).then(start=>{
  const entry=record(pid,start,options);
  if(!entry)return null;
  const file=markerFile(root),temp=file+'.'+process.pid+'.tmp';
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(temp,JSON.stringify(entry),{mode:0o600});
  fs.renameSync(temp,file);
  return entry;
 });
}
function read(root){
 try{
  const value=JSON.parse(fs.readFileSync(markerFile(root),'utf8'));
  return valid(value)?value:null;
 }catch{return null;}
}
function forget(root){
 try{fs.rmSync(markerFile(root),{force:true});return true;}catch{return false;}
}
// Whether the process a marker names is the process the launcher started. Both halves matter:
// the pid has to exist (startMark reads its own start time) and it has to report the same start
// marker, so a recycled pid is refused.
async function stillRunning(value,options={}){
 if(!valid(value))return false;
 return await startMark(value.pid,options)===value.start;
}
// What the launcher asks at startup. `{game}` when the record names a live game that started at
// the recorded moment; null otherwise, with the marker removed, because a marker that cannot be
// believed is not a state the launcher may publish.
async function adopt(root,options={}){
 const value=read(root);
 if(!value)return null;
 if(await stillRunning(value,options))return {game:value};
 forget(root);
 return null;
}
module.exports={MARKER_FILE,PROBE_TIMEOUT_MS,markerFile,linuxStart,startMark,record,read,remember,forget,stillRunning,adopt};
