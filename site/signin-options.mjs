// THE SIGN-IN OPTIONS, DRAWN FROM ONE PLACE.
//
// Two surfaces offer the same sign-in: the nav's dialog (site/company-auth.mjs, mounted on every
// page by site/web.js) and the account page (site/account/account.mjs). Owen, 2026-10-26, after
// signing in for real: "the /account/ page does not show the same content as the sign-in modal,
// but it should (missing direct sign in options)". Two surfaces that look the same today are
// exactly what drifts tomorrow, so both draw the panel this module builds: the Microsoft button,
// the provider buttons in one order, the note that says what a provider is for, and the direct
// Easter Company username/password form. Neither surface spells an option itself, and this file
// is the only place any of these words appear.
//
// What is deliberately not here: the first-time setup (choose a username, create a password) and
// the verified-emails section. Those are steps of a flow rather than options, they exist only
// inside the dialog, and the account page never draws them. They stay in site/company-auth.mjs.
//
// The wait sentences are here for the same reason the buttons are: "Signing in to Easter
// Company…" is one action, so the dialog's own wait line and the account page's busy state say
// the same thing, and the page's busy state therefore adds no new words to the product.
export const SIGN_IN_TITLE='Easter Company account';
// The provider buttons every surface draws, in the order every surface draws them. Microsoft is
// not in this list: it is the one sign-in that leaves the page, so it is drawn first as its own
// control, not as another broker button.
export const PROVIDER_ORDER=['google','steam','discord'];
const PROVIDER_NAMES={google:'Google',steam:'Steam',discord:'Discord'};
// A provider is named here and nowhere else. The names this panel draws are in the table above;
// any other provider the account service reports (the launcher's verified-emails section prints
// them) is capitalised, and an entry with no provider at all falls back to the word the emails
// section has always used for it.
export const providerName=value=>{
 const key=String(value||'').trim().toLowerCase();
 return PROVIDER_NAMES[key]||(key?key[0].toUpperCase()+key.slice(1):'Verified');
};
export const providerLabel=provider=>'Sign in with '+providerName(provider);
// One copy table. Every sentence below is the launcher's own, reused verbatim, so the account page
// says what the dialog says instead of inventing a second way to say it.
export const SIGN_IN={
 microsoft:'Sign in with Microsoft',
 providerNote:'Please sign up using an existing online account provider, and then create an Easter Company account username & password.',
 identifier:'Username or Email',
 password:'Password',
 submit:'Sign in',
 signingIn:'Signing in…',
 noReset:'If you have forgotten your password there is no reset: sign in with a linked account, then change the password in My Profile.',
 identifierRequired:'Enter your username or email.',
 failed:'Sign-in could not finish. Try again.',
 providerFailed:'Sign-in could not finish.',
 providerUnconfigured:'This provider is not configured.',
 providerUnreadable:'Provider availability could not be checked.',
};
// What a surface says while the flow is in flight. One describing sentence each, both of them the
// dialog's own: the account page's busy state says exactly what the dialog's wait line says.
export const SIGN_IN_WAIT='Signing in to Easter Company…';
export const PROVIDER_WAIT='Complete sign-in in your browser…';

// The copy for a refusal is a string or a list of strings, and blank lines are dropped: the
// launcher's dialogs draw a three-part refusal as three lines in one alert slot, and a single
// sentence as a single line.
function drawProblem(host,lines){
 const shown=[].concat(lines).filter(line=>typeof line==='string'&&line.trim());
 if(!host)return shown;
 if(shown.length===1)host.textContent=shown[0];
 else host.replaceChildren(...shown.map(line=>{const paragraph=document.createElement('p');paragraph.textContent=line;return paragraph;}));
 host.hidden=!shown.length;
 return shown;
}

// Build the panel. The hosts supply behaviour - what pressing Microsoft, a provider button or
// Sign in means on that surface - and this module supplies the surface itself.
//
//   onMicrosoft()        the Microsoft button was pressed
//   onProvider(name)     the provider button for `name` was pressed
//   onSubmit(identifier,password)  the direct form was submitted with an identifier
//   onProblem(lines)     where this panel's own refusals are drawn; without it the panel keeps an
//                        alert slot of its own in the form, which is what the dialog uses
export function createSignInOptions({onMicrosoft=null,onProvider=null,onSubmit=null,onProblem=null}={}){
 const node=document.createElement('div');
 node.className='company-signin';
 const microsoft=document.createElement('button');
 microsoft.type='button';microsoft.className='company-microsoft';microsoft.textContent=SIGN_IN.microsoft;
 microsoft.onclick=()=>{if(!microsoft.disabled&&typeof onMicrosoft==='function')void onMicrosoft();};
 const providers=new Map();
 for(const provider of PROVIDER_ORDER){
  const button=document.createElement('button');
  button.type='button';button.className='company-provider';button.dataset.provider=provider;button.textContent=providerLabel(provider);
  button.onclick=()=>{if(!button.disabled&&typeof onProvider==='function')void onProvider(provider);};
  providers.set(provider,button);node.append(button);
 }
 const note=document.createElement('p');
 note.className='company-provider-note';note.textContent=SIGN_IN.providerNote;
 node.insertBefore(microsoft,node.firstChild);
 node.append(note);
 const form=document.createElement('form');
 const identifier=document.createElement('input');
 identifier.name='identifier';identifier.autocomplete='username';identifier.maxLength=254;identifier.required=true;identifier.spellcheck=false;
 const secret=document.createElement('input');
 secret.type='password';secret.name='password';secret.autocomplete='current-password';secret.maxLength=128;secret.required=true;
 const identifierLabel=document.createElement('label');
 identifierLabel.append(SIGN_IN.identifier,identifier);
 const passwordLabel=document.createElement('label');
 passwordLabel.append(SIGN_IN.password,secret);
 const slot=document.createElement('div');
 slot.className='company-error';slot.setAttribute('role','alert');slot.hidden=true;
 const submit=document.createElement('button');
 submit.type='submit';submit.className='company-submit';submit.textContent=SIGN_IN.submit;
 const noReset=document.createElement('p');
 noReset.className='company-no-reset';noReset.textContent=SIGN_IN.noReset;
 form.append(identifierLabel,passwordLabel,slot,submit,noReset);
 node.append(form);
 // Where a refusal lands: the host's own alert region when it has one (the account page keeps one
 // region for every failure), otherwise this panel's slot in the form (the dialog's own).
 const problemHost=typeof onProblem==='function'?null:slot;
 const problem=lines=>{
  const shown=drawProblem(problemHost,lines);
  if(shown.length)drawProblem(slot,[]);
  if(shown.length&&typeof onProblem==='function')onProblem(shown);
  return shown;
 };
 const clearProblem=()=>{drawProblem(slot,[]);if(typeof onProblem==='function')onProblem([]);};
 // `unknown` until the service has been asked, a list once it has answered, and `unreadable` when
 // the question could not be answered at all. A provider the list does not name is drawn disabled
 // rather than removed: both surfaces show every option and say which ones this service offers.
 let available='unknown',locked=false;
 function paintAvailability(){
  for(const [provider,button] of providers){
   const offered=Array.isArray(available)&&available.includes(provider);
   button.disabled=locked||Array.isArray(available)&&!offered;
   button.title=Array.isArray(available)&&!offered?SIGN_IN.providerUnconfigured:available==='unreadable'?SIGN_IN.providerUnreadable:'';
  }
 }
 // The whole panel, not just its buttons: a locked panel is the modal's busy dialog, and every
 // control in it refuses a second press while the first flow is in flight.
 function lock(value){
  locked=Boolean(value);
  microsoft.disabled=locked;
  submit.disabled=locked;
  submit.textContent=locked?SIGN_IN.signingIn:SIGN_IN.submit;
  identifier.disabled=locked;secret.disabled=locked;
  paintAvailability();
 }
 function setProviders(list){available=Array.isArray(list)?list:[];paintAvailability();}
 function providersUnreadable(){available='unreadable';paintAvailability();}
 form.onsubmit=event=>{
  event.preventDefault();
  if(locked||typeof onSubmit!=='function')return;
  const named=identifier.value.trim();
  if(!named){problem(SIGN_IN.identifierRequired);identifier.focus();return;}
  clearProblem();
  void onSubmit(named,secret.value);
 };
 return {
  node,form,microsoft,providers,submit,identifier,secret,
  problem,clearProblem,lock,setProviders,providersUnreadable,
  // A refusal ends the attempt but keeps what was typed in the identifier, and never keeps a
  // password on screen: the dialog has always cleared that field and the page does the same.
  clearPassword(){secret.value='';},
 };
}
