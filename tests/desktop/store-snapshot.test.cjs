'use strict';
// The store snapshot, as a file: its whitelist, its bound, the two frozen wire shapes it holds,
// and the rules that discard it (ticket 9f6d7b16; doc/launcher-store.md, "Opening the store
// instantly"). These are pure functions, so they are proven here rather than through a launch.
// What a real main process does with the file is the journey
// `tests/desktop/store-prefetch.electron.mjs`; what the page draws from it - the instant paint,
// the pending-then-confirmed wording and the repaint-only-on-a-difference rule - is
// `tests/store-browser.mjs`.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const STORE=require('../../desktop/store.cjs');
const root=path.resolve(__dirname,'../..');
const NOW=Date.parse('2026-10-23T12:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
// The four live products exactly as the account service sends them (doc/launcher-store.md, "The
// products"). Their prices are the service's: nothing in this test file is a copy of a price the
// launcher would print on its own.
const PRODUCTS=[
 {key:'sterling-10',name:'10 Sterling',amountMinor:149,currency:'USD',kind:'sterling',creditPence:1000},
 {key:'sterling-100',name:'100 Sterling',amountMinor:695,currency:'USD',kind:'sterling',creditPence:10000},
 {key:'sterling-1000',name:'1000 Sterling',amountMinor:2999,currency:'USD',kind:'sterling',creditPence:100000},
 {key:'donation-5',name:'Keep the lights on',amountMinor:500,currency:'USD',kind:'donation',creditPence:0}
];
const ORDERS=[
 {sessionId:'cs_test_a1',product:'sterling-100',amountMinor:695,currency:'USD',paid:true,delivered:false,creditPence:10000,createdAt:'2026-10-23T10:00:00.000Z'},
 {sessionId:'cs_test_a2',product:'donation-5',amountMinor:500,currency:'USD',paid:false,delivered:false,creditPence:0,createdAt:'2026-10-22T10:00:00.000Z'}
];
// Everything the launcher can hold that must never reach a file: the account's own session, the
// player's addresses and identifiers, and the fields a service answer carries that this half does
// not print. Each is distinctive enough to be found in the text if it ever travelled.
const SECRETS={
 accessToken:'fixture-secret-company-token-9b1c',
 refreshToken:'fixture-secret-refresh-token-4e2a',
 xstsToken:'fixture-secret-xsts-token-77d0',
 password:'fixture-secret-password-hunter2',
 email:'owen@example.test',
 serverAddress:'smp.easter.company:25565',
 steamId64:'76561198000000001',
 microsoftSubject:'fixture-secret-uhs-0123456789abcdef',
 stripePriceId:'price_fixture_1',
 checkoutUrl:'https://checkout.stripe.com/c/pay/cs_test_fixture'
};
const WHOLE_PRODUCT={...PRODUCTS[0],description:'a description the page never prints',stripePriceId:SECRETS.stripePriceId,token:SECRETS.accessToken};
const WHOLE_ORDER={...ORDERS[0],email:SECRETS.email,stripePriceId:SECRETS.stripePriceId,receiptUrl:SECRETS.checkoutUrl};
const ACCOUNT_ID=7;
const record=extra=>STORE.snapshot({writtenAt:iso(NOW),accountId:ACCOUNT_ID,products:[WHOLE_PRODUCT],orders:[WHOLE_ORDER],...extra});
const textOf=value=>JSON.stringify(value);
const objectKeys=node=>{
 const keys=[];
 const walk=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  for(const [key,inner] of Object.entries(value)){keys.push(key);walk(inner);}
 };
 walk(node);
 return keys;
};

test('the snapshot holds exactly the named fields and the two frozen wire shapes',async()=>{
 const built=record();
 assert.deepEqual(Object.keys(built),[...STORE.SNAPSHOT_FIELDS],'the file is the whitelist, in order');
 assert.equal(built.version,STORE.SNAPSHOT_VERSION,'the file names its own version, so a build that changes the shape can refuse it');
 assert.equal(built.writtenAt,iso(NOW),'and the moment the answer was written, which is what its age is measured from');
 assert.equal(built.accountId,String(ACCOUNT_ID),'and the account whose orders it holds, as the string the ids are compared as');
 // The blocks are the same two shapes the bridge's reads answer with - validated by the same two
 // functions, so a file can never hold a product or an order the service could not have sent.
 assert.deepEqual(built.catalogue,STORE.catalogue({products:[WHOLE_PRODUCT]}),'the catalogue is exactly what the catalogue route shapes');
 assert.deepEqual(built.orders,STORE.orders({orders:[WHOLE_ORDER]}),'and the orders are exactly what the orders route shapes');
 assert.deepEqual(built.catalogue.products,[{key:'sterling-10',name:'10 Sterling',amountMinor:149,currency:'USD',kind:'sterling',creditPence:1000}],'nothing the page does not print travels with a product');
 assert.deepEqual(built.orders.orders[0],{sessionId:'cs_test_a1',product:'sterling-100',amountMinor:695,currency:'USD',paid:true,delivered:false,creditPence:10000,createdAt:'2026-10-23T10:00:00.000Z'},'and nothing but the frozen order shape travels with an order');
});

test('no credential, address or service-only field can reach the snapshot',async()=>{
 // A whole service answer, a whole account's session and a handful of extra top-level fields an
 // optimistic caller might hand the builder. It reads its own names off the argument and ignores
 // all of it.
 const built=record({token:SECRETS.accessToken,account:SECRETS,email:SECRETS.email,server:SECRETS.serverAddress,steamId64:SECRETS.steamId64});
 assert(built,'a whole answer still builds a snapshot: the extra fields are simply not fields');
 const text=textOf(built);
 for(const [name,value] of Object.entries(SECRETS))assert(!text.includes(value),name+' must never be written to the store snapshot');
 // The keys too, not only the values: `refreshToken: null` would still be a field the next reader
 // has to wonder about.
 const keys=objectKeys(built);
 const allowed=new Set([...STORE.SNAPSHOT_FIELDS,'products','orders','key','name','amountMinor','currency','kind','creditPence','sessionId','product','paid','delivered','createdAt']);
 for(const key of keys)assert(allowed.has(key),'the snapshot may only carry fields it declares: '+key);
 assert(!/"(refreshToken|accessToken|xstsToken|token|password|email|server|steamId64|stripePriceId|receiptUrl|microsoftSubject)"\s*:/.test(text),'and never a key for one either: '+text);
});

test('a signed-out snapshot is a catalogue and never orders',async()=>{
 assert.equal(STORE.snapshot({writtenAt:iso(NOW),accountId:null,products:PRODUCTS,orders:ORDERS}),null,'orders without an account are refused, not written anonymously');
 const signedOut=STORE.snapshot({writtenAt:iso(NOW),accountId:null,products:PRODUCTS});
 assert.deepEqual(Object.keys(signedOut),[...STORE.SNAPSHOT_FIELDS]);
 assert.equal(signedOut.accountId,null,'nobody owns this snapshot');
 assert.equal(signedOut.orders,null,'and it holds no orders at all');
 assert.deepEqual(signedOut.catalogue.products,STORE.catalogue({products:PRODUCTS}).products,'but it does hold the catalogue, which is not any account\'s own data');
});

test('an answer this half could not draw is refused rather than cached',async()=>{
 assert.equal(record({products:[]}),null,'a catalogue with nothing for sale is not a shop to paint');
 assert.equal(record({products:[{...PRODUCTS[0],currency:'usd'}]}),null,'a currency that is not three capitals');
 assert.equal(record({products:[{...PRODUCTS[0],amountMinor:1.5}]}),null,'a price that is not an integer of minor units');
 assert.equal(record({products:[PRODUCTS[0],{...PRODUCTS[1],key:'sterling-10'}]}),null,'a duplicated key');
 assert.equal(record({orders:[{...ORDERS[0],createdAt:'yesterday'}]}),null,'an order with no parseable moment');
 // `paid` and `delivered` are read as `=== true` rather than refused (desktop/store.cjs): a
 // snapshot may never claim "Paid" on evidence it did not receive, and a word that is not a
 // boolean is not evidence.
 assert.equal(record({orders:[{...ORDERS[0],paid:'yes'}]}).orders.orders[0].paid,false,'a `paid` that is not a boolean is read as not paid');
 assert.equal(record({orders:[{...ORDERS[0],delivered:1}]}).orders.orders[0].delivered,false,'and the same for delivery');
 assert.equal(record({writtenAt:'soon'}),null,'the moment it was written is required');
 assert.equal(record({products:undefined}),null,'and so is a catalogue');
});

test('the file is read back as the answer the page paints, orders included for their own account',async()=>{
 const built=record({products:PRODUCTS,orders:ORDERS});
 const {snapshot,reason,accountId}=STORE.parseSnapshot(textOf(built),{now:NOW+60000,accountId:ACCOUNT_ID});
 assert.equal(reason,null,'a file inside the bound and of this build is read, not discarded');
 assert.equal(accountId,String(ACCOUNT_ID),'the account it was written for is answered, so a caller can tell a foreign file is on disk');
 assert.deepEqual(snapshot,{writtenAt:iso(NOW),products:STORE.catalogue({products:PRODUCTS}).products,orders:STORE.orders({orders:ORDERS}).orders},'and the answer is the two frozen shapes plus the moment, which is the whole contract this page is handed');
});

test('another account\'s snapshot gives the shop and never the orders',async()=>{
 const built=record({products:PRODUCTS,orders:ORDERS});
 const {snapshot,reason}=STORE.parseSnapshot(textOf(built),{now:NOW+60000,accountId:99});
 assert.equal(reason,null,'the file is readable: the catalogue in it is not anybody\'s private data');
 assert.deepEqual(snapshot.products,STORE.catalogue({products:PRODUCTS}).products,'so the shop still paints at once for the next account');
 assert.equal(snapshot.orders,null,'and the purchases of the account that has gone are not published to it');
 // A signed-out launcher (no live account) is the same case with the same answer.
 const out=STORE.parseSnapshot(textOf(built),{now:NOW+60000,accountId:null});
 assert.equal(out.snapshot.orders,null,'and a signed-out page is handed a catalogue only');
});

test('a snapshot older than the bound is ignored, and every other discard names its reason',async()=>{
 const built=record({products:PRODUCTS,orders:ORDERS});
 const at=NOW+STORE.SNAPSHOT_MAX_AGE_MS+1;
 const stale=STORE.parseSnapshot(textOf(built),{now:at,accountId:ACCOUNT_ID});
 assert.deepEqual({snapshot:stale.snapshot,reason:stale.reason},{snapshot:null,reason:'stale'},'a file past 24 h is not used at all - the catalogue is upstream of money');
 assert.equal(STORE.SNAPSHOT_MAX_AGE_MS,24*60*60*1000,'and the bound is one Company-session lifetime, named and argued in desktop/store.cjs');
 const live=STORE.parseSnapshot(textOf(built),{now:NOW+STORE.SNAPSHOT_MAX_AGE_MS-1,accountId:ACCOUNT_ID});
 assert(live.snapshot,'one millisecond inside the bound is still read');
 // A moment in the future is a clock that moved backwards between two runs, and is read as age
 // zero rather than refused: this machine wrote the file.
 assert(STORE.parseSnapshot(textOf(built),{now:NOW-60000,accountId:ACCOUNT_ID}).snapshot,'a file from the future is not stale');
 assert.equal(STORE.parseSnapshot(textOf({...built,version:STORE.SNAPSHOT_VERSION+1}),{now:NOW,accountId:ACCOUNT_ID}).reason,'version','a build that changes the shape discards the old file');
 assert.equal(STORE.parseSnapshot('{"version":1,"writtenAt":"2026-10-23T12:00:00.000Z","catalogue":{"products":[',{now:NOW}).reason,'unreadable','a truncated file');
 assert.equal(STORE.parseSnapshot('',{now:NOW}).reason,'absent','no file at all is today\'s cold store');
 assert.equal(STORE.parseSnapshot('[]',{now:NOW}).reason,'unreadable','an array is not a record');
 assert.equal(STORE.parseSnapshot(textOf({...built,writtenAt:'soon'}),{now:NOW}).reason,'stale','a file with no parseable moment has no age this half can trust');
 assert.equal(STORE.parseSnapshot(textOf({...built,catalogue:{products:[]}}),{now:NOW}).reason,'incomplete','a file whose catalogue cannot be drawn');
 assert.equal(STORE.parseSnapshot(textOf({...built,orders:{orders:[{sessionId:'cs_x'}]}}),{now:NOW}).reason,'incomplete','and one whose orders cannot be');
 assert.equal(STORE.parseSnapshot(textOf({...built,accountId:null}),{now:NOW,accountId:ACCOUNT_ID}).reason,'incomplete','orders filed under no account are not a snapshot this half wrote');
 // Every reason is named in the constants the journey and main read.
 assert.deepEqual([...STORE.SNAPSHOT_DISCARDED],['absent','unreadable','version','stale','incomplete'],'the discard reasons are the ones this test drove');
});

test('what is published is bounded again at the moment it is published',async()=>{
 const built=record({products:PRODUCTS,orders:ORDERS});
 const live=STORE.parseSnapshot(textOf(built),{now:NOW+60000,accountId:ACCOUNT_ID}).snapshot;
 assert.deepEqual(STORE.published(live,{now:NOW+60000}),{writtenAt:iso(NOW),products:live.products,orders:live.orders},'the page is handed the two frozen shapes and the moment, and nothing else');
 assert.equal(STORE.published(live,{now:NOW+STORE.SNAPSHOT_MAX_AGE_MS+1}),null,'a launcher left open for a day publishes nothing, whatever it still holds in memory');
 assert.equal(STORE.published(null),null);
 // A snapshot with no orders publishes none, rather than an empty list: an empty list would make
 // the orders view say "No orders yet." from a file, which only the service may claim.
 const noOrders=STORE.parseSnapshot(textOf(STORE.snapshot({writtenAt:iso(NOW),accountId:ACCOUNT_ID,products:PRODUCTS})),{now:NOW,accountId:ACCOUNT_ID}).snapshot;
 assert.equal(STORE.published(noOrders,{now:NOW}).orders,null,'no cached orders is not the same answer as no orders');
 assert.equal(STORE.published(noOrders,{now:NOW}).products.length,4,'while the catalogue is published as it was cached');
});

test('the store page paints the snapshot before it asks the service, and revalidates behind it',async()=>{
 // The page's own two rules, read where they live: this suite cannot run a DOM, and the browser
 // suite is what proves the behaviour. What is asserted here is that the module still makes the
 // snapshot its first paint and still confirms it with the same two reads.
 const source=fs.readFileSync(path.join(root,'site/store/store.mjs'),'utf8');
 assert.match(source,/void hydrate\(\);/,'the mount hydrates from the snapshot');
 assert.match(source,/async function hydrate\(\)/,'which reads it, paints it, and only then asks for the live answer');
 assert.match(source,/store\.storeSnapshot\(\)/,'through the bridge command the launcher adds beside the store reads');
 assert.match(source,/function settleCatalogue\(answered\)/,'and settles that read as a confirmation where the rows on screen already came from the cache');
 assert.match(source,/sameRows\(before, answered\)/,'a confirmation that agrees with what is drawn redraws nothing');
 assert(!/COPY\.[a-z]+ =/.test(source.split('const COPY')[1]?.split('};')[0]||''),'no copy is added to the page\'s own table by this change');
 // No new sentence reached the page: the vocabulary in `COPY` is exactly the one Owen fixed.
 const copy=source.split('const COPY = {')[1].split('};')[0];
 const keys=[...copy.matchAll(/^  ([a-zA-Z]+):/gm)].map(match=>match[1]);
 assert.deepEqual(keys.sort(),['buy','close','delivered','donation','finish','noOrders','opening','orderRecorded','orders','paid','signedOut','successful','unavailable'],'the store\'s words are unchanged by the snapshot: nothing was invented to describe it');
});
