'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
// Easter Company API origin. Build-time constant, overridable at runtime with
// EASTER_API_BASE_URL exactly like EASTER_MICROSOFT_CLIENT_ID overrides the
// Microsoft registration. This is the deployed API Gateway origin of the
// accounts HTTP API; it changes only if that stack is destroyed and recreated.
const DEFAULT_API_ORIGIN='https://jyjshd22z3.execute-api.us-east-2.amazonaws.com';
const LOOPBACK=new Set(['127.0.0.1','[::1]','::1','localhost']);
function apiOrigin(value=process.env.EASTER_API_BASE_URL){
 const candidate=String(value||'').trim();
 if(!candidate)return DEFAULT_API_ORIGIN;
 let url;
 try{url=new URL(candidate);}catch{throw Error('EASTER_API_BASE_URL must be an absolute HTTPS URL.');}
 // The Mojang access token and the company session token travel on every call.
 // Refuse to send either over anything but TLS, with one exception: a loopback
 // stub used by tests, where the traffic never leaves the machine. There is no
 // way to point a real deployment at a plaintext host through this override.
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&LOOPBACK.has(url.hostname.toLowerCase())))throw Error('EASTER_API_BASE_URL must use HTTPS.');
 return url.href.replace(/\/+$/,'');
}
// Where the published client manifest, the chunk files we redistribute and the
// relative paths inside them are served from. Same rule as the API origin: HTTPS
// only, with a loopback exception so a test can run the real flow against a local
// server. No real deployment can be pointed at plaintext through it.
const DEFAULT_CLIENT_ORIGIN='https://easter-co-smp.github.io/';
function clientOrigin(value=process.env.EASTER_CLIENT_ORIGIN){
 const candidate=String(value||'').trim();
 if(!candidate)return DEFAULT_CLIENT_ORIGIN;
 let url;
 try{url=new URL(candidate);}catch{throw Error('EASTER_CLIENT_ORIGIN must be an absolute HTTPS URL.');}
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&LOOPBACK.has(url.hostname.toLowerCase())))throw Error('EASTER_CLIENT_ORIGIN must use HTTPS.');
 if(url.username||url.password)throw Error('EASTER_CLIENT_ORIGIN must not carry credentials.');
 return url.href.replace(/\/+$/,'')+'/';
}
// ---- client installation location -------------------------------------------
// The client tree is app-owned by default. A player may point it at a folder of
// their own, and that choice is persisted here. Everything that decides whether a
// folder may be used lives in this module so the main process, the folder picker
// and the tests all apply exactly the same rule.
const CLIENT_FOLDER='minecraft';
// Written into a root the launcher itself created, before anything else. Its
// presence is the only proof that a non-empty folder is already ours.
const MARKER='.easter-client';
// Names that mean "another Minecraft installation". Writing into any of them, or
// into anything that holds them, would modify a player's existing client, another
// launcher's files, the server or the world.
const FOREIGN_ENTRIES=['.minecraft','launcher_profiles.json','launcher_accounts.json','launcher_profiles_microsoft_store.json','versions','libraries','assets','mods','saves','server.properties','eula.txt','usercache.json','banned-ips.json','banned-players.json','level.dat','world','server.jar'];
function defaultInstallLocation(configRoot){return path.join(configRoot,CLIENT_FOLDER);}
// ---- the servers the launcher offers ----------------------------------------
// doc/launcher-states.md: the entries are published by the main process in display
// order rather than hardcoded in the view. `address` is the value written into
// settings.server, which stays a plain string; `id` is only a label for the UI and
// is never substituted for the address a player chose. `note` says why an entry is
// listed but not usable, and `pending` is the flag the view renders it from.
const DEFAULT_SERVER='100.100.1.0:25565';
const LOCAL_SERVER='127.0.0.1:25565';
const SERVER_ENTRIES=[
 {id:'default',label:'Easter Co. SMP',address:DEFAULT_SERVER,note:'Default server.',pending:false},
 {id:'local',label:'This machine',address:LOCAL_SERVER,note:'The server running on this computer.',pending:false},
 {id:'hostname',label:'smp.easter.company',address:'smp.easter.company:25565',note:'Pending: this name has no DNS record yet.',pending:true}
];
function serverList(){return SERVER_ENTRIES.map(entry=>({...entry}));}
function cleanLaunchSettings(input={}){
 const location=String(input.location||'').trim();
 if(location&&!path.isAbsolute(location))throw Error('The installation folder must be an absolute path.');
 return {location:location?path.resolve(location):'',includeGraphics:Boolean(input.includeGraphics)};
}
// Pure rule: returns null when the folder may be used, otherwise the message the
// player sees. No filesystem access, so both the picker and a unit test can call
// it for every refusal case.
function locationProblem(candidate,{defaultLocation,configRoot,home}={}){
 const value=String(candidate||'').trim();
 if(!value)return 'Choose an installation folder.';
 if(!path.isAbsolute(value))return 'The installation folder must be an absolute path.';
 const resolved=path.resolve(value);
 if(resolved===path.parse(resolved).root)return 'Choose a folder, not the root of the drive.';
 if(home&&resolved===path.resolve(home))return 'Choose a folder inside your home directory, not the home directory itself.';
 const segments=resolved.split(path.sep).filter(Boolean).map(segment=>segment.toLowerCase());
 if(segments.includes('.minecraft'))return 'That folder is inside an existing .minecraft. The launcher keeps its own client tree, so choose a different folder.';
 const fallback=defaultLocation?path.resolve(defaultLocation):null;
 // The default is app-owned and inside the application data directory by design,
 // so it is exempt from the rule below. It is never returned by the picker.
 if(fallback&&resolved===fallback)return null;
 if(configRoot){
  const root=path.resolve(configRoot);
  if(resolved===root||resolved.startsWith(root+path.sep))return 'That folder is inside the launcher’s own application data ('+root+'). Choose a folder outside it.';
 }
 return null;
}
async function checkLocation(candidate,{defaultLocation,configRoot,home,filesystem=fs}={}){
 const problem=locationProblem(candidate,{defaultLocation,configRoot,home});
 if(problem)throw Error(problem);
 const resolved=path.resolve(String(candidate).trim());
 let mine=false;
 try{await filesystem.stat(path.join(resolved,MARKER));mine=true;}catch{}
 if(!mine){
  let entries=[];
  try{entries=await filesystem.readdir(resolved);}
  // ENOENT: nothing there yet. ENOTDIR: a parent is a file, which the write probe
  // below refuses with the message that actually explains it.
  catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw Error('The launcher cannot read that folder.');}
  const present=new Set(entries.map(entry=>entry.toLowerCase()));
  const foreign=FOREIGN_ENTRIES.find(name=>present.has(name.toLowerCase()));
  if(foreign)throw Error('That folder already holds another Minecraft installation ('+foreign+'). Choose a folder the launcher can own.');
 }
 return resolved;
}
async function ensureLocation(candidate,options={}){
 const filesystem=options.filesystem||fs;
 const resolved=await checkLocation(candidate,options);
 try{
  await fs.mkdir(resolved,{recursive:true});
  const probe=path.join(resolved,'.easter-write-test');
  await fs.writeFile(probe,'',{mode:0o600});
  await fs.rm(probe,{force:true});
 }catch(error){
  throw Error('The launcher cannot write to that folder'+(error.code?' ('+error.code+')':'')+'. Choose another folder.');
 }
 return resolved;
}
// A renderer never supplies a path. A handler may only act on the folder the
// picker already returned and saved, or on the default; anything else is refused.
function resolveLocation(requested,{saved='',defaultLocation}={}){
 const value=String(requested||'').trim();
 const fallback=defaultLocation?path.resolve(defaultLocation):'';
 if(!value)return path.resolve(saved||fallback);
 const resolved=path.resolve(value);
 if(saved&&resolved===path.resolve(saved))return resolved;
 if(fallback&&resolved===fallback)return resolved;
 throw Error('Choose the installation folder with the folder picker.');
}
module.exports={apiOrigin,DEFAULT_API_ORIGIN,clientOrigin,DEFAULT_CLIENT_ORIGIN,LOOPBACK,CLIENT_FOLDER,MARKER,FOREIGN_ENTRIES,defaultInstallLocation,DEFAULT_SERVER,LOCAL_SERVER,SERVER_ENTRIES,serverList,cleanLaunchSettings,locationProblem,checkLocation,ensureLocation,resolveLocation};
