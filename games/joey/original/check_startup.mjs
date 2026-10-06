// Test the shipped startup and preserve evidence separately from full-duel checks.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scryptSync,createHash} from 'node:crypto';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const root=resolve(process.argv[2]||'.bridge/joey-web/reverse/output/original-startup-preview');
const restart=process.argv.includes('--restart');
const portrait=process.argv.includes('--portrait'),delayResource=process.argv.includes('--delay-resource');
const cacheCheck=process.argv.includes('--cache');if(cacheCheck&&!restart)throw Error('Cache check requires restart');
const viewport=portrait?{width:402,height:676}:{width:915,height:412};
const disableResourceStorage=()=>{const original=IDBFactory.prototype.open;IDBFactory.prototype.open=function(...args){if(args[0]==='joey-original-resource-bytes-v1')throw new DOMException('Synthetic unavailable resource cache','QuotaExceededError');return original.apply(this,args);};};
const initialArgument=process.argv.indexOf('--initial-wasm');
const initialWasmPath=initialArgument<0?null:resolve(process.argv[initialArgument+1]);
if(initialWasmPath&&!restart)throw Error('Initial program override requires restart check');
const initialWasmSHA256=initialWasmPath?createHash('sha256').update(await readFile(initialWasmPath)).digest('hex'):null;
const revision=JSON.parse(await readFile(resolve(root,'revision.json'),'utf8'));
const evidence=resolve('.bridge/joey-web/reverse/output','original-startup-check-'+revision.version+(restart?'-restart':'')+(initialWasmSHA256?'-from-'+initialWasmSHA256.slice(0,12):'')+(portrait?'-portrait':'')+(delayResource?'-loading':'')+(cacheCheck?'-cache':''));await mkdir(evidence,{recursive:true});
const {createOriginalServer}=await import(pathToFileURL(resolve(root,'server.mjs')));
const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),origin:'http://127.0.0.1',passwordSalt:'startup-check',passwordHash:scryptSync('startup-check','startup-check',32).toString('hex')};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin='http://127.0.0.1:'+server.address().port;
const prefix=config.origin+'/joey/original/',assert=(condition,message)=>{if(!condition)throw Error(message);},reports=[];
try{
 const login=await fetch(prefix+'api/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({password:'startup-check'})});assert(login.status===200,'Login');
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const failureHeaders={Origin:config.origin,'Content-Type':'application/json'};
 assert((await fetch(prefix+'api/failure',{method:'POST',headers:failureHeaders,body:'{"error":"unauthenticated"}'})).status===401,'Failure report requires session');
 assert((await fetch(prefix+'api/failure',{method:'POST',headers:{...failureHeaders,Origin:'https://invalid.example',Cookie:cookie},body:'{"error":"foreign-origin"}'})).status===403,'Failure report requires same origin');
 assert((await fetch(prefix+'api/failure',{method:'POST',headers:{...failureHeaders,Cookie:cookie},body:'{"error":"'+ 'x'.repeat(8192)+'"}'})).status===413,'Failure report body limit');
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
  try{
   for(const variant of [{isolated:true},{isolated:false},...(cacheCheck?[{isolated:true,cacheUnavailable:true}]:[])]){
    const {isolated,cacheUnavailable}=variant,caseTag=cacheUnavailable?'cache-unavailable':String(isolated);
    const context=await browser.newContext({viewport,hasTouch:true,isMobile:true});
    await context.addCookies([{name:'joey_original_session',value:cookie.slice(22),url:config.origin,httpOnly:true,sameSite:'Strict',secure:false}]);
    if(!isolated)await context.addInitScript(()=>Object.defineProperty(globalThis,'crossOriginIsolated',{value:false}));
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));const failureResponses=[];
    if(isolated&&initialWasmPath)await page.route('**/joey_original_bg.wasm',route=>route.fulfill({path:initialWasmPath,contentType:'application/wasm'}));
    let releaseResource;
    if(isolated&&delayResource){let held=false;const gate=new Promise(done=>releaseResource=done);await page.route('**/{resources,resource-bytes}/**',async route=>{if(!held){held=true;await gate;}await route.continue();});}
    page.on('response',response=>{if(response.url().endsWith('/api/failure'))failureResponses.push(response.status());});
    try{
     await page.goto(prefix,{waitUntil:'networkidle'});await page.waitForFunction(()=>!document.getElementById('start').disabled);if(cacheUnavailable)await page.evaluate(disableResourceStorage);const recorded=isolated?null:page.waitForResponse(response=>response.url().endsWith('/api/failure'));await page.locator('#start').tap();
     if(isolated&&delayResource){
      await page.waitForFunction(()=>window.joeyOriginal?.resourceStats.activeRequests>0&&(document.getElementById('status').textContent.includes('已准备')||document.getElementById('status').textContent.includes('已读取')),null,{timeout:120000});
      await page.locator('#startup-details summary').click();
      await page.waitForFunction(()=>document.getElementById('startup-report').textContent.length>0);
      const loading=await page.evaluate(()=>({status:document.getElementById('status').textContent,copyHidden:document.getElementById('copy-error').hidden,report:JSON.parse(document.getElementById('startup-report').textContent)}));
      assert(!loading.copyHidden&&loading.report.renders===0&&loading.report.resourceStats.activeRequests>0&&!loading.report.failure,'Loading state must remain inspectable without a panic');
      const bar=await page.locator('#loading-progress').evaluate(element=>({hidden:element.closest('#loading').hidden,determinate:element.hasAttribute('value'),label:document.getElementById('loading-label').textContent}));
      const preparation=loading.report.resourcePreload;
      assert(!bar.hidden&&bar.label.includes('资源')&&(cacheUnavailable?!bar.determinate:bar.determinate&&preparation.total===(revision.preloadBytes||39540213)&&preparation.completed>=0&&preparation.completed<preparation.total),'Known preload byte progress or unknown-total network fallback must remain truthful');
      assert(!loading.status.includes('已启动'),'Instantiation is not the first picture');
      await writeFile(resolve(evidence,name+'-'+caseTag+'-loading.json'),JSON.stringify({browser:name,version:revision.version,viewport,...loading},null,2)+'\n');
      await page.locator('#startup-details summary').click();releaseResource();
     }
     await page.waitForFunction(()=>window.joeyOriginal?.renders>=4||!document.getElementById('failure-details').hidden,null,{timeout:120000});
     const report=await page.evaluate(()=>({probe:window.joeyOriginal,status:document.getElementById('status').textContent,failure:document.getElementById('failure-report').textContent,detailsHidden:document.getElementById('failure-details').hidden,copyHidden:document.getElementById('copy-error').hidden}));
     if(isolated){assert(report.probe?.renders>=4,'Original first picture: '+JSON.stringify(report));assert(report.detailsHidden,'Normal startup must not show failure');assert(report.probe.audio.contextState==='running','Audio started by gesture');assert(report.probe.programProgress.received===report.probe.programProgress.total&&report.probe.programProgress.total>0,'Program progress must count all decompressed bytes');const box=await page.locator('canvas').boundingBox();assert(box?.width>0&&box?.height>0,'Original canvas must have visible dimensions');}
     else{assert(report.status.includes('共享内存'),'Missing isolation diagnostic');assert(!report.copyHidden&&!report.detailsHidden,'Copy and visible failure details');const details=JSON.parse(report.failure);assert(details.environment.isolated===false&&details.failure.startupPhase==='creating-host','Exact failing capability and phase');await recorded;assert(failureResponses.includes(200),'Authenticated failure was recorded');}
     assert(errors.length===0,'Page errors: '+errors.join(';'));
     const record={browser:name,isolated,version:revision.version,wasmSHA256:isolated&&initialWasmSHA256||revision.wasmSHA256,...report,errors,failureResponses};reports.push(record);
     await page.screenshot({path:resolve(evidence,name+'-'+caseTag+'.png')});await writeFile(resolve(evidence,name+'-'+caseTag+'.json'),JSON.stringify(record,null,2)+'\n');
     console.log(JSON.stringify({browser:name,isolated,renders:report.probe?.renders||0,status:report.status,failureResponses}));
     if(isolated&&restart){
      const saves=await page.evaluate(async()=>{const {openPlayerFiles}=await import('./player-files.mjs');const files=await openPlayerFiles();try{return await Promise.all((await files.load()).map(async file=>({path:file.path,length:file.bytes.length,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',file.bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')})));}finally{files.close();}});
      assert(saves.some(file=>file.path==='/deck.ydc'&&file.length===100)&&saves.some(file=>file.path.endsWith('/system.dat')&&file.length===5062),'Original startup created own fresh files');
      if(initialWasmPath)await page.unroute('**/joey_original_bg.wasm');
      await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>!document.getElementById('start').disabled);if(cacheUnavailable)await page.evaluate(disableResourceStorage);await page.locator('#start').tap();
      await page.waitForFunction(()=>window.joeyOriginal?.renders>=120||!document.getElementById('failure-details').hidden,null,{timeout:120000});
      const reopened=await page.evaluate(()=>({probe:window.joeyOriginal,status:document.getElementById('status').textContent,failure:document.getElementById('failure-report').textContent}));
      const restartTag=cacheUnavailable?'cache-unavailable-restart':'restart';
      await writeFile(resolve(evidence,name+'-'+restartTag+'.json'),JSON.stringify({browser:name,version:revision.version,wasmSHA256:revision.wasmSHA256,initialWasmSHA256,scope:'restart original with only the fresh files created by the first run',saves,...reopened},null,2)+'\n');
      await page.screenshot({path:resolve(evidence,name+'-'+restartTag+'.png')});
      console.log(JSON.stringify({browser:name,scope:'restart',renders:reopened.probe?.renders||0,status:reopened.status,diagnostics:reopened.probe?.diagnostics}));
      assert(reopened.probe?.renders>=120,'Restarting original with own saved files failed: '+reopened.status);
      assert(!reopened.failure&&reopened.probe.audio.contextState==='running','Restored original startup must remain healthy');
      assert(errors.length===0,'Restart page errors: '+errors.join(';'));
      if(cacheCheck&&!cacheUnavailable){
       assert(reopened.probe.resourceStats.requests===0&&reopened.probe.resourceStats.diskCacheBytes>=report.probe.resourceStats.downloadedBytes,'Warm startup must use the original cached bytes without DAT requests');
       const cacheMetadata=await page.evaluate(async()=>{const database=await new Promise((done,fail)=>{const request=indexedDB.open('joey-original-resource-bytes-v1',1);request.onsuccess=()=>done(request.result);request.onerror=()=>fail(request.error);});try{const entries=await new Promise((done,fail)=>{const request=database.transaction('metadata','readonly').objectStore('metadata').getAll();request.onsuccess=()=>done(request.result);request.onerror=()=>fail(request.error);});const item=entries.find(item=>item.key.includes(':/Voice.dat:')&&item.length===4096)||entries.find(item=>item.key.includes(':/Voice.dat:'));if(!item)throw Error('No test voice block');await new Promise((done,fail)=>{const tx=database.transaction('blocks','readwrite'),store=tx.objectStore('blocks'),request=store.get(item.key);request.onsuccess=()=>{const block=request.result;block.bytes[0]^=255;store.put(block);};tx.oncomplete=done;tx.onabort=()=>fail(tx.error);});return {entries:entries.length,bytes:entries.reduce((sum,item)=>sum+item.length,0),corruptedKey:item.key,corruptedLength:item.length};}finally{database.close();}});
       assert(cacheMetadata.bytes<=536870912&&cacheMetadata.entries<=4096,'Resource cache budget');
       await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>!document.getElementById('start').disabled);await page.locator('#start').tap();
       await page.waitForFunction(()=>window.joeyOriginal?.renders>=120||!document.getElementById('failure-details').hidden,null,{timeout:120000});
       const recovered=await page.evaluate(()=>({probe:window.joeyOriginal,status:document.getElementById('status').textContent}));
       await writeFile(resolve(evidence,name+'-cache-recovery.json'),JSON.stringify({browser:name,version:revision.version,cacheMetadata,...recovered},null,2)+'\n');
       assert(recovered.probe?.renders>=120&&recovered.probe.resourceCache.discarded===1&&recovered.probe.resourceStats.requests===1&&recovered.probe.resourceStats.downloadedBytes===cacheMetadata.corruptedLength,'Corrupted resource must be verified and refetched before original consumes it');
      }else if(cacheUnavailable){assert(reopened.probe.resourceCache.available===false&&reopened.probe.resourceStats.diskCacheHits===0&&reopened.probe.resourceStats.requests>0,'Optional cache failure must preserve original network startup and player-file database');}
     }
    }finally{releaseResource?.();await context.close();}
   }
  }finally{await browser.close();}
 }
 await writeFile(resolve(evidence,'checks.json'),JSON.stringify({version:revision.version,wasmSHA256:revision.wasmSHA256,initialWasmSHA256,restart,viewport,delayResource,cacheCheck,scope:'original startup plus failure diagnostics'+(restart?' and relaunch to 120 presents with original-created browser save files':'' )+(cacheCheck?', warm zero-DAT network, corrupted-block recovery and optional cache unavailable':'')+'; desktop browser engines with phone viewport; not physical iPhone or full duel acceptance',reports},null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
