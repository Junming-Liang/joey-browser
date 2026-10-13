// Investigate fully reversible predictors on the same complete pinned corpus.
// Not a shipping format; no browser/game/server behavior is changed here.
import assert from 'node:assert/strict';
import {open,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import * as zlib from 'node:zlib';
import {filterOriginalBytes} from './resource-byte-filter.mjs';
const out=resolve('.bridge/joey-web/reverse/output/resource-compression'),baseline=JSON.parse(await readFile(out+'/lossless-codecs.json'));
const gz=promisify(zlib.gzip),br=promisify(zlib.brotliCompress);
const codecs=[{name:'gzip6',encode:b=>gz(b,{level:6}),decode:zlib.gunzipSync},{name:'brotli6',encode:b=>br(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:6}}),decode:zlib.brotliDecompressSync}];
const began=performance.now(),archives=[];
for(const file of baseline.archives){
 const f=await open(resolve('.bridge/joey-web/reverse/input',file.name),'r'),kind=file.name==='data.dat'?'delta-rgb':file.name==='Voice.dat'?'delta-pcm16':'none';
 try{
  const digest=createHash('sha256'),totals=Object.fromEntries(codecs.map(c=>[c.name,{encodedBytes:0,rawCodecBytes:0,pagesFiltered:0,filterMs:0,inverseMs:0,pages:0}]));
  for(let start=0;start<file.originalBytes;start+=baseline.pageBytes){
   const bytes=Buffer.alloc(Math.min(baseline.pageBytes,file.originalBytes-start));assert.equal((await f.read(bytes,0,bytes.length,start)).bytesRead,bytes.length);digest.update(bytes);
   const filterStart=performance.now(),filtered=filterOriginalBytes(bytes,kind),filterMs=performance.now()-filterStart;
   assert.deepEqual(Buffer.from(filterOriginalBytes(filtered,kind,true)),bytes);
   await Promise.all(codecs.map(async codec=>{
    const [plain,candidate]=await Promise.all([codec.encode(bytes),codec.encode(filtered)]),useFilter=candidate.length<plain.length,packed=useFilter?candidate:plain;
    const decoded=codec.decode(packed),inverseStart=performance.now(),restored=filterOriginalBytes(decoded,useFilter?kind:'none',true),inverseMs=performance.now()-inverseStart;
    assert.deepEqual(Buffer.from(restored),bytes);
    const total=totals[codec.name];total.encodedBytes+=packed.length;total.rawCodecBytes+=plain.length;total.pagesFiltered+=Number(useFilter);total.filterMs+=filterMs;total.inverseMs+=inverseMs;total.pages++;
    if(start===Math.floor(file.originalBytes/2/baseline.pageBytes)*baseline.pageBytes){
     await writeFile(out+'/'+file.name+'-filtered-'+codec.name+'.bin',packed);
     await writeFile(out+'/'+file.name+'-filtered-'+codec.name+'.json',JSON.stringify({kind:useFilter?kind:'none',originalLength:bytes.length,originalSHA256:createHash('sha256').update(bytes).digest('hex')}));
    }
   }));
   if(start&&start%(128*baseline.pageBytes)===0)console.log(JSON.stringify({file:file.name,completed:start+bytes.length,total:file.originalBytes}));
  }
  assert.equal(digest.digest('hex'),file.originalSHA256);
  for(const codec of codecs)assert.equal(totals[codec.name].rawCodecBytes,file.codecs[codec.name].encodedBytes);
  archives.push({name:file.name,originalSHA256:file.originalSHA256,kind,codecs:totals});console.log(JSON.stringify({file:file.name,totals}));
 }finally{await f.close();}
}
// Predictor boundary/odd-length checks, including byte wrap and signed PCM.
for(let length=0;length<=129;length++)for(const kind of ['delta-rgb','delta-pcm16']){
 const bytes=Uint8Array.from({length},(_,i)=>(i*179+length*37)&255);assert.deepEqual(filterOriginalBytes(filterOriginalBytes(bytes,kind),kind,true),bytes);
}
const totals=Object.fromEntries(codecs.map(c=>[c.name,archives.reduce((sum,f)=>sum+f.codecs[c.name].encodedBytes,0)]));
const report={version:baseline.version,scope:'Complete same pinned original archives and same1MiB block grid. Per-block choice between plain codec and reversible byte predictor. Payload only, excluding manifest and HTTP overhead; not production installation or phone performance.',pageBytes:baseline.pageBytes,originalBytes:baseline.originalBytes,byteExact:true,boundaryChecks:true,archives,totals,elapsedMs:Math.round(performance.now()-began)};
await writeFile(out+'/filtered-codecs.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({totals,elapsedMs:report.elapsedMs}));
