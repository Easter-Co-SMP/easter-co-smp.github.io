'use strict';
// Easter Company API origin. Build-time constant, overridable at runtime with
// EASTER_API_BASE_URL exactly like EASTER_MICROSOFT_CLIENT_ID overrides the
// Microsoft registration. Keep this in step with the deployed HTTP API.
const DEFAULT_API_ORIGIN='https://accounts.eastercompany.ltd';
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
module.exports={apiOrigin,DEFAULT_API_ORIGIN};
