'use strict';
// Game shortcuts.
//
// Owen's ask, and his own correction to it: a shortcut for the game that starts the
// LAUNCHER and lets the launcher start the game, because a shortcut that ran Minecraft
// itself would skip the mandatory updater. So the entry this module writes never
// mentions the game: it runs the launcher binary with one explicit argument,
// `--play`, and the main process decides after its own launcher update, its client
// update and its account/access gate whether a game may start at all.
//
// Everything here is either a pure builder (the argument, the target paths, the
// desktop-entry text, the auto-start decision) or the two file operations that write
// and remove exactly the entries the launcher owns. Nothing in this module knows about
// tokens, accounts or the client: an entry carries the launcher's path, the argument,
// its own name and an icon path, and nothing else.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');

// The one argument a shortcut passes. It is read at startup and from the forwarded
// command line of a second instance, so a shortcut clicked while the launcher is
// already running reaches the same decision through the same lock.
const AUTO_START_ARG='--play';
// The entries are named for what the player gets, and are deliberately distinct from
// the launcher shortcut the installer itself creates ("Easter Co. Launcher").
const ENTRY_NAME='Easter Co. Game';
const ENTRY_COMMENT='Starts Minecraft through Easter Co. Launcher.';
const ENTRY_STEM='easter-co-game';
const ICON_FILE=ENTRY_STEM+'.png';
const APP_USER_MODEL_ID='ltd.easter.company.launcher';
// A marker the launcher writes into its own desktop files, so removal can prove the
// file it is about to delete is one this launcher created and not a player's own.
const ENTRY_MARKER='X-Easter-Company=game-shortcut';

// ---- the auto-start argument ------------------------------------------------
// The token is matched exactly: `--play` is the argument, `--play=1` is a different
// string that no shortcut writes and no run reads.
function wantsAutoStart(argv){return Array.isArray(argv)&&argv.some(value=>value===AUTO_START_ARG);}

// Whether a shortcut launch may start a game, or must instead leave the window in the
// state it would normally be in. The order is the order the player experiences it:
// a running game first (never a second one), then the mandatory update gate, then
// everything the account, the client and Java access still need. `actions` is the
// same ordered list of what is missing that the UI shows, and `canPlay` is the state
// contract's own gate, so the shortcut can never start a game the Play button would
// not offer.
function autoStartDecision({startupReady,installed,running,busy,updating,actions,canPlay}={}){
 const remaining=Array.isArray(actions)?actions:[];
 if(running)return {start:false,reason:'running'};
 if(!startupReady)return {start:false,reason:'update'};
 if(busy||updating)return {start:false,reason:'busy'};
 if(!installed||remaining.includes('download'))return {start:false,reason:'install'};
 if(remaining.some(action=>['signin','setup-password','connect-microsoft'].includes(action)))return {start:false,reason:'account'};
 if(remaining.some(action=>['buy','setup-profile','check-access'].includes(action)))return {start:false,reason:'access'};
 if(!canPlay)return {start:false,reason:'not-ready'};
 return {start:true,reason:null};
}

// ---- where the entries live -------------------------------------------------
// macOS is reported unavailable rather than pretended: Electron's shortcut API is a
// Windows feature, and the file an alias would need is not something the launcher can
// promise to keep working through its own updates.
function shortcutSupport({platform=process.platform}={}){
 if(platform==='darwin')return {available:false,reason:'macOS has no shortcut file the launcher can write, so the game shortcut is offered on Windows and Linux only.'};
 if(platform==='linux'||platform==='win32')return {available:true,reason:null};
 return {available:false,reason:'This computer has no shortcut location the launcher can write.'};
}

// The two locations. On Linux the desktop entry is a .desktop file on the desktop and
// the Start menu entry is a .desktop file under the user's applications directory; on
// Windows both are .lnk files Electron writes itself, one on the desktop and one in the
// per-user Start menu. The desktop and Start menu directories come from the session
// when it names them, and from the home directory otherwise.
function shortcutTargets({platform=process.platform,home=os.homedir(),env=process.env,desktopDir=null,startMenuDir=null}={}){
 if(platform==='linux'){
  const dataHome=env.XDG_DATA_HOME||path.join(home,'.local','share');
  const desktop=desktopDir||env.XDG_DESKTOP_DIR||path.join(home,'Desktop');
  const applications=startMenuDir||path.join(dataHome,'applications');
  return {
   desktop:{id:'desktop',setting:'desktopShortcut',label:'desktop shortcut',directory:desktop,file:path.join(desktop,ENTRY_STEM+'.desktop')},
   startMenu:{id:'startMenu',setting:'startMenuShortcut',label:'Start menu entry',directory:applications,file:path.join(applications,ENTRY_STEM+'.desktop')}
  };
 }
 if(platform==='win32'){
  const appData=env.APPDATA||path.join(home,'AppData','Roaming');
  const desktop=desktopDir||path.join(home,'Desktop');
  const programs=startMenuDir||path.join(appData,'Microsoft','Windows','Start Menu','Programs');
  return {
   desktop:{id:'desktop',setting:'desktopShortcut',label:'desktop shortcut',directory:desktop,file:path.join(desktop,ENTRY_NAME+'.lnk')},
   startMenu:{id:'startMenu',setting:'startMenuShortcut',label:'Start menu entry',directory:programs,file:path.join(programs,ENTRY_NAME+'.lnk')}
  };
 }
 return null;
}

// ---- the desktop entry ------------------------------------------------------
// Desktop Entry specification: reserved characters in an Exec argument are quoted, and
// a literal per cent sign is doubled because `%` starts a field code.
const SAFE_ARGUMENT=/^[A-Za-z0-9_@+=:,./-]+$/;
function quoteArgument(value){return '"'+String(value).replace(/["`$\\]/g,character=>'\\'+character)+'"';}
function execArgument(value){
 const text=String(value).replace(/%/g,'%%');
 return SAFE_ARGUMENT.test(text)?text:quoteArgument(text);
}
// The argument list, in one shape: an array of strings, whatever the caller passed.
function argumentList(args){
 const list=Array.isArray(args)?args:[args];
 return list.filter(value=>typeof value==='string'&&value);
}
// The whole of what a shortcut runs: the launcher, and the argument that makes it
// start the game once it is ready. There is no second form of this line.
function execLine(executable,args=[AUTO_START_ARG]){
 return [executable,...argumentList(args)].filter(value=>typeof value==='string'&&value).map(execArgument).join(' ');
}
// One .desktop file, byte for byte. `Icon` is an absolute path to a file the launcher
// owns, so the entry does not depend on an icon the package may or may not have
// installed.
function desktopEntry({executable,args=[AUTO_START_ARG],name=ENTRY_NAME,comment=ENTRY_COMMENT,icon=null,categories='Game'}={}){
 const lines=[
  '[Desktop Entry]',
  'Type=Application',
  'Version=1.5',
  'Name='+name,
  'Comment='+comment,
  'Exec='+execLine(executable,args),
  'Terminal=false',
  'Categories='+categories+';',
  'StartupNotify=true',
  ENTRY_MARKER
 ];
 if(icon)lines.splice(6,0,'Icon='+icon);
 return lines.join('\n')+'\n';
}
// What Electron's own shortcut API is given on Windows: the launcher as the target, the
// argument beside it, and the application's identity so Windows groups the window under
// the taskbar entry it belongs to.
function shortcutDetails({executable,args=AUTO_START_ARG}={}){
 return {target:executable,args:argumentList(args).join(' '),cwd:path.dirname(executable),description:ENTRY_COMMENT,icon:executable,iconIndex:0,appUserModelId:APP_USER_MODEL_ID};
}

// ---- the real state ---------------------------------------------------------
async function fileExists(file){try{await fs.stat(file);return true;}catch{return false;}}
// Whether the file at an entry's own name is one this launcher wrote. Removal only ever
// deletes a file that answers yes, and the dialog can then say plainly that a file it did
// not create is being left where it is. A Windows .lnk cannot be inspected without the
// shell, and the name the launcher writes there is its own, so there the answer is the
// existence of the file.
async function entryIsOurs(file,platform){
 if(platform!=='linux')return true;
 let handle;
 try{
  handle=await fs.open(file,'r');
  const {buffer,bytesRead}=await handle.read(Buffer.alloc(4096),0,4096,0);
  return buffer.subarray(0,bytesRead).toString('utf8').includes(ENTRY_MARKER);
 }catch{return false;}
 finally{try{await handle?.close();}catch{}}
}
function wantedFlags(options){
 const source=options&&typeof options==='object'?options:{};
 return {desktop:source.desktop===true,startMenu:source.startMenu===true};
}
function blankEntry(id,wanted){return {id,wanted:Boolean(wanted),exists:false,ours:false};}

// What is actually on this computer, not what the setting remembers. `wanted` is the
// saved preference, `exists` is the file and `ours` says whether that file is one the
// launcher wrote, so the dialog can show all three instead of assuming they agree.
async function readGameShortcuts(options={}){
 const wanted=wantedFlags(options);
 const platform=options.platform||process.platform;
 const support=shortcutSupport(options);
 if(!support.available)return {available:false,reason:support.reason,message:null,desktop:blankEntry('desktop',wanted.desktop),startMenu:blankEntry('startMenu',wanted.startMenu)};
 const targets=shortcutTargets(options),report={available:true,reason:null,message:null};
 for(const [id,entry] of Object.entries(targets)){
  const exists=await fileExists(entry.file);
  report[id]={id,wanted:Boolean(wanted[id]),exists,ours:exists?await entryIsOurs(entry.file,platform):false};
 }
 return report;
}

// A failure a player can act on, in one plain sentence. The paths themselves stay in
// the main process: an error a dialog shows names the entry, not the machine.
function shortcutMessage(error,entry){
 const code=error&&error.code;
 if(code==='ENOENT')return entry.id==='desktop'?'There is no Desktop folder on this computer, so no desktop shortcut was created.':'The Start menu folder could not be found, so no Start menu entry was created.';
 if(code==='EACCES'||code==='EPERM'||code==='EROFS')return 'This computer does not allow the launcher to write the '+entry.label+'.';
 return 'The '+entry.label+' could not be created.';
}

// The icon the entries point at, copied out of the application and into the launcher's
// own data directory, so the entry works for an AppImage, a package install and an
// unpackaged run alike. It is removed again when no entry is left pointing at it.
async function reconcileIcon(options,wanted){
 if(options.platform!=='linux'||!options.icon||!options.icon.source||!options.icon.target)return null;
 try{
  if(wanted){
   await fs.mkdir(path.dirname(options.icon.target),{recursive:true});
   const bytes=await fs.readFile(options.icon.source);
   await fs.writeFile(options.icon.target,bytes,{mode:0o644});
   return options.icon.target;
  }
  await fs.rm(options.icon.target,{force:true});
 }catch{}
 return null;
}

// One entry, written. The desktop directory itself is never created: a computer with no
// Desktop folder is reported rather than given one.
async function writeEntry(entry,options,iconPath){
 if(options.platform==='linux'){
  const text=desktopEntry({executable:options.executable,icon:iconPath});
  if(entry.id!=='desktop')await fs.mkdir(entry.directory,{recursive:true});
  await fs.writeFile(entry.file,text,{mode:0o755});
  await fs.chmod(entry.file,0o755);
  return entry.file;
 }
 if(options.platform==='win32'){
  await fs.mkdir(entry.directory,{recursive:true});
  const write=typeof options.writeShortcutLink==='function'?options.writeShortcutLink:require('electron').shell.writeShortcutLink;
  if(!write(entry.file,'create',shortcutDetails({executable:options.executable})))throw Error('The shortcut could not be written.');
  return entry.file;
 }
 throw Error('This computer has no shortcut location the launcher can write.');
}

// One entry, removed. On Linux the file has to carry this launcher's own marker before
// it is deleted, so a file the launcher did not write is left exactly where it is. On
// Windows the path is the exact .lnk the launcher creates and no other file is touched.
async function removeEntry(entry,options){
 if(!await fileExists(entry.file))return {removed:false,foreign:false};
 if(options.platform==='linux'){
  const text=await fs.readFile(entry.file,'utf8').catch(()=>'');
  if(!text.includes(ENTRY_MARKER))return {removed:false,foreign:true};
 }
 await fs.rm(entry.file,{force:true});
 return {removed:true,foreign:false};
}

// Creating and removing both entries in one call, which is what a settings save is. Each
// entry is independent: a desktop that cannot be written does not stop the Start menu
// entry from being written, and the caller is told which one failed and why.
async function applyGameShortcuts(options={}){
 const wanted=wantedFlags(options);
 const support=shortcutSupport(options);
 if(!support.available)return {...await readGameShortcuts(options),failures:[]};
 const targets=shortcutTargets(options);
 const iconPath=await reconcileIcon(options,wanted.desktop||wanted.startMenu);
 const failures=[];
 for(const [id,entry] of Object.entries(targets)){
  const want=Boolean(wanted[id]);
  try{
   if(want)await writeEntry(entry,options,iconPath);
   else await removeEntry(entry,options);
  }catch(error){failures.push({id,setting:entry.setting,message:shortcutMessage(error,entry)});}
 }
 const state=await readGameShortcuts(options);
 // Nobody asked for an entry and nothing survived: the icon copy goes with them rather than
 // being left behind in the launcher's data directory.
 const anyEntry=Boolean(state.desktop?.exists||state.startMenu?.exists);
 if(!anyEntry&&(wanted.desktop||wanted.startMenu))await reconcileIcon(options,false);
 return {...state,failures};
}

module.exports={AUTO_START_ARG,ENTRY_NAME,ENTRY_COMMENT,ENTRY_STEM,ENTRY_MARKER,APP_USER_MODEL_ID,ICON_FILE,wantsAutoStart,autoStartDecision,shortcutSupport,shortcutTargets,execLine,desktopEntry,shortcutDetails,readGameShortcuts,applyGameShortcuts};
