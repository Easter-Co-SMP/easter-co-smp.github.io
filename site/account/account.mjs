// THE ACCOUNT PAGE. site/account/ is the address Microsoft sends the browser back to, so this
// module has three jobs and one rule.
//
//   start     the player presses Microsoft - here, or in the chooser on any page, which sends
//             them here with ?provider=microsoft. The page asks the service to begin a flow and
//             navigates to the authorize URL the service answers with.
//   callback  Microsoft returns with either ?code=&state= or ?error=&error_description=. The
//             code case posts those two values, the state exactly as received, to the exchange;
//             the error case is a refusal and is never exchanged.
//   account   the signed-in account, and a sign-out that clears it through the same seam.
//
// The rule: this page holds no Microsoft token and never asks for a Minecraft session. The
// backend discards the refresh token by design (doc/BROWSER_SIGN_IN.md, section 4), so Play
// stays in the launcher; a browser session can identify the player, read the store and place
// orders.
//
// Every failure is drawn in one alert region, and wherever the account service spoke, the
// sentence is the service's own - the `message` from its own body - rather than this page's
// invention. That includes the 503 redirect_uri_not_registered case, which is the service
// saying what a human still has to register rather than a sign-in that broke.
import {webAccount} from '../web-account.mjs';
import {createWaitFeedback} from '../wait-feedback.mjs';
import {REDIRECT_URI,ACCOUNT_PATH,NOT_CONFIGURED,readCallback} from './microsoft-signin.mjs';

// The launcher's own words for the actions this page shares with it: the chooser's heading, its
// Microsoft button and its provider button pattern (site/company-auth.mjs), the sign-out in the
// account menu (site/web.js), and the cancelled sentence the browser sign-in seam already
// answers with. One action, one spelling: a second copy of the same sentence is a second thing
// that can stop being true.
const ACCOUNT_TITLE='Easter Company account';
const MICROSOFT='Sign in with Microsoft';
const SIGN_OUT='Sign out';
const CANCELLED='Sign-in cancelled.';
const PROVIDER_NAMES={google:'Google',steam:'Steam',discord:'Discord'};
// The three sentences this page adds, all of them about a state the launcher has no surface for.
// Not-configuration is one state and carries the service's own sentence; the address is named
// only when this page is being read somewhere else, because that is the fact the service's
// sentence leaves out.
const WRONG_ADDRESS='Sign in at '+REDIRECT_URI+'.';
const AUTHORITY_REFUSED='Microsoft did not complete the sign-in.';
// The launcher's own wait sentence for exactly this action (site/company-auth.mjs, the busy lock
// on the chooser). The page adds no second way to say "signing in to Easter Company".
const SIGNING_IN='Signing in to Easter Company…';
// What a browser session can and cannot do is a product boundary, not a hidden edge: a player who
// has just signed in on the site should not have to discover it by looking for a Play button.
const PLAY_NOTE='Signing in here does not start Minecraft. Play stays in the launcher.';

const root=document.getElementById('account-root');
const alertBox=document.getElementById('account-error');
const waitHost=document.getElementById('account-wait');
const wait=waitHost?createWaitFeedback(waitHost):{set(){},clear(){}};
const bridge=webAccount;
// Which whole answer is on screen, so a repaint caused by a busy flag does not rebuild it.
let shown=null,providerRead=0;

function element(tag,className,textContent){
 const node=document.createElement(tag);
 if(className)node.className=className;
 if(textContent!==undefined)node.textContent=textContent;
 return node;
}

// One alert region, cleared before every attempt and drawn once per refusal: the service's
// sentence first, then - when there is one - the detail underneath it, never as a competing
// message. `lines` is a string or a list of strings, and blank lines are dropped.
function problem(lines){
 const shownLines=[].concat(lines).filter(line=>typeof line==='string'&&line.trim());
 alertBox.replaceChildren(...shownLines.map(line=>element('p',null,line)));
 alertBox.hidden=!shownLines.length;
}
const clearProblem=()=>problem([]);
const busy=value=>{
 for(const button of root.querySelectorAll('button'))button.disabled=value;
};

function unavailable(){
 shown='unavailable';
 clearProblem();
 problem([NOT_CONFIGURED,WRONG_ADDRESS]);
 root.replaceChildren();
}

function signedIn(account){
 shown='in';
 clearProblem();
 const identity=element('p','account-identity','Signed in as ');
 identity.append(element('strong',null,account?.name||'Company member'));
 const out=element('button','account-provider',SIGN_OUT);
 out.type='button';
 out.onclick=()=>{
  out.disabled=true;
  void bridge.signOut();
 };
 root.replaceChildren(identity,element('p','account-note',PLAY_NOTE),out);
}

function signedOut(){
 shown='out';
 const read=++providerRead;
 const buttons=element('div','account-providers');
 const microsoft=element('button','account-provider',MICROSOFT);
 microsoft.type='button';
 microsoft.onclick=()=>void startMicrosoft();
 buttons.append(microsoft);
 root.replaceChildren(buttons);
 // Every other provider the account service reports as configured. The Microsoft button above
 // is deliberately not gated on this list: the list describes the popup broker behind Google,
 // Steam and Discord, and Microsoft's browser flow is a different mechanism that this page
 // owns, so a list that cannot be read costs the others and never this one.
 void bridge.accountProviders().then(found=>{
  if(read!==providerRead||shown!=='out')return;
  for(const provider of found?.providers||[]){
   if(provider==='microsoft'||!Object.hasOwn(PROVIDER_NAMES,provider))continue;
   const button=element('button','account-provider','Sign in with '+PROVIDER_NAMES[provider]);
   button.type='button';
   button.onclick=async()=>{
    clearProblem();
    const outcome=await bridge.signInProvider(provider,false);
    // A completed provider sign-in has already been saved by the seam, and the state change
    // paints the account; a refusal is drawn here.
    if(outcome?.ok===false)problem(outcome.error);
    busy(bridge.getState().accountWorking===true);
   };
   buttons.append(button);
  }
 },()=>{
  // Unavailable availability is not a failure of this page: the Microsoft button stands alone.
 });
}

async function startMicrosoft(){
 if(shown!=='out')return;
 clearProblem();
 busy(true);
 wait.set({message:SIGNING_IN});
 const result=await bridge.startMicrosoftSignIn();
 // On success the browser has left for Microsoft and this page is unloading; anything that
 // lands here is a refusal, including the two this page makes before asking anybody anything.
 wait.clear();
 if(result.ok)return;
 busy(false);
 problem(result.error);
}

// The four possible answers to "what is in this page's address", in the order they matter. The
// callback comes first because it is what the player came back for.
async function boot(){
 paint();
 await bridge.ready;
 const callback=readCallback(location.search);
 if(callback.kind==='refused'){
  // The authority's own word and, when it gave one, its own description. A cancelled sign-in is
  // the common case and says so in one line; anything else keeps the detail, because it is the
  // only thing that can tell a player whether to retry or to stop.
  stripAddress();
  problem(callback.error==='access_denied'?[CANCELLED]:[AUTHORITY_REFUSED,callback.description]);
  return;
 }
 if(callback.kind==='code'||callback.kind==='state-missing'){
  wait.set({message:SIGNING_IN});
  const result=await bridge.completeMicrosoftSignIn(location.search);
  wait.clear();
  // The code leaves the address bar and the history entry it was opened with. It is single use
  // and it is useless without the verifier, but nothing here needs to keep it, and a refreshed
  // page must not post it a second time.
  stripAddress();
  if(!result.ok)problem(result.error);
  return;
 }
 if(new URLSearchParams(location.search).get('provider')==='microsoft'){
  await startMicrosoft();
  return;
 }
 if(bridge.getState().account)paint();
}

// The address this page answers for, with nothing after it: the redirect literal is a contract
// and the query string is not part of it.
function stripAddress(){
 if(location.search||location.hash)history.replaceState(null,'',location.pathname);
}

// The account seam's own state decides which of the two whole answers is on screen. A busy flag
// disables the controls of whichever one is there rather than rebuilding it.
function paint(next=bridge.getState()){
 const key=next.account?'in':'out';
 if(key!==shown){
  if(key==='in')signedIn(next.account);
  else if(shown!=='unavailable')signedOut();
 }
 busy(next.accountWorking===true);
}

// The dispatch is last on purpose: every answer this page can draw is declared above it, so the
// first paint cannot run into a binding that does not exist yet.
if(!root||!alertBox){
 // The page's own markup is missing, and there is nowhere a sentence could be read.
}else if(!bridge||location.pathname!==ACCOUNT_PATH){
 // Two ways to be in the wrong place, and one answer for both. site/ is bundled into the launcher
 // as well as served as the website, and this page is a browser page, so without the browser
 // account seam there is nothing here that could sign anybody in. And the flow belongs to one
 // address: /account/index.html, a mirror of the site and the launcher's bundled copy of site/
 // all answer here, and none of them is the literal Microsoft has registered. A Microsoft button
 // in either case would send the authority a URI nobody registered and fail after the player had
 // already signed in, so the page says which address it signs in at and offers nothing.
 unavailable();
}else{
 // A sign-out finished elsewhere in the page (the account menu), a session expired, or a provider
 // sign-in completed: the account view follows the seam rather than guessing.
 bridge.subscribe(paint);
 void boot();
}
