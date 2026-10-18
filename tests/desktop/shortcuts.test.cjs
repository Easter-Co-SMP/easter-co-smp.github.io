// The game shortcut, as pure rules: the argument it passes, the two places its files
// live, the desktop entry it writes and the decision about whether a shortcut click may
// start a game. Nothing here needs Electron, a desktop or a display.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {AUTO_START_ARG,ENTRY_NAME,ENTRY_MARKER,APP_USER_MODEL_ID,ICON_FILE,wantsAutoStart,autoStartDecision,shortcutSupport,shortcutTargets,execLine,desktopEntry,shortcutDetails,readGameShortcuts,applyGameShortcuts}=require('../../desktop/shortcuts.cjs');
const {cleanSettings,cleanShortcutPreferences}=require('../../desktop/security.cjs');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFile(path.join(root,file),'utf8');
// Every credential-shaped word the launcher handles. A shortcut is world-readable text
// the desktop runs, so none of them may ever appear in one.
const SECRETS=['token','bearer','authorization','xbox','password','clientid','xuid','@'];

async function home(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easter-shortcut-'));
 await fs.mkdir(path.join(dir,'Desktop'),{recursive:true});
 await fs.mkdir(path.join(dir,'.local','share'),{recursive:true});
 return dir;
}
const options=(dir,extra={})=>({platform:'linux',home:dir,env:{},executable:'/opt/Easter Co. Launcher/easter-company',icon:{source:path.join(root,'desktop','launcher-icon.png'),target:path.join(dir,'easter-co-game.png')},...(extra.desktop===undefined&&extra.startMenu===undefined?{desktop:true,startMenu:true}:{}),...extra});

test('the shortcut passes one explicit auto-start argument and nothing else',async()=>{
 assert.equal(AUTO_START_ARG,'--play');
 assert.equal(wantsAutoStart(['electron','desktop/main.cjs','--play']),true);
 // The flag is matched as a whole argument: a value that merely starts with it is not it.
 for(const argv of [[],['electron'],['--play=1'],['--plays'],['-play'],['--Play'],[null],['--no-sandbox','desktop/main.cjs']])assert.equal(wantsAutoStart(argv),false,JSON.stringify(argv));
 assert.equal(wantsAutoStart(undefined),false);
 assert.equal(wantsAutoStart('--play'),false);
});

test('the desktop entry runs the launcher, never Minecraft, and carries no credential',async()=>{
 const text=desktopEntry({executable:'/opt/Easter Co. Launcher/easter-company',icon:'/home/player/.config/Easter Company/easter-co-game.png'});
 const lines=text.split('\n');
 assert.equal(lines[0],'[Desktop Entry]');
 assert.ok(text.endsWith('\n'),'the file ends with a newline');
 assert.match(text,/^Type=Application$/m);
 assert.match(text,new RegExp('^Name='+ENTRY_NAME+'$','m'));
 assert.match(text,/^Terminal=false$/m);
 assert.match(text,/^Categories=Game;$/m);
 assert.match(text,new RegExp('^'+ENTRY_MARKER+'$','m'));
 // The target is the launcher, quoted because its path has a space, and the only argument
 // is the auto-start flag. There is no Minecraft class, jar or version anywhere in it.
 assert.match(text,/^Exec="\/opt\/Easter Co\. Launcher\/easter-company" --play$/m);
 assert.match(text,/^Icon=\/home\/player\/\.config\/Easter Company\/easter-co-game\.png$/m);
 assert.equal(/--username|--uuid|--accessToken|--version|net\.minecraft|\.jar/i.test(text),false,'the entry names no client, jar or account argument');
 const leaked=SECRETS.filter(word=>text.toLowerCase().includes(word));
 assert.deepEqual(leaked,[],'no credential-shaped word reaches the entry');
 // The entry is the same for both locations: the launcher writes one file shape.
 assert.equal(desktopEntry({executable:'/opt/Easter Co. Launcher/easter-company',icon:'/x.png'}),desktopEntry({executable:'/opt/Easter Co. Launcher/easter-company',icon:'/x.png'}));
 assert.equal(desktopEntry({executable:'/usr/bin/easter-company'}).includes('Icon='),false,'no icon line is invented when there is no icon to point at');
 assert.match(desktopEntry({executable:'/usr/bin/easter-company'}),/^Exec=\/usr\/bin\/easter-company --play$/m,'a path with no reserved characters is left unquoted');
});

test('exec arguments are quoted and escaped as the desktop entry specification says',async()=>{
 assert.equal(execLine('/usr/bin/easter-company'),'/usr/bin/easter-company --play');
 assert.equal(execLine('/a b/easter'),'"/a b/easter" --play');
 assert.equal(execLine('/a"b/easter'),'"/a\\"b/easter" --play');
 assert.equal(execLine('/a$b/easter'),'"/a\\$b/easter" --play');
 // A literal per cent sign starts a field code, so it is doubled; the flag itself is
 // untouched and stays exactly --play.
 assert.equal(execLine('/opt/100%/easter'),'"/opt/100%%/easter" --play');
 assert.equal(execLine('/usr/bin/easter-company',['--play']),execLine('/usr/bin/easter-company'));
 assert.equal(execLine('/usr/bin/easter-company','--play'),'/usr/bin/easter-company --play','a single string argument is not spread into characters');
});

test('the two entries live where each platform keeps them',async()=>{
 const linux=shortcutTargets({platform:'linux',home:'/home/player',env:{}});
 assert.equal(linux.desktop.file,path.join('/home/player','Desktop','easter-co-game.desktop'));
 assert.equal(linux.startMenu.file,path.join('/home/player','.local','share','applications','easter-co-game.desktop'));
 // A session that names its own directories is believed.
 const xdg=shortcutTargets({platform:'linux',home:'/home/player',env:{XDG_DATA_HOME:'/home/player/.data',XDG_DESKTOP_DIR:'/home/player/Bureau'}});
 assert.equal(xdg.startMenu.file,path.join('/home/player/.data','applications','easter-co-game.desktop'));
 assert.equal(xdg.desktop.file,path.join('/home/player','Bureau','easter-co-game.desktop'));
 const windows=shortcutTargets({platform:'win32',home:'C:\\Users\\Player',env:{APPDATA:'C:\\Users\\Player\\AppData\\Roaming'}});
 assert.match(windows.desktop.file,/Easter Co\. Game\.lnk$/);
 assert.match(windows.startMenu.file,/Start Menu[\\/]Programs[\\/]Easter Co\. Game\.lnk$/);
 // Windows keeps its desktop somewhere only the shell knows, so the caller can say.
 assert.match(shortcutTargets({platform:'win32',home:'C:\\Users\\Player',env:{},desktopDir:'D:\\Desktop'}).desktop.file,/^D:\\Desktop/);
});

test('Windows entries are Electron shortcuts carrying the application identity',async()=>{
 const details=shortcutDetails({executable:'C:\\Program Files\\Easter Co. Launcher\\easter-company.exe'});
 assert.equal(details.target,'C:\\Program Files\\Easter Co. Launcher\\easter-company.exe');
 assert.equal(details.args,'--play');
 assert.equal(details.appUserModelId,APP_USER_MODEL_ID);
 assert.match(APP_USER_MODEL_ID,/^ltd\.easter\.company\.launcher$/);
 assert.equal(/token|password|Bearer/.test(JSON.stringify(details)),false,'the shortcut details carry no credential');
});

test('macOS is reported unavailable with a reason, never pretended',async()=>{
 const support=shortcutSupport({platform:'darwin'});
 assert.equal(support.available,false);
 assert.match(support.reason,/macOS/);
 assert.equal(shortcutTargets({platform:'darwin',home:'/Users/player',env:{}}),null);
 const state=await readGameShortcuts({platform:'darwin',desktop:true,startMenu:true});
 assert.equal(state.available,false);
 assert.equal(state.desktop.wanted,true,'the saved preference is still reported as such');
 assert.equal(state.desktop.exists,false);
 assert.equal(state.startMenu.exists,false);
 assert.equal(shortcutSupport({platform:'linux'}).available,true);
 assert.equal(shortcutSupport({platform:'win32'}).available,true);
 assert.equal(shortcutSupport({platform:'aix'}).available,false,'a platform with no known location is refused rather than guessed');
});

test('a shortcut click starts a game only when nothing needs the player first',async()=>{
 const ready={startupReady:true,installed:true,running:false,busy:false,updating:false,actions:[],canPlay:true};
 assert.deepEqual(autoStartDecision(ready),{start:true,reason:null});
 // A game already running is the one case where the click must not start a second one.
 assert.equal(autoStartDecision({...ready,running:true}).start,false);
 assert.equal(autoStartDecision({...ready,running:true}).reason,'running');
 // The mandatory update gate comes before anything else.
 assert.equal(autoStartDecision({...ready,startupReady:false}).reason,'update');
 assert.equal(autoStartDecision({...ready,updating:true}).reason,'busy');
 assert.equal(autoStartDecision({...ready,busy:true}).reason,'busy');
 // An account that needs a sign-in, a password or a Microsoft link is not a launch.
 for(const action of ['signin','setup-password','connect-microsoft'])assert.equal(autoStartDecision({...ready,actions:[action],canPlay:false}).reason,'account',action);
 // Java access is the same answer: the window opens and says so.
 for(const action of ['buy','setup-profile','check-access'])assert.equal(autoStartDecision({...ready,actions:[action],canPlay:false}).reason,'access',action);
 // No client is an install, whether or not the list says so.
 assert.equal(autoStartDecision({...ready,installed:false}).reason,'install');
 assert.equal(autoStartDecision({...ready,actions:['download'],canPlay:false}).reason,'install');
 // The state contract's own gate is the last word: an unexplained no is still a no.
 assert.equal(autoStartDecision({...ready,canPlay:false}).start,false);
 assert.equal(autoStartDecision({}).start,false);
});

test('the two shortcut preferences are saved with the settings, off by default',async()=>{
 const base={memoryMB:4096,server:'100.100.1.0:25565',javaPath:''};
 const saved=cleanSettings({...base,desktopShortcut:true,startMenuShortcut:true},16384);
 assert.equal(saved.desktopShortcut,true);
 assert.equal(saved.startMenuShortcut,true);
 // Absent from every file written before them, and off when absent.
 const fresh=cleanSettings(base,16384);
 assert.equal(fresh.desktopShortcut,false);
 assert.equal(fresh.startMenuShortcut,false);
 // A value that is not a boolean is not coerced into putting a file on a desktop.
 for(const bogus of ['true',1,'yes',{},[],null]){
  assert.equal(cleanShortcutPreferences({desktopShortcut:bogus,startMenuShortcut:bogus}).desktopShortcut,false,JSON.stringify(bogus));
  assert.equal(cleanShortcutPreferences({desktopShortcut:bogus,startMenuShortcut:bogus}).startMenuShortcut,false,JSON.stringify(bogus));
 }
 // The two are independent: one being on says nothing about the other.
 assert.deepEqual(cleanShortcutPreferences({desktopShortcut:true}),{desktopShortcut:true,startMenuShortcut:false});
 assert.deepEqual(cleanShortcutPreferences({startMenuShortcut:true}),{desktopShortcut:false,startMenuShortcut:true});
 // And they do not touch the launch-behaviour pair.
 assert.equal(saved.exitOnLaunch,false);
 assert.equal(saved.trayOnLaunch,false);
});

test('the entries are created and removed, and only the launcher\'s own files are deleted',async()=>{
 const dir=await home();
 try{
  const created=await applyGameShortcuts(options(dir));
  assert.equal(created.available,true);
  assert.deepEqual(created.failures,[]);
  assert.equal(created.desktop.exists,true);
  assert.equal(created.desktop.ours,true);
  assert.equal(created.startMenu.exists,true);
  const desktopFile=path.join(dir,'Desktop','easter-co-game.desktop');
  const menuFile=path.join(dir,'.local','share','applications','easter-co-game.desktop');
  const stat=await fs.stat(desktopFile);
  assert.notEqual(stat.mode&0o111,0,'the desktop entry is executable');
  assert.notEqual((await fs.stat(menuFile)).mode&0o111,0,'and so is the Start menu entry');
  const text=await fs.readFile(desktopFile,'utf8');
  assert.match(text,/^Exec="\/opt\/Easter Co\. Launcher\/easter-company" --play$/m);
  assert.deepEqual(SECRETS.filter(word=>text.toLowerCase().includes(word)),[]);
  // The icon the entries point at is a real file the launcher owns.
  const iconPath=(/^Icon=(.+)$/m.exec(text)||[])[1];
  assert.ok(iconPath,'the entry points at an icon');
  assert.equal(await fs.stat(iconPath).then(()=>true,()=>false),true);
  assert.equal(path.basename(iconPath),ICON_FILE);
  // Unticking removes exactly those two files, and the icon they were the only users of.
  const removed=await applyGameShortcuts(options(dir,{desktop:false,startMenu:false}));
  assert.equal(removed.desktop.exists,false);
  assert.equal(removed.startMenu.exists,false);
  assert.equal(await fs.stat(desktopFile).then(()=>true,()=>false),false);
  assert.equal(await fs.stat(menuFile).then(()=>true,()=>false),false);
  assert.equal(await fs.stat(iconPath).then(()=>true,()=>false),false);
  // A file the launcher did not write is left exactly where it is.
  const foreign='[Desktop Entry]\nType=Application\nName=Somebody else\nExec=/usr/bin/true\n';
  await fs.writeFile(desktopFile,foreign,{mode:0o755});
  const kept=await applyGameShortcuts(options(dir,{desktop:false,startMenu:true}));
  assert.equal(kept.desktop.exists,true);
  assert.equal(kept.desktop.ours,false,'the launcher knows the file is not one it wrote');
  assert.equal(await fs.readFile(desktopFile,'utf8'),foreign);
  await fs.rm(desktopFile,{force:true});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a computer with no Desktop folder is reported instead of given one',async()=>{
 const bare=await fs.mkdtemp(path.join(os.tmpdir(),'easter-shortcut-bare-'));
 try{
  const report=await applyGameShortcuts(options(bare));
  assert.equal(report.failures.length,1);
  assert.equal(report.failures[0].id,'desktop');
  assert.equal(report.failures[0].setting,'desktopShortcut');
  assert.match(report.failures[0].message,/no Desktop folder/i);
  assert.equal(await fs.stat(path.join(bare,'Desktop')).then(()=>true,()=>false),false,'no Desktop folder was invented');
  // The Start menu entry, which was possible, was still written.
  assert.equal(report.startMenu.exists,true);
  assert.equal(await fs.stat(path.join(bare,'.local','share','applications','easter-co-game.desktop')).then(()=>true,()=>false),true);
 }finally{await fs.rm(bare,{recursive:true,force:true});}
});

test('the renderer and the preload gain a settings preference, not a privileged surface',async()=>{
 const preload=await read('desktop/preload.cjs');
 const renderer=await read('site/desktop.js');
 const main=await read('desktop/main.cjs');
 // No new IPC channel: the two toggles travel through the existing settings action and
 // their real state through the existing status/state broadcast.
 assert.equal(/invoke\('(?:create-|remove-)?shortcut/.test(preload),false,'the preload exposes no shortcut channel');
 assert.equal(/shell\.writeShortcutLink/.test(preload),false,'the renderer process cannot write a shortcut itself');
 assert.match(renderer,/name="desktopShortcut"/);
 assert.match(renderer,/name="startMenuShortcut"/);
 assert.match(renderer,/shortcutInputs\.desktopShortcut\.checked/);
 // The main process owns both files, and sets the Windows application identity before
 // any shortcut could be written.
 assert.match(main,/readGameShortcuts|applyGameShortcuts/);
 assert.match(main,/app\.setAppUserModelId\(APP_USER_MODEL_ID\)/);
 // The target is the launcher the player installed, never a path or a command the
 // renderer supplied, and it is resolved before either entry is written.
 assert.match(main,/function shortcutExecutable\(\)\{return process\.env\.APPIMAGE\|\|process\.execPath;\}/);
 assert.equal(/executable:\s*(?:event|input|args)/.test(main),false,'no renderer value is taken as the shortcut target');
});
