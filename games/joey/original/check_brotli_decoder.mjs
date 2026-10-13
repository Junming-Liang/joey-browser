// Real packaged Worker/decoder in isolated desktop Chromium and WebKit.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,open,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const root=resolve('.bridge/joey-web/reverse/output/original-preview'),out=resolve('.bridge/joey-web/reverse/output/compression-20261013');
const manifest=JSON.parse(await readFile(root+'/resources.manifest.json'));
const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));
const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:out+'/light-pack',origin:'http://127.0.0.1'};
const gateway=await createOriginalServer(config),waiting=new Set();let stall=false;
const server=createServer((req,res)=>{
 if(stall&&req.url==='/joey/original/brotli-decoder.wasm'){waiting.add(res);res.on('close',()=>waiting.delete(res));return;}
 gateway.emit('request',req,res);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin='http://127.0.0.1:'+server.address().port;
const sha=b=>createHash('sha256').update(b).digest('hex'),reports=[];
const block=manifest.blocks.find(b=>b.codec==='brotli'&&b.length===1048576),source=await open(config.packedResourcesRoot+'/resources.gzip.pack');
const packed=Buffer.alloc(block.packedLength);await source.read(packed,0,packed.length,block.packedStart);await source.close();
const raw=brotliDecompressSync(packed),rawSHA=sha(raw);
const reads=[];
for(const file of manifest.archives){
 const source=await open(out+'/light-resources'+file.path);
 try{for(const [offset,length]of [[0,17],[Math.min(file.length,1048576-23),97],[Math.max(0,file.length-33),65536],[file.length,5],[file.length+1,4096],...(file.path==='/data.dat'?[[0,8388609]]:[])]){
  const bytes=Buffer.alloc(Math.min(length,Math.max(0,file.length-offset)));await source.read(bytes,0,bytes.length,offset);reads.push({path:file.path,offset,length,size:bytes.length,sha256:sha(bytes)});
 }}finally{await source.close();}
}
try{
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
  const context=await browser.newContext(),page=await context.newPage();
  try{
   await page.goto(config.origin+'/joey/original/');
   const readContract=await page.evaluate(async ({manifest,reads})=>{
    const {createPackedResourceReader}=await import('./packed-resource-reader.mjs'),reader=createPackedResourceReader(manifest,{originalManifest:manifest.archives});
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    try{for(const r of reads){const bytes=await reader.read(r.path,r.offset,r.length);if(bytes.length!==r.size||await hash(bytes)!==r.sha256)throw Error('Packed original-offset read changed');}
     for(const args of [['/unknown',0,1],['/data.dat',-1,1],['/data.dat',0,-1],['/data.dat',0,Number.MAX_SAFE_INTEGER+1]]){let rejected=false;try{await reader.read(...args);}catch{rejected=true;}if(!rejected)throw Error('Invalid original read accepted');}
     return {byteExactReads:reads.length,crossBlockAndLargeRead:true,pastEOFReturnsEmpty:true,decodedMemoryBytes:reader.stats.decodedMemoryBytes,maxDecoderMemoryBytes:reader.stats.maxDecoderMemoryBytes};
    }finally{reader.close();}
   },{manifest,reads});
   assert(readContract.decodedMemoryBytes<=2097152);
   const contracts=await page.evaluate(async ({descriptor,packed,rawSHA,length})=>{
    const {createBrotliBlockDecoder}=await import('./brotli-block-decoder.mjs');
    const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
    const bytes=Uint8Array.from(packed),stats={},reader=createBrotliBlockDecoder(descriptor,stats);
    const original=bytes.slice(),began=performance.now();let beats=0;const heartbeat=setInterval(()=>beats++,1);
    try{
     const restored=await reader.decode(bytes,length);
     if(await hash(restored)!==rawSHA||bytes.some((v,i)=>v!==original[i]))throw Error('Integer decode changed bytes or detached cache');
     const decoderErrors=[];
     for(const [label,input,expected]of [['tail',new Uint8Array([...bytes,0]),length],['truncated',bytes.subarray(0,bytes.length-1),length],['short-output',bytes,length-1],['long-output',bytes,length+1],['invalid',Uint8Array.from([255,255,255,255]),length]]){
      let error;try{await reader.decode(input,expected);}catch(e){error=String(e);}
      if(!error)throw Error('Invalid '+label+' accepted');decoderErrors.push({label,error});
      if(await hash(await reader.decode(bytes,length))!==rawSHA)throw Error('Failed Worker reused after '+label);
     }
     const pending=reader.decode(bytes,length);reader.close();let cancelled=false;try{await pending;}catch{cancelled=true;}if(!cancelled)throw Error('Pending decode not rejected on close');
     const {default:init}=await import('./brotli-decoder.mjs');
     const wasm=await init({module_or_path:await(await fetch(descriptor.url)).arrayBuffer()}),pages=wasm.memory.buffer.byteLength/65536;
     wasm.memory.grow(512-pages);let capped=false;try{wasm.memory.grow(1);}catch(e){capped=e instanceof RangeError;}if(!capped)throw Error('WASM memory not hard capped');
     return {byteExact:true,cacheInputPreserved:true,decoderErrors,workerRecreatedAfterError:true,closeRejectsPending:true,linearMemoryCapBytes:33554432,stats,mainThreadHeartbeats:beats,elapsedMs:performance.now()-began};
    }finally{clearInterval(heartbeat);reader.close();}
   },{descriptor:manifest.decoder,packed:[...packed],rawSHA,length:block.length});
   assert(contracts.mainThreadHeartbeats>0);assert(contracts.stats.maxDecoderMemoryBytes<=33554432);
   // Actual fetch remains pending until the parent deadline terminates Worker.
   stall=true;
   const deadline=await page.evaluate(async ({descriptor,packed,length})=>{
    const {createBrotliBlockDecoder}=await import('./brotli-block-decoder.mjs'),reader=createBrotliBlockDecoder(descriptor,{});const started=performance.now();let error;
    try{await reader.decode(Uint8Array.from(packed),length);}catch(e){error=String(e);}finally{reader.close();}
    return {elapsedMs:performance.now()-started,error};
   },{descriptor:manifest.decoder,packed:[...packed],length:block.length});
   stall=false;assert(deadline.error.includes('timed out'));assert(deadline.elapsedMs<15000);
   await page.waitForTimeout(100);assert.equal(waiting.size,0,'Terminated Worker must cancel pending decoder download');
   const migration=await page.evaluate(async descriptor=>{
    const {createOriginalResourceReader}=await import('./resource-reader.mjs'),{createOriginalResourceCache}=await import('./resource-cache.mjs');
    const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
    const originals=[],blocks=[],parts=[];let offset=0;
    for(const [i,path]of ['/data.dat','/Voice.dat','/Region.dat'].entries()){
     const bytes=Uint8Array.from([7+i]),gzip=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
     const file={path,length:1,sha256:await hash(bytes),url:'/test-raw'+path};originals.push(file);parts.push(gzip);
     blocks.push({path,start:0,length:1,sha256:file.sha256,packedStart:offset,packedLength:gzip.length,packedSHA256:await hash(gzip),kind:'none',spans:[]});offset+=gzip.length;
    }
    const pack=new Uint8Array(offset);let position=0;for(const part of parts){pack.set(part,position);position+=part.length;}
    const previous={format:'joey-lossless-gzip-pack-v1',pageBytes:1048576,archives:originals.map(({url,...file})=>file),blocks,pack:{path:'/__joey_packed_resources_v1',url:'/test-old-pack',length:pack.length,sha256:await hash(pack)}};
    const current={...previous,format:'joey-lossless-pack-v2',decoder:descriptor,blocks:blocks.map(b=>({...b,codec:'gzip'})),pack:{...previous.pack,url:'/test-new-pack',sha256:'a'.repeat(64)}};
    const oldBody=new TextEncoder().encode(JSON.stringify(previous)),newBody=new TextEncoder().encode(JSON.stringify(current));
    const old={manifestURL:'/test-old-index',manifestSHA256:await hash(oldBody),pack:previous.pack},now={manifestURL:'/test-new-index',manifestSHA256:await hash(newBody),pack:current.pack};
    const requests=[],cache=createOriginalResourceCache({}, {databaseName:'joey-v2-legacy-contract'});
    const fetcher=async (url,options={})=>{
     requests.push({url,range:options.headers?.Range});if(url===old.manifestURL)return new Response(oldBody);if(url===now.manifestURL)return new Response(newBody);
     if(url!==old.pack.url)throw Error('Migration fetched new pack/raw bytes');const m=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range),start=+m[1],end=+m[2];return new Response(pack.slice(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${pack.length}`}});
    };
    const make=()=>createOriginalResourceReader(originals,{cache,packedResources:now,legacyPackedResources:[old],fetcher});
    await cache.savePartial(old.pack,0,pack.length-1,pack.slice(0,11));
    // Keep an original cache record: completing a pack must not actively purge it.
    await cache.save(originals[0],0,0,Uint8Array.from([7]));
    let reader=make();await reader.preload(null,()=>{});reader.close();
    if(!requests.some(r=>r.url===old.pack.url&&r.range===`bytes=11-${pack.length-1}`)||requests.some(r=>r.url.startsWith('/test-new')))throw Error('Legacy partial did not continue exact offset');
    if(!await cache.hasComplete([old.pack],old.manifestSHA256)||await cache.hasComplete([now.pack],now.manifestSHA256))throw Error('Wrong completion marker');
    if((await cache.read(originals[0],0,0))?.[0]!==7)throw Error('Raw bytes actively purged');
    const count=requests.length;let progress;reader=make();await reader.preload({},value=>progress=value);
    if(progress.source!=='installed-legacy-pack'||(await reader.read('/Voice.dat',0,1))[0]!==8||requests.slice(count).some(r=>r.url!==old.manifestURL))throw Error('Legacy complete not reused offline');reader.close();await cache.close();
    return {legacyPartialResumedOffset:11,legacyCompleteReused:true,noNewPackRequests:true,rawCacheRecordRetained:true};
   },manifest.decoder);
   const report={browser:name,scope:'Packaged Worker and actual 1MiB Brotli block; original-offset reads, malformed input, hard memory limit, timeout/cancel, synthetic legacy completion/partial migration. Desktop engines, not phone timings.',version:JSON.parse(await readFile(root+'/revision.json')).version,readContract,contracts,deadline,migration};reports.push(report);console.log(JSON.stringify(report));
  }finally{stall=false;for(const res of waiting)res.destroy();await context.close();await browser.close();}
 }
 await mkdir(out,{recursive:true});await writeFile(out+'/decoder-contracts.json',JSON.stringify(reports,null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
