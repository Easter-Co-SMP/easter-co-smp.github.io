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
 const wordmark=document.querySelector('.site-wordmark');
 if(wordmark){wordmark.textContent='Easter Co. Launcher';wordmark.setAttribute('aria-label','Easter Co. Launcher home');}
 // The skip control is a website affordance. Desktop mode removes it from the DOM entirely,
 // so it never reaches assistive technology; Escape and the bounded timer still end the arrival.
 document.querySelector('.skip-arrival')?.remove();
 // The big "The Ultimate Minecraft Experience" headline is the website's line. Owen's
 // decision of 2026-10-17: the launcher keeps the crest and the small Easter Co. SMP
 // eyebrow and shows the client controls instead, so the headline leaves the app DOM.
 document.querySelector('.hero-copy h1')?.remove();
 // The promo page is the website's job. The launcher keeps the crest, the name and the client
 // controls; the welcome blurb, the endgame note, the wiki/roles story and the notes strip are
 // marketing for visitors and never enter the app DOM. Home then fits the window instead of
 // scrolling like a page (see the app shell rules at the end of desktop.css).
 for(const selector of ['.hero-welcome','.home-below','.home-story','.home-notes'])document.querySelectorAll(selector).forEach(node=>node.remove());

 const TRANSFER=['downloading','paused','verifying','installing','updating'];
 // The signed-out action starts Microsoft linking, which is where an account comes from.
 const LOGIN_ACTION='Link Microsoft Account';
 let companyAuth=null;
 const companyUI=import('./company-auth.mjs').then(({createCompanyAuth})=>{companyAuth=createCompanyAuth({desktop,signInMicrosoft,onEmails:setEmailLine,onInlineError:()=>dismissFailure()});if(current)companyAuth.render(current);return companyAuth;});
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
 const accessPanel=document.createElement('section');accessPanel.className='desktop-access';accessPanel.hidden=true;accessPanel.setAttribute('aria-label','Minecraft Java access');
 accessPanel.innerHTML='<p class="desktop-access-copy" role="status"></p><div><button type="button" data-recheck-access>Check again</button><button type="button" data-use-account>Use a different account</button></div>';
 accessPanel.querySelector('[data-recheck-access]').onclick=()=>{void desktop.recheckAccess().catch(report);};
 accessPanel.querySelector('[data-use-account]').onclick=()=>signIn({switchAccount:true});
 const installOf=state=>state&&state.install&&typeof state.install==='object'?state.install:{};
 const progressOf=state=>state&&state.progress&&typeof state.progress==='object'?state.progress:null;
 const actionsOf=state=>state&&Array.isArray(state.actions)?state.actions:[];
 // A transfer is under way for the states the contract names as download or install work.
 const transferring=state=>['downloading','paused','verifying','installing','updating'].includes(phaseOf(state));
 // Visible once a download or install has started; a stale `bar` field must not hide it
 // while a transfer is running.
 const barVisible=state=>transferring(state)||(!document.body.classList.contains('home')&&Boolean(state.bar?.visible));
 // The machine, as main reports it. Every field is optional here so an older build
 // renders without them rather than printing "undefined" at the player.
 const hardwareOf=state=>state&&state.hardware&&typeof state.hardware==='object'?state.hardware:{};
 const graphicsOf=state=>state&&state.graphics&&typeof state.graphics==='object'?state.graphics:null;
 // The Play Now stage: the client is on this device. Settings and the graphics
 // toggle belong to it and to nothing earlier.
 const atPlayNow=state=>installOf(state).installed===true;
 // Settings is client settings, and a launcher update check is the launcher working on
 // the same machine: Owen's decision of 2026-10-17 is that the dialog is not offered
 // while `launcherUpdate.phase` is `checking`. Everything else stays usable.
 const checkingForUpdate=state=>state?.launcherUpdate?.phase==='checking';
 const settingsOffered=state=>atPlayNow(state)&&!transferring(state)&&!checkingForUpdate(state);
 const graphicsOffered=state=>(!state.minecraftAccess||state.minecraftAccess==='owned')&&Boolean(graphicsOf(state))&&typeof setGraphicsAction==='function'&&atPlayNow(state)&&!transferring(state);

 // The hero's primary action and the sticky bar both read this one function,
 // so no second view can invent its own version of the gate.
 function primaryAction(state){
  const phase=phaseOf(state),account=state?.profile?.name,install=installOf(state),actions=actionsOf(state);
  if(state?.startupReady===false)return {kind:'busy',label:'Updating…',note:'Updates are required to continue'};
  if(signInPending)return {kind:'busy',label:'Connecting your account…',note:'Complete Microsoft sign-in'};
  if(state?.accountWorking)return {kind:'busy',label:'Connecting your account…',note:'Please wait'};
  if(state?.accessChecking)return {kind:'busy',label:'Checking Java access…',note:'Please wait'};
  if(state?.account?.passwordRequired)return {kind:'setup-password',label:'Create your password',note:'Finish your Easter Company account'};
  if(state?.account&&state.microsoftConnected===false)return {kind:'connect-microsoft',label:'Sign in to Minecraft',note:'Use your linked Microsoft account'};
  if(state?.companyReady===false&&!state.account&&(install.installed||state.microsoftAccount))return {kind:'signin',label:LOGIN_ACTION,note:'Microsoft account required'};
  if(state?.minecraftAccess==='missing')return {kind:'buy',label:'Buy Now',note:'Minecraft Java Edition required'};
  if(state?.minecraftAccess==='profile-required')return {kind:'setup-profile',label:'Set up Java profile',note:'Choose your Java player name'};
  if(state?.minecraftAccess==='unknown')return {kind:'check-access',label:'Retry account check',note:'Java access could not be confirmed'};
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
 // Settings and authentication have separate dialogs and independent lifecycles.
 panel.innerHTML=`<button class="dialog-close" type="button" aria-label="Close settings">×</button>
 <h2 id="desktop-title">Settings</h2>
 <form class="desktop-settings">
 <label>Server address<select name="serverSelect"></select><input name="server" autocomplete="off" spellcheck="false" placeholder="Hostname or IP:port"></label><p class="desktop-settings-note" hidden></p>
 <label class="desktop-preference"><span>Close launcher when the game starts</span><input type="checkbox" name="exitOnLaunch"></label>
 <label class="desktop-preference"><span>Minimise launcher to the system tray when the game starts</span><input type="checkbox" name="trayOnLaunch"></label>
 <div class="desktop-shortcuts"><label class="desktop-preference"><span>Desktop shortcut</span><input type="checkbox" name="desktopShortcut"></label>
 <label class="desktop-preference"><span>Start menu entry</span><input type="checkbox" name="startMenuShortcut"></label>
 <p class="desktop-shortcuts-note" role="status" hidden></p></div>
 <details class="desktop-advanced"><summary>Advanced settings</summary><p class="desktop-advanced-note">Memory is shared with other apps. Increase it only if Minecraft needs more. Changes apply the next time you launch.</p>
 <label>Memory allocated to the game<output id="memory-value"></output><input type="range" name="memoryMB" min="2048" max="16384" step="512"><small class="desktop-memory-detail"></small></label>
 <label>Java executable<small>Leave empty to use the matching runtime automatically.</small><span class="java-field"><input name="javaPath" autocomplete="off" spellcheck="false" placeholder="Automatic Java 25"><button type="button" data-choose-java>Browse</button></span></label></details>
 <div class="desktop-save-row"><button type="submit" data-save-settings>Save settings</button><output class="desktop-settings-result" role="status"></output></div></form>
 <div class="desktop-utilities"><button class="text-link" type="button" data-open-folder>Open client folder ↗</button><small class="desktop-version"></small></div>`;
 const signin=document.createElement('dialog');signin.id='desktop-signin';signin.setAttribute('aria-labelledby','desktop-signin-title');
 signin.innerHTML=`<button class="dialog-close" type="button" aria-label="Close sign-in">×</button><h2 id="desktop-signin-title">Sign in with Microsoft</h2>
 <p class="desktop-auth-wait" role="status">Connecting to Microsoft…</p><section class="desktop-device" hidden>
 <p class="desktop-device-instruction" id="desktop-device-instruction">Enter this code on the Microsoft sign-in page.</p><strong class="desktop-code"></strong>
 <button type="button" class="launcher-button desktop-device-action" data-open-microsoft>Login with Microsoft</button><p class="desktop-provider"></p></section>
 <p class="desktop-auth-error" role="alert" hidden></p><p class="desktop-auth-notice" role="status" hidden></p><button type="button" class="text-link" data-cancel>Cancel sign-in</button>`;
 document.body.append(signin);
 const startup=document.createElement('dialog');startup.id='desktop-update';startup.setAttribute('aria-labelledby','desktop-update-title');
 startup.innerHTML='<div class="desktop-update-spinner" aria-hidden="true"></div><h2 id="desktop-update-title">Checking updates…</h2><p data-update-detail role="status"></p><div class="desktop-update-progress" role="progressbar" aria-label="Update progress" hidden><i></i></div><div class="desktop-update-actions"><button type="button" data-update-retry hidden>Retry update</button><button type="button" data-update-pause hidden>Pause</button><button type="button" data-update-resume hidden>Resume</button></div>';
 startup.addEventListener('cancel',event=>event.preventDefault());document.body.append(startup);
 startup.querySelector('[data-update-retry]').onclick=()=>{void desktop.retryUpdates().catch(report);};
 startup.querySelector('[data-update-pause]').onclick=()=>{void pauseTransfer?.().catch(report);};
 startup.querySelector('[data-update-resume]').onclick=()=>{void resumeTransfer?.().catch(report);};
 let arrivalStarted=false;
 function renderStartup(state){
  const update=state.launcherUpdate||{},blocked=update.phase==='blocked';
  const active=state.startupReady===false||['checking','downloading','verifying','restarting','blocked'].includes(update.phase);
  if(!active){
   if(startup.open)startup.close();
   if(!arrivalStarted){arrivalStarted=true;window.dispatchEvent(new Event('desktop:startup-ready'));}
   return;
  }
  if(panel.open)panel.close();if(signin.open)signin.close();
  if(!startup.open)startup.showModal();
  const client=update.phase==='current',value=client?state.progress?.percent:update.percent;
  const label=blocked?'Update required':client?(phaseOf(state)==='checking-client'?'Checking game updates…':'Updating Minecraft…'):(update.message||'Checking launcher updates…');
  startup.querySelector('h2').textContent=label;
  startup.querySelector('[data-update-detail]').textContent=blocked?update.message:Number.isFinite(value)?Math.floor(value)+'%':'Please wait. Updates are required to continue.';
  startup.classList.toggle('is-blocked',blocked);
  const track=startup.querySelector('[role=progressbar]');track.hidden=!Number.isFinite(value);
  if(!track.hidden){track.setAttribute('aria-valuenow',String(Math.max(0,Math.min(100,value))));track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.firstElementChild.style.width=Math.max(0,Math.min(100,value))+'%';}
  else track.removeAttribute('aria-valuenow');
  startup.querySelector('[data-update-retry]').hidden=!blocked;
  startup.querySelector('[data-update-pause]').hidden=!client||phaseOf(state)!=='downloading';
  startup.querySelector('[data-update-resume]').hidden=!client||phaseOf(state)!=='paused';
 }
 const auth=selector=>signin.querySelector(selector);
 const notice=document.createElement('div');notice.className='desktop-page-notice';notice.setAttribute('role','alert');notice.hidden=true;document.body.append(notice);
 document.body.append(panel);
 // One screen carries one action. The hero's own Download the game starts the download,
 // so this is supporting detail beside it rather than a second panel with a second
 // button: where the client will live, and what the machine's graphics answer will be.
 const installDetails=document.createElement('div');
 installDetails.className='desktop-install-details';installDetails.id='desktop-install-details';installDetails.hidden=true;
 installDetails.innerHTML='<div class="desktop-folder"><span>Installs to</span><strong class="desktop-install-current"></strong><button type="button" class="desktop-folder-button" data-choose-location hidden>Choose folder…</button><small class="desktop-install-default"></small></div><p class="desktop-install-graphics" hidden></p><p class="desktop-install-error" role="alert" hidden></p>';
 const $=selector=>panel.querySelector(selector);
 const $$=selector=>installDetails.querySelector(selector);
 // An empty choice means the app-owned default; the folder picker is the only thing that
 // replaces it, and the hero action hands it to main when it starts the download.
 let chosenLocation='';
 const installError=$$('.desktop-install-error'),installGraphics=$$('.desktop-install-graphics');
 const settingsForm=$('form.desktop-settings'),serverSelect=settingsForm.elements.serverSelect,serverField=settingsForm.elements.server;
 const settingsNote=$('.desktop-settings-note'),settingsResult=$('.desktop-settings-result');
 const memory=settingsForm.elements.memoryMB;
 let installRequested=false,settingsDirty=false;
 $('.dialog-close').onclick=()=>panel.close();
 panel.addEventListener('click',event=>{if(event.target!==panel||event.detail===0)return;const r=panel.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)panel.close();});
 const open=()=>{if(!panel.open)panel.showModal();};
 // The two game-shortcut rows report the files, not the preference. Asking main as the
 // dialog opens is the difference between "you ticked this" and "it is on this computer".
 const refreshShortcutState=()=>{Promise.resolve(desktop.status()).then(state=>{if(!current||!state)return;current={...current,shortcuts:state.shortcuts};render(current);}).catch(()=>{});};
 let cancelledSignIn=false;
 // True while the sign-in dialog is showing Microsoft's own answer about the account's email
 // address. It holds the dialog open for one sentence the player still needs to read.
 let emailNoticeHeld=false;
 // ---- One failure, one home --------------------------------------------------
 // A failure is delivered once and then has exactly one surface: the sign-in dialog's own
 // error area while that dialog is on screen, and the page notice everywhere else. Settings
 // is never a home, so a failure can no longer be dragged into whichever dialog happens to
 // be open, and nothing replays a failure when a dialog opens or closes.
 //
 // `deliveredError` is the sentence the state channel has already been given. Main keeps
 // `error` set until the next ordinary message clears it, so every later broadcast repeats
 // the same sentence; without this marker each of those broadcasts repainted an old failure,
 // which is why a single failed sign-in looked permanent. Dedupe is therefore by delivery:
 // the visible failure is cleared by a dismissal or a new action, the marker is not.
 let failure='',failureHome='',deliveredError=null;
 const failureNodes=()=>[notice,auth('.desktop-auth-error'),auth('.desktop-auth-notice')];
 // The notice carries a dismiss control as its last child; replacing the text drops it.
 function clearFailureNodes(){for(const node of failureNodes()){node.hidden=true;node.textContent='';node.classList.remove('is-error','is-notice');}}
 // Where a sentence goes is decided by what is on screen, never by who asked for it.
 const failureHomeNow=()=>signin.open?'dialog':'notice';
 function paintFailure(text,home){
  clearFailureNodes();failure=text||'';failureHome=failure?home:'';
  if(!failure)return;
  const target=home==='dialog'?auth('.desktop-auth-error'):notice;
  target.textContent=failure;target.hidden=false;target.classList.add('is-error');
  if(target===notice){
   const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='×';dismiss.setAttribute('aria-label','Dismiss message');
   dismiss.onclick=()=>dismissFailure();target.append(dismiss);
  }
 }
 const showFailure=text=>{if(text)paintFailure(text,failureHomeNow());};
 function dismissFailure(){failure='';failureHome='';clearFailureNodes();}
 // A new action starts from a clean slate: the previous failure is nobody's answer to this
 // one. `deliveredError` is left alone, so the stale broadcast of that old sentence cannot
 // bring it back while the action runs.
 const clearFailure=()=>{if(failure)dismissFailure();};
 // The dialog that was showing a failure has gone, so the sentence moves to the page notice
 // rather than disappearing with it. A failure the page already owns is left exactly where it
 // is: the dialog's close event arrives after the call that failed has already reported.
 function moveFailureOutOfDialog(){
  if(!failure)clearFailureNodes();
  else if(failureHome==='dialog')paintFailure(failure,'notice');
 }
 // A sign-in that is actually running owns the dialog. The device code and the browser action
 // are what the player is waiting for, so a sentence from the state channel is never painted
 // over them: a live flow wins, and a failure that really ends it arrives through the call that
 // rejected. This is what keeps an old failure from looking like an instant one.
 const signInFlowLive=()=>Boolean(signInPending||(current&&current.device&&!cancelledSignIn));
 const report=error=>showFailure(error?.message||String(error));
 const cancelSignIn=()=>{
  cancelledSignIn=true;signin.close();void desktop.cancelSignIn().catch(report);
 };
 auth('.dialog-close').onclick=cancelSignIn;auth('[data-cancel]').onclick=cancelSignIn;
 signin.addEventListener('cancel',event=>{event.preventDefault();cancelSignIn();});
 signin.addEventListener('close',()=>{releaseSignInNotice();moveFailureOutOfDialog();(current?.profile?profileButton:heroButton)?.focus();});
 panel.addEventListener('close',()=>{settingsButton?.setAttribute('aria-expanded','false');});

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
  barLabel.textContent=active?label:state.minecraftAccess==='missing'?'Minecraft Java Edition required':state.minecraftAccess==='profile-required'?'Java profile setup required':state.minecraftAccess==='unknown'?'Check Minecraft Java access':state.canPlay?'Ready to play':installOf(state).installed?'Your client is ready':label;
  barPrimary.hidden=active||!['play','signin','download','buy','setup-profile','check-access','setup-password','connect-microsoft'].includes(action.kind);
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
  $('.desktop-version').textContent='Launcher '+(state.version||'');
  settingsForm.inert=busy&&phaseOf(state)!=='running';
 }

 // ---- Game shortcuts -------------------------------------------------------
 // Two preferences, and the truth about the files beside them. The main process reports
 // whether each entry is really on this computer, which is not the same question as the
 // saved preference, so a shortcut the player deleted by hand is visible here instead of
 // being assumed to work. Where the platform has no shortcut the launcher can write, the
 // rows are not offered at all and the reason is stated in their place.
 const shortcutsGroup=$('.desktop-shortcuts');
 const shortcutsNote=$('.desktop-shortcuts-note');
 const shortcutInputs={desktopShortcut:settingsForm.elements.desktopShortcut,startMenuShortcut:settingsForm.elements.startMenuShortcut};
 function shortcutNote(info){
  if(info.available===false)return info.reason||'Game shortcuts are not available on this computer.';
  // A save that could not write an entry says so in the sentence the main process chose,
  // because only it knows why the file was refused.
  if(typeof info.message==='string'&&info.message)return info.message;
  const parts=[];
  const describe=(entry,label)=>{
   if(!entry||typeof entry!=='object')return;
   if(entry.wanted&&!entry.exists)parts.push(label+' is not on this computer. Save settings to create it again.');
   // A file at the entry's name that this launcher did not write is never deleted, and
   // saying so is the difference between that and a silent no-op.
   else if(!entry.wanted&&entry.exists&&entry.ours===false)parts.push(label+' was not created by this launcher, so it is left where it is.');
   else if(!entry.wanted&&entry.exists)parts.push(label+' is still on this computer. Save settings again to remove it.');
  };
  describe(info.desktop,'The desktop shortcut');describe(info.startMenu,'The Start menu entry');
  return parts.join(' ');
 }
 function renderShortcuts(state){
  const info=state&&state.shortcuts&&typeof state.shortcuts==='object'?state.shortcuts:null;
  // An older main process publishes no shortcut state, and then carries no shortcut rows.
  shortcutsGroup.hidden=!info;
  if(!info)return;
  const available=info.available!==false;
  for(const input of Object.values(shortcutInputs)){input.parentElement.hidden=!available;input.disabled=!available;}
  const note=shortcutNote(info);
  shortcutsNote.hidden=!note;shortcutsNote.textContent=note;
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
 // The details belong to the hero's Download the game action: they say where it will
 // install and what the machine will do about graphics, and carry no action of their own.
 function renderInstallCard(state){
  const install=installOf(state),graphicsState=graphicsOf(state);
  const fallback=typeof install.defaultLocation==='string'?install.defaultLocation:'';
  const location=chosenLocation||install.location||fallback;
  $$('.desktop-install-current').textContent=location||'Not chosen yet';
  // The default is supporting text, and the choice is a real button.
  $$('.desktop-install-default').textContent=location&&location!==fallback?'Default: '+fallback:'';
  $$('[data-choose-location]').hidden=typeof chooseLocation!=='function';
  // The details state what the automatic choice for this machine will be; the toggle
  // under the hero action is the only graphics control in the launcher.
  const recommended=graphicsState?Boolean(graphicsState.recommended):Boolean(install.includeGraphics);
  installGraphics.hidden=!graphicsState;
  installGraphics.textContent=graphicsState?'Enhanced graphics '+(recommended?'included':'off')+' for this device. You can change this after installation.':'';
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
  const fromMain=state!==current;
  current={...current,...state};
  if(installRequested&&transferring(current)){installRequested=false;if(panel.open)panel.close();}
  const busy=signInPending||Boolean(current.accessChecking||current.accountWorking)||['signing-in','refreshing','launching','running'].includes(phaseOf(current));
  const action=primaryAction(current);

  document.querySelector('.home-footer>span:last-child')?.replaceChildren(document.createTextNode('Launcher '+(current.version||'')));
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
  if(!settingsDirty){
   // The two launch behaviours are linked: the launcher closes, minimises to the tray
   // or stays, and exactly one of the pair can be on. A state that somehow carried both
   // never leaves the dialog showing both.
   const exitOnLaunch=settings?.exitOnLaunch===true;
   settingsForm.elements.exitOnLaunch.checked=exitOnLaunch;
   settingsForm.elements.trayOnLaunch.checked=!exitOnLaunch&&settings?.trayOnLaunch===true;
   // The two game shortcuts are independent of each other and of the launch behaviour.
   shortcutInputs.desktopShortcut.checked=settings?.desktopShortcut===true;
   shortcutInputs.startMenuShortcut.checked=settings?.startMenuShortcut===true;
  }
  renderShortcuts(current);
  renderStartup(current);
  renderProfile(current);
  companyAuth?.render(current);
  const access=current.minecraftAccess;
  accessPanel.hidden=!current.account||current.account.passwordRequired||current.microsoftConnected===false||!['missing','profile-required','unknown'].includes(access);
  accessPanel.querySelector('p').textContent=access==='missing'?'This Microsoft account does not have access to Minecraft Java Edition. Buy it using the same account, then check again.':access==='profile-required'?'This account has Java Edition access. Set up your Java player profile, then check again.':'We could not confirm Java Edition access. Check again, or sign in with the account that has Minecraft.';
  accessPanel.querySelector('[data-recheck-access]').hidden=access==='unknown';
  for(const button of accessPanel.querySelectorAll('button'))button.disabled=Boolean(current.accessChecking||current.accountWorking)||signInPending;
  const device=current.device,wasWaiting=auth('.desktop-device').hidden;
  // While Microsoft's email answer is on screen the dialog is already where it belongs and
  // has nothing left to wait for, so it neither repeats the waiting line nor closes itself.
  auth('.desktop-device').hidden=!device;auth('.desktop-auth-wait').hidden=Boolean(device)||emailNoticeHeld;
  if(device&&!cancelledSignIn){
   if(panel.open)panel.close();
   if(!signin.open)signin.showModal();
   auth('.desktop-code').textContent=device.code;
   auth('.desktop-provider').textContent='Microsoft lists this app as '+(current.authName||'the launcher')+'.';
   if(wasWaiting)auth('[data-open-microsoft]').focus();
  }else if(!device&&!signInPending&&!emailNoticeHeld&&signin.open)signin.close();
  // Settings is the hero's secondary action, and it is offered only at the Play Now
  // stage. Before that the hero shows the download action instead.
  if(settingsButton){
   settingsButton.hidden=!settingsOffered(current);
   settingsButton.disabled=busy&&phaseOf(current)!=='running';
   // A check that begins while Settings is open closes it: the rule is that client
   // settings are unreachable during a check, not merely that the button is gone.
   // Authentication has its own dialog and is unaffected.
   if(settingsButton.hidden&&panel.open)panel.close();
  }
  if(graphicsSection){
   graphicsSection.hidden=!graphicsOffered(current);
   if(!graphicsSection.hidden)renderGraphics(current,busy);
  }
  const needsDownload=action.kind==='download';
  installDetails.hidden=!needsDownload;
  if(needsDownload)renderInstallCard(current);else installError.hidden=true;
  if(heroButton){
   heroButton.disabled=busy||action.kind==='busy'||action.kind==='running'||(needsDownload&&typeof startInstall!=='function');
   // The action kind is published on the element so a test can assert the gate without
   // reading the label back out of the copy.
   heroButton.dataset.action=action.kind;
   const icon=heroButton.querySelector('svg');
   if(icon){
    icon.setAttribute('viewBox','0 0 24 24');
    icon.innerHTML=action.kind==='signin'?'<path fill="currentColor" stroke="none" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>':action.kind==='play'?'<path fill="currentColor" stroke="none" d="M7 4v16l13-8z"/>':['buy','setup-profile'].includes(action.kind)?'<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>':action.kind==='check-access'?'<path d="M20 7v5h-5m5 0a8 8 0 1 0-2 6"/>':action.kind==='download'?'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>':'<path d="M8 5v14M16 5v14"/>';
   }
   heroButton.querySelector('span').firstChild.textContent=action.label;
   heroButton.querySelector('small').textContent=action.kind==='play'?joinParts([action.note,current.profile?.name]):action.note;
  }
  renderBar(current);
  if(fromMain){
   // The state's own failure, delivered once per distinct sentence, and then owned here: main
   // announces it in the one frame that carries it and drops it from the next, so a notice that
   // waited for the state to still say so would flash and vanish. What takes a failure away is
   // the player dismissing it or starting a new action, never a later broadcast.
   const next=typeof current.error==='string'?current.error:(phaseOf(current)==='error'&&typeof current.message==='string'?current.message:'');
   if(next!==deliveredError){
    deliveredError=next;
    if(next&&!signInFlowLive())showFailure(next);
   }
  }
 }

 // ---- Wiring ----------------------------------------------------------------
 // Sign-in opens the dialog for its device code and closes it again when the flow is
 // over: a finished login must not leave the settings dialog sitting on screen.
 const closeSignIn=()=>{if(signin.open)signin.close();};
 const signIn=(options={})=>{clearFailure();void companyUI.then(ui=>ui.open(options)).catch(report);};
 // Microsoft's own answer about the account's email address. The launcher does not print an
 // address and does not need one: it only shows the sentence this status asks for, and
 // 'stored' and 'none' pass without a word. Read from the answer itself, so a build whose
 // sign-in carries no status renders exactly as it did before.
 const EMAIL_UNAVAILABLE='We could not read your Microsoft email address. You can sign in, and choose a login email later from your profile.';
 const emailStatusOf=answer=>{
  if(!answer||typeof answer!=='object')return '';
  // The preload hands the renderer the value inside the IPC envelope; a build that answers
  // with that envelope itself is read the same way rather than silently ignored.
  const value=typeof answer.emailStatus==='string'?answer:answer.value;
  return value&&typeof value.emailStatus==='string'?value.emailStatus:'';
 };
 // The player has finished signing in and the dialog stays for one sentence: it says what
 // Microsoft could not give, and the × closes it. Nothing is left waiting, so the pending
 // line and the Cancel action go with it.
 function holdSignInNotice(){
  emailNoticeHeld=true;
  clearFailureNodes();
  auth('.desktop-auth-wait').hidden=true;auth('.desktop-device').hidden=true;auth('[data-cancel]').hidden=true;
  const node=auth('.desktop-auth-notice');
  node.textContent=EMAIL_UNAVAILABLE;node.hidden=false;node.classList.add('is-notice');
  if(!signin.open)signin.showModal();
 }
 // Closing the dialog ends the notice too: it belongs to the sign-in it answered and is
 // never carried into a later screen.
 function releaseSignInNotice(){
  if(!emailNoticeHeld)return;
  emailNoticeHeld=false;auth('[data-cancel]').hidden=false;
  clearFailureNodes();
 }
 function signInMicrosoft(options={}){
  if(signInPending)return;
  cancelledSignIn=false;clearFailure();if(panel.open)panel.close();
  signInPending=true;render(current||{});signin.showModal();
  return Promise.resolve(desktop.signIn(options)).then(answer=>{
   if(emailStatusOf(answer)==='unavailable'){holdSignInNotice();return true;}
   closeSignIn();return true;
  }).catch(error=>{
   if(!cancelledSignIn){closeSignIn();report(error);}return false;
  }).finally(()=>{signInPending=false;render(current||{});});
 }
 // Play Now starts the game. It opens nothing: the dialog is for sign-in and client
 // settings. Failures appear in the visible page notice without opening Settings.
 const start=()=>{clearFailure();void Promise.resolve(typeof playAction==='function'?playAction():Promise.reject(Error('This launcher build cannot start the game.'))).catch(report);};
 const openSettings=()=>{open();if(settingsButton&&!settingsButton.hidden)settingsButton.setAttribute('aria-expanded','true');
  // The two shortcut rows say whether the files are really there, so the truth is asked
  // for as the dialog opens rather than trusted from the last broadcast.
  refreshShortcutState();
  // Land the keyboard on the first setting that is actually usable.
  const first=!serverSelect.hidden?serverSelect:serverField;
  first?.focus?.();};
 // The hero is one control whose action follows the same state its label does. It starts a
 // new action, so any failure already on screen belongs to the last one and goes.
 const heroAction=()=>{clearFailure();const action=primaryAction(current||{});
  if(action.kind==='setup-password')return void companyUI.then(ui=>ui.setup()).catch(report);
  if(action.kind==='connect-microsoft')return void signInMicrosoft({link:true});
  if(action.kind==='buy')return void desktop.openMinecraftStore().catch(report);
  if(action.kind==='setup-profile')return void desktop.openMinecraftProfile().catch(report);
  if(action.kind==='check-access')return void desktop.recheckAccess().catch(report);
  if(action.kind==='play')return start();
  if(action.kind==='signin')return signIn();
  if(action.kind==='download')return void beginInstall();
  return undefined;};
 async function beginInstall(){
  if(typeof startInstall!=='function'||installRequested)return;
  const install=installOf(current||{});
  const location=(chosenLocation||install.location||install.defaultLocation||'').trim();
  clearFailure();installError.hidden=true;installError.textContent='';
  installRequested=true;
  try{
   // The graphics choice travels with the install as the machine's own automatic
   // answer. The toggle under the hero action is the player's, and is used once the
   // client is there.
   await startInstall({location,includeGraphics:Boolean(graphicsOf(current||{})?.recommended??installOf(current||{}).includeGraphics)});
  }catch(error){
   // A refused location is shown beside the action that tried it, and the flow stays
   // usable. A refusal has one home, so the page notice gives up its copy of it.
   installError.hidden=false;installError.textContent=error&&error.message?error.message:String(error);
   $$('[data-choose-location]').setAttribute('aria-invalid','true');
   dismissFailure();
  }finally{installRequested=false;}
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
  // The header carries Map on every page, so the hero's own View Map link would be the
  // same destination twice on one screen. Desktop mode drops it and gives the slot to
  // Settings, which appears only once there is a client to configure.
  actions?.querySelector('a.map-link')?.remove();
  // The settings button is created with the hero, so the header never carries one.
  settingsButton=document.createElement('button');settingsButton.type='button';
  settingsButton.className='map-link desktop-settings-button';settingsButton.textContent='Settings';
  settingsButton.hidden=true;settingsButton.setAttribute('aria-haspopup','dialog');
  settingsButton.onclick=openSettings;
  actions?.append(settingsButton);
  const graphics=document.createElement('div');
  graphics.className='hero-graphics';graphics.hidden=true;
  graphics.innerHTML='<label class="hero-graphics-switch"><span class="hero-graphics-text"><strong class="desktop-graphics-label"></strong></span><input type="checkbox" data-graphics-toggle><span class="hero-graphics-track" aria-hidden="true"><i></i></span></label><details class="desktop-graphics-details"><summary>Graphics details</summary><p class="desktop-graphics-note"></p></details><p class="desktop-graphics-error" role="alert" hidden></p>';
  // Below the hero's primary action, in the hero itself rather than in a dialog.
  (actions?.parentElement||actions)?.insertBefore(graphics,actions?.nextSibling||null);
  // The download details follow the toggle, in the hero, and belong to the hero's own
  // Download the game action.
  graphics.parentElement?.insertBefore(installDetails,graphics.nextSibling);
  graphics.parentElement?.insertBefore(accessPanel,graphics);
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
 const homeCopy=document.querySelector('.hero-copy'),crest=document.querySelector('.crest-frame');
 if(homeCopy&&crest){
  const heading=document.createElement('div');heading.className='desktop-home-heading';
  heading.append(crest);
  const title=document.createElement('div'),eyebrow=homeCopy.querySelector('.eyebrow');
  if(eyebrow)title.append(eyebrow);
  const edition=document.createElement('p');edition.className='desktop-edition';edition.textContent='Minecraft Java Edition';title.append(edition);
  heading.append(title);homeCopy.prepend(heading);
 }
 // The header is account-only: no client settings button is ever placed there.
 for(const trigger of document.querySelectorAll('[popovertarget="launcher-downloads"]'))trigger.remove();
 const profileButton=document.createElement('button');profileButton.type='button';profileButton.className='desktop-account-nav';profileButton.hidden=true;profileButton.setAttribute('aria-haspopup','true');profileButton.setAttribute('aria-expanded','false');
 const profileName=document.createElement('span'),face=document.createElement('canvas');face.width=32;face.height=32;face.setAttribute('aria-hidden','true');profileButton.append(profileName,face);document.querySelector('.site-header nav').append(profileButton);
 const profileMenu=document.createElement('div');profileMenu.className='desktop-profile-menu';profileMenu.popover='auto';profileMenu.setAttribute('aria-label','Profile');
 const accountHeading=document.createElement('p');accountHeading.className='desktop-profile-heading desktop-account';profileMenu.append(accountHeading);
 const companyHeading=document.createElement('p');companyHeading.className='desktop-profile-heading desktop-company';profileMenu.append(companyHeading);
 // The verified email is the profile's own line: it names the address that signs this
 // account in, or states which sign-in it has instead. It is written only from the
 // owner-only read the profile section asks for, and it is the only place outside that
 // section an address is ever displayed.
 const emailLine=document.createElement('p');emailLine.className='desktop-profile-heading desktop-email';emailLine.hidden=true;profileMenu.append(emailLine);
 for(const [label,action,key] of [
  ['Add account',()=>{profileMenu.hidePopover();signIn({switchAccount:true});},'add'],
  ['Switch Account',()=>renderAccountList(),'switch'],
  ['Logout',()=>{profileMenu.hidePopover();void desktop.signOut().catch(report);},'logout'],
  ['Reset password',()=>{profileMenu.hidePopover();void companyUI.then(ui=>ui.reset()).catch(report);},'companyPassword'],
  ['Verified emails',()=>{profileMenu.hidePopover();void companyUI.then(ui=>ui.emails()).catch(report);},'companyEmails']]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.profileAction=key;button.onclick=action;profileMenu.append(button);
 }
 const accountList=document.createElement('div');accountList.className='desktop-account-list';accountList.hidden=true;profileMenu.append(accountList);document.body.append(profileMenu);
 const positionProfile=()=>{const rect=profileButton.getBoundingClientRect();profileMenu.style.top=rect.bottom+8+'px';profileMenu.style.right=Math.max(12,innerWidth-rect.right)+'px';};
 profileButton.onclick=()=>{
  if(!current?.account){signIn();return;}
  accountList.hidden=true;profileMenu.togglePopover();positionProfile();
  // The profile section asks for the account's own verified emails when it opens, which is
  // the only read of an address in the launcher. A failure is reported inside the section;
  // the line simply says what it knows.
  if(profileMenu.matches(':popover-open'))void companyUI.then(ui=>ui.refreshEmails()).catch(()=>{});
 };
 profileMenu.addEventListener('toggle',event=>profileButton.setAttribute('aria-expanded',String(event.newState==='open')));
 window.addEventListener('resize',positionProfile);
 let skinSource=null,emailView=null;
 // The line the profile section last reported. It is kept with the account it was read
 // for, so switching accounts never shows the previous account's address.
 function setEmailLine(view){
  const account=current?.account;
  emailView=view&&account&&view.id===account.id?view:null;
  emailLine.hidden=!emailView;
  emailLine.textContent=emailView?emailView.line:'';
  emailLine.classList.toggle('is-unavailable',Boolean(emailView?.error));
 }
 function renderProfile(state){
  const account=state.account;
  profileButton.hidden=false;profileName.textContent=account?account.username||account.name:'Sign in';face.hidden=!account;
  profileButton.setAttribute('aria-haspopup',account?'true':'dialog');
  // The account view names the username the player signs in with. The Company ID stays an
  // internal handle for switching accounts and is never a label here.
  accountHeading.textContent=account?account.username?(account.name&&account.name!==account.username?account.username+' · '+account.name:account.username):account.name:'';
  companyHeading.hidden=!account;companyHeading.textContent=state.microsoftConnected?'Microsoft / Xbox linked'+(state.profile?' · '+state.profile.name:''):account?.microsoftLinked?'Microsoft / Xbox linked · sign in to play':'Microsoft / Xbox not connected';
  const locked=signInPending||Boolean(state.accessChecking||state.accountWorking)||['signing-in','refreshing','launching','running'].includes(phaseOf(state));
  for(const button of profileMenu.querySelectorAll('[data-profile-action]')){
   button.disabled=locked;
   button.hidden=button.dataset.profileAction.startsWith('company')&&!state.account;
  }
  if(!accountList.hidden)renderAccountList();
  // The email line belongs to one account and to one read of it.
  if(!emailView||!account||emailView.id!==account.id){emailLine.hidden=true;emailLine.textContent='';}
  if(!account){emailView=null;if(profileMenu.matches(':popover-open'))profileMenu.hidePopover();return;}
  const ctx=face.getContext('2d');
  const source=state.microsoftConnected?state.profile?.skin||'':'';
  const key=account.id+source;if(key===skinSource)return;skinSource=key;
  ctx.fillStyle='#536b66';ctx.fillRect(0,0,32,32);ctx.fillStyle='#eedbb2';ctx.font='bold 20px sans-serif';ctx.textAlign='center';ctx.fillText((account.username||account.name)[0],16,24);
  if(source.startsWith('data:image/png;base64,')){
   const image=new Image();image.onload=()=>{if(skinSource!==key)return;ctx.clearRect(0,0,32,32);ctx.imageSmoothingEnabled=false;ctx.drawImage(image,8,8,8,8,0,0,32,32);ctx.drawImage(image,40,8,8,8,0,0,32,32);};image.src=source;
  }
 }
 function renderAccountList(){
  accountList.replaceChildren();accountList.hidden=false;
  const accounts=current?.accounts||[];
  for(const account of accounts){
   const button=document.createElement('button');button.type='button';button.textContent=(account.username||account.name)+(account.id===(current.account?.id)?' (current)':'');button.disabled=account.id===(current.account?.id)||signInPending||['signing-in','refreshing','launching','running'].includes(phaseOf(current));
   button.onclick=async()=>{button.disabled=true;try{await desktop.switchAccount(account.id);profileMenu.hidePopover();}catch(error){profileMenu.hidePopover();report(error);}finally{renderAccountList();}};accountList.append(button);
  }
  if(!accounts.length)accountList.textContent='No saved accounts. Use Add account.';
 }

 barPrimary.onclick=()=>heroAction();
 barToggle.onclick=()=>{minimised=!minimised;writeMinimised(minimised);renderBar(current||{});if(!minimised)barToggle.focus();};
 pauseButton.onclick=()=>{if(typeof pauseTransfer==='function')void Promise.resolve(pauseTransfer()).catch(report);};
 resumeButton.onclick=()=>{if(typeof resumeTransfer==='function')void Promise.resolve(resumeTransfer()).catch(report);};
 $$('[data-choose-location]').onclick=()=>{if(typeof chooseLocation!=='function')return;
  void Promise.resolve(chooseLocation()).then(result=>{
   const value=typeof result==='string'?result:result?.location;
   if(typeof value==='string'&&value){chosenLocation=value;installError.hidden=true;installError.textContent='';$$('[data-choose-location]').removeAttribute('aria-invalid');if(current)renderInstallCard(current);}
  }).catch(error=>{installError.hidden=false;installError.textContent=error&&error.message?error.message:String(error);});};
 serverSelect.onchange=()=>{
  settingsDirty=true;settingsResult.textContent='';
  if(serverSelect.value===CUSTOM_SERVER){serverField.hidden=false;serverField.focus?.();showServerNote(null);}
  else{serverField.hidden=true;serverField.value=serverSelect.value;showServerNote(publishedServers(current||{}).find(server=>server.address===serverSelect.value));}
 };
 settingsForm.addEventListener('input',()=>{settingsDirty=true;settingsResult.textContent='';});
 // Linked launch behaviours: ticking one unticks the other here, so the dialog can never
 // leave both on. The main process enforces the same rule, and it is the one that decides.
 const launchToggles={exitOnLaunch:settingsForm.elements.exitOnLaunch,trayOnLaunch:settingsForm.elements.trayOnLaunch};
 for(const [name,toggle] of Object.entries(launchToggles))toggle.onchange=()=>{
  settingsDirty=true;settingsResult.textContent='';
  if(!toggle.checked)return;
  for(const [other,input] of Object.entries(launchToggles))if(other!==name)input.checked=false;
 };
 // The game shortcuts are one preference each: ticking one never touches the other, and
 // the save is what creates or removes the file.
 for(const input of Object.values(shortcutInputs))input.onchange=()=>{settingsDirty=true;settingsResult.textContent='';};
 memory.oninput=()=>{$('#memory-value').textContent=memoryLabel(memory.value);
  $('.desktop-memory-detail').textContent=memoryLabel(memory.value)+' of '+memoryLabel(memory.max)+' this machine can give the game.';};
 let savingSettings=false;
 settingsForm.onsubmit=async event=>{
  event.preventDefault();if(savingSettings)return;
  clearFailure();
  const server=(serverSelect.hidden?serverField.value:serverSelect.value===CUSTOM_SERVER?serverField.value:serverSelect.value).trim();
  if(!server){settingsResult.textContent='Enter the address of the server you play on.';serverField.focus?.();return;}
  savingSettings=true;$('[data-save-settings]').disabled=true;
  try{
   settings=await desktop.saveSettings({memoryMB:Number(memory.value),server,javaPath:settingsForm.elements.javaPath.value,
    exitOnLaunch:settingsForm.elements.exitOnLaunch.checked,trayOnLaunch:settingsForm.elements.trayOnLaunch.checked,
    desktopShortcut:shortcutInputs.desktopShortcut.checked,startMenuShortcut:shortcutInputs.startMenuShortcut.checked});
   // The save is the newest word on the settings, ahead of the state on screen, so the
   // dialog reads back what the main process stored rather than the broadcast before it.
   if(current)current={...current,settings};
   settingsDirty=false;settingsResult.textContent='Saved.';
  }catch(error){settingsResult.textContent=error&&error.message?error.message:String(error);}
  finally{savingSettings=false;$('[data-save-settings]').disabled=false;}
  if(current)render(current);
 };
 $('[data-choose-java]').onclick=()=>desktop.chooseJava().then(value=>{if(value){settingsForm.elements.javaPath.value=value;settingsDirty=true;settingsResult.textContent='';}}).catch(report);
 auth('[data-open-microsoft]').onclick=()=>desktop.openMicrosoft().catch(report);
 $('[data-open-folder]').onclick=()=>desktop.openFolder().catch(report);
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
