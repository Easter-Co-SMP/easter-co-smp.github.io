import {webAccount} from './web-account.mjs';
import {createCompanyAuth} from './company-auth.mjs';
if(webAccount){
 document.documentElement.classList.add('web-mode');
 const base=new URL('./',import.meta.url);
 // Stripe's return URL is a routing signal only. Orders are re-read from the API;
 // a visitor forging the fragment cannot create a payment-success claim.
 if(/^#store-paid(?:\/|$)/.test(location.hash)||location.hash==='#store-cancelled'){
  const destination=new URL('store/',base);destination.hash=location.hash==='#store-cancelled'?'catalogue':'orders';
  location.replace(destination.href);
 }else{
  const nav=document.querySelector('.site-header nav');
  if(nav){
   if(!nav.querySelector('a[href$="store/"]')){const link=document.createElement('a');link.href=new URL('store/',base).href;link.textContent='Store';link.className='store-entry';nav.append(link);}
   const account=document.createElement('button');account.type='button';account.className='web-account-nav';account.textContent='Sign in';account.disabled=true;nav.append(account);
   const menu=document.createElement('div');menu.id='web-account-menu';menu.className='desktop-profile-menu';menu.setAttribute('popover','auto');menu.setAttribute('aria-label','Account options');document.body.append(menu);
   const notice=document.createElement('p');notice.className='web-account-notice';notice.setAttribute('role','alert');notice.hidden=true;menu.append(notice);
   let current=webAccount.getState(),profile=null,linked=null;
   // Microsoft signs in on its own page. site/account/ starts the browser flow, is the address
   // Microsoft sends the browser back to, and is where a Company session for a Microsoft account
   // is made; doc/BROWSER_SIGN_IN.md in the cloud repository is the contract. Both entry points
   // below go there rather than answering with a sentence about the launcher, which stopped
   // being true when that page shipped. Linking stays a launcher action: the exchange is a
   // sign-in, and it has no link mode for an account that is already signed in.
   const signInMicrosoft=async options=>{
    if(options?.link)return {ok:false,error:'Connect Microsoft in the launcher.'};
    const destination=new URL('account/',base);destination.search='provider=microsoft';
    location.assign(destination.href);
    return {ok:true};
   };
   const auth=createCompanyAuth({desktop:webAccount,signInMicrosoft});
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
   const paint=next=>{
    current=next;auth.render(next);profile?.syncLock();linked?.syncLock();
    account.textContent=next.account?.passwordRequired?'Finish setup':next.account?.username||'Sign in';
    account.setAttribute('aria-label',next.account?.passwordRequired?'Finish account setup':next.account?'Account options':'Sign in or create an Easter Company account');
    account.setAttribute('aria-expanded',String(menu.matches(':popover-open')));
    account.disabled=next.accountWorking===true;
    if(!next.account){menu.hidePopover();document.querySelector('#company-profile')?.close();document.querySelector('#company-linked-accounts')?.close();}
   };
   menu.addEventListener('toggle',()=>account.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
   webAccount.subscribe(paint);
   await webAccount.ready;paint(webAccount.getState());
  }
 }
}
