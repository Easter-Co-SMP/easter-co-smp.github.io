const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {update,selected,validate,compare,relaunchOptions,classify,clearPlan,CLEAR,withinDataDirectory,clearForLevel,applyVersionPolicy,UpdateLog}=require('../../desktop/updater.cjs');
const bytes=Buffer.from('complete application payload'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
const manifest={schema:1,bootstrap:1,version:'1.0.12',platform:'linux',arch:'x64',runtime:'44.7.2',asset:'Easter-Company-Update-linux-x64.asar',size:bytes.length,sha256:sha};
const context={release:'1.0.12',platform:'linux',arch:'x64',runtime:'44.7.2'};
const fetchFor=(payload=bytes,meta=manifest)=>async url=>{
 if(url.endsWith('/latest'))return Response.json({tag_name:'launcher-v1.0.12'});
 if(url.endsWith('.json'))return Response.json(meta);
 return new Response(payload,{headers:{'content-length':String(payload.length)}});
};
async function fixture(run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'updater-test-'));try{await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
test('strict version comparison never calls the same version newer',()=>{
 assert.equal(compare('1.0.10','1.0.10'),0);assert.equal(compare('1.0.10','1.0.9'),1);assert.equal(compare('1.0.9','1.0.10'),-1);
 for(const version of ['launcher-v1.0.10','1.0.10junk','1.0','999999999999999999999999.0.0'])assert.throws(()=>compare(version,'1.0.10'));
});
test('manifest pins device, runtime, protocol and exact asset; paths cannot escape',()=>{
 assert(validate(manifest,context).url.endsWith('/launcher-v1.0.12/'+manifest.asset));
 for(const patch of [{platform:'win32'},{arch:'arm64'},{runtime:'45.0.0'},{bootstrap:2},{asset:'../../other.asar'},{size:0},{size:201*1024*1024},{sha256:'wrong'},{version:'1.0.13'}])assert.throws(()=>validate({...manifest,...patch},context));
});
test('verified payload activates atomically and bootstrap selects it',()=>fixture(async root=>{
 const phases=[];
 const target=await update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch:fetchFor(),notify:s=>phases.push(s.phase)});
 assert.deepEqual(await fs.readFile(target),bytes);assert.equal(JSON.parse(await fs.readFile(path.join(root,'current.json'))).version,'1.0.12');
 assert(phases.includes('downloading')&&phases.includes('verifying'));assert.equal(phases.at(-1),'restarting');
 assert.equal(selected(root,{bundled:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64'}),target);
 await fs.writeFile(target,'corrupt');
 assert.equal(selected(root,{bundled:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64'}),null);
}));
test('corrupt, truncated, oversized and interrupted downloads preserve previous selection',()=>fixture(async root=>{
 await fs.writeFile(path.join(root,'current.json'),'{"previous":true}');
 for(const payload of [Buffer.from('bad'),Buffer.alloc(bytes.length+1),Buffer.alloc(bytes.length)]){
  const fetch=async url=>url.endsWith('.asar')?new Response(payload):fetchFor()(url);
  await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch}));
  assert.equal(await fs.readFile(path.join(root,'current.json'),'utf8'),'{"previous":true}');
 }
 const stream=new ReadableStream({start(c){c.enqueue(bytes.subarray(0,3));c.error(Error('connection lost'));}});
 const fetch=async url=>url.endsWith('.asar')?new Response(stream):fetchFor()(url);
 await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch}));
 assert.equal((await fs.readdir(root)).filter(file=>file.endsWith('.part')).length,0);
}));
test('failed identity inspection never activates otherwise valid bytes',()=>fixture(async root=>{
 await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch:fetchFor(),inspect(){throw Error('wrong identity');}}));
 await assert.rejects(fs.stat(path.join(root,'current.json')));
}));
test('network and malformed feed errors propagate; no optional-update fallback',()=>fixture(async root=>{
 for(const fetch of [async()=>{throw Error('offline');},async()=>Response.json({tag_name:'bad'}),async()=>new Response('',{status:503})])
  await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',root,fetch}));
}));
test('current release downloads nothing and AppImage relaunch preserves original executable',()=>fixture(async root=>{
 let calls=0;
 assert.equal(await update({current:'1.0.12',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch:async()=>{calls++;return Response.json(manifest);}}),null);assert.equal(calls,1);
 assert.deepEqual(relaunchOptions({platform:'linux',env:{APPIMAGE:'/apps/Launcher.AppImage'},execPath:'/tmp/mount/app'}),{execPath:'/apps/Launcher.AppImage',args:[]});
 assert.deepEqual(relaunchOptions({platform:'win32',env:{},execPath:'C:\\Launcher.exe'}),{execPath:'C:\\Launcher.exe',args:[]});
}));

// ---- how big a version change is, and what it may clear ----------------------
// Every member of the clear list, with a file inside, plus the things a clear must never
// touch: the player's settings, the three session vaults, the two other logs, a directory
// the launcher did not create, a tree the player put somewhere else, and the world save and
// screenshots inside the managed client tree.
const CACHE_NAMES=['minecraft','launcher-updates','Cache','Code Cache','GPUCache','DawnGraphiteCache','DawnWebGPUCache','ShaderCache','GrShaderCache','blob_storage','Local Storage','Session Storage','WebStorage','signin.log'];
const VAULT_NAMES=['accounts.enc','company.enc','account.enc'];
async function launcherData(root){
 await fs.mkdir(root,{recursive:true});
 for(const name of CACHE_NAMES.filter(name=>name!=='signin.log')){
  await fs.mkdir(path.join(root,name,'inside'),{recursive:true});
  await fs.writeFile(path.join(root,name,'inside','payload'),'cache '+name);
 }
 await fs.mkdir(path.join(root,'Dictionaries'),{recursive:true});
 await fs.mkdir(path.join(root,'minecraft','saves','Easter','world'),{recursive:true});
 await fs.mkdir(path.join(root,'minecraft','screenshots'),{recursive:true});
 const files={
  'settings.json':'{"memoryMB":4096,"includeGraphics":false}',
  'accounts.enc':'SECRET-MICROSOFT-ACCOUNT',
  'company.enc':'SECRET-COMPANY-SESSION',
  'account.enc':'SECRET-LEGACY-ACCOUNT',
  'signin.log':'2026-10-19T00:00:00.000Z v1.0.27 step=exchange outcome=ok http=200 code=-\n',
  'install.log':'2026-10-19T00:00:00.000Z v1.0.27 step=launcher-update outcome=failed http=503 code=-\n',
  'player-notes.txt':'the player wrote this',
  'Dictionaries/en-US.dic':'a dialect dictionary Chromium keeps',
  'minecraft/.easter-client':'2026-10-19T00:00:00.000Z\n',
  'minecraft/installed.json':'{"version":"1.21","mod":"fabric"}',
  'minecraft/options.txt':'fov:70\n',
  'minecraft/saves/Easter/world/level.dat':'THE PLAYER BUILT THIS',
  'minecraft/screenshots/2026-10-19_00.00.00.png':'A PICTURE THE PLAYER TOOK',
  'launcher-updates/current.json':JSON.stringify({...manifest,version:'1.1.0'}),
  ['launcher-updates/'+sha+'.asar']:'the staged launcher payload',
  ['launcher-updates/'+'a'.repeat(64)+'.asar']:'an older launcher payload'
 };
 for(const [name,body] of Object.entries(files))await fs.writeFile(path.join(root,name),body);
 return root;
}
// A whole-tree fingerprint: relative path, then type, size and content hash or link target.
async function snapshot(root){
 const out={};
 async function walk(dir){
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
   const full=path.join(dir,entry.name),relative=path.relative(root,full);
   if(entry.isSymbolicLink())out[relative]='-> '+await fs.readlink(full);
   else if(entry.isDirectory()){out[relative]='/';await walk(full);}
   else{const stat=await fs.stat(full);out[relative]=stat.size+':'+crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');}
  }
 }
 await walk(root);
 return out;
}
const today=()=>new Date('2026-10-19T12:00:00.000Z');
const decisionLog=root=>new UpdateLog({file:path.join(root,'launcher-update.log'),version:'1.0.28',now:today});
const exists=async file=>{try{await fs.lstat(file);return true;}catch{return false;}};

test('the classifier decides the level from the numbers that moved, and nothing else',()=>{
 // The matrix Owen's rule needs: only the third number moved, the second and not the first,
 // or the first. Nothing else about a release can raise the level.
 assert.equal(classify('1.0.27','1.0.28'),'patch');
 assert.equal(classify('1.0.27','1.1.0'),'minor');
 assert.equal(classify('1.0.27','2.0.0'),'major');
 assert.equal(classify('1.2.3','1.9.0'),'minor');
 assert.equal(classify('1.9.9','2.0.0'),'major');
 assert.equal(classify('0.0.1','10.0.0'),'major');
 // Equal versions move nothing, so nothing is justified; a same-field downgrade is the
 // same answer, and update() never applies a non-increase in the first place.
 assert.equal(classify('1.0.27','1.0.27'),'patch');
 assert.equal(classify('1.0.28','1.0.27'),'patch');
 // A downgrade across a field is decided by that field, and clearing more is the safe answer.
 assert.equal(classify('1.1.0','1.0.9'),'minor');
 assert.equal(classify('2.0.0','1.9.9'),'major');
 // A version it cannot read is refused by name, not guessed at.
 for(const bad of ['1.0','1.0.28junk','launcher-v1.0.28','','1.0.-1','v1.0.28',null,undefined,'999999999999999999999.0.0'])
  assert.throws(()=>classify(bad,'1.0.28'),error=>error.name==='LauncherVersionError'&&error.code==='invalid-version'&&/Invalid launcher release version/.test(error.message));
 assert.throws(()=>classify('1.0.27',{}),error=>error.code==='invalid-version');
});

test('the clear list is one table, does not escape the data directory, and says why per member',()=>{
 const dataRoot=path.resolve('/home/example/.config/Easter Company');
 const seen=new Set();
 for(const entry of CLEAR){
  assert.match(entry.name,/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,entry.name+' must be one path segment');
  assert.equal(seen.has(entry.name),false,'duplicate clear member '+entry.name);seen.add(entry.name);
  assert.ok(entry.level==='minor'||entry.level==='major',entry.name+' carries no level');
  assert.ok(entry.why.length>60,entry.name+' must justify itself');
  // The resolved path of every member is a direct child of the data directory.
  assert.equal(path.dirname(withinDataDirectory(dataRoot,entry.name)),dataRoot);
  assert.equal(path.relative(dataRoot,withinDataDirectory(dataRoot,entry.name)).includes(path.sep),false);
 }
 assert.deepEqual(clearPlan('patch'),[]);
 assert.deepEqual(clearPlan('minor').map(entry=>entry.name),['minecraft','launcher-updates','Cache','Code Cache','GPUCache','DawnGraphiteCache','DawnWebGPUCache','ShaderCache','GrShaderCache','blob_storage','Local Storage','Session Storage','WebStorage','signin.log']);
 assert.deepEqual(clearPlan('major').map(entry=>entry.name).slice(-3),VAULT_NAMES);
 assert.equal(clearPlan('major').length,CLEAR.length);
 assert.throws(()=>clearPlan('1.1.0'),/Unknown launcher update level/);
 assert.throws(()=>clearPlan(undefined),/Unknown launcher update level/);
 // A name that is not a single segment, or that resolves anywhere but inside, is refused.
 for(const name of ['..','.','','/etc/passwd','../../etc/passwd','minecraft/../../escape','a/b','..\\escape','\0'])
  assert.throws(()=>withinDataDirectory(dataRoot,name),error=>error.code==='refused'&&error.name==='ClearRefusalError'&&/outside the launcher data directory/.test(error.message),JSON.stringify(name));
 assert.throws(()=>withinDataDirectory('','Cache'),/data directory is required/);
});

test('a patch-only update touches nothing at all',()=>fixture(async dataRoot=>{
 await launcherData(dataRoot);
 const before=await snapshot(dataRoot);
 const touched=[],read=[];
 const result=await applyVersionPolicy({from:'1.0.27',to:'1.0.28',dataRoot,filesystem:{readdir:async(...args)=>{read.push(args[0]);return fs.readdir(...args);}},remove:(target,options)=>{touched.push(target);return fs.rm(target,options);},log:decisionLog(dataRoot)});
 assert.equal(result.level,'patch');
 assert.deepEqual(result.cleared,[]);
 // Asserted, not merely left untested: not one path is removed, and not one directory is
 // even read, so a patch cannot clear anything by any route.
 assert.deepEqual(touched,[]);
 assert.deepEqual(read,[]);
 const after=await snapshot(dataRoot);
 delete after['launcher-update.log'];
 assert.deepEqual(after,before,'nothing but the decision log changes');
}));

test("the player's drawings are never cleared, at any level",()=>{
 // IndexedDB holds the map's drawing layer. A drawing is content the player made, not a copy
 // of something we published, so no upgrade level may delete it: a minor that wiped the
 // family's drawings would be the worst kind of silent data loss.
 for(const level of ['patch','minor','major'])assert.equal(clearPlan(level).some(entry=>entry.name==='IndexedDB'),false,level);
 assert(!CACHE_NAMES.includes('IndexedDB'));
});

test('a minor update clears the cache and keeps the settings and the session',()=>fixture(async dataRoot=>{
 await launcherData(dataRoot);
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'updater-outside-'));
 try{
  await fs.writeFile(path.join(outside,'player-world.dat'),'NOT THE LAUNCHER’S');
  const log=decisionLog(dataRoot);
  const result=await applyVersionPolicy({from:'1.0.27',to:'1.1.0',dataRoot,log});
  assert.equal(result.level,'minor');
  assert.deepEqual(result.cleared,clearPlan('minor').map(entry=>entry.name));
  for(const name of CACHE_NAMES.filter(name=>name!=='minecraft'&&name!=='launcher-updates'))assert.equal(await exists(path.join(dataRoot,name)),false,name+' must be cleared by a minor update');
  // The stash keeps only the record and the payload the relaunch is about to load: removing
  // those would relaunch into the version being replaced and re-download the update forever.
  assert.deepEqual((await fs.readdir(path.join(dataRoot,'launcher-updates'))).sort(),[sha+'.asar','current.json']);
  // The managed client tree goes one level deep, so the marker and what the player made in
  // it survive while every file the installer wrote is gone.
  assert.deepEqual((await fs.readdir(path.join(dataRoot,'minecraft'))).sort(),['.easter-client','saves','screenshots']);
  assert.equal(await fs.readFile(path.join(dataRoot,'minecraft','saves','Easter','world','level.dat'),'utf8'),'THE PLAYER BUILT THIS');
  assert.equal(await fs.readFile(path.join(dataRoot,'minecraft','screenshots','2026-10-19_00.00.00.png'),'utf8'),'A PICTURE THE PLAYER TOOK');
  assert.equal(await exists(path.join(dataRoot,'minecraft','installed.json')),false);
  // The minimum user state, and everything not on the list.
  for(const name of ['settings.json',...VAULT_NAMES,'install.log','player-notes.txt','Dictionaries','launcher-update.log'])
   assert.equal(await exists(path.join(dataRoot,name)),true,name+' must survive a minor update');
  assert.equal(await fs.readFile(path.join(dataRoot,'settings.json'),'utf8'),'{"memoryMB":4096,"includeGraphics":false}');
  assert.equal(await fs.readFile(path.join(outside,'player-world.dat'),'utf8'),'NOT THE LAUNCHER’S');
  // One line per decision, carrying the from/to pair and the level, and no credential.
  const lines=(await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8')).trimEnd().split('\n');
  assert.equal(lines.length,1);
  assert.match(lines[0],/^2026-10-19T12:00:00\.000Z v1\.0\.28 step=update-policy outcome=ok level=minor from=1\.0\.27 to=1\.1\.0 cleared=minecraft\|launcher-updates\|Cache\|Code Cache\|/);
  assert.equal(/SECRET|TOKEN|\//.test(lines[0]),false,'a decision line carries no credential and no path');
 }finally{await fs.rm(outside,{recursive:true,force:true});}
}));

test('a major update also removes the stored session, and nothing else of the player’s',()=>fixture(async dataRoot=>{
 await launcherData(dataRoot);
 const result=await applyVersionPolicy({from:'1.0.27',to:'2.0.0',dataRoot,log:decisionLog(dataRoot)});
 assert.equal(result.level,'major');
 for(const name of [...CACHE_NAMES.filter(name=>name!=='minecraft'&&name!=='launcher-updates'),...VAULT_NAMES])assert.equal(await exists(path.join(dataRoot,name)),false,name+' must be cleared by a major update');
 assert.deepEqual((await fs.readdir(path.join(dataRoot,'launcher-updates'))).sort(),[sha+'.asar','current.json']);
 assert.deepEqual((await fs.readdir(path.join(dataRoot,'minecraft'))).sort(),['.easter-client','saves','screenshots']);
 // Signing in again is the point; the player's own files are not collateral.
 for(const name of ['settings.json','install.log','player-notes.txt','Dictionaries','launcher-update.log'])
  assert.equal(await exists(path.join(dataRoot,name)),true,name+' must survive a major update');
 assert.equal(await fs.readFile(path.join(dataRoot,'minecraft','saves','Easter','world','level.dat'),'utf8'),'THE PLAYER BUILT THIS');
 assert.match(await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8'),/level=major from=1\.0\.27 to=2\.0\.0 cleared=.*accounts\.enc\|company\.enc\|account\.enc/);
}));

test('a listed entry that is a link is removed as a link, never followed out of the data directory',()=>fixture(async dataRoot=>{
 await launcherData(dataRoot);
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'updater-link-'));
 try{
  await fs.writeFile(path.join(outside,'keep.txt'),'NOT THE LAUNCHER’S');
  await fs.rm(path.join(dataRoot,'Cache'),{recursive:true});
  await fs.rm(path.join(dataRoot,'minecraft','mods'),{recursive:true,force:true});
  await fs.symlink(outside,path.join(dataRoot,'Cache'));
  await fs.symlink(outside,path.join(dataRoot,'minecraft','mods'));
  const result=await clearForLevel('minor',{dataRoot});
  assert.equal(result.level,'minor');
  assert.equal(await exists(path.join(dataRoot,'Cache')),false);
  assert.equal(await exists(path.join(dataRoot,'minecraft','mods')),false);
  // The target of neither link was entered: clearing refuses to leave the data directory.
  assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'NOT THE LAUNCHER’S');
 }finally{await fs.rm(outside,{recursive:true,force:true});}
}));

test('a locked member is reported and the rest of the clear still happens',()=>fixture(async dataRoot=>{
 await launcherData(dataRoot);
 const log=decisionLog(dataRoot);
 // Windows is the real case: a payload the old process still has open cannot be removed.
 const result=await applyVersionPolicy({from:'1.0.27',to:'1.1.0',dataRoot,log,remove:async(target,options)=>{
  if(target.includes('launcher-updates'+path.sep)){const error=Error('busy');error.code='EBUSY';throw error;}
  return fs.rm(target,options);
 }});
 assert.equal(result.level,'minor');
 assert.deepEqual(result.cleared.includes('launcher-updates'),false);
 assert.deepEqual(result.failed,[{name:'launcher-updates',code:'EBUSY'}]);
 assert.equal(await exists(path.join(dataRoot,'Cache')),false,'one locked member does not stop the others');
 // One decision, one line, and it says what actually happened.
 const lines=(await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8')).trimEnd().split('\n');
 assert.equal(lines.length,1);
 assert.match(lines[0],/outcome=failed level=minor from=1\.0\.27 to=1\.1\.0 cleared=minecraft\|/);
 assert.match(lines[0],/failed=launcher-updates note=EBUSY/);
}));

test('a stash with no readable record is left alone and says so',()=>fixture(async dataRoot=>{
 await launcherData(dataRoot);
 await fs.writeFile(path.join(dataRoot,'launcher-updates','current.json'),'not json');
 const before=await fs.readdir(path.join(dataRoot,'launcher-updates'));
 const result=await applyVersionPolicy({from:'1.0.27',to:'1.1.0',dataRoot,log:decisionLog(dataRoot)});
 assert.deepEqual(result.skipped,['launcher-updates']);
 assert.deepEqual((await fs.readdir(path.join(dataRoot,'launcher-updates'))).sort(),before.sort(),'nothing leaves a stash it cannot account for');
 assert.match(await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8'),/skipped=launcher-updates/);
}));

test('the decision log is bounded, redacted and rotates rather than growing',()=>fixture(async dataRoot=>{
 const log=new UpdateLog({file:path.join(dataRoot,'launcher-update.log'),version:'1.0.28',maxBytes:220,now:today});
 for(const version of ['1.1.0','1.2.0','1.3.0'])log.append({from:'1.0.27',to:version,level:'minor',cleared:['Cache']});
 assert.equal(await exists(path.join(dataRoot,'launcher-update.log.1')),true);
 // Nothing that is not a version, a level or one of the allowlist's own names is written:
 // a path, a Windows path with a token in it and a URL each collapse to `-`.
 log.append({from:'C:\\Users\\owen\\token=eyJhbGciOi',to:'https://example.test/AKIA',level:'minor',cleared:['../../etc/passwd','a/b']});
 const everything=(await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8'))+(await fs.readFile(path.join(dataRoot,'launcher-update.log.1'),'utf8'));
 assert.equal(/eyJhbGciOi|AKIA|Users|passwd|a\/b|example\.test/.test(everything),false,'a value outside the vocabulary is written as -, never as itself');
 assert.match(everything,/from=- to=- cleared=-/);
 // A level it does not know is not echoed either.
 log.append({from:'1.0.27',to:'1.1.0',level:'catastrophic',cleared:[]});
 assert.match(await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8'),/level=- from=1\.0\.27 to=1\.1\.0 cleared=-/);
}));


test('a shortcut Play request survives launcher-update relaunch without forwarding other arguments',()=>{
 for(const platform of ['linux','win32']){
  const options={platform,env:{APPIMAGE:'/apps/Launcher.AppImage'},execPath:'/bin/launcher',argv:['/bin/launcher','--play','--play','untrusted-value','--play=1','--no-sandbox']};
  assert.deepEqual(relaunchOptions(options),{execPath:platform==='linux'?'/apps/Launcher.AppImage':'/bin/launcher',args:['--no-sandbox','--play']});
  assert.deepEqual(relaunchOptions({...options,argv:['/bin/launcher','--play=1']}).args,[]);
  assert.deepEqual(relaunchOptions({...options,argv:['/bin/launcher','--play']}).args,['--play']);
 }
});
