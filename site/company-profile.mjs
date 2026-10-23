import {PASSWORD_POLICY} from './company-auth.mjs';
import {createWaitFeedback} from './wait-feedback.mjs';
// The signed-in account has two surfaces, named by Owen on 2026-10-22: My Profile holds what the
// player is called, their picture, their verified emails and their password; Linked Accounts
// holds the providers this account plays through. The menu entry list in site/desktop.js opens one
// dialog each, so neither surface can imply the other holds something it does not
// (doc/launcher-states.md, *The profile menu*). Owen had the Minecraft session section taken off
// Linked Accounts on 2026-10-23 ("Let's remove the bottom 'Minecraft session' section please"),
// and only the surface went: the launcher can still end the stored session —
// `window.easterDesktop.signOutMinecraft()` and the main-process revoke path behind it are
// untouched — but no surface offers it, and this file must not draw one again without his word.
const NAMES={microsoft:'Microsoft / Xbox',google:'Google',steam:'Steam',discord:'Discord'};
// What each linked provider's row may show, in the order it is drawn. The values are the
// account's own record of what that provider holds (desktop/accounts.cjs publishes them after
// rebuilding them field by field), so this view checks only that a value is there and never
// decides what a value may be. The Minecraft name is the account's own and is not read from
// the provider: one source, and the one the launcher already trusts.
const DETAILS={
 microsoft:[['Xbox Gamer Tag',(account,detail)=>detail?.gamertag],['Minecraft Username',account=>account.minecraftName]],
 google:[['Gmail',(account,detail)=>detail?.email]],
 steam:[['Username',(account,detail)=>detail?.persona]],
 // Discord carries two names and shows one line: the username, then the display name.
 discord:[['Username',(account,detail)=>detail?.username||detail?.displayName]]
};
const shown=value=>typeof value==='string'&&value.trim()?value.trim():'';
// The furniture both surfaces share: one dialog element, one busy flag, the two message slots and
// the launcher's own account lock. Every control that changes the account carries
// `data-account-change` and answers to that lock; neither surface computes it. site/desktop.js
// owns it, hands it in as `isAccountLocked`, and re-applies it on a broadcast through the returned
// `syncLock`, so a dialog already on screen follows a lock that went on behind it. This is the one
// place a control's disabled state is decided: `busy` is an action already in flight, and
// `data-unavailable` is a reason of the control's own.
function accountSurface({id,title,markup,isAccountLocked,cancelSignIn}){
 const modal=document.createElement('dialog');
 modal.id=id;modal.className='desktop-company-dialog';modal.setAttribute('aria-labelledby',id+'-title');
 modal.innerHTML='<button class="dialog-close" type="button" aria-label="Close '+title+'">×</button><h2 id="'+id+'-title">'+title+'</h2>'+markup;
 document.body.append(modal);modal.showModal();
 const state={busy:false,external:false,paint:null};
 // One slot per kind of sentence, and a refusal that is really two answers (the service's own
 // sentence and what to do about it) is drawn as one line each rather than one paragraph. The
 // slot stays one alert, so assistive technology reads it once, in order.
 const message=(lines,error=false)=>{
  const node=modal.querySelector(error?'.company-error':'.company-status');
  const shownLines=(Array.isArray(lines)?lines:[lines]).filter(line=>typeof line==='string'&&line.trim());
  if(shownLines.length===1)node.textContent=shownLines[0];
  else node.replaceChildren(...shownLines.map(line=>{const paragraph=document.createElement('p');paragraph.textContent=line;return paragraph;}));
  node.hidden=!shownLines.length;
 };
 const applyLock=()=>{
  const locked=isAccountLocked()===true;
  for(const control of modal.querySelectorAll('[data-account-change]'))control.disabled=state.busy||locked||control.dataset.unavailable==='true';
 };
 // The lock is checked on the way in as well as painted on the way out: a control that somehow
 // became pressable while the launcher is authenticating, launching, waking the server or
 // running cannot start an account change either.
 const run=async (action,{external=false,success='Saved.'}={})=>{
  if(state.busy||isAccountLocked())return;
  state.busy=true;state.external=external;message('',true);message('');
  for(const button of modal.querySelectorAll('button'))button.disabled=true;
  if(external)modal.querySelector('.dialog-close').disabled=false;
  try{const result=await action();if(result===false||result?.ok===false)message(result?.error||'This change was not completed.',true);else if(result?.value?.cancelled||result?.cancelled)message('');else message(success);}
  catch(error){message(error&&error.message?error.message:'This change could not be saved.',true);}
  finally{state.external=false;state.busy=false;for(const button of modal.querySelectorAll('button'))button.disabled=false;if(state.paint)state.paint();}
 };
 const close=modal.querySelector('.dialog-close');
 close.onclick=()=>{if(state.external){if(cancelSignIn)void cancelSignIn();return;}if(!state.busy)modal.close();};
 modal.addEventListener('cancel',event=>{if(state.busy||state.external){event.preventDefault();if(state.external&&cancelSignIn)void cancelSignIn();}});
 modal.addEventListener('close',()=>modal.remove(),{once:true});
 return {modal,message,applyLock,run,state,syncLock:()=>{if(modal.open)applyLock();}};
}

// ---- My Profile ------------------------------------------------------------
// The player's own record: the name they are called, the picture they chose, the addresses that
// can sign them in, and their password. Nothing about a provider is on this surface, and the
// address itself is never printed here either - the button opens the section that owns the list
// (site/company-auth.mjs openEmails) rather than this file carrying a second copy of it.
export async function openMyProfile({desktop,getState,isAccountLocked,openEmails,cancelSignIn}){
 if(document.querySelector('#company-profile'))return null;
 const surface=accountSurface({
  id:'company-profile',title:'My Profile',isAccountLocked,cancelSignIn,
  markup:'<p>Your profile can be changed independently of your linked accounts.</p>'
   +'<form data-name-form><label>Display name<input name="displayName" maxlength="64" required autocomplete="nickname"></label><button type="submit" data-account-change>Save name</button></form>'
   +'<div class="company-picture-actions"><button type="button" data-picture="upload" data-account-change>Choose picture</button><button type="button" data-picture="remove" data-account-change>Remove picture</button></div>'
   +'<h3>Verified emails</h3><p class="company-section-note">The addresses that can sign you in to Easter Company. The list is opened on purpose: it is the only place an address is shown.</p>'
   +'<button type="button" data-open-emails data-account-change>Verified emails</button>'
   +'<h3>Password</h3><p class="company-section-note" id="company-password-help">'+PASSWORD_POLICY.help+' You do not need your current password: an active sign-in on this launcher is enough.</p>'
   // The form asks the browser not to validate it: every refusal is a sentence in this surface,
   // read where the player is looking, rather than a browser bubble that vanishes on the next
   // click (the same 8-to-128 rule is applied in the handler below, and the fields keep their
   // own minlength and maxlength for the keyboard hints they give).
   +'<form data-password-form novalidate><label>New password<input name="password" type="password" minlength="'+PASSWORD_POLICY.min+'" maxlength="'+PASSWORD_POLICY.max+'" autocomplete="new-password" required aria-describedby="company-password-help"></label>'
   +'<label>Confirm password<input name="confirm" type="password" minlength="'+PASSWORD_POLICY.min+'" maxlength="'+PASSWORD_POLICY.max+'" autocomplete="new-password" required></label>'
   +'<button type="submit" class="company-submit" data-account-change>Change password</button></form>'
   +'<p class="company-error" role="alert" hidden></p><p class="company-status" role="status"></p>'
 });
 const {modal}=surface;
 function paint(){
  const account=getState()?.account;if(!account){modal.close();return;}
  const field=modal.querySelector('[data-name-form] input');
  if(document.activeElement!==field)field.value=account.name||account.username||'';
  // The rest of this surface - Save name, Choose picture, Remove picture, the verified-emails
  // section and the password form - answers to the same lock. The close control is not an
  // account change and stays available.
  surface.applyLock();
 }
 surface.state.paint=paint;
 paint();
 modal.querySelector('[data-name-form]').onsubmit=event=>{event.preventDefault();void surface.run(()=>desktop.updateProfile(modal.querySelector('[data-name-form] input').value));};
 for(const button of modal.querySelectorAll('[data-picture]'))button.onclick=()=>void surface.run(()=>desktop.setProfilePicture(button.dataset.picture==='remove'));
 // The verified-emails section is its own dialog (site/company-auth.mjs openEmails), and this
 // surface does not stack a second modal over itself: pressing this closes My Profile and opens
 // the section, so there is one dialog on screen at a time and Escape always closes the thing
 // the player is looking at.
 modal.querySelector('[data-open-emails]').onclick=()=>{if(surface.state.busy||isAccountLocked())return;modal.close();if(typeof openEmails==='function')void openEmails();};
 // The password. Owen's rule of 2026-10-22: a player with any active sign-in changes it here
 // without typing the one they have, so this form asks for the new password twice and nothing
 // else. The rule the account service enforces is the rule the form applies (PASSWORD_POLICY,
 // exported by site/company-auth.mjs so the two cannot drift), and both halves of the answer —
 // changed, or refused — are said in this surface rather than implied by it closing.
 const passwordForm=modal.querySelector('[data-password-form]');
 passwordForm.onsubmit=event=>{
  event.preventDefault();
  if(surface.state.busy||isAccountLocked())return;
  const secret=passwordForm.elements.password.value,confirmation=passwordForm.elements.confirm.value;
  const length=[...secret].length;
  if(length<PASSWORD_POLICY.min||length>PASSWORD_POLICY.max){surface.message('Use 8 to 128 characters.',true);passwordForm.elements.password.focus();return;}
  if(secret!==confirmation){surface.message('The passwords do not match.',true);passwordForm.elements.confirm.focus();return;}
  void surface.run(async()=>{
   let outcome;
   try{outcome=await desktop.setCompanyPassword(secret,true);}
   catch(error){return {ok:false,error:error&&error.message?error.message:'Your password could not be changed. Try again.'};}
   if(outcome&&outcome.ok===false){
    const refusal=outcome.error||'Your password could not be changed. Try again.';
    // The account service's own sentence is the whole refusal. Owen's rule of 2026-10-22 is that
    // any active sign-in is enough, so the service no longer answers reauthentication_required and
    // there is no second route to name here; the "sign out and sign in with a linked provider"
    // line that used to follow it described a rule that no longer exists. There is still no
    // password reset anywhere in this launcher (site/company-auth.mjs says so on the sign-in
    // chooser), and a live session is still the only thing that can reach this form.
    return {ok:false,error:refusal};
   }
   passwordForm.reset();
   return {ok:true};
  },{success:'Your password is changed.'});
 };
 return {syncLock:surface.syncLock};
}

// ---- Linked Accounts -------------------------------------------------------
// The providers this account plays through. Nothing about an address or a password is on this
// surface: those belong to My Profile. Nothing about the stored Minecraft session is here either,
// by Owen's decision of 2026-10-23: that section and its control are gone from the surface, and
// the capability behind them (`signOutMinecraft`, desktop/main.cjs's revoke) is kept.
export async function openLinkedAccounts({desktop,getState,signInMicrosoft,isAccountLocked,cancelSignIn}){
 if(document.querySelector('#company-linked-accounts'))return null;
 // The one busy state, in the rows' own place. This surface used to await the providers answer
 // before it drew anything at all, so a cold account API left the dialog open with an empty
 // section and no word about it (measured 2026-10-23: 12 s held, zero rows, zero busy marks,
 // no live region), and the rows that did arrive last offered Connect for providers the
 // launcher had not heard about yet. The wait line stands where the rows will be, so the
 // section is never an empty box and never a blank gap; `createWaitFeedback` is the launcher's
 // own quiet wait - the indeterminate ring in site/desktop.css, a decorative aria-hidden mark
 // beside one sentence in a role=status region - and this dialog adds no look of its own.
 const surface=accountSurface({
  id:'company-linked-accounts',title:'Linked Accounts',isAccountLocked,cancelSignIn,
  markup:'<p>Links stay with this Easter Company account and cannot be removed from the launcher yet. Microsoft / Xbox and Minecraft ownership are required to play Minecraft.</p>'
   +'<p class="company-wait" hidden></p>'
   +'<div class="company-provider-links"></div>'
   +'<p class="company-error" role="alert" hidden></p><p class="company-status" role="status"></p>'
 });
 const {modal}=surface;
 // The one busy state this surface owns, created on the line the markup reserves for it and in the
 // place the rows will arrive. It is the launcher's existing wait - a decorative aria-hidden ring
 // and one sentence in a role=status region, the ring still under reduced motion - so nothing here
 // is a new look and nothing here is announced twice.
 const wait=createWaitFeedback(modal.querySelector('.company-wait'));
 // Three answers, and only the third draws rows:
 //  - `answered` is the providers answer, which is the *availability* question only: which of
 //    Microsoft, Google, Steam and Discord this launcher can offer a Connect for. It is the one
 //    thing this section waits for.
 //  - `failed` is an answer nobody could read: a rejection, a timeout, or a bridge that answered
 //    with nothing. That is reported as one sentence and never as an empty list, which would
 //    read as "nothing is linked".
 //  - everything else in a row - its label, its linked state, its detail lines - is the account
 //    document's own record, which the launcher already holds and this view reads from
 //    getState(). Nothing about a row waits for a read the launcher has already made, and no
 //    Connect is drawn before the availability answer is in.
 let available=null,answered=false,failed=false,closed=false;
 // A wait that finishes after the player closed the dialog has no surface left to report to, and
 // the ring must not keep animating on a removed element.
 modal.addEventListener('close',()=>{closed=true;wait.clear();});
 // The lock is not computed here and there is no list of phases in this file: site/desktop.js
 // owns it, hands it in as `isAccountLocked`, and re-applies it when a broadcast changes it. That
 // this dialog opens only from a locked menu entry, and is modal, is not what keeps these
 // controls unavailable while the game runs.
 function paint(){
  const account=getState()?.account;if(!account){modal.close();return;}
  const list=modal.querySelector('.company-provider-links');list.replaceChildren();
  // No row is drawn until the availability answer is in: a row drawn earlier could only offer a
  // Connect on a guess, and a list drawn from a failed answer would say nothing is linked when
  // the truth is that nobody could read it. The wait line the markup puts just above this list is
  // what stands in the section meanwhile.
  if(!answered||failed){surface.applyLock();return;}
  // A missing or malformed record is no details at all, which renders exactly as the dialog
  // did before this field existed. It is never an error and never a broken row.
  const details=account.providerDetails&&typeof account.providerDetails==='object'&&!Array.isArray(account.providerDetails)?account.providerDetails:null;
  for(const [provider,name] of Object.entries(NAMES)){
   const linked=(account.providers||[]).includes(provider)||(provider==='microsoft'&&account.microsoftLinked);
   const row=document.createElement('div');row.className='company-provider-link';
   const head=document.createElement('div');head.className='company-provider-head';
   const label=document.createElement('span');label.className='company-provider-name';label.textContent=name+(linked?' · linked':'');
   head.append(label);
   // A linked provider is described and not offered. The account service has no unlink route,
   // so a control over an already-linked provider could only ever fail: pressing Verify re-ran
   // the link flow and the API answered "this account is already linked to an Easter Company
   // account" every time. Only an unlinked provider carries Connect, the action that can work.
   if(!linked){
    const button=document.createElement('button');button.type='button';button.textContent='Connect';button.dataset.accountChange='';button.dataset.unavailable=String(Boolean(available&&!available.includes(provider)));button.setAttribute('aria-label','Connect '+name);
    button.onclick=()=>void surface.run(()=>provider==='microsoft'?signInMicrosoft({link:true}):desktop.signInProvider(provider,true),{external:provider!=='microsoft'});
    head.append(button);
   }
   row.append(head);
   // What this provider holds, as labelled lines. A line is drawn only when the value exists:
   // an unlinked provider has no detail block at all, and a linked one with nothing known
   // draws no line - never a label with no value, a colon on its own, a brace, a placeholder
   // or "undefined". Each value is text and only text (textContent, never innerHTML): these
   // came from Microsoft, Steam and Discord, and the main process already rebuilt them.
   if(linked){
    const lines=[];
    for(const [caption,read] of DETAILS[provider]||[]){
     const value=shown(read(account,details?.[provider]));
     if(!value)continue;
     const line=document.createElement('p');line.className='company-provider-detail';
     const key=document.createElement('span');key.className='company-provider-detail-label';key.textContent=caption+': ';
     const held=document.createElement('span');held.className='company-provider-detail-value';held.textContent=value;
     line.append(key,held);lines.push(line);
    }
    if(lines.length){const block=document.createElement('div');block.className='company-provider-details';block.append(...lines);row.append(block);}
   }
   list.append(row);
  }
  surface.applyLock();
 }
 surface.state.paint=paint;
 paint();
 // The one read this surface makes, asked when the dialog opens, and the only thing the section
 // waits for. `openLinkedAccounts` itself does not await it: it returns the dialog's view at
 // once, so a broadcast that changes the account lock still reaches a dialog that is still
 // waiting, and the rows appear on their own when the answer lands, with no reload.
 const settle=async()=>{
  const ask=typeof desktop.accountProviders==='function'?desktop.accountProviders.bind(desktop):null;
  // A build whose bridge has no availability answer has nothing to wait for and nothing to be
  // wrong about: it draws the rows this dialog drew before this wait existed, Connect controls
  // included, exactly as that build always did.
  if(!ask){answered=true;paint();return;}
  wait.set({message:'Checking your linked accounts…',startedAt:Date.now()});
  try{
   const answer=await ask();
   // An answer that is not an object read nothing, which is a failure and not a launcher with no
   // providers: it must never settle into a list that implies nothing is linked.
   if(!answer||typeof answer!=='object')failed=true;
   else{available=answer.providers;answered=true;}
  }catch{
   // A rejection is a failed read: the account service refused, the request timed out, or the
   // launcher could not reach it. Every account read is bounded in the main process
   // (RETRY_ATTEMPT_CEILING_MS and READ_RETRY_BUDGET_MS, desktop/accounts.cjs), so this settles
   // one way or the other; a read that never settled would be main's defect rather than a
   // sentence this view could honestly invent.
   failed=true;
  }
  wait.clear();
  // The player may have closed the dialog while it was waiting. There is then no surface left to
  // paint a row or a sentence into, and nothing here has invalidated the account.
  if(closed||!modal.isConnected)return;
  if(failed)surface.message('Your linked accounts could not be read.',true);
  else paint();
 };
 void settle();
 // The launcher asks for this whenever a broadcast could have changed the account lock, so a
 // dialog that is already open follows it. Only the lock is re-applied: the rows are rebuilt by
 // paint() on the dialog's own actions, so a broadcast never replaces a control under the
 // player's focus. A dialog that has closed is left alone.
 return {syncLock:surface.syncLock};
}
