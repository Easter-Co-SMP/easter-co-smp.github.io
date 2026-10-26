import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebAccount} from '../site/web-account.mjs';
import {AccountClient} from '../site/account-client.mjs';
const account={id:8,username:'fixture_player',passwordRequired:false,providers:['steam'],microsoftLinked:false};
const signed={account,session:{token:'fixture-only',expiresAt:Date.now()+60000}};
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};};
test('storage denied at property access still allows an in-memory sign-in and sign-out',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw new Error('Storage denied');}});
 try{
  const bridge=createWebAccount({client:{loginPassword:async()=>signed,logout:async()=>{}}});
  await bridge.ready;assert.equal((await bridge.loginCompany('fixture_player','fixture')).ok,true);
  assert.equal(bridge.getState().account.username,'fixture_player');await bridge.signOut();
 }finally{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete globalThis.sessionStorage;}
});
test('sign-out invalidates an in-flight private orders read and removes persisted session',async()=>{
 let resolve;const storage=memory();
 const bridge=createWebAccount({storage,client:{loginPassword:async()=>signed,logout:async()=>{},storeOrders:()=>new Promise(done=>{resolve=done;})}});
 await bridge.loginCompany('fixture_player','fixture');
 const pending=bridge.storeOrders();await new Promise(done=>setTimeout(done,0));
 await bridge.signOut();resolve({orders:[]});
 await assert.rejects(pending);
 assert.equal(bridge.getState().account,null);assert.equal(storage.values.size,0);
});
test('a signed-out store gets the sign-in sentence and makes no API call',async()=>{
 const bridge=createWebAccount({storage:null,client:{storeCatalogue(){throw Error('must not be called');}}});
 await assert.rejects(bridge.storeCatalogue(),{message:'Sign in to buy.'});
});
test('a foreign checkout destination is refused before navigation',async()=>{
 let navigated=false;
 const bridge=createWebAccount({storage:null,navigate:()=>{navigated=true;},client:{loginPassword:async()=>signed,logout:async()=>{},storeCheckout:async()=>({url:'https://evil.invalid/pay',sessionId:'fixture',product:'fixture'})}});
 await bridge.loginCompany('fixture_player','fixture');
 await assert.rejects(bridge.storeCheckout('fixture'),{message:'The store is unavailable right now.'});
 assert.equal(navigated,false);await bridge.signOut();
});
test('browser transport refuses redirects and uses no ambient cookies or referrer',async()=>{
 let seen;const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{seen={url,options};return {ok:true,status:200,json:async()=>({providers:[]})};};
 try{await new AccountClient().providers();assert.equal(seen.options.credentials,'omit');assert.equal(seen.options.redirect,'error');assert.equal(seen.options.referrerPolicy,'no-referrer');}
 finally{globalThis.fetch=oldFetch;}
});
