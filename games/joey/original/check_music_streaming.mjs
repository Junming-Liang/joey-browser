// Real Chromium/WebKit and IndexedDB with pinned original audio ranges.
// Test profiles are fresh and isolated from any user's saves.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const root=resolve('.bridge/joey-web/reverse/output/original-preview'),revision=JSON.parse(await readFile(root+'/revision.json'));
const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));
const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:resolve('.bridge/joey-web/reverse/output/compression-20261013/light-pack'),origin:'http://127.0.0.1'};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin='http://127.0.0.1:'+server.address().port;
const evidence=resolve('.bridge/joey-web/reverse/output','original-music-streaming-'+revision.version);await mkdir(evidence,{recursive:true});
const reports=[];
try{
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
  try{
   const page=await browser.newPage();await page.goto(config.origin+'/joey/original/',{waitUntil:'networkidle'});
   const result=await page.evaluate(async()=>{
    const {createRangeReader}=await import('./range-reader.mjs'),{createOriginalResourceCache}=await import('./resource-cache.mjs'),{archiveLayouts:layouts}=await import('./resource-layout.mjs'),{openPlayerFiles}=await import('./player-files.mjs');
    const session=await (await fetch('./api/session')).json(),file=session.resources.find(f=>f.path==='/Voice.dat');
    const asset=65522888,offset=66556660,length=24576,oldSize=262144;
    const source=async(start,end)=>new Uint8Array(await (await fetch(file.compressedURL+`?start=${start}&end=${end}`)).arrayBuffer());
    const same=(actual,expected)=>{if(actual.length!==expected.length||actual.some((b,i)=>b!==expected[i]))throw Error('Original audio bytes changed');};
    const ownFiles=await openPlayerFiles();await ownFiles.save('/music-test.dat',Uint8Array.from([11,23,37]));
    const report={},cache=createOriginalResourceCache(report);
    // Seed the exact old-version range keys, close, then reopen the database.
    for(let page=3;page<=7;page++){const start=asset+page*oldSize,end=start+oldSize+4095-1;await cache.save(file,start,end,await source(start,end));}
    await cache.close();const restoredReport={},restored=createOriginalResourceCache(restoredReport),requests=[];
    const reader=createRangeReader([file],{cache:restored,layouts,fetcher:(url,options)=>{requests.push(url);return fetch(url,options);}});
    const actual=await reader.read(file.path,offset,length);same(actual,await source(offset,offset+length-1));
    while(reader.stats.activeRequests||reader.stats.activePrefetch)await new Promise(done=>setTimeout(done,5));
    if(requests.length)throw Error('Old validated music pages downloaded again');
    const reused={byteExact:true,requests:requests.length,diskHits:reader.stats.diskCacheHits,stats:{...reader.stats}};reader.close();await restored.close();
    // A genuine pending ReadableStream read with a received prefix silently stalls.
    const interruptedReport={},interrupted=createOriginalResourceCache(interruptedReport,{databaseName:'joey-music-stall-own-test'}),starts=[];
    const segmentStart=asset+20*65536,segmentEnd=segmentStart+65536-1,original=await source(segmentStart,segmentEnd);let attempt=0,cancels=0;
    const stalled=createRangeReader([file],{cache:interrupted,stallTimeoutMs:100,fetcher:async(url,options)=>{
     const start=Number(new URL(url,location.href).searchParams.get('start'));starts.push(start);const response=await fetch(url,options);
     if(attempt++)return response;
     await response.body.cancel();let sent=false;
     return new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(original.subarray(0,4096));}},cancel(){cancels++;}}),{status:response.status,headers:response.headers});
    }});
    same(await stalled.read(file.path,segmentStart,65536),original);
    const partial=await interrupted.readPartial(file,segmentStart,segmentEnd);
    const resumed={starts,stats:{...stalled.stats},byteExact:true,partialRemoved:partial===null,cancels};stalled.close();await interrupted.close();
    // The fallback cache page is hash-checked; corruption is discarded.
    const database=await new Promise((done,fail)=>{const r=indexedDB.open('joey-original-resource-bytes-v1',1);r.onsuccess=()=>done(r.result);r.onerror=()=>fail(r.error);});
    const start=asset+4*oldSize,end=start+oldSize+4095-1,key=file.sha256+':'+file.path+':'+start+':'+end;
    await new Promise((done,fail)=>{const tx=database.transaction('blocks','readwrite'),store=tx.objectStore('blocks'),request=store.get(key);request.onsuccess=()=>{const item=request.result;item.bytes[0]^=255;store.put(item);};tx.oncomplete=done;tx.onabort=()=>fail(tx.error);});database.close();
    const integrityReport={},integrity=createOriginalResourceCache(integrityReport);
    const rejected=await integrity.read(file,start,start+65536-1,{start,end});await integrity.close();
    const saved=(await ownFiles.load()).find(f=>f.path==='/music-test.dat').bytes;ownFiles.close();
    return {reused,resumed,integrity:{corruptOldPageRejected:rejected===null,discarded:integrityReport.discarded},ownSave:Array.from(saved),resourceCacheAvailable:restoredReport.available};
   });
   assert.equal(result.reused.requests,0);assert(result.reused.diskHits>0);assert(result.reused.byteExact);
   assert.deepEqual(result.resumed.starts,[65522888+20*65536,65522888+20*65536+4096]);assert.equal(result.resumed.stats.networkStalls,1);assert.equal(result.resumed.stats.networkRetries,1);assert.equal(result.resumed.stats.downloadedBytes,65536);assert(result.resumed.partialRemoved);assert.equal(result.resumed.cancels,1);
   assert(result.integrity.corruptOldPageRejected);assert.equal(result.integrity.discarded,1);assert.deepEqual(result.ownSave,[11,23,37]);
   reports.push({browser:name,...result});console.log(JSON.stringify({browser:name,oldCacheReused:true,oldCacheNetworkRequests:0,stalledBodyResumed:true,sourceBytesPreserved:true,corruptOldPageRejected:true,ownSavePreserved:true}));
  }finally{await browser.close();}
 }
 await writeFile(evidence+'/checks.json',JSON.stringify({version:revision.version,scope:'Desktop Chromium/WebKit with real IndexedDB and pinned original compressed audio; synthetic silent body stall. Not physical iPhone performance.',reports},null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
