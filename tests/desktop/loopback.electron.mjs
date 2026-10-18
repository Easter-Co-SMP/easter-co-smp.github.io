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
import {createRequire} from 'node:module';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd();
// The guiScale rule itself, so the value the launcher writes is compared with the rule
// applied to this display instead of with a constant that would pass on any screen.
const {displayGuiScale}=createRequire(import.meta.url)(path.join(root,'desktop','hardware.cjs'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-loopback-test-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
let failures=0;
let tunedDistance=null,optionsAtRest=null;
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
// The display-default seam: the tree is installed and current before the app starts,
// which is the state a returning player is in. options.txt does not exist yet, and the
// install marker is copied byte for byte so a settings write can be shown not to have
// rewritten it.
const optionsPath=path.join(clientRoot,'options.txt');
const displayRecordPath=path.join(clientRoot,'.easter-client-display');
const installedBefore=await fs.readFile(path.join(clientRoot,'installed.json'),'utf8');

// The graphics profile this run is told to assume: the discrete card the ticket's
// real run found on this machine, so the quality settings the toggle writes are the
// ones a capable adapter gets. The launcher reads it only in an unpackaged test run.
const GPU_PROFILE=JSON.stringify({
 gpu:null,vendor:null,vramMB:null,tier:'capable',
 reason:'NVIDIA GPU NVIDIA GeForce RTX 4060 with 8188 MB of video memory.',
 source:'nvidia-smi',software:false,recommended:true,tunable:true,
 adapters:[{name:'NVIDIA Corporation AD107 [GeForce RTX 4060]',vendorId:'10de',deviceId:'2882',vramMB:8188,busId:'03:00.0',source:'lspci'}]
});
const launchEnv={...process.env,EASTER_TEST_HOME:temp,EASTER_CLIENT_ORIGIN:origin,EASTER_TEST_GPU:GPU_PROFILE};
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'desktop/main.cjs')],env:launchEnv});
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

 console.log('\n1a. the display defaults are seeded from the startup path of an installed, up-to-date tree');
 // Nothing above installed anything: the tree was current before the app started, so
 // this is the path a returning player takes.
 const seeded=await fs.readFile(optionsPath,'utf8');
 // What this screen asks for, read from the real window rather than from a constant:
 // the renderer states its own screen size and pixel ratio, and the rule is applied to
 // that exactly as the main process applied it before the window existed.
 const seen=await page.evaluate(()=>({width:window.screen.width,height:window.screen.height,devicePixelRatio:window.devicePixelRatio,widthPx:Math.round(window.screen.width*window.devicePixelRatio),heightPx:Math.round(window.screen.height*window.devicePixelRatio)}));
 const inMain=await app.evaluate(({screen})=>{const display=screen.getPrimaryDisplay();return {width:display.size.width,height:display.size.height,scaleFactor:display.scaleFactor,widthPx:Math.round(display.size.width*display.scaleFactor),heightPx:Math.round(display.size.height*display.scaleFactor)};});
 const expectedScale=displayGuiScale(seen);
 console.log('  info the renderer read window.screen '+seen.width+'x'+seen.height+' CSS px at devicePixelRatio '+seen.devicePixelRatio+' = '+seen.widthPx+'x'+seen.heightPx+' physical; the main process read the primary display as '+inMain.width+'x'+inMain.height+' at scaleFactor '+inMain.scaleFactor+' = '+inMain.widthPx+'x'+inMain.heightPx+' physical; the rule says guiScale '+expectedScale);
 check(inMain.widthPx===seen.widthPx&&inMain.heightPx===seen.heightPx,'the physical display the main process resolved is the one the renderer is drawn on: '+JSON.stringify({main:inMain,renderer:seen}));
 check(displayGuiScale(inMain)===expectedScale,'so the launch-time answer and the renderer’s own screen agree on the rule’s result: '+expectedScale);
 check(new RegExp('^guiScale:'+expectedScale+'$','m').test(seeded),'starting the launcher seeded guiScale:'+expectedScale+', the rule applied to this display ('+seen.widthPx+'x'+seen.heightPx+' physical), into the client options.txt: '+JSON.stringify(seeded));
 check(/^fullscreen:true$/m.test(seeded),'and fullscreen:true, read back from the file');
 const expectedLines=new RegExp('^(guiScale:'+expectedScale+'|fullscreen:true)$');
 check(seeded.split('\n').filter(Boolean).every(line=>expectedLines.test(line)),'and nothing else was written into it: '+JSON.stringify(seeded));
 const seedRecord=JSON.parse(await fs.readFile(displayRecordPath,'utf8'));
 check(seedRecord.schema===1&&seedRecord.values?.guiScale===String(expectedScale)&&seedRecord.values?.fullscreen==='true','the seed is remembered by its own record in the tree, with the value that was applied: '+JSON.stringify(seedRecord));
 check(await fs.readFile(path.join(clientRoot,'installed.json'),'utf8')===installedBefore,'the install marker is byte-identical: the seed did not create or race it');
 check(await fs.stat(path.join(clientRoot,'config','iris.properties')).then(()=>'present',()=>'absent')==='absent','the seed is not the graphics step: no iris.properties was written');
 check(requests.every(entry=>entry.path.startsWith('/data/')),'and the seed fetched nothing');

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

 console.log('\n4. the enhanced graphics toggle in the running app');
 const servers=started.servers;
 check(Array.isArray(servers)&&servers.length===3,'status() publishes the server list');
 check(Array.isArray(servers)&&servers.map(entry=>entry.address).join(',')==='100.100.1.0:25565,127.0.0.1:25565,smp.easter.company:25565','the servers are published in display order: '+JSON.stringify((servers||[]).map(entry=>entry.address)));
 check(Array.isArray(servers)&&servers.filter(entry=>entry.pending).length===1&&servers[2].pending===true,'the name without a DNS record is the pending one');
 check(Boolean(started.hardware)&&['capable','weak','unknown'].includes(started.hardware.tier),'status() publishes a detected hardware tier: '+JSON.stringify(started.hardware));
 check(typeof started.hardware?.reason==='string'&&started.hardware.reason.length>0,'with a displayable reason: '+started.hardware?.reason);
 check(Boolean(started.hardware)&&'vramMB' in started.hardware,'vramMB is published, null when the platform will not report it: '+started.hardware?.vramMB);
 check(Boolean(started.graphics)&&'enabled' in started.graphics&&'recommended' in started.graphics&&'tunable' in started.graphics&&'tuned' in started.graphics,'status() publishes the graphics state shape: '+JSON.stringify(started.graphics));
 check(started.graphics.enabled===true,'the player\'s saved toggle is what graphics.enabled reports');
 // The client is installed and the manifest publishes the graphics chunk, so the
 // toggle has real work to do in both directions.
 requests.length=0;
 await mark();
 await page.evaluate(()=>{window.__off=window.easterDesktop.setGraphics(false).then(()=> 'done',error=>'error: '+error.message);});
 check(await page.evaluate(()=>window.__off)==='done','turning enhanced graphics off settles');
 const offState=await latest();
 check(offState.graphics.enabled===false,'the toggle is off in the broadcast state');
 check(requests.every(entry=>!entry.path.startsWith('/files/')),'switching off fetches no client content: '+JSON.stringify(requests.map(entry=>entry.path)));
 check(sha256(await fs.readFile(path.join(clientRoot,'shaderpacks','graphics.zip')))===sha256(graphicsV2),'and removes nothing that was already installed');
 check((await marker()).chunks.graphics.version==='sha256:'+sha256(graphicsV2),'the installed graphics record survives with the toggle off');
 check((await marker()).chunks.base.version===manifest.chunks[0].version,'the base chunk is still the verified one');
 const savedOff=JSON.parse(await fs.readFile(path.join(temp,'settings.json'),'utf8'));
 check(savedOff.includeGraphics===false&&savedOff.graphicsChosen===true,'the choice is persisted as the player\'s own: '+JSON.stringify({includeGraphics:savedOff.includeGraphics,graphicsChosen:savedOff.graphicsChosen}));
 // Turning it back on downloads the payload only when the published chunk differs,
 // and writes the client's own quality settings inside the app-owned tree.
 files['/data/client.json']=Buffer.from(JSON.stringify({...manifest,chunks:[manifest.chunks[0],{...manifest.chunks[1],version:'sha256:'+sha256(graphicsV3),files:[{...manifest.chunks[1].files[0],hash:'sha256:'+sha256(graphicsV3),size:graphicsV3.length}]}]}));
 files['/files/graphics.zip']=graphicsV3;
 requests.length=0;
 await mark();
 await page.evaluate(()=>{window.__on=window.easterDesktop.setGraphics(true).then(()=> 'done',error=>'error: '+error.message);});
 const graphicsProgress=await waitFor(state=>state.progress&&(state.progress.bytesDone||0)>0,'the graphics transfer to report progress');
 check(await page.evaluate(()=>window.__on)==='done','turning enhanced graphics on settles');
 check(requests.every(entry=>entry.path==='/data/client.json'||entry.path==='/files/graphics.zip'),'only the graphics chunk was fetched: '+JSON.stringify(requests.map(entry=>entry.path)));
 check(requests.filter(entry=>entry.path==='/files/base.jar').length===0,'the frozen base chunk was neither fetched nor re-verified');
 check(typeof graphicsProgress.progress.bytesTotal==='number','the sticky bar carried the transfer with a total: '+graphicsProgress.progress.bytesTotal);
 check(graphicsProgress.phase==='updating'||graphicsProgress.phase==='downloading','through the existing pipeline phases: '+graphicsProgress.phase);
 check(sha256(await fs.readFile(path.join(clientRoot,'shaderpacks','graphics.zip')))===sha256(graphicsV3),'the fetched shader chunk matches its published checksum');
 const onState=await latest();
 check(onState.graphics.enabled===true,'the toggle is on in the broadcast state');
 check(onState.graphics.tuned&&typeof onState.graphics.tuned.renderDistance==='number','graphics.tuned reports what was written into the client: '+JSON.stringify(onState.graphics.tuned));
 const options=await fs.readFile(path.join(clientRoot,'options.txt'),'utf8');
 const iris=await fs.readFile(path.join(clientRoot,'config','iris.properties'),'utf8');
 check(/^graphicsMode:(fancy|fast)$/m.test(options),'the client options carry a graphics mode: '+options.trim().split('\n').join(' '));
 check(new RegExp('^renderDistance:'+onState.graphics.tuned.renderDistance+'$','m').test(options),'and the render distance that was reported');
 check(new RegExp('^guiScale:'+expectedScale+'$','m').test(options)&&/^fullscreen:true$/m.test(options),'the display defaults are still there after the graphics write: guiScale:'+expectedScale);
 check(/^enableShaders:true$/m.test(iris),'the shader loader is switched on');
 check(/^shaderPack:ComplementaryUnbound_r5\.9\.3\.zip$/m.test(iris),'and names the pack Owen chose');
 check(onState.graphics.tuned.shaders===true||onState.graphics.tuned.shaders===false,'shaders are reported as written');
 tunedDistance=onState.graphics.tuned.renderDistance;

 console.log('\n5. the state the running app broadcasts');
 console.log(JSON.stringify({final:await latest()},null,1));
 // What the files look like at rest, so the fresh run below can be shown to leave them
 // exactly as they are.
 optionsAtRest={
  bytes:await fs.readFile(optionsPath),
  mtimeMs:(await fs.stat(optionsPath)).mtimeMs,
  recordMtimeMs:(await fs.stat(displayRecordPath)).mtimeMs
 };
}finally{
 await app.close();
}

// A fresh run of the app keeps the player's choice rather than re-deciding it. The
// first instance has to be gone first: the launcher holds a single-instance lock.
console.log('\n6. a fresh run keeps the player\'s own choice');
try{
 const relaunch=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'desktop/main.cjs')],env:launchEnv});
 try{
  const relaunchPage=await relaunch.firstWindow();
  relaunchPage.setDefaultTimeout(20000);
  await relaunchPage.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await sleep(500);
  const restarted=await relaunchPage.evaluate(()=>window.easterDesktop.status());
  check(restarted.graphics.enabled===true,'the player\'s own choice survives a restart');
  check(restarted.install.installed===true,'the client tree is still recognised');
  check(restarted.graphics.tuned&&restarted.graphics.tuned.renderDistance===tunedDistance,'the tuned record is read back from the client: '+JSON.stringify(restarted.graphics.tuned));
  check(restarted.hardware.tier==='capable','and the hardware answer is unchanged: '+JSON.stringify({tier:restarted.hardware.tier,vramMB:restarted.hardware.vramMB}));
  // The second start of the real app finds the seed record and writes nothing at all.
  const optionsAfterRestart=await fs.readFile(optionsPath);
  check(optionsAfterRestart.equals(optionsAtRest.bytes),'a second app run leaves options.txt byte-identical: '+JSON.stringify(optionsAfterRestart.toString('utf8')));
  check((await fs.stat(optionsPath)).mtimeMs===optionsAtRest.mtimeMs,'and does not touch it: mtime unchanged');
  check((await fs.stat(displayRecordPath)).mtimeMs===optionsAtRest.recordMtimeMs,'the seed record is written once, never again');
  check((await marker()).chunks.graphics.version==='sha256:'+sha256(graphicsV3),'and the install marker still records the chunks it had before the restart');
 }finally{await relaunch.close();}
}finally{
 server.close();
 await fs.rm(temp,{recursive:true,force:true});
}

console.log(failures===0?'\nLOOPBACK PASS: the real launcher seeded the client\'s display defaults, at the GUI scale its own display asks for, from its startup path on an already-installed tree and wrote nothing on the second run, fetched a fixture manifest from an overridden client origin, applied only the changed chunk, reported byte progress, paused and resumed that transfer, recorded what it installed, published the detected hardware, servers and graphics state, and applied the enhanced graphics toggle in both directions by writing the client\'s own quality files':'\nLOOPBACK FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
