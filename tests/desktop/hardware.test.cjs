// Hardware detection and the client's own quality settings. Every case here is a
// fixture: the machine's reported GPU, a software renderer, integrated graphics and
// an adapter that will not say how much video memory it has. Nothing reaches the
// network, and nothing writes outside a temporary directory.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {hardwareProfile,graphicsRecommended,graphicsTunable,detectHardware,gpuAdapters,parseNvidiaSmi,parseLspci,parseWindowsVideoControllers,parseSystemProfiler,matchAdapter,chooseDevice,reportedDevices,reportedAdapter,vendorOf,isSoftwareRenderer,isIntegrated,softwareFallback,hex16,videoMemoryMB,busId,qualitySettings,parseProperties,mergeProperties,applyQualitySettings,recordQuality,installedQuality,SHADER_PACK_NAME}=require('../../desktop/hardware.cjs');
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

test('a machine with two adapters says so instead of passing one off as the only card',()=>{
 const adapters=parseLspci(EASTER_SERVER_LSPCI).map((adapter,index)=>({...adapter,vramMB:parseNvidiaSmi(EASTER_SERVER_NVIDIA_SMI)[index].vramMB}));
 const forActive=deviceId=>hardwareProfile({devices:[{active:true,deviceId,vendorId:4318},{active:false,deviceId:deviceId===10370?9351:10370,vendorId:4318}],adapters,featureStatus:HARDWARE_STATUS});
 const six=forActive(10370),five=forActive(9351);
 assert.match(six.gpu,/RTX 4060/,'the active 0x2882 is described as the 4060');
 assert.equal(six.vramMB,8188);
 assert.match(five.gpu,/RTX 3060/,'and when the other one is marked active, that one is described');
 assert.equal(six.tier,'capable');
 assert.equal(five.tier,'capable');
 assert.equal(six.adapters,2);
 assert.match(six.reason,/2 graphics adapters/,'the player is told there is more than one adapter');
 assert.equal(six.reason.split('. ').length,1,'still one sentence');
 // A machine with one adapter says nothing about others.
 const single=hardwareProfile({devices:[],adapters:[{name:'NVIDIA GeForce RTX 4060',vramMB:8188}]});
 assert.equal(single.adapters,1);
 assert.doesNotMatch(single.reason,/adapters/);
 assert.equal(hardwareProfile({devices:[],adapters:[{name:'NVIDIA GeForce RTX 4060',vramMB:8188},{name:'NVIDIA GeForce RTX 4060',vramMB:8188}]}).adapters,1,'the same adapter listed twice is one adapter');
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
 assert.deepEqual(at(8192),{renderDistance:16,shadowDistance:12,graphicsMode:'fancy',shaders:true,shaderPack:'ComplementaryUnbound_r5.9.3.zip'});
 assert.deepEqual(at(24576),at(8192),'beyond the top rung the settings do not keep growing');
 // This machine's own figure.
 assert.deepEqual(at(8188).renderDistance,14);
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
  assert.deepEqual(written.tuned,{renderDistance:14,shadowDistance:10,shaders:true});
  const options=await fs.readFile(path.join(root,'options.txt'),'utf8');
  assert.match(options,/^graphicsMode:fancy$/m);
  assert.match(options,/^renderDistance:14$/m);
  assert.match(options,/^fov:0\.5$/m,'an unrelated setting is left alone');
  const iris=await fs.readFile(path.join(root,'config','iris.properties'),'utf8');
  assert.match(iris,/^enableShaders:true$/m);
  assert.match(iris,/^shaderPack:ComplementaryUnbound_r5\.9\.3\.zip$/m);
  assert.match(iris,/^shadowDistance:10$/m);
  // The marker records what was written, and reading it back reports the same.
  await fs.writeFile(path.join(root,'installed.json'),JSON.stringify({version:'fabric-1',files:[]}));
  assert.equal(await recordQuality(root,quality),true);
  assert.deepEqual(await installedQuality(root),{renderDistance:14,shadowDistance:10,shaders:true});
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
