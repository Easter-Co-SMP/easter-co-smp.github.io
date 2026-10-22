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
 if(wordmark){
  const mark=wordmark.querySelector('.wordmark-mark');
  wordmark.textContent='Easter Co. Launcher';
  if(mark)wordmark.prepend(mark);
  wordmark.setAttribute('aria-label','Easter Co. Launcher home');
 }
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
 // The signed-out action asks for the Easter Company account, and the chooser behind it offers that
 // account through Microsoft, Google, Steam or Discord (doc/launcher-states.md, *Provider account
 // state*), so it names the account and never one provider: "Sign in" over "Easter Company account
 // required". Naming Microsoft here would ask a Discord or Google player to do something their
 // account does not do; Microsoft is named at the step where it genuinely is the requirement, the
 // linked-account hero's "Sign in with Microsoft / Starts Minecraft as <name>". One action, one
 // name, and both strings live here so the hero and the sticky bar cannot disagree.
 const LOGIN_ACTION='Sign in';
 const LOGIN_NOTE='Easter Company account required';
 let companyAuth=null,companyProfileView=null;
 const companyUI=import('./company-auth.mjs').then(({createCompanyAuth})=>{companyAuth=createCompanyAuth({desktop,signInMicrosoft,onEmails:setEmailLine,onInlineError:()=>dismissFailure()});if(current)companyAuth.render(current);return companyAuth;});
 const GRAPHICS_LABEL='Enable Enhanced Graphics & Shaders';
 let heroWait=null,authWait=null,profileWait=null,localActivity=null,serverWaitStartedAt=null;
 // Where a wait belongs. `hero` is the default and what every operation the player starts from
 // the hero publishes; `surface` is an operation they started in a menu or a dialog, which
 // reports there and never paints the hero's line (doc/launcher-states.md, `activity`).
 const heroScoped=value=>!value||(value.scope||'hero')==='hero';
 const surfaceScoped=value=>Boolean(value)&&value.scope==='surface';
 const waitingUI=import('./wait-feedback.mjs').then(({createWaitFeedback})=>{heroWait=createWaitFeedback(heroWaitNode);authWait=createWaitFeedback(auth('.desktop-auth-wait'));if(current)render(current);});
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
 accessPanel.querySelector('[data-use-account]').remove();
 // The server's row, under the hero's action: a small LED and one status line. It is the
 // only place a game state is ever written, and both halves of it are main's — the words in
 // `game.message` and the meaning the dot repeats in `game.tone` — so the sentence is
 // readable, and assertable, as text: the dot is aria-hidden and never the only signal. The
 // row shows while the server is online too, because 'Server Online, 2 active players' is
 // the ordinary sentence it exists for.
 const gameStatus=document.createElement('p');
 gameStatus.className='desktop-game-status';gameStatus.hidden=true;
 gameStatus.setAttribute('role','status');gameStatus.setAttribute('aria-live','polite');gameStatus.setAttribute('aria-atomic','true');
 gameStatus.innerHTML='<span class="desktop-game-led" aria-hidden="true"></span><span class="desktop-game-line"></span>';
 const heroWaitNode=document.createElement('p');heroWaitNode.className='desktop-activity';heroWaitNode.hidden=true;
 const gameLineNode=gameStatus.querySelector('.desktop-game-line');
 const installOf=state=>state&&state.install&&typeof state.install==='object'?state.install:{};
 const progressOf=state=>state&&state.progress&&typeof state.progress==='object'?state.progress:null;
 const actionsOf=state=>state&&Array.isArray(state.actions)?state.actions:[];
 // A transfer is under way for the states the contract names as download or install work.
 const transferring=state=>['downloading','paused','verifying','installing','updating'].includes(phaseOf(state));
 // ---- The account lock ------------------------------------------------------
 // The one place the launcher answers "is the account locked right now": account changes are
 // disabled while it is authenticating or playing (doc/launcher-states.md, *Launcher UI
 // review*). `starting-game` is the server wake, and the wake is a launch state the contract
 // names, so it belongs in this list beside the other four; that Play is not offered during a
 // wake is the hero's rule, and the account's safety must not rest on it.
 // site/company-profile.mjs keeps no copy of this list. It is handed this answer as
 // `isAccountLocked` when it opens, because this file is a classic script and cannot read a
 // module synchronously from the render path that paints the lock.
 const LOCKED_PHASES=['signing-in','refreshing','launching','running','starting-game'];
 const accountLocked=state=>signInPending||Boolean(state&&(state.accessChecking||state.accountWorking))||LOCKED_PHASES.includes(phaseOf(state));
 // Visible once a download or install has started; a stale `bar` field must not hide it
 // while a transfer is running.
 const barVisible=state=>transferring(state)||(!document.body.classList.contains('home')&&Boolean(state.bar?.visible));
 // The machine, as main reports it. Every field is optional here so an older build
 // renders without them rather than printing "undefined" at the player.
 const hardwareOf=state=>state&&state.hardware&&typeof state.hardware==='object'?state.hardware:{};
 const graphicsOf=state=>state&&state.graphics&&typeof state.graphics==='object'?state.graphics:null;
 // The game server's own field (doc/launcher-states.md, "The game server, which may be
 // asleep"). It is never the account's and never the client's: nothing here can make a
 // sign-in, a download or an account screen look wrong, and the copy it carries is the
 // main process's, so no view words a server state for itself.
 const gameOf=state=>state&&state.game&&typeof state.game==='object'?state.game:null;
 // The Play Now stage: the client is on this device. Settings and the graphics
 // toggle belong to it and to nothing earlier.
 const atPlayNow=state=>installOf(state).installed===true;
 // The Microsoft/Minecraft session, as main reports it (doc/launcher-states.md, "The Minecraft
 // session the account service holds"). A state from a build that shipped before this field
 // existed still renders: the session's word then falls back to what `microsoftConnected` used
 // to decide, so an older main process asks for exactly what it asked for before.
 const minecraftSessionOf=state=>{
  const reported=state&&state.minecraftSession&&typeof state.minecraftSession==='object'?state.minecraftSession:null;
  if(reported&&typeof reported.state==='string'&&reported.state)return reported;
  if(!state?.account)return null;
  // A state from a build without the field: a linked account with no live token is `required`,
  // an account with no Microsoft link at all is `unlinked`, and anything else is `local`.
  const state_word=state.account.microsoftLinked!==true?'unlinked':state.microsoftConnected===false?'required':'local';
  return {state:state_word,serverHeld:false,checkedAt:null};
 };
 // Settings is client settings, and a launcher update check is the launcher working on
 // the same machine: Owen's decision of 2026-10-17 is that the dialog is not offered
 // while `launcherUpdate.phase` is `checking`. Everything else stays usable.
 const checkingForUpdate=state=>state?.launcherUpdate?.phase==='checking';
 const settingsOffered=state=>atPlayNow(state)&&!transferring(state)&&!checkingForUpdate(state);
 // Enhanced graphics is a local client setting, so the row follows Settings rather than Play:
 // it is offered at the Play Now stage whether or not a Minecraft session exists. Main records
 // the choice and applies it from files on this device (applyGraphics), which needs no account,
 // so no access value may gate the row (doc/launcher-states.md, "Enhanced Graphics & Shaders").
 const graphicsOffered=state=>Boolean(graphicsOf(state))&&typeof setGraphicsAction==='function'&&atPlayNow(state)&&!transferring(state);

 // ---- The hero's glyph, one per action kind ---------------------------------
 // Owen's launcher on 1.0.39 read "Sign in with Microsoft / Starts Minecraft as OwenEaster"
 // under a PAUSE icon while he was signed in and his Microsoft account was linked. The cause was
 // the absence of this table: the icon was one inline ternary that named five kinds, and every
 // other kind — `connect-microsoft`, his — fell through to a two-bar path that is a pause symbol.
 // So every kind primaryAction can return has its own entry here, `busy` and `starting` and
 // `running` included, and a kind with no entry draws no glyph at all rather than borrowing
 // another action's icon. No entry is a shape: this table is enumerated and compared against
 // primaryAction's own `kind:` literals by tests/browser.mjs, which fails on a missing entry and
 // on two kinds sharing a glyph.
 const HERO_GLYPHS={
  // The Easter Company account, signed out.
  signin:'<path fill="currentColor" stroke="none" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>',
  play:'<path fill="currentColor" stroke="none" d="M7 4v16l13-8z"/>',
  buy:'<path d="M4.5 8h15l-1.4 12H5.9z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  'setup-profile':'<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  'check-access':'<path d="M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z"/><path d="M12 9.5v3.5"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  // Reconnect Microsoft: two links of one chain, because the account is already joined to a
  // Minecraft identity and it is the session between them that a press makes again.
  'connect-microsoft':'<path d="M9.5 14.5 14.5 9.5"/><path d="M13.2 6.6a4 4 0 0 1 5.6 5.6l-1.8 1.8"/><path d="M10.8 17.4a4 4 0 0 1-5.6-5.6l1.8-1.8"/>',
  // Link Microsoft: a plug — the one action that attaches an account that is not attached.
  'link-microsoft':'<path d="M9 3.5v4m6-4v4"/><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v4.5"/>',
  // Try again: the same question asked once more, and never a sign-in.
  'retry-minecraft':'<path d="M20 7.5V12h-4.5"/><path d="M20 12a8 8 0 1 0-2.4 6.2"/>',
  'setup-password':'<circle cx="8.5" cy="12" r="4"/><path d="M12.5 12H21m-3.5 0v3.5m-3-3.5V15"/>',
  // Anything the launcher is waiting on.
  busy:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  // The first player of a session, waiting for the server to wake.
  starting:'<path d="M4 17a8 8 0 0 1 16 0"/><circle cx="12" cy="17" r="1.6" fill="currentColor" stroke="none"/>',
  // Minecraft is running: the client's own window.
  running:'<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 20.5h6"/>'
 };

 // The hero's primary action and the sticky bar both read this one function,
 // so no second view can invent its own version of the gate.
 function primaryAction(state){
  const phase=phaseOf(state),account=state?.profile?.name,install=installOf(state),actions=actionsOf(state);
  if(state?.startupReady===false)return {kind:'busy',label:'Updating…',note:'Updates are required to continue'};
  if(signInPending)return {kind:'busy',label:'Connecting your account…',note:'Complete Microsoft sign-in'};
  if(state?.accountWorking)return {kind:'busy',label:'Connecting your account…',note:'Please wait'};
  if(state?.accessChecking)return {kind:'busy',label:'Checking Java access…',note:'Please wait'};
  if(state?.account?.passwordRequired)return {kind:'setup-password',label:'Create your password',note:'Finish your Easter Company account'};
  // The Microsoft/Minecraft session, from the field that answers the account's question rather
  // than this computer's: a genuinely unlinked account is told to link, a linked one whose
  // session has to be re-proved is told to reconnect, and a linked one whose session lives on
  // the account service is not asked for anything at all (doc/launcher-states.md, "The Minecraft
  // session the account service holds").
  //
  // Owen's rule of 2026-10-22, from the 1.0.39 screen that started this: a player who is signed
  // in and whose Microsoft account is already linked is never told to SIGN IN with Microsoft.
  // His account is linked and his Easter Company session is live, so the press would make the
  // Minecraft session again, not log him in — it reads "Reconnect Microsoft", and it still names
  // the Minecraft identity it starts. "Sign in with Microsoft" is left to the one place it is
  // true, the sign-in dialog's own title, and `link-microsoft` keeps the attach case.
  const session=minecraftSessionOf(state);
  const sessionState=session?.state;
  const minecraftName=typeof state?.account?.minecraftName==='string'?state.account.minecraftName.trim():'';
  if(sessionState==='unlinked')return {kind:'link-microsoft',label:'Link Microsoft',note:'Attach the Microsoft account that owns Minecraft'};
  if(sessionState==='checking')return {kind:'busy',label:'Checking your Minecraft session…',note:'Asking your Easter Company account'};
  // `required` and `reauth` are the same thing to the player: this account has a linked Microsoft
  // account and its Minecraft session has to be made here. They share main's sentence, and the
  // hero never claims to know WHY a stored session is gone — the account service cannot tell a
  // revoked session from one that was never stored, so neither does the launcher.
  if(sessionState==='required'||sessionState==='reauth')return {kind:'connect-microsoft',label:'Reconnect Microsoft',note:minecraftName?'Starts Minecraft as '+minecraftName:'Starts Minecraft with your linked Microsoft account'};
  // The account service could not make a session just now — it is rate-limiting mints, or it
  // cannot answer. None of that is the player's Microsoft session dying, so this offers a retry
  // and never a Microsoft sign-in.
  if(sessionState==='busy')return {kind:'retry-minecraft',label:'Try again',note:'The account service is busy right now'};
  // `unknown` is a question with no readable answer, and it is never a Microsoft demand either.
  // With no `checkedAt` the launcher has not been answered yet and is still asking (main starts
  // one mint at startup for a linked account), so the hero says what it is waiting for; after an
  // answer it could not read, the honest offer is the same question once more.
  if(sessionState==='unknown')return session.checkedAt
   ?{kind:'retry-minecraft',label:'Try again',note:'Your Minecraft session could not be checked'}
   :{kind:'busy',label:'Checking your Minecraft session…',note:'Asking your Easter Company account'};
  if(state?.companyReady===false&&!state.account&&(install.installed||state.microsoftAccount))return {kind:'signin',label:LOGIN_ACTION,note:LOGIN_NOTE};
  if(state?.minecraftAccess==='missing')return {kind:'buy',label:'Buy Now',note:'Minecraft Java Edition required'};
  if(state?.minecraftAccess==='profile-required')return {kind:'setup-profile',label:'Set up Java profile',note:'Choose your Java player name'};
  if(state?.minecraftAccess==='unknown')return {kind:'check-access',label:'Retry account check',note:'Java access could not be confirmed'};
  // The first player of a session is waiting for a cold start: the hero says so and
  // offers no second Play, because the launch happens by itself the moment the server
  // is joinable. This is a phase of Play, and it is never an account or install state.
  if(phase==='starting-game')return {kind:'starting',label:'Starting your server…',note:'Minecraft opens when your server is ready'};
  if(state&&state.canPlay&&phase!=='launching'&&phase!=='running')return {kind:'play',label:'PLAY NOW',note:'Minecraft Java Edition'};
  if(phase==='launching')return {kind:'busy',label:'Launching Minecraft…',note:'Please wait'};
  if(phase==='running')return {kind:'running',label:'Minecraft is running',note:'The map stays open alongside'};
  // A download or install under way asks for the account while the player waits.
  if(!account&&(transferring(state)||(!actions.includes('download')&&actions.includes('signin'))))return {kind:'signin',label:LOGIN_ACTION,note:LOGIN_NOTE};
  if(account&&transferring(state))return {kind:'busy',label:phase==='paused'?'Download paused':'Installing Minecraft…',note:'Follow progress below'};
  // Fresh install: nothing downloaded and no account requirement to show yet.
  if(actions.includes('download')||install.installed!==true)
   return {kind:'download',label:'Download the game',note:'Easter Company client'};
  return {kind:'signin',label:LOGIN_ACTION,note:LOGIN_NOTE};
 }

 const panel=document.createElement('dialog');panel.id='desktop-launcher';panel.setAttribute('aria-labelledby','desktop-title');
 // Settings and authentication have separate dialogs and independent lifecycles.
 panel.innerHTML=`<button class="dialog-close" type="button" aria-label="Close settings">×</button>
 <h2 id="desktop-title">Settings</h2>
 <form class="desktop-settings">
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
 <button type="button" class="launcher-button desktop-device-action" data-open-microsoft>Open the Microsoft page</button><p class="desktop-provider"></p></section>
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
 const settingsForm=$('form.desktop-settings'),settingsResult=$('.desktop-settings-result');
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
 // be open.
 //
 // `deliveredError` is the sentence the state channel has already been given. Main keeps
 // `error` set until the next ordinary message clears it, so every later broadcast repeats
 // the same sentence; without this marker each of those broadcasts repainted an old failure,
 // which is why a single failed sign-in looked permanent. Dedupe is therefore by delivery:
 // the visible failure is cleared by a dismissal or a new action, the marker is not.
 let failure='',failureHome='',deliveredError=null;
 // A failure has one home, and a modal dialog is never one of them. A modal <dialog> paints in
 // the document's top layer and makes every other element inert, so a page notice under one is
 // a sentence the player can neither read (dimmed at 1440 and 800, covered outright at 390) nor
 // dismiss — its Dismiss control sits behind the dialog box. The rule of 2026-10-18 is therefore
 // the one in doc/launcher-states.md: while ANY modal dialog is open, no page notice is painted
 // at all and the sentence is held; the last modal to close gives it back once.
 //
 // Open modals are read from the document rather than bookkept per dialog, so the dialogs that
 // site/company-auth.mjs owns, and the update gate, are covered without this file creating them.
 // Every dialog the launcher has is opened with showModal(), so an open one is a modal one.
 const modalOpen=()=>Boolean(document.querySelector('dialog[open]'));
 // The email notice is not a failure node: it is Microsoft's own answer about the address it
 // could not give, and no failure paint may blank it while its dialog stays open.
 const failureNodes=()=>[notice,auth('.desktop-auth-error')];
 const emailNoticeNode=()=>auth('.desktop-auth-notice');
 // The notice carries a dismiss control as its last child; replacing the text drops it.
 function clearFailureNodes(){for(const node of failureNodes()){node.hidden=true;node.textContent='';node.classList.remove('is-error','is-notice');}reserveNoticeSpace();}
 function clearEmailNotice(){const node=emailNoticeNode();node.hidden=true;node.textContent='';node.classList.remove('is-notice');}
 // The notice is a fixed band above the sheet, and the page keeps its place below it. Where the
 // band would reach into the content the page reserves the room the notice needs, so it never
 // sits on the crest, the heading, or a guide's first line.
 //
 // Home reserves on the hero card, and how far that card moves for one pixel of reserved space
 // depends on how the window centres it, so that reservation is measured instead of assumed: one
 // pass finds the card's response, the second gives exactly the room the notice asks for.
 //
 // A guide page has no hero card, so its room is reserved on the layout that holds the sidebar and
 // the article (site/wiki/wiki.css reads --launcher-notice-space for it). Those columns are in
 // normal flow, so the reserved padding and the movement are the same number and one pass is
 // exact. The measurement is taken from the first block of each column the band actually reaches,
 // because which column it covers depends on the window width: at 1440 the sidebar sits clear of
 // the centred band and the guide's eyebrow line is what it lands on, and below that the sidebar's
 // own brand and search are. A band that reaches nothing reserves nothing.
 //
 // A chart page is neither: the map is a full-bleed canvas with its controls docked on top of it,
 // so there is no flow to push down. The room is taken by moving the docks themselves
 // (site/desktop.css offsets the same strip by this variable), measured from the topmost docked
 // control the band actually reaches. The band is narrower than the window, so at 1440 the key on
 // the left and the zoom controls on the right sit either side of it and nothing moves; at 800 the
 // key is what it lands on, and at 390 it reaches both docks. The location pill is deliberately not
 // a measurement: it is an output with no pointer events that only appears while a region is under
 // the pointer, and counting it would shift the whole strip at 1440 for nothing.
 function reserveNoticeSpace(){
  const root=document.documentElement;
  const set=value=>root.style.setProperty('--launcher-notice-space',Math.max(0,Math.round(value))+'px');
  const shown=!notice.hidden&&Boolean(notice.textContent.trim());
  const card=shown?document.querySelector('.hero-copy'):null;
  const layout=shown&&!card?document.querySelector('.wiki-layout'):null;
  const stage=shown&&!card&&!layout?document.querySelector('.atlas-stage'):null;
  if(!shown||(!card&&!layout&&!stage)){if(root.style.getPropertyValue('--launcher-notice-space')!=='0px')set(0);root.style.removeProperty('--launcher-notice-key-space');return;}
  set(0);
  const band=notice.getBoundingClientRect(),gap=16;
  if(layout){
   let reserve=0;
   for(const column of layout.children){
    const first=column.firstElementChild||column,box=first.getBoundingClientRect();
    // An unrendered column has nothing to clear, and only a column the band horizontally reaches
    // can be covered by it.
    if(box.height<=0||box.width<=0||box.right<=band.left||box.left>=band.right||box.top>=band.bottom)continue;
    reserve=Math.max(reserve,band.bottom+gap-box.top);
   }
   set(reserve);root.style.removeProperty('--launcher-notice-key-space');
   return;
  }
  if(stage){
   let reserve=0;
   // One grouped selector: the docks are siblings in the stage, and a selector list passed as
   // several arguments is not a list at all — querySelectorAll takes one string.
   for(const dock of stage.querySelectorAll('.map-navigation, .map-key, .compass, .map-drawing')){
    const box=dock.getBoundingClientRect();
    if(box.height<=0||box.width<=0||box.right<=band.left||box.left>=band.right||box.top>=band.bottom)continue;
    reserve=Math.max(reserve,band.bottom+gap-box.top);
   }
   set(reserve);
   // Moving the strip down brings the map key nearer the bottom of the chart, and an open key grows
   // downward into whatever is docked there. Two things are: the chart's own footer, and the
   // launcher's sticky bar, which floats above that footer and spans the window at narrow widths.
   // The bar sits on the footer's own offset, so its top edge is 76 to 94px above the footer's: a key
   // capped only by the footer slid its last line ("Arrow keys move · + / − zoom") under the bar,
   // where elementFromPoint answered #launcher-bar-body and the line could not be read at all. Both
   // are the same kind of obstacle, so the key clears the first edge it meets and one number owns the
   // rule: the room above that edge is published as the key content's cap (site/desktop.css), so a
   // long legend scrolls inside the key instead of disappearing behind whatever is below it. Nothing
   // is capped unless the notice is up.
   //
   // The cap is applied with no cap underneath it, so the height the content wants is the height it
   // is allowed: a key that already clears every edge is left exactly as it is, and only one that
   // would run under an edge is capped. That is what keeps this rule silent at 800 and 1440, where
   // the room exceeds the content and the key must not change size for a limit nobody can see.
   root.style.removeProperty('--launcher-notice-key-space');
   const key=stage.querySelector('.map-key'),footer=stage.querySelector('.map-bottom');
   let cap=null;
   if(key&&footer){
    const keyBox=key.getBoundingClientRect(),footerBox=footer.getBoundingClientRect();
    const summary=key.querySelector('summary')?.getBoundingClientRect().height||0;
    let ceiling=footerBox.top-12;
    // The bar is read from the document rather than from this file's own reference, which is
    // declared further down than this measurement is defined: a bar that does not exist yet, is
    // hidden, or has no box simply has nothing to clear. Only a bar over the key's own columns can
    // cover it, so at 1440 — where the key sits left of a narrower bar — the footer stays the edge.
    // It is cleared by 4px rather than the footer's 12: the key's own border must not touch the
    // pill's, and a wider gap would shorten a key that already clears the bar at 800 by an amount
    // nobody could see, which is the kind of change that should never happen for nothing.
    const barNode=document.getElementById('launcher-bar'),barBox=barNode?barNode.getBoundingClientRect():null;
    if(barBox&&barBox.height>0&&barBox.width>0&&barBox.right>keyBox.left&&barBox.left<keyBox.right)ceiling=Math.min(ceiling,barBox.top-4);
    // A closed key has no content to measure, so it is capped unconditionally and the chart's own
    // mutation watch re-measures it when it opens.
    const content=key.open?key.querySelector('.key-content'):null;
    const room=Math.floor(ceiling-keyBox.top-summary);
    if(ceiling>keyBox.top&&(!content||content.getBoundingClientRect().height>room))cap=Math.max(80,room);
   }
   if(cap===null)root.style.removeProperty('--launcher-notice-key-space');
   else root.style.setProperty('--launcher-notice-key-space',cap+'px');
   return;
  }
  if(!card)return;
  root.style.removeProperty('--launcher-notice-key-space');
  const start=card.getBoundingClientRect().top;
  const deficit=Math.ceil(band.bottom+gap-start);
  // The band above the card is already clear: nothing to reserve.
  if(deficit<=0)return;
  const probe=Math.max(deficit,80);
  set(probe);
  const moved=card.getBoundingClientRect().top-start;
  const response=moved>0?moved/probe:0.5;
  // Capped so a short window is never eaten by the reservation.
  set(Math.min(deficit/Math.max(response,0.2),Math.max(120,innerHeight*0.6)));
 }
 // Where a sentence goes is decided by what is on screen, never by who asked for it. `held` is
 // a modal dialog that is not the sign-in dialog: the sentence keeps no surface until the last
 // modal closes.
 const failureHomeNow=()=>signin.open?'dialog':modalOpen()?'held':'notice';
 function paintFailure(text,home){
  clearFailureNodes();failure=text||'';failureHome=failure?home:'';
  if(!failure||home==='held')return;
  const target=home==='dialog'?auth('.desktop-auth-error'):notice;
  target.textContent=failure;target.hidden=false;target.classList.add('is-error');
  if(target===notice){
   const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='×';dismiss.setAttribute('aria-label','Dismiss message');
   dismiss.onclick=()=>dismissFailure();target.append(dismiss);
   reserveNoticeSpace();
  }
 }
 const showFailure=text=>{if(text)paintFailure(text,failureHomeNow());};
 function dismissFailure(){failure='';failureHome='';clearFailureNodes();}
 // A new action starts from a clean slate: the previous failure is nobody's answer to this
 // one. `deliveredError` is left alone, so the stale broadcast of that old sentence cannot
 // bring it back while the action runs.
 const clearFailure=()=>{if(failure)dismissFailure();};
 // A dialog opening or closing changes where the held sentence belongs: a modal takes the page
 // notice away, and the last modal to close gives it back exactly once. A failure the page
 // already owns is left where it is, so a re-render never duplicates it.
 function settleFailureSurface(){
  if(!failure)return;
  const home=failureHomeNow();
  if(home===failureHome)return;
  if(home==='held'){clearFailureNodes();failureHome='held';return;}
  paintFailure(failure,home);
 }
 // A sign-in that is actually running owns the dialog. The device code and the browser action
 // are what the player is waiting for, so a sentence from the state channel is never painted
 // over them: a live flow wins, and a failure that really ends it arrives through the call that
 // rejected. This is what keeps an old failure from looking like an instant one.
 const signInFlowLive=()=>Boolean(signInPending||(current&&current.device&&!cancelledSignIn));
 const report=error=>showFailure(error?.message||String(error));
 const cancelSignIn=()=>{
  if(signInPending&&['company-signing-in','company-waking','account-working'].includes(current?.activity?.stage))return;
  cancelledSignIn=true;signin.close();void desktop.cancelSignIn().catch(report);
 };
 auth('.dialog-close').onclick=cancelSignIn;auth('[data-cancel]').onclick=cancelSignIn;
 signin.addEventListener('cancel',event=>{event.preventDefault();cancelSignIn();});
 signin.addEventListener('close',()=>{releaseSignInNotice();settleFailureSurface();(current?.profile?profileButton:heroButton)?.focus();});
 panel.addEventListener('close',()=>{settingsButton?.setAttribute('aria-expanded','false');});
 // Every modal dialog in the launcher, including the ones this file did not create, changes
 // where a held failure belongs. `open` is the attribute showModal()/close() write, so watching
 // it on the document covers Settings, sign-in, the update gate and the account dialogs alike.
 if(typeof MutationObserver==='function'){
  const modalObserver=new MutationObserver(()=>settleFailureSurface());
  modalObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
 }
 // The notice's own height decides how much room the page reserves for it, so its size is
 // watched rather than assumed: a longer sentence or a narrower window re-measures itself.
 // The re-measure runs on the next frame, because a resize has not necessarily been laid out
 // by the time the event arrives, and a burst of events collapses into one pass.
 let noticeSpacePending=0;
 function scheduleNoticeSpace(){
  if(noticeSpacePending)return;
  noticeSpacePending=requestAnimationFrame(()=>{noticeSpacePending=0;reserveNoticeSpace();});
 }
 if(typeof ResizeObserver==='function')new ResizeObserver(()=>scheduleNoticeSpace()).observe(notice);
 // A dock can arrive after the notice is painted: the map's drawing palette is inserted by the
 // chart itself once its saved notes have loaded, and a reservation measured before it existed
 // left it under the band. The chart's own stage is watched for that, so the reservation follows
 // the page rather than the page having to exist first.
 if(typeof MutationObserver==='function'){
  const chart=document.querySelector('.atlas-stage');
  if(chart){
   // Only while a sentence is on screen: the chart writes to its own DOM constantly (the tooltip
   // follows the pointer), so the watch must not cost a measurement when there is nothing to clear.
   const remeasure=()=>{if(!notice.hidden)scheduleNoticeSpace();};
   new MutationObserver(remeasure).observe(chart,{childList:true,subtree:true,attributes:true,attributeFilter:['style','open','hidden','class']});
  }
 }

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
  // The bar is one of the edges the open map key has to clear, and every pass through here can move
  // it or take it away: a state that raises or lowers it, a new label that makes it taller, a
  // minimised or reopened bar, a bar that stops being shown at all. The room the key is allowed is
  // measured from the bar as it is, so it is re-measured — on the next frame, once this pass has been
  // laid out — whenever there is a sentence on screen whose room is being reserved.
  if(!notice.hidden)scheduleNoticeSpace();
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
  const game=gameOf(state);
  barLabel.textContent=active?label:game&&game.waking?game.message:state.minecraftAccess==='missing'?'Minecraft Java Edition required':state.minecraftAccess==='profile-required'?'Java profile setup required':state.minecraftAccess==='unknown'?'Check Minecraft Java access':state.canPlay?'Ready to play':installOf(state).installed?'Your client is ready':label;
  barPrimary.hidden=active||!['play','signin','download','buy','setup-profile','check-access','setup-password','connect-microsoft','link-microsoft','retry-minecraft'].includes(action.kind);
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

 // ---- Hero surfaces ---------------------------------------------------------
 // One LED and one status line under the hero action. A server that is online, asleep,
 // offline, starting, stopping or unreadable is said in exactly one sentence, and both the
 // words and the tone come from the main process, so a view never words a state for itself
 // and never re-derives which dot goes with which words. The stopped game is not an account
 // problem and never borrows an account surface: this row is the whole of it.
 function renderGame(state,standDown=false){
  const game=gameOf(state);
  // The Play Now stage only: before the client is installed there is nothing to join, and
  // the download-first screens keep the room for what the player has to do first. `standDown`
  // is the one exception in the other direction: while the cold start's wait line is carrying
  // the same sentence, this row gives way to it instead of repeating it.
  const show=Boolean(game)&&atPlayNow(state)&&!standDown;
  gameStatus.hidden=!show;
  if(!show){gameLineNode.textContent='';gameStatus.removeAttribute('data-state');gameStatus.removeAttribute('data-tone');return;}
  gameStatus.dataset.state=typeof game.state==='string'?game.state:'unknown';
  // Meaning, not colour: the stylesheet turns the tone into a dot, and the sentence below
  // stands on its own if the dot is unseen. An older main process publishes no tone, and
  // then the dot is neutral rather than guessed at.
  gameStatus.dataset.tone=typeof game.tone==='string'?game.tone:'unknown';
  const line=typeof game.message==='string'?game.message:'';
  if(gameLineNode.textContent!==line)gameLineNode.textContent=line;
 }
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
  const busy=Boolean(localActivity?.stage==='play-requested')||accountLocked(current);
  const action=primaryAction(current);

  document.querySelector('.home-footer>span:last-child')?.replaceChildren(document.createTextNode('Launcher '+(current.version||'')));
  renderSettings(current,busy);
  const stateSettings=current.settings&&typeof current.settings==='object'?current.settings:null;
  if(stateSettings)settings=stateSettings;
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
  accessPanel.hidden=!current.account||current.account.passwordRequired||minecraftSessionOf(current)?.state!=='local'||!['missing','profile-required','unknown'].includes(access);
  accessPanel.querySelector('p').textContent=access==='missing'?'This Microsoft account does not have access to Minecraft Java Edition. Buy it using the same account, then check again.':access==='profile-required'?'This account has Java Edition access. Set up your Java player profile, then check again.':'We could not confirm Java Edition access. Check again, or sign in with the account that has Minecraft.';
  accessPanel.querySelector('[data-recheck-access]').hidden=access==='unknown';
  for(const button of accessPanel.querySelectorAll('button'))button.disabled=Boolean(current.accessChecking||current.accountWorking)||signInPending;
  // The sign-in dialog is a hero-owned operation, so a surface-scoped read running beside it
  // (a username check, a verified-email read) never retitles it or hides its device code.
  if(signInPending&&current.activity&&heroScoped(current.activity))localActivity=current.activity;
  const activity=current.activity||localActivity;
  const title=signInPending&&activity&&!['microsoft-opening','microsoft-waiting'].includes(activity.stage)?'Finishing sign-in…':'Sign in with Microsoft';
  if(auth('h2').textContent!==title)auth('h2').textContent=title;
  const deviceVisible=current.device&&(!activity||['microsoft-opening','microsoft-waiting'].includes(activity.stage));
  const device=deviceVisible?current.device:null,wasWaiting=auth('.desktop-device').hidden;
  // While Microsoft's email answer is on screen the dialog is already where it belongs and
  // has nothing left to wait for, so it neither repeats the waiting line nor closes itself.
  auth('.desktop-device').hidden=!device;
  const authActivity=signInPending&&!emailNoticeHeld?activity||{stage:'microsoft-opening',message:'Opening Microsoft sign-in…'}:null;
  authWait?.set(authActivity);if(!authWait)auth('.desktop-auth-wait').hidden=!authActivity;
  const authWorking=Boolean(authActivity)&&!['microsoft-opening','microsoft-waiting'].includes(authActivity.stage);
  signin.classList.toggle('is-finishing',authWorking);
  // Auth requests honour abort; Company mutations must finish before the dialog closes.
  const companyMutation=Boolean(authActivity)&&['company-signing-in','company-waking','account-working'].includes(authActivity.stage);
  auth('[data-cancel]').hidden=emailNoticeHeld||companyMutation;
  auth('.dialog-close').hidden=companyMutation;
  auth('[data-open-microsoft]').setAttribute('aria-busy',String(Boolean(authActivity)));

  if(device&&!cancelledSignIn){
   if(panel.open)panel.close();
   if(!signin.open)signin.showModal();
   // The instruction under the code is main's own sentence (the state's `message`), so a sign-in
   // the launcher started for a reason — a stored session the account service would not renew —
   // says why in that one place, and no view invents words for it.
   const instruction=auth('.desktop-device-instruction');
   const instructionText=typeof current.message==='string'&&current.message?current.message:'Enter this code on the Microsoft sign-in page.';
   if(instruction.textContent!==instructionText)instruction.textContent=instructionText;
   // Progress broadcasts share this render path with sign-in. Replacing even
   // identical text destroys the browser's selection before the player can copy.
   const code=auth('.desktop-code'),provider=auth('.desktop-provider');
   if(code.textContent!==device.code)code.textContent=device.code;
   const providerText='Microsoft lists this app as '+(current.authName||'the launcher')+'.';
   if(provider.textContent!==providerText)provider.textContent=providerText;
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
   heroButton.setAttribute('aria-busy',String(Boolean(activity)||phaseOf(current)==='starting-game'));
   heroButton.disabled=busy||action.kind==='busy'||action.kind==='running'||action.kind==='starting'||(needsDownload&&typeof startInstall!=='function');
   // The action kind is published on the element so a test can assert the gate without
   // reading the label back out of the copy.
   heroButton.dataset.action=action.kind;
   const icon=heroButton.querySelector('svg');
   if(icon){
    icon.setAttribute('viewBox','0 0 24 24');
    // One table, one glyph per kind (HERO_GLYPHS, above primaryAction). A kind with no entry
    // draws nothing: an action that has no icon is a missing icon, never another action's.
    icon.innerHTML=HERO_GLYPHS[action.kind]||'';
   }
   heroButton.querySelector('span').firstChild.textContent=action.label;
   heroButton.querySelector('small').textContent=action.kind==='play'?joinParts([action.note,current.profile?.name]):action.note;
  }
  if(gameStatus.parentNode&&!heroWaitNode.parentNode)gameStatus.after(heroWaitNode);
  const waking=gameOf(current)?.waking===true;
  if(waking&&serverWaitStartedAt===null)serverWaitStartedAt=localActivity?.startedAt||Date.now();
  if(!waking)serverWaitStartedAt=null;
  const gameWait=waking?{stage:'server-starting',message:current.game.message||'Waiting for your server to be ready…',detail:current.game.detail,startedAt:serverWaitStartedAt}:null;
  const heroActivity=!signInPending&&!signin.open&&!document.querySelector('.desktop-company-dialog[open]')&&current.startupReady!==false&&!transferring(current)?gameWait||(heroScoped(activity)?activity:null):null;
  heroWait?.set(heroActivity);
  // The profile menu is the other surface: the verified-email read it starts reports inside it,
  // under the line that read will fill in.
  paintProfileWait();
  // The row stands down while the cold start's own wait line is carrying the same sentence,
  // so one live region says it rather than two. That is the only case it gives way to.
  renderGame(current,Boolean(gameWait)&&heroActivity===gameWait);
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
  // A successful sign-in is the newest word in this dialog, so a failure still sitting in it
  // belongs to an older operation and goes with the waiting line. The email sentence is not a
  // failure and is never a casualty of one: it is written below, and only closing the dialog
  // takes it away.
  dismissFailure();
  auth('.desktop-auth-wait').hidden=true;auth('.desktop-device').hidden=true;auth('[data-cancel]').hidden=true;
  const node=emailNoticeNode();
  node.textContent=EMAIL_UNAVAILABLE;node.hidden=false;node.classList.add('is-notice');
  if(!signin.open)signin.showModal();
 }
 // Closing the dialog ends the notice too: it belongs to the sign-in it answered and is
 // never carried into a later screen.
 function releaseSignInNotice(){
  if(!emailNoticeHeld)return;
  emailNoticeHeld=false;auth('[data-cancel]').hidden=false;
  clearEmailNotice();
 }
 function signInMicrosoft(options={}){
  if(signInPending)return;
  cancelledSignIn=false;clearFailure();if(panel.open)panel.close();
  signInPending=true;localActivity={stage:'microsoft-opening',message:'Opening Microsoft sign-in…',startedAt:Date.now()};render(current||{});if(!signin.open)signin.showModal();
  return Promise.resolve(desktop.signIn(options)).then(answer=>{
   clearFailure();
   if(emailStatusOf(answer)==='unavailable'){holdSignInNotice();return true;}
   closeSignIn();return true;
  }).catch(error=>{
   if(!cancelledSignIn){
    closeSignIn();
    // An identity conflict is a refusal about which account is signed in, and it has its own
    // copy and its own surface (the chooser, not the page notice) whichever sign-in path it
    // arrived on. Everything else keeps going to the notice.
    if(error?.code==='identity_conflict'&&companyAuth)companyAuth.conflict(error.message);
    else report(error);
   }return false;
  }).finally(()=>{signInPending=false;localActivity=null;authWait?.clear();render(current||{});});
 }
 // Play Now starts the game. It opens nothing: the dialog is for sign-in and client
 // settings. Failures appear in the visible page notice without opening Settings.
 const start=()=>{clearFailure();localActivity={stage:'play-requested',message:'Checking your server…',startedAt:Date.now()};render(current||{});void Promise.resolve(typeof playAction==='function'?playAction():Promise.reject(Error('This launcher build cannot start the game.'))).catch(report).finally(()=>{localActivity=null;render(current||{});});};
 const openSettings=()=>{open();if(settingsButton&&!settingsButton.hidden)settingsButton.setAttribute('aria-expanded','true');
  // The two shortcut rows say whether the files are really there, so the truth is asked
  // for as the dialog opens rather than trusted from the last broadcast.
  refreshShortcutState();
  // Land the keyboard on the first setting that is actually usable. There is no server
  // row to land on any more, so that is the first launch preference.
  settingsForm.elements.exitOnLaunch?.focus?.();};
 // The hero is one control whose action follows the same state its label does. It starts a
 // new action, so any failure already on screen belongs to the last one and goes.
 const heroAction=()=>{clearFailure();const action=primaryAction(current||{});
  if(action.kind==='setup-password')return void companyUI.then(ui=>ui.setup()).catch(report);
  if(action.kind==='connect-microsoft'||action.kind==='link-microsoft')return void signInMicrosoft({link:true});
  // A retry asks the account service for a Minecraft session again. It is a read: no launch and
  // no Microsoft sign-in, because a busy service is not a dead session.
  if(action.kind==='retry-minecraft')return void Promise.resolve(desktop.refreshMinecraftSession?.()).then(()=>render(current||{})).catch(report);
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
  // The server's line sits directly under the hero action, above the install details
  // and the optional graphics row.
  graphics.parentElement?.insertBefore(gameStatus,graphics);
  graphicsSection=graphics;graphicsSwitch=graphics.querySelector('[data-graphics-toggle]');
  graphicsLabel=graphics.querySelector('.desktop-graphics-label'),graphicsNote=graphics.querySelector('.desktop-graphics-note');graphicsError=graphics.querySelector('.desktop-graphics-error');
  graphicsSwitch.addEventListener('change',async()=>{
   const wanted=graphicsSwitch.checked;
   graphicsError.hidden=true;graphicsSwitch.disabled=true;
   try{await setGraphicsAction(wanted);}
   catch(error){
    graphicsError.hidden=false;graphicsError.textContent=error&&error.message?error.message:String(error);
    graphicsSwitch.checked=!wanted;
    // Main settles the sentence in state and rejects the call as well, so the same failure
    // would otherwise be painted twice. It has one home, beside the toggle that asked for it,
    // exactly as a refused install location is shown beside the download action: the page
    // notice gives up its copy.
    dismissFailure();
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
 if(homeCopy)void import('./launcher-discovery.mjs').then(({mountDiscovery})=>mountDiscovery(homeCopy.parentElement,desktop));
 // The store is a separate, explicitly labelled mock surface. It never shares
 // payment, account or entitlement state with the launcher lifecycle.
 const storeEntry=document.createElement('button');storeEntry.type='button';storeEntry.className='desktop-store-entry';storeEntry.textContent='Store';
 storeEntry.onclick=()=>{void import('./store/store.mjs').then(({openStore})=>openStore()).catch(report);};
 document.querySelector('.site-header nav')?.append(storeEntry);
 // The header is account-only: no client settings button is ever placed there.
 for(const trigger of document.querySelectorAll('[popovertarget="launcher-downloads"]'))trigger.remove();
 const profileButton=document.createElement('button');profileButton.type='button';profileButton.className='desktop-account-nav';profileButton.hidden=true;profileButton.setAttribute('aria-haspopup','true');profileButton.setAttribute('aria-expanded','false');
 const profileName=document.createElement('span'),face=document.createElement('canvas');face.width=32;face.height=32;face.setAttribute('aria-hidden','true');profileButton.append(profileName,face);document.querySelector('.site-header nav').append(profileButton);
 const profileMenu=document.createElement('div');profileMenu.className='desktop-profile-menu';profileMenu.popover='auto';profileMenu.setAttribute('aria-label','Profile');
 // The account view leads with the name the player is called and keeps the username as the
 // second, smaller line: the username is the sign-in identifier, not what they are called.
 const accountHeading=document.createElement('p');accountHeading.className='desktop-profile-heading desktop-account';
 const accountNameNode=document.createElement('strong');accountNameNode.className='desktop-account-name';
 const accountSignInNode=document.createElement('span');accountSignInNode.className='desktop-account-signin';
 accountHeading.append(accountNameNode,accountSignInNode);profileMenu.append(accountHeading);
 const companyHeading=document.createElement('p');companyHeading.className='desktop-profile-heading desktop-company';profileMenu.append(companyHeading);
 // The verified email is the profile's own line: it names the address that signs this
 // account in, or states which sign-in it has instead. It is written only from the
 // owner-only read the profile section asks for, and it is the only place outside that
 // section an address is ever displayed.
 const emailLine=document.createElement('p');emailLine.className='desktop-profile-heading desktop-email';emailLine.hidden=true;profileMenu.append(emailLine);
 // Email refreshes stay silent when fast. Slow reads get text inside this menu,
 // without the shared spinner or its reserved reassurance row.
 const profileWaitNode=document.createElement('p');profileWaitNode.className='desktop-profile-wait';profileWaitNode.hidden=true;profileMenu.append(profileWaitNode);
 void import('./profile-status.mjs').then(({createProfileStatus})=>{profileWait=createProfileStatus(profileWaitNode);paintProfileWait();});
 for(const [label,action,key] of [
  // The dialog is an account surface, so it is handed the account lock itself rather than a copy
  // of it (*The account lock* above, and site/company-profile.mjs). It hands back a paint, so a
  // broadcast that changes the lock reaches controls that are already on screen.
  ['Profile & linked accounts',()=>{profileMenu.hidePopover();void import('./company-profile.mjs').then(({openCompanyProfile})=>openCompanyProfile({desktop,getState:()=>current,signInMicrosoft,isAccountLocked:()=>accountLocked(current)})).then(view=>{if(view)companyProfileView=view;}).catch(report);},'companyProfile'],
  ['Logout',()=>{profileMenu.hidePopover();void desktop.signOut().catch(report);},'logout'],
  ['Reset password',()=>{profileMenu.hidePopover();void companyUI.then(ui=>ui.reset()).catch(report);},'companyPassword'],
  ['Verified emails',()=>{profileMenu.hidePopover();void companyUI.then(ui=>ui.emails()).catch(report);},'companyEmails']]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.profileAction=key;button.onclick=action;profileMenu.append(button);
 }
 document.body.append(profileMenu);
 // Only a surface-scoped operation paints here, and only while the menu is actually open: a wait
 // that finished after the player closed the menu has no surface left to report to.
 function paintProfileWait(){
  if(!profileWait)return;
  const activity=current?.activity;
  profileWait.set(surfaceScoped(activity)&&profileMenu.matches(':popover-open')?activity:null);
 }
 const positionProfile=()=>{const rect=profileButton.getBoundingClientRect();profileMenu.style.top=rect.bottom+8+'px';profileMenu.style.right=Math.max(12,innerWidth-rect.right)+'px';};
 profileButton.onclick=()=>{
  if(!current?.account){signIn();return;}
  profileMenu.togglePopover();positionProfile();
  // The profile section asks for the account's own verified emails when it opens, which is
  // the only read of an address in the launcher. A failure is reported inside the section;
  // the line simply says what it knows.
  if(profileMenu.matches(':popover-open'))void companyUI.then(ui=>ui.refreshEmails()).catch(()=>{});
 };
 profileMenu.addEventListener('toggle',event=>{profileButton.setAttribute('aria-expanded',String(event.newState==='open'));paintProfileWait();});
 window.addEventListener('resize',positionProfile);
 let faceId=null,facePicture=null,faceSkin=null,emailView=null;
 // The name the player is called, not the handle they type. state.account.name is the
 // account's own displayName, then its Minecraft name, then its username (accounts.cjs
 // publicAccount), so the username is reached only when an account carries no name at all.
 const accountName=account=>{
  const name=account&&typeof account.name==='string'?account.name.trim():'';
  const username=account&&typeof account.username==='string'?account.username.trim():'';
  return name||username;
 };

 // The line the profile section last reported. It is kept with the account it was read
 // for, so switching accounts never shows the previous account's address.
 function setEmailLine(view){
  const account=current?.account;
  emailView=view&&account&&view.id===account.id?view:null;
  // No address, no line: the menu says only that a login email is not set yet, or why the
  // read failed. A set address is not printed here at all (streamer protection), so an
  // empty line is hidden rather than drawn as a blank row.
  const text=emailView&&typeof emailView.line==='string'?emailView.line.trim():'';
  emailLine.hidden=!text;
  emailLine.textContent=text;
  emailLine.classList.toggle('is-unavailable',Boolean(emailView?.error));
 }
 function renderProfile(state){
  const account=state.account,name=account?accountName(account):'';
  // Owen's report of 2026-10-19: the header showed the username where it should show the
  // name. The name leads and the username is only the fallback for an account with none.
  profileButton.hidden=false;profileName.textContent=account?(name||'Account'):'Sign in';face.hidden=!account;
  profileButton.setAttribute('aria-haspopup',account?'true':'dialog');
  profileButton.setAttribute('aria-label',account?'Account: '+name:'Sign in');
  // The account view names the player, then the handle they sign in with. The Company ID
  // stays an internal handle for switching accounts and is never a label here.
  const username=typeof account?.username==='string'?account.username.trim():'';
  accountNameNode.textContent=name;
  accountNameNode.hidden=!name;
  // "signs in as <username>" appears only when the username says something the name does
  // not: an account whose only identifier is the username already leads with it.
  const signIn=Boolean(username)&&username!==name;
  accountSignInNode.textContent=signIn?'Signs in as '+username:'';
  accountSignInNode.hidden=!signIn;
  // A session held by this machine or minted by the account service both mean the same thing to
  // the player: Microsoft is linked and there is something to play with. Only the words for a
  // linked account with no session, and an unlinked one, stay as they were.
  const heldHereOrThere=['local','server'].includes(minecraftSessionOf(state)?.state||'');
  companyHeading.hidden=!account;companyHeading.textContent=heldHereOrThere?'Microsoft / Xbox linked'+(state.profile?' · '+state.profile.name:''):account?.microsoftLinked?'Microsoft / Xbox linked · sign in to play':'Microsoft / Xbox not connected';
  const locked=accountLocked(state);
  for(const button of profileMenu.querySelectorAll('[data-profile-action]')){
   button.disabled=locked;
   button.hidden=button.dataset.profileAction.startsWith('company')&&!state.account;
  }
  // The profile dialog is the second account surface, and the lock reaches it too: its own
  // controls are disabled by the same answer, not by a disabled opener and a modal dialog
  // (site/company-profile.mjs holds no list of phases of its own). Only that answer is passed on,
  // so a broadcast cannot rebuild a control the player is using.
  companyProfileView?.syncLock();

  // The email line belongs to one account and to one read of it.
  if(!emailView||!account||emailView.id!==account.id){emailLine.hidden=true;emailLine.textContent='';}
  if(!account){emailView=null;if(profileMenu.matches(':popover-open'))profileMenu.hidePopover();return;}
  // ---- The player's face -----------------------------------------------------
  // Precedence, in Owen's order: the picture they uploaded, then the head of the Minecraft
  // skin their linked Microsoft account owns, then the initial tile. state.profile.skin is
  // already the whole skin PNG as a data URL - the main process loads it - so this is canvas
  // work only and the renderer makes no request of its own. A password sign-in holds no
  // Microsoft session and therefore no profile, so main publishes the same head from the
  // account's own Minecraft uuid instead (doc/launcher-states.md, "A password sign-in still
  // knows the account is linked"), and the canvas draws it exactly the same way.
  const picture=typeof account.picture==='string'?account.picture:'';
  const sessionSkin=account.microsoftLinked&&typeof state.profile?.skin==='string'&&state.profile.skin.startsWith('data:image/png;base64,')?state.profile.skin:'';
  const accountHead=account.microsoftLinked&&typeof state.minecraftHead==='string'&&state.minecraftHead.startsWith('data:image/png;base64,')?state.minecraftHead:'';
  const skin=sessionSkin||accountHead;
  // The work is skipped when nothing that decides the face has changed. The skin string is
  // the same instance across broadcasts, so this is a reference comparison in the common case.
  if(account.id===faceId&&picture===facePicture&&skin===faceSkin)return;
  faceId=account.id;facePicture=picture;faceSkin=skin;
  const stillCurrent=()=>faceId===account.id&&facePicture===picture&&faceSkin===skin;
  const ctx=face.getContext('2d');
  ctx.clearRect(0,0,32,32);ctx.imageSmoothingEnabled=false;
  if(!picture&&!skin){
   // The last resort: the teal tile with the first letter of the name.
   ctx.fillStyle='#536b66';ctx.fillRect(0,0,32,32);ctx.fillStyle='#eedbb2';ctx.font='bold 20px sans-serif';ctx.textAlign='center';
   ctx.fillText((name||'?').slice(0,1).toUpperCase(),16,24);
   return;
  }
  if(picture&&(picture.startsWith('data:image/png;base64,')||picture.startsWith('https://'))){
   const image=new Image();
   image.onload=()=>{if(!stillCurrent())return;ctx.clearRect(0,0,32,32);ctx.imageSmoothingEnabled=false;ctx.drawImage(image,0,0,32,32);};
   image.src=picture;
   return;
  }
  // The Minecraft head: the 8x8 face at 8,8 and the 8x8 hat overlay at 40,8, each drawn
  // nearest-neighbour into the 32px canvas with the hat over the face, which is how the
  // game itself renders a player's head.
  const image=new Image();
  image.onload=()=>{if(!stillCurrent())return;ctx.clearRect(0,0,32,32);ctx.imageSmoothingEnabled=false;
   ctx.drawImage(image,8,8,8,8,0,0,32,32);ctx.drawImage(image,40,8,8,8,0,0,32,32);};
  image.src=skin;
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
  savingSettings=true;$('[data-save-settings]').disabled=true;
  try{
   // No address travels here: the launcher targets one fixed production server and the
   // player has no say in it (doc/launcher-states.md, "The one server the launcher
   // targets"), so the save carries client settings and nothing else.
   settings=await desktop.saveSettings({memoryMB:Number(memory.value),javaPath:settingsForm.elements.javaPath.value,
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
 window.addEventListener('resize',()=>{if(current)renderBar(current);scheduleNoticeSpace();},{passive:true});
 window.addEventListener('storage',event=>{if(event.key!==BAR_KEY)return;minimised=readMinimised();if(current)renderBar(current);});

 desktop.onState(render);
 desktop.status().then(state=>{
  settings=state.settings;totalMemoryMB=state.totalMemoryMB||8192;
  memory.max=Math.min(16384,Math.floor(totalMemoryMB/512)*512);memory.value=settings.memoryMB;memory.oninput();
  settingsForm.elements.javaPath.value=settings.javaPath||'';
  render(state);
 }).catch(report);
})();
