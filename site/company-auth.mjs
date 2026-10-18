// Company credentials cross only the isolated preload and are cleared on close.
export function createCompanyAuth({desktop,signInMicrosoft}){
 let state={},busy=false,dismissed=null;
 const chooser=document.createElement('dialog'),password=document.createElement('dialog');
 chooser.className=password.className='desktop-company-dialog';
 chooser.id='desktop-company-signin';password.id='desktop-company-password';
 chooser.setAttribute('aria-labelledby','company-signin-title');password.setAttribute('aria-labelledby','company-password-title');
 chooser.innerHTML='<button class="dialog-close" type="button" aria-label="Close account sign-in">×</button><h2 id="company-signin-title">Easter Company account</h2><button type="button" class="company-microsoft">Continue with Microsoft</button><p class="company-provider-note">New accounts will be asked to create a Company password.</p><div class="company-divider">Or use your Company ID</div><form><label>Company ID<input name="companyId" placeholder="EC-123" autocomplete="username" maxlength="64" required spellcheck="false"></label><label>Password<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label><p class="company-error" role="alert" hidden></p><button type="submit" class="company-submit">Sign in</button><button type="button" class="company-recover text-link">Forgot your ID or password?</button></form>';
 password.innerHTML='<button class="dialog-close" type="button" aria-label="Close password setup">×</button><h2 id="company-password-title">Create your Company password</h2><p class="company-id"></p><p class="company-intro">Use your Company ID and password to sign in directly next time.</p><form><label>New password<input name="password" type="password" minlength="15" maxlength="128" autocomplete="new-password" required aria-describedby="company-password-help"></label><p id="company-password-help">Use 15–128 characters. A long passphrase works well.</p><label>Confirm password<input name="confirm" type="password" minlength="15" maxlength="128" autocomplete="new-password" required></label><label class="company-show"><input type="checkbox" name="show">Show passwords</label><p class="company-error" role="alert" hidden></p><button type="submit" class="company-submit">Save password</button><button type="button" class="company-verify text-link" hidden>Verify with Microsoft</button></form>';
 document.body.append(chooser,password);
 const error=(dialog,message)=>{const node=dialog.querySelector('.company-error');node.textContent=message;node.hidden=!message;};
 const lock=value=>{busy=value;for(const dialog of [chooser,password]){dialog.setAttribute('aria-busy',String(value));for(const input of dialog.querySelectorAll('input,button'))input.disabled=value;}chooser.querySelector('.company-submit').textContent=value?'Signing in…':'Sign in';password.querySelector('.company-submit').textContent=value?'Saving…':'Save password';};
 for(const dialog of [chooser,password]){
  dialog.querySelector('.dialog-close').onclick=()=>{if(!busy)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{dialog.querySelector('form').reset();for(const input of dialog.querySelectorAll('input[name=password],input[name=confirm]'))input.type='password';error(dialog,'');if(dialog===password)dismissed=state.account?.id;});
 }
 let chooseOptions={},replacePassword=false;
 async function microsoft(recover=false){
  if(busy)return;
  const useSaved=!recover&&!chooseOptions.switchAccount&&state.microsoftAccount&&typeof desktop.continueMicrosoft==='function';
  chooser.close();
  if(useSaved){
   try{await desktop.continueMicrosoft();return;}
   catch(cause){if(!['invalid_grant','invalid_microsoft_token','invalid_session'].includes(cause.code)){chooser.showModal();error(chooser,cause.message);return;}}
  }
  const result=await signInMicrosoft({link:recover?Boolean(state.account&&!chooseOptions.switchAccount):Boolean(chooseOptions.link)});
  if(result&&recover&&state.account&&!state.account.passwordRequired)setup(true);
 }
 chooser.querySelector('.company-microsoft').onclick=()=>void microsoft();
 chooser.querySelector('.company-recover').onclick=()=>void microsoft(true);
 chooser.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(busy)return;
  const form=event.currentTarget,companyId=form.elements.companyId.value.trim(),secret=form.elements.password.value;
  error(chooser,'');lock(true);
  try{await desktop.loginCompany(companyId,secret);chooser.close();}
  catch(cause){error(chooser,cause.message||'Sign-in could not finish. Try again.');form.elements.password.value='';}
  finally{lock(false);render(state);}
 };
 password.querySelector('[name=show]').onchange=event=>{for(const name of ['password','confirm'])password.querySelector('[name='+name+']').type=event.target.checked?'text':'password';};
 password.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(busy)return;
  const form=event.currentTarget,secret=form.elements.password.value;
  if([...secret].length<15||[...secret].length>128){error(password,'Use 15 to 128 characters.');return;}
  if(secret!==form.elements.confirm.value){error(password,'The passwords do not match.');form.elements.confirm.focus();return;}
  error(password,'');lock(true);
  try{await desktop.setCompanyPassword(secret,replacePassword);password.close();}
  catch(cause){error(password,cause.message||'Password could not be saved. Try again.');password.querySelector('.company-verify').hidden=cause.code!=='reauthentication_required';}
  finally{lock(false);}
 };
 password.querySelector('.company-verify').onclick=async()=>{password.close();const ok=await signInMicrosoft({link:true});if(ok)setup(replacePassword);};
 function setup(replace=false){
  if(!state.account||password.open||busy)return;
  if(chooser.open)chooser.close();
  replacePassword=replace;password.querySelector('.company-verify').hidden=true;
  password.querySelector('h2').textContent=replace?'Reset your Company password':'Create your Company password';
  password.querySelector('.company-id').textContent='Your Company ID: '+state.account.id;
  password.showModal();
 }
 function render(next){
  state=next||{};
  if(!state.account){dismissed=null;if(password.open&&!busy)password.close();return;}
  if(state.account.passwordRequired&&dismissed!==state.account.id&&!busy&&!state.accountWorking&&!document.querySelector('#desktop-signin')?.open&&state.startupReady!==false)setup();
 }
 return {render,setup,open(options={}){chooseOptions=options;error(chooser,'');if(!chooser.open&&!busy)chooser.showModal();},async reset(){const ok=await signInMicrosoft({link:true});if(ok)setup(true);}};
}
