import test from 'node:test';
import assert from 'node:assert/strict';
import {latestPost,featuredItem} from '../site/launcher-discovery.mjs';
test('latest social post excludes invalid links and dates and orders by publication',()=>{
 const p={id:'old',title:'Old',publishedAt:'2026-10-18T12:00:00Z',url:'https://example.com/old'};
 const next={...p,id:'new',title:'New',publishedAt:'2026-10-19T12:00:00Z'};
 assert.equal(latestPost([p,{...next,id:'unsafe',url:'javascript:alert(1)'},{...next,id:'bad-date',publishedAt:'invalid'},next]).id,'new');
 assert.equal(latestPost([{...p,url:'https://user:pass@example.com'}]),null);
 assert.equal(latestPost(null),null);
});
test('featured content never carries renderer prices or purchase instructions',()=>{
 assert.equal(featuredItem({title:'Missing ID'}),null);
 assert.deepEqual(featuredItem({id:'flag',title:'Flag',description:'A flag',price:0,checkoutUrl:'javascript:alert(1)'}),{id:'flag',title:'Flag',description:'A flag',category:'Featured item'});
});
