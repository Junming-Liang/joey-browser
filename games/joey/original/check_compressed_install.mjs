// Exercise the built application and its real gateway, with own browser saves.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const output=resolve('.bridge/joey-web/reverse/output'),root=resolve(output,'original-preview');
const revision=JSON.parse(await readFile(root+'/revision.json'));
const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));
const config={filesRoot:root,resourcesRoot:resolve(output,'../input'),packedResourcesRoot:resolve(output,'compression-20261013/light-pack'),origin:'http://127.0.0.1'};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin='http://127.0.0.1:'+server.address().port;
const base=config.origin+'/joey/original/',evidence=resolve(output,'compressed-install-'+revision.version);await mkdir(evidence,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex'),reports=[];
const gatewayOnly=process.argv.includes('--gateway-only');
const syntheticArchives=revision.resources.map((file,i)=>({path:'/'+file.name,length:1,sha256:hash(Buffer.from([i+7]))}));
const tinyBlocks=syntheticArchives.map((file,i)=>{const original=Buffer.from([i+7]),packed=gzipSync(original);return {file,original,packed};}),tinyPack=Buffer.concat(tinyBlocks.map(b=>b.packed));let position=0;
const tinyManifest={format:'joey-lossless-gzip-pack-v1',pageBytes:1048576,pack:{path:'/__joey_packed_resources_v1',url:'/own-pack',length:tinyPack.length,sha256:hash(tinyPack)},archives:syntheticArchives,blocks:tinyBlocks.map(b=>{const result={path:b.file.path,start:0,length:1,sha256:b.file.sha256,packedStart:position,packedLength:b.packed.length,packedSHA256:hash(b.packed),kind:'none',spans:[]};position+=b.packed.length;return result;})};
const manifestBytes=Buffer.from(JSON.stringify(tinyManifest)),tinyDescriptor={manifestURL:'/own-manifest',manifestSHA256:hash(manifestBytes),pack:tinyManifest.pack};
try{
 const session=await(await fetch(base+'api/session')).json();assert.equal(session.version,revision.version);assert.equal(session.packedResources.pack.length,revision.packedResources.pack.length);
 const span=await fetch(config.origin+session.packedResources.pack.url,{headers:{Range:'bytes=4096-8191','Accept-Encoding':'gzip'}});
 assert.equal(span.status,206);assert.equal(span.headers.get('content-encoding'),null);assert.equal(span.headers.get('cache-control'),'no-store');assert.equal(span.headers.get('content-range'),`bytes 4096-8191/${revision.packedResources.pack.length}`);
 const source=await open(config.packedResourcesRoot+'/resources.gzip.pack','r');try{const expected=Buffer.alloc(4096);await source.read(expected,0,4096,4096);assert.deepEqual(Buffer.from(await span.arrayBuffer()),expected);}finally{await source.close();}
 assert.equal((await fetch(config.origin+session.packedResources.pack.url)).status,416);
 assert.equal((await fetch(config.origin+session.packedResources.pack.url,{headers:{Range:'bytes=0-1048576'}})).status,416);
 if(gatewayOnly)console.log(JSON.stringify({version:revision.version,scope:'compressed-gateway',exactRangeBytes:true,noHTTPEncoding:true,noHTTPDuplicateCache:true,missingAndOversizedRangeRejected:true}));
 for(const [name,engine]of gatewayOnly?[]:[['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
  const context=await browser.newContext({viewport:{width:915,height:412},isMobile:true,hasTouch:true}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const gameFrames=async n=>{
   await page.waitForFunction(count=>window.joeyOriginal?.renders>=count||window.joeyOriginal?.stages.some(s=>['failed','host-failed','worker-error'].includes(s.stage)),n,{timeout:240000});
   const failure=await page.evaluate(()=>window.joeyOriginal?.stages.find(s=>['failed','host-failed','worker-error'].includes(s.stage)));assert(!failure,JSON.stringify(failure));
  };
  try{
   await page.goto(base);await page.waitForFunction(()=>!document.getElementById('start').disabled);
   assert((await page.locator('#complete-label').textContent()).includes(Math.ceil(revision.packedResources.pack.length/1000000)+' MB'));assert.equal(await page.locator('#complete-resources').isChecked(),false);
   const contracts=await page.evaluate(async ({manifest,descriptor,manifestBytes,packBytes})=>{
    const {createOriginalResourceCache}=await import('./resource-cache.mjs'),{createOriginalResourceReader}=await import('./resource-reader.mjs');
    const original=manifest.archives.map(file=>({...file,url:'/own-original'+file.path})),body=Uint8Array.from(manifestBytes),pack=Uint8Array.from(packBytes);
    const stats={},cache=createOriginalResourceCache(stats,{databaseName:'joey-own-install-contract'}),requests=[];
    const fetcher=async(url,options={})=>{
     requests.push({url,range:options.headers?.Range});if(url===descriptor.manifestURL)return new Response(body);
     const file=original.find(file=>file.url===url),range=/^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range||'');
     if(!range)throw Error('Missing test range');const start=Number(range[1]),end=Number(range[2]),bytes=file?Uint8Array.from([original.indexOf(file)+7]):pack;
     return new Response(bytes.slice(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
    };
    const make=()=>createOriginalResourceReader(original,{cache,packedResources:descriptor,fetcher});
    let reader=make();await reader.preload({},()=>{});if(requests.length||reader.stats.resourceMode!=='on-demand')throw Error('Cold default fetched a pack');reader.close();
    // Metadata hints with real persisted bytes: old full installation wins.
    for(let i=0;i<original.length;i++)await cache.save(original[i],0,0,Uint8Array.from([i+7]));
    reader=make();let progress;await reader.preload(null,value=>{progress=value;});
    if(requests.length||reader.stats.resourceMode!=='original-complete'||progress.source!=='installed-original')throw Error('Old full cache downloaded a pack');
    if((await reader.read('/Voice.dat',0,1))[0]!==8)throw Error('Legacy full cache changed');reader.close();
    for(const file of original)await cache.invalidate(file,0,0);
    reader=make();if(!await reader.preload(null,()=>{}))throw Error('Tiny packed installation failed');reader.close();
    if(!await cache.hasComplete([descriptor.pack],descriptor.manifestSHA256))throw Error('Durable verified marker missing');
    if(await cache.hasComplete(original))throw Error('Old immutable pages retained after verified pack install');
    const count=requests.length;reader=make();await reader.preload({},()=>{});
    if(reader.stats.resourceMode!=='compressed-complete'||(await reader.read('/Voice.dat',0,1))[0]!==8||requests.slice(count).some(r=>r.url!==descriptor.manifestURL))throw Error('Installed pack not reused');reader.close();
    // Remove physical bytes while retaining coverage metadata to model another
    // tab/quota loss after admission. The game may fetch only the small raw span.
    const db=await new Promise((done,fail)=>{const r=indexedDB.open('joey-own-install-contract',1);r.onsuccess=()=>done(r.result);r.onerror=()=>fail(r.error);});
    await new Promise((done,fail)=>{const tx=db.transaction('blocks','readwrite');tx.objectStore('blocks').delete(descriptor.pack.sha256+':'+descriptor.pack.path+':0:'+(descriptor.pack.length-1));tx.oncomplete=done;tx.onabort=()=>fail(tx.error);});db.close();
    // Reopen also drops validated RAM from the previous reader.
    await cache.close();const fresh=createOriginalResourceCache({}, {databaseName:'joey-own-install-contract'});
    reader=createOriginalResourceReader(original,{cache:fresh,packedResources:descriptor,fetcher});const missingAt=requests.length;await reader.preload({},()=>{});
    if((await reader.read('/Voice.dat',0,1))[0]!==8||requests.slice(missingAt).some(r=>r.url===descriptor.pack.url)||reader.stats.resourceMode!=='on-demand')throw Error('Missing local pack did not fall back to a small original read');reader.close();await fresh.close();
    const quota=createOriginalResourceCache({}, {databaseName:'joey-own-install-low-quota',maxBytes:32});reader=createOriginalResourceReader(original,{cache:quota,packedResources:descriptor,fetcher});let rejected=false;
    try{await reader.preload(null,()=>{});}catch{rejected=true;}reader.close();if(!rejected||await quota.hasComplete([descriptor.pack],descriptor.manifestSHA256))throw Error('Incomplete storage announced installed');await quota.close();
    return {defaultNeverFetchesPack:true,oldFullCacheReused:true,installedPackReused:true,verifiedMarkerRequired:true,missingPackFallsBackToSmallOriginal:true,quotaFailureNeverMarksReady:true};
   },{manifest:tinyManifest,descriptor:tinyDescriptor,manifestBytes:[...manifestBytes],packBytes:[...tinyPack]});
   console.log(JSON.stringify({browser:name,scope:'shipping-reader-contracts',...contracts}));
   // Real default startup, with the built app and normal original game bytes.
   const resourceURLs=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(/\/(?:resource-packs|resources|resource-bytes)\//.test(path))resourceURLs.push(path);});
   await page.locator('#start').tap();await gameFrames(120);
   const common=await page.evaluate(()=>({preload:window.joeyOriginal.resourcePreload,stats:window.joeyOriginal.resourceStats,audio:window.joeyOriginal.audio}));
   assert.equal(common.preload.total,50040206);assert(common.preload.complete);assert(!resourceURLs.some(path=>path.includes('/resource-packs/')));assert.equal(common.stats.resourceMode,'on-demand');assert.equal(common.audio.contextState,'running');
   console.log(JSON.stringify({browser:name,scope:'built-default-game',commonBytes:common.preload.total,packRequests:0}));
   await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.goto(base);await page.waitForFunction(()=>!document.getElementById('start').disabled);
   // Real existing full raw installation (all three original archives).
   const oldFull=await page.evaluate(async()=>{
    const {createOriginalResourceCache}=await import('./resource-cache.mjs'),{openPlayerFiles}=await import('./player-files.mjs');
    const session=await(await fetch('./api/session')).json(),cache=createOriginalResourceCache({}),files=await openPlayerFiles();await files.save('/migration-test.dat',Uint8Array.from([13,17,19]));
    const pages=[];for(const file of session.resources)for(let start=0;start<file.length;start+=1048576)pages.push({file,start,end:Math.min(file.length,start+1048576)-1});let next=0;
    await Promise.all(Array.from({length:4},async()=>{while(next<pages.length){const {file,start,end}=pages[next++],response=await fetch(file.url,{headers:{Range:`bytes=${start}-${end}`}});if(response.status!==206)throw Error('Old full seed range failed');await cache.save(file,start,end,new Uint8Array(await response.arrayBuffer()));}}));
    if(!await cache.hasComplete(session.resources))throw Error('Actual full raw pages unavailable');await cache.close();files.close();return {pages:pages.length,logicalBytes:session.resources.reduce((sum,f)=>sum+f.length,0)};
   });
   const oldAt=resourceURLs.length;await page.locator('#complete-resources').check();await page.locator('#start').tap();await gameFrames(120);
   const reused=await page.evaluate(()=>({preload:window.joeyOriginal.resourcePreload,stats:window.joeyOriginal.resourceStats}));assert.equal(reused.stats.resourceMode,'original-complete');assert.equal(reused.preload.source,'installed-original');assert.equal(resourceURLs.length,oldAt);assert.equal(reused.stats.requests,0);
   console.log(JSON.stringify({browser:name,scope:'actual-old-full-cache-reused',...oldFull,archiveAndPackRequests:0}));
   await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.goto(base);await page.waitForFunction(()=>!document.getElementById('start').disabled);
   await page.evaluate(async()=>{const {createOriginalResourceCache}=await import('./resource-cache.mjs'),session=await(await fetch('./api/session')).json(),cache=createOriginalResourceCache({});for(const file of session.resources)await cache.invalidate(file,0,file.length-1);await cache.close();});
   // Interrupt exactly one real pack response after4096 compressed bytes. The
   // application must persist that prefix and request the missing tail.
   await page.evaluate(()=>{
    const native=window.fetch;window.ownPackStarts=[];let cut=false;
    window.fetch=async(...args)=>{const [url,options]=args;if(!String(url).includes('/resource-packs/'))return native(...args);const start=Number(/^bytes=(\d+)/.exec(options.headers.Range)[1]);window.ownPackStarts.push(start);const response=await native(...args);if(cut||start)return response;cut=true;const bytes=new Uint8Array(await response.arrayBuffer());let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(bytes.subarray(0,4096));}else c.error(Error('Own production integration cut'));}}),{status:response.status,headers:response.headers});};
   });
   // Modules already imported during prepare: their default fetch argument is
   // evaluated when creating the host, so the controlled cut reaches the app.
   await page.locator('#complete-resources').check();await page.locator('#start').tap();await gameFrames(4);
   const install=await page.evaluate(()=>({preload:window.joeyOriginal.resourcePreload,cache:window.joeyOriginal.resourceCache,stats:window.joeyOriginal.resourceStats,starts:window.ownPackStarts}));
   assert(install.preload.complete);assert.equal(install.preload.total,revision.packedResources.pack.length);assert.equal(install.preload.phase,'ready');assert.equal(install.preload.verifiedBlocks,458);assert.equal(install.cache.storedBytes,revision.packedResources.pack.length);assert(install.starts.includes(4096),'Actual app must resume compressed offset4096');assert.equal(install.stats.resourceMode,'compressed-complete');
   const sentinel=await page.evaluate(async()=>{const {openPlayerFiles}=await import('./player-files.mjs'),profile=await openPlayerFiles();try{return Array.from((await profile.load()).find(f=>f.path==='/migration-test.dat').bytes);}finally{profile.close();}});assert.deepEqual(sentinel,[13,17,19]);
   console.log(JSON.stringify({browser:name,scope:'built-full-compressed-install',storedPayloadBytes:install.cache.storedBytes,verifiedBlocks:458,resumed4096:true,playerFilePreserved:true}));
   // Restart through the real app's default option. Block DAT/pack network and
   // verify the original card editor with continuous music from compressed DB.
   await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.goto(base);await page.waitForFunction(()=>!document.getElementById('start').disabled);
   let denied=0;await page.route(/\/joey\/original\/(?:resource-packs|resources|resource-bytes)\//,route=>{denied++;return route.abort();});await page.locator('#start').tap();await gameFrames(4);
   await page.locator('[data-key=Enter]').tap();await gameFrames(450);await page.locator('[data-key=Enter]').tap();await gameFrames(650);await page.locator('[data-key=Escape]').tap();await gameFrames(await page.evaluate(()=>window.joeyOriginal.renders)+80);
   const box=await page.locator('canvas').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height*390/600);await page.mouse.down();await page.waitForTimeout(150);await page.mouse.up();await gameFrames(await page.evaluate(()=>window.joeyOriginal.renders)+120);
   const before=await page.evaluate(()=>structuredClone(window.joeyOriginal));await gameFrames(before.renders+1200);const game=await page.evaluate(()=>structuredClone(window.joeyOriginal));
   assert.equal(denied,0);assert.equal(game.resourceStats.requests,0);assert.equal(game.resourcePreload.source,'installed-pack');assert.equal(game.audio.contextState,'running');assert(game.audio.nonzeroSamples>before.audio.nonzeroSamples);assert.equal(game.audio.missingFrames-before.audio.missingFrames,0);assert(game.resourceReads.some(r=>r.path==='/Voice.dat'&&r.offset>=65522888&&r.offset<74202956));assert.equal(errors.length,0);
   await page.locator('canvas').screenshot({path:evidence+'/'+name+'-editor.png'});
   const report={browser:name,version:revision.version,scope:'Built production app on loopback, real full old cache, real full compressed install and restart, original editor+1200 music frames. Desktop engines, not physical phone/full duel acceptance.',contracts,common,oldFull,reused,install,game,additionalMissingAudioFrames:game.audio.missingFrames-before.audio.missingFrames,deniedNetworkRequests:denied,errors};reports.push(report);await writeFile(evidence+'/'+name+'.json',JSON.stringify(report,null,2)+'\n');
   console.log(JSON.stringify({browser:name,scope:'built-compressed-editor',frames:game.renders,fps:game.renderTiming.framesPerSecond,additionalMissingAudioFrames:0,archiveAndPackRequests:0,maxRenderIntervalMs:game.renderTiming.maxIntervalMs}));
  }finally{await context.close();await browser.close();}
 }
 await writeFile(evidence+(gatewayOnly?'/gateway.json':'/checks.json'),JSON.stringify({version:revision.version,gatewayOnly,reports},null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
