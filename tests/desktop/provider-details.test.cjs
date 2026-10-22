// What a linked provider is allowed to say about itself.
//
// The profile dialog draws the gamertag, the address, the Steam persona and the Discord name
// under each linked provider, and those values come from Microsoft, Steam and Discord: the
// first strings in the launcher that a third party wrote. Every one of them is rebuilt in
// sanitizeAccount before it can reach state, a value that is not a string is unknown rather
// than something to coerce, an address that is not an address is dropped rather than printed,
// and a record this launcher cannot read is "no details" - never an error and never a broken
// row. The dialog's own rules (no value, no line; text and never HTML) are driven in
// tests/identity-browser.mjs against the real site/company-profile.mjs.
const test=require('node:test'),assert=require('node:assert/strict');
const {ACCOUNT}=require('./fixtures.cjs');
const {sanitizeAccount,publicAccount}=require('../../desktop/accounts.cjs');
const account=extra=>sanitizeAccount({...ACCOUNT,...extra});
const view=extra=>publicAccount({account:account(extra)});
const LINKED=['microsoft','google','steam','discord'];

test('each linked provider publishes its own details and nothing else',()=>{
 const details={
  microsoft:{gamertag:'Cap. Wren',minecraftName:'NotThisOne'},
  google:{email:'wren@example.test'},
  steam:{persona:'Captain Wren'},
  discord:{username:'wren_ec',displayName:'Wren'},
  // A key the contract does not name, a nested object, and a provider the account has not
  // linked: none of them reaches state.
  github:{username:'wren'},junk:{deep:{nested:true}}
 };
 assert.deepEqual(view({providers:LINKED,providerDetails:details}).providerDetails,{
  microsoft:{gamertag:'Cap. Wren'},
  google:{email:'wren@example.test'},
  steam:{persona:'Captain Wren'},
  discord:{username:'wren_ec',displayName:'Wren'}
 });
 assert.deepEqual(view({providers:['google'],providerDetails:details}).providerDetails,{google:{email:'wren@example.test'}},'an unlinked provider keeps no details');
});

test('the Minecraft name is the account\'s own, never the provider\'s copy',()=>{
 const minecraftName=view({providers:['microsoft'],providerDetails:{microsoft:{gamertag:'Cap. Wren',minecraftName:'Somebody Else'}}}).minecraftName;
 assert.equal(minecraftName,'TestCaptain','the row reads the account\'s validated name, not providerDetails');
 // The account's own field is still validated exactly as before, and a payload that names an
 // impossible Minecraft name is refused rather than shown with a second, unvalidated copy
 // standing next to it.
 assert.throws(()=>sanitizeAccount({...ACCOUNT,minecraftName:'not a name'}),error=>error.code==='invalid_response');
 const noProfile=view({minecraftName:null,minecraftUuid:null,microsoftLinked:false,providers:['google'],providerDetails:{microsoft:{gamertag:'Cap. Wren'}}});
 assert.equal(noProfile.minecraftName,null,'an account with no Minecraft profile has no name to show, not the display name');
 assert.equal(noProfile.providerDetails,null,'and no details for a provider it has not linked');
});

test('a record this launcher cannot read is no details, never an error',()=>{
 for(const value of [undefined,null,'details',42,true,[],['microsoft'],[{gamertag:'x'}],{microsoft:'x'},{microsoft:null},{microsoft:['a']}]){
  const account=view({providers:LINKED,providerDetails:value});
  assert.equal(account.providerDetails,null,'providerDetails '+JSON.stringify(value)+' must be no details');
  assert.equal(account.minecraftName,'TestCaptain','the account still renders exactly as it did');
 }
});

test('a value that is not a string is unknown, and unknown draws nothing',()=>{
 for(const bad of [5,0,true,false,{text:'x'},['x'],()=> 'x']){
  assert.equal(view({providers:['microsoft'],providerDetails:{microsoft:{gamertag:bad}}}).providerDetails,null,'a '+typeof bad+' gamertag is unknown');
 }
 // The values are the payload's own strings: trimmed, capped and otherwise left alone.
 const held=view({providers:['microsoft'],providerDetails:{microsoft:{gamertag:'   Cap. Wren   '}}}).providerDetails;
 assert.deepEqual(held,{microsoft:{gamertag:'Cap. Wren'}},'a kept value is trimmed');
 assert.equal(view({providers:['steam'],providerDetails:{steam:{persona:'   '}}}).providerDetails,null,'whitespace is not a value');
 assert.equal(view({providers:['steam'],providerDetails:{steam:{persona:'x'.repeat(200)}}}).providerDetails.steam.persona,'x'.repeat(64),'a handle is capped at 64 characters');
});

test('a value that could reorder or hide text is not a value',()=>{
 // A gamertag is one visible word: control characters and bidi overrides are removed, not
 // carried into a row the player reads.
 assert.deepEqual(view({providers:['microsoft'],providerDetails:{microsoft:{gamertag:'Cap\u202e\u0000. Wren\n'}}}).providerDetails,{microsoft:{gamertag:'Cap. Wren'}});
 assert.equal(view({providers:['discord'],providerDetails:{discord:{username:'\u202e\u0007'}}}).providerDetails,null,'a value made only of those characters is no value');
 // Markup is a string like any other here; the dialog renders it as text, which
 // tests/identity-browser.mjs proves against the real view.
 assert.equal(view({providers:['steam'],providerDetails:{steam:{persona:'<b>Wren</b>'}}}).providerDetails.steam.persona,'<b>Wren</b>');
});

test('an address that is not an address is dropped rather than shown',()=>{
 for(const bad of ['not-an-address','wren.example.test','@example.test','wren@','wren @example.test','wren@example .test','',"   ",'wren@@example.test',5,['wren@example.test'],'w'.repeat(250)+'@example.test']){
  assert.equal(view({providers:['google'],providerDetails:{google:{email:bad}}}).providerDetails,null,'the address '+JSON.stringify(bad)+' is dropped');
 }
 // The address validator is the launcher's existing one, so what it accepts the row may show.
 assert.equal(view({providers:['google'],providerDetails:{google:{email:' wren@example.test '}}}).providerDetails.google.email,'wren@example.test');
});

test('a linked provider with nothing known adds no details at all',()=>{
 for(const details of [{}, {microsoft:{gamertag:null}}, {microsoft:{}}, {microsoft:{gamertag:null,minecraftName:'TestCaptain'}}, {steam:{persona:''}}, {discord:{username:null,displayName:null}}]){
  assert.equal(view({providers:LINKED,providerDetails:details}).providerDetails,null,JSON.stringify(details)+' has nothing to show');
 }
 // Discord's second name is kept when it is the only one, because the row falls back to it.
 assert.deepEqual(view({providers:['discord'],providerDetails:{discord:{username:null,displayName:'Wren'}}}).providerDetails,{discord:{username:null,displayName:'Wren'}});
});

test('details travel with the account and are re-sanitized from a stored vault',()=>{
 const {storedSession}=require('../../desktop/accounts.cjs');
 const stored=storedSession({token:'session-token',expiresAt:Date.now()+60000,account:{...ACCOUNT,providers:LINKED,providerDetails:{google:{email:'wren@example.test'},discord:{username:'wren_ec'}}}});
 assert.deepEqual(publicAccount(stored).providerDetails,{google:{email:'wren@example.test'},discord:{username:'wren_ec',displayName:null}});
 // A vault record written by a build that never checked the field is checked on the way out.
 const tampered=storedSession({token:'session-token',expiresAt:Date.now()+60000,account:{...ACCOUNT,providers:LINKED,providerDetails:{google:{email:'not-an-address'},discord:{username:5}}}});
 assert.equal(publicAccount(tampered).providerDetails,null,'a stored value that fails the rules is dropped on the way out');
});
