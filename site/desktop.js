// The same pages run unchanged in a browser. Native capabilities only come from
// the isolated Electron preload, never a URL parameter or a saved preference.
//
// Everything below renders from the launcher state contract in doc/launcher-states.md.
// No view computes its own version of the gate: `canPlay` is the single source of
// truth for Play, so Play can never appear because an install finished alone.
//
// The surfaces are the ones Owen's review settled: Settings is a settings-only
// dialog offered only once the client is installed, the first-run install card
// lives behind the hero's Download the game action, and the enhanced graphics
// choice is a themed toggle under that action rather than a checkbox in an
// install form.
(()=>{
 const desktop=window.easterDesktop;
 if(!desktop||desktop.mode!=='desktop')return;
 document.documentElement.classList.add('desktop-mode');
 // The skip control is a website affordance. Desktop mode removes it from the DOM entirely,
 // so it never reaches assistive technology; Escape and the bounded timer still end the arrival.
 document.querySelector('.skip-arrival')?.remove();

 const TRANSFER=['downloading','paused','verifying','installing','updating'];
 const LOGIN_ACTION='Sign in with Microsoft';
 const CUSTOM_SERVER='__custom__';
 const GRAPHICS_LABEL='Enable Enhanced Graphics & Shaders';
 let current=null,settings,totalMemoryMB=0,heroButton=null,settingsButton=null,graphicsSection=null,graphicsSwitch=null,graphicsLabel=null,graphicsNote=null,graphicsError=null,signInPending=false;

 // A launcher build older than the download half exposes no install, pause, resume,
 // choose-location or update handler. Looking them up defensively hides those controls
 // instead of throwing at the player.
 const bridge=(...names)=>{for(const name of names)if(typeof desktop[name]==='function')return desktop[name].bind(desktop);};
 const chooseLocation=bridge('chooseLocation','chooseInstallLocation');
 const startInstall=bridge('startInstall','startDownload');
 const pauseTransfer=bridge('pauseInstall','pause');
 const resumeTransfer=bridge('resumeInstall','resume');
 const playAction=bridge('play','launch');
 const setGraphicsAction=bridge('setGraphics');

 const phaseOf=state=>state&&typeof state.phase==='string'?state.phase:'';
 const installOf=state=>state&&state.install&&typeof state.install==='object'?state.install:{};
 const progressOf=state=>state&&state.progress&&typeof state.progress==='object'?state.progress:null;
 const actionsOf=state=>state&&Array.isArray(state.actions)?state.actions:[];
 // A transfer is under way for the states the contract names as download or install work.
 const transferring=state=>['downloading','paused','verifying','installing','updating'].includes(phaseOf(state));
 // Visible once a download or install has started; a stale `bar` field must not hide it
 // while a transfer is running.
 const barVisible=state=>Boolean(state.bar&&state.bar.visible)||transferring(state);
 // The machine, as main reports it. Every field is optional here so an older build
 // renders without them rather than printing "undefined" at the player.
 const hardwareOf=state=>state&&state.hardware&&typeof state.hardware==='object'?state.hardware:{};
 const graphicsOf=state=>state&&state.graphics&&typeof state.graphics==='object'?state.graphics:null;
 // The Play Now stage: the client is on this device. Settings and the graphics
 // toggle belong to it and to nothing earlier.
 const atPlayNow=state=>installOf(state).installed===true;
 const settingsOffered=state=>atPlayNow(state)&&!transferring(state);
 const graphicsOffered=state=>Boolean(graphicsOf(state))&&typeof setGraphicsAction==='function'&&atPlayNow(state)&&!transferring(state);

 // The hero's primary action and the sticky bar both read this one function,
 // so no second view can invent its own version of the gate.
 function primaryAction(state){
  const phase=phaseOf(state),account=state?.profile?.name,install=installOf(state),actions=actionsOf(state);
  if(signInPending)return {kind:'busy',label:'Connecting your account…',note:'Complete Microsoft sign-in'};
  if(state&&state.canPlay&&phase!=='launching'&&phase!=='running')return {kind:'play',label:'PLAY NOW',note:'Minecraft Java Edition'};
  if(phase==='launching')return {kind:'busy',label:'Launching Minecraft…',note:'Please wait'};
  if(phase==='running')return {kind:'running',label:'Minecraft is running',note:'The map stays open alongside'};
  // A download or install under way asks for the account while the player waits.
  if(!account&&(transferring(state)||(!actions.includes('download')&&actions.includes('signin'))))return {kind:'signin',label:LOGIN_ACTION,note:'Microsoft account required'};
  if(account&&transferring(state))return {kind:'busy',label:phase==='paused'?'Download paused':'Installing Minecraft…',note:'Follow progress below'};
  // Fresh install: nothing downloaded and no account requirement to show yet.
  if(actions.includes('download')||install.installed!==true)
   return {kind:'download',label:'Download the game',note:'Easter Company client'};
  return {kind:'signin',label:LOGIN_ACTION,note:'Microsoft account required'};
 }

 const panel=document.createElement('dialog');panel.id='desktop-launcher';panel.setAttribute('aria-labelledby','desktop-title');
 // Client settings and the account lines only. No install action, no transfer, no
 // progress and no status hint about what the player still has to do.
 panel.innerHTML='<button class="dialog-close" type="button" aria-label="Close launcher">×</button><p class="eyebrow">Easter Company · Desktop</p><h2 id="desktop-title">Settings</h2><p class="desktop-account"></p><p class="desktop-company" hidden></p><button type="button" class="text-link" data-account-refresh hidden>Refresh account</button><button type="button" class="text-link" data-account-sign-out hidden>Sign out of Easter Company</button><section class="desktop-device" hidden><p class="desktop-device-instruction" id="desktop-device-instruction">Enter this code on the Microsoft sign-in page.</p><strong class="desktop-code"></strong><button type="button" class="launcher-button desktop-device-action" data-open-microsoft><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></svg><span>Login with Microsoft</span></button><p class="desktop-device-foot"><small class="desktop-provider"></small><button type="button" class="text-link" data-cancel>Cancel sign-in</button></p></section><div class="desktop-status" role="status" aria-live="polite"></div><form class="desktop-settings"><p class="desktop-settings-heading">Client settings</p><label>Server address<select name="serverSelect"></select><input name="server" autocomplete="off" spellcheck="false" placeholder="Hostname or IP:port"></label><p class="desktop-settings-note" hidden></p><details class="desktop-advanced"><summary>Advanced settings</summary><p class="desktop-advanced-note">How much memory the game may use. Too little makes the client stutter or run out of memory in busy areas; more than the game needs takes memory from everything else on this machine, so leave it alone unless you are told to change it.</p><label>Memory allocated to the game<output id="memory-value"></output><input type="range" name="memoryMB" min="2048" max="16384" step="512"><small class="desktop-memory-detail"></small></label><label>Java executable <small>Leave empty to install the matching runtime automatically.</small><span class="java-field"><input name="javaPath" autocomplete="off" spellcheck="false" placeholder="Automatic Java 25"><button type="button" data-choose-java>Browse</button></span></label></details><p class="desktop-settings-heading">Updates and launching</p><label class="desktop-preference"><input type="checkbox" name="autoUpdateLauncher"> Automatically keep launcher up-to-date.</label><label class="desktop-preference"><input type="checkbox" name="autoUpdateGame"> Automatically keep games up-to-date.</label><label class="desktop-preference"><input type="checkbox" name="exitOnLaunch"> Exit launcher when opening a game.</label><p class="desktop-launcher-update" hidden></p><button type="button" class="text-link" data-save-settings>Save settings</button><output class="desktop-settings-result" role="status"></output></form><div class="desktop-utilities"><button class="text-link" type="button" data-open-folder>Open client folder ↗</button><button class="text-link" type="button" data-sign-out>Sign out</button><small class="desktop-version"></small></div>';
 document.body.append(panel);
 // The install card is its own panel in the hero, never part of the settings dialog:
 // first-run download and client settings are different surfaces.
 const installPanel=document.createElement('section');
 installPanel.className='desktop-install-panel';installPanel.id='desktop-install-card';installPanel.hidden=true;
 installPanel.setAttribute('aria-labelledby','desktop-install-title');
 installPanel.innerHTML='<h2 id="desktop-install-title">Install the Easter Company client</h2><section class="desktop-install"><p class="desktop-install-note"></p><div class="desktop-folder"><span>Installation folder</span><strong class="desktop-install-current"></strong><button type="button" class="desktop-folder-button" data-choose-location hidden>Choose folder…</button><small class="desktop-install-default"></small></div><p class="desktop-install-graphics" hidden></p><p class="desktop-install-error" role="alert" hidden></p><button type="button" class="launcher-button desktop-install-start">Start download</button></section>';
 const $=selector=>panel.querySelector(selector);
 const $$=selector=>installPanel.querySelector(selector);
 const message=$('.desktop-status');
 // The chosen folder is held here and handed to main when the download starts.
 const locationField=document.createElement('input');locationField.type='hidden';locationField.name='installLocation';installPanel.append(locationField);
 const installError=$$('.desktop-install-error'),installGraphics=$$('.desktop-install-graphics');
 const settingsForm=$('form.desktop-settings'),serverSelect=settingsForm.elements.serverSelect,serverField=settingsForm.elements.server;
 const settingsNote=$('.desktop-settings-note'),settingsResult=$('.desktop-settings-result');
 const memory=settingsForm.elements.memoryMB;
 let installTouched=false,installRequested=false,settingsDirty=false;
 $('.dialog-close').onclick=()=>panel.close();
 panel.addEventListener('click',event=>{if(event.target!==panel||event.detail===0)return;const r=panel.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)panel.close();});
 const open=()=>{if(!panel.open)panel.showModal();if(current?.device)$('[data-open-microsoft]').focus();};
 const installOpen=()=>{const button=$$('[data-choose-location]');
  if(!button.hidden)button.focus?.();else $$('.desktop-install-start').focus?.();};
 const report=error=>{message.textContent=error&&error.message?error.message:String(error);message.classList.add('is-error');};

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
 const memoryLabel=value=>(Number(value)/1024).toFixed(1)+' GB';

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
  barLabel.textContent=active?label:state.canPlay?'Ready to play':installOf(state).installed?'Your client is ready':label;
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
  // Pause and resume appear only while a transfer can actually continue either way.
  const phase=phaseOf(state),offerPause=phase==='downloading'&&typeof pauseTransfer==='function';
  const offerResume=phase==='paused'&&typeof resumeTransfer==='function';
  pauseButton.hidden=!offerPause;resumeButton.hidden=!offerResume;
 }

 // ---- Server choice ---------------------------------------------------------
 // The entries are published by the main process. The current value is looked up in
 // them, so a saved address that is not one of them simply shows as the player's own.
 function publishedServers(state){
  const list=state&&Array.isArray(state.servers)?state.servers:[];
  const seen=new Set();
  return list.filter(entry=>entry&&typeof entry==='object'&&typeof entry.address==='string'&&entry.address&&!seen.has(entry.address)&&seen.add(entry.address));
 }
 function serverChoice(state,value){
  const servers=publishedServers(state);
  const entry=servers.find(server=>server.address===value);
  if(entry)return {value:entry.address,address:value,custom:false,entry};
  return {value:CUSTOM_SERVER,address:value,custom:true,entry:null};
 }
 function buildServerOptions(state,value){
  const servers=publishedServers(state),choice=serverChoice(state,value);
  serverSelect.replaceChildren();
  if(!servers.length){
   // No published list: the address stays a plain field rather than losing the setting.
   serverSelect.hidden=true;serverField.hidden=false;
   return choice;
  }
  serverSelect.hidden=false;
  for(const server of servers){
   const option=document.createElement('option');
   option.value=server.address;option.textContent=server.label||server.address;
   if(server.pending){
    // A pending entry is shown, and shown as unusable rather than silently failing.
    option.disabled=true;
    option.textContent=(server.label||server.address)+' — '+(server.note||'Not available yet');
   }else if(server.note)option.textContent=(server.label||server.address)+' — '+server.note;
   serverSelect.append(option);
  }
  const custom=document.createElement('option');
  custom.value=CUSTOM_SERVER;custom.textContent='Custom address…';
  serverSelect.append(custom);
  serverSelect.value=choice.value;
  serverField.hidden=!choice.custom;
  return choice;
 }

 // ---- Settings dialog -------------------------------------------------------
 // Client settings only, and only once the client is installed. No install, update
 // or play action lives here, and the dialog carries no transfer and no status hint.
 function renderSettings(state,busy){
  const graphicState=graphicsOf(state);
  const account=state.profile?.name,company=state.account;
  $('.desktop-account').textContent=account?'Microsoft account: '+account+(state.remembered?' · Remembered on this device':' · This session only'):'No Microsoft account on this device yet.';
  // Two systems, two lines: a signed-in Microsoft account is never followed by an
  // unlabelled sentence about the Easter Company account, and with no company
  // account the line is omitted rather than advertised.
  $('.desktop-company').hidden=!company;
  $('.desktop-company').textContent=company?'Easter Company account: '+company.name+(company.roles?.length?' · '+company.roles.join(', '):''):'';
  $('[data-account-refresh]').hidden=!account;$('[data-account-refresh]').disabled=busy;
  // The session token never comes near the UI; only whether one is held and when
  // it lapses, so a player can see that signing in again is enough.
  const live=Boolean(company)&&state.sessionExpiresAt>Date.now();
  $('[data-account-sign-out]').hidden=!live||busy;
  $('[data-sign-out]').hidden=!account;$('[data-sign-out]').disabled=busy&&phaseOf(state)!=='running';
  $('.desktop-version').textContent='Easter Company '+state.version+(graphicState?' · Enhanced graphics '+(graphicState.enabled?'on':'off'):'');
  settingsForm.inert=busy;
 }

 function fillServerRow(state,address){
  const choice=buildServerOptions(state,address);
  serverField.value=address;
  // A pending entry explains itself whenever it is the one on show, whether that is
  // the saved setting or the player's own current pick.
  showServerNote(choice.entry);
 }
 // A pending address is shown as unusable, and says why, rather than being offered as
 // a choice that would silently fail to connect.
 function showServerNote(entry){
  const pending=Boolean(entry&&entry.pending);
  settingsNote.hidden=!pending;
  settingsNote.textContent=pending?(entry.note||'This address is not available yet.'):'';
 }

 // ---- Hero surfaces ---------------------------------------------------------
 // The install card is the only place install actions exist, and it is opened by
 // the hero's own Download the game action.
 function renderInstallCard(state,open){
  const install=installOf(state),graphicsState=graphicsOf(state),hardware=hardwareOf(state);
  const fallback=typeof install.defaultLocation==='string'?install.defaultLocation:'';
  if(!installTouched||!locationField.value)locationField.value=fallback;
  const location=locationField.value||fallback;
  $$('.desktop-install-current').textContent=location||'Not chosen yet';
  // The default is supporting text, and the choice is a real button.
  $$('.desktop-install-default').textContent=!location?'':location===fallback?'The app-owned folder, used unless you choose another.':'Default: '+fallback;
  $$('[data-choose-location]').hidden=typeof chooseLocation!=='function';
  // The card states what the automatic choice for this machine will be; the toggle
  // under the hero action is the only graphics control in the launcher.
  const recommended=graphicsState?Boolean(graphicsState.recommended):Boolean(install.includeGraphics);
  const why=graphicsState?.reason||hardware.reason||'';
  installGraphics.hidden=!graphicsState;
  installGraphics.textContent=graphicsState?joinParts(['Enhanced graphics and shaders will be '+(recommended?'included':'left off')+' automatically on this machine.',why,graphicsState.tunable===false?'This machine cannot report enough about its graphics to promise a quality level.':'']):'';
  $$('.desktop-install-start').hidden=typeof startInstall!=='function';
  if(open)installError.hidden=true;
 }

 function renderGraphics(state,busy){
  const graphicState=graphicsOf(state),hardware=hardwareOf(state);
  const enabled=Boolean(graphicState?.enabled);
  graphicsLabel.textContent=GRAPHICS_LABEL;
  graphicsSwitch.checked=enabled;
  graphicsSwitch.disabled=busy;
  graphicsSection.classList.toggle('is-on',enabled);
  const tuned=graphicState?.tuned;
  graphicsNote.textContent=joinParts([graphicState?.reason||hardware.reason||'Adds shaders and higher quality settings to the installed client.',
   enabled&&tuned&&Number.isFinite(tuned.renderDistance)?'Render distance '+tuned.renderDistance+(Number.isFinite(tuned.shadowDistance)?', shadow distance '+tuned.shadowDistance:'')+(tuned.shaders?' with shaders':''):'',
   graphicState?.tunable===false?'This machine cannot report enough about its graphics to promise a quality level.':'']);
 }

 // ---- State rendering -------------------------------------------------------
 function render(state){
  current={...current,...state};
  if(installRequested&&transferring(current)){installRequested=false;if(panel.open)panel.close();}
  const busy=signInPending||['signing-in','refreshing','launching','running'].includes(phaseOf(current));
  const action=primaryAction(current);
  // The dialog's status line belongs to the sign-in flow it is showing. Settings
  // carries no status hint about what the player still has to do.
  message.classList.remove('is-error');
  message.textContent=current.device?'':(current.message||'');
  renderSettings(current,busy);
  const stateSettings=current.settings&&typeof current.settings==='object'?current.settings:null;
  if(stateSettings)settings=stateSettings;
  if(!settingsDirty)fillServerRow(current,typeof settings?.server==='string'?settings.server:'');
  if(!settingsDirty&&Number.isFinite(Number(settings?.memoryMB))){
   memory.value=settings.memoryMB;memory.max=Math.min(16384,Math.floor(totalMemoryMB/512)*512);
   $('#memory-value').textContent=memoryLabel(memory.value);
   $('.desktop-memory-detail').textContent=memoryLabel(memory.value)+' of '+memoryLabel(memory.max)+' this machine can give the game.';
  }
  if(!settingsDirty&&typeof settings?.javaPath==='string')settingsForm.elements.javaPath.value=settings.javaPath;
  if(!settingsDirty)for(const name of ['autoUpdateLauncher','autoUpdateGame','exitOnLaunch'])
   settingsForm.elements[name].checked=settings?.[name]!==false;
  const launcherNotice=$('.desktop-launcher-update'),update=current?.launcherUpdate;
  if(update&&update.phase==='available'&&update.url){
   launcherNotice.hidden=false;
   launcherNotice.replaceChildren(document.createTextNode((update.message||'A newer launcher is available.')+' '));
   const link=document.createElement('a');link.href=update.url;link.target='_blank';link.rel='noopener';link.textContent='Get it here.';
   launcherNotice.append(link);
  }else launcherNotice.hidden=true;
  renderProfile(current);
  const device=current.device;$('.desktop-device').hidden=!device;
  // Keep the pending sign-in focused on the instruction, code and browser action.
  const wasSigningIn=panel.classList.contains('is-signing-in');
  panel.classList.toggle('is-signing-in',Boolean(device));
  if(device){
   panel.removeAttribute('aria-labelledby');panel.setAttribute('aria-label','Sign in with Microsoft');
   panel.setAttribute('aria-describedby','desktop-device-instruction');
   $('.desktop-code').textContent=device.code;
   $('.desktop-provider').textContent='Microsoft lists this app as '+(current.authName||'the launcher')+'.';
   if(!wasSigningIn&&panel.open)$('[data-open-microsoft]').focus();
  }else{
   panel.removeAttribute('aria-label');panel.removeAttribute('aria-describedby');panel.setAttribute('aria-labelledby','desktop-title');
  }
  // Settings is the hero's secondary action, and it is offered only at the Play Now
  // stage. Before that the hero shows the download action instead.
  if(settingsButton){
   settingsButton.hidden=!settingsOffered(current);
   settingsButton.disabled=busy;
  }
  if(graphicsSection){
   graphicsSection.hidden=!graphicsOffered(current);
   if(!graphicsSection.hidden)renderGraphics(current,busy);
  }
  const needsDownload=action.kind==='download';
  installPanel.hidden=!needsDownload;
  if(needsDownload)renderInstallCard(current,true);else installError.hidden=true;
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
   heroButton.querySelector('small').textContent=action.kind==='play'?joinParts([action.note,current.profile?.name]):action.note;
  }
  renderBar(current);
 }

 // ---- Wiring ----------------------------------------------------------------
 const signIn=()=>{if(signInPending)return;open();signInPending=true;render(current||{});void Promise.resolve(desktop.signIn()).catch(report).finally(()=>{signInPending=false;render(current||{});const target=$('[data-open-microsoft]');if(panel.open&&!deviceHidden())target.focus();});};
 const deviceHidden=()=>$('.desktop-device').hidden;
 const start=()=>{open();void Promise.resolve(typeof playAction==='function'?playAction():Promise.reject(Error('This launcher build cannot start the game.'))).catch(report);};
 // The install card is its own surface: the hero action reveals it and focuses it, and it
 // never opens the settings dialog on top of itself. Opening Settings here covered the card
 // with a modal, so the player saw a download they could not click.
 const openInstall=()=>{installPanel.hidden=false;installError.hidden=true;if(typeof chooseLocation==='function'&&!locationField.value){
  // Prefill from the contract default; the folder picker is the only thing that replaces it.
  const fallback=installOf(current||{}).defaultLocation;
  if(typeof fallback==='string')locationField.value=fallback;}
  installOpen();};
 const openSettings=()=>{open();if(settingsButton&&!settingsButton.hidden)settingsButton.setAttribute('aria-expanded','true');
  // Land the keyboard on the first setting that is actually usable.
  const first=current?.device?$('[data-open-microsoft]'):!serverField.hidden?serverField:$('.desktop-advanced summary');
  first?.focus?.();};
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
  $$('.desktop-install-start').disabled=true;
  try{
   // The graphics choice travels with the install as the machine's own automatic
   // answer. The toggle under the hero action is the player's, and is used once the
   // client is there.
   await startInstall({location,includeGraphics:Boolean(graphicsOf(current||{})?.recommended??installOf(current||{}).includeGraphics)});
  }catch(error){
   // A refused location is shown, and the flow stays usable.
   installError.hidden=false;installError.textContent=error&&error.message?error.message:String(error);
   locationField.setAttribute('aria-invalid','true');
  }finally{installRequested=false;$$('.desktop-install-start').disabled=false;}
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
  document.querySelector('.map-caption')?.remove();
  const actions=replacement.closest('.hero-actions')||replacement.parentElement;
  // The settings button is created with the hero, so the header never carries one.
  settingsButton=document.createElement('button');settingsButton.type='button';
  settingsButton.className='map-link desktop-settings-button';settingsButton.textContent='Settings';
  settingsButton.hidden=true;settingsButton.setAttribute('aria-haspopup','dialog');
  settingsButton.onclick=openSettings;
  actions?.append(settingsButton);
  const graphics=document.createElement('div');
  graphics.className='hero-graphics';graphics.hidden=true;
  graphics.innerHTML='<label class="hero-graphics-switch"><input type="checkbox" data-graphics-toggle><span class="hero-graphics-track" aria-hidden="true"><i></i></span><span class="hero-graphics-text"><strong class="desktop-graphics-label"></strong><small class="desktop-graphics-note"></small></span></label><p class="desktop-graphics-error" role="alert" hidden></p>';
  // Below the hero's primary action, in the hero itself rather than in a dialog.
  (actions?.parentElement||actions)?.insertBefore(graphics,actions?.nextSibling||null);
  // The install card follows the toggle, in the hero, and is opened by the hero's
  // own Download the game action.
  graphics.parentElement?.insertBefore(installPanel,graphics.nextSibling);
  graphicsSection=graphics;graphicsSwitch=graphics.querySelector('[data-graphics-toggle]');
  graphicsLabel=graphics.querySelector('.desktop-graphics-label'),graphicsNote=graphics.querySelector('.desktop-graphics-note');graphicsError=graphics.querySelector('.desktop-graphics-error');
  graphicsSwitch.addEventListener('change',async()=>{
   const wanted=graphicsSwitch.checked;
   graphicsError.hidden=true;graphicsSwitch.disabled=true;
   try{await setGraphicsAction(wanted);}
   catch(error){
    graphicsError.hidden=false;graphicsError.textContent=error&&error.message?error.message:String(error);
    graphicsSwitch.checked=!wanted;
   }finally{graphicsSwitch.disabled=false;if(current)render(current);}
  });
 }
 // The header is account-only: no client settings button is ever placed there.
 for(const trigger of document.querySelectorAll('[popovertarget="launcher-downloads"]'))trigger.remove();
 const profileButton=document.createElement('button');profileButton.type='button';profileButton.className='desktop-account-nav';profileButton.hidden=true;profileButton.setAttribute('aria-haspopup','true');profileButton.setAttribute('aria-expanded','false');
 const profileName=document.createElement('span'),face=document.createElement('canvas');face.width=32;face.height=32;face.setAttribute('aria-hidden','true');profileButton.append(profileName,face);document.querySelector('.site-header nav').append(profileButton);
 const profileMenu=document.createElement('div');profileMenu.className='desktop-profile-menu';profileMenu.popover='auto';profileMenu.setAttribute('aria-label','Profile');
 for(const [label,action] of [['Add account',()=>{profileMenu.hidePopover();signIn();}],['Switch Account',()=>{renderAccountList();}],['Logout',()=>{profileMenu.hidePopover();void desktop.signOut().catch(error=>{open();report(error);});}]]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=action;profileMenu.append(button);
 }
 const accountList=document.createElement('div');accountList.className='desktop-account-list';accountList.hidden=true;profileMenu.append(accountList);document.body.append(profileMenu);
 const positionProfile=()=>{const rect=profileButton.getBoundingClientRect();profileMenu.style.top=rect.bottom+8+'px';profileMenu.style.right=Math.max(12,innerWidth-rect.right)+'px';};
 profileButton.onclick=()=>{accountList.hidden=true;profileMenu.togglePopover();positionProfile();};
 profileMenu.addEventListener('toggle',event=>profileButton.setAttribute('aria-expanded',String(event.newState==='open')));
 window.addEventListener('resize',positionProfile);
 let skinSource=null;
 function renderProfile(state){
  profileButton.hidden=!state.profile;profileName.textContent=state.profile?.name||'';
  if(!state.profile){if(profileMenu.matches(':popover-open'))profileMenu.hidePopover();return;}
  const ctx=face.getContext('2d');
  const source=state.profile.skin||'';
  const key=state.profile.id+source;if(key===skinSource)return;skinSource=key;
  ctx.fillStyle='#536b66';ctx.fillRect(0,0,32,32);ctx.fillStyle='#eedbb2';ctx.font='bold 20px sans-serif';ctx.textAlign='center';ctx.fillText(state.profile.name[0],16,24);
  if(source.startsWith('data:image/png;base64,')){
   const image=new Image();image.onload=()=>{if(skinSource!==key)return;ctx.clearRect(0,0,32,32);ctx.imageSmoothingEnabled=false;ctx.drawImage(image,8,8,8,8,0,0,32,32);ctx.drawImage(image,40,8,8,8,0,0,32,32);};image.src=source;
  }
 }
 function renderAccountList(){
  accountList.replaceChildren();accountList.hidden=false;
  const accounts=current?.accounts||[];
  for(const account of accounts){
   const button=document.createElement('button');button.type='button';button.textContent=account.name+(account.id===current.profile?.id?' (current)':'');button.disabled=account.id===current.profile?.id;
   button.onclick=async()=>{button.disabled=true;try{await desktop.switchAccount(account.id);profileMenu.hidePopover();}catch(error){open();report(error);}finally{button.disabled=false;}};accountList.append(button);
  }
  if(!accounts.length)accountList.textContent='No saved accounts. Use Add account.';
 }

 barPrimary.onclick=()=>heroAction();
 barToggle.onclick=()=>{minimised=!minimised;writeMinimised(minimised);renderBar(current||{});if(!minimised)barToggle.focus();};
 pauseButton.onclick=()=>{if(typeof pauseTransfer==='function')void Promise.resolve(pauseTransfer()).catch(report);};
 resumeButton.onclick=()=>{if(typeof resumeTransfer==='function')void Promise.resolve(resumeTransfer()).catch(report);};
 locationField.addEventListener('input',()=>{installTouched=true;locationField.removeAttribute('aria-invalid');installError.hidden=true;});
 $$('[data-choose-location]').onclick=()=>{if(typeof chooseLocation!=='function')return;
  void Promise.resolve(chooseLocation()).then(result=>{
   const value=typeof result==='string'?result:result?.location;
   if(typeof value==='string'&&value){locationField.value=value;installTouched=true;installError.hidden=true;locationField.removeAttribute('aria-invalid');if(current)renderInstallCard(current,false);}
  }).catch(error=>{installError.hidden=false;installError.textContent=error&&error.message?error.message:String(error);});};
 $$('.desktop-install-start').onclick=()=>void beginInstall();
 serverSelect.onchange=()=>{
  settingsDirty=true;settingsResult.textContent='';
  if(serverSelect.value===CUSTOM_SERVER){serverField.hidden=false;serverField.focus?.();showServerNote(null);}
  else{serverField.hidden=true;serverField.value=serverSelect.value;showServerNote(publishedServers(current||{}).find(server=>server.address===serverSelect.value));}
 };
 settingsForm.addEventListener('input',()=>{settingsDirty=true;settingsResult.textContent='';});
 memory.oninput=()=>{$('#memory-value').textContent=memoryLabel(memory.value);
  $('.desktop-memory-detail').textContent=memoryLabel(memory.value)+' of '+memoryLabel(memory.max)+' this machine can give the game.';};
 $('[data-save-settings]').onclick=async()=>{
  const server=(serverSelect.hidden?serverField.value:serverSelect.value===CUSTOM_SERVER?serverField.value:serverSelect.value).trim();
  if(!server){settingsResult.textContent='Enter the address of the server you play on.';serverField.focus?.();return;}
  try{
   settings=await desktop.saveSettings({memoryMB:Number(memory.value),server,javaPath:settingsForm.elements.javaPath.value,
    autoUpdateLauncher:settingsForm.elements.autoUpdateLauncher.checked,autoUpdateGame:settingsForm.elements.autoUpdateGame.checked,
    exitOnLaunch:settingsForm.elements.exitOnLaunch.checked});
   settingsDirty=false;settingsResult.textContent='Saved.';
  }catch(error){settingsResult.textContent=error&&error.message?error.message:String(error);}
  if(current)render(current);
 };
 $('[data-choose-java]').onclick=()=>desktop.chooseJava().then(value=>{if(value){settingsForm.elements.javaPath.value=value;settingsDirty=true;settingsResult.textContent='';}}).catch(report);
 $('[data-open-microsoft]').onclick=()=>desktop.openMicrosoft().catch(report);
 $('[data-cancel]').onclick=()=>desktop.cancelSignIn().catch(report);
 $('[data-open-folder]').onclick=()=>desktop.openFolder().catch(report);
 $('[data-sign-out]').onclick=()=>desktop.signOut().catch(report);
 $('[data-account-refresh]').onclick=()=>desktop.refreshAccount().catch(report);
 $('[data-account-sign-out]').onclick=()=>desktop.signOutAccount().catch(report);
 window.addEventListener('resize',()=>{if(current)renderBar(current);},{passive:true});
 window.addEventListener('storage',event=>{if(event.key!==BAR_KEY)return;minimised=readMinimised();if(current)renderBar(current);});

 desktop.onState(render);
 desktop.status().then(state=>{
  settings=state.settings;totalMemoryMB=state.totalMemoryMB||8192;
  memory.max=Math.min(16384,Math.floor(totalMemoryMB/512)*512);memory.value=settings.memoryMB;memory.oninput();
  fillServerRow(state,settings.server||'');settingsForm.elements.javaPath.value=settings.javaPath||'';
  render(state);
 }).catch(report);
})();
