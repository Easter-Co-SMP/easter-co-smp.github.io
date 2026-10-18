const test=require('node:test'),assert=require('node:assert/strict');
const {valid,access,id,publicIdentity}=require('../../desktop/identity.cjs');
test('profile-less Microsoft sessions have stable safe identities without fake Java profiles',()=>{
 const session={xuid:'1234',accountId:'xbox:1234',refreshToken:'private-refresh',accessToken:'private-access',profile:null,minecraftAccess:'missing'};
 assert(valid(session));assert.equal(id(session),'xbox:1234');assert.equal(access(session),'missing');
 assert.deepEqual(publicIdentity(session),{id:'xbox:1234',name:'Microsoft account'});
 assert(!JSON.stringify(publicIdentity(session)).includes('private'));
 assert(!valid({...session,xuid:'invalid'}));assert(!valid({...session,accountId:'arbitrary'}));assert(!valid({...session,refreshToken:null}));
});
test('legacy profiles remain readable and explicit revoked access overrides a cached profile',()=>{
 const session={refreshToken:'private',profile:{id:'1234567890abcdef1234567890abcdef',name:'Captain'}};
 assert(valid(session));assert.equal(access(session),'owned');assert.equal(id(session),session.profile.id);
 assert.equal(access({...session,minecraftAccess:'missing'}),'missing');assert.equal(access(null),'signed-out');
 assert.equal(publicIdentity({...session,minecraftAccess:'unknown'}).name,'Captain');
});
