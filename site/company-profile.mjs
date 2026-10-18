const NAMES={microsoft:'Microsoft / Xbox',google:'Google',steam:'Steam',discord:'Discord'};
export async function openCompanyProfile({desktop,getState,signInMicrosoft}){
 if(document.querySelector('#company-profile'))return;
 const modal=document.createElement('dialog');modal.id='company-profile';modal.className='desktop-company-dialog';modal.setAttribute('aria-labelledby','company-profile-title');
 modal.innerHTML='<button class="dialog-close" aria-label="Close profile">×</button><h2 id="company-profile-title">Your profile</h2><form><label>Display name<input name="displayName" maxlength="64" required autocomplete="nickname"></label><button type="submit">Save name</button></form><div class="company-picture-actions"><button type="button" data-picture="upload">Choose picture</button><button type="button" data-picture="remove">Remove picture</button></div><p>Your profile can be changed independently of your linked accounts.</p><h3>Linked accounts</h3><p>Links stay with this Easter Company account. Microsoft / Xbox and Minecraft ownership are required to play Minecraft.</p><div class="company-provider-links"></div><p class="company-error" role="alert" hidden></p><p class="company-status" role="status"></p>';
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
  const list=modal.querySelector('.company-provider-links');list.replaceChildren();
  for(const [provider,name] of Object.entries(NAMES)){
   const linked=(account.providers||[]).includes(provider)||(provider==='microsoft'&&account.microsoftLinked);
   const row=document.createElement('div');row.className='company-provider-link';
   const label=document.createElement('span');label.textContent=name+(linked?' · linked':'');
   const button=document.createElement('button');button.type='button';button.textContent=linked?'Verify':'Connect';button.disabled=busy||(available&&!available.includes(provider));button.setAttribute('aria-label',button.textContent+' '+name);
   button.onclick=()=>void run(()=>provider==='microsoft'?signInMicrosoft({link:true}):desktop.signInProvider(provider,true),provider!=='microsoft');row.append(label,button);list.append(row);
  }
 }
 paint();
 modal.querySelector('form').onsubmit=event=>{event.preventDefault();void run(()=>desktop.updateProfile(modal.querySelector('input').value));};
 for(const button of modal.querySelectorAll('[data-picture]'))button.onclick=()=>void run(()=>desktop.setProfilePicture(button.dataset.picture==='remove'));
 modal.querySelector('.dialog-close').onclick=()=>{if(providerPending){void desktop.cancelSignIn();return;}if(!busy)modal.close();};
 modal.addEventListener('cancel',event=>{if(busy){event.preventDefault();if(providerPending)void desktop.cancelSignIn();}});
 modal.addEventListener('close',()=>modal.remove(),{once:true});
}
