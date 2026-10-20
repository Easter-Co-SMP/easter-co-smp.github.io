'use strict';
// The home screen's editorial document (doc/launcher-discovery.md). Every case here is
// about one of two promises: nothing malformed reaches the renderer, and nothing the
// document says can cost the launcher more than one bounded read.
const test=require('node:test'),assert=require('node:assert/strict');
const {Discovery,cleanContent,cleanPost,contentURL,CONTENT_PATH,TIMEOUT_MS,MAX_BYTES,CACHE_MS}=require('../../desktop/discovery.cjs');

const POST={id:'dispatch-1',title:'A title',excerpt:'An excerpt',publishedAt:'2026-10-19T16:00:00Z',url:'https://example.com/posts/dispatch-1'};
const ITEM={id:'pennant',title:'Phoenix Pennant',description:'A cosmetic.',category:'Cosmetics'};
const document_=overrides=>({schema:1,posts:[POST],featuredItem:ITEM,...overrides});

function stub(response,{ok=true,status=200}={}){
 const calls=[];
 const request=async(url,options)=>{calls.push({url,options});return {ok,status,json:async()=>response};};
 return {request,calls};
}

test('a valid document survives with exactly the fields the renderer reads',()=>{
 const clean=cleanContent(document_({extra:'ignored',posts:[{...POST,unknown:'dropped'}]}));
 assert.deepEqual(Object.keys(clean).sort(),['featuredItem','posts','schema']);
 assert.deepEqual(Object.keys(clean.posts[0]).sort(),['excerpt','id','publishedAt','title','url']);
 assert.deepEqual(Object.keys(clean.featuredItem).sort(),['category','description','id','title']);
 assert.equal(clean.posts[0].publishedAt,'2026-10-19T16:00:00.000Z','the timestamp leaves as ISO-8601');
});

test('an entry is dropped rather than repaired, one bad field at a time',()=>{
 const bad=[
  [{...POST,url:'http://example.com/a'},'plain HTTP'],
  [{...POST,url:'https://user:pass@example.com/a'},'credentials in the URL'],
  [{...POST,url:'javascript:alert(1)'},'a script URL'],
  [{...POST,url:'not a url'},'a non-URL'],
  [{...POST,title:'   '},'an empty title'],
  [{...POST,publishedAt:'someday'},'an unparseable date'],
  [{...POST,id:'has space'},'an identifier that is not one'],
  [{...POST,id:'x'.repeat(200)},'an oversized identifier'],
  ['not an object','a string']
 ];
 for(const [entry,why] of bad){
  assert.equal(cleanPost(entry),null,'dropped: '+why);
  assert.deepEqual(cleanContent(document_({posts:[entry]})).posts,[],'and the document keeps no trace: '+why);
 }
 // Over-long text is clamped rather than dropped: a title that is merely too long is
 // still a title the Company wrote, and hiding it would be a worse answer than cutting it.
 const long=cleanPost({...POST,title:'T'.repeat(5000),excerpt:'E'.repeat(4000)});
 assert.equal(long.title.length,160,'a long title is clamped, not dropped');
 assert.equal(long.excerpt.length,400,'and so is an excerpt');
});

test('a duplicate identifier is shown once, and only twelve entries are kept at all',()=>{
 const doubled=cleanContent(document_({posts:[POST,{...POST,title:'Second copy'}]}));
 assert.equal(doubled.posts.length,1);
 const many=Array.from({length:40},(_,i)=>({...POST,id:'dispatch-'+i}));
 assert.equal(cleanContent(document_({posts:many})).posts.length,12,'the document cannot grow the payload past its own bound');
});

test('an unusable featured item is null, and an unknown schema is refused whole',()=>{
 assert.equal(cleanContent(document_({featuredItem:{id:'x'}})).featuredItem,null);
 assert.equal(cleanContent(document_({featuredItem:null})).featuredItem,null);
 for(const schema of [undefined,0,2,'1',null]) assert.throws(()=>cleanContent(document_({schema})),/Unsupported content/,'schema '+String(schema));
 assert.throws(()=>cleanContent({schema:1,posts:'none'}),/Unsupported content/);
});

test('the document is read from the client origin, and its read is bounded three ways',async()=>{
 assert.equal(CONTENT_PATH,'/home.json');
 const url=contentURL('https://example.test/');
 assert.equal(url,'https://example.test/home.json');
 const {request,calls}=stub(document_());
 const discovery=new Discovery({request});
 await discovery.content();
 assert.equal(calls.length,1);
 assert.equal(calls[0].options.maxBytes,MAX_BYTES,'the body is capped at the transport');
 assert.ok(calls[0].options.signal,'and the read carries its own cancellation');
 assert.match(String(calls[0].url),/^https:\/\/.+\/home\.json$/);
 assert.equal(TIMEOUT_MS,8000);
 assert.equal(MAX_BYTES,65536);
 assert.equal(CACHE_MS,30*60*1000);
});

test('one read is shared, then reused for half an hour, then read again',async()=>{
 let clock=1000;
 const {request,calls}=stub(document_());
 const discovery=new Discovery({request,now:()=>clock});
 const [a,b]=await Promise.all([discovery.content(),discovery.content()]);
 assert.equal(calls.length,1,'two asks in the same breath are one request');
 assert.deepEqual(a,b);
 clock+=CACHE_MS-1;await discovery.content();
 assert.equal(calls.length,1,'a fresh answer is not re-fetched');
 clock+=2;await discovery.content();
 assert.equal(calls.length,2,'and an old one is');
});

test('a failure is a refusal, and a failure after a success keeps the dispatch it had',async()=>{
 let fail=false;
 const request=async()=>{ if(fail) throw Object.assign(Error('socket hang up'),{name:'TypeError'}); return {ok:true,status:200,json:async()=>document_()}; };
 let clock=1000;
 const discovery=new Discovery({request,now:()=>clock});
 await discovery.content();
 fail=true;clock+=CACHE_MS+1;
 const kept=await discovery.content();
 assert.equal(kept.posts.length,1,'the last good answer survives a later failure');

 const cold=new Discovery({request});
 await assert.rejects(cold.content(),error=>{
  assert.equal(error.code,'content_unavailable');
  assert.match(error.message,/could not be read/);
  assert.equal(/socket|hang up/.test(error.message),false,'no transport detail reaches the renderer');
  return true;
 });
 const refused=new Discovery({request:async()=>({ok:false,status:404,json:async()=>({})})});
 await assert.rejects(refused.content(),{code:'content_unavailable'});
});
