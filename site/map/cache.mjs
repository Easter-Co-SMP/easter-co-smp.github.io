// Only map data lives here. Each coordinate holds one PNG, replaced after a good fetch.
// No expiry: an older map is useful while fresh data is being checked.
export function createMapCache({maxTiles=256,maxBytes=64*1024*1024}={}){
 let opening;
 function open(){
  if(opening)return opening;
  opening=new Promise(resolve=>{
   let settled=false;
   const finish=value=>{if(settled){value?.close();return;}settled=true;clearTimeout(timer);resolve(value);};
   const timer=setTimeout(()=>finish(null),700);
   try{
    const request=globalThis.indexedDB.open('easter-co-public-map',1);
    request.onupgradeneeded=()=>{
     const db=request.result;
     db.createObjectStore('snapshots');
     db.createObjectStore('tiles',{keyPath:'id'}).createIndex('usedAt','usedAt');
    };
    request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();finish(request.result);};
    request.onerror=request.onblocked=()=>finish(null);
   }catch{finish(null);}
  });
  return opening;
 }
 async function transaction(store,mode,work){
  const db=await open();if(!db)return null;
  return new Promise(resolve=>{
   let result=null,tx,settled=false;
   const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
   const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish(null);},1500);
   try{
    tx=db.transaction(store,mode);
    tx.oncomplete=()=>finish(result);
    tx.onerror=tx.onabort=()=>finish(null);
    work(tx.objectStore(store),value=>{result=value;});
   }catch{finish(null);}
  });
 }
 const readSnapshot=id=>transaction('snapshots','readonly',(store,set)=>{
  const request=store.get(id);request.onsuccess=()=>set(request.result?.value??null);
 });
 const writeSnapshot=(id,value)=>transaction('snapshots','readwrite',store=>{
  store.put({value,savedAt:Date.now()},id);
 });
 const readTile=id=>transaction('tiles','readwrite',(store,set)=>{
  const request=store.get(id);
  request.onsuccess=()=>{
   const row=request.result;if(!row)return;
   row.usedAt=Date.now();store.put(row);set(row);
  };
 });
 const writeTile=(id,version,blob)=>transaction('tiles','readwrite',store=>{
  store.put({id,version,blob,bytes:blob.size,usedAt:Date.now()});
  let count=0,bytes=0;
  const cursor=store.index('usedAt').openCursor(null,'prev');
  cursor.onsuccess=()=>{
   const row=cursor.result;if(!row)return;
   if(count>=maxTiles||bytes+row.value.bytes>maxBytes)row.delete();
   else{count++;bytes+=row.value.bytes;}
   row.continue();
  };
 });
 const removeTile=id=>transaction('tiles','readwrite',store=>store.delete(id));
 return {readSnapshot,writeSnapshot,readTile,writeTile,removeTile};
}
