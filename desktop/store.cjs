'use strict';
// The Community store, main-process half. Three routes and no fourth, all on the account
// client (accounts.cjs, OPERATIONS): the catalogue, one checkout press, and the player's
// orders. Nothing here fetches: it shapes what the account service sent into exactly the
// fields the page renders, and it decides which of two fixed sentences a refusal says.
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
// The key the page asked for, or a refusal. This is a SHAPE check and nothing more: this half
// does not keep a catalogue, so it cannot tell a key the server offered from one it never did.
// What is checked here is that the renderer sent a product key at all - a lower-case identifier
// and no price, amount, id or URL - and the server is the authority on which keys are for sale:
// an unknown one is its own 400 unknown_product, which refusal() turns into the one sentence.
function productKey(value){
 if(typeof value!=='string'||!PRODUCT_KEY.test(value))throw unavailable();
 return value;
}
module.exports={SENTENCES,unavailable,signedOut,refusal,catalogue,checkout,orders,productKey,PRODUCT_KEY};
