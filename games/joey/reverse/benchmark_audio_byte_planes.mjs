// Same full PCM archive/block grid; reversibly group16-bit high/low bytes.
import assert from 'node:assert/strict';
import {open,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import * as zlib from 'node:zlib';
import {filterOriginalBytes} from './resource-byte-filter.mjs';
const out=resolve('.bridge/joey-web/reverse/output/resource-compression'),baseline=JSON.parse(await readFile(out+'/lossless-codecs.json')),previous=JSON.parse(await readFile(out+'/filtered-codecs.json'));
const file=baseline.archives.find(f=>f.name==='Voice.dat'),prior=previous.archives.find(f=>f.name==='Voice.dat');
const gz=promisify(zlib.gzip),br=promisify(zlib.brotliCompress);
const codecs=[{name:'gzip6',encode:b=>gz(b,{level:6}),decode:zlib.gunzipSync},{name:'brotli6',encode:b=>br(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:6}}),decode:zlib.brotliDecompressSync}];
const totals=Object.fromEntries(codecs.map(c=>[c.name,{encodedBytes:0,priorFilteredBytes:0,shuffledPages:0}])),digest=createHash('sha256'),source=await open(resolve('.bridge/joey-web/reverse/input/Voice.dat'),'r'),started=performance.now();
try{
 for(let start=0;start<file.originalBytes;start+=baseline.pageBytes){
  const bytes=Buffer.alloc(Math.min(baseline.pageBytes,file.originalBytes-start));assert.equal((await source.read(bytes,0,bytes.length,start)).bytesRead,bytes.length);digest.update(bytes);
  const delta=filterOriginalBytes(bytes,'delta-pcm16'),shuffled=filterOriginalBytes(bytes,'delta-pcm16-plane');assert.deepEqual(Buffer.from(filterOriginalBytes(shuffled,'delta-pcm16-plane',true)),bytes);
  await Promise.all(codecs.map(async codec=>{
   const [plain,first,second]=await Promise.all([codec.encode(bytes),codec.encode(delta),codec.encode(shuffled)]);
   const prior=Math.min(plain.length,first.length),useShuffle=second.length<prior,packed=useShuffle?second:plain.length<first.length?plain:first,kind=useShuffle?'delta-pcm16-plane':plain.length<first.length?'none':'delta-pcm16';
   assert.deepEqual(Buffer.from(filterOriginalBytes(codec.decode(packed),kind,true)),bytes);
   const total=totals[codec.name];total.encodedBytes+=packed.length;total.priorFilteredBytes+=prior;total.shuffledPages+=Number(useShuffle);
   if(start===Math.floor(file.originalBytes/2/baseline.pageBytes)*baseline.pageBytes){
    await writeFile(out+'/Voice.dat-shuffled-'+codec.name+'.bin',packed);
    await writeFile(out+'/Voice.dat-shuffled-'+codec.name+'.json',JSON.stringify({kind,originalLength:bytes.length,originalSHA256:createHash('sha256').update(bytes).digest('hex')}));
   }
  }));
 }
 assert.equal(digest.digest('hex'),file.originalSHA256);
 for(const codec of codecs)assert.equal(totals[codec.name].priorFilteredBytes,prior.codecs[codec.name].encodedBytes);
}finally{await source.close();}
for(let length=0;length<=129;length++){const bytes=Uint8Array.from({length},(_,i)=>(i*179+length*37)&255);assert.deepEqual(filterOriginalBytes(filterOriginalBytes(bytes,'delta-pcm16-plane'),'delta-pcm16-plane',true),bytes);}
const completeResourcePayloads=Object.fromEntries(codecs.map(c=>[c.name,previous.totals[c.name]-prior.codecs[c.name].encodedBytes+totals[c.name].encodedBytes]));
const report={version:baseline.version,scope:'All139 pinned Voice.dat1MiB pages with optional16-bit byte-plane grouping after reversible predictor. Complete totals use previously verified graphic/Region blocks. Payload only, not a deployed installer or actual-phone measurement.',originalSHA256:file.originalSHA256,pageBytes:baseline.pageBytes,originalBytes:file.originalBytes,byteExact:true,boundaryChecks:true,totals,completeResourcePayloads,elapsedMs:Math.round(performance.now()-started)};
await writeFile(out+'/audio-byte-planes.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
