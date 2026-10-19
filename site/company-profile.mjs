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
export async function openCompanyProfile({desktop,getState,signInMicrosoft}){
 if(document.querySelector('#company-profile'))return;
 const modal=document.createElement('dialog');modal.id='company-profile';modal.className='desktop-company-dialog';modal.setAttribute('aria-labelledby','company-profile-title');
 modal.innerHTML='<button class="dialog-close" aria-label="Close profile">×</button><h2 id="company-profile-title">Your profile</h2><form><label>Display name<input name="displayName" maxlength="64" required autocomplete="nickname"></label><button type="submit">Save name</button></form><div class="company-picture-actions"><button type="button" data-picture="upload">Choose picture</button><button type="button" data-picture="remove">Remove picture</button></div><p>Your profile can be changed independently of your linked accounts.</p><h3>Linked accounts</h3><p>Links stay with this Easter Company account and cannot be removed from the launcher yet. Microsoft / Xbox and Minecraft ownership are required to play Minecraft.</p><div class="company-provider-links"></div><div class="company-minecraft-session" hidden><h3>Minecraft session</h3><p>Your Microsoft session is stored on your Easter Company account, so any computer you sign in on is ready to play without asking Microsoft again.</p><button type="button" data-revoke-minecraft>Sign out of Minecraft everywhere</button></div><p class="company-error" role="alert" hidden></p><p class="company-status" role="status"></p>';
 document.body.append(modal);modal.showModal();
 let busy=false,providerPending=false;
 const message=(text,error=false)=>{const node=modal.querySelector(error?'.company-error':'.company-status');node.textContent=text;node.hidden=!text;};
 const run=async (action,external=false)=>{
  if(busy)return;busy=true;providerPending=external;message('',true);message('');for(const button of modal.querySelectorAll('button'))button.disabled=true;
  if(providerPending)modal.querySelector('.dialog-close').disabled=false;
  try{const result=await action();if(result===false||result?.ok===false)message(result?.error||'This change was not completed.',true);else if(result?.value?.cancelled||result?.cancelled)message('');else message('Saved.');}
  catch(error){message(error.message||'This change could not be saved.',true);}
  finally{providerPending=false;busy=false;for(const button of modal.querySelectorAll('button'))button.disabled=false;paint();}
 };
 let available=null;
 try{available=(await desktop.accountProviders()).providers;}catch{}
 function paint(){
  const account=getState()?.account;if(!account){modal.close();return;}
  if(document.activeElement!==modal.querySelector('input'))modal.querySelector('input').value=account.name||account.username||'';
  // The stored-session control belongs to the account service's own answer, not to a guess: it is
  // offered only once the launcher has seen a session this account stores (doc/launcher-states.md,
  // "Signing Minecraft out everywhere"), and a state from a build without that field draws no such
  // section at all.
  const sessionSection=modal.querySelector('.company-minecraft-session');
  if(sessionSection)sessionSection.hidden=getState()?.minecraftSession?.serverHeld!==true;
  const list=modal.querySelector('.company-provider-links');list.replaceChildren();
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
    const button=document.createElement('button');button.type='button';button.textContent='Connect';button.disabled=busy||(available&&!available.includes(provider));button.setAttribute('aria-label','Connect '+name);
    button.onclick=()=>void run(()=>provider==='microsoft'?signInMicrosoft({link:true}):desktop.signInProvider(provider,true),provider!=='microsoft');
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
 }
 paint();
 modal.querySelector('form').onsubmit=event=>{event.preventDefault();void run(()=>desktop.updateProfile(modal.querySelector('input').value));};
 for(const button of modal.querySelectorAll('[data-picture]'))button.onclick=()=>void run(()=>desktop.setProfilePicture(button.dataset.picture==='remove'));
 // One control, one request, and the dialog prints the sentence the launcher answered with —
 // "signed out everywhere", "the launcher cannot do that yet", or the account service's own
 // refusal. It never words that outcome itself, because only the main process saw the answer.
 const revoke=modal.querySelector('[data-revoke-minecraft]');
 if(revoke)revoke.onclick=async()=>{
  if(busy)return;
  busy=true;message('',true);message('');
  for(const button of modal.querySelectorAll('button'))button.disabled=true;
  try{
   const answer=await desktop.signOutMinecraft();
   const sentence=typeof answer==='string'?answer:typeof answer?.message==='string'?answer.message:typeof answer?.value?.message==='string'?answer.value.message:'';
   message(sentence||'Signed Minecraft out everywhere.');
  }catch(error){message(error?.message||'The launcher could not sign Minecraft out.',true);}
  finally{busy=false;for(const button of modal.querySelectorAll('button'))button.disabled=false;paint();}
 };
 modal.querySelector('.dialog-close').onclick=()=>{if(providerPending){void desktop.cancelSignIn();return;}if(!busy)modal.close();};
 modal.addEventListener('cancel',event=>{if(busy){event.preventDefault();if(providerPending)void desktop.cancelSignIn();}});
 modal.addEventListener('close',()=>modal.remove(),{once:true});
}
