import {webAccount} from './web-account.mjs';
import {createCompanyAuth} from './company-auth.mjs';
import {rememberReturnTarget} from './auth-return.mjs';
if(webAccount){
 // WHAT THIS PAGE WAS ASKED TO RETURN TO. Owen, 2026-10-26: "easter-co-smp.github.io should have
 // generic flags to handle redirects and other e apps using the same auth flows." `?app=<id>` (an
 // allow-listed first-party app) and `?next=<url>` (an address that passes the same validator) are a
 // request to be brought back to that app once this tab has signed in, and they are read here
 // because this module runs on every page of the site: an app may open the homepage, and the player
 // may sign in from the nav's dialog rather than from /account/. site/auth-return.mjs owns the
 // allow-list, the one storage key and the consume-once rule, and its header says what this must
 // never become (a token handoff); doc/auth-return.md is the written contract. A page opened
 // without either parameter writes nothing at all.
 rememberReturnTarget(location.search);
 document.documentElement.classList.add('web-mode');
 // THE WEBSITE HAS NO STORE. Owen, 2026-10-27: the Easter Company app registration is going to
 // Minecraft for API approval and the form reviews this site, so a storefront on it is a
 // monetisation question we do not want asked during a review - *"let's not remove, but disable
 // the store on the website ... leave it inside the launcher though"*. Nothing is deleted:
 // site/store/ is still here, the launcher still mounts it through its own bridge, and
 // site/account-client.mjs still serves the catalogue and the player's own orders. What went is
 // the website's every route to it: the Store entry this file injected into the shared nav on
 // any page that lacked one, and the Stripe return redirect that used to forward
 // `#store-paid/cs_...` and `#store-cancelled` into site/store/. A browser that opens /store/
 // is sent to the site root instead, and no page of this site links into it
 // (site/store/store.mjs, the mount gate; doc/launcher-store.md).
 const nav=document.querySelector('.site-header nav');
 if(nav){
   // ---- The account control's face ----------------------------------------------
   // Owen, 2026-10-26, signed in on the live site: "there's no user image in the `oceaster` user
   // element"; and the next day, signed in on both surfaces: "I am logged in on both web and
   // launcher, but web shows the placeholder profile image while the launcher is showing my
   // minecraft skin based one." So this control draws the launcher's own three-step precedence
   // (site/desktop.js, "The player's face"), in the same order and ending where it already did:
   // the account's uploaded `picture`; else the head cropped here from the account's Minecraft
   // `skin`; else the deliberate teal letter tile.
   //
   // Both images reach this control only inside the account document, as data:image/png;base64
   // URIs - the cloud validates them into that form and publicAccount in
   // site/account-client.mjs keeps that form and drops any other - so the page shows a face it
   // already holds and asks nobody for one. That is not a shortcut. The launcher's first source,
   // sessionserver.mojang.com, answers a page with no Access-Control-Allow-Origin, so a browser's
   // own uuid-to-texture lookup fails as a CORS error before any JSON exists (measured in
   // Chromium at this origin, 2026-10-26: "TypeError: Failed to fetch" from sessionserver while
   // textures.minecraft.net itself answered). The whole texture travels to the page instead, and
   // the crop happens here.
   //
   // The tile is a primary state, not an edge case: the account wipe in flight keeps username,
   // password and roles and drops every provider link, so accounts arrive here with neither a
   // picture nor a Minecraft identity, and an account whose skin will not decode lands on the tile
   // too. That is the launcher's own last resort - #536b66 with the first letter of the name in
   // cream #eedbb2 - so one player sees one face on both surfaces.
   const account=document.createElement('button');account.type='button';account.className='web-account-nav';account.disabled=true;
   // Fixed-size slot, absolutely positioned image inside it: whether the picture is absent,
   // loading, painted or failed, the control's box cannot move.
   const face=document.createElement('span');face.className='web-account-face';face.setAttribute('aria-hidden','true');face.hidden=true;
   const initial=document.createElement('span');initial.className='web-account-initial';
   // An empty alt plus the aria-hidden slot keep the control's name the account and never a
   // filename; the visible name stays the button's own text so nothing about it changes.
   const portrait=document.createElement('img');portrait.className='web-account-picture';portrait.alt='';portrait.decoding='async';portrait.hidden=true;
   face.append(initial,portrait);
   const name=document.createElement('span');name.className='web-account-name';name.textContent='Sign in';
   account.append(face,name);nav.append(account);
   const menu=document.createElement('div');menu.id='web-account-menu';menu.className='desktop-profile-menu';menu.setAttribute('popover','auto');menu.setAttribute('aria-label','Account options');document.body.append(menu);
   const notice=document.createElement('p');notice.className='web-account-notice';notice.setAttribute('role','alert');notice.hidden=true;menu.append(notice);
   let current=webAccount.getState(),profile=null,linked=null;
   // Microsoft signs in on its own page. site/account/ is the address Microsoft sends the browser
   // back to, and is where a Company session for a Microsoft account is made; doc/BROWSER_SIGN_IN.md
   // in the cloud repository is the contract. Pressing the button in this dialog therefore starts
   // the flow here and sends the browser straight to Microsoft. It used to send it to
   // /account/?provider=microsoft first: one whole page load that answered nothing, and one the
   // Back button re-entered and re-started (Owen, 2026-10-26, after signing in for real: "too many
   // full page loads"). The address Microsoft is handed is the registered redirect either way, and
   // the answer is exchanged on /account/ whether the flow started there or here.
   //
   // Linking stays a launcher action: the exchange is a sign-in, and it has no link mode for an
   // account that is already signed in.
   const signInMicrosoft=async options=>{
    if(options?.link)return {ok:false,error:'Connect Microsoft in the launcher.'};
    // The seam refuses a second flow while one is in flight, and on success the browser has
    // already been sent to Microsoft by the time this answers.
    const result=await webAccount.startMicrosoftSignIn();
    return result&&result.ok===false?{ok:false,error:result.error}:{ok:true};
   };
   // `startsOnPage` tells the dialog that pressing Microsoft begins the flow on the page the
   // player is on, so the dialog stays up and reports the start instead of closing first.
   const auth=createCompanyAuth({desktop:webAccount,signInMicrosoft,startsOnPage:true});
   const action=(label,fn)=>{const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{menu.hidePopover();void fn();};menu.append(button);};
   const options={desktop:webAccount,getState:()=>current,isAccountLocked:()=>current.accountWorking===true,cancelSignIn:()=>webAccount.cancelSignIn()};
   action('My Profile',async()=>{const {openMyProfile}=await import('./company-profile.mjs');profile=await openMyProfile({...options,openEmails:()=>auth.emails()});});
   action('Linked Accounts',async()=>{const {openLinkedAccounts}=await import('./company-profile.mjs');linked=await openLinkedAccounts({...options,signInMicrosoft});});
   action('Sign out',async()=>{await webAccount.signOut();});
   account.onclick=()=>{
    if(!current.account){auth.open();return;}
    if(current.account.passwordRequired){auth.setup();return;}
    menu.style.top=(account.getBoundingClientRect().bottom+8)+'px';menu.style.right=Math.max(12,innerWidth-account.getBoundingClientRect().right)+'px';
    menu.showPopover();menu.querySelector('button')?.focus();
   };
   // The face follows the account and only the account: while a sign-in is in flight there is no
   // account to show, so the slot is hidden and the control is exactly the text it always was.
   // The one other state is a boot that cannot paint yet (site/web-account.mjs: a saved session with
   // no stored document), and there the slot holds the Easter Company mark with no name beside it.
   let facePicture=null,faceGeneration=0;
   const firstLetter=value=>{
    const letter=[...String(value||'').trim()][0];
    return letter?letter.toUpperCase():'';
   };
   const setInitial=letter=>{initial.textContent=letter;face.classList.toggle('web-account-face-mark',!letter);};
   const showPicture=(src,pixelated=false)=>{
    // The cropped head is 32 canvas pixels of an 8x8 texture, and this slot is 16: the same
    // nearest-neighbour intent the launcher states for its own canvas (site/desktop.css,
    // image-rendering:pixelated). An uploaded picture keeps the ordinary smoothing a photograph
    // wants, so this is a class on this one source and not a rule on the image.
    portrait.classList.toggle('web-account-head',Boolean(src)&&pixelated);
    if(src===facePicture)return;
    facePicture=src;
    face.classList.remove('has-picture');
    if(!src){portrait.hidden=true;portrait.removeAttribute('src');return;}
    portrait.src=src;portrait.hidden=false;
   };
   // A picture that never arrives leaves the tile showing, at the same size, under the same name:
   // a face is never a reason to fail at anything, which is also the launcher's rule.
   portrait.onload=()=>face.classList.add('has-picture');
   portrait.onerror=()=>{portrait.hidden=true;face.classList.remove('has-picture');};
   // The head, cropped exactly as the launcher crops it (site/desktop.js:1251-1257): the skin's
   // 8x8 face at 8,8 and its 8x8 hat overlay at 40,8, each drawn into the same 32x32 canvas with
   // the hat painted over the face, nearest-neighbour, which is how the game renders a player's
   // head. A 64x32 skin of the old shape has both of those squares and crops identically. The
   // result is a data URL, so it travels back through the one image the slot already knows.
   const HEAD_CROP=32;
   const cropHead=skin=>new Promise((resolve,reject)=>{
    const image=new Image();
    image.onload=()=>{
     try{
      const canvas=document.createElement('canvas');canvas.width=HEAD_CROP;canvas.height=HEAD_CROP;
      const ctx=canvas.getContext('2d');
      if(!ctx)throw Error('no canvas');
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(image,8,8,8,8,0,0,HEAD_CROP,HEAD_CROP);
      ctx.drawImage(image,40,8,8,8,0,0,HEAD_CROP,HEAD_CROP);
      const head=canvas.toDataURL('image/png');
      // A canvas that hands back nothing is the same answer as an image that would not decode:
      // no head, and the tile stays.
      if(!head.startsWith('data:image/png;base64,'))throw Error('no crop');
      resolve(head);
     }catch(error){reject(error);}
    };
    image.onerror=()=>reject(Error('the skin did not decode'));
    image.src=skin;
   });
   // One skin crops to one head, so the work is done once per skin: the control is painted again
   // on every account broadcast, and re-decoding the same texture each time would be wasted work
   // and a second asynchronous paint for nothing. The promise itself is what is remembered, so
   // two paints while a crop is in flight share it; a skin that cannot be decoded is remembered
   // as no head at all rather than retried on every broadcast.
   let headSkin=null,headPending=null;
   const headFor=skin=>{
    if(headSkin!==skin){headSkin=skin;headPending=cropHead(skin).catch(()=>'');}
    return headPending;
   };
   const showFace=(user,generation)=>{
    const picture=typeof user.picture==='string'?user.picture:'';
    if(picture){showPicture(picture);return;}
    const skin=typeof user.skin==='string'?user.skin:'';
    if(!skin){showPicture('');return;}
    void headFor(skin).then(head=>{if(generation===faceGeneration)showPicture(head,true);});
   };
   // The words 'Company member' are publicAccount's last resort for an account with no name at all
   // (site/account-client.mjs:274): it is a sentence, not a name, so it is never lettered.
   const GENERIC_NAME='Company member';
   const paintFace=next=>{
    const user=next.account;
    // A saved session this load cannot paint yet: the account exists and nothing else about it is
    // known, so the slot is the Easter Company mark and the control carries no name. It is never the
    // tile's letter, because no name has been read to take a letter from.
    const waiting=!user&&next.startupReady===false;
    // A crop still in flight belongs to the account this paint is replacing, and it must never
    // arrive on top of the next account's face: one counter, read once, decides that.
    const generation=++faceGeneration;
    face.hidden=!user&&!waiting;
    // The narrowest header gives the face the control and takes the name away; signed out there is
    // no face, so the name must stay - the control is never an empty box.
    account.classList.toggle('web-account-with-face',Boolean(user)||waiting);
    if(!user){setInitial('');showPicture(null);return;}
    const called=typeof user.name==='string'&&user.name!==GENERIC_NAME?user.name:'';
    // The letter is the display name's first character, then the Minecraft name's, then the
    // username's: the same order as the label, because `name` is that mapping. An account with no
    // name at all - the moment between a provider sign-in and a first name - is the mark, because
    // a C for 'Company member' would be a letter that means nothing.
    setInitial(firstLetter(called));
    showFace(user,generation);
   };
   const paint=next=>{
    current=next;auth.render(next);profile?.syncLock();linked?.syncLock();
    // A saved session that has not been read yet is the third state of this control, and it is the
    // one Owen met on a cold refresh: it says neither `Sign in`, which the seam would refuse to honour
    // ("Sign out before using another account.", site/web-account.mjs), nor a name it does not have.
    // It is the Easter Company mark, disabled, until /me settles. No new words: the accessible name is
    // the one the signed-in control uses, and the control says why it is inert with aria-busy.
    const waiting=!next.account&&next.startupReady===false;
    // The name the player is called, not the handle they type - the launcher's own rule (site/desktop.js,
    // accountName, after Owen's same report there on 2026-10-19): publicAccount gives the display
    // name, then the Minecraft name, then the username. Owen, 2026-10-26, on this site: the nav showed
    // `oceaster` where the launcher shows `OCEaster`.
    name.textContent=next.account?next.account.passwordRequired?'Finish setup':next.account.name||GENERIC_NAME:waiting?'':'Sign in';
    paintFace(next);
    account.setAttribute('aria-label',waiting?'Account options':next.account?.passwordRequired?'Finish account setup':next.account?'Account options':'Sign in or create an Easter Company account');
    account.setAttribute('aria-busy',String(waiting));
    account.setAttribute('aria-expanded',String(menu.matches(':popover-open')));
    account.disabled=next.accountWorking===true||waiting;
    if(!next.account&&!waiting){menu.hidePopover();document.querySelector('#company-profile')?.close();document.querySelector('#company-linked-accounts')?.close();}
   };
   menu.addEventListener('toggle',()=>account.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
   webAccount.subscribe(paint);
   await webAccount.ready;paint(webAccount.getState());
 }
}
