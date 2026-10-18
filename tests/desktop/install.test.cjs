const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {downloadVerified,publishedManifest,setFailureLog,launchOptions,generateArguments}=require('../../desktop/install.cjs');
const updater=require('../../desktop/updater.cjs');
const {SignInLog}=require('../../desktop/auth.cjs');
const {localFile,cleanSettings,publicProfile,externalURL,trustedFrame}=require('../../desktop/security.cjs');
test('download checksum mismatch preserves last good file; retries atomically replace it',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easter-download-test-'));const file=path.join(dir,'client.jar'),original=global.fetch;
 await fs.writeFile(file,'previous');const data=Buffer.from('verified'),hash=crypto.createHash('sha256').update(data).digest('hex');
 try{
  global.fetch=async()=>new Response('corrupt');
  await assert.rejects(downloadVerified('https://cdn.modrinth.com/test.jar',file,hash),/checksum/);assert.equal(await fs.readFile(file,'utf8'),'previous');assert.deepEqual(await fs.readdir(dir),['client.jar']);
  global.fetch=async()=>new Response(data);
  assert.equal(await downloadVerified('https://cdn.modrinth.com/test.jar',file,hash),true);
  assert.equal(await fs.readFile(file,'utf8'),'verified');
  global.fetch=()=>{throw Error('should use verified cache');};
  assert.equal(await downloadVerified('https://cdn.modrinth.com/test.jar',file,hash),false);
 }finally{global.fetch=original;await fs.rm(dir,{recursive:true,force:true});}
});
test('only safe app paths and HTTPS external links are accepted',()=>{
 assert.equal(localFile('easter://easter/map/map.js','/app/site'),'/app/site/map/map.js');
 assert.throws(()=>localFile('https://easter/map','/app/site'));assert.throws(()=>localFile('easter://easter/%2f..%2fprivate','/app/site'));assert.throws(()=>localFile('easter://easter/map%5c..%5cprivate','/app/site'));
 assert.equal(externalURL('https://modrinth.com/'),'https://modrinth.com/');
 for(const url of ['file:///etc/passwd','javascript:alert(1)','https://user:password@example.com/'])assert.throws(()=>externalURL(url));
 const main={url:'easter://easter/'};assert(trustedFrame({senderFrame:main,sender:{mainFrame:main}}));assert(!trustedFrame({senderFrame:{url:'easter://easter/'},sender:{mainFrame:main}}));
});
test('settings reject command strings; public account view omits all tokens',()=>{
 assert.deepEqual(cleanSettings({memoryMB:4096,server:'play.example.com:25565',javaPath:''}),{memoryMB:4096,server:'play.example.com:25565',javaPath:'',autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false,trayOnLaunch:false,desktopShortcut:false,startMenuShortcut:false});
 // Update opt-outs, including legacy false values, cannot disable mandatory updates.
 assert.deepEqual(
  (({autoUpdateLauncher,autoUpdateGame,exitOnLaunch})=>({autoUpdateLauncher,autoUpdateGame,exitOnLaunch}))(
   cleanSettings({memoryMB:4096,server:'',autoUpdateLauncher:false,autoUpdateGame:false,exitOnLaunch:false})),
  {autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false});
 assert.deepEqual(
  (({autoUpdateLauncher,autoUpdateGame,exitOnLaunch})=>({autoUpdateLauncher,autoUpdateGame,exitOnLaunch}))(
   cleanSettings({memoryMB:4096,server:'',autoUpdateLauncher:'yes',autoUpdateGame:0,exitOnLaunch:null})),
  {autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false});
 for(const server of ['host;rm -rf /','$(command)','server:65536','--argument'])assert.throws(()=>cleanSettings({memoryMB:4096,server}));
 assert.throws(()=>cleanSettings({memoryMB:90000,server:''}));assert.throws(()=>cleanSettings({memoryMB:4096,server:'',javaPath:'/bin/bash'}));
 const profile=publicProfile({profile:{id:'test',name:'Captain',accessToken:'private'},accessToken:'secret'});assert.deepEqual(profile,{id:'test',name:'Captain',skin:null});
});
test('launch arguments carry the authenticated identity and Quick Play without a shell',async()=>{
 const session={profile:{id:'1234567890abcdef1234567890abcdef',name:'Captain'},accessToken:'test-secret',clientId:'easter-app',xuid:'1234'};
 const version={id:'fabric-test',minecraftVersion:'26.2',type:'release',assets:'26',mainClass:'net.fabricmc.loader.impl.launch.knot.KnotClient',libraries:[],arguments:{jvm:['-cp','${classpath}'],game:['--username','${auth_player_name}','--accessToken','${auth_access_token}','--clientId','${clientid}','--xuid','${auth_xuid}']}};
 const options=launchOptions({root:'/tmp/easter-game',version,javaPath:'/java/bin/java',session,settings:{memoryMB:4096,server:'server.example:25565'}});
 const args=await generateArguments(options);
 assert.equal(options.extraExecOption.shell,false);assert(args.includes('test-secret'));assert(args.includes('Captain'));assert(args.includes('easter-app'));assert(args.includes('1234'));assert(args.includes('--quickPlayMultiplayer'));assert(args.includes('server.example:25565'));assert(!args.some(arg=>arg.includes('${')));
});
// The player reads what stopped and what to do about it; the status they cannot act on is kept where
// a failure is diagnosable instead (doc/launcher-states.md, "One verb, and sentences that carry no
// status"). Both halves are asserted here: the sentence, and the one redacted line per failure in
// the launcher's install record. The record is the class the sign-in already uses, so the line shape
// is the sign-in's: timestamp, version, step, outcome, HTTP status, provider code, host.
test('a download or update failure carries no status in its sentence and one line in the install log',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easter-fault-test-'));
 const logPath=path.join(dir,'install.log'),log=new SignInLog({file:logPath,version:'1.0.21'});
 const original=global.fetch;
 // No HTTP status, no XErr number and no provider code may reach the player. The same rule as the
 // sign-in sentences, checked against the whole sentence rather than a substring.
 const JARGON=/HTTP\s*\d|XErr|invalid_[a-z]|\b[45]\d{2}\b/i;
 const lines=async()=>{try{return (await fs.readFile(logPath,'utf8')).trim().split('\n').filter(Boolean);}catch{return [];}};
 const faults=[];
 const failure=async(run,expected)=>{
  await assert.rejects(run,error=>{
   assert(!JARGON.test(error.message),'the sentence the player reads carries no status: '+error.message);
   assert.equal(error.message,expected.message);
   assert.equal(error.httpStatus,expected.httpStatus);
   assert.equal(error.step,expected.step);
   if(expected.host)assert.equal(error.host,expected.host);
   faults.push(error);return true;
  });
 };
 setFailureLog(log);updater.setFailureLog(log);
 try{
  // 1. The client-data request: the host stays in the sentence because it is the source, the status
  //    does not.
  global.fetch=async()=>new Response('nope',{status:404});
  await failure(()=>publishedManifest('https://easter-co-smp.github.io'),{message:'Could not download easter-co-smp.github.io data. Try again.',httpStatus:404,step:'data',host:'easter-co-smp.github.io'});
  // 2. A download that stopped, and 3. a resumed one the source would not continue.
  const stopped=path.join(dir,'stopped.jar');
  global.fetch=async()=>new Response('nope',{status:503});
  await failure(()=>downloadVerified('https://cdn.modrinth.com/stopped.jar',stopped,'0'.repeat(64)),{message:'The download stopped before it finished. Your installed files are unchanged.',httpStatus:503,step:'download',host:'cdn.modrinth.com'});
  const resumed=path.join(dir,'resumed.jar'),prefix=Buffer.from('partial-bytes');
  const hash=crypto.createHash('sha256').update(Buffer.concat([prefix,Buffer.from('rest')])).digest('hex');
  await fs.writeFile(resumed+'.part',prefix);
  await fs.writeFile(resumed+'.part.json',JSON.stringify({url:'https://cdn.modrinth.com/resumed.jar',hash,algorithm:'sha256'}));
  global.fetch=async()=>new Response('no',{status:403});
  await failure(()=>downloadVerified('https://cdn.modrinth.com/resumed.jar',resumed,hash),{message:'The download could not be resumed. Your installed files are unchanged.',httpStatus:403,step:'resume',host:'cdn.modrinth.com'});
  // 4. The launcher update check, and 5. the launcher update download.
  global.fetch=async()=>new Response('',{status:500});
  await failure(()=>updater.update({current:'1.0.20',runtime:'44.7.2',platform:'linux',arch:'x64',root:path.join(dir,'updates'),fetch:global.fetch}),{message:'The launcher update could not be checked. Check your connection and try again.',httpStatus:500,step:'launcher-update',host:'github.com'});
  global.fetch=async()=>new Response('',{status:503});
  await failure(()=>updater.stage({version:'1.0.21',platform:'linux',arch:'x64',sha256:'a'.repeat(64),size:1024,asset:'Easter-Company-Update-linux-x64.asar',url:'https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/download/launcher-v1.0.21/Easter-Company-Update-linux-x64.asar'},{root:path.join(dir,'staged'),fetch:global.fetch}),{message:'The launcher update could not be downloaded. Try again.',httpStatus:503,step:'launcher-asset',host:'github.com'});
  // One failure, one line. That is the promise the sign-in log makes, and the reason a burst of
  // retries cannot fill the file.
  const written=(await lines());
  assert.equal(written.length,faults.length,'one line per failure, and nothing else writes here');
  for(const [index,expected] of [['data',404,'easter-co-smp.github.io'],['download',503,'cdn.modrinth.com'],['resume',403,'cdn.modrinth.com'],['launcher-update',500,'github.com'],['launcher-asset',503,'github.com']].entries()){
   const pattern=new RegExp('^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z v1\\.0\\.21 step='+expected[0]+' outcome=failed http='+expected[1]+' code=- note='+expected[2].replace(/\./g,'\\.')+'$');
   assert.match(written[index],pattern,'line '+(index+1)+' carries the status and the host/step: '+written[index]);
   assert.equal(faults[index].httpStatus,expected[1],'the error still carries the status it kept off the sentence');
  }
  // The sentence and the line are for two different readers, and neither carries a token, a URL
  // path or a response body.
  assert(!written.join('\n').includes('nope'),'no response body reaches the record');
  assert(!faults.some(fault=>JSON.stringify(Object.keys(fault)).includes('body')),'no body rides on the error either');
 }finally{
  global.fetch=original;setFailureLog(null);updater.setFailureLog(null);
  await fs.rm(dir,{recursive:true,force:true});
 }
});
test('the install record stays opt-in, redacted and bounded exactly like the sign-in log',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easter-fault-log-'));
 const logPath=path.join(dir,'install.log');
 const original=global.fetch;
 setFailureLog(null);updater.setFailureLog(null);
 try{
  // No record handed in: the failure still carries its status, and nothing is written anywhere.
  // That is what an older main process sees, and it must never be worse than before the change.
  global.fetch=async()=>new Response('',{status:502});
  await assert.rejects(publishedManifest('https://easter-co-smp.github.io'),error=>error.httpStatus===502);
  await assert.rejects(fs.stat(logPath));
  // Bounded like signin.log: a line that would pass the cap rotates the file once, so at most two
  // files exist however often the launcher fails.
  const small=new SignInLog({file:logPath,version:'1.0.21',maxBytes:200});
  setFailureLog(small);
  for(let attempt=0;attempt<20;attempt++)await assert.rejects(publishedManifest('https://easter-co-smp.github.io'),error=>error.httpStatus===502);
  const files=(await fs.readdir(dir)).filter(name=>name.startsWith('install.log')).sort();
  assert.deepEqual(files,['install.log','install.log.1'],'one rotation, never a growing history');
  const text=await fs.readFile(logPath,'utf8');
  assert(!/token|Bearer|https?:\/\//i.test(text),'the record holds no token and no URL: '+text);
 }finally{
  global.fetch=original;setFailureLog(null);
  await fs.rm(dir,{recursive:true,force:true});
 }
});
