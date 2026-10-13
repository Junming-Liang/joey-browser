// Offline only: preserve every original block, predictor and archive byte.
import assert from 'node:assert/strict';
import {open,readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {brotliCompress,brotliDecompressSync,gzip,gunzipSync,constants} from 'node:zlib';
import {filterOriginalBytes} from './resource-byte-filter.mjs';
import {filterStructuredBytes} from './structured-byte-filter.mjs';

const baselineRoot=resolve('.bridge/joey-web/reverse/output/resource-compression/structured-pack');
const light=process.argv.includes('--light');
const out=resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--'))||'.bridge/joey-web/reverse/output/compression-20261013/'+(light?'light-pack':'brotli-pack'));
const variantRoot=resolve('.bridge/joey-web/reverse/output/compression-20261013/light-resources');
const provenance=light?JSON.parse(await readFile(variantRoot+'/provenance.json')):null;
await mkdir(out,{recursive:true});
const original=JSON.parse(await readFile(baselineRoot+'/manifest.json','utf8'));
assert.equal(original.pack.sha256,'42d626a804979565e5dabe976975c8f5db88b0c4314b9811e44ba4eec2091f49');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),encode=promisify(brotliCompress),gzipEncode=promisify(gzip);
const simple=new Set(['none','delta-rgb','delta-pcm16','delta-pcm16-plane']);
const filter=(bytes,block,inverse=false)=>simple.has(block.kind)?filterOriginalBytes(bytes,block.kind,inverse):filterStructuredBytes(bytes,block.kind,block.spans,inverse);
const oldPack=await open(baselineRoot+'/resources.gzip.pack','r');
const sources=new Map();
for(const file of original.archives){
 const path=resolve(light?variantRoot:'.bridge/joey-web/reverse/input',file.path.slice(1));
 if(light){const expected=provenance.archives.find(f=>f.path===file.path);assert.equal(expected.sha256,file.sha256);assert.equal(expected.length,file.length);assert.equal(sha(await readFile(path)),expected.derivedSHA256);}
 sources.set(file.path,await open(path,'r'));
}
const results=[],began=performance.now();let next=0,finished=0;
async function build(){
 for(;;){
  const index=next++;if(index>=original.blocks.length)return;
  const sourceBlock=original.blocks[index],raw=Buffer.alloc(sourceBlock.length),oldGzip=Buffer.alloc(sourceBlock.packedLength);
  const block={...sourceBlock};
  assert.equal((await sources.get(block.path).read(raw,0,raw.length,block.start)).bytesRead,raw.length);
  if(light){block.sourceSHA256=block.sha256;block.sha256=sha(raw);}else assert.equal(sha(raw),block.sha256);
  assert.equal((await oldPack.read(oldGzip,0,oldGzip.length,block.packedStart)).bytesRead,oldGzip.length);
  assert.equal(sha(oldGzip),block.packedSHA256);
  assert.equal(sha(filter(gunzipSync(oldGzip),block,true)),sourceBlock.sha256);
  const residual=filter(raw,block);
  const gzip=light&&block.sha256!==sourceBlock.sha256?await gzipEncode(residual,{level:6}):oldGzip;
  assert.deepEqual(Buffer.from(filter(gunzipSync(gzip),block,true)),raw);
  const options=quality=>({params:{[constants.BROTLI_PARAM_QUALITY]:quality,[constants.BROTLI_PARAM_LGWIN]:20,[constants.BROTLI_PARAM_SIZE_HINT]:raw.length}});
  const [q6,q11]=await Promise.all([encode(residual,options(6)),encode(residual,options(11))]);
  for(const bytes of [q6,q11])assert.deepEqual(Buffer.from(filter(brotliDecompressSync(bytes),block,true)),raw);
  const candidates=[{codec:'gzip',quality:6,bytes:gzip},{codec:'brotli',quality:6,bytes:q6},{codec:'brotli',quality:11,bytes:q11}];
  const selected=candidates.reduce((a,b)=>a.bytes.length<=b.bytes.length?a:b);
  results[index]={block,selected,sizes:candidates.map(c=>({codec:c.codec,quality:c.quality,bytes:c.bytes.length}))};
  finished++;if(finished%16===0||finished===original.blocks.length)console.log(JSON.stringify({completed:finished,total:original.blocks.length,elapsedMs:Math.round(performance.now()-began)}));
 }
}
try{
 // Two independent encoders keep offline memory and CPU predictable.
 await Promise.all([build(),build()]);
 const target=await open(out+'/resources.gzip.pack.tmp','wx'),digest=createHash('sha256'),blocks=[];let position=0;
 try{
  for(const {block,selected}of results){
   const bytes=selected.bytes;assert.equal((await target.write(bytes,0,bytes.length,position)).bytesWritten,bytes.length);digest.update(bytes);
   blocks.push({...block,codec:selected.codec,packedStart:position,packedLength:bytes.length,packedSHA256:sha(bytes)});position+=bytes.length;
  }
 }finally{await target.close();}
 await rename(out+'/resources.gzip.pack.tmp',out+'/resources.gzip.pack');
 const decoder=JSON.parse(await readFile(new URL('./brotli-decoder-provenance.json',import.meta.url)));
 const manifest={...original,format:light?'joey-light-pack-v3':'joey-lossless-pack-v2',decoder:{url:'/joey/original/brotli-decoder.wasm',length:decoder.wasmBytes,sha256:decoder.files['brotli-decoder.wasm'],memoryLimitBytes:decoder.linearMemoryLimitBytes},pack:{...original.pack,length:position,sha256:digest.digest('hex')},blocks};
 if(light){manifest.archives=provenance.archives.map(({path,length,sha256,derivedSHA256})=>({path,length,sha256,derivedSHA256}));manifest.qualityProfile=provenance.profile;}
 await writeFile(out+'/manifest.json',JSON.stringify(manifest)+'\n');
 const report={scope:light?'Light variant; source archives pinned, 458-block1MiB grid unchanged, derived bytes exact. UI, directories, headers, padding, alpha, fonts untouched. Payload excludes decoder/index/program; not phone timing.':'Same original archive hashes, original458-block1MiB grid and predictors; byte exact original payload excluding decoder/index/program; not phone timing.',baselinePackSHA256:original.pack.sha256,baselineBytes:original.pack.length,packedBytes:position,packSHA256:manifest.pack.sha256,originalBytes:original.archives.reduce((sum,f)=>sum+f.length,0),byteExactTo:light?'derived-resources':'original-resources',blocks:results.map(({block,selected,sizes})=>({path:block.path,start:block.start,originalBytes:block.length,kind:block.kind,codec:selected.codec,quality:selected.quality,encodedBytes:selected.bytes.length,candidates:sizes})),node:process.version,brotli:process.versions.brotli,windowBits:20,elapsedMs:Math.round(performance.now()-began)};
 await writeFile(out+'/build-report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({packedBytes:position,packSHA256:manifest.pack.sha256,elapsedMs:report.elapsedMs}));
}finally{await oldPack.close();await Promise.all([...sources.values()].map(file=>file.close()));}
