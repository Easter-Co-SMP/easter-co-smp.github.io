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
 // A file that ends with a newline splits into a trailing empty line; it is dropped
 // before the keys still to be added go on, so appending cannot leave a blank line in
 // the middle of the file. Every other line, blank lines included, is kept.
 while(output.length&&output[0]==='')output.shift();
 while(output.length&&output[output.length-1]==='')output.pop();
 for(const [key,value] of Object.entries(values))if(!seen.has(key))output.push(key+':'+value);
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
 // Minecraft 26.2 split the old graphicsMode into concrete options. Naming a
 // preset in the file does not apply its values (that happens only in the UI).
 // Every name written here was measured against the shipped 26.2 client jar on
 // 2026-10-22 with tests/live/option-keys.mjs: each occurs in
 // net/minecraft/client/Options.class, and graphicsMode occurs only in the two
 // datafixers that migrated it. doc/launcher-states.md, "Client visual content".
 const fancy=quality.graphicsMode!=='fast';
 const previous=(await readText(optionsFile)??'').replace(/^graphicsMode[:=].*(?:\r?\n|$)/gm,'');
 const options=mergeProperties(previous,{graphicsPreset:JSON.stringify('custom'),renderDistance:String(quality.renderDistance),ao:String(fancy),cutoutLeaves:String(fancy),entityShadows:String(fancy),improvedTransparency:'false',mipmapLevels:fancy?'4':'2',particles:fancy?'0':'1'});
 const iris=mergeProperties(await readText(irisFile)??'',{enableShaders:String(Boolean(quality.shaders)),shadowDistance:String(quality.shadowDistance),maxShadowRenderDistance:String(quality.shadowDistance),...(quality.shaders&&quality.shaderPack?{shaderPack:quality.shaderPack}:{})});
 await fs.mkdir(path.dirname(irisFile),{recursive:true});
 await fs.writeFile(optionsFile,options,{mode:0o600});
 await fs.writeFile(irisFile,iris,{mode:0o600});
 return {optionsFile,irisFile,tuned:tunedDigest(quality)};
}
// ---- the GUI scale this display asks for --------------------------------------
// Owen's follow-up of 2026-10-18: a flat GUI scale of 2 was right on an ordinary
// display and too small on a high-resolution one, so the seeded scale follows the
// display the client will open on. The table is the whole rule, and it is read in
// PHYSICAL pixels, because that is what the player actually has:
//
//   physical height >= 2160 (2160p and up)  -> 4
//   physical height >= 1350 (1440p, 1600p)  -> 3
//   anything shorter, down to the smallest  -> 2
//   no usable size reported                 -> 2
//
// Height is the axis that binds: a 21:9 1440p display is as tall as any other 1440p
// one, and the interface a player runs out of room on is the vertical one, so the
// rungs are heights. They are cut where 2 stops being legible rather than at round
// numbers of width, and 1080p stays on the bottom rung on purpose: both household
// machines are 1080p and keep the 2 Owen asked for, which is the whole promise of
// the change. Nothing above 4 is ever seeded, and that ceiling is the launcher's own
// decision: 4 is as far as we are willing to go on a high-resolution display we have
// not played on, and it is not a claim about what the client itself allows.
//
// A rung the display cannot show is not written either. The client lays its interface
// out in 320x240 steps, so a display too small to fit the wanted rung gets the lower
// one it does fit - on a very small screen that can be 1 - instead of the launcher
// recording a number the game would have to reduce.
const GUI_SCALE_LADDER=[
 {minHeightPx:2160,guiScale:4},
 {minHeightPx:1350,guiScale:3},
 {minHeightPx:1,guiScale:2}
];
const GUI_SCALE_DEFAULT=2;
// One scale step needs this much room in the client's window.
const GUI_SCALE_STEP={widthPx:320,heightPx:240};
function positivePixels(value){
 const number=Number(value);
 return Number.isFinite(number)&&number>0?number:null;
}
function displayGuiScale({widthPx,heightPx}={}){
 const height=positivePixels(heightPx),width=positivePixels(widthPx);
 // No reported height is not a small display: it is an unknown one, and an unknown
 // display gets the ordinary-display answer rather than a guess in either direction.
 if(height===null)return GUI_SCALE_DEFAULT;
 const rung=GUI_SCALE_LADDER.find(candidate=>height>=candidate.minHeightPx);
 const wanted=rung?rung.guiScale:GUI_SCALE_DEFAULT;
 const fitsWidth=width===null?Infinity:Math.floor(width/GUI_SCALE_STEP.widthPx);
 const fitsHeight=Math.floor(height/GUI_SCALE_STEP.heightPx);
 return Math.max(1,Math.min(wanted,fitsWidth,fitsHeight));
}
// Electron reports a display's size in device-independent pixels and the factor it
// multiplies them by; the client draws, and the table above is read, in physical
// pixels. This is the one conversion, kept pure so it can be stated and tested
// without a running display server.
function displayPhysicalPixels(display){
 const size=display&&typeof display==='object'&&display.size&&typeof display.size==='object'?display.size:{};
 const factor=Number(display&&display.scaleFactor);
 const scale=Number.isFinite(factor)&&factor>0?factor:1;
 const width=positivePixels(size.width),height=positivePixels(size.height);
 return {widthPx:width===null?null:Math.round(width*scale),heightPx:height===null?null:Math.round(height*scale)};
}
// ---- the client's display defaults -------------------------------------------
// Owen's goal: a new player's first launch is already fullscreen at a GUI scale of 2.
// Two keys in the vanilla client's own options.txt carry that — the GUI scale the
// display asked for above, and fullscreen — and they are seeded once per client tree.
// The same seed also carries the household's approved controls, read off Owen's own
// client: sprint and crouch swapped from vanilla, inventory on tab, the player list on
// the key that frees, third person on R, chat on enter, the GUI toggle on F10, social
// interactions on I, smooth camera on right shift, and the vanilla debug keys unbound.
// The first seed writes every value whether or not the game has written options.txt
// before, because the game writes every key on its first exit and a tree that has
// already been played would otherwise never see them. A small record inside the same
// app-owned tree remembers that the seed happened and which keys it covered; after that
// a present key belongs to the player and is never rewritten, and the only thing ever
// written again is a covered key that has gone missing (options.txt deleted or
// truncated) or a key the table has grown that the record does not cover yet. The
// record is its own dotfile and never `installed.json`, which the install pipeline
// rewrites from a record it read earlier: a separate file cannot race that write.
// Like the quality files, this refuses a tree without the launcher's marker.
//
// The controls arrived in three rounds — the display pair, then the five bindings Owen
// plays with, then the rest of the approved set — and the record's schema records that
// history for a human reader: schema 1 covered the display pair, schema 2 the five
// bindings, schema 3 the remaining approved keys. The schema does not decide what a
// tree gets. Coverage is per key: the record's values are the set of keys the launcher
// has had its say over, so a tree holding an older record gets exactly the keys it does
// not cover, once, and leaves every value it already covers byte-identical — including
// the ones the player has since changed.
//
// The debug keys are pinned by name because that is the set of actions this client
// writes into options.txt; an action the client stops writing is a name to remove from
// this list rather than a key left half-bound. Unbinding them is deliberate and has a
// player-visible consequence, documented in doc/launcher-states.md: no F3 debug overlay.
const DEBUG_BINDINGS=[
 'key_key.debug.clearChat',
 'key_key.debug.copyLocation',
 'key_key.debug.copyRecreateCommand',
 'key_key.debug.crash',
 'key_key.debug.debugOptions',
 'key_key.debug.dumpDynamicTextures',
 'key_key.debug.dumpVersion',
 'key_key.debug.focusPause',
 'key_key.debug.fpsCharts',
 'key_key.debug.lightmapTexture',
 'key_key.debug.modifier',
 'key_key.debug.networkCharts',
 'key_key.debug.overlay',
 'key_key.debug.profiling',
 'key_key.debug.profilingChart',
 'key_key.debug.reloadChunk',
 'key_key.debug.reloadResourcePacks',
 'key_key.debug.showAdvancedTooltips',
 'key_key.debug.showChunkBorders',
 'key_key.debug.showHitboxes',
 'key_key.debug.spectate',
 'key_key.debug.switchGameMode'
];
const DISPLAY_DEFAULTS={
 guiScale:'2',
 fullscreen:'true',
 // Vanilla binds sneak to Left Shift and sprint to Left Ctrl. The household plays the
 // other way round, as most other games do, so the launcher seeds this pair swapped.
 'key_key.sneak':'key.keyboard.left.control',
 'key_key.sprint':'key.keyboard.left.shift',
 // Owen's own controls, read off his client: inventory on tab, the player list on the
 // grave/accent key it displaces, and third person on R instead of vanilla's F5.
 'key_key.inventory':'key.keyboard.tab',
 'key_key.playerlist':'key.keyboard.grave.accent',
 'key_key.togglePerspective':'key.keyboard.r',
 // The keys that unblock the rest of the household's layout: clicking the game window
 // no longer opens the chat line, F10 is the GUI toggle rather than vanilla's F1, the
 // social screen sits on I, and smooth camera takes right shift.
 'key_key.chat':'key.keyboard.enter',
 'key_key.toggleGui':'key.keyboard.f10',
 'key_key.socialInteractions':'key.keyboard.i',
 'key_key.smoothCamera':'key.keyboard.right.shift',
 // The F3 debug keys, unbound. `key.keyboard.unknown` is the client's own word for an
 // action with no key, so this is an unbind rather than an invented binding.
 ...Object.fromEntries(DEBUG_BINDINGS.map(key=>[key,'key.keyboard.unknown'])),
 // The Shippy Ships quick-build hotkey ("Quick Build (Use Stack)") moves off Left Ctrl,
 // which crouch owns, onto Right Ctrl: no vanilla action and no other seeded action uses
 // that key, and it keeps the mod's own Ctrl intent. Deferred — see DISPLAY_DEFERRED_KEYS.
 'key_key.shippy-ships.isPressingCtrl':'key.keyboard.right.control'
};
const DISPLAY_RECORD='.easter-client-display';
// Bindings that have to land together. Inventory takes tab, which is vanilla's player
// list key, so applying one without the other would leave two actions on one key. A
// group is written whenever one of its members is: a member the player is already
// carrying is only written when its present value is the one a sibling is taking.
// With the full table applied, no two seeded actions share a key.
const DISPLAY_KEY_GROUPS=[['key_key.inventory','key_key.playerlist']];
// A mod-provided binding does not exist in options.txt until the mod has registered it,
// and the vanilla client does not persist a key_ entry it never read: writing one into a
// fresh tree is silently lost when the game saves. So a deferred key is written only
// once it is already present in options.txt, it is never counted as covered until it has
// actually been written, and it is re-checked on every seed run. A new install therefore
// seeds everything else immediately, and the Shippy key is fixed on the first launcher
// start after the client has run once with the mod.
const DISPLAY_DEFERRED_KEYS=['key_key.shippy-ships.isPressingCtrl'];
// What each schema of the record added, kept as the history a human reads: the display
// pair Owen asked for first, then the five bindings, then the rest of the approved set.
// This is no longer the mechanism — coverage is per key, read from the record's values.
const DISPLAY_SCHEMA_KEYS={
 1:['guiScale','fullscreen'],
 2:['key_key.sneak','key_key.sprint','key_key.inventory','key_key.playerlist','key_key.togglePerspective'],
 3:['key_key.chat','key_key.toggleGui','key_key.socialInteractions','key_key.smoothCamera',...DEBUG_BINDINGS,'key_key.shippy-ships.isPressingCtrl']
};
const DISPLAY_RECORD_SCHEMA=3;
// The range this launcher is willing to seed: 1 to 4, the ladder's bottom and its own
// ceiling. Anything outside it is not a scale the launcher decided, so the documented
// ordinary-display default is written instead of passing the value through.
const GUI_SCALE_RANGE={min:1,max:4};
// What the first seed writes: Owen's approved defaults with the scale this display asked
// for. An answer that is not a usable scale is not invented into the file - the
// documented fallback of 2 is written instead, so a broken screen probe costs the
// ordinary-display default and nothing else.
function displayDefaultValues(guiScale){
 const number=Number(guiScale);
 const fit=Number.isInteger(number)&&number>=GUI_SCALE_RANGE.min&&number<=GUI_SCALE_RANGE.max?String(number):DISPLAY_DEFAULTS.guiScale;
 return {...DISPLAY_DEFAULTS,guiScale:fit};
}
// A record with no schema, or one that cannot be read as a positive integer, is read
// as the first schema: the oldest meaning this launcher ever wrote. A schema this
// build does not know is left alone rather than pulled back down to its own.
function displayRecordSchema(record){
 const schema=Number(record?.schema);
 return Number.isInteger(schema)&&schema>0?schema:1;
}
// The keys the launcher has already had its say over. The record's values are that set:
// a key the record carries a value for is one the launcher wrote once and will not write
// again, whatever the player has since done to it. An empty or unreadable value is not
// coverage — it is a record this launcher cannot act on.
function displayCoveredKeys(record){
 const values=record?.values;
 if(!values||typeof values!=='object')return new Set();
 return new Set(Object.keys(values).filter(key=>typeof values[key]==='string'&&values[key]!==''));
}
async function readDisplayRecord(file){
 try{
  const record=JSON.parse(await fs.readFile(file,'utf8'));
  if(!record||typeof record!=='object'||!record.values||typeof record.values!=='object')return null;
  return record;
 }catch{return null;}
}
// `guiScale` is the value the display asked for (displayGuiScale of the display the
// client will open on). It is only ever used for the first seed: after the record
// exists the recorded value is the one a repair reuses, so a player who moved the
// launcher to another screen does not have their choice re-decided.
async function applyDisplayDefaults(root,{marker='.easter-client',record=DISPLAY_RECORD,now=()=>new Date().toISOString(),guiScale=null}={}){
 const base=path.resolve(String(root||''));
 if(!root)throw Error('There is no client folder to write display settings into.');
 try{await fs.stat(path.join(base,marker));}
 catch{throw Error('That folder is not the launcher’s client tree, so its settings were not touched.');}
 const defaults=displayDefaultValues(guiScale);
 const optionsFile=path.join(base,'options.txt');
 const recordFile=path.join(base,record);
 // No record, or one that cannot be read, means this tree has not been seeded yet.
 const remembered=await readDisplayRecord(recordFile);
 const text=await readText(optionsFile);
 const existing=parseProperties(text??'');
 const schema=displayRecordSchema(remembered);
 // A record written by a newer build than this one is not ours to extend: its schema
 // covers keys this build has never heard of, so it is left alone — not pulled down to
 // this schema and not given keys this build would only now start to seed.
 const future=Boolean(remembered)&&schema>DISPLAY_RECORD_SCHEMA;
 const covered=displayCoveredKeys(remembered);
 const deferred=new Set(DISPLAY_DEFERRED_KEYS);
 // A deferred key that is not in options.txt is not writable yet, so it stops being
 // covered: its value leaves the record, and the seed writes it again the moment the
 // client writes the line again (after a reset, or the first run with the mod). Without
 // this a tree whose options.txt was recreated would keep every other key and lose the
 // Shippy one to the mod's own Left Ctrl default — the collision this seed exists to fix.
 const released=future?[]:[...deferred].filter(key=>covered.has(key)&&!existing.has(key));
 for(const key of released)covered.delete(key);
 // The value a key is written with: what this tree was actually seeded with, or the
 // default when the record has never covered it.
 const valueFor=key=>typeof remembered?.values?.[key]==='string'&&remembered.values[key]!==''?remembered.values[key]:defaults[key];
 const wanted={};
 for(const key of Object.keys(defaults)){
  // A deferred key cannot be seeded before the client has written it: vanilla drops a
  // key_ entry it never read, so the write would be silently lost, and marking it covered
  // then would leave it never seeded at all.
  if(deferred.has(key)&&!existing.has(key))continue;
  if(future&&!covered.has(key))continue;
  // A first seed writes everything; a key the record does not cover is written once,
  // whether it is new in the table or belonged to a schema the record predates; after
  // that the only write left is repairing a covered key that has gone missing.
  if(!remembered||!covered.has(key)||!existing.has(key))wanted[key]=valueFor(key);
 }
 // Two actions may never end up on one key because only half of a group was applied.
 // A sibling the player is carrying stays theirs unless its present value is exactly
 // the one a member is taking, which is the collision the group exists to prevent.
 for(const group of DISPLAY_KEY_GROUPS){
  const moving=new Set(group.filter(key=>key in wanted));
  if(!moving.size)continue;
  const taken=new Set([...moving].map(key=>wanted[key]));
  for(const key of group){
   if(key in wanted||!existing.has(key)||!taken.has(existing.get(key)))continue;
   wanted[key]=valueFor(key);
  }
 }
 if(!Object.keys(wanted).length&&!released.length)return {optionsFile,recordFile,written:false,firstSeed:false,upgraded:false,deferred:[],released:[],keys:[]};
 const applied=Object.keys(wanted);
 const deferredWritten=applied.filter(key=>deferred.has(key));
 // Coverage only grows: a key already in the record keeps the value it was seeded with,
 // so an upgrade or a late-arriving mod key cannot rewrite a player's own rebind.
 const newlyCovered=applied.filter(key=>!covered.has(key));
 if(applied.length)await fs.writeFile(optionsFile,mergeProperties(text??'',wanted),{mode:0o600});
 // Written once, on the first seed, and it stores the values that were applied rather
 // than the defaults, so a repair restores what this tree was actually seeded with. A
 // repair leaves the record as it was, so a repeat run touches neither file's mtime.
 if(!remembered)await fs.writeFile(recordFile,JSON.stringify({schema:DISPLAY_RECORD_SCHEMA,values:{...wanted},appliedAt:now()},null,2)+'\n',{mode:0o600});
 // An older record is raised to this schema exactly once, and a key that only became
 // writable later (a deferred one) joins the covered set once it has been written. Either
 // way the record keeps the values it already carries and the time of the seed that first
 // wrote them; the tree is still seeded once, and only the keys it did not cover before
 // are written now.
 else if(newlyCovered.length||released.length){
  const values={...remembered.values,...wanted};
  for(const key of released)delete values[key];
  const next={...remembered,schema:DISPLAY_RECORD_SCHEMA,values,updatedAt:now()};
  if(schema<DISPLAY_RECORD_SCHEMA)next.upgradedAt=now();
  await fs.writeFile(recordFile,JSON.stringify(next,null,2)+'\n',{mode:0o600});
 }
 return {optionsFile,recordFile,written:applied.length>0,firstSeed:!remembered,upgraded:Boolean(remembered)&&!future&&schema<DISPLAY_RECORD_SCHEMA,deferred:deferredWritten,released,keys:applied};
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
module.exports={hex16,videoMemoryMB,busId,distinctAdapters,isDiscreteAdapter,parseNvidiaSmi,parseLspci,parseWindowsVideoControllers,parseSystemProfiler,gpuAdapters,drmCards,sessionDisplay,targetAdapter,pciForDriPrime,renderOffload,reportedDevices,reportedAdapter,chooseDevice,matchAdapter,vendorOf,isSoftwareRenderer,isIntegrated,softwareFallback,hardwareProfile,graphicsRecommended,graphicsTunable,detectHardware,SHADER_PACK_NAME,QUALITY_LADDER,qualitySettings,parseProperties,readProperty,mergeProperties,applyQualitySettings,recordQuality,installedQuality,tunedDigest,GUI_SCALE_LADDER,GUI_SCALE_DEFAULT,displayGuiScale,displayPhysicalPixels,displayDefaultValues,DISPLAY_DEFAULTS,DISPLAY_RECORD,DISPLAY_RECORD_SCHEMA,DISPLAY_SCHEMA_KEYS,DISPLAY_DEFERRED_KEYS,DEBUG_BINDINGS,applyDisplayDefaults};
