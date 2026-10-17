'use strict';
// What the launcher can learn about this machine's graphics, and what it therefore
// promises the player. doc/launcher-states.md: "On unless the GPU is clearly weak".
//
// Everything here is derived from evidence the machine actually reported:
//  - app.getGPUInfo('complete') / app.getGPUFeatureStatus() from Electron, which on
//    Linux name the PCI device ids of the adapters Chromium found and which of them
//    is active, but never report video memory;
//  - a platform probe for the adapter's own video memory (nvidia-smi here, the
//    Windows video controller, system_profiler on macOS), because render distance
//    and shader settings are derived from reported video memory, not guessed;
//  - lspci as a fallback that names an adapter without memory.
// Nothing is invented: an adapter string the platform will not give up stays null,
// video memory that is not reported stays null, and the tier says `unknown` instead
// of pretending.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const MAX_BUFFER=1024*1024;
async function command(file,args,options={}){
 if(!file)return null;
 try{
  const {stdout}=await run(file,args,{timeout:8000,windowsHide:true,maxBuffer:MAX_BUFFER,...options});
  return String(stdout||'');
 }catch{return null;}
}
// Sixteen bits, however the source spelled them: lspci writes 10de:2882, Chromium's
// report and WMI write decimal numbers, and both must land on the same value.
function hex16(value){
 if(value===undefined||value===null||value==='')return null;
 // A number is a number: Chromium reports 4318 for NVIDIA (0x10de) and WMI reports
 // plain integers, so it is rendered as hex. A string is already the hex id the
 // source printed, which is how lspci writes it.
 if(typeof value==='number'){
  if(!Number.isInteger(value)||value<0||value>0xffff)return null;
  return value.toString(16).padStart(4,'0');
 }
 const text=String(value).trim().replace(/^0x/i,'');
 if(!/^[0-9a-f]{1,4}$/i.test(text))return null;
 return text.toLowerCase().padStart(4,'0');
}
function videoMemoryMB(value){
 if(value===undefined||value===null||value==='')return null;
 const number=Number(String(value).replace(/,/g,'').trim());
 if(!Number.isFinite(number)||number<=0)return null;
 return Math.round(number);
}
// A four-digit id is a PCI id; anything longer is the vendor's own adapter id and
// says nothing about which PCI device is in use, so it is not a match.
function idMatch(reported,adapter){
 const left=hex16(reported);
 if(!left)return false;
 const right=hex16(adapter);
 return Boolean(right)&&left===right;
}
function busId(value){
 const text=String(value||'').toLowerCase().replace(/^0x/,'');
 const match=/(?:^|[:\s])([0-9a-f]{2}):([0-9a-f]{2})\.([0-9a-f])(?:$|\s)/.exec(text);
 return match?match[1]+':'+match[2]+'.'+match[3]:null;
}
// ---- system probes ----------------------------------------------------------
// NVIDIA reports its adapters' video memory directly, without an X display and
// without root. This is the only general Linux source for that number.
function parseNvidiaSmi(stdout){
 if(!stdout)return [];
 return stdout.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
  const [index,name,memory,bus]=line.split(',').map(field=>String(field||'').trim());
  // `[N/A]` is the driver saying it does not know, which is not an adapter name.
  if(name===undefined||memory===undefined||!name||/^\[?n\/?a\]?$/i.test(name))return null;
  return {index:Number(index),name,vramMB:videoMemoryMB(memory),busId:busId(bus)||null,source:'nvidia-smi'};
 }).filter(adapter=>adapter&&adapter.name);
}
// lspci without -v needs no privileges and names the adapter and its PCI ids.
function parseLspci(stdout){
 if(!stdout)return [];
 const adapters=[];
 for(const line of stdout.split('\n')){
  // `03:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD107 [GeForce RTX 4060] [10de:2882] (rev a1)`
  // The class code is the first bracket pair after the class name; the PCI ids are
  // the first hex:hex pair in a bracket, and the name keeps its own brackets.
  const head=/^([0-9a-f]{2,4}:[0-9a-f]{2}\.[0-9a-f])\s+[^:]*:\s+(.*)$/i.exec(line.trim());
  if(!head)continue;
  const rest=head[2].trim();
  const ids=/\[([0-9a-f]{4}):([0-9a-f]{4})\]/i.exec(rest);
  const name=rest.replace(/\s*\(rev [^)]*\)\s*$/i,'').replace(/\s*\[[0-9a-f]{4}:[0-9a-f]{4}\]\s*$/i,'').trim();
  adapters.push({busId:busId(head[1])||null,name,vendorId:hex16(ids?ids[1]:null),deviceId:hex16(ids?ids[2]:null),vramMB:null,source:'lspci'});
 }
 return adapters.filter(adapter=>adapter.name);
}
// The Windows video controller reports its own dedicated video memory.
function parseWindowsVideoControllers(stdout){
 if(!stdout)return [];
 return stdout.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
  const fields=line.split('|').map(field=>field.trim());
  if(fields.length<2)return null;
  const bytes=Number(fields[1]);
  const vramMB=Number.isFinite(bytes)&&bytes>0?videoMemoryMB(bytes/1024/1024):null;
  return {name:fields[0],vramMB,busId:null,source:'windows-video-controller'};
 }).filter(adapter=>adapter&&adapter.name&&adapter.vramMB!==null);
}
function parseSystemProfiler(stdout){
 if(!stdout)return [];
 const adapters=[];
 for(const line of stdout.split('\n')){
  const chipset=/Chipset Model:\s*(.+)$/.exec(line);
  const vram=/VRAM[^:]*:\s*(.+)$/.exec(line);
  if(chipset)adapters.push({name:chipset[1].trim(),vramMB:null,source:'system_profiler'});
  else if(vram&&adapters.length){
   const text=vram[1].trim();
   const megabytes=/^(\d+)\s*MB/i.exec(text);
   const gigabytes=/^(\d+(?:\.\d+)?)\s*GB/i.exec(text);
   if(megabytes)adapters[adapters.length-1].vramMB=Number(megabytes[1]);
   else if(gigabytes)adapters[adapters.length-1].vramMB=Math.round(Number(gigabytes[1])*1024);
  }
 }
 return adapters;
}
// ---- the machine's adapters, as well as it will say -------------------------
async function gpuAdapters({platform=process.platform,env=process.env}={}){
 if(platform==='linux'){
  const nvidia=parseNvidiaSmi(await command(env.EASTER_NVIDIA_SMI||'nvidia-smi',['--query-gpu=index,name,memory.total,pci.bus_id','--format=csv,noheader,nounits']));
  const lspci=parseLspci(await command(env.EASTER_LSPCI||'lspci',['-nn']));
  const known=[...nvidia,...lspci];
  // The lspci entry supplies the PCI ids; nvidia-smi supplies the memory. When only
  // one of them exists, the adapter is still better described than not at all.
  const merged=lspci.map(entry=>{
   const exact=(nvidia.find(item=>item.busId&&entry.busId&&item.busId===entry.busId))
    ||(nvidia.find(item=>item.name&&entry.name&&item.name.includes(entry.name.split('[').pop().replace(/]/g,'').trim())))
    ||(nvidia.length===1?nvidia[0]:null);
   return {...entry,vramMB:exact?.vramMB??entry.vramMB};
  });
  const extra=nvidia.filter(item=>!merged.some(entry=>entry.busId&&item.busId&&entry.busId===item.busId));
  return [...merged,...extra];
 }
 if(platform==='win32'){
  const script='Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }';
  const powershell=env.EASTER_POWERSHELL||'powershell.exe';
  const adapters=parseWindowsVideoControllers(await command(powershell,['-NoProfile','-NonInteractive','-Command',script]));
  if(adapters.length)return adapters;
  return parseWindowsVideoControllers(await command(env.EASTER_WMIC||'wmic',['path','win32_VideoController','get','name,AdapterRAM','/format:csv']));
 }
 if(platform==='darwin'){
  return parseSystemProfiler(await command(env.EASTER_SYSTEM_PROFILER||'system_profiler',['SPDisplaysDataType']));
 }
 return [];
}
// ---- which adapter the display is on ----------------------------------------
// Owen's rule of 2026-10-17: the launcher targets exactly one GPU, and it must be the
// GPU the display runs on. The session's own answer comes first, because Chromium
// reports the device this process actually renders on and that is the seat-correct
// one; a connected DRM output and then the firmware's boot VGA device are the
// fallbacks for a seat with no real display. boot_vga is deliberately last: on this
// household server it names the headless RTX 3060 (PCI 07:00.0) while the monitor is
// wired to the RTX 4060 (PCI 03:00.0), so trusting it would describe, tune for and
// target the card nobody is looking at.
async function drmCards({platform=process.platform,root='/sys/class/drm',listing=null,read=null}={}){
 if(platform!=='linux')return [];
 const list=listing||(dir=>fs.readdir(dir));
 const text=read||(file=>fs.readFile(file,'utf8'));
 const names=await list(root).catch(()=>[]);
 const cards=new Map();
 const entry=index=>{if(!cards.has(index))cards.set(index,{index,bus:null,vendorId:null,deviceId:null,bootVga:false,connected:0});return cards.get(index);};
 for(const name of names){
  const card=/^card(\d+)$/.exec(name);
  if(card){
   const info=entry(card[1]);
   const device=path.join(root,name,'device');
   info.vendorId=hex16(String(await text(path.join(device,'vendor')).catch(()=>'')).trim());
   info.deviceId=hex16(String(await text(path.join(device,'device')).catch(()=>'')).trim());
   info.bootVga=String(await text(path.join(device,'boot_vga')).catch(()=>'')).trim()==='1';
   info.bus=String(await fs.realpath(device).catch(()=>'')).split('/').pop()||null;
   continue;
  }
  const connector=/^card(\d+)-[\w-]+$/.exec(name);
  if(connector){
   const status=String(await text(path.join(root,name,'status')).catch(()=>'')).trim();
   if(status==='connected')entry(connector[1]).connected+=1;
  }
 }
 return [...cards.values()];
}
// The display adapter for this session, with the evidence that settled it. Returning
// `via` keeps the answer auditable instead of asserting one card by assertion.
function sessionDisplay({devices=[],adapters=[],cards=[]}={}){
 const list=(adapters||[]).filter(Boolean);
 const byIds=(vendorId,deviceId)=>list.find(item=>idMatch(vendorId,item.vendorId)&&idMatch(deviceId,item.deviceId))||null;
 // A monitor wired to a card is the least ambiguous statement of "the display GPU", so
 // it is asked first; the session's own renderer answers next, which is also the answer
 // on a seat whose display is synthesised (a streamed seat has no connected output).
 // With monitors on more than one card, the session's renderer breaks the tie, because
 // that is the card this window is actually drawn on.
 const active=chooseDevice(devices||[]);
 const activeHit=active?byIds(active.vendorId,active.deviceId):null;
 const connected=(cards||[]).filter(candidate=>candidate.connected>0);
 const preferred=connected.find(card=>activeHit&&idMatch(card.vendorId,activeHit.vendorId)&&idMatch(card.deviceId,activeHit.deviceId))||connected[0];
 if(preferred){
  const hit=byIds(preferred.vendorId,preferred.deviceId);
  if(hit)return {adapter:{...hit,bus:preferred.bus||hit.bus||null},via:'connected',card:preferred};
 }
 if(activeHit)return {adapter:activeHit,via:'reported'};
 const primary=(cards||[]).find(card=>card.bootVga);
 if(primary){
  const hit=byIds(primary.vendorId,primary.deviceId);
  if(hit)return {adapter:{...hit,bus:primary.bus||hit.bus||null},via:'boot-vga',card:primary};
 }
 return {adapter:null,via:'unknown'};
}
// One answer. A display adapter that can render is the target. When the display is a
// weak integrated part and the machine has exactly one discrete adapter, that adapter
// is the target instead: a laptop's screen hangs off the integrated part while the
// discrete card does the work, and pretending otherwise would turn shaders off on a
// machine that runs them well. `via:'offload'` is what tells the launch path to pin
// the renderer with the platform's own offload variables.
function targetAdapter({display=null,adapters=[]}={}){
 const list=(adapters||[]).filter(Boolean);
 const current=display?.adapter||null;
 const renders=current&&!isIntegrated(current.name)&&!isSoftwareRenderer(current.name);
 if(renders)return {adapter:current,via:display.via,offload:false};
 const discrete=list.filter(isDiscreteAdapter);
 if(discrete.length===1)return {adapter:discrete[0],via:'offload',offload:Boolean(current)};
 if(current)return {adapter:current,via:display.via,offload:false};
 return {adapter:null,via:'unknown',offload:false};
}
// The variables that make the launched client render on the target instead of on
// whatever the driver would have chosen. Only the offload case needs them: when the
// target already drives the display, the driver's default is the target and adding
// variables would be noise. Windows and macOS choose per-application themselves, so
// the launcher does not claim an override it cannot make.
function pciForDriPrime(bus){
 const text=String(bus||'').toLowerCase().replace(/^0x/,'');
 return /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/.test(text)?'pci-'+text.replace(/[:.]/g,'_'):null;
}
function renderOffload({platform=process.platform,target=null,via=''}={}){
 if(platform!=='linux'||!target||via!=='offload')return {};
 const name=String(target.name||''),vendor=String(target.vendor||'');
 if(/nvidia/i.test(vendor)||/nvidia|geforce|quadro|tesla/i.test(name))return {'__NV_PRIME_RENDER_OFFLOAD':'1','__GLX_VENDOR_LIBRARY_NAME':'nvidia','__VK_LAYER_NV_optimus':'NVIDIA_only'};
 if(/amd|advanced micro|radeon/i.test(vendor+' '+name)){
  const prime=pciForDriPrime(target.bus||target.busId);
  return prime?{'DRI_PRIME':prime,'MESA_VK_DEVICE_SELECT':prime}:{};
 }
 if(/intel/i.test(vendor+' '+name)){
  const prime=pciForDriPrime(target.bus||target.busId);
  return prime?{'DRI_PRIME':prime}:{};
 }
 return {};
}

// ---- what Electron reported -------------------------------------------------
function reportedDevices(gpuInfo){
 if(!gpuInfo||typeof gpuInfo!=='object')return [];
 const list=gpuInfo.gpuDevice||gpuInfo.gpu_devices||gpuInfo.gpuDevices;
 return Array.isArray(list)?list.filter(device=>device&&typeof device==='object'):[];
}
// The adapter string, if this platform gives one. Chromium reports it in
// auxAttributes on Windows and macOS; on Linux it does not, and the adapter is
// named from the system probe instead.
function reportedAdapter(gpuInfo){
 const aux=gpuInfo&&typeof gpuInfo==='object'?(gpuInfo.auxAttributes||gpuInfo.aux_attributes||{}):{};
 if(!aux||typeof aux!=='object')return null;
 for(const key of ['glRenderer','gl_renderer','glVendor','gl_vendor']){
  const value=aux[key];
  if(typeof value==='string'&&value.trim())return value.trim();
 }
 return null;
}
// Which reported device is in use: Chromium marks it, and on a machine with two
// adapters that flag is the difference between describing the right one and
// describing whichever happened to be listed first. The active device wins; if
// nothing is flagged, the first device is the best available answer.
function chooseDevice(devices){
 if(!devices.length)return null;
 // Chromium says which device it started on. That is the best answer available and
 // it is not a promise about the display: on a switchable-graphics machine the flag
 // can name the card the last process used. It is still preferred over guessing.
 return devices.find(device=>device.active===true)||devices.find(device=>device.active===undefined)||devices[0];
}
// Two adapters, one answer: the launcher tells the player that the machine has more
// than one, so a description of the wrong card is never silently presented as the
// machine's only graphics hardware.
// Only display adapters count as adapters. The system probe lists every PCI device it can
// see, so counting all of them said this machine had 31 graphics adapters when it has two.
function isGraphicsAdapter(item){
 if(!item)return false;
 if(Number.isFinite(item.vramMB)&&item.vramMB>0)return true;
 const name=String(item.name||'').toLowerCase();
 return /(geforce|radeon|\barc\b|quadro|tesla|\bgpu\b|graphics|\bvga\b|display controller|iris|uhd graphics|apple m[0-9]|video controller)/.test(name);
}
function distinctAdapters(adapters){
 const seen=new Set();
 for(const item of Array.isArray(adapters)?adapters:[]){
  if(!isGraphicsAdapter(item))continue;
  const key=[hex16(item.vendorId),hex16(item.deviceId),String(item.name||'').toLowerCase()].join('|');
  seen.add(key);
 }
 return seen.size;
}
function matchAdapter({adapter,devices,adapters}){
 const list=Array.isArray(adapters)?adapters.filter(Boolean):[];
 if(!list.length)return null;
 const chosen=chooseDevice(devices||[]);
 if(chosen){
  const exact=list.find(item=>idMatch(chosen.vendorId,item.vendorId)&&idMatch(chosen.deviceId,item.deviceId));
  if(exact)return {...exact,reportedDevice:chosen};
  const byVendor=chosen.vendorId!==undefined?list.filter(item=>idMatch(chosen.vendorId,item.vendorId)):[];
  if(byVendor.length===1)return {...byVendor[0],reportedDevice:chosen};
 }
 if(adapter){
  const lower=adapter.toLowerCase();
  const named=list.find(item=>item.name&&(lower.includes(item.name.toLowerCase())||item.name.toLowerCase().includes(lower)));
  if(named)return {...named,reportedDevice:chosen||null};
  const vendor=adapter.replace(/\(.*?\)/g,'').split(/[\s,]+/).filter(Boolean)[0];
  if(vendor&&vendor.length>3){
   const hinted=list.filter(item=>item.name&&item.name.toLowerCase().includes(vendor.toLowerCase()));
   if(hinted.length===1)return {...hinted[0],reportedDevice:chosen||null};
  }
 }
 if(list.length===1)return {...list[0],reportedDevice:chosen||null};
 // Two adapters and no way to tell them apart: report the vendor if they agree on
 // it, and leave the adapter itself unnamed rather than picking one at random.
 const vendors=new Set(list.map(item=>vendorOf(item.name)).filter(Boolean));
 if(vendors.size===1)return {name:null,vendorId:list[0].vendorId??null,deviceId:null,vramMB:null,vendor:[...vendors][0],source:'ambiguous'};
 return {name:null,vendorId:null,deviceId:null,vramMB:null,vendor:null,source:'ambiguous'};
}
// ---- naming -----------------------------------------------------------------
const SOFTWARE_RENDERER=/\b(llvmpipe|softpipe|swiftshader|swrast|software rasterizer|software renderer|mesa offscreen|virgl|virtualbox|vmware svga|basic render|microsoft basic)\b/i;
const INTEGRATED=/\b(intel|iris|uhd|hd graphics|arc graphics|radeon graphics|vega \d|amd radeon|apple m\d|adreno|mali|powervr)\b/i;
function vendorOf(value){
 const text=String(value||'');
 if(/nvidia|geforce|quadro|tesla|rtx|gtx/i.test(text))return 'NVIDIA';
 if(/amd|radeon|advanced micro devices|ati\b/i.test(text))return 'AMD';
 if(/intel|iris|uhd|hd graphics|arc graphics/i.test(text))return 'Intel';
 if(/apple|metal/i.test(text))return 'Apple';
 if(/qualcomm|adreno|arm|mali|powervr|imagination/i.test(text))return 'ARM';
 if(/mesa|llvmpipe|swiftshader|gallium/i.test(text))return 'Mesa';
 return null;
}
function isSoftwareRenderer(value){return SOFTWARE_RENDERER.test(String(value||''));}
function isIntegrated(value){return INTEGRATED.test(String(value||''));}
// A feature the platform switched off because it fell back to software is real
// evidence about the graphics stack, but it is not a statement about the adapter:
// a headless display reports llvmpipe while a discrete card sits idle in the same
// machine. It is reported, and the tier stays a judgement about the adapter.
function softwareFallback(featureStatus){
 if(!featureStatus||typeof featureStatus!=='object')return false;
 for(const key of ['gpu_compositing','webgl','webgl2','rasterization','2d_canvas','gpu_rasterization'])if(typeof featureStatus[key]==='string'&&featureStatus[key].includes('disabled_software'))return true;
 return false;
}
// ---- the published answer ---------------------------------------------------
// `tier` follows one rule only: on unless the GPU is clearly weak.
function isDiscreteAdapter(item){
 if(!item||!isGraphicsAdapter(item))return false;
 const name=String(item.name||'');
 if(isSoftwareRenderer(name))return false;
 if(/(\brx\b|\brtx\b|\bgtx\b|arc a\d|radeon pro|quadro|tesla|geforce)/i.test(name))return true;
 if(Number.isFinite(item.vramMB)&&item.vramMB>=3072)return true;
 return !isIntegrated(name);
}
function hardwareProfile({adapter=null,devices=[],featureStatus=null,adapters=[],chosen=null,via=null}={}){
 const matched=chosen||matchAdapter({adapter,devices,adapters});
 // The one card the launcher targets names itself; the platform's renderer string is
 // only a fallback for a machine where no adapter could be identified at all.
 const name=matched?.name||adapter||null;
 const vramMB=videoMemoryMB(matched?.vramMB)||null;
 const vendor=matched?.vendor||vendorOf(name)||null;
 const softwareName=isSoftwareRenderer(name);
 const integrated=isIntegrated(name);
 const fallbackToSoftware=softwareFallback(featureStatus);
 const installed=distinctAdapters(adapters);
 let tier,reason;
 if(softwareName){
  tier='weak';
  reason='Software graphics ('+name+'): enhanced graphics stay off.';
 }else if(fallbackToSoftware&&!name){
  tier='weak';
  reason='The system is drawing without GPU acceleration, so enhanced graphics stay off.';
 }else if(integrated){
  tier='weak';
  reason=(vendor?vendor+' integrated graphics':'Integrated graphics')+(vramMB?', '+vramMB+' MB shared video memory':'')+': enhanced graphics stay off.';
 }else if(!name&&!vramMB){
  tier='unknown';
  reason='The graphics adapter could not be identified, so enhanced graphics are left on.';
 }else if(vramMB===null){
  tier='unknown';
  reason=(name?name+': ':'')+'the platform does not report video memory, so enhanced graphics are left on.';
 }else{
  tier='capable';
  reason=(vendor&&!new RegExp(vendor,'i').test(name)?vendor+' ':'')+name+' with '+vramMB+' MB of video memory.';
 }
 // No adapter count here: the launcher has one answer, so it gives one. `adapters` stays
 // in the object for callers that need to know the machine is multi-GPU.
 return {gpu:name,vendor,vramMB,tier,reason,source:matched?.source||(name?'reported':'none'),software:softwareName||(fallbackToSoftware&&!name),adapters:installed,via:via||null};
}
// The recommendation is the tier, and nothing else. It is honest about the
// platform: where the machine will not report video memory, no quality level is
// promised, so the toggle is less useful and that is said rather than hidden.
function graphicsRecommended(hardware){return hardware?.tier!=='weak';}
function graphicsTunable(hardware){return hardware?.tier!=='unknown'&&Number.isFinite(hardware?.vramMB)&&hardware.vramMB>0;}
async function detectHardware({gpuInfo=null,featureStatus=null,platform=process.platform,env=process.env,adapters=null,cards=null}={}){
 let list=adapters;
 if(list===null)try{list=await gpuAdapters({platform,env});}catch{list=[];}
 const drm=cards!==null?cards:await drmCards({platform}).catch(()=>[]);
 const devices=reportedDevices(gpuInfo);
 const adapter=reportedAdapter(gpuInfo);
 const display=sessionDisplay({devices,adapters:list,cards:drm});
 const target=targetAdapter({display,adapters:list});
 const hardware=hardwareProfile({adapter,featureStatus,adapters:list,chosen:target.adapter,via:target.via});
 return {...hardware,recommended:graphicsRecommended(hardware),tunable:graphicsTunable(hardware),offload:target.offload};
}
// ---- the client's own quality settings --------------------------------------
// Owen's goal: the client works out the highest quality settings it can push for
// the hardware. Render distance and shadow distance come from the video memory the
// machine reported, and shaders are only turned on where there is memory for them;
// a machine that reports nothing gets the conservative settings and no shader pack
// promise, exactly like the toggle's own `tunable` flag.
const SHADER_PACK_NAME='ComplementaryUnbound_r5.9.3.zip';
const QUALITY_LADDER=[
 {minVRAM:0,renderDistance:6,shadowDistance:4,graphicsMode:'fast',shaders:false},
 {minVRAM:2048,renderDistance:8,shadowDistance:4,graphicsMode:'fast',shaders:false},
 {minVRAM:3072,renderDistance:10,shadowDistance:6,graphicsMode:'fancy',shaders:false},
 {minVRAM:4096,renderDistance:12,shadowDistance:8,graphicsMode:'fancy',shaders:true},
 {minVRAM:6144,renderDistance:14,shadowDistance:10,graphicsMode:'fancy',shaders:true},
 // 8 GB cards report 8188 MiB, so the top rung starts at 8000: at 8192 the rung a
 // nominal 8 GB card can never reach would be a rung nobody has.
 {minVRAM:8000,renderDistance:16,shadowDistance:12,graphicsMode:'fancy',shaders:true}
];
// The highest rung the reported memory reaches. A weak adapter keeps the shaders
// off however much memory it borrows, because the tier is a statement about the
// adapter and shaders are the one setting that punishes a weak adapter hardest.
function qualitySettings({vramMB=null,tier='unknown'}={}){
 const reported=videoMemoryMB(vramMB);
 let rung=QUALITY_LADDER[0];
 if(reported!==null)for(const candidate of QUALITY_LADDER)if(reported>=candidate.minVRAM)rung=candidate;
 const shaders=rung.shaders&&tier!=='weak';
 const renderDistance=tier==='weak'?Math.min(rung.renderDistance,10):rung.renderDistance;
 return {renderDistance,shadowDistance:rung.shadowDistance,graphicsMode:rung.graphicsMode,shaders,shaderPack:shaders?SHADER_PACK_NAME:null};
}
function parseProperties(text){
 const map=new Map();
 for(const line of String(text||'').split('\n')){
  const match=/^\s*([\w.-]+)\s*[:=]\s*(.*?)\s*$/.exec(line);
  if(match)map.set(match[1],match[2]);
 }
 return map;
}
function readProperty(text,key){return parseProperties(text).has(key)?parseProperties(text).get(key):null;}
// Rewrite only the keys named, keeping every other line and the file's own line
// endings, so a settings file a player or another mod wrote survives untouched.
function mergeProperties(text,values){
 const lines=String(text??'').replace(/\r\n/g,'\n').split('\n');
 const seen=new Set();
 const output=lines.map(line=>{
  const match=/^\s*([\w.-]+)\s*([:=])\s*(.*?)\s*$/.exec(line);
  if(!match||!(match[1] in values))return line;
  seen.add(match[1]);
  return match[1]+match[2]+values[match[1]];
 });
 for(const [key,value] of Object.entries(values))if(!seen.has(key))output.push(key+':'+value);
 while(output.length&&output[0]==='')output.shift();
 while(output.length&&output[output.length-1]==='')output.pop();
 return output.join('\n')+'\n';
}
async function readText(file){
 try{return await fs.readFile(file,'utf8');}catch{return null;}
}
// What was actually written into the client, as opposed to what was planned: the
// files are read back and the values reported are the ones on disk.
function tunedDigest(quality){
 if(!quality)return null;
 return {renderDistance:quality.renderDistance,shadowDistance:quality.shadowDistance,shaders:Boolean(quality.shaders)};
}
// options.txt is the vanilla client's own file (graphics mode and render distance);
// iris.properties is the shader loader's (shaders, the chosen pack, shadow
// distance). Both live inside the app-owned client tree, whose marker file is the
// only proof that the tree is ours: without it nothing is written anywhere.
async function applyQualitySettings(root,quality,{marker='.easter-client'}={}){
 const base=path.resolve(String(root||''));
 if(!root)throw Error('There is no client folder to write quality settings into.');
 try{await fs.stat(path.join(base,marker));}
 catch{throw Error('That folder is not the launcher’s client tree, so its settings were not touched.');}
 const optionsFile=path.join(base,'options.txt');
 const irisFile=path.join(base,'config','iris.properties');
 const options=mergeProperties(await readText(optionsFile)??'',{graphicsMode:quality.graphicsMode,renderDistance:String(quality.renderDistance)});
 const iris=mergeProperties(await readText(irisFile)??'',{enableShaders:String(Boolean(quality.shaders)),shadowDistance:String(quality.shadowDistance),maxShadowRenderDistance:String(quality.shadowDistance),...(quality.shaders&&quality.shaderPack?{shaderPack:quality.shaderPack}:{})});
 await fs.mkdir(path.dirname(irisFile),{recursive:true});
 await fs.writeFile(optionsFile,options,{mode:0o600});
 await fs.writeFile(irisFile,iris,{mode:0o600});
 return {optionsFile,irisFile,tuned:tunedDigest(quality)};
}
// The installed marker records what was written, so status() can report it without
// re-reading the client on every broadcast. The record is only updated when it
// already exists: the pipeline owns `installed.json` and a lost race there would
// undo an install, so a setting write never creates it.
async function recordQuality(root,quality,{now=()=>new Date().toISOString()}={}){
 const marker=path.join(path.resolve(String(root||'')),'installed.json');
 let record=null;
 try{record=JSON.parse(await fs.readFile(marker,'utf8'));}catch{return false;}
 if(!record||typeof record!=='object'||typeof record.version!=='string')return false;
 const temp=marker+'.'+crypto.randomUUID()+'.tmp';
 const next={...record,quality:{...tunedDigest(quality),graphicsMode:quality.graphicsMode,shaderPack:quality.shaders?quality.shaderPack:null,updatedAt:now()}};
 try{await fs.writeFile(temp,JSON.stringify(next,null,2),{mode:0o600});await fs.rename(temp,marker);}
 catch{await fs.rm(temp,{force:true});return false;}
 return true;
}
// `tuned` is what the client is actually carrying: the marker's record when the
// install pipeline has written one, and the client's own files when it has not.
async function installedQuality(root){
 const base=path.resolve(String(root||''));
 try{
  const record=JSON.parse(await fs.readFile(path.join(base,'installed.json'),'utf8'));
  const tuned=tunedDigest(record?.quality);
  if(tuned)return tuned;
 }catch{}
 const optionsText=await readText(path.join(base,'options.txt'));
 const irisText=await readText(path.join(base,'config','iris.properties'));
 if(optionsText===null&&irisText===null)return null;
 const options=parseProperties(optionsText??'');
 const iris=parseProperties(irisText??'');
 const renderDistance=Number(options.get('renderDistance'));
 const shadowDistance=Number(iris.get('shadowDistance'));
 return {renderDistance:Number.isFinite(renderDistance)?renderDistance:null,shadowDistance:Number.isFinite(shadowDistance)?shadowDistance:null,shaders:iris.get('enableShaders')==='true'};
}
module.exports={hex16,videoMemoryMB,busId,distinctAdapters,isDiscreteAdapter,parseNvidiaSmi,parseLspci,parseWindowsVideoControllers,parseSystemProfiler,gpuAdapters,drmCards,sessionDisplay,targetAdapter,pciForDriPrime,renderOffload,reportedDevices,reportedAdapter,chooseDevice,matchAdapter,vendorOf,isSoftwareRenderer,isIntegrated,softwareFallback,hardwareProfile,graphicsRecommended,graphicsTunable,detectHardware,SHADER_PACK_NAME,QUALITY_LADDER,qualitySettings,parseProperties,readProperty,mergeProperties,applyQualitySettings,recordQuality,installedQuality,tunedDigest};
