// Drive the original game's right-button path; use only task-owned profiles.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const name=process.argv.includes('webkit')?'webkit':'chromium',publicRun=process.argv.includes('--public');
const label=process.argv.includes('--baseline')?'baseline':'fixed';
const root=resolve('.bridge/joey-web/reverse/output/original-preview'),out=resolve('.bridge/joey-web/reverse/output/right-click-1bpp');await mkdir(out,{recursive:true});
let server,url;
if(publicRun)url=JSON.parse(await readFile(out+'/deployment.json','utf8')).url;
else{const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));const port=name==='webkit'?18897:18898;const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:resolve('.bridge/joey-web/reverse/output/compression-20261013/light-pack'),origin:'http://127.0.0.1:'+port};server=await createOriginalServer(config);await new Promise(done=>server.listen(port,'127.0.0.1',done));url=config.origin+'/joey/original/';}
const expectedVersion=JSON.parse(await readFile(publicRun?out+'/deployment.json':root+'/revision.json','utf8')).version;
const profile=publicRun?resolve('.bridge/joey-web/reverse/output/original-public-own-test-profile-'+name):resolve('.bridge/joey-web/reverse/output/deck-library/own-'+name);
const context=await (name==='webkit'?webkit:chromium).launchPersistentContext(profile,{headless:true,...(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']}:{ }),viewport:{width:915,height:412},hasTouch:true,isMobile:true});
const page=context.pages()[0]||await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const report={browser:name,url,scope:'Original native right-click popup and return; task-owned profile, desktop engine',checks:[]};
const prefix=(publicRun?'public-':'local-')+name+'-'+label;
const screenshot=async label=>writeFile(out+'/'+prefix+'-'+label+'.png',Buffer.from(await page.locator('canvas').evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
const frames=async n=>{const target=await page.evaluate(()=>window.joeyOriginal.renders)+n;await page.waitForFunction(target=>window.joeyOriginal.renders>=target||window.joeyOriginal.stages.some(s=>s.stage==='failed'),target,{timeout:180000});const failure=await page.evaluate(()=>window.joeyOriginal.stages.find(s=>s.stage==='failed'));if(failure)throw Error(JSON.stringify(failure));};
const move=async(x,y)=>{const b=await page.locator('canvas').boundingBox();await page.mouse.move(b.x+x*b.width/800,b.y+y*b.height/600);};
const click=async(x,y,button='left',wait=60)=>{await move(x,y);await page.mouse.down({button});await page.waitForTimeout(90);await page.mouse.up({button});await frames(wait);};
const timer=setInterval(async()=>{try{console.log(JSON.stringify({browser:name,check:report.checks.at(-1),renders:await page.evaluate(()=>window.joeyOriginal?.renders)}));}catch{}},20000);
try{
 await page.goto(url,{waitUntil:'networkidle'});await page.waitForFunction(()=>!document.getElementById('start').disabled);await page.locator('#start').tap();await page.waitForFunction(()=>window.joeyOriginal?.renders>=4||window.joeyOriginal?.stages.some(s=>s.stage==='failed'),null,{timeout:180000});await frames(600);
 report.version=await page.locator('#version').textContent();assert(report.version.includes(expectedVersion));await screenshot('main-menu');
 // Mobile toolbar emits the same native button events as a physical right click.
 await move(400,300);await page.locator('#right-click').tap();await frames(150);await screenshot('menu-right-click');report.checks.push('menu toolbar right-click');
 if(!process.argv.includes('--duel-only')){
 await click(400,390,'left',150);await screenshot('editor');
 await click(290,55,'right',150);await screenshot('editor-right-click');report.checks.push('editor card right-click');
 await page.locator('[data-key=Escape]').tap();await frames(120);
 await click(110,570,'left',180);await screenshot('returned');
 }
 await click(400,338,'left',150);await screenshot('duel-mode');
 await click(400,338,'left',500);await screenshot('duel-dialogue');
 await page.locator('#right-click').tap();await frames(150);await screenshot('dialogue-right-click');report.checks.push('duel dialogue toolbar right-click');
 await click(210,450,'left',350);await page.locator('[data-key=Enter]').tap();await frames(800);await screenshot('duel-progress');
 // The native game ignores commands during the computer's animation/turn.
 // Wait for it to finish, so the right click exercises an interactive phase.
 await frames(1800);await screenshot('player-turn');
 await click(550,560,'right',150);await screenshot('hand-right-click');report.checks.push('duel hand right-click');
 await move(400,300);await page.locator('#right-click').tap();await frames(150);await screenshot('duel-toolbar-right-click');report.checks.push('duel toolbar right-click');
 await page.locator('[data-key=Escape]').tap();await frames(100);await screenshot('cancel-turn-dialog');
 await page.locator('[data-key=Escape]').tap();await frames(100);await screenshot('reopened-turn-dialog');report.checks.push('reopen turn-confirmation dialog');
 report.errors=errors;assert.deepEqual(errors,[]);report.diagnostics=await page.evaluate(()=>window.joeyOriginal);console.log(JSON.stringify({browser:name,checks:report.checks,passed:true}));
}catch(error){report.error=error.message;report.diagnostics=await page.evaluate(()=>window.joeyOriginal);await screenshot('failure');console.log(JSON.stringify({browser:name,checks:report.checks,error:report.error}));process.exitCode=1;}
finally{await writeFile(out+'/'+prefix+'-checks.json',JSON.stringify(report,null,2)+'\n');clearInterval(timer);await context.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}}
