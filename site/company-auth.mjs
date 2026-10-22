import {createWaitFeedback} from './wait-feedback.mjs';
// Company credentials cross only the isolated preload and are cleared on close.
// First-time setup runs in a fixed order: the player chooses a username in step 1 and
// the username is claimed together with the first password in step 2, so the password
// step always names the username it is saved against. A Company ID is never asked for,
// shown, or accepted anywhere in this flow.
//
// The verified emails are the one place an address is ever displayed. The list is the
// account service's own record, read through the owner-only profile action when the
// section opens and never cached, so the choice shown is the choice the server holds. Only
// the selected address is a login key; the others are recorded and cannot sign in.
const PROVIDER_NAMES={microsoft:'Microsoft',xbox:'Xbox',discord:'Discord',steam:'Steam',google:'Google',email:'Email'};
const providerName=value=>{
 const key=String(value||'').trim().toLowerCase();
 return PROVIDER_NAMES[key]||(key?key[0].toUpperCase()+key.slice(1):'Verified');
};
const NO_EMAILS='No verified email is recorded for this account. Sign in with a linked provider or with your username.';
const NO_LOGIN_EMAIL='No login email is selected. Sign in with a linked provider or with your username.';
export function createCompanyAuth({desktop,signInMicrosoft,onEmails=null,onInlineError=null}){
 let providerAvailabilityState=null,providerPending=false;
 const providerCancellable=()=>providerPending&&!['company-signing-in','company-waking','account-working'].includes(state.activity?.stage);
 let state={},busy=false,dismissed=null,pendingUsername=null,replacePassword=false,advancing=false;
 const chooser=document.createElement('dialog'),username=document.createElement('dialog'),password=document.createElement('dialog'),emails=document.createElement('dialog');
 for(const dialog of [chooser,username,password])dialog.className='desktop-company-dialog';
 chooser.id='desktop-company-signin';username.id='desktop-company-username';password.id='desktop-company-password';
 chooser.setAttribute('aria-labelledby','company-signin-title');username.setAttribute('aria-labelledby','company-username-title');password.setAttribute('aria-labelledby','company-password-title');
 chooser.innerHTML='<button class="dialog-close" type="button" aria-label="Close account sign-in">×</button><h2 id="company-signin-title">Easter Company account</h2><button type="button" class="company-microsoft">Sign in with Microsoft</button><p class="company-provider-note">Please sign up using an existing online account provider, and then create an Easter Company account username &amp; password.</p><form><label>Username or Email<input name="identifier" autocomplete="username" maxlength="254" required spellcheck="false"></label><label>Password<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label><div class="company-error" role="alert" hidden></div><button type="submit" class="company-submit">Sign in</button><button type="button" class="company-recover text-link">Forgot your password?</button></form>';
 username.innerHTML='<button class="dialog-close" type="button" aria-label="Close username setup">×</button><h2 id="company-username-title">Choose your Easter Company username</h2><p class="company-step">Step 1 of 2</p><form><label>Username<input name="username" autocomplete="username" maxlength="20" required spellcheck="false" aria-describedby="company-username-help"></label><p id="company-username-help">This is the name you sign in with, and it cannot be changed later. Use 3–20 characters: letters, numbers, underscores or dashes. Capitals are saved as lowercase.</p><p class="company-error" role="alert" hidden></p><button type="submit" class="company-submit">Continue</button></form>';
 password.innerHTML='<button class="dialog-close" type="button" aria-label="Close password setup">×</button><h2 id="company-password-title">Create your Easter Company password</h2><p class="company-step">Step 2 of 2</p><p class="company-username"></p><p class="company-intro">Use your username or email and password to sign in directly next time.</p><form><label>New password<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required aria-describedby="company-password-help"></label><p id="company-password-help">Use 8–128 characters. A long passphrase works well.</p><label>Confirm password<input name="confirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><label class="company-show"><input type="checkbox" name="show">Show passwords</label><p class="company-error" role="alert" hidden></p><button type="submit" class="company-submit">Save password</button><button type="button" class="company-verify text-link" hidden>Verify with Microsoft</button></form>';
 // The verified emails section. The list renders whatever the account service reports, so
 // a provider that does not exist yet needs no new code here. Only the selected address is
 // a login key, and that is said in the section itself rather than implied.
 emails.className='desktop-company-dialog';emails.id='desktop-company-emails';
 emails.setAttribute('aria-labelledby','company-emails-title');
 emails.innerHTML='<button class="dialog-close" type="button" aria-label="Close verified emails">×</button><h2 id="company-emails-title">Verified emails</h2><p class="company-intro">Choose the address that signs you in to Easter Company. Only the selected address is a login key; the other addresses are recorded on your account and cannot be used to sign in.</p><div class="company-emails" role="radiogroup" aria-label="Verified emails"></div><p class="company-emails-loading" role="status">Reading your verified emails…</p><p class="company-emails-empty" hidden></p><p class="company-emails-unset" hidden></p><p class="company-error" role="alert" hidden></p><p class="company-status" role="status"></p><div class="company-email-actions"><button type="button" class="company-submit">Save selection</button><button type="button" class="company-clear text-link" hidden>Clear login email</button></div>';
 document.body.append(chooser,username,password,emails);
 const waits=new Map();
 for(const dialog of [chooser,username,password,emails]){
  const node=document.createElement('p');node.className='company-wait';
  const anchor=dialog.querySelector('.company-submit');anchor.before(node);waits.set(dialog,createWaitFeedback(node));
 }
 let localWait=null;
 const waitFor=(dialog,message)=>{localWait={dialog,message,startedAt:Date.now()};waits.get(dialog).set(localWait);};
 const endWait=dialog=>{waits.get(dialog).clear();if(localWait?.dialog===dialog)localWait=null;};
 // A refusal painted into a dialog that is already open is painted where the player is not
 // looking. The chooser is taller than a phone's window, so at 390 the third line of the
 // identity conflict landed under the dialog's own bottom edge while the dialog sat at
 // scrollTop 0, and nothing on screen says the box scrolls: the way out read as a sentence cut
 // off mid-word. The refusal stays above the form, where it is read before the controls, and
 // the dialog scrolls to it instead — the least it can scroll for the whole refusal to be
 // inside the box. At 390 that is the three lines read in full with the heading still above
 // them, and Sign in and Forgot your password below the fold, which is the order a refusal is
 // read in. A refusal taller than the box is read from its first line. A dialog that can show
 // the whole refusal at once is not scrolled at all — at 800x600 it no longer can, because
 // Google, Steam and Discord sit above the form and the chooser scrolls there whether or not a
 // refusal is painted (doc/launcher-states.md, *A chooser may scroll when the window is
 // short*) — and a dialog with no refusal opens at the top.
 const reveal=(dialog,node)=>{
  const box=dialog.getBoundingClientRect(),rect=node.getBoundingClientRect();
  const top=box.top+dialog.clientTop,bottom=top+dialog.clientHeight;
  if(rect.height>=dialog.clientHeight)dialog.scrollTop-=top-rect.top;
  else if(rect.bottom>bottom)dialog.scrollTop+=rect.bottom-bottom;
  else if(rect.top<top)dialog.scrollTop-=top-rect.top;
 };
 // A sentence in one of these dialogs is that failure's only home: the page notice gives up
 // its copy rather than showing the same failure twice. A closed dialog holds no text the
 // player can see, so it never takes the failure away from the notice.
 //
 // A refusal that is really three answers arrives as an array and is drawn as one line each:
 // the sentence itself, then what did not happen, then what to do about it. One 55-word
 // paragraph is where a player stops reading. The slot stays one alert, so assistive
 // technology reads it once, in order. A single sentence stays a single text node, which is
 // what every other dialog's slot is.
 window.addEventListener('resize',()=>{
  for(const dialog of [chooser,username,password,emails]){
   const notice=dialog.querySelector('.company-error');
   if(dialog.open&&notice&&!notice.hidden)reveal(dialog,notice);
  }
 });
 const error=(dialog,lines)=>{
  const shown=(Array.isArray(lines)?lines:[lines]).filter(line=>typeof line==='string'&&line.trim());
  if(shown.length&&dialog.open&&typeof onInlineError==='function')onInlineError();
  const node=dialog.querySelector('.company-error');
  if(shown.length===1)node.textContent=shown[0];
  else node.replaceChildren(...shown.map(line=>{const paragraph=document.createElement('p');paragraph.textContent=line;return paragraph;}));
  node.hidden=!shown.length;
  if(shown.length&&dialog.open)reveal(dialog,node);
 };
 const lock=value=>{busy=value;if(value&&!localWait){const dialog=[chooser,username,password,emails].find(item=>item.open);if(dialog)waitFor(dialog,dialog===username?'Checking your username…':dialog===password?'Saving your password…':dialog===emails?'Saving your email selection…':'Signing in to Easter Company…');}if(!value&&localWait)endWait(localWait.dialog);for(const dialog of [chooser,username,password,emails]){for(const button of dialog.querySelectorAll('.company-submit,.company-microsoft,.company-provider'))button.setAttribute('aria-busy',String(value&&dialog.open));for(const input of dialog.querySelectorAll('input,button'))input.disabled=value;}if(!value&&providerAvailabilityState)for(const button of chooser.querySelectorAll('[data-provider]'))button.disabled=!providerAvailabilityState.includes(button.dataset.provider);chooser.querySelector('.company-submit').textContent=value?'Signing in…':'Sign in';username.querySelector('.company-submit').textContent=value?'Checking…':'Continue';password.querySelector('.company-submit').textContent=value?'Saving…':'Save password';emails.querySelector('.company-submit').textContent=value?'Saving…':'Save selection';};
 // A username the server rejects is a plain sentence beside the field, never a hint
 // about any other account: taken and policy are the only two answers there are.
 const usernamePolicy='Use 3 to 20 characters: letters, numbers, underscores or dashes. Capitals become lowercase.';
 const usernameTaken='That username is already taken. Try another.';
 const checkUsername=typeof desktop.checkCompanyUsername==='function'?desktop.checkCompanyUsername.bind(desktop):null;
 // Capitals are converted as they are typed rather than refused on submit: the help text
 // says they are saved as lowercase, and the field shows that immediately. The caret is
 // kept where it was, so folding mid-word does not jump the cursor to the end.
 const usernameField=username.querySelector('[name=username]');
 usernameField.addEventListener('input',()=>{
  const at=usernameField.selectionStart,typed=usernameField.value,folded=typed.toLowerCase();
  if(typed===folded)return;
  usernameField.value=folded;
  if(typeof at==='number')usernameField.setSelectionRange(at,at);
 });
 for(const dialog of [chooser,username,password]){
  dialog.querySelector('.dialog-close').onclick=()=>{if(dialog===chooser&&providerPending){if(providerCancellable())void desktop.cancelSignIn();return;}if(!busy)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(busy){event.preventDefault();if(dialog===chooser&&providerCancellable())void desktop.cancelSignIn();}});
  dialog.addEventListener('close',()=>{dialog.querySelector('form').reset();for(const input of dialog.querySelectorAll('input[name=password],input[name=confirm]'))input.type='password';error(dialog,'');if(dialog!==chooser)dismissed=state.account?.id;
   // Step 1 is the choice; closing it forgets it. Step 2 keeps the username from step 1
   // so a dismissal answers the same question rather than starting the flow over, and a
   // step that moved the player on keeps it too.
   if(dialog===username){if(!advancing)pendingUsername=null;advancing=false;}});
 }
 // ---- Verified emails --------------------------------------------------------
 // One address at a time, and the account service's answer is the only thing on screen:
 // the list is re-read on every open, so what the player sees is the record they hold
 // rather than anything this launcher remembered. Only the selected address is a login
 // key, and both the section's own copy and each row's own note say so.
 const emailNodes={list:emails.querySelector('.company-emails'),intro:emails.querySelector('.company-intro'),loading:emails.querySelector('.company-emails-loading'),empty:emails.querySelector('.company-emails-empty'),unset:emails.querySelector('.company-emails-unset'),save:emails.querySelector('.company-submit'),clear:emails.querySelector('.company-clear'),status:emails.querySelector('.company-status')};
 emailNodes.empty.textContent=NO_EMAILS;emailNodes.unset.textContent=NO_LOGIN_EMAIL;
 let emailState={loaded:false,emails:[],loginEmail:null},emailFailure=null,emailBusy=false,emailAccount=null;
 function publishEmails(){
  if(typeof onEmails!=='function')return;
  // The profile menu never carries the address. Owen's rule of 2026-10-22: a streamer
 // must be able to open their own profile on screen without showing an email to the
 // audience, so the menu line says only whether a login email is set; the address itself
 // lives in the Verified emails dialog, which the player opens on purpose.
 onEmails(state.account?{id:emailAccount,emails:emailState.emails,loginEmail:emailState.loginEmail,error:emailFailure,line:emailFailure||(emailState.loginEmail?null:emailState.emails.length?NO_LOGIN_EMAIL:NO_EMAILS)}:null);
 }
 // Saving is only offered when there is a choice to save: no row selected, and the row the
 // service already calls its login email, both mean there is nothing to send.
 function syncSave(){
  const chosen=emailNodes.list.querySelector('input[name=email]:checked');
  emailNodes.save.disabled=emailBusy||!chosen||chosen.value===emailState.loginEmail;
 }
 function paintEmails(){
  const rows=emailState.emails,listed=!emailFailure&&rows.length>0;
  emailNodes.list.replaceChildren();
  emailNodes.intro.hidden=!listed;
  // The three information states are exclusive: a list, "none recorded", or "not known".
  // Nothing suggests an address exists when it does not, and a list that could not be
  // read never pretends the account has none.
  emailNodes.empty.hidden=Boolean(emailFailure)||!emailState.loaded||rows.length>0;
  emailNodes.unset.hidden=Boolean(emailFailure)||!rows.length||Boolean(emailState.loginEmail);
  emailNodes.list.hidden=!listed;
  emailNodes.save.hidden=Boolean(emailFailure)||!rows.length;
  emailNodes.clear.hidden=Boolean(emailFailure)||!emailState.loginEmail;
  for(const entry of rows){
   const label=document.createElement('label');label.className='company-email';
   const radio=document.createElement('input');radio.type='radio';radio.name='email';radio.value=entry.email;radio.checked=entry.login===true;
   const address=document.createElement('span');address.className='company-email-address';address.textContent=entry.email;
   // The note says what this address is for: the marked one signs the player in, the
   // others are recorded and are not login keys.
   const meta=document.createElement('small');meta.className='company-email-meta';meta.textContent=providerName(entry.provider)+(entry.login?' · signs you in':' · recorded, not a login key');
   label.append(radio,address,meta);
   radio.onchange=()=>{error(emails,'');emailNodes.status.textContent='';if(!emailBusy)syncSave();};
   emailNodes.list.append(label);
  }
  syncSave();
  publishEmails();
 }
 function showEmails(list){
  const found=list&&typeof list==='object'?list:{};
  emailState={loaded:true,emails:Array.isArray(found.emails)?found.emails:[],loginEmail:typeof found.loginEmail==='string'?found.loginEmail:null};
  emailFailure=null;error(emails,'');paintEmails();
 }
 function failEmails(message){
  emailFailure=message||'Your verified emails could not be read.';
  emailState={loaded:false,emails:[],loginEmail:null};paintEmails();error(emails,emailFailure);
 }
 async function loadEmails(){
  const fetcher=typeof desktop.profileEmails==='function'?desktop.profileEmails.bind(desktop):null;
  if(!fetcher||!state.account){failEmails('This launcher build cannot read your verified emails.');return null;}
  emailAccount=state.account.id;
  emailNodes.loading.hidden=true;waitFor(emails,'Reading your verified emails…');
  try{const found=await fetcher();showEmails(found);return found;}
  catch(cause){failEmails(cause&&cause.message);return null;}
  finally{emailNodes.loading.hidden=true;endWait(emails);}
 }
 async function saveLoginEmail(address){
  if(emailBusy)return;
  const select=typeof desktop.selectLoginEmail==='function'?desktop.selectLoginEmail.bind(desktop):null;
  if(!select){error(emails,'This launcher build cannot change your login email.');return;}
  emailBusy=true;emailNodes.status.textContent='';lock(true);
  try{
   const outcome=await select(address);
   if(outcome&&outcome.ok===false){
    // A refused address is reported as one unavailable address, and the selection the
    // service already has stays exactly where it was and still marked. This is not a
    // failed sign-in and is never worded as one.
    error(emails,outcome.error||'That address could not be saved. Try again.');
    paintEmails();
   }else{
    showEmails(outcome&&outcome.value?outcome.value:await loadEmails());
    // One event, one sentence. The main process notifies the same clearing with the same
    // words (desktop/main.cjs, selectLoginEmail) and that notice is held until this dialog
    // closes, so the player reads both surfaces for one click; they must not disagree. It
    // says "a linked provider" and not Microsoft because the chooser behind the cleared
    // email offers Microsoft, Google, Steam and Discord (doc/launcher-states.md, *Provider
    // account state*), the same reason the signed-out hero dropped the provider's name.
    emailNodes.status.textContent=address===null?'Your login email is cleared. Sign in with a linked provider or with your username.':'Your login email is saved.';
   }
  }
  catch(cause){
   error(emails,(cause&&cause.message)||'That address could not be saved. Try again.');
   paintEmails();
  }
  finally{emailBusy=false;lock(false);paintEmails();}
 }
 emailNodes.save.onclick=()=>{const chosen=emailNodes.list.querySelector('input[name=email]:checked');if(chosen)void saveLoginEmail(chosen.value);};
 emailNodes.clear.onclick=()=>{void saveLoginEmail(null);};
 emails.querySelector('.dialog-close').onclick=()=>{if(!emailBusy)emails.close();};
 emails.addEventListener('cancel',event=>{if(emailBusy)event.preventDefault();});
 emails.addEventListener('close',()=>{endWait(emails);error(emails,'');emailNodes.status.textContent='';emailNodes.loading.hidden=true;});
 // Opening the profile asks for the list; a bridge without the action has nothing to ask,
 // so the line simply stays out of the way rather than claiming a failure.
 async function refreshEmails(){
  if(emailBusy||!state.account||typeof desktop.profileEmails!=='function')return null;
  return loadEmails();
 }
 async function openEmails(){
  if(emailBusy||emails.open||!state.account)return;
  error(emails,'');emailNodes.status.textContent='';emails.showModal();
  await loadEmails();
 }
 let chooseOptions={},recovering=false;
 // The one refusal in this flow that stops it. `identity_conflict` means the Microsoft
 // account the player just used belongs to a different Easter Company account, so there is
 // nothing to fall through to: completing a fresh sign-in would replace the account they
 // are signed in to, which is the opposite of an answer.
 //
 // The code decides that, and a code cannot cross the isolated world inside a thrown Error,
 // which is why the saved-session shortcut answers with its whole result ({ok, value} or
 // {ok:false, error, code}); a bridge that still throws is read the same way rather than
 // being ignored. The sentence itself is the account service's own, carried on the failure
 // (desktop/accounts.cjs MESSAGES.identity_conflict, and the same wording whether the
 // launcher or the service noticed the conflict). The fallback below is only for a build
 // that answers with no sentence at all.
 const IDENTITY_CONFLICT='This provider belongs to a different Easter Company account.';
 // What that sentence leaves unsaid and the player needs, one line each rather than one
 // paragraph: their account is untouched, and then the way out. The way out starts by closing
 // this dialog, because that is not a detail — the profile it names is behind a modal dialog, so
 // its Logout entry cannot be pressed until this window is gone, and the launcher has one
 // account: signing in again while signed in is refused until the player signs out. Neither
 // line names an account, an address or a Company ID.
 const IDENTITY_CONFLICT_UNCHANGED='Nothing on your Easter Company account has changed.';
 const IDENTITY_CONFLICT_NEXT='Close this window first. Sign out from your profile before signing in to a different account.';
 const identityConflictCopy=sentence=>{
  const own=typeof sentence==='string'&&sentence.trim()?sentence.trim():IDENTITY_CONFLICT;
  return [own,IDENTITY_CONFLICT_UNCHANGED,IDENTITY_CONFLICT_NEXT];
 };
 // The saved-session shortcut, answered as one result the renderer can read.
 const continueSaved=async()=>{
  try{const answer=await desktop.continueMicrosoft();return answer&&typeof answer==='object'?answer:{ok:true,value:answer};}
  catch(cause){return {ok:false,error:cause&&cause.message,code:cause&&cause.code};}
 };
 // The conflict refusal, whichever path asked. It used to be painted only by the
 // saved-session shortcut, so the same refusal arriving through the interactive sign-in
 // fell back to a single sentence on the page notice — and which path a click took
 // depended on whether this launcher currently believed it held a Microsoft session.
 // One refusal, one copy, one surface.
 function conflict(sentence){
  const lines=identityConflictCopy(sentence);
  if(!chooser.open){error(chooser,'');chooser.showModal();}
  error(chooser,lines);
 }
 async function microsoft(recover=false){
  if(busy)return;
  const useSaved=!recover&&state.microsoftAccount&&typeof desktop.continueMicrosoft==='function';
  chooser.close();
  // The saved Microsoft session is a shortcut, never a dead end. Every failure of it falls
  // through to the fresh interactive sign-in that shows the device code and the browser
  // action, with exactly one stop: an identity conflict means the player must choose the
  // Microsoft account linked to this Easter Company account, and nobody else can do that.
  // Anything else — an expired, invalid or unreachable saved session included — is the
  // shortcut failing rather than the sign-in, so the player still gets the code that the
  // Forgot your password path already gives them.
  if(useSaved){
   chooser.showModal();waitFor(chooser,'Connecting your saved Microsoft account…');lock(true);
   let answer;try{answer=await continueSaved();}finally{lock(false);chooser.close();render(state);}
   if(!answer||answer.ok!==false)return;
   if(answer.code==='identity_conflict'){
    // Identity conflict is the one stop: the player has to choose the Microsoft account linked
    // to this Easter Company account, so the chooser comes back carrying that sentence and
    // nothing else opens. No device code, no second sign-in, and the account stays as it was.
    // Choosing Microsoft closed the chooser, and its own close handler runs as a task after
    // this answer arrives, so the dialog is reopened once that task has run rather than
    // racing the reset it does.
    await new Promise(resolve=>setTimeout(resolve,0));
    conflict(answer.error);return;
   }
  }
  const result=await signInMicrosoft({link:recover?Boolean(state.account):Boolean(chooseOptions.link)});
  if(result&&recover&&state.account&&!state.account.passwordRequired)setup(true);
 }
 chooser.querySelector('.company-microsoft').onclick=()=>void microsoft(recovering);
 const recoveryNote=document.createElement('p');recoveryNote.className='company-recovery-note';recoveryNote.hidden=true;chooser.querySelector('.company-provider-note').after(recoveryNote);
 const providerButtons=[];
 for(const provider of ['google','steam','discord']){
  const button=document.createElement('button');button.type='button';button.className='company-provider';button.dataset.provider=provider;button.textContent='Sign in with '+providerName(provider);
  chooser.querySelector('.company-provider-note').before(button);providerButtons.push(button);
  button.onclick=async()=>{
   if(busy)return;error(chooser,'');providerPending=true;let completed=false;waitFor(chooser,'Complete sign-in in your browser…');lock(true);chooser.querySelector('.dialog-close').disabled=false;
   try{
    const outcome=await desktop.signInProvider(provider,Boolean(state.account));
    if(outcome?.ok===false)error(chooser,outcome.error||'Sign-in could not finish.');
    else{chooser.close();completed=true;}
   }catch(cause){error(chooser,cause.message||'Sign-in could not finish.');}
   finally{providerPending=false;lock(false);render(state);if(completed&&recovering&&!state.account?.passwordRequired)setup(true);}
  };
 }
 async function providerAvailability(){
  if(typeof desktop.accountProviders!=='function')return;
  try{const found=await desktop.accountProviders();providerAvailabilityState=found.providers||[];for(const button of providerButtons){const available=found.providers?.includes(button.dataset.provider);button.disabled=busy||!available;button.title=available?'':'This provider is not configured.';}}
  catch{providerAvailabilityState=[];for(const button of providerButtons){button.disabled=true;button.title='Provider availability could not be checked.';}}
 }
 chooser.querySelector('.company-recover').onclick=()=>{
  recovering=true;recoveryNote.hidden=false;recoveryNote.textContent='Choose a provider already linked to your account, then set a new Easter Company password.';chooser.querySelector('form').hidden=true;
  for(const button of providerButtons)button.hidden=Boolean(state.account)&&!state.account.providers?.includes(button.dataset.provider);
 };
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
  // One canonical value: the field is folded as it is typed (below) and again here, so a
  // capital can never reach the server as a reason to refuse a name the player chose.
  const chosen=event.currentTarget.elements.username.value.trim().toLowerCase();
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
  if([...secret].length<8||[...secret].length>128){error(password,'Use 8 to 128 characters.');return;}
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
 password.querySelector('.company-verify').textContent='Verify with a linked provider';
 password.querySelector('.company-verify').onclick=()=>{password.close();openRecovery();};
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
  if(localWait&&(state.activity?.stage==='company-waking'||providerPending&&state.activity))waits.get(localWait.dialog).set({...state.activity,startedAt:localWait.startedAt});
  if(providerPending)chooser.querySelector('.dialog-close').disabled=!providerCancellable();
  if(!state.account){
   dismissed=null;pendingUsername=null;if(!busy)for(const dialog of [username,password])if(dialog.open)dialog.close();
   // The verified emails belong to one account. Leaving it closes the section and forgets
   // the list, because the list was only ever a read of that account's own record.
   emailState={loaded:false,emails:[],loginEmail:null};emailFailure=null;emailAccount=null;if(!emailBusy&&emails.open)emails.close();paintEmails();
   return;
  }
  if(!state.account.passwordRequired||dismissed===state.account.id)return;
  if(busy||state.accountWorking||state.startupReady===false)return;
  if(password.open||username.open||chooser.open||document.querySelector('#desktop-signin')?.open)return;
  // An account that already has a username is only ever asked for its password.
  if(state.account.username)setup();else openUsername();
 }
 function openChoice(options={}){
  chooseOptions=options;recovering=false;recoveryNote.hidden=true;chooser.querySelector('form').hidden=false;for(const button of providerButtons)button.hidden=false;
  error(chooser,'');if(!chooser.open&&!busy)chooser.showModal();void providerAvailability();
 }
 function openRecovery(){openChoice({link:Boolean(state.account)});chooser.querySelector('.company-recover').click();}
 return {render,setup,open:openChoice,reset:openRecovery,emails:openEmails,refreshEmails,conflict};
}
