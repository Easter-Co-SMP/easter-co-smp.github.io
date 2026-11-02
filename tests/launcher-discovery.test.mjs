import test from 'node:test';
import assert from 'node:assert/strict';
import {latestPost,productTeaser,nextTeaserIndex} from '../site/launcher-discovery.mjs';
test('latest social post excludes invalid links and dates and orders by publication',()=>{
 const p={id:'old',title:'Old',publishedAt:'2026-10-18T12:00:00Z',url:'https://example.com/old'};
 const next={...p,id:'new',title:'New',publishedAt:'2026-10-19T12:00:00Z'};
 assert.equal(latestPost([p,{...next,id:'unsafe',url:'javascript:alert(1)'},{...next,id:'bad-date',publishedAt:'invalid'},next]).id,'new');
 assert.equal(latestPost([{...p,url:'https://user:pass@example.com'}]),null);
 assert.equal(latestPost(null),null);
});
test('a store teaser carries the server name, price and one of the two worth lines',()=>{
 const pack=productTeaser({key:'sterling-10',name:'1,000 Sterling',amountMinor:499,currency:'USD',kind:'sterling',creditPence:100000});
 assert.equal(pack.key,'sterling-10');
 assert.equal(pack.name,'1,000 Sterling');
 assert.match(pack.line,/1,000 Sterling in your bank$/);
 assert.match(pack.line,/^\$4\.99 · /);
 const donation=productTeaser({key:'donation-5',name:'A gift',amountMinor:500,currency:'USD',kind:'donation',creditPence:0});
 assert.match(donation.line,/A one-off donation\.$/);
});
test('a teaser refuses anything the catalogue contract could not have sent',()=>{
 assert.equal(productTeaser(null),null);
 assert.equal(productTeaser({name:'No key',amountMinor:100,currency:'USD'}),null);
 assert.equal(productTeaser({key:'k',name:'  ',amountMinor:100,currency:'USD'}),null);
 assert.equal(productTeaser({key:'k',name:'Name',amountMinor:1.5,currency:'USD'}),null);
 assert.equal(productTeaser({key:'k',name:'Name',amountMinor:100}),null);
});
test('the rotation wraps and an empty catalogue never advances',()=>{
 assert.equal(nextTeaserIndex(0,4),1);
 assert.equal(nextTeaserIndex(3,4),0);
 assert.equal(nextTeaserIndex(0,0),0);
});
