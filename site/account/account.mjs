// THE ACCOUNT PAGE. site/account/ is the address Microsoft sends the browser back to, so this
// module has three jobs and one rule.
//
//   start     the player presses Microsoft - here, or in the chooser on any page, which starts
//             the flow itself and sends the browser straight here with the answer. The page asks
//             the service to begin a flow and navigates to the authorize URL the service answers
//             with. ?provider=microsoft is still answered for, because it is an address a person
//             can still arrive at; nothing on the site sends the browser through it any more.
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
import {REDIRECT_URI,ACCOUNT_PATH,NOT_CONFIGURED,readCallback} from './microsoft-signin.mjs';

// The sign-in options are not written out here either. This page and the nav's dialog draw the
// same panel from site/signin-options.mjs - the Microsoft button, the provider buttons in one
// order, the note that says what a provider is for, and the direct Company username/password
// form - because Owen signed in for real on 2026-10-26 and found the page "does not show the same
// content as the sign-in modal, but it should (missing direct sign in options)". Two surfaces that
// look the same today is exactly what drifts, so there is one renderer and one copy table.
import {SIGN_IN_TITLE,SIGN_IN,SIGN_IN_WAIT,PROVIDER_WAIT,createSignInOptions} from '../signin-options.mjs';

// The launcher's own words for the actions this page shares with it: the sign-out in the account
// menu (site/web.js) and the cancelled sentence the browser sign-in seam already answers with.
// One action, one spelling: a second copy of the same sentence is a second thing that can stop
// being true.
const SIGN_OUT='Sign out';
const CANCELLED='Sign-in cancelled.';
// The two sentences this page adds, both of them about a state the launcher has no surface for.
// Not-configuration is one state and carries the service's own sentence; the address is named
// only when this page is being read somewhere else, because that is the fact the service's
// sentence leaves out.
const WRONG_ADDRESS='Sign in at '+REDIRECT_URI+'.';
const AUTHORITY_REFUSED='Microsoft did not complete the sign-in.';
// What a browser session can and cannot do is a product boundary, not a hidden edge: a player who
// has just signed in on the site should not have to discover it by looking for a Play button.
const PLAY_NOTE='Signing in here does not start Minecraft. Play stays in the launcher.';

const root=document.getElementById('account-root');
const panel=document.getElementById('account-panel');
const alertBox=document.getElementById('account-error');
const waitHost=document.getElementById('account-wait');
const bridge=webAccount;
// Which whole answer is on screen, so a repaint caused by a busy flag does not rebuild it.
let shown=null,providerRead=0,options=null;
// The page's heading is the dialog's heading: one sentence, written in one file.
const heading=document.querySelector('.account-heading');
if(heading)heading.textContent=SIGN_IN_TITLE;

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

// THE BUSY STATE, which is the whole of what this page shows while a flow is in flight.
//
// Owen, 2026-10-26, after signing in for real: the page "should not show any content except a
// decorative and descriptive loading spinner while a sign-in / auth or sign up process is
// happening", and it must offer "nothing interactive that could start a second flow in parallel
// with the first". So the busy state is one decorative spinner and one describing sentence, and
// the heading, the options and every refusal are out of the way for as long as it lasts: the
// panel's own `data-busy` attribute is what hides them, because `display:none` takes the controls
// out of the tab order rather than merely out of sight.
//
// The spinner is the shared mark every other wait in this product paints (`.wait-feedback-mark`,
// site/desktop.css), including its reduced-motion form - a still gold ring, never nothing. The one
// sentence is the dialog's own wait line for the same action (site/signin-options.mjs), so the two
// surfaces say one thing about one flow and this page adds no words to the product. It is written
// here rather than through site/wait-feedback.mjs because that component adds a second line -
// "Still working. You can leave this open." - after ten seconds, and this state is one sentence.
//
// `flow` holds that sentence for the length of the flow and is the page's only record that one is
// in flight; every entry point below refuses to start a second while it is set.
let flow=null,busyLine=null;
function busyMark(){
 if(!waitHost||busyLine)return;
 const mark=element('span','wait-feedback-mark');
 mark.setAttribute('aria-hidden','true');
 busyLine=element('span','account-busy-line');
 waitHost.append(mark,busyLine);
 waitHost.setAttribute('role','status');
 waitHost.setAttribute('aria-live','polite');
 waitHost.setAttribute('aria-atomic','true');
}
function begin(line){
 if(!panel||flow)return;
 flow=line||SIGN_IN_WAIT;
 busyMark();
 // A refusal from the previous attempt is not carried into this one: the busy state shows one
 // sentence, and a stale error would be a second.
 clearProblem();
 panel.dataset.busy='true';
 // The live region is shown before the sentence is written into it, so a reader announces the
 // sentence rather than a region that appeared already full.
 if(waitHost)waitHost.hidden=false;
 if(busyLine)busyLine.textContent=flow;
}
function end(){
 flow=null;
 if(busyLine)busyLine.textContent='';
 if(waitHost)waitHost.hidden=true;
 if(panel)panel.dataset.busy='false';
}

function unavailable(){
 shown='unavailable';
 options=null;
 clearProblem();
 problem([NOT_CONFIGURED,WRONG_ADDRESS]);
 root.replaceChildren();
}

function signedIn(account){
 shown='in';
 options=null;
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

// The signed-out answer is the shared panel, one node, whether or not the service has answered
// about the other providers yet: the Microsoft button and the direct Company sign-in never wait
// on a question about Google, Steam or Discord.
function signedOut(){
 shown='out';
 const read=++providerRead;
 options=createSignInOptions({
  onMicrosoft:()=>void startMicrosoft(),
  onProvider:provider=>void signInWithProvider(provider),
  onSubmit:(identifier,secret)=>void signInWithPassword(identifier,secret),
  // This page keeps one alert region for every failure it can draw, above the options, so the
  // panel's own refusals are drawn there rather than in a second slot below the fields.
  onProblem:lines=>problem(lines),
 });
 root.replaceChildren(options.node);
 // Every other provider the account service reports as configured. The provider buttons are the
 // same three the dialog draws, in the same order, and one the service does not offer is drawn
 // disabled with the dialog's own sentence rather than left out: the two surfaces show one list.
 void bridge.accountProviders().then(found=>{
  if(read!==providerRead||shown!=='out'||!options)return;
  options.setProviders(found?.providers||[]);
 },()=>{
  // Unavailable availability is not a failure of this page: Microsoft and the direct sign-in
  // stand, and the provider buttons say that is the one thing that could not be checked.
  if(read!==providerRead||shown!=='out'||!options)return;
  options.providersUnreadable();
 });
}

// Every entry point below opens the busy state, asks once, closes it, and draws whatever came
// back in place. None of them navigates: the only navigation on this page is the one to
// Microsoft, which is the contract, and a refusal must not cost a document load.
async function startMicrosoft(){
 if(shown!=='out')return;
 begin(SIGN_IN_WAIT);
 const result=await bridge.startMicrosoftSignIn();
 // On success the browser has left for Microsoft and this page is unloading; anything that
 // lands here is a refusal, including the two this page makes before asking anybody anything.
 end();
 if(result.ok)return;
 problem(result.error);
 paint();
}

async function signInWithProvider(provider){
 if(flow)return;
 clearProblem();
 begin(PROVIDER_WAIT);
 const outcome=await bridge.signInProvider(provider,false);
 end();
 // A completed provider sign-in has already been saved by the seam, and the state change paints
 // the account; a refusal is drawn here, on this page, in place.
 if(outcome?.ok===false)problem(outcome.error||SIGN_IN.providerFailed);
 paint();
}

async function signInWithPassword(identifier,secret){
 if(flow)return;
 clearProblem();
 begin(SIGN_IN_WAIT);
 const outcome=await bridge.loginCompany(identifier,secret);
 end();
 if(outcome&&outcome.ok===false){
  problem(outcome.error||SIGN_IN.failed);
  // The attempt ended, so the page is back to its ordinary content - and the password the player
  // typed is not left on screen to be read over their shoulder.
  options?.clearPassword();
 }
 paint();
}

// The four possible answers to "what is in this page's address", in the order they matter. The
// callback comes first because it is what the player came back for.
async function boot(){
 const callback=readCallback(location.search);
 const handed=callback.kind==='none'&&new URLSearchParams(location.search).get('provider')==='microsoft';
 // A page that is mid-flow never shows its ordinary content, not even for the first frame: a
 // callback or a hand-off opens straight into the busy state, and the options are drawn only if
 // the flow ends without signing anybody in.
 if(callback.kind==='code'||callback.kind==='state-missing'||handed)begin(SIGN_IN_WAIT);
 paint();
 await bridge.ready;
 if(callback.kind==='refused'){
  // The authority's own word and, when it gave one, its own description. A cancelled sign-in is
  // the common case and says so in one line; anything else keeps the detail, because it is the
  // only thing that can tell a player whether to retry or to stop.
  stripAddress();
  problem(callback.error==='access_denied'?[CANCELLED]:[AUTHORITY_REFUSED,callback.description]);
  return;
 }
 if(callback.kind==='code'||callback.kind==='state-missing'){
  const result=await bridge.completeMicrosoftSignIn(location.search);
  // The flow is over, so the page returns to its ordinary content with the result: the account if
  // it signed in, the refusal in the alert region if it did not.
  end();
  // The code leaves the address bar and the history entry it was opened with. It is single use
  // and it is useless without the verifier, but nothing here needs to keep it, and a refreshed
  // page must not post it a second time.
  stripAddress();
  if(!result.ok)problem(result.error);
  paint();
  return;
 }
 if(handed){
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

// The account seam's own state decides which whole answer is on screen. A flow in flight is the
// exception: while one runs none of these answers is on screen at all - the busy state is.
function paint(next=bridge.getState()){
 const key=next.account?'in':'out';
 if(key!==shown){
  if(key==='in')signedIn(next.account);
  else if(shown!=='unavailable')signedOut();
 }
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
