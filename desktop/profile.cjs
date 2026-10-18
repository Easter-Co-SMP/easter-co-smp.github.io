'use strict';
// Provider picture URLs never reach the renderer or trigger arbitrary fetches.
function allowedPicture(value){
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(
 url.hostname==='cdn.discordapp.com'&&/^\/avatars\/[0-9]+\/(a_)?[a-f0-9]{32}\.png$/.test(url.pathname)||
 /(^|\.)googleusercontent\.com$/.test(url.hostname)||
 url.hostname==='images-eds-ssl.xboxlive.com'||url.hostname==='images-eds.xboxlive.com'||url.hostname==='avatars.steamstatic.com'||url.hostname==='avatars.akamai.steamstatic.com');}catch{return false;}
}
async function hydratePicture(account,{request,nativeImage}){
 if(!account?.picture||account.picture.startsWith('data:image/png;base64,'))return account;
 const source=account.picture;account={...account,picture:null};
 if(!allowedPicture(source))return account;
 try{
  const response=await request(source,{redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)return account;
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)return account;chunks.push(chunk);}
  const image=nativeImage.createFromBuffer(Buffer.concat(chunks));
  if(image.isEmpty())return account;
  const png=image.resize({width:256,height:256}).toPNG();
  if(png.length<=262144)account.picture='data:image/png;base64,'+png.toString('base64');
 }catch{}
 return account;
}
module.exports={allowedPicture,hydratePicture};
