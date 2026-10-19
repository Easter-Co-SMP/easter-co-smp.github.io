'use strict';
// Managed visual content lives only in the launcher's client tree. Downloads stay
// immutable; activating foliage creates a disposable loadable copy of its cache.
const fs=require('node:fs/promises'),path=require('node:path');
const {mergeProperties,parseProperties}=require('./hardware.cjs');
const {MARKER}=require('./config.cjs');
const catalog=require('./visuals.json');
const grass=catalog.files.find(file=>file.activation==='shaders');
const GRASS_CACHE=grass.path,GRASS_ACTIVE='mods/easter-grassier-grass.jar';
const PACKS=catalog.files.filter(file=>file.kind==='resourcepack').map(file=>file.path);
async function read(file){try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function writeChanged(file,text){
 if(await read(file)===text)return false;
 await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=file+'.easter-tmp';
 try{await fs.writeFile(temp,text,{mode:0o600});await fs.rename(temp,file);}
 finally{await fs.rm(temp,{force:true});}
 return true;
}
async function assertOwned(root){
 if(!root)throw Error('There is no client folder to configure.');
 await fs.access(path.join(root,MARKER));
}
async function disableShaders(root){
 await assertOwned(root);
 const file=path.join(root,'config','iris.properties'),text=await read(file);
 if(text!==null)await writeChanged(file,mergeProperties(text,{enableShaders:'false'}));
}
async function configureVisuals(root,{record,includeGraphics=false}={}){
 await assertOwned(root);
 if(!includeGraphics)await disableShaders(root);
 const active=path.join(root,GRASS_ACTIVE),stateFile=path.join(root,'config','easter-visuals.json');
 // Fail closed before editing pack selections: an unrelated malformed option may
 // stop setup, but can never leave optional foliage running with the switch off.
 const iris=parseProperties(await read(path.join(root,'config','iris.properties'))||'');
 const cached=Boolean(record?.chunks?.graphics?.files?.includes(GRASS_CACHE));
 const files=new Set(record?.chunks?.graphics?.files||[]);
 const shaderPack=iris.get('shaderPack')||'';
 const safePack=shaderPack===path.posix.basename(shaderPack)&&!shaderPack.includes('\\')&&shaderPack.endsWith('.zip');
 const shaderPath='shaderpacks/'+shaderPack;
 const irisPath=[...files].find(file=>/^mods\/iris(?:-[^/]+)?\.jar$/.test(file));
 const sodiumPath=[...files].find(file=>/^mods\/sodium(?:-[^/]+)?\.jar$/.test(file));
 let payload=false;
 if(safePack&&files.has(shaderPath)&&irisPath&&sodiumPath){
  try{await Promise.all([shaderPath,irisPath,sodiumPath,GRASS_CACHE].map(file=>fs.access(path.join(root,file))));payload=true;}catch{}
 }
 const shaders=includeGraphics&&cached&&payload&&iris.get('enableShaders')==='true';
 if(!shaders)await fs.rm(active,{force:true});
 const installed=new Set(record?.chunks?.visuals?.files||[]);
 const packs=PACKS.filter(pack=>installed.has(pack));
 if(packs.length){
  for(const pack of packs)await fs.access(path.join(root,pack));
  const file=path.join(root,'options.txt'),text=await read(file)||'';
  const properties=parseProperties(text),raw=properties.get('resourcePacks');
  let selected=[];
  if(raw!==undefined){
   try{selected=JSON.parse(raw);}catch{throw Error('The client resource pack selection is invalid. Repair options.txt before trying again.');}
   if(!Array.isArray(selected)||selected.some(item=>typeof item!=='string'))throw Error('The client resource pack selection is invalid.');
  }
  // Minecraft lists low to high priority. The extension follows its base pack.
  const managed=new Set(PACKS.map(pack=>'file/'+path.posix.basename(pack)));
  selected=selected.filter(pack=>!managed.has(pack));
  selected.push(...packs.map(pack=>'file/'+path.posix.basename(pack)));
  await writeChanged(file,mergeProperties(text,{resourcePacks:JSON.stringify(selected)}));
 }
 if(shaders){
  let previous=null;
  try{previous=JSON.parse(await read(stateFile)||'null');}catch{}
  let exists=false;try{await fs.access(active);exists=true;}catch{}
  if(!exists||previous?.grassVersion!==record.chunks.graphics.version){
   const temp=active+'.easter-tmp';
   try{await fs.copyFile(path.join(root,GRASS_CACHE),temp);await fs.rename(temp,active);}
   finally{await fs.rm(temp,{force:true});}
  }
 }
 await writeChanged(stateFile,JSON.stringify({grassVersion:shaders?record.chunks.graphics.version:null,shaders,packs},null,2)+'\n');
 return {shaders,grass:shaders,packs};
}
module.exports={configureVisuals,disableShaders,GRASS_CACHE,GRASS_ACTIVE,PACKS};
