'use strict';
// Provider picture URLs never reach the renderer or trigger arbitrary fetches.
function allowedPicture(value){
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(
 url.hostname==='cdn.discordapp.com'&&/^\/avatars\/[0-9]+\/(a_)?[a-f0-9]{32}\.png$/.test(url.pathname)||
 /(^|\.)googleusercontent\.com$/.test(url.hostname)||
 url.hostname==='images-eds-ssl.xboxlive.com'||url.hostname==='images-eds.xboxlive.com'||url.hostname==='avatars.steamstatic.com'||url.hostname==='avatars.akamai.steamstatic.com');}catch{return false;}
}
// THE SAME REFUSAL e-server's core/minecraft_face.py makes (its `PRIVATE_HOST`): no picture URL may
// become a request into this machine's own network. The value comes from this instance's own accounts
// service, so this is not a defence against a stranger typing an address; it is what stops one
// account field from reaching a router, a metadata endpoint or the player's own machine if the
// service is ever wrong. It is checked on its own, before the allowlist, so widening the allowlist
// later cannot widen this.
const PRIVATE_PICTURE_HOST=/(^|\.)localhost$|^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^\[?::1\]?$/;
function privatePictureHost(hostname){
 return PRIVATE_PICTURE_HOST.test(String(hostname||'').toLowerCase());
}
// These two numbers are e-server's own (`PICTURE_URL_TIMEOUT` and `PICTURE_URL_LIMIT` in
// core/minecraft_face.py, where the same field is fetched for the same face): four seconds, one
// mebibyte. A profile thumbnail whose host cannot answer in four seconds has not answered, and a
// body past a mebibyte is not a profile picture. Both are enforced BEFORE the bytes are decoded.
// `timeoutMs` is the test seam only: the shipped value is PICTURE_TIMEOUT_MS.
const PICTURE_TIMEOUT_MS=4000,PICTURE_MAX_BYTES=1024*1024;
// Where a decoded picture lands: the renderer draws a 32px square in the bar and at most 64px in the
// profile dialog, so 256 is the ceiling e-server also re-encodes to (its MAX_PICTURE_EDGE). The PNG
// has to stay inside the 360000-character form rule in desktop/accounts.cjs (`pictureForm`) - 256
// square RGBA is 262144 bytes, which base64s well under it - and a PNG past that is dropped rather
// than shrunk again: a face is never worth a second round of lossy work.
const PICTURE_EDGE=256,PICTURE_MAX_PNG=PICTURE_EDGE*PICTURE_EDGE*4;
// ONE MINT PER ACCOUNT FOR THE SESSION. The bar paints on every broadcast, so re-fetching the same
// host each time would spend a request per paint on a third party's CDN. Keyed by the account's
// Company handle AND the source URL: a picture the player changes is fetched again rather than
// answered from memory, and a failure is remembered for the session instead of retried on a paint -
// the face simply stays the skin head.
const hydratedPictures=new Map();
const pictureKey=(account,source)=>String(account.companyId||account.id||'')+'\n'+source;
function forgetHydratedPictures(){hydratedPictures.clear();}
async function hydratePicture(account,{request,nativeImage,timeoutMs=PICTURE_TIMEOUT_MS}={}){
 if(!account?.picture||account.picture.startsWith('data:image/png;base64,'))return account;
 const source=account.picture;
 const key=pictureKey(account,source);
 if(hydratedPictures.has(key))return {...account,picture:hydratedPictures.get(key)};
 const refused=()=>{hydratedPictures.set(key,null);return {...account,picture:null};};
 // Only what the two rules above admit is ever requested: https, a host this launcher knows the
 // accounts service uses for a provider avatar, and never this machine's own network.
 if(!allowedPicture(source))return refused();
 try{if(privatePictureHost(new URL(source).hostname))return refused();}catch{return refused();}
 let picture=null;
 try{
  // THIS REQUEST IS NOT THE PAGE'S. It is made by the main process against the network stack, so it
  // carries no cookie (`credentials:'omit'`: the account session is this app's own bearer token in a
  // header, never a page cookie), no referrer, and the client's own default user agent - a desktop
  // app asking for a thumbnail, never a page or a player's machine. The body is bounded as it
  // streams, so an oversized answer is stopped at the byte that crossed the cap rather than after it.
  const response=await request(source,{
   redirect:'error',
   credentials:'omit',
   referrerPolicy:'no-referrer',
   headers:{Accept:'image/*'},
   signal:AbortSignal.timeout(timeoutMs),
  });
  if(response.ok){
   const chunks=[];let size=0;
   for await(const chunk of response.body){
    size+=chunk.length;
    if(size>PICTURE_MAX_BYTES){size=-1;break;}
    chunks.push(chunk);
   }
   if(size>0){
    const image=nativeImage.createFromBuffer(Buffer.concat(chunks));
    if(!image.isEmpty()){
     const png=image.resize({width:PICTURE_EDGE,height:PICTURE_EDGE}).toPNG();
     if(png.length<=PICTURE_MAX_PNG)picture='data:image/png;base64,'+png.toString('base64');
    }
   }
  }
 }catch{} // A face never fails a sign-in, a launch or a render - e-server's own rule for this field.
 hydratedPictures.set(key,picture);
 return {...account,picture};
}
module.exports={allowedPicture,privatePictureHost,hydratePicture,forgetHydratedPictures,PICTURE_TIMEOUT_MS,PICTURE_MAX_BYTES,PICTURE_EDGE};
