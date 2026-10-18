'use strict';
const path=require('node:path'),http=require('node:http'),https=require('node:https');
const ROOT='easter';
function localFile(url,root){
 const parsed=new URL(url);
 if(parsed.protocol!=='easter:'||parsed.host!==ROOT)throw Error('Unknown application origin');
 const decoded=decodeURIComponent(parsed.pathname);
 if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').includes('..'))throw Error('Invalid application path');
 const relative=decoded.replace(/^\/+/, '');
 const file=path.resolve(root,relative);
 if(file!==root&&!file.startsWith(root+path.sep))throw Error('Path leaves application');
 return file;
}
function trustedFrame(event){return event.senderFrame===event.sender.mainFrame&&new URL(event.senderFrame.url).origin==='null'&&event.senderFrame.url.startsWith('easter://easter/');}
function externalURL(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password)throw Error('Only HTTPS links can open outside the launcher');
 return url.href;
}
function publicProfile(session){return session?.profile?{name:session.profile.name,id:session.profile.id,skin:typeof session.profile.skin==='string'&&session.profile.skin.startsWith('data:image/png;base64,')?session.profile.skin:null}:null;}
// fetch-shaped request on Node's own TLS stack. Chromium's fetch inside Electron
// refuses Node-served TLS endpoints during the handshake, so the account API is
// reached with the same HTTP module the rest of the launcher already uses. The
// caller's signal bounds the whole request; unexpected transport errors surface
// only as a bounded, cause-free rejection.
function apiFetch(url,{method='GET',headers={},body,signal}={}){
 return new Promise((resolve,reject)=>{
  // Belt and braces: the caller's own timeout and this transport's ceiling.
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(30000)].filter(Boolean));
  let request,settled=false;
  const finish=(error,response)=>{if(settled)return;settled=true;if(error)reject(error);else resolve(response);};
  const fail=()=>{try{request?.destroy();}catch{}finish(Object.assign(Error('The account service connection failed.'),{name:'TypeError'}));};
  let target;
  try{target=new URL(url);}catch{return finish(Object.assign(Error('Invalid account service address.'),{name:'TypeError'}));}
  const transport=target.protocol==='https:'?https:http;
  signal?.addEventListener('abort',()=>finish(Object.assign(Error('Cancelled'),{name:'AbortError'})),{once:true});
  try{
   request=transport.request(target,{method,headers,minVersion:target.protocol==='https:'?'TLSv1.2':undefined,signal:deadline,timeout:30000},response=>{
    const chunks=[];
    response.on('data',chunk=>chunks.push(chunk));
    response.on('end',()=>finish(undefined,{ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    response.on('aborted',fail);
    response.on('error',fail);
   });
  }catch{return finish(Object.assign(Error('The account service connection failed.'),{name:'TypeError'}));}
  request.on('timeout',()=>request.destroy());
  request.on('error',error=>finish(error.name==='AbortError'?error:Object.assign(Error('The account service connection failed.'),{name:'TypeError'})));
  if(body!==undefined)request.write(body);
  request.end();
 });
}
// The server setting stays one plain string, and the launcher's own published
// entries are just strings of the same shape. A value the player typed is kept
// exactly as they typed it: nothing here rewrites it to an entry id, because the
// launcher has no business replacing a server someone chose with its own list.
const SERVER_ADDRESS=/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[0-9]{1,5})?$/i;
function checkServer(value){
 const server=String(value||'').trim();
 if(server&&!SERVER_ADDRESS.test(server))throw Error('Enter a server hostname or IPv4 address, with an optional port.');
 if(server.includes(':')&&(+server.split(':')[1]<1||+server.split(':')[1]>65535))throw Error('Server port must be between 1 and 65535.');
 return server;
}
function cleanSettings(input,totalMB=16384){
 const memoryMB=Number(input.memoryMB);
 if(!Number.isInteger(memoryMB)||memoryMB<2048||memoryMB>Math.min(16384,Math.floor(totalMB)))throw Error('Choose a memory limit between 2 GB and the available memory.');
 const server=checkServer(input.server);
 const javaPath=String(input.javaPath||'').trim();
 if(javaPath&&(!path.isAbsolute(javaPath)||!/^java(?:\.exe)?$/i.test(path.basename(javaPath))))throw Error('Select a Java executable named java or java.exe.');
 return {memoryMB,server,javaPath,autoUpdateLauncher:true,autoUpdateGame:true,...cleanLaunchPreferences(input)};
}
// The two launch-time behaviours are linked and cannot both be chosen: the launcher
// either closes behind the game it started, or steps into the system tray, or stays
// exactly where it is. Both default to off, so a fresh install leaves the window on
// screen.
//
// Both on is a state the launcher itself never offers. Once the one-time migration in
// migrateLaunchPreferences has run, a file carrying both cannot even be a leftover from
// an older build: it is hand-edited or damaged. So the pair is resolved to both off
// rather than guessed between. Neither of the two do-anything-visible behaviours is
// trusted from an ambiguous pair, and quitting behind the game — the more destructive of
// them — is never inferred from it. The file is not rewritten from here; the settings
// dialog is where the player states the pair they actually want. The rule lives here, in
// the main process, and not only in the view.
function cleanLaunchPreferences(input){
 const exitOnLaunch=preference(input.exitOnLaunch,false);
 const trayOnLaunch=preference(input.trayOnLaunch,false);
 if(exitOnLaunch&&trayOnLaunch)return {exitOnLaunch:false,trayOnLaunch:false};
 return {exitOnLaunch,trayOnLaunch};
}
// Owen's one-time migration of the saved launch preferences, decided on load. A saved
// file that does not carry trayOnLaunch was written by a build that predates it, and the
// default of that build was to close the launcher behind the game. Such a file therefore
// cannot say whether the player ever chose that: both of this household's machines carry
// exitOnLaunch:true verbatim from cleanSettings on the old default. The pair is resolved
// to today's defaults — both off — and main.cjs writes the file back once with the field
// present, which is what makes this happen once and never again. From then on the file is
// the player's own record and is left alone. The cost, stated plainly: a true that a
// player deliberately chose in the old build looks exactly like the old default and is
// reset once, after which their next choice sticks both ways. A file that already carries
// the field, a fresh install with nothing read, and unreadable JSON are all left to the
// ordinary load path.
function migrateLaunchPreferences(stored){
 const file=stored&&typeof stored==='object'?stored:null;
 if(!file)return {migrated:false,exitOnLaunch:false,trayOnLaunch:false};
 if(typeof file.trayOnLaunch==='boolean')return {migrated:false,exitOnLaunch:file.exitOnLaunch===true,trayOnLaunch:file.trayOnLaunch};
 return {migrated:true,exitOnLaunch:false,trayOnLaunch:false};
}
// What starting the game does to the launcher window, as one pure decision so it can be
// tested without a window. `quit` closes the launcher behind the game, `tray` hides it
// behind a tray icon offering Open launcher and Quit, `hide` hides it where no tray icon
// can be drawn and carries the sentence that says how to bring it back (start the
// launcher again), and `stay` leaves the window as the player had it.
function launchBehaviour(settings,{trayAvailable=false}={}){
 const chosen=cleanLaunchPreferences(settings||{});
 if(chosen.exitOnLaunch)return {action:'quit',message:null};
 if(!chosen.trayOnLaunch)return {action:'stay',message:null};
 if(trayAvailable)return {action:'tray',message:null};
 return {action:'hide',message:'This desktop has no system tray, so start Easter Co. Launcher again to bring the window back.'};
}
// A preference is a boolean or it keeps its default; anything else is ignored rather
// than coerced, so a stray value can never silently flip a player's automation off.
function preference(value,fallback=true){
 return typeof value==='boolean'?value:fallback;
}
// A saved settings payload may or may not carry the enhanced-graphics toggle. It is
// a boolean or it is absent; anything else is ignored rather than coerced, so a
// stray value can never silently re-decide a player's own choice.
function includeGraphicsValue(input,fallback=false){
 if(!input||typeof input!=='object'||typeof input.includeGraphics!=='boolean')return Boolean(fallback);
 return input.includeGraphics;
}
module.exports={localFile,trustedFrame,externalURL,publicProfile,apiFetch,cleanSettings,cleanLaunchPreferences,migrateLaunchPreferences,launchBehaviour,SERVER_ADDRESS,checkServer,includeGraphicsValue};
