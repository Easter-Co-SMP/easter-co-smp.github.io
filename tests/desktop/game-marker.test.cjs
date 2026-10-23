// The running game's identity, without Electron and without a launcher.
//
// What each case proves, in the order the ticket asks for them:
//   * a marker round-trips: what `remember` wrote is what `read` answers;
//   * the start marker is the identity, so a *reused pid* is refused even though the process
//     exists — the case a bare pid cannot tell apart, and the reason this module exists;
//   * a stale marker (the process is gone) resolves to the ordinary launcher state and is
//     removed, never left for a screen that would then claim a game that is not there;
//   * the Linux start-time parse survives the field that makes /proc/<pid>/stat awkward (the
//     command name in parentheses, which may itself contain spaces and parentheses).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const marker=require('../../desktop/game-marker.cjs');
const fixture=async run=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'game-marker-'));try{await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}};
const linuxOnly=process.platform==='linux';

test('the Linux start marker is field 22, past a command name that may hold spaces and parentheses',()=>{
 // A real /proc/<pid>/stat shape: pid, (comm), state, ppid, ... and starttime as field 22,
 // which is index 19 of what follows the last ')'.
 const stat='4711 (java (nested) name with spaces) S 1 4711 4711 0 -1 4194304 1234 0 0 0 5 6 0 0 20 0 12 0 987654 123456789 4096 18446744073709551615';
 assert.equal(marker.linuxStart(stat),'987654','the kernel start time, not a neighbouring field');
 assert.equal(marker.linuxStart(''),null);
 assert.equal(marker.linuxStart('not a stat line'),null);
 assert.equal(marker.linuxStart('4711 (java) S 1 4711 4711 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 x 0'),null,'a field that is not a number is not an identity');
});

test('a marker round-trips, and what it records is a live process plus its own start time',async()=>{
 await fixture(async root=>{
  assert.equal(marker.read(root),null,'nothing written yet');
  // This test process is the stand-in for the game: a process that really exists, whose start
  // time the operating system really reports.
  const written=await marker.remember(root,process.pid);
  if(!linuxOnly)return; // the probe below is the Linux read; the other platforms are reported, not claimed
  assert(written&&written.pid===process.pid,'the record names the process');
  assert.match(written.start,/^\d+$/,'and the kernel start time it was seen with');
  assert.deepEqual(marker.read(root),written,'the file answers exactly what was written');
  assert.equal((await marker.adopt(root)).game.pid,process.pid,'adoption accepts a process that is still the one recorded');
  await fs.access(marker.markerFile(root)); // still there: a launcher restarting again must find it
 });
});

test('a reused pid is refused: the same number with a different start time is not the game',async()=>{
 await fixture(async root=>{
  const written=await marker.remember(root,process.pid);
  if(!written)return;
  // The pid exists — it is this very process — but the start time does not match, which is what
  // a recycled pid looks like from the outside.
  const forged={...written,start:String(Number(written.start)+1)};
  await fs.writeFile(marker.markerFile(root),JSON.stringify(forged));
  assert.equal(await marker.stillRunning(forged),false,'a pid whose start time differs is a different process');
  assert.equal(await marker.adopt(root),null,'so it is not adopted as the game');
  await assert.rejects(fs.access(marker.markerFile(root)),'and the marker is removed rather than left to claim a game that is gone');
 });
});

test('a stale marker resolves to the ordinary launcher state, and a damaged one does not throw',async()=>{
 await fixture(async root=>{
  // A pid that cannot be running: nothing in this container has pid 2^22.
  await fs.writeFile(marker.markerFile(root),JSON.stringify({pid:4194304,start:'1',startedAt:new Date().toISOString()}));
  assert.equal(await marker.adopt(root),null,'a process that is gone is not a game');
  await assert.rejects(fs.access(marker.markerFile(root)),'the stale marker is removed');
  for(const damaged of ['', 'null', '{"pid":0,"start":"1"}', '{"pid":"4711","start":"1"}', '{"pid":4711,"start":""}', '{"pid":4711}', '[4711]'])
   await fs.writeFile(marker.markerFile(root),damaged),assert.equal(await marker.adopt(root),null,'a marker that cannot be believed is not a state the launcher publishes: '+damaged);
  assert.equal(await marker.forget(root),true,'forgetting an absent marker is not an error');
 });
});

test('a record is only made for a process that can be identified',async()=>{
 await fixture(async root=>{
  assert.equal(marker.record(0,'1'),null);
  assert.equal(marker.record(-5,'1'),null);
  assert.equal(marker.record(1.5,'1'),null);
  assert.equal(marker.record(4711,''),null);
  assert.equal(marker.record(4711,null),null);
  assert.equal(marker.record(4711,'123').pid,4711);
  assert.equal(await marker.startMark(0),null,'no pid, no identity');
  assert.equal(await marker.startMark(4194304),null,'and no process, no identity');
  // A process that cannot be found is never remembered, so no marker ever claims a game that
  // was never started.
  assert.equal(await marker.remember(root,4194304),null);
  await assert.rejects(fs.access(marker.markerFile(root)),'and nothing is written for it');
 });
});
