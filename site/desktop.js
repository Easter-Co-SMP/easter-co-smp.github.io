// The same pages run unchanged in a browser. Native capabilities only come from
// the isolated Electron preload, never a URL parameter or a saved preference.
(()=>{
 const desktop=window.easterDesktop;
 if(!desktop||desktop.mode!=='desktop')return;
 document.documentElement.classList.add('desktop-mode');
 // The skip control is a website affordance. Desktop mode removes it from the DOM entirely,
 // so it never reaches assistive technology; Escape and the bounded timer still end the arrival.
 document.querySelector('.skip-arrival')?.remove();
 let current,settings,totalMemoryMB;
 const panel=document.createElement('dialog');panel.id='desktop-launcher';panel.setAttribute('aria-labelledby','desktop-title');
 panel.innerHTML='<button class="dialog-close" type="button" aria-label="Close launcher">×</button><p class="eyebrow">Easter Company · Desktop</p><h2 id="desktop-title">Your next voyage.</h2><p class="desktop-account"></p><div class="desktop-status" role="status" aria-live="polite"></div><progress class="desktop-progress" max="100" hidden></progress><section class="desktop-device" hidden><p>Sign in securely with Microsoft</p><strong class="desktop-code"></strong><button type="button" class="text-link" data-open-microsoft>Open Microsoft sign-in ↗</button><small class="desktop-provider"></small><button type="button" class="text-link" data-cancel>Cancel sign-in</button></section><button class="desktop-play launcher-button" type="button">Sign in &amp; Play</button><details class="desktop-settings"><summary>Client settings</summary><form><label>Memory <output id="memory-value"></output><input type="range" name="memoryMB" min="2048" max="16384" step="512"></label><label>Server address<input name="server" autocomplete="off" spellcheck="false" placeholder="Hostname or IP:port"></label><label>Java executable <small>Leave empty to install the matching runtime automatically.</small><span class="java-field"><input name="javaPath" autocomplete="off" spellcheck="false" placeholder="Automatic Java 25"><button type="button" data-choose-java>Browse</button></span></label><button type="submit" class="text-link">Save settings</button><output class="desktop-settings-result" role="status"></output></form></details><div class="desktop-utilities"><button class="text-link" type="button" data-open-folder>Open client folder ↗</button><button class="text-link" type="button" data-sign-out>Sign out</button><small class="desktop-version"></small></div>';
 document.body.append(panel);
 const $=selector=>panel.querySelector(selector);
 const message=$('.desktop-status'),progress=$('.desktop-progress'),playButton=$('.desktop-play');
 const open=()=>{if(!panel.open)panel.showModal();};
 const report=error=>{message.textContent=error.message;};
 const start=()=>{open();void desktop.play().catch(report);};
 $('.dialog-close').onclick=()=>panel.close();
 panel.addEventListener('click',event=>{const r=panel.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)panel.close();});
 const hero=document.querySelector('[data-download-primary]');
 if(hero){
  const replacement=hero.cloneNode(true);hero.replaceWith(replacement);
  replacement.removeAttribute('data-download-primary');replacement.dataset.desktopPlay='';replacement.querySelector('span').firstChild.textContent='Sign in & Play';
  replacement.querySelector('small').textContent='Easter Company client';
  replacement.onclick=start;
  document.querySelector('.launcher-picker')?.remove();
  document.querySelector('.map-caption').textContent='Your launcher. Your world. Your crew.';
 }
 for(const trigger of document.querySelectorAll('[popovertarget="launcher-downloads"]')){
  const replacement=trigger.cloneNode(false);replacement.removeAttribute('popovertarget');replacement.removeAttribute('aria-expanded');replacement.removeAttribute('aria-haspopup');replacement.textContent='Play';replacement.dataset.desktopNav='';trigger.replaceWith(replacement);replacement.onclick=open;
 }
 const settingsButton=document.createElement('button');settingsButton.type='button';settingsButton.className='desktop-account-nav';settingsButton.textContent='My client';settingsButton.onclick=open;document.querySelector('.site-header nav').append(settingsButton);
 function render(state){
  current={...current,...state};
  const busy=['signing-in','refreshing','installing','launching','running'].includes(current.phase);
  message.textContent=current.message||'Your crew is waiting.';
  playButton.disabled=busy;playButton.textContent=current.phase==='running'?'Minecraft is running':busy?'Preparing your voyage…':current.profile?'Play Minecraft':'Sign in & Play';
  const account=current.profile?.name;
  $('.desktop-account').textContent=account?'Signed in as '+account+(current.remembered?' · Remembered on this device':' · This session only'):'Connect your Microsoft account to set sail.';
  settingsButton.textContent=account||'My client';
  $('.desktop-settings form').inert=busy;
  $('[data-sign-out]').hidden=!account;$('[data-sign-out]').disabled=busy&&current.phase!=='running';
  const device=current.device;$('.desktop-device').hidden=!device;
  if(device){$('.desktop-code').textContent=device.code;$('.desktop-provider').textContent='Microsoft will identify this sign-in as '+(current.authName||'the launcher')+'.';}
  progress.hidden=current.phase!=='installing';
  if(current.progress===null)progress.removeAttribute('value');else progress.value=current.progress;
  if(hero){
   const button=document.querySelector('[data-desktop-play]');
   button.disabled=busy;
   button.querySelector('span').firstChild.textContent=current.phase==='running'?'Minecraft is running':busy?'Preparing…':account?'Play Minecraft':'Sign in & Play';
   button.querySelector('small').textContent=account?'Welcome aboard, '+account:'Easter Company client';
  }
 }
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
 playButton.onclick=start;
 desktop.status().then(state=>{
  settings=state.settings;totalMemoryMB=state.totalMemoryMB;
  memory.max=Math.min(16384,Math.floor(totalMemoryMB/512)*512);memory.value=settings.memoryMB;memory.oninput();
  form.elements.server.value=settings.server;form.elements.javaPath.value=settings.javaPath;
  $('.desktop-version').textContent='Easter Company '+state.version;render(state);
 }).catch(report);
})();
