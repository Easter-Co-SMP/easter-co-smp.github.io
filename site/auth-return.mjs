// GENERIC RETURN TARGETS: how another household app sends the browser here to sign in, and gets it
// back afterwards.
//
// Owen, 2026-10-26: "easter-co-smp.github.io should have generic flags to handle redirects and
// other e apps using the same auth flows." This site already owns the sign-in flows - the Microsoft
// callback on /account/, the provider broker, the direct Company form, the splash a finishing window
// shows - and what it did not own was the answer to "and then where?". Every success went to the
// site root, so a second app that wanted the household's identity had to invent a flow of its own.
// It does not any more.
//
// WHAT MAY BE A TARGET, frozen by the owner on 2026-10-26. Only first-party addresses:
//
//   https, with a host that is easter.company or a subdomain of it,
//   https, with a host that is char-istrian.ts.net or a subdomain of it,
//   the easter-company: scheme, which is the launcher's own deep link.
//
// Owen wrote "chat-istrian"; the domain the household's tailnet actually serves is
// char-istrian.ts.net - measured from e-server's own configured public URL,
// https://easter-server.char-istrian.ts.net:8443/ - so that is the suffix implemented here and the
// one e-server's side of this contract builds against. It is one constant (TAILNET_DOMAIN below):
// a second domain is one line, not a second rule. Matching is on label boundaries and never on a
// substring, so "char-istrian.ts.net.evil.example" and "evil-char-istrian.ts.net" are both
// refused; and the host has to be spelled the way the URL parser already reads it, which is what
// refuses a trailing dot, an upper-case spelling and a Unicode look-alike that would only become
// an allowed host after normalisation.
//
// TWO WAYS TO ASK, ONE ANSWER:
//
//   ?app=<id>            an id from the ALLOWED table below. Short, and the only form e-server needs.
//   ?next=<absolute URL> any absolute URL that passes the same validator, refused otherwise.
//
// Either is resolved once and stored once, in this tab's sessionStorage under RETURN_KEY; the tab
// then signs in however it likes - Microsoft through /account/, a provider popup, the direct Company
// form - and the sign-in that succeeds consumes it. Two places consume it, both of them where a
// sign-in is answered today: signedIn() on /account/ (site/account/account.mjs) and the site root's
// `/?signed-in=1` hand-back (site/index.html's head script). Reading it deletes it, so the return
// happens exactly once and a second visit goes to '/' as it always did. A visit carrying neither
// parameter writes nothing and behaves exactly as it did before this module existed.
//
// A REFUSED SIGN-IN DROPS THE REQUEST. A cancellation, the authority's own refusal and a failed
// exchange all leave the visitor on /account/, with the sentence and with no stored target, so a
// later sign-in in that tab cannot redeem an intent that was abandoned. A retry is a fresh visit
// from the app, carrying its parameter again.
//
// A POPUP CLOSES ITSELF AND NAVIGATES NOWHERE. Only an ordinary tab leaves for the target: the
// Microsoft flow hands the whole tab back, and a window this site opened for a provider closes
// itself (site/index.html's head script). A popup that followed the target would be this site
// sending a window it opened to somebody else's address while the player's own tab sat still.
//
// WHAT THIS MUST NEVER BECOME: A TOKEN HANDOFF. No token, session, password or one-time code is
// ever placed in a redirect target, and none may be added here. The parameter means "bring this
// browser back" and nothing else: this module holds no account state, imports nothing that has
// any, and the only value it stores is the URL. An app that needs its own session gets it from its
// own flow against the account API - e-server already does, with core/company_accounts.py - and the
// flag tells that app where to continue, never what it may do. If a future need looks like "just
// put the session in the URL", the answer is the API, not this file.
// doc/auth-return.md is the written record of this contract, for the app being built against it.

// The one key this tab stores the target under. sessionStorage and not localStorage: the return
// belongs to the tab that started the sign-in and must not outlive it or follow a new one. It is
// the same-origin partition that makes the value survive the round trip through Microsoft and back
// - written on one document of this origin and read on the next one.
export const RETURN_KEY='easter-company-auth-return-v1';

// THE ALLOW-LISTED APPS: one entry per first-party app, as scheme, host, port (only when it is not
// the default for the scheme) and path. `?app=<id>` may only ever name one of these, and the URL a
// row builds is run through the same validator as any other target - so a row that stopped being a
// legal address would refuse itself here rather than send a browser somewhere unlisted.
export const ALLOWED={
 'e-server':{scheme:'https:',host:'easter-server.char-istrian.ts.net',port:'8443',path:'/'},
 'launcher':{scheme:'easter-company:',host:'signed-in',path:''}
};

const COMPANY_DOMAIN='easter.company';
const TAILNET_DOMAIN='char-istrian.ts.net';
const HTTPS='https:';
const APP_SCHEME='easter-company:';
// The authority as it was WRITTEN, before any normalisation: everything between the scheme and the
// first path, query or fragment character. A backslash is excluded because the parser reads it as a
// slash in an https URL, so it can never be part of the host the parser saw.
const AUTHORITY=/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#\\]*)/;
// A redirect target is an address, not a document: anything longer than this is not one of ours.
const LONGEST=2048;

// A host is under a suffix only on a label boundary: the suffix itself, or the suffix with at least
// one label of its own in front of it. Never a substring, so "evil-char-istrian.ts.net" is a
// different host and stays refused.
const under=(hostname,suffix)=>hostname===suffix||hostname.endsWith('.'+suffix);

// THE VALIDATOR. A pure function of its argument: no storage, no location, no imports, so what a
// target may be is decided in one place and can be unit-tested without a browser. It answers with
// the normalised absolute URL, or null for everything that is not named above - which is the whole
// of what "fail closed" needs, because a caller with a null has nowhere to go but today's answer.
export function resolve(target){
 if(typeof target!=='string')return null;
 const text=target.trim();
 if(!text||text.length>LONGEST)return null;
 let url;
 try{url=new URL(text);}catch{return null;}
 // A URL carrying a username or password is refused before anything else is considered: the
 // authority may not hold a credential here, and "https://easter.company@evil.example/" is exactly
 // the shape that reads as ours and is not.
 if(url.username||url.password)return null;
 // THE SPELLING CHECK. What a browser lower-cases, strips a trailing dot from or maps through IDNA
 // is not what the allow-list names, so a host that only BECOMES an allowed host once normalised is
 // refused. Written and parsed authorities have to be the same string: that is what refuses
 // "https://EASTER.COMPANY/", "https://easter.company./", "%2E" in a host, and a look-alike whose
 // spelling is not ASCII.
 const written=AUTHORITY.exec(text);
 if(!written||written[1]!==url.host)return null;
 // The launcher's own scheme, which is a deep link into an app we ship: any non-empty host is a
 // path that app chooses to open. Nothing else is a scheme this module can answer.
 if(url.protocol===APP_SCHEME)return url.host?url.href:null;
 if(url.protocol!==HTTPS)return null;
 return under(url.hostname,COMPANY_DOMAIN)||under(url.hostname,TAILNET_DOMAIN)?url.href:null;
}

// The address an allow-listed app id names, or null for an id that is not in the table above. The
// built address goes back through resolve(), so the table cannot describe anything the validator
// would refuse.
export function appUrl(id){
 if(typeof id!=='string'||!Object.hasOwn(ALLOWED,id))return null;
 const entry=ALLOWED[id];
 const built=entry.scheme+'//'+entry.host+(entry.port?':'+entry.port:'')+(entry.path||'');
 return resolve(built);
}

// What this address asks for, if anything: an allow-listed app id first, then an absolute URL that
// passes the validator. Everything else - an unknown id, a refused URL, no parameter at all - is
// null, and a null means "this visit is the visit it always was".
export function requestedTarget(search){
 let params;
 try{params=new URLSearchParams(typeof search==='string'?search:'');}catch{return null;}
 const id=params.get('app');
 if(id!==null){
  const named=appUrl(id);
  if(named)return named;
 }
 const next=params.get('next');
 return next===null?null:resolve(next);
}

// sessionStorage, unless a caller hands one over (the unit tests do). A storage that is denied -
// a blocked cookie jar, a locked-down profile - is a storage that answers nothing rather than a
// page that fails: the visit then behaves exactly as it does with no parameter.
function storageOf(storage){
 if(storage!==undefined)return storage;
 try{return globalThis.sessionStorage;}catch{return null;}
}

// Store the target this address asks for, once, and answer with what was stored. A visit with no
// parameter writes nothing and leaves any target an earlier page of this tab stored alone; the
// newest request is the tab's intent, so a request that does resolve replaces a target left behind
// by a sign-in that never finished. A storage that will not take the value costs the return, not
// the sign-in.
export function rememberReturnTarget(search,storage){
 const target=requestedTarget(search);
 if(!target)return null;
 const box=storageOf(storage);
 if(!box)return null;
 try{box.setItem(RETURN_KEY,target);}catch{return null;}
 return target;
}

// Consume it: read, delete, and answer with the address this tab is to be sent back to - or null.
// The delete happens whatever the value turns out to be, so one read is one return and a hand-edited
// storage entry is dropped rather than followed (resolve() is applied to what was stored, exactly as
// it was applied to what was asked for).
export function takeTarget(storage){
 const box=storageOf(storage);
 if(!box)return null;
 let kept=null;
 try{kept=box.getItem(RETURN_KEY);box.removeItem(RETURN_KEY);}catch{return null;}
 return resolve(kept);
}

// Drop it without using it. This is what a refused sign-in does: the request was not answered, so
// it is not carried into whatever the visitor does next in this tab.
export function forgetTarget(storage){
 const box=storageOf(storage);
 if(!box)return;
 try{box.removeItem(RETURN_KEY);}catch{}
}
