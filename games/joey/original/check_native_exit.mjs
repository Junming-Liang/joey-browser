// Actual original menu exit, using only the existing task-owned test profile.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const baseline=process.argv.includes('--baseline'),name=process.argv.includes('webkit')?'webkit':'chromium';
const out=resolve('.bridge/joey-web/reverse/output/audit-20261013'),root=resolve('.bridge/joey-web/reverse/output/original-preview');await mkdir(out,{recursive:true});
const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));
const port=name==='webkit'?18897:18898,config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:resolve('.bridge/joey-web/reverse/output/compression-20261013/light-pack'),origin:'http://127.0.0.1:'+port};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(port,'127.0.0.1',done));
const context=await(name==='webkit'?webkit:chromium).launchPersistentContext(resolve('.bridge/joey-web/reverse/output/deck-library/own-'+name),{headless:true,...(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
const page=context.pages()[0]||await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(config.origin+'/joey/original/',{waitUntil:'networkidle'});await page.waitForFunction(()=>!document.getElementById('start').disabled);await page.locator('#start').click();
 await page.waitForFunction(()=>window.joeyOriginal?.renders>=600||window.joeyOriginal?.stages.some(s=>s.stage==='failed'),null,{timeout:180000});
 let second;
 if(!baseline){
  second=await context.newPage();await second.goto(config.origin+'/joey/original/',{waitUntil:'networkidle'});await second.waitForFunction(()=>!document.getElementById('start').disabled);await second.locator('#start').click();
  await second.waitForFunction(()=>window.joeyOriginal?.stages.some(s=>['host-failed','failed'].includes(s.stage)),null,{timeout:10000});
  const blocked=await second.evaluate(()=>({status:document.getElementById('status').textContent,probe:window.joeyOriginal}));
  assert(blocked.status.includes('另一游戏标签'));assert.equal(blocked.probe.renders,0);assert.equal(blocked.probe.resourceStats.requests,0);assert.equal(blocked.probe.audio.contextState,'closed');
  await writeFile(out+'/'+name+'-writer-second-tab.json',JSON.stringify(blocked,null,2)+'\n');
 }
 await page.locator('[data-key=Escape]').click();await page.waitForFunction(()=>window.joeyOriginal.stages.some(s=>['returned','failed'].includes(s.stage)),null,{timeout:30000});await page.waitForTimeout(300);
 const report=await page.evaluate(()=>({version:document.getElementById('version').textContent,status:document.getElementById('status').textContent,probe:window.joeyOriginal}));
 await writeFile(out+'/'+name+'-native-exit-'+(baseline?'before':'after')+'.json',JSON.stringify({...report,errors},null,2)+'\n');console.log(JSON.stringify({browser:name,version:report.version,stages:report.probe.stages.map(s=>s.stage),diagnostics:report.probe.diagnostics,status:report.status,audio:report.probe.audio.contextState}));
 if(!baseline){assert(!report.probe.stages.some(s=>s.stage==='failed'));assert(report.probe.stages.some(s=>s.stage==='returned'));assert.equal(report.probe.audio.contextState,'closed');assert.deepEqual(errors,[]);
  await second.reload({waitUntil:'networkidle'});await second.waitForFunction(()=>!document.getElementById('start').disabled);await second.locator('#start').click();
  await second.waitForFunction(()=>window.joeyOriginal?.renders>=120||window.joeyOriginal?.stages.some(s=>['host-failed','failed'].includes(s.stage)),null,{timeout:120000});
  const reclaimed=await second.evaluate(()=>window.joeyOriginal);assert(reclaimed.renders>=120);assert.equal(reclaimed.audio.contextState,'running');
  await writeFile(out+'/'+name+'-writer-after-exit.json',JSON.stringify({scope:'Real original host, same browser profile and origin; second tab denied before resources and reclaimed after original exit',probe:reclaimed},null,2)+'\n');
 }
}finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
