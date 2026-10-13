import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {brotliCompressSync,gzipSync} from 'node:zlib';
import {filterOriginalBytes} from '../games/joey/reverse/resource-byte-filter.mjs';
import {filterStructuredBytes} from '../games/joey/reverse/structured-byte-filter.mjs';
import {decodeOriginalBlock,restoreOriginalArchives} from '../games/joey/reverse/setup-deployment.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sources=[Uint8Array.from({length:128},(_,i)=>i*7),Uint8Array.from({length:128},(_,i)=>i*3),Uint8Array.of(1)];
const kinds=['bmp-paeth-green','pcm-mono-first-plane','none'],paths=['/data.dat','/Voice.dat','/Region.dat'];
let offset=0;const payloads=[],blocks=[];
for(let i=0;i<sources.length;i++){
 const raw=sources[i],spans=i===0?[[0,raw.length,16,12,3,0]]:[],kind=kinds[i];
 const filtered=i===2?filterOriginalBytes(raw,kind):filterStructuredBytes(raw,kind,spans);
 const codec=i===1?'gzip':'brotli',packed=(codec==='gzip'?gzipSync:brotliCompressSync)(filtered);
 const block={path:paths[i],start:0,length:raw.length,sha256:hash(raw),packedStart:offset,packedLength:packed.length,packedSHA256:hash(packed),kind,spans,codec};
 assert.deepEqual([...decodeOriginalBlock(packed,block)],[...raw]);
 const corrupt=Buffer.from(packed);corrupt[0]^=1;assert.throws(()=>decodeOriginalBlock(corrupt,block),/checksum/);
 assert.throws(()=>decodeOriginalBlock(packed,{...block,sha256:hash(Uint8Array.of(99))}),/checksum/);
 assert.throws(()=>decodeOriginalBlock(packed,{...block,length:raw.length-1}));
 const extra=Buffer.concat([packed,Buffer.of(0)]);assert.throws(()=>decodeOriginalBlock(extra,{...block,packedLength:extra.length,packedSHA256:hash(extra)}));
 payloads.push(packed);blocks.push(block);offset+=packed.length;
}
const payload=Buffer.concat(payloads),manifest={format:'joey-lossless-pack-v2',pack:{length:payload.length,sha256:hash(payload)},archives:sources.map((b,i)=>({path:paths[i],length:b.length,sha256:hash(b)})),blocks};
const root=await mkdtemp(join(tmpdir(),'joey-deployment-check-'));
try{
 const pack=join(root,'pack'),output=join(root,'resources');await writeFile(pack,payload);await mkdir(output);
 await restoreOriginalArchives(manifest,pack,output);
 for(let i=0;i<paths.length;i++)assert.equal(hash(await readFile(join(output,paths[i].slice(1)))),hash(sources[i]));
 await assert.rejects(()=>restoreOriginalArchives(manifest,pack,output),/EEXIST/);
 for(let i=0;i<paths.length;i++)assert.equal(hash(await readFile(join(output,paths[i].slice(1)))),hash(sources[i]));
 const other=join(root,'corrupt');await mkdir(other);const damaged=Buffer.from(payload);damaged[0]^=1;await writeFile(pack,damaged);
 await assert.rejects(()=>restoreOriginalArchives(manifest,pack,other),/checksum/);
 console.log('Local deployment: lossless BMP/PCM restore, block/archive hashes, malformed data and existing-file preservation passed');
}finally{await rm(root,{recursive:true,force:true});}
