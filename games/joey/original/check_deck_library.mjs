// Operate the original UI and compare its own saved groups with the recipes.
// Uses only task-owned browser profiles; desktop engines are not phone acceptance.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectionCatalog as catalog} from './collection-catalog.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const name=process.argv.includes('webkit')?'webkit':'chromium',publicRun=process.argv.includes('--public');
const root=resolve('.bridge/joey-web/reverse/output/original-preview'),out=resolve('.bridge/joey-web/reverse/output/deck-library');await mkdir(out,{recursive:true});
let server,url;
if(publicRun)url=JSON.parse(await readFile(resolve(out,'deployment.json'),'utf8')).url;
else{const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:resolve('.bridge/joey-web/reverse/output/compression-20261013/light-pack'),origin:'http://127.0.0.1:18897'};server=await createOriginalServer(config);await new Promise(done=>server.listen(18897,'127.0.0.1',done));url=config.origin+'/joey/original/';}
const expectedVersion=JSON.parse(await readFile(publicRun?out+'/deployment.json':root+'/revision.json','utf8')).version;
const engine=name==='webkit'?webkit:chromium;
const profile=publicRun?resolve('.bridge/joey-web/reverse/output/original-public-own-test-profile-'+name):out+'/own-'+name;
const context=await engine.launchPersistentContext(profile,{headless:true,...(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']}:{ }),viewport:{width:915,height:412},hasTouch:true,isMobile:true});
const page=context.pages()[0]||await context.newPage(),errors=[],trace=[];page.on('pageerror',e=>errors.push(e.message));
if(!publicRun){const source=(await readFile(root+'/browser-host.mjs','utf8')).replace("traceSpec='',","traceSpec='kernel32/file,advapi32',");await page.route('**/browser-host.mjs',r=>r.fulfill({body:source,contentType:'text/javascript'}));page.on('console',m=>{const text=m.text();if(/FindFirst|FindNext|CreateFileA|RegSet|RegQuery|CommonDir/.test(text))trace.push(text);});}
const report={browser:name,url,scope:'Original native loose-YDC list, read, return/save and reload; task-owned profile, desktop engine',checks:[]};
const groups=bytes=>{const b=Uint8Array.from(bytes),v=new DataView(b.buffer);let offset=8;const result=[];for(let i=0;i<3;i++){const n=v.getUint16(offset,true);offset+=2;result.push(Array.from({length:n},()=>{const card=v.getUint16(offset,true);offset+=2;return card%2000;}).sort((a,b)=>a-b));}assert.equal(offset,b.length);return result;};
const frames=async n=>{const target=await page.evaluate(()=>window.joeyOriginal.renders)+n;await page.waitForFunction(target=>window.joeyOriginal.renders>=target||window.joeyOriginal.stages.some(s=>s.stage==='failed'),target,{timeout:180000});const failure=await page.evaluate(()=>window.joeyOriginal.stages.find(s=>s.stage==='failed'));if(failure)throw Error(JSON.stringify(failure));};
const click=async(x,y,wait=6)=>{const b=await page.locator('canvas').boundingBox();await page.mouse.move(b.x+x*b.width/800,b.y+y*b.height/600);await page.mouse.down();await page.waitForTimeout(70);await page.mouse.up();await frames(wait);};
const screenshot=async label=>writeFile(out+'/'+(publicRun?'public-':'local-')+name+'-'+label+'.png',Buffer.from(await page.locator('canvas').evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
const files=()=>page.evaluate(async()=>{const {openPlayerFiles}=await import('./player-files.mjs');const p=await openPlayerFiles();try{return(await p.load()).map(f=>({path:f.path,bytes:Array.from(f.bytes)}));}finally{p.close();}});
const start=async()=>{await page.goto(url,{waitUntil:'networkidle'});await page.waitForFunction(()=>!document.getElementById('start').disabled);await page.locator('#start').tap();await page.waitForFunction(()=>window.joeyOriginal?.renders>=4||window.joeyOriginal?.stages.some(s=>s.stage==='failed'),null,{timeout:180000});await frames(600);};
const timer=setInterval(async()=>{try{console.log(JSON.stringify({browser:name,step:report.checks.at(-1)?.deck||'startup',renders:await page.evaluate(()=>window.joeyOriginal?.renders)}));}catch{}},20000);
try{
 await start();report.version=await page.locator('#version').textContent();assert(report.version.includes(expectedVersion),'Wrong deployed version');
 let initial=await files();assert.equal(initial.filter(f=>catalog.decks.some(d=>d.filePath===f.path)).length,45);report.installedDecks=45;
 for(const number of [2,13,45]){
  const preset=catalog.decks[number-1];await click(400,390,150);await click(157,70,30);
  await screenshot('opened-'+number);const scroll=Math.max(0,number-6);for(let i=0;i<scroll;i++)await click(512,327,2);
  await screenshot('list-'+number);const row=Math.min(number-1,5);await click(375,241+row*17,15);await screenshot('selected-'+number);
  await click(361,387,300);await screenshot('loaded-'+number);await click(110,570,180);
  const saved=await files(),deck=saved.find(f=>f.path==='/deck.ydc');assert(deck);const actual=groups(deck.bytes),expected=groups(Buffer.from(preset.bytes,'base64'));assert.deepEqual(actual,expected,'Native saved card groups for '+preset.id);
  report.checks.push({deck:preset.id,nativeSavedGroups:actual.map(g=>g.length),allCardIdsMatch:true});console.log(JSON.stringify(report.checks.at(-1)));
 }
 const prior=(await files()).find(f=>f.path==='/deck.ydc').bytes;await start();assert.deepEqual((await files()).find(f=>f.path==='/deck.ydc').bytes,prior,'Reload changed the last native selection');report.reloadPreservesNativeSelection=true;
 report.errors=errors;assert.deepEqual(errors,[]);report.renderTiming=await page.evaluate(()=>window.joeyOriginal.renderTiming);await screenshot('reload');
 await writeFile(out+'/'+(publicRun?'public-':'local-')+name+'-native-checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await writeFile(out+'/'+(publicRun?'public-':'local-')+name+'-trace.json',JSON.stringify(trace,null,2)+'\n');clearInterval(timer);await context.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}}
