// End-to-end proof of the real launcher: desktop/main.cjs, not a stub harness,
// pointed at a loopback server that publishes a fixture manifest and a chunk
// payload through EASTER_CLIENT_ORIGIN. The game install itself is already
// recorded in the fixture tree, so the flow under test is the client content:
// manifest fetch, chunk diff, download with byte progress, pause, resume, and the
// marker the next run reads.
// Run: xvfb-run -a node tests/desktop/loopback.electron.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-loopback-test-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
let failures=0;
function check(condition,message){if(condition)console.log('  ok   '+message);else{failures++;console.log('  FAIL '+message);}}

// ---- the published fixture --------------------------------------------------
const baseJar=Buffer.from('easter-navy-base-jar');
const graphicsV2=crypto.randomBytes(512*1024);
const graphicsV3=Buffer.from('graphics-v3-'+'z'.repeat(64*1024));
const files={'/files/base.jar':baseJar,'/files/graphics.zip':graphicsV2};
const requests=[];
const server=http.createServer((request,response)=>{
 const name=decodeURIComponent(new URL(request.url,'http://stub').pathname);
 requests.push({path:name,range:request.headers.range||null});
 const body=files[name];
 if(!body){response.writeHead(404);response.end();return;}
 const range=/^bytes=(\d+)-$/.exec(request.headers.range||'');
 const start=range?Number(range[1]):0;
 if(range)response.writeHead(206,{'Content-Length':body.length-start,'Content-Range':'bytes '+start+'-'+(body.length-1)+'/'+body.length});
 else response.writeHead(200,{'Content-Length':body.length});
 let offset=start;
 const timer=setInterval(()=>{
  if(offset>=body.length){clearInterval(timer);response.end();return;}
  response.write(body.subarray(offset,offset+8192));offset+=8192;
 },25);
 response.on('close',()=>clearInterval(timer));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const manifest={
 minecraft:'26.2',fabric:'0.19.5',
 mod:{name:'Easter Co. client',version:'2.0.0',sha256:sha256(baseJar),url:'downloads/easter-navy.jar'},
 dependencies:[{id:'fabric-api',name:'Fabric API',version:'0.161.0+26.2'}],
 chunks:[
  {id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(baseJar),files:[{id:'easter-navy',name:'Easter Co. client',version:'2.0.0',path:'mods/easter-navy.jar',url:'files/base.jar',hash:'sha256:'+sha256(baseJar),size:baseJar.length}]},
  {id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphicsV2),files:[{id:'graphics',name:'Enhanced graphics',version:'1.0.0',path:'shaderpacks/graphics.zip',url:'files/graphics.zip',hash:'sha256:'+sha256(graphicsV2),size:graphicsV2.length}]}
 ]
};
files['/data/client.json']=Buffer.from(JSON.stringify(manifest));

// ---- the fixture tree the launcher is pointed at ----------------------------
const clientRoot=path.join(temp,'my-client');
const java=path.join(temp,'java');
const fabricVersion='26.2-fabric0.19.5';
await fs.writeFile(java,'#!/bin/sh\n');
await fs.mkdir(path.join(clientRoot,'versions',fabricVersion),{recursive:true});
await fs.writeFile(path.join(clientRoot,'versions',fabricVersion,fabricVersion+'.json'),'{}');
await fs.mkdir(path.join(clientRoot,'mods'),{recursive:true});
await fs.writeFile(path.join(clientRoot,'mods','easter-navy.jar'),baseJar);
await fs.mkdir(path.join(clientRoot,'shaderpacks'),{recursive:true});
await fs.writeFile(path.join(clientRoot,'shaderpacks','graphics.zip'),graphicsV2);
await fs.writeFile(path.join(clientRoot,'.easter-client'),'');
await fs.writeFile(path.join(clientRoot,'installed.json'),JSON.stringify({
 version:fabricVersion,minecraft:'26.2',fabric:'0.19.5',java,
 game:{minecraft:'26.2',fabric:'0.19.5',verified:true},
 chunks:{
  base:{id:'base',version:manifest.chunks[0].version,immutable:true,files:['mods/easter-navy.jar'],verified:true},
  graphics:{id:'graphics',version:manifest.chunks[1].version,immutable:false,files:['shaderpacks/graphics.zip'],verified:true}
 },
 files:['mods/easter-navy.jar','shaderpacks/graphics.zip'],includeGraphics:true,updatedAt:'2026-10-15T00:00:00.000Z'
}));
await fs.writeFile(path.join(temp,'settings.json'),JSON.stringify({memoryMB:4096,server:'',javaPath:'',location:clientRoot,includeGraphics:true}));

const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'desktop/main.cjs')],env:{...process.env,EASTER_TEST_HOME:temp,EASTER_CLIENT_ORIGIN:origin}});
const marker=async()=>JSON.parse(await fs.readFile(path.join(clientRoot,'installed.json'),'utf8'));
try{
 const page=await app.firstWindow();
 page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await app.evaluate(({BrowserWindow})=>{
  const win=BrowserWindow.getAllWindows()[0];
  global.__states=[];global.__mark=0;
  const send=win.webContents.send.bind(win.webContents);
  win.webContents.send=(channel,...args)=>{if(channel==='launcher:state')global.__states.push(JSON.parse(JSON.stringify(args[0])));return send(channel,...args);};
 });
 const since=async()=>app.evaluate(()=>global.__states.slice(global.__mark));
 const latest=async()=>app.evaluate(()=>global.__states[global.__states.length-1]||null);
 const mark=()=>app.evaluate(()=>{global.__mark=global.__states.length;});
 const waitFor=async(predicate,label)=>{
  for(let attempt=0;attempt<400;attempt++){
   const hit=(await since()).find(predicate);
   if(hit)return hit;
   await sleep(25);
  }
  throw Error('timed out waiting for '+label+'; last state '+JSON.stringify(await latest()));
 };

 console.log('\n1. the real app starts against the loopback origin and its chosen location');
 await sleep(2000);
 const started=await page.evaluate(()=>window.easterDesktop.status());
 check(started.install.installed===true,'the fixture client tree is recognised as installed');
 check(path.resolve(started.install.location)===path.resolve(clientRoot),'the chosen installation location is the one in use: '+started.install.location);
 check(started.install.includeGraphics===true,'the persisted enhanced graphics toggle is reported');
 check(started.phase==='ready'&&started.progress===null,'the launch update check found nothing and stayed quiet');
 check(started.canPlay===false,'an installed client with no account is not playable');
 // The renderer also pulls map data through the same origin; no client content is fetched.
 check(requests.every(entry=>entry.path.startsWith('/data/')),'the launch check fetched no client content: '+JSON.stringify(requests.map(r=>r.path)));

 console.log('\n2. publishing a new graphics chunk and applying it through the real pipeline');
 files['/data/client.json']=Buffer.from(JSON.stringify({...manifest,chunks:[manifest.chunks[0],{...manifest.chunks[1],version:'sha256:'+sha256(graphicsV3),files:[{...manifest.chunks[1].files[0],hash:'sha256:'+sha256(graphicsV3),size:graphicsV3.length}]}]}));
 files['/files/graphics.zip']=graphicsV3;
 requests.length=0;
 await mark();
 await page.evaluate(()=>{window.__check=window.easterDesktop.checkUpdates().then(()=> 'done',error=>'error: '+error.message);});
 const downloading=await waitFor(state=>state.progress&&(state.progress.bytesDone||0)>0,'the update to report progress');
 check(await page.evaluate(()=>window.__check)==='done','the update completed');
 check(downloading.phase==='updating','an update reports the updating phase');
 check(typeof downloading.progress.bytesTotal==='number'&&downloading.progress.bytesTotal===graphicsV3.length,'the chunk size the manifest declares is the progress total: '+downloading.progress.bytesTotal);
 check(downloading.progress.bytesDone>0&&downloading.progress.bytesDone<=graphicsV3.length,'progress carries the bytes actually fetched: '+downloading.progress.bytesDone);
 check(requests.length>0&&requests.every(entry=>entry.path==='/data/client.json'||entry.path==='/files/graphics.zip'),'only the changed chunk was fetched: '+JSON.stringify(requests.map(r=>r.path)));
 check(requests.filter(entry=>entry.path==='/files/base.jar').length===0,'the unchanged base chunk was not fetched');
 check(sha256(await fs.readFile(path.join(clientRoot,'shaderpacks','graphics.zip')))===sha256(graphicsV3),'the new chunk file matches its published checksum');
 check((await marker()).chunks.graphics.version==='sha256:'+sha256(graphicsV3),'the marker records the installed chunk version');
 check((await marker()).chunks.base.version===manifest.chunks[0].version,'the base chunk record is untouched');
 check(sha256(await fs.readFile(path.join(clientRoot,'mods','easter-navy.jar')))===sha256(baseJar),'the base chunk file is untouched');
 const ready=await latest();
 check(ready.phase==='ready'&&ready.install.installed===true,'the launcher settles back to ready');
 check(ready.actions.length===1&&ready.actions[0]==='signin','the only remaining requirement is the sign-in');

 console.log('\n3. pausing and resuming that transfer in the running app');
 files['/data/client.json']=Buffer.from(JSON.stringify({...manifest,chunks:[manifest.chunks[0],{...manifest.chunks[1],version:'sha256:'+sha256(graphicsV2),files:[{...manifest.chunks[1].files[0],hash:'sha256:'+sha256(graphicsV2),size:graphicsV2.length}]}]}));
 files['/files/graphics.zip']=graphicsV2;
 requests.length=0;
 await mark();
 await page.evaluate(()=>{window.__check2=window.easterDesktop.checkUpdates().then(()=> 'done',error=>'error: '+error.message);});
 const moving=await waitFor(state=>state.progress&&(state.progress.bytesDone||0)>0,'the download to start');
 await page.evaluate(()=>window.easterDesktop.pauseInstall());
 const paused=await waitFor(state=>state.paused===true,'the paused state');
 check(paused.phase==='paused','a paused transfer reports the paused phase');
 await sleep(400);
 const frozenAt=(await latest()).progress.bytesDone;
 const reports=(await since()).length;
 await sleep(700);
 check((await latest()).progress.bytesDone===frozenAt,'bytesDone does not advance while paused ('+frozenAt+' bytes)');
 check((await since()).length===reports,'a paused transfer reports no progress at all');
 await page.evaluate(()=>window.easterDesktop.resumeInstall());
 const resumed=await waitFor(state=>state.paused===false&&state.progress&&state.progress.bytesDone>frozenAt,'the resumed state');
 check(resumed.progress.bytesDone>frozenAt,'bytesDone advances after resume ('+frozenAt+' -> '+resumed.progress.bytesDone+')');
 check(await page.evaluate(()=>window.__check2)==='done','the resumed update completed');
 check(sha256(await fs.readFile(path.join(clientRoot,'shaderpacks','graphics.zip')))===sha256(graphicsV2),'the resumed file matches its checksum');
 check((await marker()).chunks.graphics.version==='sha256:'+sha256(graphicsV2),'the marker records the resumed chunk version');
 check(moving.progress.bytesTotal===graphicsV2.length,'the transfer knew its total from the manifest');

 console.log('\n4. the state the running app broadcasts');
 console.log(JSON.stringify({final:await latest()},null,1));
 console.log(failures===0?'\nLOOPBACK PASS: the real launcher fetched a fixture manifest from an overridden client origin, applied only the changed chunk, reported byte progress, paused and resumed that transfer, and recorded what it installed':'\nLOOPBACK FAIL: '+failures+' check(s) failed');
 process.exitCode=failures===0?0:1;
}finally{
 await app.close();
 server.close();
 await fs.rm(temp,{recursive:true,force:true});
}
