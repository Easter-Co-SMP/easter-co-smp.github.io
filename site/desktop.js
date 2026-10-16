// The same pages run unchanged in a browser. Native capabilities only come from
// the isolated Electron preload, never a URL parameter or a saved preference.
//
// Everything below renders from the launcher state contract in doc/launcher-states.md.
// No view computes its own version of the gate: `canPlay` is the single source of
// truth for Play, so Play can never appear because an install finished alone.
(()=>{
 const desktop=window.easterDesktop;
 if(!desktop||desktop.mode!=='desktop')return;
 document.documentElement.classList.add('desktop-mode');
 // The skip control is a website affordance. Desktop mode removes it from the DOM entirely,
 // so it never reaches assistive technology; Escape and the bounded timer still end the arrival.
 document.querySelector('.skip-arrival')?.remove();

 const TRANSFER=['downloading','paused','verifying','installing','updating'];
 const LOGIN_ACTION='Sign in with Microsoft';
 let current=null,settings,totalMemoryMB=0,heroButton=null,signInPending=false;

 // A launcher build older than the download half exposes no install, pause, resume,
 // choose-location or update handler. Looking them up defensively hides those controls
 // instead of throwing at the player.
 const bridge=(...names)=>{for(const name of names)if(typeof desktop[name]==='function')return desktop[name].bind(desktop);};
 const chooseLocation=bridge('chooseInstallLocation','chooseLocation');
 const startInstall=bridge('startInstall','startDownload');
 const pauseTransfer=bridge('pauseInstall','pause');
 const resumeTransfer=bridge('resumeInstall','resume');
 const playAction=bridge('play','launch');

 const phaseOf=state=>state&&typeof state.phase==='string'?state.phase:'';
 const installOf=state=>state&&state.install&&typeof state.install==='object'?state.install:{};
 const progressOf=state=>state&&state.progress&&typeof state.progress==='object'?state.progress:null;
 const actionsOf=state=>state&&Array.isArray(state.actions)?state.actions:[];
 // A transfer is under way for the states the contract names as download or install work.
 const transferring=state=>['downloading','paused','verifying','installing','updating'].includes(phaseOf(state));
 // Visible once a download or install has started; a stale `bar` field must not hide it
 // while a transfer is running.
 const barVisible=state=>Boolean(state.bar&&state.bar.visible)||transferring(state);

 // The hero's primary action and the dialog's primary button both read this one function,
 // so no second view can invent its own version of the gate.
 function primaryAction(state){
  const phase=phaseOf(state),account=current?.profile?.name,install=installOf(state),actions=actionsOf(state);
  if(signInPending)return {kind:'busy',label:'Connecting your account…',note:'Complete Microsoft sign-in'};
  if(state&&state.canPlay&&phase!=='launching'&&phase!=='running')return {kind:'play',label:'PLAY NOW',note:'Set sail'};
  if(phase==='launching')return {kind:'busy',label:'Launching Minecraft…',note:'Hold fast'};
  if(phase==='running')return {kind:'running',label:'Minecraft is running',note:'The map stays open alongside'};
  // A download or install under way asks for the account while the player waits.
  if(!account&&(transferring(state)||(!actions.includes('download')&&actions.includes('signin'))))return {kind:'signin',label:LOGIN_ACTION,note:'Your crew is waiting'};
  if(account&&transferring(state))return {kind:'busy',label:phase==='paused'?'Download paused':'Preparing your client…',note:'Follow progress below'};
  // Fresh install: nothing downloaded and no account requirement to show yet.
  if(actions.includes('download')||!(account&&install.installed===true))
   return {kind:'download',label:'Download the game',note:'Easter Company client'};
  return {kind:'signin',label:LOGIN_ACTION,note:'Your crew is waiting'};
 }

 const panel=document.createElement('dialog');panel.id='desktop-launcher';panel.setAttribute('aria-labelledby','desktop-title');
 panel.innerHTML='<button class="dialog-close" type="button" aria-label="Close launcher">×</button><p class="eyebrow">Easter Company · Desktop</p><h2 id="desktop-title">Your next voyage.</h2><p class="desktop-account"></p><p class="desktop-company" hidden></p><button type="button" class="text-link" data-account-refresh hidden>Refresh account</button><button type="button" class="text-link" data-account-sign-out hidden>Sign out of Easter Company</button><section class="desktop-install" hidden><p class="desktop-install-note"></p><label>Installation folder<input name="installLocation" autocomplete="off" spellcheck="false"><small class="desktop-install-default"></small></label><button type="button" class="text-link" data-choose-location hidden>Choose folder…</button><p class="desktop-install-error" role="alert" hidden></p><label class="desktop-toggle"><input type="checkbox" name="includeGraphics" checked> Include enhanced graphics + shaders</label><button type="button" class="launcher-button desktop-install-start">Start download</button></section><div class="desktop-status" role="status" aria-live="polite"></div><progress class="desktop-progress" max="100" hidden></progress><section class="desktop-device" hidden><p>Sign in securely with Microsoft</p><strong class="desktop-code"></strong><button type="button" class="text-link" data-open-microsoft>Open Microsoft sign-in ↗</button><small class="desktop-provider"></small><button type="button" class="text-link" data-cancel>Cancel sign-in</button></section><button class="desktop-play launcher-button" type="button">Sign in &amp; Play</button><details class="desktop-settings"><summary>Client settings</summary><form><label>Memory <output id="memory-value"></output><input type="range" name="memoryMB" min="2048" max="16384" step="512"></label><label>Server address<input name="server" autocomplete="off" spellcheck="false" placeholder="Hostname or IP:port"></label><label>Java executable <small>Leave empty to install the matching runtime automatically.</small><span class="java-field"><input name="javaPath" autocomplete="off" spellcheck="false" placeholder="Automatic Java 25"><button type="button" data-choose-java>Browse</button></span></label><button type="submit" class="text-link">Save settings</button><output class="desktop-settings-result" role="status"></output></form></details><div class="desktop-utilities"><button class="text-link" type="button" data-open-folder>Open client folder ↗</button><button class="text-link" type="button" data-sign-out>Sign out</button><small class="desktop-version"></small></div>';
 document.body.append(panel);
 const $=selector=>panel.querySelector(selector);
 const message=$('.desktop-status'),progress=$('.desktop-progress'),playButton=$('.desktop-play');
 const installSection=$('.desktop-install'),locationField=$('input[name=installLocation]'),graphicsField=$('input[name=includeGraphics]');
 const installError=$('.desktop-install-error');
 let installTouched=false,installRequested=false;
 $('.dialog-close').onclick=()=>panel.close();
 panel.addEventListener('click',event=>{const r=panel.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)panel.close();});
 const open=()=>{if(!panel.open)panel.showModal();};
 const report=error=>{message.textContent=error&&error.message?error.message:String(error);};

 // ---- Sticky bottom bar -----------------------------------------------------
 // The minimised state is a renderer-local preference by contract, so it is kept here
 // and re-applied on every page of the launcher.
 const BAR_KEY='easter-co-launcher-bar';
 const readMinimised=()=>{try{return localStorage.getItem(BAR_KEY)==='minimised';}catch{return false;}};
 const writeMinimised=value=>{try{localStorage.setItem(BAR_KEY,value?'minimised':'open');}catch{}};
 let minimised=readMinimised();
 const bar=document.createElement('div');
 bar.id='launcher-bar';bar.className='launcher-bar';bar.hidden=true;
 bar.setAttribute('role','region');bar.setAttribute('aria-label','Client download');
 // One control does both jobs: it reads as the bar's own switch while the bar is open and
 // becomes the whole side tab once minimised, so there is always something to press with
 // a mouse or a keyboard.
 bar.innerHTML='<button type="button" class="launcher-bar-tab" data-bar-toggle aria-pressed="false"><span class="launcher-bar-tab-icon" aria-hidden="true">▾</span><span class="launcher-bar-tab-text" data-bar-tab-text></span></button><div class="launcher-bar-body" id="launcher-bar-body"><div class="launcher-bar-info"><p class="launcher-bar-label"></p><p class="launcher-bar-meta"></p></div><div class="launcher-bar-track" role="progressbar" aria-label="Download progress"><i data-bar-fill></i></div><div class="launcher-bar-actions"><button type="button" class="launcher-bar-button" data-bar-primary hidden></button><button type="button" class="launcher-bar-button" data-bar-pause hidden>Pause</button><button type="button" class="launcher-bar-button" data-bar-resume hidden>Resume</button></div></div>';
 document.body.append(bar);
 const barToggle=bar.querySelector('[data-bar-toggle]'),barBody=bar.querySelector('.launcher-bar-body'),barFill=bar.querySelector('[data-bar-fill]');
 const barTrack=bar.querySelector('.launcher-bar-track'),barLabel=bar.querySelector('.launcher-bar-label'),barMeta=bar.querySelector('.launcher-bar-meta');
 const barTabText=bar.querySelector('[data-bar-tab-text]');
 const barPrimary=bar.querySelector('[data-bar-primary]');
 const pauseButton=bar.querySelector('[data-bar-pause]'),resumeButton=bar.querySelector('[data-bar-resume]');

 // Sit above whatever the page already docks at the bottom (the map's footer and status
 // line), so the bar never covers the chart's own controls.
 function measureDock(){
  let blocking=0;
  for(const selector of ['.map-bottom','.map-status','.map-location']){
   for(const node of document.querySelectorAll(selector)){
    const style=getComputedStyle(node);
    // The chart's footer is absolutely placed inside a full-height stage rather than fixed,
    // so both count as docked; only something in normal flow is ignored.
    if(!['fixed','absolute'].includes(style.position)||style.display==='none'||style.visibility==='hidden')continue;
    const rect=node.getBoundingClientRect();
    // A docked element that is not laid out yet, or is scrolled away, must not count as
    // clear space; the observer below re-measures once the chart has laid its footer out.
    if(rect.height<=0||rect.width<24||rect.bottom<=innerHeight*0.5)continue;
    blocking=Math.max(blocking,innerHeight-rect.top);
   }
  }
  return blocking;
 }
 function offsetBar(){
  const offset=Math.round(Math.min(measureDock()+12,Math.max(12,innerHeight/3)));
  document.documentElement.style.setProperty('--launcher-bar-offset',offset+'px');
 }
 // The chart's footer only gains its height once the world is drawn, so the bar's offset is
 // re-measured as the page's own docked elements settle rather than sampled once.
 if(typeof ResizeObserver==='function'){
  const dockObserver=new ResizeObserver(()=>{if(current)renderBar(current);});
  for(const node of document.querySelectorAll('.map-bottom,.map-status,.map-location'))dockObserver.observe(node);
 }

 const formatBytes=value=>typeof value!=='number'||!Number.isFinite(value)?null:value>=1073741824?(value/1073741824).toFixed(value>=10737418240?0:1)+' GB':value>=1048576?(value/1048576).toFixed(value>=104857600?0:1)+' MB':value>=1024?(value/1024).toFixed(value>=102400?0:1)+' KB':Math.round(value)+' B';
 const formatSpeed=value=>{const size=formatBytes(value);return size===null?null:size+'/s';};
 const formatEta=value=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)return null;
  const seconds=Math.round(value);
  if(seconds<60)return seconds+'s left';
  if(seconds<3600)return Math.ceil(seconds/60)+' min left';
  return Math.floor(seconds/3600)+'h '+Math.round(seconds%3600/60)+'m left';};
 // Absent rather than zero: a field the task cannot report is simply not shown.
 const joinParts=parts=>parts.filter(part=>part!==null&&part!==undefined&&part!=='').join(' · ');

 function renderBar(state){
  if(!barVisible(state)){bar.hidden=true;return;}
  offsetBar();bar.hidden=false;
  const progressState=progressOf(state),percent=progressState&&typeof progressState.percent==='number'?progressState.percent:null;
  const active=TRANSFER.includes(phaseOf(state)),label=progressState&&typeof progressState.label==='string'&&progressState.label?progressState.label:(active?phaseOf(state).replace(/^./,letter=>letter.toUpperCase()):'Easter Company client');
  bar.classList.toggle('is-minimised',minimised);
  barToggle.setAttribute('aria-pressed',String(minimised));
  barToggle.setAttribute('aria-label',minimised?'Show download progress':active?'Minimise download progress':'Minimise download');
  barBody.inert=minimised;
  if(minimised)barBody.setAttribute('aria-hidden','true');else barBody.removeAttribute('aria-hidden');
  // Minimised: percentages only while a download or install is active, otherwise the play
  // or sign-in action the state dictates.
  const action=primaryAction(state);
  const percentText=percent===null?'':Math.round(percent)+'%';
  if(minimised&&!active)barTabText.textContent=action.kind==='play'?'PLAY NOW':action.kind==='signin'?LOGIN_ACTION:action.label;
  else barTabText.textContent=percentText||'…';
  barLabel.textContent=active?label:state.canPlay?'Ready to set sail':installOf(state).installed?'Your client is ready':label;
  barPrimary.hidden=active||!['play','signin','download'].includes(action.kind);
  barPrimary.textContent=action.label;
  const bytes=progressState&&typeof progressState.bytesDone==='number'&&typeof progressState.bytesTotal==='number'?formatBytes(progressState.bytesDone)+' of '+formatBytes(progressState.bytesTotal):null;
  const speed=progressState&&typeof progressState.bytesPerSecond==='number'?formatSpeed(progressState.bytesPerSecond):null;
  barMeta.textContent=joinParts([percent===null?null:Math.round(percent)+'%',bytes,speed,formatEta(progressState?.etaSeconds)]);
  barMeta.hidden=barMeta.textContent==='';
  // Nothing is transferring: the bar carries the state's action and no progress at all,
  // rather than an idle bar sitting at zero.
  barTrack.hidden=!progressState;
  bar.classList.toggle('is-indeterminate',Boolean(progressState)&&percent===null);
  barFill.style.width=percent===null?'':Math.max(0,Math.min(100,percent))+'%';
  // Indeterminate progress is shown as activity without a number, never an invented 0%.
  if(!progressState||percent===null){barTrack.removeAttribute('aria-valuenow');barTrack.setAttribute('aria-valuetext',progressState?'Working, progress unknown':'');}
  else{barTrack.setAttribute('aria-valuenow',String(Math.round(percent)));barTrack.setAttribute('aria-valuetext',Math.round(percent)+' percent');}
  // Pause and resume appear only while a transfer can actually continue either way. The
  // sign-in entry point belongs to the hero and the dialog, so the bar keeps its own space
  // for those two controls.
  const phase=phaseOf(state),offerPause=phase==='downloading'&&typeof pauseTransfer==='function';
  const offerResume=phase==='paused'&&typeof resumeTransfer==='function';
  pauseButton.hidden=!offerPause;resumeButton.hidden=!offerResume;
 }

 // ---- State rendering -------------------------------------------------------
 function render(state){
  current={...current,...state};
  if(installRequested&&transferring(current)){installRequested=false;if(panel.open)panel.close();}
  const busy=['signing-in','refreshing','launching','running'].includes(phaseOf(current));
  const account=current.profile?.name,action=primaryAction(current),install=installOf(current),phase=phaseOf(current);
  message.textContent=current.message||'Your crew is waiting.';
  playButton.disabled=busy||action.kind==='busy';
  // The first-run section carries its own Start download action, so the dialog's primary
  // button would be a second way to do the same thing.
  playButton.hidden=action.kind==='running'||action.kind==='download';
  playButton.textContent=action.kind==='play'?'PLAY NOW':action.kind==='signin'?LOGIN_ACTION:action.kind==='busy'?'Launching Minecraft…':action.kind==='running'?'Minecraft is running':'Install the client';
  $('.desktop-account').textContent=account?'Signed in as '+account+(current.remembered?' · Remembered on this device':' · This session only'):'Connect your Microsoft account to set sail.';
  // Easter Company account state. Only a name and roles ever arrive from IPC.
  const company=current.account;
  $('.desktop-company').hidden=!account;
  $('.desktop-company').textContent=company?'Easter Company account: '+company.name+(company.roles.length?' · '+company.roles.join(', '):''):'No Easter Company account on this device yet.';
  $('[data-account-refresh]').hidden=!account;$('[data-account-refresh]').disabled=busy;
  // The session token never comes near the UI; only whether one is held and when
  // it lapses, so a player can see that signing in again is enough.
  const live=Boolean(company)&&current.sessionExpiresAt>Date.now();
  $('[data-account-sign-out]').hidden=!live||busy;
  settingsButton.textContent=account||'My client';
  $('.desktop-settings form').inert=busy;
  $('[data-sign-out]').hidden=!account;$('[data-sign-out]').disabled=busy&&phase!=='running';
  const device=current.device;$('.desktop-device').hidden=!device;
  if(device){$('.desktop-code').textContent=device.code;$('.desktop-provider').textContent='Microsoft will identify this sign-in as '+(current.authName||'the launcher')+'.';}
  progress.hidden=true; // The themed sticky bar owns progress on every page.
  // A progress object without a numeric percent is indeterminate: no value attribute,
  // because a raw browser progress bar would otherwise sit at an invented position.
  const installedPercent=progressOf(current)?.percent;
  if(!Number.isFinite(installedPercent))progress.removeAttribute('value');
  else progress.value=Math.max(0,Math.min(100,installedPercent));
  const needsDownload=action.kind==='download';
  installSection.hidden=!needsDownload;
  if(needsDownload){
   // First run collects a location, defaulting to the contract's own default, plus the
   // enhanced graphics toggle, and passes both to main when the download starts.
   const fallback=typeof install.defaultLocation==='string'?install.defaultLocation:'';
   if(!installTouched||!locationField.value)locationField.value=fallback;
   graphicsField.checked=install.includeGraphics!==false;
   $('.desktop-install-note').textContent='Choose where the Easter Company client is installed, then start the download.';
   $('.desktop-install-default').textContent=fallback?'Default: '+fallback:'';
   $('[data-choose-location]').hidden=typeof chooseLocation!=='function';
   $('.desktop-install-start').hidden=typeof startInstall!=='function';
  }else installError.hidden=true;
  if(heroButton){
   heroButton.disabled=busy||action.kind==='busy'||action.kind==='running';
   // The action kind is published on the element so a test can assert the gate without
   // reading the label back out of the copy.
   heroButton.dataset.action=action.kind;
   const icon=heroButton.querySelector('svg');
   if(icon){
    icon.setAttribute('viewBox','0 0 24 24');
    icon.innerHTML=action.kind==='signin'?'<path fill="currentColor" stroke="none" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>':action.kind==='play'?'<path fill="currentColor" stroke="none" d="M7 4v16l13-8z"/>':action.kind==='download'?'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>':'<path d="M8 5v14M16 5v14"/>';
   }
   heroButton.querySelector('span').firstChild.textContent=action.label;
   heroButton.querySelector('small').textContent=action.kind==='play'?joinParts([action.note,account]):action.note;
  }
  renderBar(current);
 }

 // ---- Wiring ----------------------------------------------------------------
 const signIn=()=>{if(signInPending)return;open();signInPending=true;render(current||{});void Promise.resolve(desktop.signIn()).catch(report).finally(()=>{signInPending=false;render(current||{});});};
 const start=()=>{open();void Promise.resolve(typeof playAction==='function'?playAction():Promise.reject(Error('This launcher build cannot start the game.'))).catch(report);};
 const openInstall=()=>{open();installError.hidden=true;if(typeof chooseLocation==='function'){
  // Prefill from the contract default, then let the folder picker replace it.
  const fallback=installOf(current||{}).defaultLocation;
  if(!locationField.value&&typeof fallback==='string')locationField.value=fallback;}
  locationField.focus?.();};
 // The hero is one control whose action follows the same state its label does.
 const heroAction=()=>{const action=primaryAction(current||{});
  if(action.kind==='play')return start();
  if(action.kind==='signin')return signIn();
  if(action.kind==='download')return openInstall();
  return undefined;};
 async function beginInstall(){
  if(typeof startInstall!=='function')return;
  const location=(locationField.value||'').trim()||installOf(current||{}).defaultLocation||'';
  installError.hidden=true;
  installRequested=true;
  $('.desktop-install-start').disabled=true;
  try{
   await startInstall({location,includeGraphics:Boolean(graphicsField.checked)});
  }catch(error){
   // A refused location is shown, and the flow stays usable.
   open();installError.hidden=false;installError.textContent=error&&error.message?error.message:String(error);
   locationField.setAttribute('aria-invalid','true');locationField.focus?.();
  }finally{installRequested=false;$('.desktop-install-start').disabled=false;}
 }

 const hero=document.querySelector('[data-download-primary]');
 if(hero){
  const replacement=hero.cloneNode(true);hero.replaceWith(replacement);
  replacement.removeAttribute('data-download-primary');replacement.dataset.desktopPlay='';
  heroButton=replacement;
  replacement.querySelector('span').firstChild.textContent='Download the game';
  replacement.querySelector('small').textContent='Easter Company client';
  replacement.onclick=heroAction;
  document.querySelector('.launcher-picker')?.remove();
  document.querySelector('.map-caption').textContent='Your launcher. Your world. Your crew.';
 }
 // One client control in navigation; the hero and sticky bar carry the current action.
 for(const trigger of document.querySelectorAll('[popovertarget="launcher-downloads"]'))trigger.remove();
 const settingsButton=document.createElement('button');settingsButton.type='button';settingsButton.className='desktop-account-nav';settingsButton.textContent='My client';settingsButton.onclick=open;document.querySelector('.site-header nav').append(settingsButton);

 barPrimary.onclick=()=>heroAction();
 barToggle.onclick=()=>{minimised=!minimised;writeMinimised(minimised);renderBar(current||{});if(!minimised)barToggle.focus();};
 pauseButton.onclick=()=>{if(typeof pauseTransfer==='function')void Promise.resolve(pauseTransfer()).catch(report);};
 resumeButton.onclick=()=>{if(typeof resumeTransfer==='function')void Promise.resolve(resumeTransfer()).catch(report);};
  locationField.addEventListener('input',()=>{installTouched=true;locationField.removeAttribute('aria-invalid');installError.hidden=true;});
 $('[data-choose-location]').onclick=()=>{if(typeof chooseLocation!=='function')return;
  void Promise.resolve(chooseLocation()).then(result=>{
   const value=typeof result==='string'?result:result?.location;
   if(typeof value==='string'&&value){locationField.value=value;installTouched=true;installError.hidden=true;locationField.removeAttribute('aria-invalid');}
  }).catch(error=>{installError.hidden=false;installError.textContent=error&&error.message?error.message:String(error);});};
 $('.desktop-install-start').onclick=()=>void beginInstall();
 window.addEventListener('resize',()=>{if(current)renderBar(current);},{passive:true});
 window.addEventListener('storage',event=>{if(event.key!==BAR_KEY)return;minimised=readMinimised();if(current)renderBar(current);});

 desktop.onState(render);
 const form=$('form'),memory=form.elements.memoryMB;
 memory.oninput=()=>$('#memory-value').textContent=(Number(memory.value)/1024).toFixed(1)+' GB';
 form.onsubmit=async event=>{
  event.preventDefault();
  try{settings=await desktop.saveSettings({memoryMB:Number(memory.value),server:form.elements.server.value,javaPath:form.elements.javaPath.value});$('.desktop-settings-result').textContent='Saved.';}catch(error){$('.desktop-settings-result').textContent=error.message;}
 };
 $('[data-choose-java]').onclick=()=>desktop.chooseJava().then(value=>{if(value)form.elements.javaPath.value=value;}).catch(report);
 $('[data-open-microsoft]').onclick=()=>desktop.openMicrosoft().catch(report);
 $('[data-cancel]').onclick=()=>desktop.cancelSignIn().catch(report);
 $('[data-open-folder]').onclick=()=>desktop.openFolder().catch(report);
 $('[data-sign-out]').onclick=()=>desktop.signOut().catch(report);
 $('[data-account-refresh]').onclick=()=>desktop.refreshAccount().catch(report);
 $('[data-account-sign-out]').onclick=()=>desktop.signOutAccount().catch(report);
 playButton.onclick=heroAction;
 desktop.status().then(state=>{
  settings=state.settings;totalMemoryMB=state.totalMemoryMB;
  memory.max=Math.min(16384,Math.floor(totalMemoryMB/512)*512);memory.value=settings.memoryMB;memory.oninput();
  form.elements.server.value=settings.server;form.elements.javaPath.value=settings.javaPath;
  $('.desktop-version').textContent='Easter Company '+state.version;render(state);
 }).catch(report);
})();
