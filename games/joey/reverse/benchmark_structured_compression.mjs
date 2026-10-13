// Same complete pinned archives and1MiB grid as previous experiments.
import assert from 'node:assert/strict';
import {open,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import * as zlib from 'node:zlib';
import {filterOriginalBytes} from './resource-byte-filter.mjs';
import {filterStructuredBytes} from './structured-byte-filter.mjs';
const out='.bridge/joey-web/reverse/output/resource-compression';
const baseline=JSON.parse(await readFile(out+'/lossless-codecs.json')),previous=JSON.parse(await readFile(out+'/audio-byte-planes.json')),geometry=JSON.parse(await readFile(out+'/bitmap-geometry.json'));
const gzip=promisify(zlib.gzip),brotli=promisify(zlib.brotliCompress);
const codecs=[{name:'gzip6',encode:b=>gzip(b,{level:6}),decode:zlib.gunzipSync},{name:'brotli6',encode:b=>brotli(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:6}}),decode:zlib.brotliDecompressSync}];
const sha=b=>createHash('sha256').update(b).digest('hex'),archives=[],began=performance.now();
const build=process.argv.includes('--build-pack'),packDigest=createHash('sha256'),blocks=[];
let packPosition=0;
if(build)await mkdir(out+'/structured-pack',{recursive:true});
const target=build?await open(out+'/structured-pack/resources.gzip.pack','w'):null;
for(const file of baseline.archives){
 if(file.name==='data.dat'){assert.equal(geometry.originalSHA256,file.originalSHA256);assert.equal(geometry.originalBytes,file.originalBytes);}
 const source=await open('.bridge/joey-web/reverse/input/'+file.name,'r'),digest=createHash('sha256');
 const totals=Object.fromEntries(codecs.map(c=>[c.name,{encodedBytes:0,previousBytes:0,selectedKinds:{},maxInverseMs:0}]));
 try{
  for(let start=0;start<file.originalBytes;start+=baseline.pageBytes){
   const bytes=Buffer.alloc(Math.min(baseline.pageBytes,file.originalBytes-start));assert.equal((await source.read(bytes,0,bytes.length,start)).bytesRead,bytes.length);digest.update(bytes);
   const spans=file.name==='data.dat'?geometry.images.filter(([s,n])=>s<start+bytes.length&&s+n>start).map(([s,n,stride,rowBytes,bpp])=>[Math.max(s,start)-start,Math.min(s+n,start+bytes.length)-start,stride,rowBytes,bpp,(Math.max(s,start)-s)%stride]):[];
   const priorKinds=file.name==='data.dat'?['none','delta-rgb']:file.name==='Voice.dat'?['none','delta-pcm16','delta-pcm16-plane']:['none'];
   const newKinds=file.name==='data.dat'?['bmp-up','bmp-paeth','bmp-paeth-green']:file.name==='Voice.dat'?['pcm-mono-first-plane','pcm-stereo-second-plane','pcm-mono-second-plane']:[];
   const candidates=[...priorKinds,...newKinds].map(kind=>({kind,bytes:priorKinds.includes(kind)?filterOriginalBytes(bytes,kind):filterStructuredBytes(bytes,kind,spans)}));
   for(const c of candidates)assert.deepEqual(Buffer.from(priorKinds.includes(c.kind)?filterOriginalBytes(c.bytes,c.kind,true):filterStructuredBytes(c.bytes,c.kind,spans,true)),bytes);
   await Promise.all(codecs.map(async codec=>{
    const packed=await Promise.all(candidates.map(async c=>({...c,packed:await codec.encode(c.bytes)}))),selected=packed.reduce((a,b)=>a.packed.length<=b.packed.length?a:b);
    const decoded=codec.decode(selected.packed),before=performance.now(),restored=priorKinds.includes(selected.kind)?filterOriginalBytes(decoded,selected.kind,true):filterStructuredBytes(decoded,selected.kind,spans,true),inverseMs=performance.now()-before;
    assert.deepEqual(Buffer.from(restored),bytes);const t=totals[codec.name];t.encodedBytes+=selected.packed.length;t.previousBytes+=Math.min(...packed.filter(c=>priorKinds.includes(c.kind)).map(c=>c.packed.length));t.selectedKinds[selected.kind]=(t.selectedKinds[selected.kind]||0)+1;t.maxInverseMs=Math.max(t.maxInverseMs,inverseMs);
    if(target&&codec.name==='gzip6'){
     assert.equal((await target.write(selected.packed,0,selected.packed.length,packPosition)).bytesWritten,selected.packed.length);
     blocks.push({path:'/'+file.name,start,length:bytes.length,sha256:sha(bytes),packedStart:packPosition,packedLength:selected.packed.length,packedSHA256:sha(selected.packed),kind:selected.kind,spans:priorKinds.includes(selected.kind)?[]:spans});
     packDigest.update(selected.packed);packPosition+=selected.packed.length;
    }
    if(start===Math.floor(file.originalBytes/2/baseline.pageBytes)*baseline.pageBytes){
     await writeFile(out+'/'+file.name+'-structured-'+codec.name+'.bin',selected.packed);
     await writeFile(out+'/'+file.name+'-structured-'+codec.name+'.json',JSON.stringify({kind:selected.kind,spans:priorKinds.includes(selected.kind)?[]:spans,originalLength:bytes.length,originalSHA256:sha(bytes)}));
    }
   }));
   if(start&&start%(64*baseline.pageBytes)===0)console.log(JSON.stringify({file:file.name,completed:start+bytes.length,elapsedMs:Math.round(performance.now()-began)}));
  }
  assert.equal(digest.digest('hex'),file.originalSHA256);archives.push({name:file.name,originalSHA256:file.originalSHA256,codecs:totals});console.log(JSON.stringify({file:file.name,totals}));
 }finally{await source.close();}
}
const totals=Object.fromEntries(codecs.map(c=>[c.name,archives.reduce((sum,a)=>sum+a.codecs[c.name].encodedBytes,0)]));
for(const codec of codecs)assert.equal(archives.reduce((sum,a)=>sum+a.codecs[codec.name].previousBytes,0),previous.completeResourcePayloads[codec.name]);
for(let length=0;length<=129;length++)for(const kind of ['pcm-mono-first-plane','pcm-stereo-second-plane','pcm-mono-second-plane']){const bytes=Uint8Array.from({length},(_,i)=>(i*179+length*37)&255);assert.deepEqual(filterStructuredBytes(filterStructuredBytes(bytes,kind),kind,[],true),bytes);}
for(let stride=3;stride<=40;stride++)for(let rowOffset=0;rowOffset<stride;rowOffset++)for(const kind of ['bmp-up','bmp-paeth','bmp-paeth-green']){const bytes=Uint8Array.from({length:129},(_,i)=>(i*179+stride*37)&255),spans=[[2,123,stride,Math.floor(stride/3)*3,3,rowOffset]];assert.deepEqual(filterStructuredBytes(filterStructuredBytes(bytes,kind,spans),kind,spans,true),bytes);}
const report={version:baseline.version,scope:'Same complete original archives and same1MiB grid. Every original byte retained. Sizes exclude geometry/manifest and HTTP/program/browser storage overhead; desktop timing only. No production changes.',originalBytes:baseline.originalBytes,pageBytes:baseline.pageBytes,byteExact:true,boundaryChecks:true,archives,totals,elapsedMs:Math.round(performance.now()-began)};
if(target){
 await target.close();assert.equal(packPosition,totals.gzip6);
 await writeFile(out+'/structured-pack/manifest.json',JSON.stringify({format:'joey-lossless-gzip-pack-v1',version:baseline.version,pageBytes:baseline.pageBytes,pack:{path:'/__joey_packed_resources_v1',url:'/pack',length:packPosition,sha256:packDigest.digest('hex')},archives:baseline.archives.map(f=>({path:'/'+f.name,length:f.originalBytes,sha256:f.originalSHA256})),blocks})+'\n');
}
await writeFile(out+'/structured-codecs.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({totals,elapsedMs:report.elapsedMs}));
