'use strict';
const path=require('node:path');
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
function publicProfile(session){return session?.profile?{name:session.profile.name,id:session.profile.id}:null;}
function cleanSettings(input,totalMB=16384){
 const memoryMB=Number(input.memoryMB);
 if(!Number.isInteger(memoryMB)||memoryMB<2048||memoryMB>Math.min(16384,Math.floor(totalMB)))throw Error('Choose a memory limit between 2 GB and the available memory.');
 const server=String(input.server||'').trim();
 if(server&&!/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[0-9]{1,5})?$/i.test(server))throw Error('Enter a server hostname or IPv4 address, with an optional port.');
 if(server.includes(':')&&(+server.split(':')[1]<1||+server.split(':')[1]>65535))throw Error('Server port must be between 1 and 65535.');
 const javaPath=String(input.javaPath||'').trim();
 if(javaPath&&(!path.isAbsolute(javaPath)||!/^java(?:\.exe)?$/i.test(path.basename(javaPath))))throw Error('Select a Java executable named java or java.exe.');
 return {memoryMB,server,javaPath};
}
module.exports={localFile,trustedFrame,externalURL,publicProfile,cleanSettings};
