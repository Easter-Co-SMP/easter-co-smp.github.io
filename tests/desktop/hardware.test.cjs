// Hardware detection and the client's own quality settings. Every case here is a
// fixture: the machine's reported GPU, a software renderer, integrated graphics and
// an adapter that will not say how much video memory it has. Nothing reaches the
// network, and nothing writes outside a temporary directory.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {hardwareProfile,graphicsRecommended,graphicsTunable,detectHardware,gpuAdapters,drmCards,sessionDisplay,targetAdapter,renderOffload,pciForDriPrime,parseNvidiaSmi,parseLspci,parseWindowsVideoControllers,parseSystemProfiler,matchAdapter,chooseDevice,reportedDevices,reportedAdapter,vendorOf,isSoftwareRenderer,isIntegrated,softwareFallback,hex16,videoMemoryMB,busId,qualitySettings,parseProperties,mergeProperties,applyQualitySettings,recordQuality,installedQuality,applyDisplayDefaults,displayGuiScale,displayPhysicalPixels,displayDefaultValues,GUI_SCALE_LADDER,GUI_SCALE_DEFAULT,DISPLAY_DEFAULTS,DISPLAY_RECORD,DISPLAY_RECORD_SCHEMA,DISPLAY_SCHEMA_KEYS,SHADER_PACK_NAME}=require('../../desktop/hardware.cjs');
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
// Owen asked for a first launch that is already fullscreen at GUI scale 2, and then for
// five key bindings set the way the household plays: sprint and crouch swapped from
// vanilla, inventory on tab, the player list on the grave key that frees, and third
// person on R. The seven keys live in options.txt, are seeded once per client tree, and
// are then never rewritten unless a recorded key has gone missing or an older record
// schema never covered it.
const SEEDED_BINDINGS=['key_key.sneak','key_key.sprint','key_key.inventory','key_key.playerlist','key_key.togglePerspective'];
// The values Owen verified in the real clients. Vanilla's are below them, and the two
// differ on purpose: this is the layout the seed exists to produce.
const WANTED_BINDS={
 'key_key.sneak':'key.keyboard.left.control',
 'key_key.sprint':'key.keyboard.left.shift',
 'key_key.inventory':'key.keyboard.tab',
 'key_key.playerlist':'key.keyboard.grave.accent',
 'key_key.togglePerspective':'key.keyboard.r'
};
const VANILLA_BINDS={
 'key_key.sneak':'key.keyboard.left.shift',
 'key_key.sprint':'key.keyboard.left.control',
 'key_key.inventory':'key.keyboard.e',
 'key_key.playerlist':'key.keyboard.tab',
 'key_key.togglePerspective':'key.keyboard.f5'
};
const bindLines=binds=>Object.entries(binds).map(([key,value])=>key+':'+value);
const seededLines=(guiScale='2')=>['guiScale:'+guiScale,'fullscreen:true',...bindLines(WANTED_BINDS)];
const shown=text=>text.split('\n').filter(Boolean);
const optionsText=root=>fs.readFile(path.join(root,'options.txt'),'utf8');
const recordText=root=>fs.readFile(path.join(root,DISPLAY_RECORD),'utf8');
// The seven seeded actions as options.txt ended up carrying them, read from the file.
const boundKeys=text=>{
 const options=parseProperties(text);
 return [...SEEDED_BINDINGS.map(key=>[key,options.get(key)??null])];
};
// No two actions may end up on one key: inventory takes tab, which vanilla gives the
// player list, so the seed has to move both or neither.
function assertDistinctBindings(text,label){
 const bound=boundKeys(text);
 assert.deepEqual(bound.filter(([,value])=>value===null),[],label+': every seeded action has a binding: '+JSON.stringify(bound));
 const values=bound.map(([,value])=>value);
 assert.equal(new Set(values).size,values.length,label+': no two seeded actions share a key: '+JSON.stringify(bound));
}

test('the display defaults are seeded once into the launcher’s client tree',async()=>{
 const dir=await tempDir('easter-display-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  assert.deepEqual(DISPLAY_DEFAULTS,{guiScale:'2',fullscreen:'true',...WANTED_BINDS},'the values are Owen’s, exactly');
  assert.equal(DISPLAY_RECORD,'.easter-client-display');
  assert.equal(DISPLAY_RECORD_SCHEMA,2,'the record covers the key bindings, not only the display pair');
  const seeded=await applyDisplayDefaults(root);
  assert.equal(seeded.written,true);
  assert.equal(seeded.firstSeed,true,'the first seed records itself');
  assert.equal(seeded.upgraded,false,'a fresh tree is not an upgrade of anything');
  assert.deepEqual(seeded.keys,[...new Set(seededLines().map(line=>line.split(':')[0]))],'all seven keys in one seed');
  // Read the file itself, not the intent.
  const options=await optionsText(root);
  assert.deepEqual(shown(options),seededLines());
  assert.equal(options.includes('\r'),false,'LF line endings');
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mode&0o777,0o600,'the same mode the quality writer uses');
  assertDistinctBindings(options,'the first seed');
  const record=JSON.parse(await recordText(root));
  assert.equal(record.schema,DISPLAY_RECORD_SCHEMA);
  assert.deepEqual(record.values,{guiScale:'2',fullscreen:'true',...WANTED_BINDS});
  assert.equal(typeof record.appliedAt,'string');
  assert.match(record.appliedAt,/^\d{4}-\d\d-\d\dT/);
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mode&0o777,0o600);
  // The install pipeline owns installed.json; a settings write never creates it.
  assert.equal(await fs.stat(path.join(root,'installed.json')).then(()=>'present',()=>'absent'),'absent');
  assert.equal(await fs.stat(path.join(root,'config','iris.properties')).then(()=>'present',()=>'absent'),'absent','display defaults are not the graphics step');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the seeded bindings are the household layout, not vanilla’s',async()=>{
 // The swap is the feature, so it is asserted against the literals read off the real
 // clients rather than against the constants that produce them.
 assert.equal(DISPLAY_DEFAULTS['key_key.sneak'],'key.keyboard.left.control');
 assert.equal(DISPLAY_DEFAULTS['key_key.sprint'],'key.keyboard.left.shift');
 assert.equal(WANTED_BINDS['key_key.sneak'],VANILLA_BINDS['key_key.sprint'],'crouch takes sprint’s vanilla key');
 assert.equal(WANTED_BINDS['key_key.sprint'],VANILLA_BINDS['key_key.sneak'],'and sprint takes crouch’s');
 assert.equal(WANTED_BINDS['key_key.inventory'],'key.keyboard.tab','inventory takes the player list’s vanilla key');
 assert.equal(VANILLA_BINDS['key_key.playerlist'],'key.keyboard.tab','which is exactly why the player list has to move with it');
 assert.equal(WANTED_BINDS['key_key.playerlist'],'key.keyboard.grave.accent');
 assert.equal(WANTED_BINDS['key_key.togglePerspective'],'key.keyboard.r','third person moves off vanilla’s F5');
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
  assertDistinctBindings(await optionsText(root),'the swap');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the seed writes Owen’s seven keys and none of the settings he did not ask for',async()=>{
 // Owen's own client carries settings he did not ask the launcher to seed (chat on enter,
 // toggleGui on F10, socialInteractions on I, smoothCamera on right shift, unbound debug
 // keys). A tree that already has them keeps them, and a fresh tree never gets them.
 const dir=await tempDir('easter-display-unrequested-');
 try{
  const hisExtras=[
   'key_key.chat:key.keyboard.enter',
   'key_key.toggleGui:key.keyboard.f10',
   'key_key.socialInteractions:key.keyboard.i',
   'key_key.smoothCamera:key.keyboard.right.shift',
   'key_key.debugOverlay:key.keyboard.',
   'key_key.swapOffhand:key.keyboard.f'
  ];
  const SEVEN=['fullscreen','guiScale','key_key.inventory','key_key.playerlist','key_key.sneak','key_key.sprint','key_key.togglePerspective'];
  assert.deepEqual(Object.keys(DISPLAY_DEFAULTS).sort(),SEVEN,'exactly the seven keys Owen asked for, nothing else');
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await fs.writeFile(path.join(root,'options.txt'),hisExtras.join('\n')+'\n');
  await applyDisplayDefaults(root);
  const after=await optionsText(root);
  for(const line of hisExtras)assert(shown(after).includes(line),'kept exactly as the player had it: '+line);
  // A fresh tree gets the seven seeded keys and none of his extras.
  const fresh=path.join(dir,'fresh');
  await fs.mkdir(fresh,{recursive:true});
  await fs.writeFile(path.join(fresh,'.easter-client'),'');
  await applyDisplayDefaults(fresh);
  assert.deepEqual([...parseProperties(await optionsText(fresh)).keys()].sort(),SEVEN,'the seed invents nothing beyond the seven');
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
  assert.deepEqual(shown(await optionsText(root)),['fullscreen:true','guiScale:2','fov:0.5','renderDistance:12',...bindLines(WANTED_BINDS)],'the seven defaults win on the first seed and every other line is kept');
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
  const playerChose='fullscreen:false\nguiScale:2\nfov:0.75\n'+bindLines(WANTED_BINDS).join('\n')+'\n';
  await fs.writeFile(path.join(root,'options.txt'),playerChose);
  const playerStat=await fs.stat(path.join(root,'options.txt'));
  const third=await applyDisplayDefaults(root);
  assert.equal(third.written,false,'a present key is the player’s own from now on');
  assert.equal(await optionsText(root),playerChose,'the launcher never re-decides a player’s choice');
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,playerStat.mtimeMs);
  // The player rebinds, in the game's own controls screen, sprint back to Ctrl and the
  // player list onto a key of their choosing. Both are theirs now.
  const reboundText=playerChose.replace('key_key.sprint:key.keyboard.left.shift','key_key.sprint:key.keyboard.left.control').replace('key_key.playerlist:key.keyboard.grave.accent','key_key.playerlist:key.keyboard.p');
  await fs.writeFile(path.join(root,'options.txt'),reboundText);
  const reboundStat=await fs.stat(path.join(root,'options.txt'));
  const rebound=await applyDisplayDefaults(root);
  assert.equal(rebound.written,false);
  assert.equal(await optionsText(root),reboundText,'a rebound key survives every later run');
  assert.equal((await fs.stat(path.join(root,'options.txt'))).mtimeMs,reboundStat.mtimeMs);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the only later seed is repair: a recorded key that went missing is written again, bindings included',async()=>{
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
  assert.deepEqual(single.keys,['guiScale','key_key.sneak','key_key.sprint','key_key.inventory','key_key.playerlist','key_key.togglePerspective']);
  assert.equal(await optionsText(root),'fullscreen:false\n'+seededLines().slice(0,1).join('\n')+'\n'+bindLines(WANTED_BINDS).join('\n')+'\n','the present key is untouched');
  // A binding that goes missing is repaired from the record exactly like a display key,
  // and a binding the player rebound meanwhile is left where they put it.
  await fs.writeFile(path.join(root,'options.txt'),'fullscreen:false\nguiScale:2\nkey_key.sneak:key.keyboard.left.control\n');
  const missingBind=await applyDisplayDefaults(root);
  assert.deepEqual(missingBind.keys,['key_key.sprint','key_key.inventory','key_key.playerlist','key_key.togglePerspective']);
  assert.match(await optionsText(root),/^key_key\.playerlist:key\.keyboard\.grave\.accent$/m,'the recorded binding came back');
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(WANTED_BINDS).join('\n').replace('key_key.togglePerspective:key.keyboard.r','key_key.togglePerspective:key.keyboard.f5')+'\n');
  const reboundRepair=await applyDisplayDefaults(root);
  assert.equal(reboundRepair.written,false,'a player’s own third-person key is not "missing", so nothing is repaired over it');
  // options.txt deleted entirely, as a fresh profile or a botched reset would: every
  // recorded key comes back, from the record.
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
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(WANTED_BINDS).filter(line=>!line.startsWith('key_key.inventory:')).join('\n').replace('key_key.playerlist:key.keyboard.grave.accent','key_key.playerlist:key.keyboard.p')+'\n');
  const inventoryOnly=await applyDisplayDefaults(root);
  assert.deepEqual(inventoryOnly.keys,['key_key.inventory'],'only the missing member of the group is written');
  assert.match(await optionsText(root),/^key_key\.playerlist:key\.keyboard\.p$/m,'the player’s own player list key is not overwritten');
  assertDistinctBindings(await optionsText(root),'a group repair against a player-chosen sibling');
  // The player list line goes missing and its present value is tab, which is the key the
  // seed takes for inventory: both members are written together.
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(WANTED_BINDS).join('\n').replace('key_key.playerlist:key.keyboard.grave.accent','key_key.playerlist:key.keyboard.tab')+'\n');
  const together=await applyDisplayDefaults(root);
  assert.deepEqual(together.written,false,'both members are present and nothing is missing, so no repair runs');
  // Now the collision that matters: inventory is missing, and the player list still sits
  // on tab, the key inventory is about to take.
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\nkey_key.sneak:key.keyboard.left.control\nkey_key.sprint:key.keyboard.left.shift\nkey_key.playerlist:key.keyboard.tab\nkey_key.togglePerspective:key.keyboard.r\n');
  const paired=await applyDisplayDefaults(root);
  assert.deepEqual(paired.keys,['key_key.inventory','key_key.playerlist'],'inventory and the player list move together');
  const pairedOptions=await optionsText(root);
  assert.match(pairedOptions,/^key_key\.inventory:key\.keyboard\.tab$/m);
  assert.match(pairedOptions,/^key_key\.playerlist:key\.keyboard\.grave\.accent$/m,'the player list was moved off the key inventory takes');
  assertDistinctBindings(pairedOptions,'a group repair that had to break a collision');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

// The bindings were added after the display pair had already shipped, so a tree the
// (unreleased) earlier build had seeded carries a schema-1 record. That record only ever
// promised the display pair, so the upgrade writes exactly the five bindings once and
// leaves the display values, player-changed or not, where they are.
test('a schema-1 record gets exactly the five bindings added once, and its display values left alone',async()=>{
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
  assert.deepEqual(upgraded.keys,SEEDED_BINDINGS,'only the keys schema 1 never covered are written');
  const expected=before.replace('key_key.sneak:key.keyboard.left.shift','key_key.sneak:key.keyboard.left.control').replace('key_key.sprint:key.keyboard.left.control','key_key.sprint:key.keyboard.left.shift').replace('key_key.inventory:key.keyboard.e','key_key.inventory:key.keyboard.tab').replace('key_key.playerlist:key.keyboard.tab','key_key.playerlist:key.keyboard.grave.accent').replace('key_key.togglePerspective:key.keyboard.f5','key_key.togglePerspective:key.keyboard.r');
  assert.equal(await optionsText(root),expected,'exactly the five bindings moved, in place, and every other line is byte for byte where it was');
  assertDistinctBindings(await optionsText(root),'a schema-1 upgrade');
  const record=JSON.parse(await recordText(root));
  assert.equal(record.schema,2);
  assert.deepEqual(record.values,{guiScale:'2',fullscreen:'true',...WANTED_BINDS},'the values it already carried are kept, and the ones applied now are added');
  assert.equal(record.appliedAt,appliedAt,'the original seed time is still the seed time');
  assert.match(String(record.upgradedAt),/^\d{4}-\d\d-\d\dT/);
  assert.equal((await fs.stat(path.join(root,DISPLAY_RECORD))).mode&0o777,0o600);
  // Once only: the next run finds a schema-2 record and touches neither file.
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

test('a schema-1 tree whose display values the player changed keeps those values through the upgrade',async()=>{
 const dir=await tempDir('easter-display-schema1-changed-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  await fs.writeFile(path.join(root,DISPLAY_RECORD),JSON.stringify({schema:1,values:{guiScale:'2',fullscreen:'true'},appliedAt:'2026-10-17T09:00:00.000Z'},null,2)+'\n',{mode:0o600});
  // The player moved the scale, plays windowed, and has not touched the bindings.
  const before='fullscreen:false\nguiScale:1\n'+bindLines(VANILLA_BINDS).join('\n')+'\n';
  await fs.writeFile(path.join(root,'options.txt'),before);
  const upgraded=await applyDisplayDefaults(root,{guiScale:4});
  assert.deepEqual(upgraded.keys,SEEDED_BINDINGS,'the display pair is not re-applied, however far the player moved it');
  assert.equal(await optionsText(root),'fullscreen:false\nguiScale:1\n'+bindLines(WANTED_BINDS).join('\n')+'\n');
  assertDistinctBindings(await optionsText(root),'a schema-1 upgrade over player-chosen display values');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a record from a schema this build does not know is left alone, never pulled back down',async()=>{
 const dir=await tempDir('easter-display-schema-future-');
 try{
  const root=path.join(dir,'minecraft');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.easter-client'),'');
  assert.deepEqual(DISPLAY_SCHEMA_KEYS,{1:['guiScale','fullscreen'],2:SEEDED_BINDINGS},'the documented schema table: what each version took responsibility for');
  const future=JSON.stringify({schema:9,values:{guiScale:'2',fullscreen:'true',...WANTED_BINDS},appliedAt:'2026-10-17T09:00:00.000Z'},null,2)+'\n';
  await fs.writeFile(path.join(root,DISPLAY_RECORD),future,{mode:0o600});
  await fs.writeFile(path.join(root,'options.txt'),'guiScale:2\nfullscreen:true\n'+bindLines(VANILLA_BINDS).join('\n')+'\n');
  const result=await applyDisplayDefaults(root);
  assert.equal(result.written,false,'a newer schema has already had its say over every key this build knows');
  assert.deepEqual(result.keys,[]);
  assert.equal(await recordText(root),future,'and the newer record is not downgraded');
  // A record with no schema at all is the oldest meaning: the display pair only.
  await fs.writeFile(path.join(root,DISPLAY_RECORD),JSON.stringify({values:{guiScale:'2',fullscreen:'true'}})+'\n');
  const legacy=await applyDisplayDefaults(root);
  assert.deepEqual(legacy.keys,SEEDED_BINDINGS,'an unversioned record is treated as schema 1');
  assert.equal(JSON.parse(await recordText(root)).schema,2,'and is brought up to the current schema');
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
  assert.deepEqual(record.values,{guiScale:'3',fullscreen:'true',...WANTED_BINDS},'the record stores the value that was applied, not the fallback');
  // A repair reuses the record, so the launcher moving to another screen cannot
  // re-decide a tree that has already been seeded.
  await fs.writeFile(path.join(root,'options.txt'),'renderDistance:12\n');
  const repaired=await applyDisplayDefaults(root,{guiScale:4});
  assert.equal(repaired.firstSeed,false);
  assert.deepEqual(shown(await optionsText(root)),['renderDistance:12',...seededLines('3')],'the recorded 3 comes back, not this display’s 4');
  // And a key the player moved themselves is still never rewritten.
  const playerChose='guiScale:1\nfullscreen:false\n'+bindLines(WANTED_BINDS).join('\n')+'\n';
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
  assert.deepEqual(JSON.parse(await recordText(root)).values,{guiScale:'2',fullscreen:'true',...WANTED_BINDS});
  assertDistinctBindings(await optionsText(root),'the fallback seed');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
