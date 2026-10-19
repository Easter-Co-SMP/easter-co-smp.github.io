'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
// The one address rule the launcher has, next to the one address it targets. It lived
// with the settings field it used to guard; the field is gone and the rule now decides
// what the test-only override may say. security.cjs imports nothing from here, so this
// is not a cycle.
const {checkServer}=require('./security.cjs');
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
// ---- the one server the launcher targets -------------------------------------
// Owen's instruction of 2026-10-18: the launcher's server address is no longer a
// player setting, so there is exactly one target and every path that names an address
// reads it from here. The production host is live at smp.easter.company:25565 on an
// Elastic IP (3.151.255.100, DNS verified 2026-10-18), and the *hostname* is the
// constant rather than the IP: the name survives the address changing, a number baked
// into a launcher release does not.
const PRODUCTION_SERVER='smp.easter.company:25565';
// The one override, for tests and development only. The suites need an address that is
// not production (a loopback fixture, a stub server), and none of them may reintroduce
// a field a player can edit: this is read from the process environment, is never part
// of renderer state, is never written to the settings file, and is validated by the
// very hostname/port rule (security.cjs checkServer) that used to guard the settings
// field. Nothing a player can reach sets it, and a released launcher never sets it
// itself, so an ordinary install always targets PRODUCTION_SERVER.
const SERVER_ADDRESS_ENV='EASTER_SERVER_ADDRESS';
function serverAddress(override=process.env[SERVER_ADDRESS_ENV]){
 const candidate=String(override??'').trim();
 if(!candidate)return PRODUCTION_SERVER;
 let address='';
 try{address=checkServer(candidate);}
 catch{throw Error(SERVER_ADDRESS_ENV+' must be a hostname or IPv4 address, with an optional port.');}
 if(!address)throw Error(SERVER_ADDRESS_ENV+' must name a server.');
 return address;
}
// ---- the game server, which may be asleep ------------------------------------
// The game server is stopped whenever nobody plays, because the hosting credit is
// finite, so the first player of a session pays a cold start. Two routes on the same
// API origin answer for it, authenticated with the same Company session token:
// GET /v2/game/status and POST /v2/game/wake. The five state words and the two timings
// below are frozen in doc/launcher-states.md, and the address is serverAddress(): the
// wake flow and the launch cannot disagree about which host they are talking about.
const GAME_STATES=['running','starting','stopping','stopped','unknown'];
// Readiness is polled every three seconds, so a server that becomes joinable is
// joined within three seconds of it happening without hammering the account API.
const GAME_POLL_MS=3000;
// Three minutes of cold start before the wait fails honestly. Owen's figure for the
// cold start is 60-90 seconds, so this is the failure line, not the expectation.
const GAME_WAKE_TIMEOUT_MS=180000;
// A status read is bounded far below the account client's 30 s: it is on the way to
// a launch and an unanswered read is already an answer ('unknown').
const GAME_STATUS_TIMEOUT_MS=10000;
const GAME_WAKE_REQUEST_TIMEOUT_MS=20000;
// The service's own `detail` sentence is shown beside the launcher's copy, so it is
// bounded like every other sentence the state carries.
const GAME_DETAIL_MAX=200;
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
module.exports={apiOrigin,DEFAULT_API_ORIGIN,clientOrigin,DEFAULT_CLIENT_ORIGIN,LOOPBACK,CLIENT_FOLDER,MARKER,FOREIGN_ENTRIES,defaultInstallLocation,PRODUCTION_SERVER,SERVER_ADDRESS_ENV,serverAddress,cleanLaunchSettings,locationProblem,checkLocation,ensureLocation,resolveLocation,GAME_STATES,GAME_POLL_MS,GAME_WAKE_TIMEOUT_MS,GAME_STATUS_TIMEOUT_MS,GAME_WAKE_REQUEST_TIMEOUT_MS,GAME_DETAIL_MAX};
