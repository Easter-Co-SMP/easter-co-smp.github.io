'use strict';
// The Community store, main-process half. Three routes and no fourth, all on the account
// client (accounts.cjs, OPERATIONS): the catalogue, one checkout press, and the player's
// orders. Nothing here fetches: it shapes what the account service sent into exactly the
// fields the page renders, and it decides which of two fixed sentences a refusal says.
//
// It also owns the SHAPE of the snapshot the launcher keeps so opening the store is instant
// (below, "The snapshot the page paints before it asks anything"). The snapshot adds no route,
// no command to the service and no field to either frozen answer: it is those same two answers,
// validated by the same two functions, written to a file beside the session cache.
//
// Why the shaping lives here and not in the renderer: site/ is a plain web page, and a page
// that received the service's own body could print a number, a word or an address this
// launcher never agreed to show. Every value below is rebuilt field by field; an answer that
// does not fit is refused rather than guessed at.
//
// THE TWO SENTENCES ARE OWEN'S, character for character (ticket 45bb99ad). The store prints no
// other failure copy: a signed-out player is told to sign in, and every other failure — the
// service unreachable, no such route yet, a product not for sale, the store not configured,
// Stripe refusing — is "The store is unavailable right now." That is the honest limit of what
// this half knows: it cannot tell an operator's missing Stripe key from a sleeping database,
// and it must not pretend to.
const {stripeCheckoutURL}=require('./security.cjs');
const {AccountError}=require('./accounts.cjs');
const SENTENCES=Object.freeze({
 signedOut:'Sign in to buy.',
 unavailable:'The store is unavailable right now.'
});
// What each product key may look like. The keys are the server's own (`sterling-10`,
// `donation-5`); this is a shape check, not a catalogue: the page never learns a key the server
// did not send, and a key-shaped string is all storeCheckout() will forward.
const PRODUCT_KEY=/^[a-z0-9][a-z0-9-]{0,63}$/;
const CURRENCY=/^[A-Z]{3}$/;
// What a product is called and what kind it is, in the bounds a card can draw. A kind is a
// lower-case word (`sterling`, `donation`); its meaning for the card comes from creditPence,
// never from the word, so the two halves cannot disagree about what a product is worth.
const NAME_MAX=80,KIND=/^[a-z][a-z0-9-]{0,31}$/;
const AMOUNT_MAX=100000000,PRODUCTS_MAX=64,ORDERS_MAX=200,SESSION_ID_MAX=200;
const integer=value=>Number.isSafeInteger(value)&&value>=0&&value<=AMOUNT_MAX;
// One refusal, one sentence. `invalid_response` is not a third sentence: an answer this half
// cannot read leaves the player in exactly the position "unavailable" describes.
function unavailable(){return new AccountError('store_unavailable',SENTENCES.unavailable);}
function signedOut(){return new AccountError('store_signed_out',SENTENCES.signedOut);}
// Any failure from the account client becomes one of those two sentences. A 401 is the one
// failure with its own meaning — the session this store is bought against is gone — and the
// page's answer to it is to ask the player to sign in. Everything else, including a 404 from
// a service that has not shipped the route yet, is the store not being available.
function refusal(error){
 if(Number(error?.status)===401||error?.code==='invalid_session')return signedOut();
 return unavailable();
}
function nameOf(value){
 if(typeof value!=='string')return null;
 const name=value.replace(/[\u0000-\u001f\u007f]/g,'').trim();
 return name&&name.length<=NAME_MAX?name:null;
}
function product(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const key=typeof value.key==='string'?value.key:'',
  name=nameOf(value.name),
  currency=typeof value.currency==='string'?value.currency:'',
  kind=typeof value.kind==='string'?value.kind:'',
  creditPence=value.creditPence===undefined?0:value.creditPence;
 if(!PRODUCT_KEY.test(key)||!name||!CURRENCY.test(currency)||!KIND.test(kind))return null;
 if(!integer(value.amountMinor)||!integer(creditPence))return null;
 // The server's order is the catalogue's order; nothing here sorts, filters or dedupes.
 return {key,name,amountMinor:value.amountMinor,currency,kind,creditPence};
}
// GET /v2/accounts/store/catalogue -> {products:[{key,name,amountMinor,currency,kind,creditPence}]}
// An empty list is refused rather than rendered: this store sells four products, so nothing on
// sale is an answer this half cannot explain, and a shop that silently draws no cards would
// look like a bug rather than a shut door.
function catalogue(payload){
 const list=payload?.products;
 if(!Array.isArray(list)||!list.length||list.length>PRODUCTS_MAX)throw unavailable();
 const products=list.map(product);
 if(products.some(entry=>!entry))throw unavailable();
 const keys=new Set(products.map(entry=>entry.key));
 if(keys.size!==products.length)throw unavailable();
 return {products};
}
// POST /v2/accounts/checkout -> {url, sessionId, product}
// The URL is the only thing this half acts on, and it is checked against the launcher's own
// in-app payment rule before it is ever loaded into a window this process owns: HTTPS on the
// Stripe Checkout host and nothing else. It is checked again in desktop/main.cjs, where the
// window is made, because a service answer is the far side of a network either way.
function checkout(payload){
 let url;
 try{url=stripeCheckoutURL(payload?.url);}
 catch{throw unavailable();}
 const sessionId=payload?.sessionId,
  key=payload?.product;
 if(typeof sessionId!=='string'||!sessionId||sessionId.length>SESSION_ID_MAX)throw unavailable();
 if(typeof key!=='string'||key.length>64)throw unavailable();
 return {url,sessionId,product:key};
}
// One order, in the frozen shape. `paid` and `delivered` are the server's two claims and are
// read as booleans only: a missing or unreadable flag is false, so this launcher can never say
// "Paid" or "In the game" on evidence it did not receive.
function order(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const sessionId=value.sessionId,
  productKey=typeof value.product==='string'?value.product:'',
  currency=typeof value.currency==='string'?value.currency:'',
  creditPence=value.creditPence===undefined?0:value.creditPence,
  createdAt=typeof value.createdAt==='string'?value.createdAt:'';
 if(typeof sessionId!=='string'||!sessionId||sessionId.length>SESSION_ID_MAX)return null;
 if(!PRODUCT_KEY.test(productKey)||!CURRENCY.test(currency))return null;
 if(!integer(value.amountMinor)||!integer(creditPence))return null;
 if(!Number.isFinite(Date.parse(createdAt)))return null;
 return {sessionId,product:productKey,amountMinor:value.amountMinor,currency,paid:value.paid===true,delivered:value.delivered===true,creditPence,createdAt:new Date(createdAt).toISOString()};
}
// GET /v2/accounts/store/orders -> {orders:[...]}, newest or old as the server listed them. An
// empty list is a real answer here — a player with no purchases — and the page says so.
function orders(payload){
 const list=payload?.orders;
 if(!Array.isArray(list)||list.length>ORDERS_MAX)throw unavailable();
 const shaped=list.map(order);
 if(shaped.some(entry=>!entry))throw unavailable();
 return {orders:shaped};
}
// ---- The snapshot the page paints before it asks anything --------------------
//
// Owen, 2026-10-23: *"The store pages should perhaps even pre-render the store page, and cache
// client side on launcher start-up so opening the store is instant."* The launcher asks the
// account service for the catalogue and the player's own orders once, at startup, and keeps the
// answer in a file beside the session cache (`desktop/main.cjs`, `readStoreSnapshot` and
// `prefetchStore`). Opening the store then paints that answer immediately and revalidates behind
// the player's eyes.
//
// WHAT A SNAPSHOT IS NOT. It is not a price. The two shapes it holds are the frozen wire shapes
// above and nothing else - `catalogue()` and `orders()` are what validate them on the way in AND
// on the way out of the file, so a file cannot hold a product this half would refuse from the
// service - and the Buy press still goes to the service, which resolves the price from its own
// configuration. A stale snapshot can therefore make a card out of date; it can never change what
// is charged. Nor is it a session: it holds no token of any kind, only what the player may look
// at, and the page receives it through the launcher's own bridge rather than from a file.
const SNAPSHOT_VERSION=1;
// How old a snapshot may be before it is not used at all. The catalogue is upstream of money:
// every card prints the price the account service last sent, and a price is the one number on
// this page a player will compare against a charge. The launcher's own Company session lives 24
// hours (`accounts.cjs`; `renewCompany` re-proves it every six hours, doc/launcher-states.md), so
// past one session lifetime the snapshot describes a shop that has been re-read - at startup and
// on every renewal - at least four times since, and a launcher that has not managed one of those
// in a day is not one whose cache should stand in for an answer. The bound is also what keeps the
// page honest with nothing new to say: an older file is discarded and the store waits for the
// service exactly as it did before this snapshot existed.
const SNAPSHOT_MAX_AGE_MS=24*60*60*1000;
// The fields of the file, in the order they are written. This list is the whole whitelist: a
// token, a refresh token, a Stripe id, a price id or an account's email has no field here to
// travel in, and `tests/desktop/store-snapshot.test.cjs` proves it by handing the builder a whole
// service answer and asserting none of those values is anywhere in the text it produces.
const SNAPSHOT_FIELDS=Object.freeze(['version','writtenAt','accountId','catalogue','orders']);
// The reasons a file is not read. Every one but `absent` means the file must go: it can never be
// used again, and leaving it would make every later start repeat the same discard.
const SNAPSHOT_DISCARDED=Object.freeze(['absent','unreadable','version','stale','incomplete']);
const ACCOUNT_ID_MAX=64;
function moment(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;}
function ownerId(value){
 if(value===null||value===undefined)return null;
 if(typeof value==='number'&&Number.isFinite(value))return String(value);
 if(typeof value!=='string')return null;
 const id=value.trim();
 return id&&id.length<=ACCOUNT_ID_MAX?id:null;
}
// The record, or null when this half has nothing it could honestly paint from. Every key is
// written from `SNAPSHOT_FIELDS`, so nothing else can be in the object, and both blocks are
// re-shaped by the same two functions the wire answers go through.
//
// The orders are the account's own and are written only for the account they belong to: a
// snapshot with no `accountId` is a signed-out snapshot and is a catalogue only, never orders.
function snapshot({writtenAt,accountId=null,products,orders:rows=null}={}){
 const at=moment(writtenAt);
 if(!at)return null;
 const owner=ownerId(accountId);
 let shop=null,list=null;
 try{
  shop=catalogue({products}).products;
  if(rows!==null){
   if(!owner)return null;
   list=orders({orders:rows}).orders;
  }
 }catch{return null;}
 return {version:SNAPSHOT_VERSION,writtenAt:at,accountId:owner,catalogue:{products:shop},orders:list?{orders:list}:null};
}
// Is this snapshot still young enough to paint? The same bound the read applies, asked again at
// the moment it is published, because a launcher left open for a day holds its copy in memory
// long after the file it came from would have been refused.
function fresh(value,{now=Date.now()}={}){
 if(!value)return false;
 const at=moment(value.writtenAt);
 return Boolean(at)&&Math.max(0,now-Date.parse(at))<=SNAPSHOT_MAX_AGE_MS;
}
// Read a file's text. `accountId` is the account this launcher holds right now (null when nobody
// is signed in). The catalogue is not any account's private data, so it survives an account
// change; the orders are, so they are published only to the account they were written for.
// `accountId` is answered as well, so the caller can tell that a file written for someone else is
// on disk and rewrite it rather than keep it.
function parseSnapshot(raw,{now=Date.now(),accountId=null}={}){
 if(typeof raw!=='string'||!raw.trim())return {snapshot:null,reason:'absent',accountId:null};
 let stored;
 try{stored=JSON.parse(raw);}catch{return {snapshot:null,reason:'unreadable',accountId:null};}
 if(!stored||typeof stored!=='object'||Array.isArray(stored))return {snapshot:null,reason:'unreadable',accountId:null};
 if(stored.version!==SNAPSHOT_VERSION)return {snapshot:null,reason:'version',accountId:null};
 const writtenAt=moment(stored.writtenAt);
 // A moment in the future - a clock that moved backwards between two runs - is read as age zero
 // for the same reason the session cache reads it that way: this machine wrote the file.
 if(!writtenAt)return {snapshot:null,reason:'stale',accountId:null};
 if(Math.max(0,now-Date.parse(writtenAt))>SNAPSHOT_MAX_AGE_MS)return {snapshot:null,reason:'stale',accountId:null};
 const record=snapshot({writtenAt,accountId:stored.accountId,products:stored.catalogue?.products,orders:stored.orders?.orders??null});
 if(!record)return {snapshot:null,reason:'incomplete',accountId:null};
 const mine=record.accountId!==null&&accountId!==null&&String(record.accountId)===String(accountId);
 return {
  snapshot:{writtenAt:record.writtenAt,products:record.catalogue.products,orders:mine?record.orders?.orders??null:null},
  reason:null,
  accountId:record.accountId
 };
}
// What the page is handed: the same objects the bridge's two reads answer with, so a warm paint
// and a confirmed paint draw the same rows from the same fields. `writtenAt` is the file's own
// moment and the only field this shape adds. `orders` stays null when no orders were ever cached:
// an empty list would make the orders view print "No orders yet." from a file, which is a claim
// about this account that only the service may make.
function published(value,{now=Date.now()}={}){
 if(!fresh(value,{now}))return null;
 return {writtenAt:value.writtenAt,products:value.products,orders:Array.isArray(value.orders)&&value.orders.length?value.orders:null};
}
// The key the page asked for, or a refusal. This is a SHAPE check and nothing more: this half
// does not keep a catalogue, so it cannot tell a key the server offered from one it never did.
// What is checked here is that the renderer sent a product key at all - a lower-case identifier
// and no price, amount, id or URL - and the server is the authority on which keys are for sale:
// an unknown one is its own 400 unknown_product, which refusal() turns into the one sentence.
function productKey(value){
 if(typeof value!=='string'||!PRODUCT_KEY.test(value))throw unavailable();
 return value;
}
module.exports={SENTENCES,unavailable,signedOut,refusal,catalogue,checkout,orders,productKey,PRODUCT_KEY,SNAPSHOT_VERSION,SNAPSHOT_MAX_AGE_MS,SNAPSHOT_FIELDS,SNAPSHOT_DISCARDED,snapshot,parseSnapshot,published,fresh};
