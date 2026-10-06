// Real IndexedDB across reloads and real authenticated source bytes, with
// controlled cuts inside a response body. Never reads a user's player profile.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {scryptSync} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const root=resolve('.bridge/joey-web/reverse/output/original-preview');
const revision=JSON.parse(await readFile(resolve(root,'revision.json'),'utf8'));
const {createOriginalServer}=await import(pathToFileURL(resolve(root,'server.mjs')));
const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),origin:'http://127.0.0.1',passwordSalt:'resume-test',passwordHash:scryptSync('resume-test','resume-test',32).toString('hex')};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin='http://127.0.0.1:'+server.address().port;
const base=config.origin+'/joey/original/',reports=[];
const evidence=resolve('.bridge/joey-web/reverse/output','original-download-resume-'+revision.version);await mkdir(evidence,{recursive:true});
try{
 const login=await fetch(base+'api/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({password:'resume-test'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const session=await (await fetch(base+'api/session',{headers:{Cookie:cookie}})).json();
 assert.equal((await fetch(base+'program-bytes',{headers:{Range:'bytes=0-1'}})).status,401);
 assert.equal((await fetch(base+'program-bytes',{headers:{Cookie:cookie,Range:'bytes=0-1048576'}})).status,416);
 const packed=await readFile(resolve(root,'joey_original_bg.wasm.gz'));
 const slice=await fetch(base+'program-bytes',{headers:{Cookie:cookie,Range:'bytes=131072-262143','Accept-Encoding':'gzip'}});
 assert.equal(slice.status,206);assert.equal(slice.headers.get('content-encoding'),null);assert.deepEqual(Buffer.from(await slice.arrayBuffer()),packed.subarray(131072,262144));
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
  const context=await browser.newContext();await context.addCookies([{name:'joey_original_session',value:cookie.slice(22),url:config.origin,httpOnly:true,sameSite:'Strict',secure:false}]);
  const page=await context.newPage();
  try{
   await page.goto(base,{waitUntil:'networkidle'});
   const ownSave=await page.evaluate(async()=>{const {openPlayerFiles}=await import('./player-files.mjs');const player=await openPlayerFiles();try{await player.save('/resume-test.dat',Uint8Array.from([13,27,41,55]));return Array.from((await player.load()).find(f=>f.path==='/resume-test.dat').bytes);}finally{player.close();}});
   const resource={...session.resources.find(file=>file.path==='/data.dat'),start:1048576,end:2097151};
   const program={path:'/joey_original_bg.wasm.gz',url:session.program.compressedURL,length:session.program.compressedBytes,sha256:session.program.compressedSHA256,start:0,end:1048575};
   const cases=[];
   for(const file of [resource,program]){
    // Abort as soon as a real prefix is durably committed; reload the page.
    const stopped=await page.evaluate(async(file)=>{
     const {createOriginalResourceCache}=await import('./resource-cache.mjs'),{createRangeReader}=await import('./range-reader.mjs');
     const databaseName=file.path.endsWith('.gz')?'joey-original-program-bytes-v1':'joey-original-resource-bytes-v1';
     const report={},cache=createOriginalResourceCache(report,{databaseName});let reader;
     const save=cache.savePartial.bind(cache);cache.savePartial=async(...args)=>{await save(...args);reader.close();};
     const starts=[];reader=createRangeReader([file],{cache,fetcher:async(url,options)=>{
      starts.push(file.compressedURL?Number(new URL(url,location.href).searchParams.get('start')):Number(/^bytes=(\d+)/.exec(options.headers.Range)[1]));
      const response=await fetch(url,options),source=response.body.getReader();let pending,position=0;
      return new Response(new ReadableStream({async pull(controller){
       if(options.signal.aborted){await source.cancel();controller.error(options.signal.reason);return;}
       if(!pending||position===pending.length){const {done,value}=await source.read();if(done){controller.close();return;}pending=value;position=0;}
       const end=Math.min(pending.length,position+65536);controller.enqueue(pending.subarray(position,end));position=end;
      }}),{status:response.status,headers:response.headers});
     }});
     let error;try{await reader.read(file.path,file.start,file.end-file.start+1);}catch(e){error=String(e);}
     const partial=await cache.readPartial(file,file.start,file.end);await cache.close();
     return {prefixBytes:partial?.length||0,starts,error};
    },file);
    assert(stopped.prefixBytes>=131072&&stopped.prefixBytes<1048576);assert(stopped.error);
    await page.reload({waitUntil:'networkidle'});
    const resumed=await page.evaluate(async(file)=>{
     const {createOriginalResourceCache}=await import('./resource-cache.mjs'),{createRangeReader}=await import('./range-reader.mjs');
     const cache=createOriginalResourceCache({}, {databaseName:file.path.endsWith('.gz')?'joey-original-program-bytes-v1':'joey-original-resource-bytes-v1'});
     const starts=[];const reader=createRangeReader([file],{cache,fetcher:async(url,options)=>{starts.push(file.compressedURL?Number(new URL(url,location.href).searchParams.get('start')):Number(/^bytes=(\d+)/.exec(options.headers.Range)[1]));return fetch(url,options);}});
     const bytes=await reader.read(file.path,file.start,file.end-file.start+1);
     const direct=await fetch(file.compressedURL?file.compressedURL+`?start=${file.start}&end=${file.end}`:file.url,{headers:file.compressedURL?{}:{Range:`bytes=${file.start}-${file.end}`}});const expected=new Uint8Array(await direct.arrayBuffer());
     if(bytes.some((value,i)=>value!==expected[i]))throw Error('Resumed bytes differ from source');
     const partial=await cache.readPartial(file,file.start,file.end);reader.close();await cache.close();
     return {starts,stats:reader.stats,partialRemoved:partial===null,byteExact:true};
    },file);
    assert.deepEqual(resumed.starts,[file.start+stopped.prefixBytes]);assert.equal(resumed.stats.downloadedBytes,1048576-stopped.prefixBytes);assert(resumed.partialRemoved&&resumed.byteExact);
    cases.push({file:file.path,stopped,resumed});
   }
   // A response body fails once; the same request resumes automatically.
   const automatic=await page.evaluate(async(file)=>{
    const {createOriginalResourceCache}=await import('./resource-cache.mjs'),{createRangeReader}=await import('./range-reader.mjs');
    const cache=createOriginalResourceCache({}),starts=[];let count=0;
    const reader=createRangeReader([file],{cache,fetcher:async(url,options)=>{
     starts.push(Number(new URL(url,location.href).searchParams.get('start')));const response=await fetch(url,options);if(count++)return response;
     const source=response.body.getReader();let sent=0,pending,position=0;
     return new Response(new ReadableStream({async pull(controller){if(sent>=131072){await source.cancel();controller.error(Error('Synthetic network interruption'));return;}
      if(!pending||position===pending.length){const {done,value}=await source.read();if(done){controller.close();return;}pending=value;position=0;}
      const end=Math.min(pending.length,position+65536);sent+=end-position;controller.enqueue(pending.subarray(position,end));position=end;
     }}),{status:response.status,headers:response.headers});
    }});
    const bytes=await reader.read(file.path,3145728,1048576);const direct=new Uint8Array(await (await fetch(file.compressedURL+'?start=3145728&end=4194303')).arrayBuffer());
    if(bytes.some((value,i)=>value!==direct[i]))throw Error('Automatic resume bytes differ');reader.close();await cache.close();return {starts,stats:reader.stats,byteExact:true};
   },resource);
   assert.equal(automatic.stats.networkRetries,1);assert.equal(automatic.starts.length,2);assert(automatic.starts[1]>automatic.starts[0]);assert.equal(automatic.stats.downloadedBytes,1048576);
   // Poison a checkpoint, then change source identity: neither can be reused.
   const integrity=await page.evaluate(async(file)=>{
    const {createOriginalResourceCache}=await import('./resource-cache.mjs');const report={},cache=createOriginalResourceCache(report),bytes=new Uint8Array(131072);
    await cache.savePartial(file,5242880,6291455,bytes);
    const changed=await cache.readPartial({...file,sha256:'0'.repeat(64)},5242880,6291455);
    const database=await new Promise((done,fail)=>{const r=indexedDB.open('joey-original-resource-bytes-v1',1);r.onsuccess=()=>done(r.result);r.onerror=()=>fail(r.error);});
    const key=file.sha256+':'+file.path+':5242880:6291455:partial';
    await new Promise((done,fail)=>{const tx=database.transaction('blocks','readwrite'),store=tx.objectStore('blocks'),r=store.get(key);r.onsuccess=()=>{const item=r.result;item.bytes[0]^=255;store.put(item);};tx.oncomplete=done;tx.onabort=()=>fail(tx.error);});database.close();
    const bad=await cache.readPartial(file,5242880,6291455);await cache.close();return {sourceChangeRejected:changed===null,corruptRejected:bad===null,discarded:report.discarded};
   },resource);
   assert(integrity.sourceChangeRejected&&integrity.corruptRejected);assert.equal(integrity.discarded,1);
   const unavailable=await page.evaluate(async(file)=>{
    const {createOriginalResourceCache}=await import('./resource-cache.mjs'),{createRangeReader}=await import('./range-reader.mjs'),{openPlayerFiles}=await import('./player-files.mjs');
    const original=IDBFactory.prototype.open;IDBFactory.prototype.open=function(...args){if(args[0]==='joey-original-program-bytes-v1')throw new DOMException('Test unavailable program cache','QuotaExceededError');return original.apply(this,args);};
    const report={},cache=createOriginalResourceCache(report,{databaseName:'joey-original-program-bytes-v1'});await cache.ready();IDBFactory.prototype.open=original;
    const reader=createRangeReader([file],{cache});const bytes=await reader.read(file.path,2097152,1048576);const direct=new Uint8Array(await (await fetch(file.url,{headers:{Range:'bytes=2097152-3145727'}})).arrayBuffer());
    if(bytes.some((value,i)=>value!==direct[i]))throw Error('Storage-unavailable transfer changed bytes');reader.close();await cache.close();
    const player=await openPlayerFiles();let ownSave;try{ownSave=Array.from((await player.load()).find(f=>f.path==='/resume-test.dat').bytes);}finally{player.close();}
    return {cacheAvailable:report.available,reason:report.reason,byteExact:true,ownSave};
   },program);
   assert.equal(unavailable.cacheAvailable,false);assert(unavailable.byteExact);assert.deepEqual(unavailable.ownSave,ownSave);
   reports.push({browser:name,cases,automatic,integrity,unavailable,ownSavePreserved:true});
   console.log(JSON.stringify({browser:name,resumed:cases.map(c=>({file:c.file,prefix:c.stopped.prefixBytes,remaining:c.resumed.stats.downloadedBytes})),automaticRetries:automatic.stats.networkRetries,integrity,programCacheUnavailableFallback:unavailable.byteExact,ownSavePreserved:true}));
  }finally{await context.close();await browser.close();}
 }
 await writeFile(resolve(evidence,'checks.json'),JSON.stringify({version:revision.version,wasmSHA256:revision.wasmSHA256,programGzipSHA256:revision.programGzipSHA256,scope:'real authenticated source ranges and IndexedDB; simulated body interruption, reload and automatic retry in desktop Chromium/WebKit; not physical phone performance',reports},null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
