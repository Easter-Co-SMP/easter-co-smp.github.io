// Hardware detection and the client's own quality settings. Every case here is a
// fixture: the machine's reported GPU, a software renderer, integrated graphics and
// an adapter that will not say how much video memory it has. Nothing reaches the
// network, and nothing writes outside a temporary directory.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {hardwareProfile,graphicsRecommended,graphicsTunable,detectHardware,gpuAdapters,drmCards,sessionDisplay,targetAdapter,renderOffload,pciForDriPrime,parseNvidiaSmi,parseLspci,parseWindowsVideoControllers,parseSystemProfiler,matchAdapter,chooseDevice,reportedDevices,reportedAdapter,vendorOf,isSoftwareRenderer,isIntegrated,softwareFallback,hex16,videoMemoryMB,busId,qualitySettings,parseProperties,mergeProperties,applyQualitySettings,recordQuality,installedQuality,applyDisplayDefaults,displayGuiScale,displayPhysicalPixels,displayDefaultValues,GUI_SCALE_LADDER,GUI_SCALE_DEFAULT,DISPLAY_DEFAULTS,DISPLAY_RECORD,DISPLAY_RECORD_SCHEMA,DISPLAY_SCHEMA_KEYS,DISPLAY_DEFERRED_KEYS,SHADER_PACK_NAME}=require('../../desktop/hardware.cjs');
const {deriveQuality}=require('../../desktop/install.cjs');
async function tempDir(prefix){return fs.mkdtemp(path.join(os.tmpdir(),prefix));}

// ---- fixtures: what each platform actually reports ---------------------------
// This machine, as Electron reports it: two NVIDIA adapters with the first one
// active, and no adapter string and no memory at all. 10370 is 0x2882 (the RTX
// 4060) and 9351 is 0x2487 (the RTX 3060), exactly as the real run reported.
const EASTER_SERVER_GPU_INFO={auxAttributes:{glImplementationParts:'(gl=none,angle=none)'},gpuDevice:[{active:true,deviceId:10370,vendorId:4318,gpuPreference:0},{active:false,deviceId:9351,vendorId:4318,gpuPreference:0}]};
const EASTER_SERVER_NVIDIA_SMI='0, NVIDIA GeForce RTX 4060, 8188, 00000000:03:00.0\n1, NVIDIA GeForce RTX 3060, 12288, 00000000:07:00.0\n';
const EASTER_SERVER_LSPCI='03:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD107 [GeForce RTX 4060] [10de:2882] (rev a1)\n07:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA104 [GeForce RTX 3060] [10de:2487] (rev a1)\n';
const SOFTWARE_STATUS={gpu_compositing:'disabled_software',webgl:'disabled_off',rasterization:'disabled_software'};
const HARDWARE_STATUS={gpu_compositing:'enabled',webgl:'enabled',rasterization:'enabled'};

test('the PCI ids a browser reports and the ones lspci prints are the same device',()=>{
 // Chromium reports decimal numbers; lspci prints four hex digits.
 assert.equal(hex16(4318),'10de');
 assert.equal(hex16('0x10DE'),'10de');
 assert.equal(hex16('10de'),'10de');
 assert.equal(hex16('2882'),'2882');
 assert.equal(hex16(2882),'0b42','a number is rendered as hex, not read as a hex string');
 assert.equal(hex16(''),null);
 assert.equal(hex16(undefined),null);
 assert.equal(hex16('not-an-id'),null);
 assert.equal(busId('00000000:03:00.0'),'03:00.0');
 assert.equal(busId('0000:07:00.0'),'07:00.0');
 assert.equal(busId('whatever'),null);
});

test('the system probes are parsed as the platform prints them, and quote nothing invented',()=>{
 const nvidia=parseNvidiaSmi(EASTER_SERVER_NVIDIA_SMI);
 assert.deepEqual(nvidia.map(adapter=>adapter.name),['NVIDIA GeForce RTX 4060','NVIDIA GeForce RTX 3060']);
 assert.deepEqual(nvidia.map(adapter=>adapter.vramMB),[8188,12288]);
 assert.deepEqual(nvidia.map(adapter=>adapter.busId),['03:00.0','07:00.0']);
 const lspci=parseLspci(EASTER_SERVER_LSPCI);
 assert.deepEqual(lspci.map(adapter=>[adapter.vendorId,adapter.deviceId]),[['10de','2882'],['10de','2487']]);
 assert.equal(lspci[0].name,'NVIDIA Corporation AD107 [GeForce RTX 4060]');
 assert.equal(lspci[0].vramMB,null,'lspci does not report video memory, and it is not invented');
 assert.deepEqual(parseNvidiaSmi(''),[]);
 assert.deepEqual(parseLspci('not lspci output'),[]);
 assert.equal(parseNvidiaSmi('0, [N/A], [N/A], [N/A]').length,0,'an adapter with no values is not reported');
 // Windows and macOS report their own way.
 const windows=parseWindowsVideoControllers('NVIDIA GeForce RTX 4060|8589934592\nIntel(R) UHD Graphics 630|1073741824');
 assert.deepEqual(windows.map(adapter=>adapter.vramMB),[8192,1024]);
 const mac=parseSystemProfiler('      Chipset Model: Apple M2 Pro\n        VRAM (Total): 16 GB\n');
 assert.deepEqual(mac.map(adapter=>[adapter.name,adapter.vramMB]),[['Apple M2 Pro',16384]]);
 assert.equal(videoMemoryMB(' 8188 '),8188);
 assert.equal(videoMemoryMB('8,192'),8192);
 assert.equal(videoMemoryMB(0),null);
 assert.equal(videoMemoryMB(-5),null);
 assert.equal(videoMemoryMB('lots'),null);
});

test('which reported device is in use decides which adapter is described',()=>{
 const devices=[{active:false,deviceId:10370,vendorId:4318},{active:true,deviceId:9351,vendorId:4318}];
 assert.equal(chooseDevice(devices).deviceId,9351);
 assert.equal(chooseDevice([]),null);
 const adapters=[{name:'NVIDIA Corporation GA104 [GeForce RTX 3060]',vendorId:'10de',deviceId:'2487',vramMB:12288},{name:'NVIDIA Corporation AD107 [GeForce RTX 4060]',vendorId:'10de',deviceId:'2882',vramMB:8188}];
 // 0x2487 is 9351 decimal, so the active entry is the 3060.
 const chosen=matchAdapter({adapter:null,devices:[{active:true,deviceId:9351,vendorId:4318},{active:false,deviceId:10370,vendorId:4318}],adapters});
 assert.equal(chosen.name,'NVIDIA Corporation GA104 [GeForce RTX 3060]');
 assert.equal(chosen.vramMB,12288);
 // Two adapters, no usable report: the vendor is said, the model is not guessed.
 const ambiguous=matchAdapter({adapter:null,devices:[],adapters});
 assert.equal(ambiguous.name,null);
 assert.equal(ambiguous.vendor,'NVIDIA');
 assert.equal(ambiguous.vramMB,null);
 assert.equal(matchAdapter({adapter:null,devices:[],adapters:[]}),null);
});

test('the tier is "capable" only for a discrete adapter with reported video memory',()=>{
 const dedicated=hardwareProfile({adapter:'NVIDIA GeForce RTX 4060',devices:[],featureStatus:HARDWARE_STATUS,adapters:[{name:'NVIDIA GeForce RTX 4060',vramMB:8188,source:'nvidia-smi'}]});
 assert.deepEqual({gpu:dedicated.gpu,vendor:dedicated.vendor,vramMB:dedicated.vramMB,tier:dedicated.tier},{gpu:'NVIDIA GeForce RTX 4060',vendor:'NVIDIA',vramMB:8188,tier:'capable'});
 assert.match(dedicated.reason,/8188 MB/);
 assert.equal(dedicated.reason.split('.').filter(Boolean).length,1,'the reason is one short sentence');
 assert.equal(graphicsRecommended(dedicated),true);
 assert.equal(graphicsTunable(dedicated),true);
 // A software renderer is clearly weak, whatever it claims.
 for(const name of ['llvmpipe (LLVM 23.1.1, 256 bits)','SwiftShader Device (Subzero)','softpipe','Mesa OffScreen']){
  const profile=hardwareProfile({adapter:name,featureStatus:SOFTWARE_STATUS});
  assert.equal(profile.tier,'weak',name+' is weak');
  assert.equal(graphicsRecommended(profile),false,name+' leaves enhanced graphics off');
  assert.match(profile.reason,/stay(s)? off|Software/);
 }
 // Integrated graphics are weak, whether or not the platform reports shared memory.
 for(const name of ['Intel(R) UHD Graphics 630','Intel(R) Iris(R) Xe Graphics','AMD Radeon Graphics','Apple M2']){
  const profile=hardwareProfile({adapter:name,featureStatus:HARDWARE_STATUS,adapters:[{name,vramMB:2048}]});
  assert.equal(profile.tier,'weak',name+' is weak');
  assert.equal(graphicsRecommended(profile),false,name);
  assert.match(profile.reason,/integrated/i);
 }
 // A known discrete adapter whose memory the machine will not report is honest
 // about it: unknown, not capable and not weak.
 const silent=hardwareProfile({adapter:null,devices:[],featureStatus:HARDWARE_STATUS,adapters:[{name:'NVIDIA Corporation GA104 [GeForce RTX 3060]',vendorId:'10de',deviceId:'2487',vramMB:null,source:'lspci'}]});
 assert.equal(silent.tier,'unknown');
 assert.equal(silent.vramMB,null);
 assert.equal(silent.vendor,'NVIDIA');
 assert.equal(graphicsRecommended(silent),true,'unknown is not weak: the rule is on unless clearly weak');
 assert.equal(graphicsTunable(silent),false,'and no quality level is promised without a reported memory figure');
 assert.match(silent.reason,/does not report video memory/);
 // Nothing at all: also unknown, also on.
 const nothing=hardwareProfile({adapter:null,devices:[],featureStatus:HARDWARE_STATUS,adapters:[]});
 assert.equal(nothing.tier,'unknown');
 assert.equal(nothing.gpu,null);
 assert.equal(nothing.vramMB,null);
 assert.equal(graphicsRecommended(nothing),true);
 assert.equal(graphicsTunable(nothing),false);
 assert.equal(nothing.reason.split('. ').length,1);
 // A fallback to software inside a machine with no identifiable adapter is weak,
 // and it says why without claiming a GPU it cannot see.
 const headless=hardwareProfile({adapter:null,devices:[],featureStatus:SOFTWARE_STATUS,adapters:[]});
 assert.equal(headless.tier,'weak');
 assert.match(headless.reason,/without GPU acceleration/);
 assert.equal(softwareFallback(SOFTWARE_STATUS),true);
 assert.equal(softwareFallback(HARDWARE_STATUS),false);
 assert.equal(softwareFallback(null),false);
 assert.equal(isSoftwareRenderer('llvmpipe'),true);
 assert.equal(isSoftwareRenderer('Intel UHD Graphics'),false);
 assert.equal(isIntegrated('AMD Radeon Graphics'),true);
 assert.equal(isIntegrated('NVIDIA GeForce RTX 4060'),false);
 assert.equal(vendorOf('GeForce RTX 4060'),'NVIDIA');
 assert.equal(vendorOf('Radeon RX 7900'),'AMD');
 assert.equal(vendorOf('Apple M2 Pro'),'Apple');
 assert.equal(vendorOf('something else'),null);
 assert.equal(reportedAdapter({auxAttributes:{glRenderer:'ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)'}}),'ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)');
 assert.equal(reportedAdapter({auxAttributes:{}}),null);
 assert.deepEqual(reportedDevices({gpuDevice:[{active:true}]}).length,1);
 assert.deepEqual(reportedDevices(null),[]);
});

// Owen's rule of 2026-10-17: the launcher targets exactly one GPU and it must be the GPU
// the display runs on. These are this machine's own two cards, as /sys/class/drm reports
// them: a monitor on card0 (RTX 4060, PCI 03:00.0) and a headless card1 (RTX 3060) that
// the firmware happens to make the boot VGA device.
const EASTER_SERVER_ADAPTERS=()=>parseLspci(EASTER_SERVER_LSPCI).map((adapter,index)=>({...adapter,vramMB:parseNvidiaSmi(EASTER_SERVER_NVIDIA_SMI)[index].vramMB}));
const EASTER_SERVER_CARDS=[
 {index:'0',bus:'0000:03:00.0',vendorId:'10de',deviceId:'2882',bootVga:false,connected:1},
 {index:'1',bus:'0000:07:00.0',vendorId:'10de',deviceId:'2487',bootVga:true,connected:0}
];
test('the display GPU is the card a monitor is wired to, not the boot VGA device',()=>{
 const adapters=EASTER_SERVER_ADAPTERS();
 // Chromium marks the 3060 active here, exactly as it does on a headless seat; the
 // connected output is what settles it.
 const devices=[{active:true,deviceId:0x2487,vendorId:0x10de},{active:false,deviceId:0x2882,vendorId:0x10de}];
 const display=sessionDisplay({devices,adapters,cards:EASTER_SERVER_CARDS});
 assert.equal(display.via,'connected');
 assert.match(display.adapter.name,/RTX 4060/,'the display card is described, not the active one');
 const target=targetAdapter({display,adapters});
 assert.equal(target.via,'connected');
 assert.equal(target.offload,false,'the display card needs no offload: the driver already renders there');
 const hardware=hardwareProfile({chosen:target.adapter,adapters,via:target.via});
 assert.match(hardware.gpu,/RTX 4060/);
 assert.equal(hardware.vramMB,8188,'one card, its own memory');
 assert.equal(hardware.tier,'capable');
 assert.equal(hardware.adapters,2,'the machine is still known to have two');
 assert.doesNotMatch(hardware.reason,/adapters/,'the launcher has one answer, so it gives one');
 assert.equal(hardware.reason.split('. ').length,1,'one sentence');
});
test('with monitors on two cards the session renderer breaks the tie',()=>{
 const adapters=EASTER_SERVER_ADAPTERS();
 const both=EASTER_SERVER_CARDS.map(card=>({...card,connected:1}));
 const onTheSix=sessionDisplay({devices:[{active:true,deviceId:0x2882,vendorId:0x10de}],adapters,cards:both});
 assert.equal(onTheSix.via,'connected');
 assert.match(onTheSix.adapter.name,/RTX 4060/,'the card this window is drawn on wins the tie');
 const onTheFive=sessionDisplay({devices:[{active:true,deviceId:0x2487,vendorId:0x10de}],adapters,cards:both});
 assert.match(onTheFive.adapter.name,/RTX 3060/,'and the other way round when that is the session card');
 assert.equal(onTheFive.via,'connected');
});
test('a seat with no connected output falls back to the session renderer, then to boot_vga',()=>{
 const adapters=EASTER_SERVER_ADAPTERS();
 // A streamed seat: the display is synthesised, so nothing reads connected.
 const headless=EASTER_SERVER_CARDS.map(card=>({...card,connected:0}));
 const bySession=sessionDisplay({devices:[{active:true,deviceId:0x2487,vendorId:0x10de}],adapters,cards:headless});
 assert.equal(bySession.via,'reported',"the seat's own renderer answers when no monitor is attached");
 assert.match(bySession.adapter.name,/RTX 3060/);
 const byBoot=sessionDisplay({devices:[],adapters,cards:headless});
 assert.equal(byBoot.via,'boot-vga');
 assert.match(byBoot.adapter.name,/RTX 3060/,"and the firmware's device is the last resort");
 const nothing=sessionDisplay({devices:[],adapters,cards:[]});
 assert.equal(nothing.via,'unknown');
 assert.equal(nothing.adapter,null,'nothing is invented when nothing resolves');
});
test('a display wired to an integrated part still targets the discrete card, and says so',()=>{
 const intel={name:'Intel(R) UHD Graphics 630',vendor:'Intel',vendorId:'8086',deviceId:'3e9b',vramMB:null};
 const nvidia={name:'NVIDIA GeForce RTX 3050 Laptop GPU',vendor:'NVIDIA',vendorId:'10de',deviceId:'25e5',vramMB:4096,busId:'0000:01:00.0'};
 const adapters=[intel,nvidia];
 const display=sessionDisplay({devices:[{active:true,deviceId:0x3e9b,vendorId:0x8086}],adapters,cards:[]});
 const target=targetAdapter({display,adapters});
 assert.equal(target.via,'offload','the integrated display part is not the target when one discrete card can render');
 assert.match(target.adapter.name,/RTX 3050/);
 assert.equal(target.offload,true);
 assert.deepEqual(renderOffload({platform:'linux',target:target.adapter,via:target.via}),
  {'__NV_PRIME_RENDER_OFFLOAD':'1','__GLX_VENDOR_LIBRARY_NAME':'nvidia','__VK_LAYER_NV_optimus':'NVIDIA_only'});
 // Mesa spells the same intent with the card's PCI address.
 const amd={name:'AMD Radeon RX 6600',vendor:'AMD',vendorId:'1002',deviceId:'73ff',vramMB:8192,busId:'0000:05:00.0'};
 const amdTarget=targetAdapter({display,adapters:[intel,amd]});
 assert.deepEqual(renderOffload({platform:'linux',target:amdTarget.adapter,via:amdTarget.via}),
  {'DRI_PRIME':'pci-0000_05_00_0','MESA_VK_DEVICE_SELECT':'pci-0000_05_00_0'});
 // And the launcher does not claim an override it cannot make.
 assert.deepEqual(renderOffload({platform:'win32',target:nvidia,via:'offload'}),{},'Windows chooses per application itself');
 assert.deepEqual(renderOffload({platform:'darwin',target:{...nvidia,name:'Apple M2 Pro',vendor:'Apple'},via:'offload'}),{});
 assert.deepEqual(renderOffload({platform:'linux',target:nvidia,via:'connected'}),{},'no pin when the target already drives the display');
});

test('detection on this machine describes the card that is actually driving the display',async()=>{
 // The exact report shape this machine produces, with the probes as fixtures so the
 // case is the same on any host.
 const detected=await detectHardware({
  gpuInfo:EASTER_SERVER_GPU_INFO,
  featureStatus:SOFTWARE_STATUS,
  platform:'linux',
  env:{EASTER_NVIDIA_SMI:'/bin/echo',EASTER_LSPCI:'/bin/echo'},
  adapters:[...parseLspci(EASTER_SERVER_LSPCI).map((adapter,index)=>({...adapter,vramMB:parseNvidiaSmi(EASTER_SERVER_NVIDIA_SMI)[index].vramMB}))]
 });
 assert.equal(detected.gpu.includes('RTX 4060'),true,'the active device 0x2882 matches the 4060, not the 3060: '+detected.gpu);
 assert.equal(detected.vendor,'NVIDIA');
 assert.equal(detected.vramMB,8188);
 assert.equal(detected.tier,'capable');
 assert.equal(detected.recommended,true);
 assert.equal(detected.tunable,true);
 // The same machine without nvidia-smi: the adapter is still named, the memory is
 // not invented.
 const withoutMemory=await detectHardware({gpuInfo:EASTER_SERVER_GPU_INFO,featureStatus:HARDWARE_STATUS,platform:'linux',adapters:parseLspci(EASTER_SERVER_LSPCI)});
 assert.equal(withoutMemory.vramMB,null);
 assert.equal(withoutMemory.tier,'unknown');
 assert.equal(withoutMemory.recommended,true);
 // And a machine where the probes are absent entirely does not throw.
 const bare=await detectHardware({gpuInfo:null,featureStatus:null,platform:'linux',env:{EASTER_NVIDIA_SMI:'/nonexistent/nvidia-smi',EASTER_LSPCI:'/nonexistent/lspci'}});
 assert.equal(bare.tier,'unknown');
 assert.equal(bare.recommended,true);
});

test('the probe reads the platform command line and survives its absence',async()=>{
 // A test double is not needed: the real commands are asked with a name that
 // cannot exist, so the parsing path is exercised and the failure path is proven.
 const adapters=await gpuAdapters({platform:'linux',env:{EASTER_NVIDIA_SMI:'/nonexistent/nvidia-smi',EASTER_LSPCI:'/nonexistent/lspci'}});
 assert.deepEqual(adapters,[]);
 const empty=await gpuAdapters({platform:'aix',env:{}});
 assert.deepEqual(empty,[]);
});

// ---- the client's own quality settings ---------------------------------------
test('quality settings are the highest the reported video memory supports',()=>{
 const at=vramMB=>qualitySettings({vramMB,tier:'capable'});
 assert.deepEqual(at(1024),{renderDistance:6,shadowDistance:4,graphicsMode:'fast',shaders:false,shaderPack:null});
 assert.deepEqual(at(2048),{renderDistance:8,shadowDistance:4,graphicsMode:'fast',shaders:false,shaderPack:null});
 assert.deepEqual(at(3072),{renderDistance:10,shadowDistance:6,graphicsMode:'fancy',shaders:false,shaderPack:null});
 assert.deepEqual(at(4096),{renderDistance:12,shadowDistance:8,graphicsMode:'fancy',shaders:true,shaderPack:SHADER_PACK_NAME});
 assert.deepEqual(at(6144).renderDistance,14);
 assert.deepEqual(at(8000).renderDistance,16,'the top rung starts at 8000 so a nominal 8 GB card can reach it');
 assert.deepEqual(at(8192),{renderDistance:16,shadowDistance:12,graphicsMode:'fancy',shaders:true,shaderPack:'ComplementaryUnbound_r5.9.3.zip'});
 assert.deepEqual(at(24576),at(8192),'beyond the top rung the settings do not keep growing');
 // The display GPU on this machine reports 8188 MiB and gets the top rung.
 assert.deepEqual(at(8188).renderDistance,16);
 // The ladder is monotonic: more memory never buys less quality.
 let previous=at(0);
 for(const vram of [1024,2048,3072,4096,6144,8192,12288,32768]){
  const current=at(vram);
  assert(current.renderDistance>=previous.renderDistance,vram+' MB');
  assert(current.shadowDistance>=previous.shadowDistance,vram+' MB');
  previous=current;
 }
 // No report: conservative, and no shader pack chosen for a card we know nothing about.
 const unknown=qualitySettings({vramMB:null,tier:'unknown'});
 assert.deepEqual(unknown,{renderDistance:6,shadowDistance:4,graphicsMode:'fast',shaders:false,shaderPack:null});
 // A weak adapter keeps the shaders off however much memory it reports.
 assert.deepEqual(qualitySettings({vramMB:8192,tier:'weak'}),{renderDistance:10,shadowDistance:12,graphicsMode:'fancy',shaders:false,shaderPack:null});
 // The install pipeline derives the same thing from a detected profile.
 assert.deepEqual(deriveQuality({vramMB:8188,tier:'capable'}),at(8188));
 assert.deepEqual(deriveQuality({}),unknown);
 assert.deepEqual(deriveQuality(null),unknown);
});

test('properties files are merged, not replaced',()=>{
 assert.equal(parseProperties('a:1\nb = two\n# comment\n').get('a'),'1');
 assert.equal(parseProperties('a:1\n').get('b'),undefined);
 const merged=mergeProperties('graphicsMode:fast\nrenderDistance:8\nfov:0.5\n',{renderDistance:'16'});
 assert.equal(merged,'graphicsMode:fast\nrenderDistance:16\nfov:0.5\n','only the named key changed and the rest of the file is intact');
 const added=mergeProperties('fov:0.5\n',{graphicsMode:'fancy',renderDistance:'16'});
 assert.deepEqual(added.split('\n').filter(Boolean),['fov:0.5','graphicsMode:fancy','renderDistance:16']);
 assert.equal(mergeProperties('',{a:'1'}),'a:1\n');
 assert.equal(mergeProperties('a:1\r\nb:2\r\n',{b:'3'}),'a:1\nb:3\n','line endings are not doubled up');
 assert.equal(mergeProperties('distance:4\n',{renderDistance:'16'}).includes('distance:4'),true,'a similar key name is not mistaken for the target');
});

test('the quality files are written inside the launcher’s own client tree only',async()=>{
 const dir=await tempDir('easter-quality-');
 const root=path.join(dir,'minecraft');
 const foreign=path.join(dir,'.minecraft');
 try{
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await fs.writeFile(path.join(root,'options.txt'),'graphicsMode:fast\nrenderDistance:8\nfov:0.5\n');
  await fs.mkdir(path.join(root,'config'),{recursive:true});
  await fs.writeFile(path.join(root,'config','iris.properties'),'enableShaders:false\nshadowDistance:4\n');
  const quality=qualitySettings({vramMB:8188,tier:'capable'});
  const written=await applyQualitySettings(root,quality);
  assert.deepEqual(written.tuned,{renderDistance:16,shadowDistance:12,shaders:true});
  const options=await fs.readFile(path.join(root,'options.txt'),'utf8');
  assert.match(options,/^graphicsMode:fancy$/m);
  assert.match(options,/^renderDistance:16$/m);
  assert.match(options,/^fov:0\.5$/m,'an unrelated setting is left alone');
  const iris=await fs.readFile(path.join(root,'config','iris.properties'),'utf8');
  assert.match(iris,/^enableShaders:true$/m);
  assert.match(iris,/^shaderPack:ComplementaryUnbound_r5\.9\.3\.zip$/m);
  assert.match(iris,/^shadowDistance:12$/m);
  // The marker records what was written, and reading it back reports the same.
  await fs.writeFile(path.join(root,'installed.json'),JSON.stringify({version:'fabric-1',files:[]}));
  assert.equal(await recordQuality(root,quality),true);
  assert.deepEqual(await installedQuality(root),{renderDistance:16,shadowDistance:12,shaders:true});
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'installed.json'),'utf8')).version,'fabric-1','the marker keeps everything else it carried');
  // A tree without the launcher's marker is refused: that is the rule that keeps an
  // existing .minecraft, another launcher and the server untouched.
  await fs.mkdir(foreign,{recursive:true});
  await fs.writeFile(path.join(foreign,'options.txt'),'renderDistance:8\n');
  const before=await fs.readFile(path.join(foreign,'options.txt'),'utf8');
  await assert.rejects(applyQualitySettings(foreign,quality),/not the launcher/);
  assert.equal(await fs.readFile(path.join(foreign,'options.txt'),'utf8'),before);
  assert.equal(await fs.stat(path.join(foreign,'config','iris.properties')).then(()=>'present',()=>'absent'),'absent');
  // And a tree with no record at all has no quality to report.
  const unmarked=path.join(dir,'client');
  await fs.mkdir(unmarked,{recursive:true});
  assert.equal(await installedQuality(unmarked),null);
  assert.equal(await recordQuality(unmarked,quality),false,'a setting write never creates the install marker');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a quality setting write does not create the installed marker it may not own',async()=>{
 const dir=await tempDir('easter-quality-marker-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await fs.writeFile(path.join(root,'installed.json'),'not json');
  assert.equal(await recordQuality(root,qualitySettings({vramMB:8192,tier:'capable'})),false,'a damaged marker is left for the pipeline to repair');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

// ---- the client's display defaults -------------------------------------------
// Owen asked for a first launch that is already fullscreen at GUI scale 2, then for the
// five controls the household plays with, then for the rest of the approved set: chat on
// enter, the GUI toggle on F10, social interactions on I, smooth camera on right shift,
// the vanilla debug keys unbound, and the Shippy Ships quick-build hotkey moved off the
// Left Ctrl that crouch owns. The keys live in options.txt, are seeded once per client
// tree, and are then never rewritten unless a covered key has gone missing or the table
// has grown a key the record does not cover yet.
const DEFERRED_KEY='key_key.shippy-ships.isPressingCtrl';
// Pinned by name: these are the actions this client writes, so an action it stops writing
// is a name to remove from the table rather than a key left half-bound.
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
// The values Owen verified in the real clients, in the order the table writes them.
const WANTED_BINDS={
 'key_key.sneak':'key.keyboard.left.control',
 'key_key.sprint':'key.keyboard.left.shift',
 'key_key.inventory':'key.keyboard.tab',
 'key_key.playerlist':'key.keyboard.grave.accent',
 'key_key.togglePerspective':'key.keyboard.r',
 'key_key.chat':'key.keyboard.enter',
 'key_key.toggleGui':'key.keyboard.f10',
 'key_key.socialInteractions':'key.keyboard.i',
 'key_key.smoothCamera':'key.keyboard.right.shift',
 ...Object.fromEntries(DEBUG_BINDINGS.map(key=>[key,'key.keyboard.unknown'])),
 [DEFERRED_KEY]:'key.keyboard.right.control'
};
// Vanilla's values for the five controls the household layout moves. The rest of the
// table is either a key vanilla leaves unbound (smooth camera, the debug keys) or one no
// vanilla action uses.
const VANILLA_BINDS={
 'key_key.sneak':'key.keyboard.left.shift',
 'key_key.sprint':'key.keyboard.left.control',
 'key_key.inventory':'key.keyboard.e',
 'key_key.playerlist':'key.keyboard.tab',
 'key_key.togglePerspective':'key.keyboard.f5'
};
const SEEDED_BINDINGS=Object.keys(WANTED_BINDS);
// What a fresh tree gets: everything except the binding only a mod can register.
const IMMEDIATE_BINDINGS=SEEDED_BINDINGS.filter(key=>key!==DEFERRED_KEY);
const bindLines=binds=>Object.entries(binds).map(([key,value])=>key+':'+value);
const immediateBinds=()=>Object.fromEntries(IMMEDIATE_BINDINGS.map(key=>[key,WANTED_BINDS[key]]));
const seededLines=(guiScale='2')=>['guiScale:'+guiScale,'fullscreen:true',...bindLines(immediateBinds())];
// The Shippy key as the client writes it once the mod has registered its own default,
// and as this seed wants it.
const DEFERRED_VANILLA=DEFERRED_KEY+':key.keyboard.left.control';
const DEFERRED_SEEDED=DEFERRED_KEY+':key.keyboard.right.control';
const shown=text=>text.split('\n').filter(Boolean);
const optionsText=root=>fs.readFile(path.join(root,'options.txt'),'utf8');
const recordText=root=>fs.readFile(path.join(root,DISPLAY_RECORD),'utf8');
const SEVEN_KEYS={'key_key.sneak':WANTED_BINDS['key_key.sneak'],'key_key.sprint':WANTED_BINDS['key_key.sprint'],'key_key.inventory':WANTED_BINDS['key_key.inventory'],'key_key.playerlist':WANTED_BINDS['key_key.playerlist'],'key_key.togglePerspective':WANTED_BINDS['key_key.togglePerspective']};
// No two seeded actions may share a key. `key.keyboard.unknown` is the client's own word
// for an action with no key, so the debug keys are counted as unbound rather than as one
// shared binding.
function assertDistinctBindings(text,label){
 const options=parseProperties(text);
 for(const key of DEBUG_BINDINGS)assert.equal(options.get(key),'key.keyboard.unknown',label+': '+key+' is unbound');
 const absent=IMMEDIATE_BINDINGS.filter(key=>!options.has(key));
 assert.deepEqual(absent,[],label+': every seeded action has a binding');
 // The deferred key is only there once the client has written it, so it joins the check
 // when it is present and is never missed when it is not.
 const bound=[...IMMEDIATE_BINDINGS,...(options.has(DEFERRED_KEY)?[DEFERRED_KEY]:[])].filter(key=>!DEBUG_BINDINGS.includes(key)).map(key=>[key,options.get(key)]);
 const values=bound.map(([,value])=>value).filter(value=>value!=='key.keyboard.unknown');
 assert.equal(new Set(values).size,values.length,label+': no two seeded actions share a key: '+JSON.stringify(bound));
}

test('the display defaults are seeded once into the launcher’s client tree',async()=>{
 const dir=await tempDir('easter-display-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  assert.deepEqual(DISPLAY_DEFAULTS,{guiScale:'2',fullscreen:'true',...WANTED_BINDS},'the values are Owen’s approved set, exactly');
  assert.equal(DISPLAY_RECORD,'.easter-client-display');
  assert.equal(DISPLAY_RECORD_SCHEMA,3,'the record covers the whole approved set, not only the display pair');
  assert.deepEqual(DISPLAY_DEFERRED_KEYS,[DEFERRED_KEY],'exactly one binding waits for its mod to register it');
  const seeded=await applyDisplayDefaults(root);
  assert.equal(seeded.written,true);
  assert.equal(seeded.firstSeed,true,'the first seed records itself');
  assert.equal(seeded.upgraded,false,'a fresh tree is not an upgrade of anything');
  assert.deepEqual(seeded.deferred,[],'a fresh tree has no mod-provided binding to write yet');
  assert.deepEqual(seeded.keys,['guiScale','fullscreen',...IMMEDIATE_BINDINGS],'the whole table except the deferred key, in one seed');
  // Read the file itself, not the intent.
  const options=await optionsText(root);
  assert.deepEqual(shown(options),seededLines());
  assert.equal(options.includes('\r'),false,'LF line endings');
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mode&0o777,0o600,'the same mode the quality writer uses');
  assertDistinctBindings(options,'the first seed');
  const record=JSON.parse(await recordText(root));
  assert.equal(record.schema,DISPLAY_RECORD_SCHEMA);
  assert.deepEqual(record.values,{guiScale:'2',fullscreen:'true',...immediateBinds()},'the record carries exactly the keys it has written');
  assert.equal(DEFERRED_KEY in record.values,false,'the deferred key is not claimed before the client has written it');
  assert.equal(typeof record.appliedAt,'string');
  assert.match(record.appliedAt,/^\d{4}-\d\d-\d\dT/);
  assert.equal(record.upgradedAt,undefined,'a first seed is not an upgrade');
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mode&0o777,0o600);
  // The install pipeline owns installed.json; a settings write never creates it.
  assert.equal(await fs.stat(path.join(root,'installed.json')).then(()=>'present',()=>'absent'),'absent');
  assert.equal(await fs.stat(path.join(root,'config','iris.properties')).then(()=>'present',()=>'absent'),'absent','display defaults are not the graphics step');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the seeded bindings are the household layout, not vanilla’s',async()=>{
 // The layout is the feature, so it is asserted against the literals read off the real
 // clients rather than against the constants that produce them.
 assert.equal(DISPLAY_DEFAULTS['key_key.sneak'],'key.keyboard.left.control');
 assert.equal(DISPLAY_DEFAULTS['key_key.sprint'],'key.keyboard.left.shift');
 assert.equal(WANTED_BINDS['key_key.sneak'],VANILLA_BINDS['key_key.sprint'],'crouch takes sprint’s vanilla key');
 assert.equal(WANTED_BINDS['key_key.sprint'],VANILLA_BINDS['key_key.sneak'],'and sprint takes crouch’s');
 assert.equal(WANTED_BINDS['key_key.inventory'],'key.keyboard.tab','inventory takes the player list’s vanilla key');
 assert.equal(VANILLA_BINDS['key_key.playerlist'],'key.keyboard.tab','which is exactly why the player list has to move with it');
 assert.equal(WANTED_BINDS['key_key.playerlist'],'key.keyboard.grave.accent');
 assert.equal(WANTED_BINDS['key_key.togglePerspective'],'key.keyboard.r','third person moves off vanilla’s F5');
 assert.equal(WANTED_BINDS['key_key.chat'],'key.keyboard.enter','chat moves off vanilla’s t');
 assert.equal(WANTED_BINDS['key_key.toggleGui'],'key.keyboard.f10','the GUI toggle moves off vanilla’s F1');
 assert.equal(WANTED_BINDS['key_key.socialInteractions'],'key.keyboard.i','the social screen moves off vanilla’s p');
 assert.equal(WANTED_BINDS['key_key.smoothCamera'],'key.keyboard.right.shift','smooth camera takes right shift, which nothing else seeded uses');
 assert.equal(WANTED_BINDS[DEFERRED_KEY],'key.keyboard.right.control','Shippy’s quick build keeps the mod’s Ctrl intent, on the right hand');
 assert.notEqual(WANTED_BINDS[DEFERRED_KEY],WANTED_BINDS['key_key.sneak'],'so crouch owns Left Ctrl alone');
 for(const [key,value] of Object.entries(WANTED_BINDS))assert.equal(DISPLAY_DEFAULTS[key],value,key+' is seeded as Owen’s client has it');
 const dir=await tempDir('easter-display-swap-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await applyDisplayDefaults(root);
  const options=parseProperties(await optionsText(root));
  assert.equal(options.get('key_key.sneak'),'key.keyboard.left.control','crouch is on Left Ctrl');
  assert.equal(options.get('key_key.sprint'),'key.keyboard.left.shift','sprint is on Left Shift');
  assert.equal(options.get('key_key.inventory'),'key.keyboard.tab');
  assert.equal(options.get('key_key.playerlist'),'key.keyboard.grave.accent');
  assert.equal(options.get('key_key.togglePerspective'),'key.keyboard.r');
  assert.equal(options.get('key_key.chat'),'key.keyboard.enter');
  assert.equal(options.get('key_key.toggleGui'),'key.keyboard.f10');
  assert.equal(options.get('key_key.socialInteractions'),'key.keyboard.i');
  assert.equal(options.get('key_key.smoothCamera'),'key.keyboard.right.shift');
  assert.equal(options.has(DEFERRED_KEY),false,'and the mod’s own key is not invented on a tree that has never seen the mod');
  assertDistinctBindings(await optionsText(root),'the swap');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the seed writes the whole approved table and keeps the settings Owen did not ask for',async()=>{
 // The table is pinned by name and value, because it is the complete list of things the
 // launcher is allowed to have an opinion about. Owen's own client carries far more: the
 // free-camera and ReplayMod binds, the creative toolbar keys, the spectator hotbar and
 // Shippy's eject key. None of them is in the table, so none of them is ever touched —
 // including his replaymod.positionkeyframe, which his client has on the same I the social
 // screen is seeded to, exactly as his client has it.
 const TABLE={guiScale:'2',fullscreen:'true',...WANTED_BINDS};
 assert.deepEqual(DISPLAY_DEFAULTS,TABLE,'the table, name by name and value by value');
 assert.deepEqual(Object.keys(DISPLAY_DEFAULTS),Object.keys(TABLE),'and in the order it is written');
 assert.equal(Object.keys(TABLE).length,34,'two display values, 31 immediate bindings and the deferred one');
 assert.equal(IMMEDIATE_BINDINGS.length,31);
 assert.equal(DEBUG_BINDINGS.length,22,'the 22 vanilla debug actions');
 assert.deepEqual(Object.keys(DISPLAY_DEFAULTS).filter(key=>key.startsWith('key_key.debug.')).sort(),[...DEBUG_BINDINGS].sort(),'exactly those, with no guessed extra');
 const HIS_OTHER_SETTINGS=[
  'key_key.free-camera.camera_control:key.keyboard.unknown',
  'key_key.free-camera.hold_zoom:key.keyboard.unknown',
  'key_key.free-camera.reset:key.keyboard.unknown',
  'key_key.replaymod.marker:key.keyboard.m',
  'key_key.replaymod.positionkeyframe:key.keyboard.i',
  'key_key.spectatorHotbar:key.keyboard.unknown',
  'key_key.saveToolbarActivator:key.keyboard.unknown',
  'key_key.loadToolbarActivator:key.keyboard.unknown',
  'key_key.shippy-ships.eject_passengers:key.keyboard.v'
 ];
 const dir=await tempDir('easter-display-unrequested-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await fs.writeFile(path.join(root,'options.txt'),['version:4903','fov:0.5',...HIS_OTHER_SETTINGS].join('\n')+'\n');
  await applyDisplayDefaults(root);
  const after=await optionsText(root);
  for(const line of HIS_OTHER_SETTINGS)assert(shown(after).includes(line),'kept exactly as the player had it: '+line);
  assert.deepEqual(shown(after),['version:4903','fov:0.5',...HIS_OTHER_SETTINGS,...seededLines()],'his lines stay where they were, the table lands after them, and nothing else changes');
  // A fresh tree gets the table and none of his other settings.
  const fresh=path.join(dir,'fresh');
  await fs.mkdir(fresh,{recursive:true});
  await fs.writeFile(path.join(fresh,'.easter-client'),'');
  await applyDisplayDefaults(fresh);
  assert.deepEqual([...parseProperties(await optionsText(fresh)).keys()].sort(),['fullscreen','guiScale',...IMMEDIATE_BINDINGS].sort(),'the seed invents nothing beyond the table, and the deferred key is not invented either');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a tree that has already been played is seeded once, and a key the player changed later is never rewritten',async()=>{
 const dir=await tempDir('easter-display-played-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  // What the game itself writes on its first exit: every key, its own values.
  await fs.writeFile(path.join(root,'options.txt'),'fullscreen:false\nguiScale:4\nfov:0.5\nrenderDistance:12\n');
  const first=await applyDisplayDefaults(root);
  assert.equal(first.firstSeed,true,'an already-played tree still takes the defaults once');
  assert.deepEqual(shown(await optionsText(root)),['fullscreen:true','guiScale:2','fov:0.5','renderDistance:12',...bindLines(immediateBinds())],'the table wins on the first seed and every other line is kept');
  const optionsBefore=await fs.readFile(path.join(root,'options.txt'));
  const recordBefore=await recordText(root);
  const optionsStat=await fs.stat(path.join(root,'options.txt'));
  const recordStat=await fs.stat(path.join(root,DISPLAY_RECORD));
  // A second run has nothing to do and must touch neither file.
  const second=await applyDisplayDefaults(root);
  assert.equal(second.written,false);
  assert.equal(second.firstSeed,false);
  assert.equal(second.upgraded,false);
  assert.deepEqual(second.keys,[]);
  assert.deepEqual(await fs.readFile(path.join(root,'options.txt')),optionsBefore,'the file is byte-identical');
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,optionsStat.mtimeMs,'and its mtime is unchanged');
  assert.equal(await recordText(root),recordBefore);
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mtimeMs,recordStat.mtimeMs,'the record is written once and never again');
  // The player plays again and turns fullscreen off in the game's own settings.
  const playerChose='fullscreen:false\nguiScale:2\nfov:0.75\n'+bindLines(immediateBinds()).join('\n')+'\n';
  await fs.writeFile(path.join(root,'options.txt'),playerChose);
  const playerStat=await fs.stat(path.join(root,'options.txt'));
  const third=await applyDisplayDefaults(root);
  assert.equal(third.written,false,'a present key is the player’s own from now on');
  assert.equal(await optionsText(root),playerChose,'the launcher never re-decides a player’s choice');
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,playerStat.mtimeMs);
  // The player rebinds, in the game's own controls screen, sprint back to Ctrl, the player
  // list onto a key of their choosing, and chat back onto vanilla's t. All three are theirs.
  const reboundText=playerChose.replace('key_key.sprint:key.keyboard.left.shift','key_key.sprint:key.keyboard.left.control').replace('key_key.playerlist:key.keyboard.grave.accent','key_key.playerlist:key.keyboard.p').replace('key_key.chat:key.keyboard.enter','key_key.chat:key.keyboard.t');
  await fs.writeFile(path.join(root,'options.txt'),reboundText);
  const reboundStat=await fs.stat(path.join(root,'options.txt'));
  const rebound=await applyDisplayDefaults(root);
  assert.equal(rebound.written,false);
  assert.equal(await optionsText(root),reboundText,'a rebound key survives every later run');
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,reboundStat.mtimeMs);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the only later seed is repair: a covered key that went missing is written again, bindings included',async()=>{
 const dir=await tempDir('easter-display-repair-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await applyDisplayDefaults(root);
  const recordBefore=await recordText(root);
  const recordStat=await fs.stat(path.join(root,DISPLAY_RECORD));
  // A truncated options.txt: the record still says this tree was seeded.
  await fs.writeFile(path.join(root,'options.txt'),'renderDistance:12\n');
  const repaired=await applyDisplayDefaults(root);
  assert.equal(repaired.written,true);
  assert.equal(repaired.firstSeed,false,'a repair is not a fresh seed');
  assert.equal(repaired.upgraded,false,'and it is not a schema upgrade either');
  assert.deepEqual(shown(await optionsText(root)),['renderDistance:12',...seededLines()],'the missing keys are re-added and the rest is kept');
  assertDistinctBindings(await optionsText(root),'a full repair');
  assert.equal(await recordText(root),recordBefore,'the record describes the seed, so a repair leaves it alone');
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mtimeMs,recordStat.mtimeMs);
  // One key missing, one present and player-chosen: only the missing one comes back.
  await fs.writeFile(path.join(root,'options.txt'),'fullscreen:false\n');
  const single=await applyDisplayDefaults(root);
  assert.deepEqual(single.keys,['guiScale',...IMMEDIATE_BINDINGS]);
  assert.equal(await optionsText(root),'fullscreen:false\n'+['guiScale:2',...bindLines(immediateBinds())].join('\n')+'\n','the present key is untouched');
  // A binding that goes missing is repaired from the record exactly like a display key,
  // and a binding the player rebound meanwhile is left where they put it.
  await fs.writeFile(path.join(root,'options.txt'),'fullscreen:false\nguiScale:2\nkey_key.sneak:key.keyboard.left.control\n');
  const missingBind=await applyDisplayDefaults(root);
  assert.deepEqual(missingBind.keys,IMMEDIATE_BINDINGS.filter(key=>key!=='key_key.sneak'));
  assert.match(await optionsText(root),/^key_key\.playerlist:key\.keyboard\.grave\.accent$/m,'the recorded binding came back');
  assert.match(await optionsText(root),/^key_key\.debug\.overlay:key\.keyboard\.unknown$/m,'and so does an unbound debug key');
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(immediateBinds()).join('\n').replace('key_key.togglePerspective:key.keyboard.r','key_key.togglePerspective:key.keyboard.f5')+'\n');
  const reboundRepair=await applyDisplayDefaults(root);
  assert.equal(reboundRepair.written,false,'a player’s own third-person key is not "missing", so nothing is repaired over it');
  // options.txt deleted entirely, as a fresh profile or a botched reset would: every
  // covered key comes back, from the record.
  await fs.rm(path.join(root,'options.txt'));
  const recreated=await applyDisplayDefaults(root);
  assert.deepEqual(shown(await optionsText(root)),seededLines());
  assertDistinctBindings(await optionsText(root),'a recreated options.txt');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the inventory and player list keys land together, so no two actions share tab',async()=>{
 const dir=await tempDir('easter-display-group-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await applyDisplayDefaults(root);
  // The inventory line goes missing while the player has since moved the player list to
  // a key of their own: the repair writes inventory back on tab and leaves their key be,
  // because nothing collides.
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(immediateBinds()).filter(line=>!line.startsWith('key_key.inventory:')).join('\n').replace('key_key.playerlist:key.keyboard.grave.accent','key_key.playerlist:key.keyboard.p')+'\n');
  const inventoryOnly=await applyDisplayDefaults(root);
  assert.deepEqual(inventoryOnly.keys,['key_key.inventory'],'only the missing member of the group is written');
  assert.match(await optionsText(root),/^key_key\.playerlist:key\.keyboard\.p$/m,'the player’s own player list key is not overwritten');
  assertDistinctBindings(await optionsText(root),'a group repair against a player-chosen sibling');
  // The player list line sits on tab, which is the key the seed takes for inventory: both
  // members are written together.
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(immediateBinds()).join('\n').replace('key_key.playerlist:key.keyboard.grave.accent','key_key.playerlist:key.keyboard.tab')+'\n');
  const together=await applyDisplayDefaults(root);
  assert.equal(together.written,false,'both members are present and nothing is missing, so no repair runs');
  // Now the collision that matters: inventory is missing, and the player list still sits
  // on tab, the key inventory is about to take.
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(immediateBinds()).filter(line=>!line.startsWith('key_key.inventory:')).join('\n').replace('key_key.playerlist:key.keyboard.grave.accent','key_key.playerlist:key.keyboard.tab')+'\n');
  const paired=await applyDisplayDefaults(root);
  assert.deepEqual(paired.keys,['key_key.inventory','key_key.playerlist'],'inventory and the player list move together');
  const pairedOptions=await optionsText(root);
  assert.match(pairedOptions,/^key_key\.inventory:key\.keyboard\.tab$/m);
  assert.match(pairedOptions,/^key_key\.playerlist:key\.keyboard\.grave\.accent$/m,'the player list was moved off the key inventory takes');
  assertDistinctBindings(pairedOptions,'a group repair that had to break a collision');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

// The controls arrived after the display pair had already shipped, so a tree the earlier
// build had seeded carries a schema-1 record. That record only ever promised the display
// pair, so the upgrade writes exactly the keys the table has grown — the five bindings,
// the four new controls and the 22 debug unbinds — once, and leaves the display values,
// player-changed or not, exactly where they are.
test('a schema-1 record gets exactly the keys it does not cover added once, and its display values left alone',async()=>{
 const dir=await tempDir('easter-display-schema1-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  // The tree as the earlier build left it: a schema-1 record from the display-only seed,
  // and options.txt as the game writes it, with the player's own guiScale and fullscreen
  // and the vanilla key bindings.
  const appliedAt='2026-10-17T09:00:00.000Z';
  await fs.writeFile(path.join(root,DISPLAY_RECORD),JSON.stringify({schema:1,values:{guiScale:'2',fullscreen:'true'},appliedAt},null,2)+'\n',{mode:0o600});
  const before='version:4903\nfullscreen:false\nguiScale:4\n'+bindLines(VANILLA_BINDS).join('\n')+'\nfov:0.5\n';
  await fs.writeFile(path.join(root,'options.txt'),before);
  const upgraded=await applyDisplayDefaults(root,{guiScale:3});
  assert.equal(upgraded.written,true);
  assert.equal(upgraded.firstSeed,false,'the tree was already seeded by the older schema');
  assert.equal(upgraded.upgraded,true,'a schema-1 record is raised to this schema');
  assert.deepEqual(upgraded.deferred,[],'the mod’s key is not in this tree, so it is not written');
  assert.deepEqual(upgraded.keys,IMMEDIATE_BINDINGS,'only the keys the record never covered are written');
  // The five vanilla lines are rewritten where they stand; the keys the table has grown
  // are appended after the player's last line.
  const table=bindLines(immediateBinds());
  const five=table.slice(0,5),grown=table.slice(5);
  const expected=['version:4903','fullscreen:false','guiScale:4',...five,'fov:0.5',...grown].join('\n')+'\n';
  assert.equal(await optionsText(root),expected,'exactly the keys the record never covered, and every other line byte for byte where it was');
  assertDistinctBindings(await optionsText(root),'a schema-1 upgrade');
  const record=JSON.parse(await recordText(root));
  assert.equal(record.schema,3);
  assert.deepEqual(record.values,{guiScale:'2',fullscreen:'true',...immediateBinds()},'the values it already carried are kept, and the ones applied now are added');
  assert.equal(record.appliedAt,appliedAt,'the original seed time is still the seed time');
  assert.match(String(record.upgradedAt),/^\d{4}-\d\d-\d\dT/);
  assert.match(String(record.updatedAt),/^\d{4}-\d\d-\d\dT/);
  assert.equal(DEFERRED_KEY in record.values,false,'and it still claims nothing it has not written');
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mode&0o777,0o600);
  // Once only: the next run finds a schema-3 record and touches neither file.
  const optionsStat=await fs.stat(path.join(root,'options.txt'));
  const recordStat=await fs.stat(path.join(root,DISPLAY_RECORD));
  const optionsAfter=await fs.readFile(path.join(root,'options.txt'));
  const again=await applyDisplayDefaults(root,{guiScale:3});
  assert.equal(again.written,false);
  assert.equal(again.upgraded,false);
  assert.deepEqual(again.keys,[]);
  assert.deepEqual(await fs.readFile(path.join(root,'options.txt')),optionsAfter);
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,optionsStat.mtimeMs);
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mtimeMs,recordStat.mtimeMs);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a schema-2 tree is upgraded by exactly the keys it does not cover, and the Shippy key when the client has written it',async()=>{
 const dir=await tempDir('easter-display-schema2-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  // The tree as the previous build left it: a schema-2 record covering the display pair
  // and the five bindings, and options.txt with the player's own window mode and scale,
  // those five bindings, and the Shippy key the mod registered on the client's own run.
  const appliedAt='2026-10-18T09:00:00.000Z';
  await fs.writeFile(path.join(root,DISPLAY_RECORD),JSON.stringify({schema:2,values:{guiScale:'2',fullscreen:'true',...SEVEN_KEYS},appliedAt},null,2)+'\n',{mode:0o600});
  const before=['version:4903','fullscreen:false','guiScale:1',...bindLines(SEVEN_KEYS),DEFERRED_VANILLA,'fov:0.5'].join('\n')+'\n';
  await fs.writeFile(path.join(root,'options.txt'),before);
  const upgraded=await applyDisplayDefaults(root,{guiScale:4});
  assert.equal(upgraded.written,true);
  assert.equal(upgraded.firstSeed,false);
  assert.equal(upgraded.upgraded,true,'a schema-2 record is raised to this schema');
  assert.deepEqual(upgraded.deferred,[DEFERRED_KEY],'the mod’s key is covered now that the client has written it');
  const grown=IMMEDIATE_BINDINGS.filter(key=>!(key in SEVEN_KEYS));
  assert.deepEqual(upgraded.keys,[...grown,DEFERRED_KEY],'exactly the keys the record did not cover, and nothing it already had');
  const expected=['version:4903','fullscreen:false','guiScale:1',...bindLines(SEVEN_KEYS),DEFERRED_SEEDED,'fov:0.5',...bindLines(Object.fromEntries(grown.map(key=>[key,WANTED_BINDS[key]])))].join('\n')+'\n';
  assert.equal(await optionsText(root),expected,'the player’s scale, window mode and the seven covered keys are untouched; the Shippy key moved in place and the new keys landed after them');
  assertDistinctBindings(await optionsText(root),'a schema-2 upgrade');
  const record=JSON.parse(await recordText(root));
  assert.equal(record.schema,3);
  assert.equal(record.appliedAt,appliedAt,'the seed time does not move');
  assert.deepEqual(record.values,{guiScale:'2',fullscreen:'true',...WANTED_BINDS},'every key in the table is covered now, with the values that were applied');
  assert.match(String(record.upgradedAt),/^\d{4}-\d\d-\d\dT/);
  // Once only: a further run rewrites neither file.
  const optionsStat=await fs.stat(path.join(root,'options.txt'));
  const recordStat=await fs.stat(path.join(root,DISPLAY_RECORD));
  const again=await applyDisplayDefaults(root,{guiScale:4});
  assert.equal(again.written,false);
  assert.equal(again.upgraded,false);
  assert.deepEqual(again.keys,[]);
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,optionsStat.mtimeMs);
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mtimeMs,recordStat.mtimeMs);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the Shippy Ships hotkey waits for the client to write it, is seeded once, and is never rewritten',async()=>{
 const dir=await tempDir('easter-display-deferred-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  // A fresh tree: the mod has not run, so the binding does not exist, and vanilla would
  // drop any key_ entry this launcher invented for it. It is neither written nor claimed.
  const first=await applyDisplayDefaults(root);
  assert.equal(first.firstSeed,true);
  assert.deepEqual(first.deferred,[]);
  assert.equal(parseProperties(await optionsText(root)).has(DEFERRED_KEY),false,'the deferred key is not invented');
  const firstRecord=JSON.parse(await recordText(root));
  assert.equal(DEFERRED_KEY in firstRecord.values,false,'and it is not marked covered before it has been written');
  // The client runs once with the mod, which registers the binding on its own default.
  const seeded=await optionsText(root);
  const withModLine=seeded+DEFERRED_VANILLA+'\n';
  await fs.writeFile(path.join(root,'options.txt'),withModLine);
  const arrived=await applyDisplayDefaults(root);
  assert.equal(arrived.written,true,'the first launcher start after the client has run with the mod seeds it');
  assert.equal(arrived.firstSeed,false);
  assert.equal(arrived.upgraded,false,'this is not a schema upgrade');
  assert.deepEqual(arrived.deferred,[DEFERRED_KEY]);
  assert.deepEqual(arrived.keys,[DEFERRED_KEY],'and nothing else is touched');
  assert.equal(await optionsText(root),withModLine.replace(DEFERRED_VANILLA,DEFERRED_SEEDED),'only the mod’s own line changed, byte for byte');
  const arrivedRecord=JSON.parse(await recordText(root));
  assert.equal(arrivedRecord.schema,3,'the schema does not move for a deferred key');
  assert.equal(arrivedRecord.values[DEFERRED_KEY],'key.keyboard.right.control','the record covers it now that it has been written');
  assert.equal(arrivedRecord.appliedAt,firstRecord.appliedAt,'and the seed time is still the first seed’s');
  assert.match(String(arrivedRecord.updatedAt),/^\d{4}-\d\d-\d\dT/);
  // Once written, it is never rewritten: not on the next run, and not after the player
  // rebinds it back in the game's own controls screen.
  const optionsStat=await fs.stat(path.join(root,'options.txt'));
  const recordStat=await fs.stat(path.join(root,DISPLAY_RECORD));
  const again=await applyDisplayDefaults(root);
  assert.equal(again.written,false);
  assert.deepEqual(again.keys,[]);
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,optionsStat.mtimeMs);
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mtimeMs,recordStat.mtimeMs);
  await fs.writeFile(path.join(root,'options.txt'),withModLine);
  const kept=await applyDisplayDefaults(root);
  assert.equal(kept.written,false,'a covered key is the player’s, the deferred one included');
  assert.equal(await optionsText(root),withModLine);
  // A recreated options.txt is repaired like any other file, and the Shippy key is
  // released until the client writes it again: inventing it would be silently lost, and
  // leaving it covered would let the client's own Left Ctrl default survive for good.
  await fs.rm(path.join(root,'options.txt'));
  const recreated=await applyDisplayDefaults(root);
  assert.equal(recreated.written,true);
  assert.deepEqual(recreated.keys,['guiScale','fullscreen',...IMMEDIATE_BINDINGS],'every covered key comes back');
  assert.deepEqual(recreated.released,[DEFERRED_KEY],'and the mod’s key is released until the client writes it again');
  assert.equal(parseProperties(await optionsText(root)).has(DEFERRED_KEY),false);
  assert.equal(DEFERRED_KEY in JSON.parse(await recordText(root)).values,false,'so it is not covered while the tree has no such line');
  // The client runs with the mod again and writes it on its own default: the seed repairs
  // it back onto Right Ctrl, once.
  const rewritten=(await optionsText(root))+DEFERRED_VANILLA+'\n';
  await fs.writeFile(path.join(root,'options.txt'),rewritten);
  const repairedAgain=await applyDisplayDefaults(root);
  assert.deepEqual(repairedAgain.deferred,[DEFERRED_KEY]);
  assert.deepEqual(repairedAgain.keys,[DEFERRED_KEY]);
  assert.equal(await optionsText(root),rewritten.replace(DEFERRED_VANILLA,DEFERRED_SEEDED));
  assert.equal(JSON.parse(await recordText(root)).values[DEFERRED_KEY],'key.keyboard.right.control');
  const settled=await applyDisplayDefaults(root);
  assert.equal(settled.written,false,'and then it is the player’s again');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the 22 vanilla debug keys are unbound, so there is no F3 overlay and no debug combinations',async()=>{
 assert.deepEqual(DEBUG_BINDINGS,[
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
 ],'the names this client writes, pinned one by one');
 for(const key of DEBUG_BINDINGS)assert.equal(DISPLAY_DEFAULTS[key],'key.keyboard.unknown',key+' is unbound in the table');
 const dir=await tempDir('easter-display-debug-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  // A tree where the client wrote the vanilla F3 bindings: the seed unbinds each one in
  // place rather than adding a second line for it.
  const played=DEBUG_BINDINGS.map(key=>key+':key.keyboard.f3').join('\n')+'\n';
  await fs.writeFile(path.join(root,'options.txt'),played);
  await applyDisplayDefaults(root);
  const options=parseProperties(await optionsText(root));
  for(const key of DEBUG_BINDINGS)assert.equal(options.get(key),'key.keyboard.unknown','unbound in options.txt: '+key);
  assert.equal(shown(await optionsText(root)).filter(line=>line.startsWith('key_key.debug.')).length,22,'rewritten in place, not added again');
  // The record keeps them, so a repair restores the unbind rather than vanilla's F3.
  await fs.rm(path.join(root,'options.txt'));
  await applyDisplayDefaults(root);
  const repaired=parseProperties(await optionsText(root));
  for(const key of DEBUG_BINDINGS)assert.equal(repaired.get(key),'key.keyboard.unknown','still unbound after a repair: '+key);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('no two seeded actions share a key, before or after the mod’s binding arrives',async()=>{
 // The table itself, first: everything except the unbound debug keys is a distinct key.
 const bound=Object.entries(DISPLAY_DEFAULTS).filter(([key,value])=>key.startsWith('key_key.')&&value!=='key.keyboard.unknown');
 const values=bound.map(([,value])=>value);
 assert.equal(new Set(values).size,values.length,'no two seeded actions share a key: '+JSON.stringify(bound));
 assert.equal(bound.length,10,'nine household controls plus Shippy’s quick build');
 // Left Ctrl is crouch's alone and Right Ctrl is Shippy's alone: that is the point of
 // moving the hotkey rather than leaving two actions on one key.
 assert.deepEqual(bound.filter(([,value])=>value==='key.keyboard.left.control').map(([key])=>key),['key_key.sneak']);
 assert.deepEqual(bound.filter(([,value])=>value==='key.keyboard.right.control').map(([key])=>key),[DEFERRED_KEY]);
 const dir=await tempDir('easter-display-distinct-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await applyDisplayDefaults(root);
  assertDistinctBindings(await optionsText(root),'a fresh seed');
  // And with the deferred key present, on a tree where every key the table names is there.
  await fs.writeFile(path.join(root,'options.txt'),seededLines().concat([DEFERRED_VANILLA]).join('\n')+'\n');
  await applyDisplayDefaults(root);
  const withMod=await optionsText(root);
  assertDistinctBindings(withMod,'a seed after the mod registered its key');
  assert.match(withMod,new RegExp('^'+DEFERRED_KEY.replace(/\./g,'\\.')+':key\\.keyboard\\.right\\.control$','m'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a record from a schema this build does not know is left alone, never pulled back down',async()=>{
 const dir=await tempDir('easter-display-schema-future-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  assert.deepEqual(DISPLAY_SCHEMA_KEYS,{1:['guiScale','fullscreen'],2:['key_key.sneak','key_key.sprint','key_key.inventory','key_key.playerlist','key_key.togglePerspective'],3:['key_key.chat','key_key.toggleGui','key_key.socialInteractions','key_key.smoothCamera',...DEBUG_BINDINGS,DEFERRED_KEY]},'the documented schema history: what each version added, kept for a human reader');
  assert.deepEqual([...DISPLAY_SCHEMA_KEYS[1],...DISPLAY_SCHEMA_KEYS[2],...DISPLAY_SCHEMA_KEYS[3]].sort(),Object.keys(DISPLAY_DEFAULTS).sort(),'together they are the table, so the history cannot drift from it');
  // A newer record: its values are the covered set, and this build neither adds keys it
  // has never seeded into this tree nor lowers the record to its own schema.
  const future=JSON.stringify({schema:9,values:{guiScale:'2',fullscreen:'true',...SEVEN_KEYS},appliedAt:'2026-10-17T09:00:00.000Z'},null,2)+'\n';
  await fs.writeFile(path.join(root,DISPLAY_RECORD),future,{mode:0o600});
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(VANILLA_BINDS).join('\n')+'\n');
  const optionsBefore=await fs.readFile(path.join(root,'options.txt'));
  const result=await applyDisplayDefaults(root);
  assert.equal(result.written,false,'a newer schema has already had its say over every key this build knows');
  assert.equal(result.upgraded,false);
  assert.deepEqual(result.keys,[]);
  assert.deepEqual(await fs.readFile(path.join(root,'options.txt')),optionsBefore,'and the table is not extended into a tree a newer build owns');
  assert.equal(await recordText(root),future,'nor is the newer record downgraded');
  // A record with no schema at all is the oldest meaning, and coverage is still per key:
  // the display pair is covered, everything the table has grown since is not.
  await fs.writeFile(path.join(root,DISPLAY_RECORD),JSON.stringify({values:{guiScale:'2',fullscreen:'true'}})+'\n');
  const legacy=await applyDisplayDefaults(root);
  assert.equal(legacy.upgraded,true,'an unversioned record is raised to this schema');
  assert.deepEqual(legacy.keys,IMMEDIATE_BINDINGS,'and gets exactly the keys it never covered');
  assert.equal(JSON.parse(await recordText(root)).schema,3);
  assert.deepEqual(JSON.parse(await recordText(root)).values,{guiScale:'2',fullscreen:'true',...immediateBinds()});
  assertDistinctBindings(await optionsText(root),'an unversioned-record upgrade');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

// ---- the GUI scale follows the display it will open on ----------------------
// Owen's follow-up of 2026-10-17: a flat 2 is right on an ordinary display and too
// small on a high-resolution one. The table is the contract, so it is asserted one
// pixel either side of every cut as well as on the displays that decide the change.
test('the GUI scale rule follows the display, and keeps 2 on an ordinary one',()=>{
 assert.equal(displayGuiScale({widthPx:1366,heightPx:768}),2,'a small laptop keeps 2');
 assert.equal(displayGuiScale({widthPx:1600,heightPx:900}),2,'so does 1600x900');
 assert.equal(displayGuiScale({widthPx:1920,heightPx:1080}),2,'1080p keeps 2: it is what both household machines run');
 assert.equal(displayGuiScale({widthPx:1920,heightPx:1200}),2,'a 1200-tall display is still on the ordinary rung');
 assert.equal(displayGuiScale({widthPx:2560,heightPx:1440}),3,'1440p is one rung up');
 assert.equal(displayGuiScale({widthPx:3440,heightPx:1440}),3,'an ultrawide is judged by its height, like any other 1440p display');
 assert.equal(displayGuiScale({widthPx:3840,heightPx:2160}),4,'2160p is the top rung');
 assert.equal(displayGuiScale({widthPx:5120,heightPx:2880}),4,'and the table stops at 4: that is the launcher’s own ceiling, not a claim about the client');
 // One pixel either side of each cut, so the table is the rule and not an impression.
 assert.equal(displayGuiScale({widthPx:2560,heightPx:1349}),2);
 assert.equal(displayGuiScale({widthPx:2560,heightPx:1350}),3);
 assert.equal(displayGuiScale({widthPx:3840,heightPx:2159}),3);
 assert.equal(displayGuiScale({widthPx:3840,heightPx:2160}),4);
 assert.deepEqual(GUI_SCALE_LADDER.map(rung=>[rung.minHeightPx,rung.guiScale]),[[2160,4],[1350,3],[1,2]],'the documented table, in order');
 assert.equal(GUI_SCALE_DEFAULT,2,'the documented fallback');
 // A display that will not state its size is unknown, not small and not large.
 assert.equal(displayGuiScale({}),2);
 assert.equal(displayGuiScale(),2);
 assert.equal(displayGuiScale({widthPx:null,heightPx:null}),2);
 assert.equal(displayGuiScale({widthPx:3840,heightPx:null}),2,'a height the platform will not state is unknown, not 2160');
 assert.equal(displayGuiScale({widthPx:3840,heightPx:0}),2);
 assert.equal(displayGuiScale({widthPx:3840,heightPx:NaN}),2);
 assert.equal(displayGuiScale({widthPx:3840,heightPx:'tall'}),2);
 // A rung the display cannot show is not written: the client needs 320x240 per step.
 assert.equal(displayGuiScale({widthPx:1080,heightPx:2160}),3,'a tall narrow display is capped by what its width fits');
 assert.equal(displayGuiScale({widthPx:640,heightPx:480}),2,'a tiny display still gets the scale it can show');
 assert.equal(displayGuiScale({widthPx:320,heightPx:240}),1);
});

test('the GUI scale is read in physical pixels, not device-independent ones',()=>{
 assert.deepEqual(displayPhysicalPixels({size:{width:3840,height:2160},scaleFactor:1}),{widthPx:3840,heightPx:2160});
 assert.deepEqual(displayPhysicalPixels({size:{width:1920},scaleFactor:2}),{widthPx:3840,heightPx:null},'a size with no height leaves the height unknown rather than assuming one');
 assert.deepEqual(displayPhysicalPixels({size:{width:1920,height:1080},scaleFactor:2}),{widthPx:3840,heightPx:2160},'a 2160p screen at 200% scaling reports 1080p in device-independent pixels');
 assert.equal(displayGuiScale(displayPhysicalPixels({size:{width:1920,height:1080},scaleFactor:2})),4,'which is the whole point: the scaled display gets the rung its real pixels earn');
 assert.deepEqual(displayPhysicalPixels({size:{width:2560,height:1440},scaleFactor:1.25}),{widthPx:3200,heightPx:1800});
 assert.equal(displayGuiScale(displayPhysicalPixels({size:{width:2560,height:1440},scaleFactor:1.25})),3);
 assert.deepEqual(displayPhysicalPixels({size:{width:1280,height:1024}}),{widthPx:1280,heightPx:1024},'a display that reports no factor is read 1:1');
 assert.deepEqual(displayPhysicalPixels({size:{width:1280,height:1024},scaleFactor:0}),{widthPx:1280,heightPx:1024},'and so is one that reports a nonsense factor');
 assert.deepEqual(displayPhysicalPixels({}),{widthPx:null,heightPx:null});
 assert.deepEqual(displayPhysicalPixels(null),{widthPx:null,heightPx:null});
 assert.equal(displayGuiScale(displayPhysicalPixels(null)),2,'an unreadable display gets 2 rather than a guess');
});

test('the first seed writes the GUI scale its display asked for, and the record keeps that value',async()=>{
 const dir=await tempDir('easter-display-scale-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  const seeded=await applyDisplayDefaults(root,{guiScale:3});
  assert.equal(seeded.firstSeed,true);
  assert.deepEqual(shown(await optionsText(root)),seededLines('3'),'the display’s answer is what a fresh tree gets, with the same five bindings');
  const record=JSON.parse(await recordText(root));
  assert.deepEqual(record.values,{guiScale:'3',fullscreen:'true',...immediateBinds()},'the record stores the value that was applied, not the fallback, and covers exactly the keys it wrote');
  // A repair reuses the record, so the launcher moving to another screen cannot
  // re-decide a tree that has already been seeded.
  await fs.writeFile(path.join(root,'options.txt'),'renderDistance:12\n');
  const repaired=await applyDisplayDefaults(root,{guiScale:4});
  assert.equal(repaired.firstSeed,false);
  assert.deepEqual(shown(await optionsText(root)),['renderDistance:12',...seededLines('3')],'the recorded 3 comes back, not this display’s 4');
  // And a key the player moved themselves is still never rewritten.
  const playerChose='guiScale:1\nfullscreen:false\n'+bindLines(immediateBinds()).join('\n')+'\n';
  await fs.writeFile(path.join(root,'options.txt'),playerChose);
  const kept=await applyDisplayDefaults(root,{guiScale:4});
  assert.equal(kept.written,false);
  assert.equal(await optionsText(root),playerChose,'a player’s own scale outranks every rung');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('an unusable GUI scale is never invented into the client',async()=>{
 const dir=await tempDir('easter-display-scale-fallback-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  for(const value of [null,undefined,0,5,-1,3.5,'',NaN,'three',{}]){
   assert.equal(displayDefaultValues(value).guiScale,'2','an unusable value ('+String(value)+') falls back to the documented 2');
  }
  assert.equal(displayDefaultValues(3).guiScale,'3');
  assert.equal(displayDefaultValues('4').guiScale,'4','the rule’s answer may arrive as a number or a string');
  assert.equal(displayDefaultValues(4).fullscreen,'true','fullscreen does not depend on the scale at all');
  for(const [key,value] of Object.entries(WANTED_BINDS))assert.equal(displayDefaultValues(4)[key],value,'and neither do the bindings: '+key);
  const seeded=await applyDisplayDefaults(root,{guiScale:'nonsense'});
  assert.deepEqual(shown(await optionsText(root)),seededLines());
  assert.deepEqual(JSON.parse(await recordText(root)).values,{guiScale:'2',fullscreen:'true',...immediateBinds()});
  assertDistinctBindings(await optionsText(root),'the fallback seed');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
