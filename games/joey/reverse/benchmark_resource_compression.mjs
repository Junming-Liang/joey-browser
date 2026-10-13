// Same pinned originals and same1MiB independently decodable pages for every
// lossless codec. Sizes are payload/model measurements, not public-network totals.
import assert from 'node:assert/strict';
import {open,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import * as zlib from 'node:zlib';
const output=resolve('.bridge/joey-web/reverse/output/resource-compression');await mkdir(output,{recursive:true});
const revision=JSON.parse(await readFile(resolve(output,'../original-preview/revision.json')));
const pageBytes=1048576;
const gz=promisify(zlib.gzip),br=promisify(zlib.brotliCompress),zs=promisify(zlib.zstdCompress);
const codecs=[
 {name:'gzip1',encode:b=>gz(b,{level:1}),decode:zlib.gunzipSync},
 {name:'gzip6',encode:b=>gz(b,{level:6}),decode:zlib.gunzipSync},
 {name:'gzip9',encode:b=>gz(b,{level:9}),decode:zlib.gunzipSync},
 {name:'brotli4',encode:b=>br(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:4}}),decode:zlib.brotliDecompressSync},
 {name:'brotli6',encode:b=>br(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:6}}),decode:zlib.brotliDecompressSync},
 {name:'zstd6',encode:b=>zs(b,{params:{[zlib.constants.ZSTD_c_compressionLevel]:6}}),decode:zlib.zstdDecompressSync}
];
const began=performance.now(),archives=[];
for(const file of revision.resources){
 const source=await open(resolve('.bridge/joey-web/reverse/input',file.name),'r');
 try{
  assert.equal((await source.stat()).size,file.length);const digest=createHash('sha256'),totals=Object.fromEntries(codecs.map(c=>[c.name,{encodedBytes:0,encodeWallMs:0,decodeMs:0,maxPageDecodeMs:0,pages:0}]));
  for(let start=0;start<file.length;start+=pageBytes){
   const bytes=Buffer.alloc(Math.min(pageBytes,file.length-start));assert.equal((await source.read(bytes,0,bytes.length,start)).bytesRead,bytes.length);digest.update(bytes);
   await Promise.all(codecs.map(async codec=>{
    const before=performance.now(),packed=await codec.encode(bytes),encodeMs=performance.now()-before;
    const decodeStart=performance.now(),decoded=codec.decode(packed),decodeMs=performance.now()-decodeStart;
    assert.deepEqual(decoded,bytes);const total=totals[codec.name];total.encodedBytes+=packed.length;total.encodeWallMs+=encodeMs;total.decodeMs+=decodeMs;total.maxPageDecodeMs=Math.max(total.maxPageDecodeMs,decodeMs);total.pages++;
    // Keep real representative pages for browser-native decoding measurements.
    if(start===Math.floor(file.length/2/pageBytes)*pageBytes){await writeFile(resolve(output,file.name+'-'+codec.name+'.bin'),packed);}
   }));
   if(start&&start%(64*pageBytes)===0)console.log(JSON.stringify({file:file.name,completed:start+bytes.length,total:file.length,elapsedMs:Math.round(performance.now()-began)}));
  }
  assert.equal(digest.digest('hex'),file.sha256);archives.push({name:file.name,originalBytes:file.length,originalSHA256:file.sha256,codecs:totals});
  console.log(JSON.stringify({file:file.name,complete:true,codecs:Object.fromEntries(Object.entries(totals).map(([name,total])=>[name,total.encodedBytes]))}));
 }finally{await source.close();}
}
const totals=Object.fromEntries(codecs.map(c=>[c.name,{encodedBytes:archives.reduce((sum,a)=>sum+a.codecs[c.name].encodedBytes,0),pages:archives.reduce((sum,a)=>sum+a.codecs[c.name].pages,0),decodeMs:archives.reduce((sum,a)=>sum+a.codecs[c.name].decodeMs,0)}]));
const report={version:revision.version,scope:'All three pinned original DAT archives, independently compressed1MiB pages, including every original byte. Node-local payload sizes and byte-exact decompression, no HTTP/TLS overhead, no actual-phone throughput/CPU inference.',node:process.version,zlib:process.versions.zlib,brotli:process.versions.brotli,zstd:process.versions.zstd,pageBytes,originalBytes:revision.completePreloadBytes,byteExact:true,archives,totals,elapsedMs:Math.round(performance.now()-began)};
await writeFile(resolve(output,'lossless-codecs.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:resolve(output,'lossless-codecs.json'),originalBytes:report.originalBytes,totals,elapsedMs:report.elapsedMs}));
