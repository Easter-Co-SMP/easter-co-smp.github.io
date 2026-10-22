// End-to-end proof of the real launcher: desktop/main.cjs, not a stub harness,
// pointed at a loopback server that publishes a fixture manifest and a chunk
// payload through EASTER_CLIENT_ORIGIN. The game install itself is already
// recorded in the fixture tree, so the flow under test is the client content:
// manifest fetch, chunk diff, download with byte progress, pause, resume, and the
// marker the next run reads.
//
// The graphics chunk is the payload the live manifest really publishes — Iris, Sodium,
// the Complementary shader pack and the cached Grassier Grass jar — clicked through the
// page's own toggle, so the activation desktop/visuals.cjs performs is exercised rather
// than skipped. Only the bytes are fixtures; the inventory, paths and versions come from
// site/data/client.json, which is what the launcher downloads from the public origin.
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
// The rule and the constants the launcher itself matches the published payload with, so
// this journey compares the manifest with the code instead of with a copy of it: the
// guiScale rule applied to this display, the one shader pack name iris.properties may
// carry, and the cache path the managed Grassier Grass jar is activated from.
const {displayGuiScale,SHADER_PACK_NAME}=createRequire(import.meta.url)(path.join(root,'desktop','hardware.cjs'));
const {GRASS_CACHE,GRASS_ACTIVE}=createRequire(import.meta.url)(path.join(root,'desktop','visuals.cjs'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-loopback-test-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const sha512=buffer=>crypto.createHash('sha512').update(buffer).digest('hex');
const exists=async file=>fs.stat(file).then(()=>true,()=>false);
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
// The graphics chunk is not one synthetic file any more. It carries the file set the live
// manifest declares, read from this repository's own copy of it (site/data/client.json is
// what https://easter-co-smp.github.io/data/client.json serves), because a one-file chunk
// skipped the whole activation path: the Iris and Sodium names desktop/visuals.cjs matches
// with its own regexes, the shader pack whose basename has to equal SHADER_PACK_NAME, and
// the optional-mods cache it requires before it will activate mods/easter-grassier-grass.jar.
// Only the bytes, hashes and urls are fixtures; nothing here downloads from Modrinth.
const publishedClient=JSON.parse(await fs.readFile(path.join(root,'site','data','client.json'),'utf8'));
const publishedGraphics=publishedClient.chunks.find(chunk=>chunk.id==='graphics');
// What kind of managed file a path is, by the shapes the launcher's own matches use.
const kindOf=relative=>/^mods\/iris(?:-[^/]*)?\.jar$/.test(relative)?'iris':/^mods\/sodium(?:-[^/]*)?\.jar$/.test(relative)?'sodium':/^shaderpacks\/[^/]+\.zip$/.test(relative)?'shader':relative===GRASS_CACHE?'grass':null;
const publishedPaths=publishedGraphics.files.map(file=>file.path);
const publishedOf=kind=>publishedGraphics.files.find(file=>kindOf(file.path)===kind)||null;
const SHADER_PATH=publishedOf('shader')?.path,IRIS_PATH=publishedOf('iris')?.path,SODIUM_PATH=publishedOf('sodium')?.path,GRASS_PATH=publishedOf('grass')?.path;
// The release before the one the manifest declares, and one after it. A managed jar that
// changes its name between versions is what the retirement rule exists for, so the fixture
// publishes both directions: an older Iris the tree already has, a newer Sodium an update
// brings.
const OLD_IRIS='mods/iris-fabric-1.11.3+mc26.2.jar';
const NEW_SODIUM='mods/sodium-fabric-0.9.3+mc26.2.jar';
const fixtureBytes=text=>Buffer.from('easter-fixture-'+text);
const files={'/files/base.jar':baseJar};
const requests=[];
// A publisher's file is addressed by its own content, as the CDN's are, so one release
// never overwrites another's bytes and every fetch names exactly what it received.
function publishBytes(bytes){const name=sha256(bytes).slice(0,16);files['/files/'+name]=bytes;return 'files/'+name;}
// Every published field of one file, with fixture bytes in place of the publisher's.
function graphicsFile(relative,bytes){
 const kind=kindOf(relative),source=publishedOf(kind),name=path.posix.basename(relative);
 return {id:source?.id||kind,name:source?.name||name,version:source?.version||'',path:relative,url:publishBytes(bytes),hash:'sha512:'+sha512(bytes),size:bytes.length};
}
// One released graphics chunk: `set` is its [path, bytes] pairs in the manifest's own
// order, and the version is derived from what the release carries.
function graphicsChunk(set){
 const entries=set.map(([relative,bytes])=>graphicsFile(relative,bytes));
 const version='sha256:'+sha256(Buffer.concat(entries.map(entry=>Buffer.from(entry.path+' '+entry.hash))));
 return {id:'graphics',name:publishedGraphics.name,optional:true,immutable:false,version,files:entries};
}
const graphicsRelease=({shader,iris=IRIS_PATH,sodium=SODIUM_PATH})=>graphicsChunk([[SHADER_PATH,shader],[iris,fixtureBytes(path.posix.basename(iris))],[sodium,fixtureBytes(path.posix.basename(sodium))],[GRASS_PATH,fixtureBytes(path.posix.basename(GRASS_PATH))]]);
// V0 is the release this tree already has; V1 is what the toggle installs, V2 an update
// that renames Sodium, V3 the transfer the pause/resume section stops and resumes.
const graphicsV0=graphicsRelease({shader:crypto.randomBytes(96*1024),iris:OLD_IRIS});
const graphicsV1=graphicsRelease({shader:crypto.randomBytes(320*1024)});
const graphicsV2=graphicsRelease({shader:crypto.randomBytes(256*1024),sodium:NEW_SODIUM});
const graphicsV3=graphicsRelease({shader:crypto.randomBytes(512*1024),sodium:NEW_SODIUM});
// The bytes a release publishes for one path, and the url the stub serves them on.
const releaseBytes=(chunk,relative)=>files['/'+chunk.files.find(entry=>entry.path===relative).url];
const releaseUrl=(chunk,relative)=>'/'+chunk.files.find(entry=>entry.path===relative).url;
const chunkSize=chunk=>chunk.files.reduce((sum,entry)=>sum+entry.size,0);
// The one non-client document the launcher reads from its own origin, named here once so
// both "no client content" checks stay about client content (doc/launcher-discovery.md).
const EDITORIAL_PATHS=new Set(['/home.json']);
const isClientRead=entry=>entry.path.startsWith('/data/')||EDITORIAL_PATHS.has(entry.path);
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
  graphicsV0
 ]
};
files['/data/client.json']=Buffer.from(JSON.stringify(manifest));
// The home screen's optional editorial document, published the way the real one is: one
// good dispatch, one carrying a javascript: URL, one duplicate of the first, and one item.
// The bad entry must never reach the renderer, which is what makes this a check of main's
// validation rather than of the fixture's politeness (doc/launcher-discovery.md).
files['/home.json']=Buffer.from(JSON.stringify({
 schema:1,
 posts:[
  {id:'fixture-dispatch',title:'A fixture dispatch',excerpt:'Written for this check.',publishedAt:'2026-10-19T16:00:00Z',url:'https://example.test/dispatch'},
  {id:'fixture-hostile',title:'A hostile link',excerpt:'',publishedAt:'2026-10-19T17:00:00Z',url:'javascript:alert(1)'},
  {id:'fixture-dispatch',title:'A duplicate of the first',excerpt:'',publishedAt:'2026-10-19T18:00:00Z',url:'https://example.test/dispatch-again'}
 ],
 featuredItem:{id:'fixture-item',title:'A fixture item',description:'Preview only.',category:'Cosmetics'}
}));
// What a launcher read may touch on this origin: the generated manifest data, and the one
// hand-written editorial document the home screen's cards come from. That document is not
// client payload — it downloads nothing, installs nothing and never gates Play — so the two
// "no client content" checks below allow it by name rather than by a looser prefix
// (doc/launcher-discovery.md).

// ---- the fixture tree the launcher is pointed at ----------------------------
const clientRoot=path.join(temp,'my-client');
const java=path.join(temp,'java');
const fabricVersion='26.2-fabric0.19.5';
await fs.writeFile(java,'#!/bin/sh\n');
await fs.mkdir(path.join(clientRoot,'versions',fabricVersion),{recursive:true});
await fs.writeFile(path.join(clientRoot,'versions',fabricVersion,fabricVersion+'.json'),'{}');
await fs.mkdir(path.join(clientRoot,'mods'),{recursive:true});
await fs.writeFile(path.join(clientRoot,'mods','easter-navy.jar'),baseJar);
// The graphics release this tree already carries, at the published paths: the previous
// Iris, the declared Sodium, the declared shader pack and the cached Grassier Grass jar.
for(const entry of graphicsV0.files){
 const target=path.join(clientRoot,entry.path);
 await fs.mkdir(path.dirname(target),{recursive:true});
 await fs.writeFile(target,files['/'+entry.url]);
}
// The tree carries that release with enhanced graphics switched off, so the toggle under
// the hero action has both directions to prove and the client has never been tuned.
await fs.writeFile(path.join(clientRoot,'.easter-client'),'');
await fs.writeFile(path.join(clientRoot,'installed.json'),JSON.stringify({
 version:fabricVersion,minecraft:'26.2',fabric:'0.19.5',java,
 game:{minecraft:'26.2',fabric:'0.19.5',verified:true},
 chunks:{
  base:{id:'base',version:manifest.chunks[0].version,immutable:true,files:['mods/easter-navy.jar'],verified:true},
  graphics:{id:'graphics',version:graphicsV0.version,immutable:false,files:graphicsV0.files.map(entry=>entry.path),verified:true}
 },
 files:['mods/easter-navy.jar',...graphicsV0.files.map(entry=>entry.path)],includeGraphics:false,updatedAt:'2026-10-15T00:00:00.000Z'
}));
// The settings file this run is given is the shape both household machines actually carry
// today: written by cleanSettings when true was the default, so exitOnLaunch is true and
// the new trayOnLaunch field does not exist yet. Owen's own file and root's are this,
// graphicsChosen included, which is why the migration's write-back is checked for keeping
// that flag as well as the rest of the file.
const settingsPath=path.join(temp,'settings.json');
await fs.writeFile(settingsPath,JSON.stringify({memoryMB:4096,javaPath:'',server:'100.100.1.0:25565',location:clientRoot,includeGraphics:false,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:true,graphicsChosen:true}));
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
  // The original send is kept under its own name: the graphics section needs to hand the
  // renderer one state the app cannot publish here, and a forged broadcast must not be
  // mistaken for one the app recorded.
  global.__rawSend=send;
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
 check(started.install.includeGraphics===false,'the persisted enhanced graphics toggle is reported: off, which is how this tree carries its graphics chunk');
 check(started.phase==='ready'&&started.progress===null,'the launch update check found nothing and stayed quiet');
 check(started.canPlay===false,'an installed client with no account is not playable');
 // The renderer also pulls map data through the same origin; no client content is fetched.
 check(requests.every(isClientRead),'the launch check fetched no client content (only manifest data and the optional editorial document): '+JSON.stringify(requests.map(r=>r.path)));

 // The home screen's editorial cards, read through the real preload and the real main
 // process: the fixture above is what the launcher would find published with the site. The
 // hostile entry and the duplicate must both be gone, which is main's validation doing the
 // work rather than the renderer's own filter.
 const homeContent=await page.evaluate(()=>window.easterDesktop.homeContent());
 check(homeContent&&homeContent.schema===1,'the editorial document reaches the renderer through the ordinary bridge: '+JSON.stringify(homeContent));
 check(Array.isArray(homeContent.posts)&&homeContent.posts.length===1,'one post survives: the duplicate is collapsed and the hostile one dropped: '+JSON.stringify(homeContent.posts?.map(post=>post.id)));
 check(homeContent.posts?.[0]?.id==='fixture-dispatch','and it is the clean one');
 check(homeContent.featuredItem?.id==='fixture-item','the featured item arrives with its id intact');
 check(Object.keys(homeContent.featuredItem).sort().join()==='category,description,id,title','and with exactly the fields the renderer reads');
 const readsAfterFirst=requests.filter(entry=>entry.path==='/home.json').length;
 await page.evaluate(()=>window.easterDesktop.homeContent());
 check(requests.filter(entry=>entry.path==='/home.json').length===readsAfterFirst,'a second ask inside the cache window reads nothing again');

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
 check(requests.every(isClientRead),'and the seed fetched no client content');

 console.log('\n1c. the one server the launcher targets, and the machine it found');
 // The launcher targets one fixed production server: this run's settings file carries
 // the legacy address an existing install has, and the state publishes no choice at all.
 check(!('servers' in started),'status() publishes no server list');
 check(!('server' in started.settings),'and the settings carry no server address: '+JSON.stringify(started.settings));
 check(!('server' in migratedFile),'the address left behind by an older build is not written back into settings.json: '+JSON.stringify(migratedFile));
 check(JSON.stringify(started).includes(TEST_SERVER)===false,'the test-only override is a main-process environment value and never reaches the renderer state: '+TEST_SERVER);
 check(Boolean(started.hardware)&&['capable','weak','unknown'].includes(started.hardware.tier),'status() publishes a detected hardware tier: '+JSON.stringify(started.hardware));
 check(typeof started.hardware?.reason==='string'&&started.hardware.reason.length>0,'with a displayable reason: '+started.hardware?.reason);
 check(Boolean(started.hardware)&&'vramMB' in started.hardware,'vramMB is published, null when the platform will not report it: '+started.hardware?.vramMB);
 check(started.hardware.tier==='capable'&&started.hardware.tunable===true,'this run is told to assume a capable adapter, so the quality ladder applies: '+JSON.stringify({tier:started.hardware.tier,tunable:started.hardware.tunable}));
 check(Boolean(started.graphics)&&'enabled' in started.graphics&&'recommended' in started.graphics&&'tunable' in started.graphics&&'tuned' in started.graphics,'status() publishes the graphics state shape: '+JSON.stringify(started.graphics));
 check(started.graphics.enabled===false,'the player\'s saved toggle is what graphics.enabled reports');

 console.log('\n2. clicking the real toggle on installs the published graphics chunk and activates it');
 // The premise, read before anything is clicked: the file set and paths the live manifest
 // publishes, compared with the constants the launcher itself matches them by. A published
 // payload that disagreed with any of these would install files the next step refuses to
 // use, and the shader pack it names would never be loaded.
 check(publishedGraphics.files.length===4&&publishedPaths.every(relative=>kindOf(relative)!==null),'the published graphics chunk is the four managed files this journey reproduces: '+JSON.stringify(publishedPaths));
 check(path.posix.basename(SHADER_PATH)===SHADER_PACK_NAME,'and its shader pack carries the one name the launcher writes into iris.properties: '+SHADER_PACK_NAME);
 check(GRASS_PATH===GRASS_CACHE,'its cached Grassier Grass jar sits at the path desktop/visuals.cjs activates from: '+GRASS_CACHE);
 check(GRASS_ACTIVE==='mods/easter-grassier-grass.jar','whose activated copy is the managed jar in mods/: '+GRASS_ACTIVE);
 // The row the player clicks exists at the Play Now stage and nowhere earlier. It is also
 // hidden while nobody is signed in, which is the page's own rule (graphicsOffered in
 // site/desktop.js), so this run states that rule and then hands the renderer the one state
 // it cannot reach here: safeStorage reports basic_text under xvfb, so desktop/main.cjs
 // cannot save or read a session at all.
 check(await page.locator('.hero-graphics').count()===1,'the graphics row exists in the real page');
 check(await page.locator('.hero-graphics').isHidden(),'and stays hidden while no Minecraft session exists, the rule graphicsOffered states: access is '+started.minecraftAccess);
 // Clicking is what this journey proves, so the two bridge calls the section used to make
 // are gone: the change handler below is the page's own, and everything under it is real.
 const forgery=async state=>app.evaluate((_electron,payload)=>global.__rawSend('launcher:state',payload),state);
 const revealGraphics=async()=>{
  const state=(await latest())??(await page.evaluate(()=>window.easterDesktop.status()));
  if(state.minecraftAccess!=='owned'){
   console.log('  info no session can exist in this run, so the renderer is handed the state main published with minecraftAccess:"owned" and nothing else changed; that is the one state the Play Now row appears in, and every effect below it is the real pipeline');
   await forgery({...state,minecraftAccess:'owned'});
  }
  await page.locator('.hero-graphics').waitFor({state:'visible'});
 };
 // One click on the page's own control, then the wait for the real pipeline to finish. The
 // handler disables the switch for the length of the change, so the control's own disabled
 // flag is the completion signal, and a change event that fired is what proves the click
 // reached the page's handler rather than the bridge.
 const clickGraphicsToggle=async wanted=>{
  await revealGraphics();
  const toggle=page.locator('.hero-graphics input[data-graphics-toggle]');
  check(await toggle.isVisible(),'the real toggle is a visible control in the page');
  check((await toggle.isChecked())===!wanted,'and shows the state the launcher reported before the click: '+!wanted);
  await page.evaluate(()=>{
   window.__graphicsClicked=false;
   const input=document.querySelector('.hero-graphics input[data-graphics-toggle]');
   input.addEventListener('change',()=>{window.__graphicsClicked=true;},{once:true,capture:true});
  });
  if(wanted)await toggle.check();else await toggle.uncheck();
  for(let attempt=0;attempt<1600;attempt++){
   const settled=await page.evaluate(()=>{
    const input=document.querySelector('.hero-graphics input[data-graphics-toggle]');
    return Boolean(window.__graphicsClicked)&&Boolean(input)&&!input.disabled;
   });
   if(settled)return latest();
   await sleep(25);
  }
  throw Error('timed out waiting for the graphics click to settle; last state '+JSON.stringify(await latest()));
 };
 // The publish the click picks up: the release the live manifest declares today.
 files['/data/client.json']=Buffer.from(JSON.stringify({...manifest,chunks:[manifest.chunks[0],graphicsV1]}));
 requests.length=0;
 await mark();
 const onState=await clickGraphicsToggle(true);
 // The four files the published chunk declares, on disk with the bytes it published.
 for(const entry of graphicsV1.files){
  const onDisk=await fs.readFile(path.join(clientRoot,entry.path)).then(bytes=>bytes,null);
  check(Boolean(onDisk)&&onDisk.equals(releaseBytes(graphicsV1,entry.path)),'the published file '+entry.path+' is on disk with the bytes the manifest declares ('+entry.size+' bytes)');
 }
 check(JSON.stringify(graphicsV1.files.map(entry=>entry.path))===JSON.stringify(publishedPaths),'and the chunk is exactly the published file set, in its order: '+JSON.stringify(publishedPaths));
 check(requests.some(request=>request.path==='/data/client.json'),'the click read the published manifest: '+JSON.stringify(requests.map(request=>request.path)));
 check(requests.every(request=>request.path==='/data/client.json'||request.path.startsWith('/files/')),'and fetched nothing but graphics chunk files: '+JSON.stringify(requests.map(request=>request.path)));
 check(requests.filter(request=>request.path==='/files/base.jar').length===0,'the frozen base chunk was neither fetched nor re-verified');
 const fetched=graphicsV1.files.map(entry=>releaseUrl(graphicsV1,entry.path)).filter(url=>requests.some(request=>request.path===url));
 check(fetched.includes(releaseUrl(graphicsV1,SHADER_PATH))&&fetched.includes(releaseUrl(graphicsV1,IRIS_PATH)),'the two files whose bytes changed were fetched: '+JSON.stringify(fetched));
 check(!fetched.includes(releaseUrl(graphicsV1,SODIUM_PATH))&&!fetched.includes(releaseUrl(graphicsV1,GRASS_PATH)),'and the two the tree already carried byte for byte were verified rather than downloaded again: '+JSON.stringify([SODIUM_PATH,GRASS_PATH]));
 // The activation desktop/visuals.cjs performs: the cache is copied into a loadable jar,
 // which only happens when the payload it requires is all present and shaders are named.
 const activeGrass=path.join(clientRoot,GRASS_ACTIVE),cachedGrass=path.join(clientRoot,GRASS_PATH);
 const activeBytes=await fs.readFile(activeGrass).then(bytes=>bytes,null);
 check(Boolean(activeBytes),'mods/easter-grassier-grass.jar is activated in mods/');
 check(Boolean(activeBytes)&&activeBytes.equals(await fs.readFile(cachedGrass)),'and is a byte-equal copy of the cached '+GRASS_PATH);
 const irisOn=await fs.readFile(path.join(clientRoot,'config','iris.properties'),'utf8');
 check(/^enableShaders:true$/m.test(irisOn),'iris.properties carries enableShaders:true');
 check(irisOn.includes('shaderPack:'+SHADER_PACK_NAME),'and names the shader pack that is on disk: shaderPack:'+SHADER_PACK_NAME);
 const optionsOn=await fs.readFile(path.join(clientRoot,'options.txt'),'utf8');
 check(onState.graphics.enabled===true,'the broadcast state has the toggle on');
 check(onState.graphics.tuned?.shaders===true,'and graphics.tuned reports shaders:true: '+JSON.stringify(onState.graphics.tuned));
 check(Number.isFinite(onState.graphics.tuned?.renderDistance)&&new RegExp('^renderDistance:'+onState.graphics.tuned.renderDistance+'$','m').test(optionsOn),'options.txt carries the tuned render distance it reports: '+onState.graphics.tuned?.renderDistance);
 check(/^graphicsPreset:"custom"$/m.test(optionsOn)&&/^ao:(true|false)$/m.test(optionsOn),'and the Minecraft 26.2 quality fields: '+optionsOn.trim().split('\n').join(' '));
 check(new RegExp('^guiScale:'+expectedScale+'$','m').test(optionsOn)&&/^fullscreen:true$/m.test(optionsOn),'with the display defaults still in place: guiScale:'+expectedScale);
 check(IMMEDIATE_BINDINGS.every(key=>new RegExp('^'+key.replace(/\./g,'\\.')+':'+WANTED_BINDS[key].replace(/\./g,'\\.')+'$','m').test(optionsOn)),'and all 31 seeded bindings, the 22 debug unbinds included');
 tunedDistance=onState.graphics.tuned.renderDistance;
 const markerOn=await marker();
 check(markerOn.chunks.graphics.version===graphicsV1.version,'the install marker records the graphics chunk version the click installed: '+graphicsV1.version);
 check(JSON.stringify(markerOn.chunks.graphics.files)===JSON.stringify(publishedPaths),'with the published file list: '+JSON.stringify(markerOn.chunks.graphics.files));
 check(markerOn.chunks.base.version===manifest.chunks[0].version,'and the base chunk record is untouched');
 check(markerOn.includeGraphics===true,'the marker records the toggle as on');
 const savedOn=JSON.parse(await fs.readFile(settingsPath,'utf8'));
 check(savedOn.includeGraphics===true&&savedOn.graphicsChosen===true,'the click is persisted as the player\'s own choice: '+JSON.stringify({includeGraphics:savedOn.includeGraphics,graphicsChosen:savedOn.graphicsChosen}));
 check(!(await exists(path.join(clientRoot,OLD_IRIS))),'the Iris jar the previous release installed is retired from mods/: '+OLD_IRIS);
 check((await since()).every(state=>!state.error),'and the graphics change reported no failure');

 console.log('\n3. a new graphics chunk version retires only the files the previous one installed');
 // A file the player put in mods/ themselves. No retirement rule may touch it.
 const playerJar=path.join(clientRoot,'mods','my-own-mod.jar'),playerBytes=Buffer.from('a mod the player added');
 await fs.writeFile(playerJar,playerBytes);
 // The published update renames a managed jar: Sodium moves on, Iris does not.
 files['/data/client.json']=Buffer.from(JSON.stringify({...manifest,chunks:[manifest.chunks[0],graphicsV2]}));
 requests.length=0;
 await mark();
 await page.evaluate(()=>{window.__check=window.easterDesktop.checkUpdates().then(()=> 'done',error=>'error: '+error.message);});
 const downloading=await waitFor(state=>state.progress&&(state.progress.bytesDone||0)>0,'the update to report progress');
 check(await page.evaluate(()=>window.__check)==='done','the update completed');
 check(downloading.phase==='updating','an update reports the updating phase');
 check(downloading.progress.bytesTotal===chunkSize(graphicsV2),'the size the manifest declares for the chunk is the progress total: '+downloading.progress.bytesTotal);
 check(downloading.progress.bytesDone>0&&downloading.progress.bytesDone<=chunkSize(graphicsV2),'progress carries the bytes actually fetched: '+downloading.progress.bytesDone);
 check(requests.every(request=>request.path==='/data/client.json'||request.path.startsWith('/files/')),'only the changed chunk was fetched: '+JSON.stringify(requests.map(request=>request.path)));
 check(requests.filter(request=>request.path==='/files/base.jar').length===0,'the unchanged base chunk was not fetched');
 check(requests.some(request=>request.path===releaseUrl(graphicsV2,SHADER_PATH)),'the shader pack whose bytes changed was fetched');
 check(!requests.some(request=>request.path===releaseUrl(graphicsV2,IRIS_PATH)),'the Iris jar whose bytes did not change was not fetched again');
 check(requests.some(request=>request.path===releaseUrl(graphicsV2,NEW_SODIUM)),'and the renamed Sodium release was fetched');
 check(!(await exists(path.join(clientRoot,SODIUM_PATH))),'the Sodium jar the previous version installed is gone from mods/: '+SODIUM_PATH);
 check(await exists(path.join(clientRoot,NEW_SODIUM)),'and the one this version installs is on disk: '+NEW_SODIUM);
 check(await exists(path.join(clientRoot,IRIS_PATH)),'the Iris jar this version still declares is kept: '+IRIS_PATH);
 check(await exists(path.join(clientRoot,GRASS_PATH)),'the cached foliage jar is kept: '+GRASS_PATH);
 check(await exists(playerJar),'a file the player added to mods/ is untouched: '+path.posix.basename(playerJar));
 check((await fs.readFile(playerJar)).equals(playerBytes),'and byte-identical');
 check((await fs.readFile(path.join(clientRoot,SHADER_PATH))).equals(releaseBytes(graphicsV2,SHADER_PATH)),'the shader pack on disk is the new release');
 const markerUpdate=await marker();
 check(markerUpdate.chunks.graphics.version===graphicsV2.version,'the marker records the new graphics chunk version');
 check(JSON.stringify(markerUpdate.chunks.graphics.files)===JSON.stringify(graphicsV2.files.map(entry=>entry.path)),'with the file list the new version installs, the renamed Sodium included: '+JSON.stringify(markerUpdate.chunks.graphics.files));
 check(markerUpdate.chunks.base.version===manifest.chunks[0].version,'and the base chunk record is untouched');
 check(sha256(await fs.readFile(path.join(clientRoot,'mods','easter-navy.jar')))===sha256(baseJar),'so is the base chunk file');
 check((await fs.readFile(activeGrass)).equals(await fs.readFile(cachedGrass)),'the activated foliage jar still matches its cache');
 const ready=await latest();
 check(ready.phase==='ready'&&ready.install.installed===true,'the launcher settles back to ready');
 check(ready.actions.length===1&&ready.actions[0]==='signin','the only remaining requirement is the sign-in');

 console.log('\n4. pausing and resuming that transfer in the running app');
 files['/data/client.json']=Buffer.from(JSON.stringify({...manifest,chunks:[manifest.chunks[0],graphicsV3]}));
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
 check((await fs.readFile(path.join(clientRoot,SHADER_PATH))).equals(releaseBytes(graphicsV3,SHADER_PATH)),'the resumed shader pack matches the published bytes');
 check((await marker()).chunks.graphics.version===graphicsV3.version,'the marker records the resumed chunk version');
 check(moving.progress.bytesTotal===chunkSize(graphicsV3),'the transfer knew its total from the manifest: '+chunkSize(graphicsV3));

 console.log('\n5. clicking the toggle off removes the activated mod, keeps the cache and fetches nothing');
 requests.length=0;
 await mark();
 const offState=await clickGraphicsToggle(false);
 check(offState.graphics.enabled===false,'the toggle is off in the broadcast state');
 check(offState.graphics.tuned?.shaders===false,'and graphics.tuned reports the shaders the client now carries: '+JSON.stringify(offState.graphics.tuned));
 check(requests.every(request=>!request.path.startsWith('/files/')),'switching off fetches no chunk file: '+JSON.stringify(requests.map(request=>request.path)));
 check(!(await exists(activeGrass)),'the activated mods/easter-grassier-grass.jar is removed');
 check(await exists(cachedGrass),'the cached '+GRASS_PATH+' stays on disk for the next enable');
 check((await fs.readFile(cachedGrass)).equals(releaseBytes(graphicsV3,GRASS_PATH)),'still carrying the published bytes');
 check(await exists(path.join(clientRoot,SHADER_PATH)),'so does the shader pack: '+SHADER_PATH);
 check(/^enableShaders:false$/m.test(await fs.readFile(path.join(clientRoot,'config','iris.properties'),'utf8')),'iris.properties is rewritten with enableShaders:false');
 const markerOff=await marker();
 check(markerOff.chunks.graphics.version===graphicsV3.version,'the install marker keeps the graphics chunk version');
 check(markerOff.chunks.base.version===manifest.chunks[0].version,'and the base chunk record');
 check(markerOff.includeGraphics===false,'and records the toggle as off');
 const savedOff=JSON.parse(await fs.readFile(settingsPath,'utf8'));
 check(savedOff.includeGraphics===false&&savedOff.graphicsChosen===true,'the choice is persisted as the player\'s own: '+JSON.stringify({includeGraphics:savedOff.includeGraphics,graphicsChosen:savedOff.graphicsChosen}));
 check((await since()).every(state=>!state.error),'and switching it off reported no failure');
 // Switching it back on with nothing changed on the publisher's side is local work: the
 // chunk is installed and current, so no chunk file is fetched and the foliage jar is
 // activated from the cache the off direction deliberately kept.
 requests.length=0;
 await mark();
 const againState=await clickGraphicsToggle(true);
 check(againState.graphics.enabled===true,'the toggle is on again in the broadcast state');
 check(requests.every(request=>!request.path.startsWith('/files/')),'switching it back on fetches no chunk file: '+JSON.stringify(requests.map(request=>request.path)));
 check((await fs.readFile(activeGrass)).equals(await fs.readFile(cachedGrass)),'the foliage jar is activated again from its own cache');
 check(/^enableShaders:true$/m.test(await fs.readFile(path.join(clientRoot,'config','iris.properties'),'utf8')),'and the shader loader is switched back on');
 check(againState.graphics.tuned?.shaders===true,'graphics.tuned reports shaders:true again: '+JSON.stringify(againState.graphics.tuned));
 tunedDistance=againState.graphics.tuned.renderDistance;

 console.log('\n6. the state the running app broadcasts');
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
console.log('\n7. a fresh run keeps the player\'s own choice');
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
  check((await marker()).chunks.graphics.version===graphicsV3.version,'and the install marker still records the chunks it had before the restart');
 }finally{await relaunch.close();}

 // A tree the previous build had already seeded carries a schema-2 record, and one whose
 // client has run with the mod since carries the Shippy hotkey on Left Ctrl. That tree must
 // get exactly the keys the record does not cover once — the mod's hotkey included, moved
 // off the Left Ctrl crouch owns — with every value it already covers left alone.
 console.log('\n8. a schema-2 tree gets exactly the keys it does not cover added, and the Shippy hotkey with them');
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

console.log(failures===0?'\nLOOPBACK PASS: the real launcher seeded the client\'s display defaults, at the GUI scale its own display asks for and with the whole approved control set: crouch on Left Ctrl and sprint on Left Shift swapped from vanilla, inventory on tab, the player list on the grave key, third person on R, chat on enter, the GUI toggle on F10, social interactions on I, smooth camera on right shift, the 22 vanilla debug keys unbound and the mod-provided Shippy hotkey left for the client to register, from its startup path on an already-installed tree, wrote nothing on the second run, upgraded a schema-2 tree with exactly the keys its record did not cover — the Shippy hotkey moved off Left Ctrl in the same pass, inventory and the player list together so no two actions share tab — and nothing on the run after, fetched a fixture manifest from an overridden client origin, applied only the changed chunk, reported byte progress, paused and resumed that transfer, recorded what it installed, published the detected hardware and graphics state and no server choice at all, with the legacy address its settings file still carried accepted, ignored and dropped, installed the enhanced graphics chunk the live manifest really declares — the shader pack, Iris, Sodium and the cached Grassier Grass jar, at the published paths — by clicking the page\'s own toggle on in the running app, which activated mods/easter-grassier-grass.jar as a byte-equal copy of that cache and wrote iris.properties with enableShaders:true and shaderPack:ComplementaryUnbound_r5.9.3.zip, options.txt with the tuned render distance the state reports and state.graphics.tuned with shaders:true, retired exactly the managed jar the previous graphics version had installed while leaving a file the player added to mods/ untouched, then clicked the same toggle off to remove that jar and write enableShaders:false while keeping the cached payload, the shader pack, the chunk version and the base chunk record and fetching no chunk file at all, switched it back on from that cache without a download, and migrated the old default this box actually carries — exitOnLaunch:true with no trayOnLaunch — to both off once while keeping the saved graphics answer, leaving a player\'s own later choice unchanged on the next load and a second start over the migrated file itself leaving it alone':'\nLOOPBACK FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
