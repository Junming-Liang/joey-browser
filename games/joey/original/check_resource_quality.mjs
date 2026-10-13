// Cache identity and fidelity selection contracts; task-owned databases only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createOriginalServer} from './server.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const out=resolve('.bridge/joey-web/reverse/output/compression-20261013'),root=resolve(out,'../original-preview');
const revision=JSON.parse(await readFile(root+'/revision.json')),real=JSON.parse(await readFile(root+'/resources.manifest.json'));
const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:out+'/light-pack',origin:'http://127.0.0.1'};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin='http://127.0.0.1:'+server.address().port;
const hash=b=>createHash('sha256').update(b).digest('hex'),source=[7,8,9],files=source.map((v,i)=>({path:['/data.dat','/Voice.dat','/Region.dat'][i],length:1,sha256:hash(Buffer.from([v])),url:'/quality-raw/'+i}));
function variant(name,format,values,level){
 const parts=values.map(v=>gzipSync(Buffer.from([v]),{level})),payload=Buffer.concat(parts);let offset=0;
 const manifest={format,pageBytes:1048576,decoder:real.decoder,archives:files.map(({url,...f},i)=>format==='joey-light-pack-v3'?{...f,derivedSHA256:hash(Buffer.from([values[i]]))}:f),pack:{path:'/__joey_packed_resources_v1',url:'/quality-pack/'+name,length:payload.length,sha256:hash(payload)},blocks:parts.map((p,i)=>{const b={path:files[i].path,start:0,length:1,sha256:hash(Buffer.from([values[i]])),packedStart:offset,packedLength:p.length,packedSHA256:hash(p),kind:'none',spans:[]};offset+=p.length;if(format!=='joey-lossless-gzip-pack-v1')b.codec='gzip';if(format==='joey-light-pack-v3')b.sourceSHA256=files[i].sha256;return b;})};
 const body=Buffer.from(JSON.stringify(manifest));return {manifest,payload:[...payload],body:[...body],descriptor:{manifestURL:'/quality-index/'+name,manifestSHA256:hash(body),pack:manifest.pack}};
}
const variants={light:variant('light','joey-light-pack-v3',[6,8,9],9),original:variant('original','joey-lossless-pack-v2',source,6),legacy:variant('legacy','joey-lossless-gzip-pack-v1',source,0)},reports=[];
try{
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
  const context=await browser.newContext(),page=await context.newPage();
  try{
   await page.goto(config.origin+'/joey/original/');await page.waitForFunction(()=>!document.getElementById('start').disabled);
   assert.equal(await page.locator('#resource-quality-option').isVisible(),false);await page.locator('#complete-resources').check();assert.equal(await page.locator('#complete-quality').inputValue(),'light');assert((await page.locator('#complete-label').textContent()).includes('180 MB'));
   await page.locator('#complete-quality').selectOption('original');assert((await page.locator('#complete-label').textContent()).includes('228 MB'));assert((await page.locator('#complete-quality-note').textContent()).includes('无损'));
   const result=await page.evaluate(async({variants,files})=>{
    const {createOriginalResourceCache}=await import('./resource-cache.mjs'),{createOriginalResourceReader}=await import('./resource-reader.mjs'),{createPackedResourceReader}=await import('./packed-resource-reader.mjs');
    const reports=[];
    for(const kind of ['light-complete-choose-original','light-and-v1-partial-choose-original','original-complete-choose-light','corrupt-light-fallback-original']){
     const cache=createOriginalResourceCache({}, {databaseName:'joey-own-quality-'+kind}),requests=[];
     const fetcher=async(url,options={})=>{
      requests.push({url,range:options.headers?.Range});const v=Object.values(variants).find(v=>[v.descriptor.manifestURL,v.descriptor.pack.url].includes(url));
      if(v&&url===v.descriptor.manifestURL)return new Response(Uint8Array.from(v.body));
      const m=/^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range||''),start=+m?.[1],end=+m?.[2],file=files.find(f=>f.url===url);
      const payload=file?Uint8Array.from([files.indexOf(file)+7]):Uint8Array.from(v.payload);
      if(!m)throw Error('Quality test missing range');return new Response(payload.slice(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${payload.length}`}});
     };
     const seed=async v=>{await cache.save(v.descriptor.pack,0,v.payload.length-1,Uint8Array.from(v.payload));await cache.markComplete(v.descriptor.pack,v.descriptor.manifestSHA256);};
     const choose=original=>createOriginalResourceReader(files,{cache,fetcher,packedResources:variants[original?'original':'light'].descriptor,legacyPackedResources:original?[variants.legacy.descriptor]:[variants.original.descriptor,variants.legacy.descriptor]});
     let reader,progress;
     try{
      if(kind==='light-complete-choose-original'){
       await seed(variants.light);reader=choose(true);await reader.preload(null,v=>progress=v);
       if((await reader.read('/data.dat',0,1))[0]!==7||reader.stats.resourceVariant!=='original'||!requests.some(r=>r.url===variants.original.descriptor.pack.url)||requests.some(r=>r.url.includes('/light')))throw Error('Light cache masqueraded as original');
      }else if(kind==='light-and-v1-partial-choose-original'){
       for(const v of [variants.light,variants.legacy])await cache.savePartial(v.descriptor.pack,0,v.payload.length-1,Uint8Array.from(v.payload.slice(0,11)));
       reader=choose(true);await reader.preload(null,v=>progress=v);
       if((await reader.read('/data.dat',0,1))[0]!==7||!requests.some(r=>r.url===variants.legacy.descriptor.pack.url&&r.range===`bytes=11-${variants.legacy.payload.length-1}`)||requests.some(r=>r.url.includes('/light')))throw Error('Original choice continued light partial');
      }else if(kind==='original-complete-choose-light'){
       await seed(variants.original);reader=choose(false);await reader.preload({},v=>progress=v);
       if(progress.source!=='installed-legacy-pack'||(await reader.read('/data.dat',0,1))[0]!==7||reader.stats.resourceVariant!=='original'||requests.some(r=>r.url!==variants.original.descriptor.manifestURL))throw Error('Original full cache not reused');
      }else{
       await seed(variants.light);reader=choose(false);await reader.preload({},v=>progress=v);
       const bad=Uint8Array.from(variants.light.payload);bad[0]^=1;await cache.save(variants.light.descriptor.pack,0,bad.length-1,bad);
       if((await reader.read('/data.dat',0,1))[0]!==7||reader.stats.resourceMode!=='on-demand'||requests.some(r=>r.url===variants.light.descriptor.pack.url)||!requests.some(r=>r.url===files[0].url))throw Error('Bad light cache did not fall back to small original bytes');
      }
      reports.push({kind,passed:true,requests});
     }finally{reader?.close();await cache.close();}
    }
    // Derived metadata is mandatory and never changes the original identity.
    for(const field of ['derivedSHA256','sourceSHA256']){
     const value=structuredClone(variants.light.manifest);delete (field==='derivedSHA256'?value.archives[0]:value.blocks[0])[field];let rejected=false;
     try{createPackedResourceReader(value,{originalManifest:files});}catch{rejected=true;}if(!rejected)throw Error('Incomplete derived identity accepted');
    }
    return {reports,derivedIdentityRequired:true};
   },{variants,files});
   reports.push({browser:name,version:revision.version,...result});console.log(JSON.stringify(reports.at(-1)));
  }finally{await context.close();await browser.close();}
 }
 await writeFile(out+'/light-quality-contracts.json',JSON.stringify(reports,null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
