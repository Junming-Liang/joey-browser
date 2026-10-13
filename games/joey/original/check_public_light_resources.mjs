// Public HTTPS integer decoding of real card/audio bytes in both engines.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,open,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const out=resolve('.bridge/joey-web/reverse/output/compression-20261013'),root=resolve(out,'../original-preview');
const revision=JSON.parse(await readFile(root+'/revision.json')),manifest=JSON.parse(await readFile(root+'/resources.manifest.json'));
const url=process.argv[2]||(process.env.JOEY_PUBLIC_URL||'http://127.0.0.1:18891/joey/original/');
const reads=[],hash=b=>createHash('sha256').update(b).digest('hex');
for(const path of ['/data.dat','/Voice.dat']){
 const b=manifest.blocks.find(b=>b.path===path&&b.sha256!==b.sourceSHA256),offset=b.start+63,length=4096;
 for(const [quality,source]of [['light',out+'/light-resources'],['original',resolve('.bridge/joey-web/reverse/input')]]){
  const file=await open(source+path),bytes=Buffer.alloc(length);await file.read(bytes,0,length,offset);await file.close();reads.push({quality,path,offset,length,sha256:hash(bytes)});
 }
}
const reports=[];
for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true}),context=await browser.newContext({viewport:{width:402,height:714},isMobile:true,hasTouch:true}),page=await context.newPage();
 try{
  await page.goto(url);await page.waitForFunction(()=>!document.getElementById('start').disabled);
  const result=await page.evaluate(async({version,reads})=>{
   const session=await(await fetch('./api/session')).json();if(session.version!==version||!isSecureContext||!crossOriginIsolated)throw Error('Wrong public version/isolation');
   const {createPackedResourceReader}=await import('./packed-resource-reader.mjs'),hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
   const restored=[];
   for(const quality of ['light','original']){
    const descriptor=quality==='light'?session.packedResources:session.originalPackedResources,response=await fetch(descriptor.manifestURL),bytes=new Uint8Array(await response.arrayBuffer());
    if(await hash(bytes)!==descriptor.manifestSHA256)throw Error('Public index checksum');
    const manifest=JSON.parse(new TextDecoder().decode(bytes)),reader=createPackedResourceReader(manifest,{originalManifest:session.resources});
    try{for(const r of reads.filter(r=>r.quality===quality))if(await hash(await reader.read(r.path,r.offset,r.length))!==r.sha256)throw Error('Public '+quality+' bytes changed');
     if(reader.stats.resourceVariant!==quality)throw Error('Public fidelity mismatch');restored.push({quality,checkedCardAndAudio:true,stats:reader.stats});
    }finally{reader.close();}
   }
   return {version:session.version,secure:true,isolated:true,publicAccess:session.access,restored};
  },{version:revision.version,reads});
  assert.equal(result.publicAccess,'public');reports.push({browser:name,scope:'Real public HTTPS sample card+audio ranges for light and original packs; actual Worker/WASM, hashes and CSP. Desktop mobile viewport, not physical phone/full duel.',...result});console.log(JSON.stringify(reports.at(-1)));
 }finally{await context.close();await browser.close();}
}
await writeFile(out+'/light-public-decoder.json',JSON.stringify(reports,null,2)+'\n');
