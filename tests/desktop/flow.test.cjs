// Download-first flow: the state contract, the transfer meter, pause and resume,
// the installation-location guard and the update check. Everything here runs
// against fixtures, temp directories and a loopback stub server; no upstream
// download is used.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {Transfer,countProgress,downloadVerified,createControl,canPlay,installDiff,installClient,checkForUpdates,graphicsPlan,graphicsEntry,clientStatus,readInstalled,tracked}=require('../../desktop/install.cjs');
const {setTimeout:sleep}=require('node:timers/promises');
const {defaultInstallLocation,locationProblem,checkLocation,ensureLocation,resolveLocation,cleanLaunchSettings}=require('../../desktop/config.cjs');

async function tempDir(prefix){return fs.mkdtemp(path.join(os.tmpdir(),prefix));}
function sha256(buffer){return crypto.createHash('sha256').update(buffer).digest('hex');}
// A loopback stub that dribbles bytes out slowly enough to pause mid-transfer.
async function slowServer(payload,{chunk=8192,delay=20}={}){
 let sent=0;
 const server=http.createServer((_request,response)=>{
  response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length});
  let offset=0;
  const timer=setInterval(()=>{
   if(offset>=payload.length){clearInterval(timer);response.end();return;}
   response.write(payload.subarray(offset,offset+chunk));offset+=chunk;sent=offset;
  },delay);
  response.on('close',()=>clearInterval(timer));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:'http://127.0.0.1:'+server.address().port,read:()=>sent,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('canPlay is exactly install.installed && profile !== null',()=>{
 const profile={name:'Captain',id:'1234567890abcdef1234567890abcdef'};
 assert.equal(canPlay({installed:true},profile),true);
 // An installed client with no account is not playable.
 assert.equal(canPlay({installed:true},null),false);
 assert.equal(canPlay({installed:true},undefined),false);
 // A signed-in account with no client is not playable.
 assert.equal(canPlay({installed:false},profile),false);
 assert.equal(canPlay({installed:false},null),false);
 assert.equal(canPlay(null,profile),false);
 // Nothing else may leak into the gate: a truthy non-boolean still cannot play.
 assert.equal(canPlay({installed:'yes'},profile),true);
 assert.equal(canPlay({installed:0},profile),false);
});

test('the installer refuses a folder inside .minecraft, the app directory, another launcher or the server',async()=>{
 const configRoot=await tempDir('easter-config-');
 const defaultLocation=defaultInstallLocation(configRoot);
 const home='/home/player';
 const rules={defaultLocation,configRoot,home};
 // Inside an existing .minecraft, at any depth, for any user.
 assert.match(locationProblem('/home/player/.minecraft',rules),/\.minecraft/);
 assert.match(locationProblem('/home/player/.minecraft/EasterCompany',rules),/\.minecraft/);
 assert.match(locationProblem('/srv/minecraft/.minecraft/instance',rules),/\.minecraft/);
 // Inside the launcher's own application data, but never the default itself.
 assert.match(locationProblem(configRoot,rules),/application data/);
 assert.match(locationProblem(path.join(configRoot,'somewhere-else'),rules),/application data/);
 assert.equal(locationProblem(defaultLocation,rules),null);
 // Not a folder at all, or the whole home directory.
 assert.match(locationProblem('Games/minecraft',rules),/absolute/);
 assert.match(locationProblem('',rules),/Choose an installation folder/);
 assert.equal(locationProblem(path.parse(process.cwd()).root,rules)!==null,true);
 assert.match(locationProblem(home,rules),/home directory/);
 // A folder of the player's own is allowed.
 assert.equal(locationProblem('/home/player/Games/EasterCompany',rules),null);

 // A folder that already holds another Minecraft installation is refused even
 // though its path is fine, and the server/world counts as one.
 for(const entry of ['.minecraft','launcher_profiles.json','launcher_accounts.json','versions','libraries','assets','mods','saves','server.properties','level.dat','world','server.jar']){
  const dir=path.join(await tempDir('easter-foreign-'),'picked');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,entry),'');
  await assert.rejects(ensureLocation(dir,{defaultLocation,configRoot,home}),/another Minecraft installation/);
 }
 // A tree the launcher already owns keeps working, marker and all.
 const owned=path.join(await tempDir('easter-owned-'),'client');
 await fs.mkdir(path.join(owned,'mods'),{recursive:true});
 await fs.writeFile(path.join(owned,'.easter-client'),'');
 await fs.writeFile(path.join(owned,'mods','easter-navy.jar'),'');
 assert.equal(await ensureLocation(owned,{defaultLocation,configRoot,home}),owned);
 // An empty folder of the player's own is created and accepted.
 const fresh=path.join(await tempDir('easter-fresh-'),'new-client');
 assert.equal(await ensureLocation(fresh,{defaultLocation,configRoot,home}),fresh);
 assert.equal((await fs.stat(fresh)).isDirectory(),true);
});

test('a folder the process cannot write is refused with a clear message',async()=>{
 const base=await tempDir('easter-unwritable-');
 const file=path.join(base,'not-a-directory');
 await fs.writeFile(file,'x');
 // Root bypasses mode bits, so the refusals below are structural: a regular file
 // cannot be a parent directory, and a read-only system filesystem stays read-only.
 await assert.rejects(ensureLocation(path.join(file,'client'),{}),/cannot write to that folder/);
 if(process.platform==='linux'&&await fs.stat('/sys').then(()=>true).catch(()=>false)){
  await assert.rejects(ensureLocation('/sys/easter-launcher-write-test',{}),/cannot write to that folder/);
 }
});

test('a renderer can only name the saved folder or the default',async()=>{
 const configRoot=await tempDir('easter-resolve-');
 const defaultLocation=defaultInstallLocation(configRoot);
 const saved=path.join(configRoot,'chosen');
 // No request at all -> the saved setting, or the default when none was saved.
 assert.equal(resolveLocation('',{saved:'',defaultLocation}),defaultLocation);
 assert.equal(resolveLocation(undefined,{saved,defaultLocation}),saved);
 // The saved value and the default are the only names that are accepted.
 assert.equal(resolveLocation(saved,{saved,defaultLocation}),saved);
 assert.equal(resolveLocation(defaultLocation,{saved,defaultLocation}),defaultLocation);
 for(const requested of ['/etc','/home/player/.minecraft',path.join(configRoot,'other'),'relative/path','..'])
  assert.throws(()=>resolveLocation(requested,{saved,defaultLocation}),/folder picker/);
 // A malformed launch-settings payload cannot smuggle a relative location either.
 assert.deepEqual(cleanLaunchSettings({includeGraphics:true}),{location:'',includeGraphics:true});
 assert.deepEqual(cleanLaunchSettings({location:saved,includeGraphics:false}),{location:saved,includeGraphics:false});
 assert.throws(()=>cleanLaunchSettings({location:'relative/minecraft'}),/absolute/);
});

test('speed and ETA come from measured throughput and stay null until enough is observed',()=>{
 let clock=0;
 const meter=new Transfer({now:()=>clock});
 meter.begin('Downloading the game',1000000);
 assert.deepEqual(meter.snapshot(),{label:'Downloading the game',percent:0,bytesDone:0,bytesTotal:1000000,bytesPerSecond:null,etaSeconds:null});
 clock=300;meter.add(10000);
 assert.equal(meter.snapshot().bytesPerSecond,null,'no speed before enough time has been observed');
 assert.equal(meter.snapshot().etaSeconds,null,'no ETA without a measured speed');
 assert.equal(meter.snapshot().percent,1);
 clock=800;meter.add(10000);
 assert.equal(meter.snapshot().bytesPerSecond,null,'no speed before enough data has been observed');
 clock=1400;meter.add(30000);
 const snapshot=meter.snapshot();
 assert.equal(snapshot.percent,5);
 // Samples span 1400-300 = 1100 ms for 50000 bytes.
 assert.equal(Math.round(snapshot.bytesPerSecond),Math.round(50000*1000/1100));
 assert.equal(snapshot.etaSeconds,Math.round((1000000-50000)/(50000*1000/1100)));
 // Absolute task progress feeds the same meter, including a restarted transfer.
 clock=2400;meter.set(90000,1000000);
 assert.equal(meter.snapshot().bytesDone,90000);
 assert.equal(meter.snapshot().percent,9);
 clock=2500;meter.set(0,1000000);
 assert.equal(meter.snapshot().bytesDone,0);
 assert.equal(meter.snapshot().bytesPerSecond,null,'a restarted transfer measures again');
});

test('an unknown total leaves percent null while a count-based task leaves every byte field null',()=>{
 const meter=new Transfer();
 meter.begin('Installing Java 25',null);
 assert.equal(meter.snapshot().percent,null,'percent is null exactly when no total is known');
 assert.equal(meter.snapshot().bytesTotal,null);
 assert.equal(meter.snapshot().etaSeconds,null);
 assert.equal(meter.snapshot().bytesDone,0);
 assert.deepEqual(countProgress('Verifying game sounds & textures',42.6),{label:'Verifying game sounds & textures',percent:43,bytesDone:null,bytesTotal:null,bytesPerSecond:null,etaSeconds:null});
 assert.equal(countProgress('Verifying',null).percent,null);
 assert.equal(countProgress('Verifying',-5).percent,0);
});

test('a paused transfer stops fetching bytes and resumes to the same verified file',async()=>{
 const payload=crypto.randomBytes(512*1024);
 const hash=sha256(payload);
 const server=await slowServer(payload);
 const dir=await tempDir('easter-pause-');
 const file=path.join(dir,'client.jar');
 const control=createControl();
 const meter=new Transfer();
 const seen=[];
 let started;
 const arrived=new Promise(resolve=>{started=resolve;});
 const download=downloadVerified(server.origin+'/client.jar',file,hash,'sha256',{control,meter,onProgress(snapshot){seen.push(snapshot);if((snapshot.bytesDone||0)>0)started();}});
 try{
  await arrived;
  assert.equal(control.pause(),true);
  assert.equal(control.paused,true);
  // Let any chunk already in flight land, then watch for the transfer to park.
  let previous=-1;
  for(let attempt=0;attempt<60;attempt++){
   await sleep(50);
   const last=seen[seen.length-1].bytesDone;
   if(last===previous)break;
   previous=last;
  }
  const pausedAt=seen[seen.length-1].bytesDone;
  const reports=seen.length;
  assert(pausedAt>0,'the transfer had started before it was paused');
  assert(pausedAt<payload.length,'the transfer had not finished before it was paused');
  await sleep(500);
  assert.equal(seen[seen.length-1].bytesDone,pausedAt,'bytesDone must not advance while paused');
  assert.equal(seen.length,reports,'a paused transfer reports no progress at all');
  const sentAtPause=server.read();
  await sleep(200);
  assert(sentAtPause>0);
  assert.equal(control.resume(),true);
  assert.equal(control.paused,false);
  assert.equal(await download,true);
  assert(seen[seen.length-1].bytesDone>pausedAt,'bytesDone advances after resume');
  const written=await fs.readFile(file);
  assert.equal(written.length,payload.length);
  assert.equal(sha256(written),hash,'the resumed file matches its checksum');
  assert.equal(written.equals(payload),true);
  assert.deepEqual(await fs.readdir(dir),['client.jar'],'no part file is left behind');
 }finally{await server.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a cancelled transfer stops, keeps the previous file and keeps the partial data for a resume',async()=>{
 const payload=crypto.randomBytes(256*1024);
 const server=await slowServer(payload);
 const dir=await tempDir('easter-cancel-');
 const file=path.join(dir,'client.jar');
 await fs.writeFile(file,'previous');
 const control=createControl();
 const meter=new Transfer();
 let started;const arrived=new Promise(resolve=>{started=resolve;});
 const download=downloadVerified(server.origin+'/client.jar',file,sha256(payload),'sha256',{control,meter,onProgress(snapshot){if((snapshot.bytesDone||0)>0)started();}});
 try{
  await arrived;
  control.cancel();
  await assert.rejects(download,error=>error.name==='CancelledError');
  assert.equal(await fs.readFile(file,'utf8'),'previous','a cancelled download replaces nothing');
  const entries=await fs.readdir(dir);
  assert(entries.includes('client.jar.part'),'the bytes already fetched are kept so the file can resume: '+JSON.stringify(entries));
  assert((await fs.stat(path.join(dir,'client.jar.part'))).size>0,'the partial data is not empty');
 }finally{await server.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a mismatched download over the loopback stub replaces nothing and a plaintext upstream host is refused',async()=>{
 const payload=crypto.randomBytes(64*1024);
 const server=await slowServer(payload,{chunk:65536,delay:1});
 const dir=await tempDir('easter-checksum-');
 const file=path.join(dir,'client.jar');
 await fs.writeFile(file,'previous');
 try{
  await assert.rejects(downloadVerified(server.origin+'/client.jar',file,sha256(Buffer.from('other')),'sha256'),/checksum/);
  assert.equal(await fs.readFile(file,'utf8'),'previous');
  assert.deepEqual(await fs.readdir(dir),['client.jar']);
  // Plaintext is only ever accepted on the loopback interface.
  for(const url of ['http://cdn.example.com/client.jar','http://192.168.1.5/client.jar','ftp://127.0.0.1/client.jar'])
   await assert.rejects(downloadVerified(url,file,sha256(payload),'sha256'),/Insecure download refused/);
 }finally{await server.close();await fs.rm(dir,{recursive:true,force:true});}
});

// ---- update check -----------------------------------------------------------
const MOD_SHA='3cb0b28b1f7de7c818cb35072846ce922975be9f23f1fab988bda3c329f8936f';
const FABRIC_VERSION='fabric-loader-0.19.5-26.2';
const PUBLISHED={minecraft:'26.2',dependencies:[{id:'fabric-api',name:'Fabric API',version:'0.161.0+26.2'},{id:'shippy-ships',name:'Shippy Ships',version:'1.0.23.1'}],mod:{version:'2.0.0',sha256:MOD_SHA,url:'downloads/easter-navy.jar',name:'Easter Co. client'}};
async function installedFixture(){
 const dir=await tempDir('easter-installed-');
 const root=path.join(dir,'minecraft');
 await fs.mkdir(path.join(root,'versions',FABRIC_VERSION),{recursive:true});
 await fs.writeFile(path.join(root,'versions',FABRIC_VERSION,FABRIC_VERSION+'.json'),'{}');
 await fs.mkdir(path.join(root,'mods'),{recursive:true});
 await fs.writeFile(path.join(root,'mods','easter-navy.jar'),'jar');
 await fs.writeFile(path.join(root,'.easter-client'),'');
 await fs.writeFile(path.join(root,'installed.json'),JSON.stringify({version:FABRIC_VERSION,minecraft:'26.2',fabric:'0.19.5',mod:'2.0.0',modSha256:MOD_SHA,dependencies:PUBLISHED.dependencies.map(d=>({id:d.id,version:d.version})),files:['mods/easter-navy.jar'],graphics:null,includeGraphics:false,updatedAt:'2026-10-15T00:00:00.000Z'}));
 return {root,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}

test('a task that downloads bytes is reported with its label, bytes, measured speed and ETA',async()=>{
 const notifications=[];
 const task={total:1000000,progress:0,startAndWait:async context=>{for(let step=1;step<=8;step++){task.progress=step*125000;context.onUpdate();await sleep(90);}}};
 await tracked(task,'Verifying Fabric libraries',patch=>notifications.push(patch),{phase:'downloading'});
 assert(notifications.length>1);
 for(const patch of notifications){
  assert.equal(patch.phase,'downloading');
  assert.equal(patch.progress.label,'Verifying Fabric libraries');
  assert.equal(patch.progress.bytesTotal,1000000);
 }
 const final=notifications[notifications.length-1];
 assert.equal(final.progress.bytesDone,1000000);
 assert.equal(final.progress.percent,100);
 assert.equal(final.progress.etaSeconds,0);
 assert(typeof final.progress.bytesPerSecond==='number'&&final.progress.bytesPerSecond>0,'a measured speed, not an assumed one');
 // A task with no total is a percentage-free step with every byte field null.
 const blind=[];
 await tracked({total:0,progress:0,startAndWait:async()=>{}},'Installing Java 25',patch=>blind.push(patch),{phase:'installing'});
 assert.deepEqual(blind[blind.length-1].progress,{label:'Installing Java 25',percent:null,bytesDone:null,bytesTotal:null,bytesPerSecond:null,etaSeconds:null});
});

test('an install that matches the published manifest stays completely quiet',async()=>{
 const fixture=await installedFixture();
 try{
  const status=await clientStatus(fixture.root);
  assert.equal(status.installed,true);
  assert.equal(status.version,'2.0.0');
  const notifications=[];
  let applied=0;
  const result=await checkForUpdates({root:fixture.root,notify:patch=>notifications.push(patch),fetchManifest:async()=>PUBLISHED,install:async()=>{applied++;}});
  assert.equal(result.checked,true);
  assert.equal(result.changed,false);
  assert.equal(result.applied,false);
  assert.equal(applied,0,'the pipeline must not run when nothing differs');
  assert.deepEqual(notifications,[],'a quiet check reports nothing: no phase change and no progress bar');
 }finally{await fixture.cleanup();}
});

test('a changed published manifest runs the same pipeline in update mode with the same reporting',async()=>{
 const fixture=await installedFixture();
 try{
  const cases=[
   ['mod',{...PUBLISHED,mod:{...PUBLISHED.mod,sha256:'a'.repeat(64)}}],
   ['minecraft',{...PUBLISHED,minecraft:'26.3'}],
   ['dependencies',{...PUBLISHED,dependencies:[...PUBLISHED.dependencies,{id:'tectonic',version:'3.0.28'}]}]
  ];
  for(const [name,published] of cases){
   const notifications=[];const calls=[];
   const result=await checkForUpdates({root:fixture.root,notify:patch=>notifications.push(patch),fetchManifest:async()=>published,install:async options=>{calls.push(options);options.notify({phase:'updating',message:'Updating the client',progress:{label:'Updating the client',percent:50,bytesDone:5,bytesTotal:10,bytesPerSecond:null,etaSeconds:null}});return {version:FABRIC_VERSION,message:'Client updated.'};}});
   assert.equal(result.checked,true,name);
   assert.equal(result.changed,true,name);
   assert.equal(result.applied,true,name);
   assert.equal(calls.length,1,name);
   assert.deepEqual(result.changes,[name]);
   assert.equal(calls[0].mode,'update',name);
   assert.equal(calls[0].published.minecraft,published.minecraft,name);
   assert.equal(notifications.length,1,'the update reports through the same notify',name);
   assert.equal(notifications[0].phase,'updating');
  }
  // A different pinned Fabric loader is a change too, and it is the version the
  // launcher ships rather than anything the published manifest says.
  const calls=[];
  const result=await checkForUpdates({root:fixture.root,notify:()=>{},fetchManifest:async()=>PUBLISHED,install:async options=>{calls.push(options);return {version:FABRIC_VERSION};}});
  assert.equal(result.changed,false);
  assert.equal(calls.length,0);
  assert.deepEqual(installDiff(PUBLISHED,{minecraft:'26.2',fabric:'0.19.4',modSha256:MOD_SHA,dependencies:PUBLISHED.dependencies.map(d=>({id:d.id,version:d.version}))}).changes,['fabric']);
 }finally{await fixture.cleanup();}
});

test('an install with no record is reported as missing rather than quietly current',async()=>{
 const dir=await tempDir('easter-missing-');
 const root=path.join(dir,'minecraft');
 await fs.mkdir(root,{recursive:true});
 try{
  const notifications=[];
  const result=await checkForUpdates({root,notify:patch=>notifications.push(patch),fetchManifest:async()=>PUBLISHED,install:async()=>{}});
  assert.deepEqual(result,{checked:false,changed:true,applied:false,changes:['missing'],result:null});
  assert.deepEqual(notifications,[]);
  assert.equal(await readInstalled(root),null);
  assert.equal((await clientStatus(root)).installed,false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('installDiff compares every published field, not the file names',()=>{
 const record={minecraft:'26.2',fabric:'0.19.5',modSha256:MOD_SHA,dependencies:[{id:'fabric-api',version:'0.161.0+26.2'},{id:'shippy-ships',version:'1.0.23.1'}],graphics:null};
 assert.deepEqual(installDiff(PUBLISHED,record),{changed:false,changes:[]});
 assert.deepEqual(installDiff(PUBLISHED,{...record,dependencies:[{id:'fabric-api',version:'0.160.0+26.2'},{id:'shippy-ships',version:'1.0.23.1'}]}).changes,['dependencies']);
 assert.deepEqual(installDiff(PUBLISHED,{...record,fabric:'0.19.4'}).changes,['fabric']);
 assert.deepEqual(installDiff(PUBLISHED,{...record,minecraft:'26.1'}).changes,['minecraft']);
 assert.deepEqual(installDiff(PUBLISHED,{...record,modSha256:'b'.repeat(64)}).changes,['mod']);
 assert.deepEqual(installDiff(PUBLISHED,null).changes,['missing']);
});

test('the enhanced graphics toggle only installs what the manifest publishes',()=>{
 // Off: nothing is planned at all.
 assert.deepEqual(graphicsPlan(PUBLISHED,false),{state:'skipped',entry:null,message:null});
 // On, but the manifest declares no payload: the install completes and says so.
 const unpublished=graphicsPlan(PUBLISHED,true);
 assert.equal(unpublished.state,'not-published');
 assert.equal(unpublished.entry,null);
 assert.match(unpublished.message,/not published yet/);
 assert.doesNotMatch(unpublished.message,/installed[.]$/);
 // On with a declared payload: same-origin, checksum verified, plan reported.
 const hash='c'.repeat(64);
 const published={...PUBLISHED,graphics:{name:'Enhanced graphics',version:'1.0.0',filename:'easter-graphics.zip',url:'downloads/easter-graphics.zip',sha256:hash}};
 const plan=graphicsPlan(published,true);
 assert.equal(plan.state,'install');
 assert.deepEqual(plan.entry,{name:'Enhanced graphics',version:'1.0.0',filename:'easter-graphics.zip',hash,url:'https://launcher.easter.company/downloads/easter-graphics.zip'});
 assert.match(plan.message,/installed/);
 const diff=installDiff(published,{minecraft:'26.2',fabric:'0.19.5',modSha256:MOD_SHA,dependencies:[{id:'fabric-api',version:'0.161.0+26.2'},{id:'shippy-ships',version:'1.0.23.1'}],graphics:null},{includeGraphics:true});
 assert.deepEqual(diff.changes,['graphics']);
 // A payload that is not ours, or has no checksum, is refused rather than fetched.
 assert.throws(()=>graphicsEntry({filename:'x.zip',url:'https://evil.example/x.zip',sha256:hash}),/Unexpected graphics location/);
 assert.throws(()=>graphicsEntry({filename:'x.zip',url:'downloads/x.zip'}),/checksum/);
 assert.throws(()=>graphicsEntry({filename:'../escape.zip',url:'downloads/x.zip',sha256:hash}),/invalid filename/);
 assert.equal(graphicsEntry(undefined),null);
});

test('the install pipeline refuses a root inside an existing .minecraft before it writes anything',async()=>{
 const dir=await tempDir('easter-install-guard-');
 const root=path.join(dir,'.minecraft','EasterCompany');
 try{
  await assert.rejects(installClient({root,notify:()=>{}}),/\.minecraft/);
  await assert.rejects(fs.stat(root),error=>error.code==='ENOENT');
  await assert.rejects(fs.stat(path.join(dir,'.minecraft')),error=>error.code==='ENOENT');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the graphics toggle is exposed on the isolated preload and handled origin-checked',async()=>{
 const preload=await fs.readFile(path.join(__dirname,'../../desktop/preload.cjs'),'utf8');
 assert.match(preload,/contextBridge\.exposeInMainWorld\('easterDesktop'/);
 assert.match(preload,/setGraphics:invoke\('set-graphics'\)/,'setGraphics is on the existing bridge surface');
 // No renderer gets a path, a command or a filesystem from this: the whole bridge is
 // still a list of named channels.
 assert.equal(/\brequire\(['"]node:fs/.test(preload),false);
 const channels=[...preload.matchAll(/invoke\('([^']+)'\)/g)].map(match=>match[1]);
 assert(channels.length>=14,'the bridge exposes the launcher channels');
 assert.equal(channels.includes('set-graphics'),true);
 assert.equal(/ipcRenderer\.(send|sendSync|postMessage)|webFrame|process\.binding/.test(preload),false,'no other renderer-to-main path exists');
 const main=await fs.readFile(path.join(__dirname,'../../desktop/main.cjs'),'utf8');
 assert.match(main,/handle\('set-graphics',/,'the handler exists');
 assert.match(main,/if\(!trustedFrame\(event\)\)throw Error\('Untrusted launcher request\.'\)/,'and follows the origin-checked pattern every other handler uses');
 // The state the contract publishes, merged into the object status() already returns.
 // status() is what Settings asks when it opens, so it refreshes the two shortcut entries
 // before answering, and answers with everything the contract carries.
 assert.match(main,/handle\('status',async\(\)=>\{[\s\S]{0,300}?await refreshShortcuts\(\);[\s\S]{0,400}?return \{\.\.\.state,shortcuts:shortcutState,/,'status() refreshes the real shortcut state and spreads the state that carries hardware and graphics');
 assert.match(main,/hardware:hardwareState\(\),graphics:graphicsState\(\)/,'every broadcast carries hardware and graphics');
 // There is no server list in the state: the launcher targets one fixed production server
 // and the player has no address to choose (doc/launcher-states.md, "The one server the
 // launcher targets").
 assert.equal(/serversState|servers:/.test(main),false,'no state broadcast carries a server choice');
 assert.equal(/serverList|SERVER_ENTRIES/.test(main),false,'main.cjs publishes no server entries');
 assert.match(main,/function chooseGraphicsDefault\(stored,recommended\)/,'the first-run default is decided once');
 assert.match(main,/require\('\.\/hardware\.cjs'\)/,'detection lives in its own module');
 assert.match(main,/app\.getGPUInfo\('complete'\)/);
 assert.match(main,/app\.getGPUFeatureStatus\(\)/);
 // The toggle's own path is the verified pipeline, never a second downloader, and it
 // carries the display's own GUI scale answer so the pipeline seed and the startup seed
 // cannot disagree.
 assert.match(main,/applyGraphics\(\{root:gameRoot\(\),settings,notify,control,includeGraphics:enabled,hardware:hardwareState\(\),guiScale:clientGuiScale\(\)\}\)/);
 assert.match(main,/const \{detectHardware,installedQuality,applyDisplayDefaults,displayGuiScale,displayPhysicalPixels\}=require\('\.\/hardware\.cjs'\)/,'the display rule lives in its own module');
 assert.match(main,/displayPhysicalPixels\(screen\.getPrimaryDisplay\(\)\)/,'the primary display is resolved from Electron and read in physical pixels, not guessed');
 assert.match(main,/applyDisplayDefaults\(gameRoot\(\),\{guiScale:clientGuiScale\(\)\}\)/,'the startup seed uses the same value');
});

test('the published graphics state carries the contract shape',()=>{
 const graphics={enabled:true,recommended:true,tunable:true,tuned:{renderDistance:14,shadowDistance:10,shaders:true}};
 assert.deepEqual(Object.keys(graphics).sort(),['enabled','recommended','tunable','tuned']);
 const hardware={gpu:'NVIDIA GeForce RTX 4060',vendor:'NVIDIA',vramMB:8188,tier:'capable',reason:'NVIDIA GPU NVIDIA GeForce RTX 4060 with 8188 MB of video memory.'};
 assert.deepEqual(Object.keys(hardware).sort(),['gpu','reason','tier','vendor','vramMB']);
 assert.equal(['capable','weak','unknown'].includes(hardware.tier),true);
 assert.equal(typeof hardware.reason,'string');
 assert.equal(hardware.reason.includes('\n'),false,'the reason is one displayable sentence');
});

test('the location guard is what the main process uses, not a second copy',async()=>{ // The renderer-facing handlers must resolve through these helpers, so a path can
 // only ever arrive from the picker or the saved setting.
 const source=await fs.readFile(path.join(__dirname,'../../desktop/main.cjs'),'utf8');
 assert.match(source,/require\('\.\/config\.cjs'\)/);
 assert.match(source,/ensureLocation\(resolveLocation\(/);
 // The one gate, computed in one place and reused by Play and by the game shortcut. The
 // Minecraft profile it checks against is the launcher's own answer — this machine's session,
 // or the one the account service minted (doc/launcher-states.md, "The Minecraft session the
 // account service holds") — and never a second computation in a view.
 assert.match(source,/function canPlayNow\(\)\{/);
 assert.match(source,/canPlay\(installInfo\(\),launchProfile\(\)\)/);
 assert.match(source,/function launchProfile\(\)\{/);
 assert.match(source,/properties:\['openDirectory','createDirectory'\]/);
 for(const channel of ['choose-location','set-location','start-install','pause-install','resume-install','cancel-install','check-updates'])
  assert.match(source,new RegExp("handle\\('"+channel+"'"),channel+' handler must exist');
});

// ---- launch behaviour -------------------------------------------------------
// The three launch-time behaviours are one decision, and it is a pure function, so what
// the window does can be tested without a window and without a tray.
test('starting the game moves the launcher by exactly one rule, and never hides it without a tray',()=>{
 const {launchBehaviour}=require('../../desktop/security.cjs');
 // Neither preference: the window stays where it is, and says nothing.
 assert.deepEqual(launchBehaviour({}),{action:'stay',message:null});
 assert.deepEqual(launchBehaviour({exitOnLaunch:false,trayOnLaunch:false}),{action:'stay',message:null});
 // Close on launch: the existing behaviour, unchanged.
 assert.deepEqual(launchBehaviour({exitOnLaunch:true}),{action:'quit',message:null});
 // Tray on launch: hidden rather than closed — behind a tray icon when one can be drawn.
 assert.deepEqual(launchBehaviour({trayOnLaunch:true},{trayAvailable:true}),{action:'tray',message:null});
 // Where no tray icon can be drawn the launcher still steps aside, and the sentence says
 // how to bring it back: starting the launcher again. The setting is never a silent no-op.
 const noHost=launchBehaviour({trayOnLaunch:true},{trayAvailable:false});
 assert.equal(noHost.action,'hide','without a tray host the launcher still steps aside');
 assert.equal(noHost.message,'This desktop has no system tray, so start Easter Co. Launcher again to bring the window back.');
 // A payload claiming both does neither: after the one-time migration a both-true file can
 // only be hand-edited, so the launcher stays where it is rather than guessing between
 // quitting and hiding.
 assert.deepEqual(launchBehaviour({exitOnLaunch:true,trayOnLaunch:true},{trayAvailable:true}),{action:'stay',message:null});
 assert.equal(launchBehaviour({trayOnLaunch:'yes'},{trayAvailable:true}).action,'stay');
 assert.equal(launchBehaviour({exitOnLaunch:'yes',trayOnLaunch:true},{trayAvailable:true}).action,'tray','a malformed close value leaves the tray choice alone');
 assert.equal(launchBehaviour(null,{trayAvailable:true}).action,'stay');
 // The relaunch switch, which is a different question asked at startup: this window replaced
 // one that was in the tray, so it comes up in the tray — regardless of the launch-time pair,
 // and with no sentence, because the player is not being told anything they can see.
 assert.deepEqual(launchBehaviour({},{trayAvailable:true,hiddenToTray:true}),{action:'tray',message:null});
 assert.deepEqual(launchBehaviour({trayOnLaunch:true},{trayAvailable:true,hiddenToTray:true}),{action:'tray',message:null});
 // Closing behind the game is an explicit choice the player made, so it wins over the switch.
 assert.equal(launchBehaviour({exitOnLaunch:true},{trayAvailable:true,hiddenToTray:true}).action,'quit');
 // Where no tray host exists the switch is NOT honoured: the window comes up as an ordinary
 // window. An invisible launcher with no icon is one nobody can reach, which is worse than the
 // frame the switch exists to avoid.
 assert.deepEqual(launchBehaviour({},{trayAvailable:false,hiddenToTray:true}),{action:'stay',message:null});
 assert.deepEqual(launchBehaviour({trayOnLaunch:true},{trayAvailable:false,hiddenToTray:true}).action,'hide','the trayOnLaunch rule is unchanged by the switch');
 assert.equal(launchBehaviour({},{trayAvailable:true}).action,'stay','a switch nobody passed changes nothing');
});

// What the main process does with that decision. These are wiring assertions on the real
// entry point rather than a tray on a panel: a status-notifier host is not part of the test
// seat, and the point here is that the window steps aside only behind a tray that was
// created first (or with the sentence that says how to return), that starting the launcher
// again brings a hidden window back, and that the game ending does so by itself.
test('the window steps aside with a tray or a way back, and returns when the game ends',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../../desktop/main.cjs'),'utf8');
 // Tray and its menu, with Open launcher and Quit.
 assert.match(source,/const \{[^}]*\bTray\b[^}]*\}=require\('electron'\)/);
 assert.match(source,/new Tray\(/);
 assert.match(source,/\{label:'Open launcher',click:\(\)=>showLauncher\(\)\}/);
 // Quit exits the launcher and does not touch the game process. The launcher can end a game in
 // exactly one place — Owen's Exit Game, through `signalGame` — so the tray's own path is asserted
 // to carry no signal at all, rather than the whole file being free of the word `kill`: the
 // force-quit lives here now (ticket 4869be14), and the rule it must not break is this one.
 assert.match(source,/\{label:'Quit',click:\(\)=>app\.quit\(\)\}/);
 const trayPath=source.slice(source.indexOf('async function leaveTheWay()'),source.indexOf('// The game has ended, or never started'));
 assert(trayPath.length>200,'the tray path was found in desktop/main.cjs');
 assert.equal(/\.kill\(|SIGTERM|SIGKILL|signalGame/.test(trayPath),false,'quitting from the tray must not kill a running game');
 // And the one place that may: Exit Game signals, and it is the only caller of the signal helper.
 // And the one place that may: Exit Game signals the client, in two steps (a polite ask, then a
 // kill) for each of the two shapes of game — a launched child and an adopted pid — and it is the
 // only caller of the signal helper in the file.
 const exitPath=source.slice(source.indexOf('async function performGameExit('),source.indexOf('// Play and the game shortcut reach this one function'));
 assert(exitPath.length>500,'Exit Game was found in desktop/main.cjs');
 assert.match(exitPath,/signalGame\(null,record\.pid,'SIGTERM'\)/,'an adopted game is asked to close by pid, because there is no child handle to kill');
 assert.match(exitPath,/signalGame\(null,record\.pid,'SIGKILL'\)/,'and killed by pid when the short bound runs out');
 assert.match(exitPath,/signalGame\(child,null,'SIGTERM'\)/,'a launched game is asked to close through its own child handle');
 assert.match(exitPath,/signalGame\(child,null,'SIGKILL'\)/,'and killed through it');
 const signals=/signalGame\([^)]*\)/g;
 assert.equal((source.match(signals)||[]).length,5,'the four signals above are the only ones in the file (plus its definition): '+JSON.stringify(source.match(signals)));
 // The order that makes each path honest: ask the desktop, create the icon when it says
 // one can be drawn, and only then hide.
 const hide=source.indexOf('window.hide()');
 assert(hide>0,'the player\'s window can step aside');
 assert(source.lastIndexOf('trayHostAvailable()',hide)>0,'only after the desktop was asked whether a tray exists');
 assert(source.lastIndexOf('ensureTray()',hide)>0,'and only after the tray icon was created where one can be');
 assert.match(source,/const decision=launchBehaviour\(settings,\{trayAvailable:available&&ensureTray\(\)\}\)/,'the tray is only created when the desktop says one can be drawn');
 // The old default is migrated once on load, so the update reaches an existing install
 // instead of silently keeping the behaviour the feature was asked to change.
 assert.match(source,/const migration=migrateLaunchPreferences\(savedFile\?stored:null\)/,'the saved file is migrated on load');
 assert.match(source,/if\(migration\.migrated\)\{[\s\S]{0,200}?await atomicJSON\(settingsFile\(\),/,'and written back once, which is what makes it once');
 // Without a tray icon the window still hides, and the sentence says how to come back.
 assert.match(source,/if\(decision\.message\)notify\(\{message:decision\.message,error:decision\.message\}\)/,'the no-tray case is not silent');
 // Starting the launcher again is the way back, and it is the game shortcut's path too.
 assert.match(source,/app\.on\('second-instance',\(_event,argv\)=>\{[\s\S]{0,500}?window\.show\(\);window\.focus\(\);/,'a second instance shows and focuses the existing window');
 assert.match(source,/if\(!window\|\|window\.isDestroyed\(\)\)createWindow\(\);/,'and creates one if the window is gone');
 // The shortcut clicked while the launcher is running arrives on this same event with
 // its own command line, so the flag is read from there and not from the first launch.
 assert.match(source,/if\(wantsAutoStart\(argv\)\)void autoStart\(\);/,'a second launch carrying the auto-start flag starts the game through the same path');
 // Both game handlers put the window back, keep the messages they settled before, and forget
 // the running game's marker: a launcher that restarts after the game has ended must not adopt
 // a process that is gone (tests/desktop/game-marker.test.cjs proves what adoption does).
 // The handler takes the signal as well as the code, because Exit Game ends the client with one: an
 // exit the player asked for publishes the sentence a clean close has always had instead of a code
 // it never had, and the press itself is the one that settles it (`gameExitRequested`).
 const exitHandler=/child\.once\('exit',\(code,signal\)=>\{const requested=gameExitRequested;gameExitRequested=false;game=null;forgetRunningGame\(\);returnToLauncher\(\);if\(requested\)return;const message=code===0\?GAME_CLOSED:'Minecraft closed with code '\+code\+'\. Its log is in the client folder\.';settle\(message,\{error:code===0\?null:message\}\);\}\)/.exec(source);
 assert(exitHandler,'the exit handler restores the window, forgets the marker and settles the same message');
 assert.match(source,/const GAME_CLOSED='Minecraft closed\. Ready to play\.'/,'the closing sentence has one copy, which Exit Game and an ordinary exit share');
 const errorHandler=/child\.once\('error',\(\)=>\{game=null;forgetRunningGame\(\);returnToLauncher\(\);const message='Minecraft could not start\. Check Java and try again\.';settle\(message,\{error:message\}\);\}\)/.exec(source);
 assert(errorHandler,'the failure handler restores the window too');
 // The behaviours are mutually exclusive at the call site as well: one branch each.
 assert.match(source,/if\(settings\.exitOnLaunch===true\)setTimeout\(\(\)=>\{ if\(game\)\{ app\.quit\(\); \} \},800\);/);
 assert.match(source,/else if\(settings\.trayOnLaunch===true\)setTimeout\(\(\)=>\{ if\(game\)void leaveTheWay\(\); \},800\);/);
 // A hidden window is not a closed one, so the existing quit-on-last-window rule is
 // untouched and does not fire while the launcher is in the tray.
 assert.match(source,/app\.on\('window-all-closed',\(\)=>\{if\(process\.platform!=='darwin'\)app\.quit\(\);\}\);/);
 // Linux detection asks the session bus for a StatusNotifier host and treats every
 // failure as "no host", so a missing dbus-send is a kept window, not a hidden one.
 assert.match(source,/org\.kde\.StatusNotifierWatcher/);
 assert.match(source,/if\(!process\.env\.DBUS_SESSION_BUS_ADDRESS\)return Promise\.resolve\(false\)/);
 assert.match(source,/if\(process\.platform!=='linux'\)return Promise\.resolve\(true\)/);
 assert.match(source,/resolve\(!error&&\/\\btrue\\b\/\.test\(String\(stdout\)\)\)/);
 // The Settings dialog reads the pair from the broadcast, which now carries it, and the
 // broadcast carries no server choice beside it.
 assert.match(source,/game:gameState\(\),settings,shortcuts:shortcutState,launcherUpdate/,'the state broadcast publishes settings, the game server and the two shortcut entries');
 assert.equal(/servers:/.test(source),false,'and no server list');
 // This line pinned the literal `accounts:[],settings,totalMemoryMB` in the status answer
 // until the account list was deleted from the state contract (doc/launcher-states.md,
 // "Provider account state"); what it was here for is that the status the Settings dialog
 // reads on open carries the settings and the memory total. The absent account list is
 // asserted rather than required, so the vestige cannot come back through this line.
 assert.match(source,/sessionExpiresAt:company\?\.expiresAt\|\|null,settings,totalMemoryMB/,'and so does the status the dialog reads on open');
 assert.equal(/accounts:\[\]/.test(source),false,'and it publishes no account list, only the one signed-in account');
 // No new privileged surface: the preferences ride on the existing settings channel.
 const preload=await fs.readFile(path.join(__dirname,'../../desktop/preload.cjs'),'utf8');
 assert.match(preload,/saveSettings:invoke\('settings'\)/);
 assert.equal(/tray/i.test(preload),false,'the renderer gets no tray channel of its own');
});
