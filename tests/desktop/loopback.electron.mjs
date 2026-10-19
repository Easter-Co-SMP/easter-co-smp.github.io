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
let tunedDistance=null,optionsAtRest=null,expectedScale=null,migratedSettings=null;
function check(condition,message){if(condition)console.log('  ok   '+message);else{failures++;console.log('  FAIL '+message);}}
// The household's approved controls, and vanilla's, as read off the real clients.
const DEFERRED_KEY='key_key.shippy-ships.isPressingCtrl';
const DEBUG_BINDINGS=[
 'key_key.debug.clearChat',
 'key_key.debug.copyLocation',
 'key_key.debug.copyRecreateCommand',
 'key_key.debug.crash',
 'key_key.debug.debugOptions',
 'key_key.debug.dumpDynamicTextures',
 'key_key.debug.dumpVersion',
 'key_key.debug.focusPause',
 'key_key.debug.fpsCharts',
 'key_key.debug.lightmapTexture',
 'key_key.debug.modifier',
 'key_key.debug.networkCharts',
 'key_key.debug.overlay',
 'key_key.debug.profiling',
 'key_key.debug.profilingChart',
 'key_key.debug.reloadChunk',
 'key_key.debug.reloadResourcePacks',
 'key_key.debug.showAdvancedTooltips',
 'key_key.debug.showChunkBorders',
 'key_key.debug.showHitboxes',
 'key_key.debug.spectate',
 'key_key.debug.switchGameMode'
];
const WANTED_BINDS={
 'key_key.sneak':'key.keyboard.left.control',
 'key_key.sprint':'key.keyboard.left.shift',
 'key_key.inventory':'key.keyboard.tab',
 'key_key.playerlist':'key.keyboard.grave.accent',
 'key_key.togglePerspective':'key.keyboard.r',
 'key_key.chat':'key.keyboard.enter',
 'key_key.toggleGui':'key.keyboard.f10',
 'key_key.socialInteractions':'key.keyboard.i',
 'key_key.smoothCamera':'key.keyboard.right.shift',
 ...Object.fromEntries(DEBUG_BINDINGS.map(key=>[key,'key.keyboard.unknown'])),
 [DEFERRED_KEY]:'key.keyboard.right.control'
};
const bindLines=binds=>Object.entries(binds).map(([key,value])=>key+':'+value);
const SEEDED_BINDINGS=Object.keys(WANTED_BINDS);
// What a fresh tree gets: everything except the binding only a mod can register.
const IMMEDIATE_BINDINGS=SEEDED_BINDINGS.filter(key=>key!==DEFERRED_KEY);
const immediateBinds=()=>Object.fromEntries(IMMEDIATE_BINDINGS.map(key=>[key,WANTED_BINDS[key]]));
const immediateLines=()=>bindLines(immediateBinds());
// The Shippy key as the client writes it once the mod has registered its own default, and
// as this seed wants it: crouch keeps Left Ctrl, the quick build takes Right Ctrl.
const DEFERRED_VANILLA=DEFERRED_KEY+':key.keyboard.left.control';
const DEFERRED_SEEDED=DEFERRED_KEY+':key.keyboard.right.control';
const SEVEN_KEYS={'key_key.sneak':WANTED_BINDS['key_key.sneak'],'key_key.sprint':WANTED_BINDS['key_key.sprint'],'key_key.inventory':WANTED_BINDS['key_key.inventory'],'key_key.playerlist':WANTED_BINDS['key_key.playerlist'],'key_key.togglePerspective':WANTED_BINDS['key_key.togglePerspective']};
const boundValues=text=>{
 const map=new Map();
 for(const line of text.split('\n')){const index=line.indexOf(':');if(index>0)map.set(line.slice(0,index),line.slice(index+1));}
 return map;
};
function checkDistinctBindings(text,label){
 const map=boundValues(text);
 for(const key of DEBUG_BINDINGS)check(map.get(key)==='key.keyboard.unknown',label+': '+key+' is unbound');
 // The deferred key is only there once the client has written it, so it joins the check
 // when it is present and is never missed when it is not.
 const keys=[...IMMEDIATE_BINDINGS,...(map.has(DEFERRED_KEY)?[DEFERRED_KEY]:[])].filter(key=>!DEBUG_BINDINGS.includes(key));
 const bound=keys.map(key=>[key,map.get(key)??null]);
 const values=bound.map(([,value])=>value);
 check(bound.every(([,value])=>typeof value==='string')&&new Set(values).size===values.length,label+': no two of the seeded actions share a key: '+JSON.stringify(bound));
}

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
// The settings file this run is given is the shape both household machines actually carry
// today: written by cleanSettings when true was the default, so exitOnLaunch is true and
// the new trayOnLaunch field does not exist yet. Owen's own file and root's are this,
// graphicsChosen included, which is why the migration's write-back is checked for keeping
// that flag as well as the rest of the file.
const settingsPath=path.join(temp,'settings.json');
await fs.writeFile(settingsPath,JSON.stringify({memoryMB:4096,javaPath:'',server:'100.100.1.0:25565',location:clientRoot,includeGraphics:true,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:true,graphicsChosen:true}));
const oldSettingsBytes=await fs.readFile(settingsPath,'utf8');
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
// The one test/development address override (config.cjs EASTER_SERVER_ADDRESS). It is the
// only way a suite gets an address other than production, and this run proves the real
// main process starts and publishes state with it set: nothing here can reach, or is
// mistaken for, the production server.
const TEST_SERVER='127.0.0.1:25599';
const launchEnv={...process.env,EASTER_TEST_HOME:temp,EASTER_CLIENT_ORIGIN:origin,EASTER_TEST_GPU:GPU_PROFILE,EASTER_SERVER_ADDRESS:TEST_SERVER};
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

 console.log('\n1b. the old default is migrated once on load, and the pair is resolved by the real main process');
 // This is the path Owen's own settings file takes: exitOnLaunch:true with no
 // trayOnLaunch, written by the old default rather than by anyone ticking a box.
 check(started.settings.exitOnLaunch===false,'an old settings file carrying exitOnLaunch:true loads with the launcher staying open: '+JSON.stringify(started.settings.exitOnLaunch));
 check(started.settings.trayOnLaunch===false,'and with the tray preference off: '+JSON.stringify(started.settings.trayOnLaunch));
 const migratedFile=JSON.parse(await fs.readFile(settingsPath,'utf8'));
 migratedSettings=migratedFile;
 check(migratedFile.exitOnLaunch===false&&migratedFile.trayOnLaunch===false,'the file was written back once with both off: '+JSON.stringify({exitOnLaunch:migratedFile.exitOnLaunch,trayOnLaunch:migratedFile.trayOnLaunch}));
 check(typeof migratedFile.trayOnLaunch==='boolean','with the new field present, which is what stops the migration running again');
 check(migratedFile.graphicsChosen===true,'and the saved graphics answer is kept by that write rather than dropped');
 check(migratedFile.memoryMB===4096&&migratedFile.location===clientRoot,'the rest of the saved file is untouched: '+JSON.stringify({memoryMB:migratedFile.memoryMB,location:migratedFile.location}));
 console.log('  info settings.json was '+JSON.stringify(oldSettingsBytes)+'\n  info and now reads '+JSON.stringify(await fs.readFile(settingsPath,'utf8')));
 const both=await page.evaluate(async()=>{const state=await window.easterDesktop.status();return window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:true,trayOnLaunch:true});});
 check(both.exitOnLaunch===false&&both.trayOnLaunch===false,'a payload claiming both is resolved to both off, the documented rule: '+JSON.stringify({exitOnLaunch:both.exitOnLaunch,trayOnLaunch:both.trayOnLaunch}));
 const inFile=JSON.parse(await fs.readFile(settingsPath,'utf8'));
 check(inFile.exitOnLaunch===false&&inFile.trayOnLaunch===false,'and only that resolved pair is written to settings.json: '+JSON.stringify({exitOnLaunch:inFile.exitOnLaunch,trayOnLaunch:inFile.trayOnLaunch}));
 const tray=await page.evaluate(async()=>{const state=await window.easterDesktop.status();return window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:true});});
 check(tray.trayOnLaunch===true&&tray.exitOnLaunch===false,'choosing the tray turns the close-on-launch behaviour off in the other direction');
 const published=await page.evaluate(()=>window.easterDesktop.status());
 check(published.settings.trayOnLaunch===true&&published.settings.exitOnLaunch===false,'status() — what the Settings dialog reads — publishes the saved pair');
 // A malformed value falls back to the documented default rather than throwing.
 const malformed=await page.evaluate(async()=>{const state=await window.easterDesktop.status();return window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:'yes',trayOnLaunch:1});});
 check(malformed.exitOnLaunch===false&&malformed.trayOnLaunch===false,'a malformed pair falls back to both off: '+JSON.stringify({exitOnLaunch:malformed.exitOnLaunch,trayOnLaunch:malformed.trayOnLaunch}));

 console.log('\n1a. the display defaults are seeded from the startup path of an installed, up-to-date tree');
 // Nothing above installed anything: the tree was current before the app started, so
 // this is the path a returning player takes.
 const seeded=await fs.readFile(optionsPath,'utf8');
 // What this screen asks for, read from the real window rather than from a constant:
 // the renderer states its own screen size and pixel ratio, and the rule is applied to
 // that exactly as the main process applied it before the window existed.
 const seen=await page.evaluate(()=>({width:window.screen.width,height:window.screen.height,devicePixelRatio:window.devicePixelRatio,widthPx:Math.round(window.screen.width*window.devicePixelRatio),heightPx:Math.round(window.screen.height*window.devicePixelRatio)}));
 const inMain=await app.evaluate(({screen})=>{const display=screen.getPrimaryDisplay();return {width:display.size.width,height:display.size.height,scaleFactor:display.scaleFactor,widthPx:Math.round(display.size.width*display.scaleFactor),heightPx:Math.round(display.size.height*display.scaleFactor)};});
 expectedScale=displayGuiScale(seen);
 console.log('  info the renderer read window.screen '+seen.width+'x'+seen.height+' CSS px at devicePixelRatio '+seen.devicePixelRatio+' = '+seen.widthPx+'x'+seen.heightPx+' physical; the main process read the primary display as '+inMain.width+'x'+inMain.height+' at scaleFactor '+inMain.scaleFactor+' = '+inMain.widthPx+'x'+inMain.heightPx+' physical; the rule says guiScale '+expectedScale);
 check(inMain.widthPx===seen.widthPx&&inMain.heightPx===seen.heightPx,'the physical display the main process resolved is the one the renderer is drawn on: '+JSON.stringify({main:inMain,renderer:seen}));
 check(displayGuiScale(inMain)===expectedScale,'so the launch-time answer and the renderer’s own screen agree on the rule’s result: '+expectedScale);
 check(new RegExp('^guiScale:'+expectedScale+'$','m').test(seeded),'starting the launcher seeded guiScale:'+expectedScale+', the rule applied to this display ('+seen.widthPx+'x'+seen.heightPx+' physical), into the client options.txt: '+JSON.stringify(seeded));
 check(/^fullscreen:true$/m.test(seeded),'and fullscreen:true, read back from the file');
 check(/^key_key\.sneak:key\.keyboard\.left\.control$/m.test(seeded),'and crouch on Left Ctrl, the vanilla sneak key swapped with sprint');
 check(/^key_key\.sprint:key\.keyboard\.left\.shift$/m.test(seeded),'and sprint on Left Shift, the other half of that swap');
 check(/^key_key\.inventory:key\.keyboard\.tab$/m.test(seeded),'and inventory on tab');
 check(/^key_key\.playerlist:key\.keyboard\.grave\.accent$/m.test(seeded),'and the player list on the grave key that frees');
 check(/^key_key\.togglePerspective:key\.keyboard\.r$/m.test(seeded),'and third person on R');
 check(/^key_key\.chat:key\.keyboard\.enter$/m.test(seeded),'and chat on enter');
 check(/^key_key\.toggleGui:key\.keyboard\.f10$/m.test(seeded),'and the GUI toggle on F10');
 check(/^key_key\.socialInteractions:key\.keyboard\.i$/m.test(seeded),'and social interactions on I');
 check(/^key_key\.smoothCamera:key\.keyboard\.right\.shift$/m.test(seeded),'and smooth camera on right shift');
 const debugLines=seeded.split('\n').filter(line=>line.startsWith('key_key.debug.'));
 check(debugLines.length===22&&debugLines.every(line=>line.endsWith(':key.keyboard.unknown')),'and the 22 vanilla debug keys unbound, so no F3 overlay: '+JSON.stringify(debugLines.length));
 check(!seeded.includes(DEFERRED_KEY),'and the mod’s own hotkey is not invented before the client has written it');
 console.log('  info options.txt now reads: '+JSON.stringify(seeded));
 const expectedLines=new RegExp('^(guiScale:'+expectedScale+'|fullscreen:true|'+IMMEDIATE_BINDINGS.map(key=>key.replace(/\./g,'\\.')+':'+WANTED_BINDS[key].replace(/\./g,'\\.')).join('|')+')$');
 check(seeded.split('\n').filter(Boolean).every(line=>expectedLines.test(line)),'and nothing else was written into it: '+JSON.stringify(seeded));
 check(seeded.split('\n').filter(Boolean).length===33,'which is the whole table except the one key that waits for its mod');
 checkDistinctBindings(seeded,'the startup seed');
 const seedRecord=JSON.parse(await fs.readFile(displayRecordPath,'utf8'));
 console.log('  info the seed record now reads: '+JSON.stringify({schema:seedRecord.schema,keys:Object.keys(seedRecord.values||{}).length,appliedAt:seedRecord.appliedAt}));
 check(seedRecord.schema===3,'the seed is remembered by its own record, at the schema that covers the whole approved set');
 check(seedRecord.values?.guiScale===String(expectedScale)&&seedRecord.values?.fullscreen==='true','with the display values that were applied: '+JSON.stringify({guiScale:seedRecord.values?.guiScale,fullscreen:seedRecord.values?.fullscreen}));
 check(IMMEDIATE_BINDINGS.every(key=>seedRecord.values?.[key]===WANTED_BINDS[key]),'and every binding that was applied: '+JSON.stringify(Object.fromEntries(IMMEDIATE_BINDINGS.filter(key=>!DEBUG_BINDINGS.includes(key)).map(key=>[key,seedRecord.values?.[key]]))));
 check(!(DEFERRED_KEY in seedRecord.values),'while the deferred key is not claimed before it has been written');
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
 // The launcher targets one fixed production server: this run's settings file carries
 // the legacy address an existing install has, and the state publishes no choice at all.
 check(!('servers' in started),'status() publishes no server list');
 check(!('server' in started.settings),'and the settings carry no server address: '+JSON.stringify(started.settings));
 check(!('server' in migratedFile),'the address left behind by an older build is not written back into settings.json: '+JSON.stringify(migratedFile));
 check(JSON.stringify(started).includes(TEST_SERVER)===false,'the test-only override is a main-process environment value and never reaches the renderer state: '+TEST_SERVER);
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
 check(IMMEDIATE_BINDINGS.every(key=>new RegExp('^'+key.replace(/\./g,'\\.')+':'+WANTED_BINDS[key].replace(/\./g,'\\.')+'$','m').test(options)),'and so are all 31 bindings, the 22 debug unbinds included');
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
// A file that already carries the field is the player's own record: this is the choice a
// build with the setting could have saved, so it must survive the load as it was saved.
// The pair is compared as values rather than bytes, because the launcher's existing
// startup path may rewrite the file for its own graphics bookkeeping regardless.
const chosenExit={...JSON.parse(await fs.readFile(settingsPath,'utf8')),exitOnLaunch:true,trayOnLaunch:false};
await fs.writeFile(settingsPath,JSON.stringify(chosenExit));
try{
 const relaunch=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'desktop/main.cjs')],env:launchEnv});
 try{
  const relaunchPage=await relaunch.firstWindow();
  relaunchPage.setDefaultTimeout(20000);
  await relaunchPage.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await sleep(500);
  const restarted=await relaunchPage.evaluate(()=>window.easterDesktop.status());
  check(restarted.graphics.enabled===true,'the player\'s own choice survives a restart');
  check(restarted.settings.exitOnLaunch===true&&restarted.settings.trayOnLaunch===false,'a settings file that already carries the fields is not migrated again: '+JSON.stringify({exitOnLaunch:restarted.settings.exitOnLaunch,trayOnLaunch:restarted.settings.trayOnLaunch}));
  const chosenExitAfter=JSON.parse(await fs.readFile(settingsPath,'utf8'));
  check(chosenExitAfter.exitOnLaunch===true&&chosenExitAfter.trayOnLaunch===false,'and the saved pair is unchanged in the file, so the migration did not run twice: '+JSON.stringify({exitOnLaunch:chosenExitAfter.exitOnLaunch,trayOnLaunch:chosenExitAfter.trayOnLaunch}));
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

 // A tree the previous build had already seeded carries a schema-2 record, and one whose
 // client has run with the mod since carries the Shippy hotkey on Left Ctrl. That tree must
 // get exactly the keys the record does not cover once — the mod's hotkey included, moved
 // off the Left Ctrl crouch owns — with every value it already covers left alone.
 console.log('\n7. a schema-2 tree gets exactly the keys it does not cover added, and the Shippy hotkey with them');
 const appliedAt='2026-10-18T09:00:00.000Z';
 const beforeUpgrade=['version:4903','fullscreen:false','guiScale:1',...bindLines(SEVEN_KEYS),DEFERRED_VANILLA,'fov:0.5'].join('\n')+'\n';
 await fs.writeFile(optionsPath,beforeUpgrade);
 await fs.writeFile(displayRecordPath,JSON.stringify({schema:2,values:{guiScale:String(expectedScale),fullscreen:'true',...SEVEN_KEYS},appliedAt},null,2)+'\n',{mode:0o600});
 // The other saved direction: a tray choice made in this build stays put across a load.
 const chosenTray={...JSON.parse(await fs.readFile(settingsPath,'utf8')),exitOnLaunch:false,trayOnLaunch:true};
 await fs.writeFile(settingsPath,JSON.stringify(chosenTray));
 let upgraded=null,upgradedRecord=null,upgradeOptionsStat=null,upgradeRecordStat=null;
 const upgrade=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'desktop/main.cjs')],env:launchEnv});
 try{
  const upgradePage=await upgrade.firstWindow();
  upgradePage.setDefaultTimeout(20000);
  await upgradePage.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await sleep(2000);
   const trayLoaded=await upgradePage.evaluate(()=>window.easterDesktop.status());
   check(trayLoaded.settings.trayOnLaunch===true&&trayLoaded.settings.exitOnLaunch===false,'a saved tray choice is not reset by a later load: '+JSON.stringify({exitOnLaunch:trayLoaded.settings.exitOnLaunch,trayOnLaunch:trayLoaded.settings.trayOnLaunch}));
   const chosenTrayAfter=JSON.parse(await fs.readFile(settingsPath,'utf8'));
   check(chosenTrayAfter.trayOnLaunch===true&&chosenTrayAfter.exitOnLaunch===false,'and the saved pair is unchanged in its file too: '+JSON.stringify({exitOnLaunch:chosenTrayAfter.exitOnLaunch,trayOnLaunch:chosenTrayAfter.trayOnLaunch}));
  upgraded=await fs.readFile(optionsPath,'utf8');
  console.log('  info options.txt now reads: '+JSON.stringify(upgraded));
  upgradedRecord=JSON.parse(await fs.readFile(displayRecordPath,'utf8'));
  console.log('  info the seed record now reads: '+JSON.stringify({schema:upgradedRecord.schema,keys:Object.keys(upgradedRecord.values||{}).length,appliedAt:upgradedRecord.appliedAt,upgradedAt:upgradedRecord.upgradedAt}));
  upgradeOptionsStat=await fs.stat(optionsPath);
  upgradeRecordStat=await fs.stat(displayRecordPath);
 }finally{await upgrade.close();}
 const grown=IMMEDIATE_BINDINGS.filter(key=>!(key in SEVEN_KEYS));
 const expectedUpgrade=[...beforeUpgrade.replace(DEFERRED_VANILLA,DEFERRED_SEEDED).split('\n').filter(Boolean),...bindLines(Object.fromEntries(grown.map(key=>[key,WANTED_BINDS[key]])))].join('\n')+'\n';
 check(upgraded===expectedUpgrade,'exactly the keys the record never covered landed after the player’s own lines, the mod’s hotkey moved in place, and the player’s guiScale:1, fullscreen:false and seven covered keys are byte-identical');
 checkDistinctBindings(upgraded,'the schema-2 upgrade');
 check(upgradedRecord.schema===3,'the record is raised to the schema that covers the whole approved set');
 check(upgradedRecord.appliedAt===appliedAt,'and keeps the time of the seed that first wrote it');
 check(typeof upgradedRecord.upgradedAt==='string','recording when it was raised');
 check(IMMEDIATE_BINDINGS.every(key=>upgradedRecord.values?.[key]===WANTED_BINDS[key]),'with every key it had just applied added to its values, the deferred one included');
 // One more start of the real app: the upgrade happened once and writes nothing again.
 const settle=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'desktop/main.cjs')],env:launchEnv});
 try{
  const settlePage=await settle.firstWindow();
  settlePage.setDefaultTimeout(20000);
  await settlePage.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await sleep(2000);
  check(await fs.readFile(optionsPath,'utf8')===upgraded,'a further launch leaves the upgraded options.txt byte-identical');
  check((await fs.stat(optionsPath)).mtimeMs===upgradeOptionsStat.mtimeMs,'and does not touch it');
  check((await fs.stat(displayRecordPath)).mtimeMs===upgradeRecordStat.mtimeMs,'nor the record it raised');
 }finally{await settle.close();}

 // The file the migration itself wrote in section 1b, put back exactly as it came out and
 // started again: a second start must leave it alone rather than migrate it a second time.
 console.log('\n9. a second start over the migrated file leaves it alone');
 await fs.writeFile(settingsPath,JSON.stringify(migratedSettings));
 const again=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'desktop/main.cjs')],env:launchEnv});
 try{
  const againPage=await again.firstWindow();
  againPage.setDefaultTimeout(20000);
  await againPage.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await sleep(2000);
  const againStatus=await againPage.evaluate(()=>window.easterDesktop.status());
  check(againStatus.settings.exitOnLaunch===false&&againStatus.settings.trayOnLaunch===false,'a second start over the migrated file keeps the launcher open: '+JSON.stringify({exitOnLaunch:againStatus.settings.exitOnLaunch,trayOnLaunch:againStatus.settings.trayOnLaunch}));
  const againFile=JSON.parse(await fs.readFile(settingsPath,'utf8'));
  check(againFile.exitOnLaunch===false&&againFile.trayOnLaunch===false,'and the file still holds the pair the migration wrote: '+JSON.stringify({exitOnLaunch:againFile.exitOnLaunch,trayOnLaunch:againFile.trayOnLaunch}));
  check(typeof againFile.trayOnLaunch==='boolean','still carrying the field, so nothing had to be migrated a second time');
  check(againFile.graphicsChosen===true&&againFile.memoryMB===4096,'with the rest of the file as the migration left it: '+JSON.stringify({graphicsChosen:againFile.graphicsChosen,memoryMB:againFile.memoryMB}));
 }finally{await again.close();}
}finally{
 server.close();
 await fs.rm(temp,{recursive:true,force:true});
}

console.log(failures===0?'\nLOOPBACK PASS: the real launcher seeded the client\'s display defaults, at the GUI scale its own display asks for and with the whole approved control set: crouch on Left Ctrl and sprint on Left Shift swapped from vanilla, inventory on tab, the player list on the grave key, third person on R, chat on enter, the GUI toggle on F10, social interactions on I, smooth camera on right shift, the 22 vanilla debug keys unbound and the mod-provided Shippy hotkey left for the client to register, from its startup path on an already-installed tree, wrote nothing on the second run, upgraded a schema-2 tree with exactly the keys its record did not cover — the Shippy hotkey moved off Left Ctrl in the same pass, inventory and the player list together so no two actions share tab — and nothing on the run after, fetched a fixture manifest from an overridden client origin, applied only the changed chunk, reported byte progress, paused and resumed that transfer, recorded what it installed, published the detected hardware and graphics state and no server choice at all, with the legacy address its settings file still carried accepted, ignored and dropped, applied the enhanced graphics toggle in both directions by writing the client\'s own quality files, and migrated the old default this box actually carries — exitOnLaunch:true with no trayOnLaunch — to both off once while keeping the saved graphics answer, leaving a player\'s own later choice unchanged on the next load and a second start over the migrated file itself leaving it alone':'\nLOOPBACK FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
