// Real game, independent browser profiles; exercise rotation after first frame.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const address=process.argv.indexOf('--url'),root=resolve('.bridge/joey-web/reverse/output/original-preview');
const out=resolve(process.env.JOEY_LAYOUT_EVIDENCE||'.bridge/joey-web/reverse/output/landscape-20261015/real-game');await mkdir(out,{recursive:true});
let server,url;
if(address>=0)url=new URL(process.argv[address+1]).href;
else{
 const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));
 const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:resolve('.bridge/joey-web/reverse/output/compression-20261013/light-pack'),origin:'http://127.0.0.1'};
 server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin='http://127.0.0.1:'+server.address().port;url=config.origin+'/joey/original/';
}
const reports=[];
try{
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true,...(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
  const context=await browser.newContext({viewport:{width:402,height:714},isMobile:true,hasTouch:true,ignoreHTTPSErrors:true});context.setDefaultTimeout(120000);
  try{
   const page=await context.newPage();await page.goto(url);await page.waitForFunction(()=>!document.getElementById('start').disabled);await page.locator('#start').tap();
   try{await page.waitForFunction(()=>window.joeyOriginal?.renders>=120||!document.getElementById('failure-details').hidden,null,{timeout:address>=0?300000:120000});}
   catch(error){console.error(JSON.stringify(await page.evaluate(()=>({version:document.getElementById('version').textContent,status:document.getElementById('status').textContent,stages:window.joeyOriginal?.stages,preload:window.joeyOriginal?.resourcePreload,download:window.joeyOriginal?.programDownload,diagnostics:window.joeyOriginal?.diagnostics}))));throw error;}
   assert(await page.evaluate(()=>window.joeyOriginal.renders>=120),'Original game must render before rotation');
   for(const [label,width,height,safeArea]of [['portrait',402,714,false],['landscape',874,402,false],['browser-bars',874,320,false],['small-landscape',568,320,false],['safe-area',874,320,true],['portrait-again',402,714,false]]){
    await page.setViewportSize({width,height});await page.evaluate(safe=>{document.body.style.padding=safe?'0px 44px 21px':'0px';},safeArea);
    await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    const measure=()=>page.evaluate(()=>{const rect=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};return {version:document.getElementById('version').textContent,viewport:[innerWidth,innerHeight],canvas:rect('#game-surface canvas'),surface:rect('#game-surface'),tools:rect('#game-tools'),scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],frames:window.joeyOriginal.renders,audio:window.joeyOriginal.audio.contextState};});
    const report=await measure(),{canvas,surface}=report;
    assert(canvas.width>0&&canvas.height>0);assert(Math.abs(canvas.width*600-canvas.height*800)<=800,'Preserve 800:600 picture ratio');
    assert(canvas.x>=surface.x-1&&canvas.y>=surface.y-1&&canvas.x+canvas.width<=surface.x+surface.width+1&&canvas.y+canvas.height<=surface.y+surface.height+1,'Whole picture stays inside its surface');
    assert(report.scroll[0]<=width+1&&report.scroll[1]<=height+1,'No document overflow after rotation');
    if(width>height){
     assert(surface.height>=height-(safeArea?21:0)-1,'Game must retain usable landscape height');
     await page.locator('#startup-details summary').click();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
     const expanded=await measure();assert(Math.abs(expanded.canvas.height-canvas.height)<=1&&Math.abs(expanded.canvas.width-canvas.width)<=1,'Diagnostics must not shrink the landscape game');
     await page.locator('#startup-details summary').click();
     for(const id of ['right-click','keyboard','sound','fullscreen']){const button=page.locator('#'+id);await button.scrollIntoViewIfNeeded();assert(await button.isVisible(),id+' stays accessible');}
    }
    const queued=await page.evaluate(()=>window.joeyOriginal.inputQueued);await page.touchscreen.tap(canvas.x+5,canvas.y+5);assert(await page.evaluate(()=>window.joeyOriginal.inputQueued)>=queued+2,'Rotated canvas still receives touch down/up');
    reports.push({browser:name,label,...report});if(label==='safe-area')await page.screenshot({path:out+'/'+name+'-landscape.png'});
   }
   console.log(JSON.stringify({browser:name,rotationCases:6,preservedAspectRatio:true,preservedLandscapeHeight:true,diagnosticsDoNotShrinkGame:true,touchDelivered:true}));
  }finally{await context.close();await browser.close();}
 }
 await writeFile(out+'/checks.json',JSON.stringify({scope:'Desktop Chromium and WebKit, real original program, simulated phone rotation and safe-area padding; not physical-phone acceptance',reports},null,2)+'\n');
}finally{if(server)await new Promise(done=>server.close(done));}
