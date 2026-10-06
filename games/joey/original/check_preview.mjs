// Exercise the shipped host, login, archive ranges, touch coordinates and fresh browser saves.
import {createRequire} from 'node:module';
import {open,writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {scryptSync} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {startWorkerProfiler} from '../reverse/worker-profiler.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const output=resolve('.bridge/joey-web/reverse/output'),rootArgument=process.argv.indexOf('--root'),root=rootArgument<0?resolve(output,'original-preview'):resolve(process.argv[rootArgument+1]);
const revision=JSON.parse(await readFile(resolve(root,'revision.json'),'utf8'));
const audioRecovery=process.argv.includes('--audio-recovery');
const resourceTrace=process.argv.includes('--resource-trace');
const demoCycle=process.argv.includes('--demo-cycle');
const fullCache=process.argv.includes('--full-cache');
const frameTrace=process.argv.includes('--frame-trace');
const cpuSampling=process.argv.includes('--cpu-sampling');
const evidence=resolve(output,'original-preview-check-'+revision.version+(fullCache?'-full-cache':'-common-cache')+(audioRecovery?'-audio-recovery':'')+(resourceTrace?'-resource-trace':'')+(demoCycle?'-demo-cycle':'')+(frameTrace?'-frame-trace':'')+(cpuSampling?'-cpu-sampling':''));await mkdir(evidence,{recursive:true});
const {createOriginalServer}=await import(pathToFileURL(resolve(root,'server.mjs')));
const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),origin:'http://127.0.0.1',passwordSalt:'local-original-preview',passwordHash:scryptSync('local-preview-password','local-original-preview',32).toString('hex')};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));
config.origin='http://127.0.0.1:'+server.address().port;const prefix=config.origin+'/joey/original/';
const reports=[];
const assert=(condition,message)=>{if(!condition)throw Error(message);};
try{
  const blocked=await fetch(prefix+'joey_original_bg.wasm');assert(blocked.status===401,'WASM must require login');
  const foreign=await fetch(prefix+'api/login',{method:'POST',headers:{Origin:'https://invalid.example','Content-Type':'application/json'},body:JSON.stringify({password:'local-preview-password'})});assert(foreign.status===403,'Login origin');
  const login=await fetch(prefix+'api/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({password:'local-preview-password'})});assert(login.status===200,'Local login');
  const cookie=login.headers.get('set-cookie');assert(cookie.includes('Secure')&&cookie.includes('HttpOnly')&&cookie.includes('Path=/joey/original/')&&cookie.includes('SameSite=Strict'),'Cookie scope');
  const Cookie=cookie.split(';')[0],headers={Cookie};
  const range=await fetch(prefix+'resources/Voice.dat',{headers:{...headers,Range:'bytes=0-4095'}});
  assert(range.status===206&&range.headers.get('content-range')==='bytes 0-4095/145041724','Archive byte ranges');
  const archive=await open(resolve(config.resourcesRoot,'Voice.dat'),'r'),expected=Buffer.alloc(4096);try{await archive.read(expected,0,4096,0);}finally{await archive.close();}
  assert(Buffer.from(await range.arrayBuffer()).equals(expected),'Archive range bytes');
  const sliceAPI=(await (await fetch(prefix+'api/session',{headers})).json()).resources.some(file=>file.compressedURL);
  if(sliceAPI){
  for(const encoding of ['gzip','identity','gzip;q=0']){
    const sliced=await fetch(prefix+'resource-bytes/Voice.dat?start=0&end=4095',{headers:{...headers,'Accept-Encoding':encoding}});
    assert(sliced.status===200&&sliced.headers.get('x-original-range')==='bytes 0-4095/145041724','Slice representation offsets');
    assert((sliced.headers.get('content-encoding')==='gzip')===(encoding==='gzip'),'Slice gzip negotiation');
    assert(Buffer.from(await sliced.arrayBuffer()).equals(expected),'Decoded slice preserves original bytes');
  }
  assert((await fetch(prefix+'resource-bytes/Voice.dat?start=0&end=1')).status===401,'Slice requires login');
  assert((await fetch(prefix+'resource-bytes/system.dat?start=0&end=1',{headers})).status===404,'Slice cannot access player files');
  assert((await fetch(prefix+'resource-bytes/data.dat?start=0&end=999999999',{headers})).status===416,'Slice range limit');
  }
  assert((await fetch(prefix+'resources/system.dat',{headers:{...headers,Range:'bytes=0-99'}})).status===404,'No server save access');
  assert((await fetch(prefix+'resources/data.dat',{headers:{...headers,Range:'bytes=0-999999999'}})).status===416,'Range limit');
  for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
    if(process.argv.includes('--webkit-only')&&name!=='webkit')continue;
    if(process.argv.includes('--chromium-only')&&name!=='chromium')continue;
    if(cpuSampling&&name!=='chromium')continue;
    const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
    const context=await browser.newContext({viewport:{width:915,height:412},hasTouch:true,isMobile:true});
    if(audioRecovery)await context.addInitScript(()=>{
      const Original=AudioContext;window.testAudioContexts=[];
      window.AudioContext=class extends Original{constructor(...args){super(...args);window.testAudioContexts.push(this);}};
    });
    await context.addCookies([{name:'joey_original_session',value:Cookie.slice(22),url:config.origin,httpOnly:true,sameSite:'Strict',secure:false}]);
    const page=await context.newPage(),errors=[],consoleMessages=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{consoleMessages.push({type:message.type(),text:message.text().slice(0,12000)});if(consoleMessages.length>200)consoleMessages.shift();});
    // Test-only complete trace; the shipped host retains its bounded last 200.
    if(resourceTrace||frameTrace){
      let source=await readFile(resolve(root,'browser-host.mjs'),'utf8');
      if(resourceTrace){const limited='if (probe.resourceReads.length > 200) probe.resourceReads.shift();';assert(source.includes(limited),'Resource trace hook');source=source.replace(limited,'');}
      if(frameTrace){
        const marker='timing.lastRenderAt=now;timing.windowFrames++;';assert(source.includes(marker),'Frame timing trace hook');
        source=source.replace(marker,marker+`
    if(timing.lastIntervalMs>=100){
      const gaps=probe.longFrames||=[];gaps.push({atRender:probe.renders+1,at:now,intervalMs:timing.lastIntervalMs,
        resourceReadMsSincePresent:reader.stats.readMs-(probe.readMsAtPresent||0),lastRead:{...reader.stats.lastRead},lastInput:{...probe.lastInput},pendingReads:reader.stats.pendingReads.map(read=>({...read}))});
      if(gaps.length>32)gaps.shift();
    }
    probe.readMsAtPresent=reader.stats.readMs;
`);
      }
      await page.route('**/browser-host.mjs',route=>route.fulfill({body:source,contentType:'text/javascript'}));
    }
    const failure=()=>page.evaluate(()=>window.joeyOriginal?.stages.find(stage=>['failed','host-failed','worker-error'].includes(stage.stage)));
    const frames=async count=>{await page.waitForFunction(count=>window.joeyOriginal?.renders>=count||window.joeyOriginal?.stages.some(stage=>['failed','host-failed','worker-error'].includes(stage.stage)),count,{timeout:120000});assert(!await failure(),'Original runtime fault: '+JSON.stringify(await failure()));};
    let profiler;
    try{
      await page.goto(prefix,{waitUntil:'networkidle'});
      assert(await page.evaluate(()=>crossOriginIsolated),'Shared memory isolation');
      await page.locator('#start').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('start').disabled);
      assert(!await page.locator('#complete-resources').isChecked(),'Full installation must be opt-in');
      if(fullCache)await page.locator('#complete-resources').check();
      await page.locator('#start').tap();await frames(4);
      if(cpuSampling)profiler=await startWorkerProfiler(browser,prefix+'original-worker.mjs');
      const prepared=await page.evaluate(()=>({preload:window.joeyOriginal.resourcePreload,requests:window.joeyOriginal.resourceStats.requests}));
      assert(prepared.preload.complete&&prepared.preload.mode===(fullCache?'complete':'common')&&prepared.preload.total===(fullCache?revision.completePreloadBytes:revision.preloadBytes)&&prepared.preload.completed===prepared.preload.total,'Selected original resource plan must finish before play');
      const unexpected=[];
      if(fullCache)await page.route('**/{resources,resource-bytes}/**',route=>{unexpected.push(route.request().url());return route.abort();});
      await page.locator('[data-key=Enter]').tap();
      await frames(450);await page.screenshot({path:resolve(evidence,'original-preview-'+name+'-intro.png')});await page.locator('[data-key=Enter]').tap();
      await frames(650);
      const click=async(x,y,hold=100)=>{const box=await page.locator('canvas').boundingBox();await page.mouse.move(box.x+x*box.width/800,box.y+y*box.height/600);await page.mouse.down();await page.waitForTimeout(hold);await page.mouse.up();};
      await click(400,338);
      let audioEvidence;
      if(audioRecovery){
        await frames(700);await page.waitForFunction(()=>window.joeyOriginal.audio.nonzeroSamples>0&&window.joeyOriginal.audio.playedFrames>0,null,{timeout:30000});
        await page.evaluate(()=>window.testAudioContexts[0].suspend());
        await page.waitForFunction(()=>window.joeyOriginal.audio.contextState==='suspended');
        await page.waitForTimeout(300);const before=await page.evaluate(()=>({...window.joeyOriginal.audio}));
        await page.screenshot({path:resolve(evidence,name+'-suspended-dialogue.png')});
        await page.waitForTimeout(3000);const paused=await page.evaluate(()=>({...window.joeyOriginal.audio}));
        assert(paused.playedFrames===before.playedFrames,'Suspended output must stop actual audio consumption');
        await page.locator('#sound').tap();await page.waitForFunction(frames=>window.joeyOriginal.audio.contextState==='running'&&window.joeyOriginal.audio.playedFrames>frames,paused.playedFrames,{timeout:10000});
        const resumed=await page.evaluate(()=>({...window.joeyOriginal.audio}));
        audioEvidence={before,paused,resumed,scope:'Actual AudioContext suspension and user-gesture resumption with the shipped original at dialogue; desktop engines, not physical iPhone audio audibility'};
      }
      await frames(1400);await page.screenshot({path:resolve(evidence,'original-preview-'+name+'-janken.png')});
      if(!audioRecovery){await click(210,450,150);await frames(1700);await page.locator('[data-key=Enter]').tap();await frames(2500);}
      await page.screenshot({path:resolve(evidence,'original-preview-'+name+'-after-choice.png')});
      const report=await page.evaluate(()=>({...window.joeyOriginal,isolated:crossOriginIsolated,canvas:(()=>{const c=document.querySelector('canvas'),b=c.getBoundingClientRect();return {width:c.width,height:c.height,displayWidth:b.width,displayHeight:b.height};})()}));
      let cpuEvidence;
      if(profiler){const sampled=await profiler.stop();profiler=null;const path=resolve(evidence,'original-preview-'+name+'.cpuprofile');await writeFile(path,JSON.stringify(sampled.profile));cpuEvidence={path,clock:sampled.clock};}
      if(fullCache)assert(unexpected.length===0&&report.resourceStats.requests===prepared.requests,'Complete mode must continue with all archive network blocked');
      else assert(report.resourceStats.downloadedBytes<100663296,'Common mode must not silently download the full archives');
      assert((report.resourceCache.pageMemoryBytes||0)<=4194304&&report.resourceStats.cacheBytes<=4194304,'Archive pages and active assets must each remain bounded');
      if(revision.files['worker-read-cache.mjs'])assert(report.workerReadCache?.hits>0&&report.workerReadCache.capacityBytes===4194304,'Actual original Worker must use the bounded direct byte cache');
      assert(errors.length===0,'Browser page errors: '+errors.join(';'));
      assert(Math.abs(report.canvas.displayWidth/report.canvas.displayHeight-4/3)<.01,'Original canvas must retain 4:3 ratio');
      const saves=await page.evaluate(async()=>{const {openPlayerFiles}=await import('./player-files.mjs');const files=await openPlayerFiles();try{return (await files.load()).map(file=>({path:file.path,length:file.bytes.length}));}finally{files.close();}});
      assert(saves.some(file=>file.path==='/deck.ydc'&&file.length===100)&&saves.some(file=>file.path.endsWith('/system.dat')&&file.length===5062),'Fresh original files must persist in browser');
      // Reopen storage in a new document; never import a server-side player profile.
      await page.reload({waitUntil:'networkidle'});
      const reloaded=await page.evaluate(async()=>{const {openPlayerFiles}=await import('./player-files.mjs');const files=await openPlayerFiles();try{return (await files.load()).map(file=>({path:file.path,length:file.bytes.length}));}finally{files.close();}});
      assert(JSON.stringify(reloaded)===JSON.stringify(saves),'Browser files survive reload');
      let fullToCommon;
      if(fullCache&&!demoCycle){
        // An existing complete install must remain reusable by the new default.
        assert(!await page.locator('#complete-resources').isChecked(),'Reload resets complete-install opt-in');
        await page.waitForFunction(()=>!document.getElementById('start').disabled);
        await page.locator('#start').tap();await frames(120);
        fullToCommon=await page.evaluate(()=>({...window.joeyOriginal}));
        assert(fullToCommon.resourcePreload.mode==='common'&&fullToCommon.resourcePreload.total===revision.preloadBytes&&fullToCommon.resourceStats.requests===0&&unexpected.length===0,'Common mode must reuse complete-page cache with no archive network');
      }
      let demoEvidence;
      if(demoCycle){
        // The original idle menu starts its own demonstration duel. Exercise
        // that path using the same shipped host and this browser's fresh files.
        await page.waitForFunction(()=>!document.getElementById('start').disabled);
        if(fullCache)await page.locator('#complete-resources').check();
        await page.locator('#start').tap();await frames(4);
        await page.locator('[data-key=Enter]').tap();await frames(450);
        await page.locator('[data-key=Enter]').tap();await frames(650);
        // With the original saved menu state, Enter has opened the duel-mode
        // submenu. Return to the root menu, where the original idle timer runs.
        await page.locator('[data-key=Escape]').tap();await frames(900);
        await page.screenshot({path:resolve(evidence,'original-demo-'+name+'-root-menu.png')});
        for(let count=1200;count<=6000;count+=600){
          await frames(count);
          if(count%1800===0)await page.screenshot({path:resolve(evidence,'original-demo-'+name+'-'+count+'.png')});
          console.log(JSON.stringify({browser:name,scope:'original-idle-demonstration',renders:await page.evaluate(()=>window.joeyOriginal.renders)}));
        }
        demoEvidence=await page.evaluate(()=>({...window.joeyOriginal}));
        if(fullCache)assert(unexpected.length===0&&demoEvidence.resourceStats.requests===0,'Original demo must use the full local archive cache');
        else assert(demoEvidence.resourceStats.downloadedBytes<100663296,'Common mode demo must remain bounded on demand');
        assert(demoEvidence.audio.contextState==='running'&&demoEvidence.audio.nonzeroSamples>0,'Original demo audio must run');
      }
      const archiveNetwork={preloadMode:fullCache?'complete':'common',preparedRequests:prepared.requests,requestsAtPlayerCapture:report.resourceStats.requests,unexpectedDuringPlay:unexpected.length,decodedBytesAtPlayerCapture:report.resourceStats.downloadedBytes};
      const result={browser:name,version:revision.version,wasmSHA256:revision.wasmSHA256,report,saves,reloaded,errors,audioEvidence,demoEvidence,fullToCommon,cpuEvidence,archiveNetwork};reports.push(result);await writeFile(resolve(evidence,'original-preview-'+name+'.json'),JSON.stringify(result,null,2)+'\n');
      console.log(JSON.stringify({browser:name,renders:report.renders,stages:report.stages,audio:report.audio,saves,canvas:report.canvas}));
    }catch(error){const report=await page.evaluate(()=>window.joeyOriginal||null).catch(()=>null);await writeFile(resolve(evidence,'original-preview-'+name+'-failure.json'),JSON.stringify({browser:name,version:revision.version,wasmSHA256:revision.wasmSHA256,error:String(error),errors,consoleMessages,report},null,2)+'\n');throw error;}finally{if(profiler)await profiler.close();await context.close();await browser.close();}
  }
  const summary={version:revision.version,wasmSHA256:revision.wasmSHA256,preloadMode:fullCache?'complete':'common',evidenceDirectory:evidence,httpChecks:true,reports:reports.map(item=>({browser:item.browser,renders:item.report.renders,stages:item.report.stages,saves:item.saves,archiveNetwork:item.archiveNetwork,...(item.demoEvidence?{demoRenders:item.demoEvidence.renders,demoStages:item.demoEvidence.stages,demoDATRequests:item.demoEvidence.resourceStats.requests}:{})}))};
  await writeFile(resolve(evidence,'checks.json'),JSON.stringify(summary,null,2)+'\n');await writeFile(resolve(output,'original-preview-checks.json'),JSON.stringify(summary,null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
