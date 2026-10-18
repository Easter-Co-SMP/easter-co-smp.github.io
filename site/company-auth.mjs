// Company credentials cross only the isolated preload and are cleared on close.
// First-time setup runs in a fixed order: the player chooses a username in step 1 and
// the username is claimed together with the first password in step 2, so the password
// step always names the username it is saved against. A Company ID is never asked for,
// shown, or accepted anywhere in this flow.
export function createCompanyAuth({desktop,signInMicrosoft}){
 let state={},busy=false,dismissed=null,pendingUsername=null,replacePassword=false,advancing=false;
 const chooser=document.createElement('dialog'),username=document.createElement('dialog'),password=document.createElement('dialog');
 for(const dialog of [chooser,username,password])dialog.className='desktop-company-dialog';
 chooser.id='desktop-company-signin';username.id='desktop-company-username';password.id='desktop-company-password';
 chooser.setAttribute('aria-labelledby','company-signin-title');username.setAttribute('aria-labelledby','company-username-title');password.setAttribute('aria-labelledby','company-password-title');
 chooser.innerHTML='<button class="dialog-close" type="button" aria-label="Close account sign-in">×</button><h2 id="company-signin-title">Easter Company account</h2><button type="button" class="company-microsoft">Login with Microsoft Account</button><p class="company-provider-note">Please sign up using an existing online account provider, and then create an Easter Company account username &amp; password.</p><form><label>Username or Email<input name="identifier" autocomplete="username" maxlength="254" required spellcheck="false"></label><label>Password<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label><p class="company-error" role="alert" hidden></p><button type="submit" class="company-submit">Sign in</button><button type="button" class="company-recover text-link">Forgot your password?</button></form>';
 username.innerHTML='<button class="dialog-close" type="button" aria-label="Close username setup">×</button><h2 id="company-username-title">Choose your Easter Company username</h2><p class="company-step">Step 1 of 2</p><form><label>Username<input name="username" autocomplete="username" maxlength="20" required spellcheck="false" aria-describedby="company-username-help"></label><p id="company-username-help">This is the name you sign in with, and it cannot be changed later. Use 3–20 characters: lowercase letters, numbers, underscores or dashes.</p><p class="company-error" role="alert" hidden></p><button type="submit" class="company-submit">Continue</button></form>';
 password.innerHTML='<button class="dialog-close" type="button" aria-label="Close password setup">×</button><h2 id="company-password-title">Create your Easter Company password</h2><p class="company-step">Step 2 of 2</p><p class="company-username"></p><p class="company-intro">Use your username or email and password to sign in directly next time.</p><form><label>New password<input name="password" type="password" minlength="15" maxlength="128" autocomplete="new-password" required aria-describedby="company-password-help"></label><p id="company-password-help">Use 15–128 characters. A long passphrase works well.</p><label>Confirm password<input name="confirm" type="password" minlength="15" maxlength="128" autocomplete="new-password" required></label><label class="company-show"><input type="checkbox" name="show">Show passwords</label><p class="company-error" role="alert" hidden></p><button type="submit" class="company-submit">Save password</button><button type="button" class="company-verify text-link" hidden>Verify with Microsoft</button></form>';
 document.body.append(chooser,username,password);
 const error=(dialog,message)=>{const node=dialog.querySelector('.company-error');node.textContent=message;node.hidden=!message;};
 const lock=value=>{busy=value;for(const dialog of [chooser,username,password]){dialog.setAttribute('aria-busy',String(value));for(const input of dialog.querySelectorAll('input,button'))input.disabled=value;}chooser.querySelector('.company-submit').textContent=value?'Signing in…':'Sign in';username.querySelector('.company-submit').textContent=value?'Checking…':'Continue';password.querySelector('.company-submit').textContent=value?'Saving…':'Save password';};
 // A username the server rejects is a plain sentence beside the field, never a hint
 // about any other account: taken and policy are the only two answers there are.
 const usernamePolicy='Use 3 to 20 characters: lowercase letters, numbers, underscores or dashes.';
 const usernameTaken='That username is already taken. Try another.';
 const checkUsername=typeof desktop.checkCompanyUsername==='function'?desktop.checkCompanyUsername.bind(desktop):null;
 for(const dialog of [chooser,username,password]){
  dialog.querySelector('.dialog-close').onclick=()=>{if(!busy)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{dialog.querySelector('form').reset();for(const input of dialog.querySelectorAll('input[name=password],input[name=confirm]'))input.type='password';error(dialog,'');if(dialog!==chooser)dismissed=state.account?.id;
   // Step 1 is the choice; closing it forgets it. Step 2 keeps the username from step 1
   // so a dismissal answers the same question rather than starting the flow over, and a
   // step that moved the player on keeps it too.
   if(dialog===username){if(!advancing)pendingUsername=null;advancing=false;}});
 }
 let chooseOptions={};
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
  const form=event.currentTarget,identifier=form.elements.identifier.value.trim(),secret=form.elements.password.value;
  if(!identifier){error(chooser,'Enter your username or email.');return;}
  error(chooser,'');lock(true);
  try{
   const outcome=await desktop.loginCompany(identifier,secret);
   if(outcome&&outcome.ok===false)error(chooser,outcome.error||'Sign-in could not finish. Try again.');
   else chooser.close();
  }
  catch(cause){error(chooser,cause.message||'Sign-in could not finish. Try again.');}
  finally{lock(false);if(chooser.open)form.elements.password.value='';render(state);}
 };
 // Step 1: choose the username. The availability answer is asked for here, before the
 // player is asked for a password, so a taken name is not discovered at the end.
 function openUsername(message='',value=''){
  if(busy||username.open)return;
  if(chooser.open)chooser.close();if(password.open)password.close();
  username.querySelector('[name=username]').value=value||pendingUsername||'';
  error(username,message);username.showModal();username.querySelector('[name=username]').focus?.();
 }
 username.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(busy)return;
  const chosen=event.currentTarget.elements.username.value.trim();
  if(!/^[a-z0-9_-]{3,20}$/.test(chosen)){error(username,usernamePolicy);return;}
  error(username,'');lock(true);
  let verdict=null;
  try{
   if(!checkUsername)verdict={ok:true,value:{available:true}};
   else{
    const outcome=await checkUsername(chosen);
    verdict=outcome&&outcome.ok===false?{ok:false,message:outcome.error}:{ok:true,value:outcome?outcome.value:null};
   }
  }
  catch(cause){error(username,cause.message||'That username could not be checked. Try again.');}
  finally{lock(false);}
  if(!verdict)return;
  if(verdict.ok===false){error(username,verdict.message||usernameTaken);return;}
  const answer=verdict.value||{available:true};
  if(answer.available===true){advancing=true;pendingUsername=chosen;username.close();setup();return;}
  error(username,(answer.available===false&&answer.message)||usernameTaken);
 };
 password.querySelector('[name=show]').onchange=event=>{for(const name of ['password','confirm'])password.querySelector('[name='+name+']').type=event.target.checked?'text':'password';};
 // Step 2: the password, saved together with the username from step 1. A race the
 // availability answer could not see comes back as a taken username, and the flow walks
 // back to step 1 with the name the player typed still in the field.
 password.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(busy)return;
  const form=event.currentTarget,secret=form.elements.password.value,claimed=pendingUsername;
  if([...secret].length<15||[...secret].length>128){error(password,'Use 15 to 128 characters.');return;}
  if(secret!==form.elements.confirm.value){error(password,'The passwords do not match.');form.elements.confirm.focus();return;}
  error(password,'');lock(true);
  let walkBack=null;
  try{
   const outcome=await desktop.setCompanyPassword(secret,replacePassword,claimed||undefined);
   if(!outcome||outcome.ok!==false){pendingUsername=null;password.close();}
   else{
    const code=outcome.code,message=outcome.error;
    if(code==='username_taken'||code==='username_policy')walkBack={message:message||(code==='username_taken'?usernameTaken:usernamePolicy),value:claimed||''};
    else{
     error(password,message||'Password could not be saved. Try again.');
     password.querySelector('.company-verify').hidden=code!=='reauthentication_required';
    }
   }
  }
  catch(cause){
   error(password,cause.message||'Password could not be saved. Try again.');
   password.querySelector('.company-verify').hidden=true;
  }
  finally{lock(false);}
  // The race the step-1 answer could not see: step 1 comes back with the name kept.
  if(walkBack){pendingUsername=walkBack.value;password.close();openUsername(walkBack.message,walkBack.value);}
 };
 password.querySelector('.company-verify').onclick=async()=>{password.close();const ok=await signInMicrosoft({link:true});if(ok)setup(replacePassword);};
 function setup(replace=false){
  if(!state.account||password.open||busy)return;
  // A player who still has to choose a username starts at step 1, whichever action
  // reached here: the username is never skipped and never asked for out of order.
  if(!replace&&!pendingUsername&&!state.account.username){openUsername();return;}
  if(chooser.open)chooser.close();if(username.open)username.close();
  replacePassword=replace;password.querySelector('.company-verify').hidden=true;
  const named=replace?'':pendingUsername||state.account.username||'';
  password.querySelector('h2').textContent=replace?'Reset your Easter Company password':'Create your Easter Company password';
  // The step count is shown exactly when the username step led here, so a resumed
  // setup or a password change never claims to be step two of a two-step flow.
  password.querySelector('.company-step').hidden=!(pendingUsername&&!replace);
  password.querySelector('.company-username').textContent=named?'Your username: '+named:'';
  password.querySelector('.company-username').hidden=!named;
  password.showModal();
 }
 function render(next){
  state=next||{};
  if(!state.account){dismissed=null;pendingUsername=null;if(!busy)for(const dialog of [username,password])if(dialog.open)dialog.close();return;}
  if(!state.account.passwordRequired||dismissed===state.account.id)return;
  if(busy||state.accountWorking||state.startupReady===false)return;
  if(password.open||username.open||chooser.open||document.querySelector('#desktop-signin')?.open)return;
  // An account that already has a username is only ever asked for its password.
  if(state.account.username)setup();else openUsername();
 }
 return {render,setup,open(options={}){chooseOptions=options;error(chooser,'');if(!chooser.open&&!busy)chooser.showModal();},async reset(){const ok=await signInMicrosoft({link:true});if(ok)setup(true);}};
}
