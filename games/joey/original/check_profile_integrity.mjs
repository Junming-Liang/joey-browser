// Real IndexedDB transactions in independent test contexts; no user profile.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const baseline=process.argv.includes('--baseline'),names=process.argv.includes('webkit')?['webkit']:['chromium'];
const out=resolve('.bridge/joey-web/reverse/output/audit-20261013');await mkdir(out,{recursive:true});
const source=await readFile('games/joey/original/player-files.mjs','utf8');
for(const name of names){
 const browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
 const context=await browser.newContext();await context.route('https://joey-audit.invalid/**',route=>route.fulfill({contentType:route.request().url().endsWith('.mjs')?'text/javascript':'text/html',body:route.request().url().endsWith('.mjs')?source:'<!doctype html><title>Own profile test</title>'}));
 const page=await context.newPage();await page.goto('https://joey-audit.invalid/');
 try{
 const report=await page.evaluate(async()=>{
  const {openPlayerFiles}=await import('./player-files.mjs'),a=await openPlayerFiles(),b=await openPlayerFiles();
  const bytes=n=>Uint8Array.of(n);await a.save('/deck.ydc',bytes(1));
  await a.patch('before-deck',files=>files.map(f=>f.path==='/deck.ydc'?{...f,bytes:bytes(2)}:f));
  await a.patch('before-deck',files=>files);await a.restore('before-deck');
  const backupRestored=(await a.load()).find(f=>f.path==='/deck.ydc').bytes[0];
  let writerExclusive=null;
  if(a.acquireWriter){const release=await a.acquireWriter();try{await b.acquireWriter();writerExclusive=false;}catch{writerExclusive=true;}await release();const releaseB=await b.acquireWriter();await releaseB();}
  for(let i=0;i<62;i++)await a.save('/own-'+i+'.dat',bytes(i));
  const outcomes=await Promise.allSettled([a.save('/new-a.dat',bytes(3)),b.save('/new-b.dat',bytes(4))]);
  let files,loadError;try{files=await a.load();}catch(e){loadError=e.message;}
  const report={backupRestored,writerExclusive,concurrentOutcomes:outcomes.map(r=>r.status),profileCount:files?.length,loadError:loadError||null,locksAvailable:!!navigator.locks};
  a.close();b.close();return report;
 });
 await writeFile(out+'/'+name+'-profile-'+(baseline?'before':'after')+'.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({browser:name,...report}));
 if(!baseline){assert.equal(report.backupRestored,1);assert.equal(report.writerExclusive,true);assert.deepEqual(report.concurrentOutcomes.sort(),['fulfilled','rejected']);assert.equal(report.profileCount,64);assert.equal(report.loadError,null);}
 }finally{await context.close();await browser.close();}
}
