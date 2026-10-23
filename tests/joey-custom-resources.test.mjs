import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {gzipSync} from 'node:zlib';
globalThis.crypto??=webcrypto;
const source=await readFile(new URL('../games/joey/original/custom-resources.mjs',import.meta.url),'utf8');
const {createCustomResourceReader}=await import('data:text/javascript;base64,'+Buffer.from(source.replace("'./range-reader.mjs'",JSON.stringify(new URL('../games/joey/reverse/range-reader.mjs',import.meta.url).href))).toString('base64'));
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const raw=Buffer.from('abcde'),blob=Buffer.from('HEADTAIL!'),packed=gzipSync(blob),sourceFile={path:'/data.dat',length:raw.length,sha256:hash(raw)};
 const descriptor={format:'joey-custom-dat-v1',rulesVersion:'joey-five-collectible-cards-v2',path:'/data.dat',sourceLength:5,sourceSHA256:sourceFile.sha256,length:14,
  blob:{url:'custom-resources.bin',length:9,sha256:hash(blob)},compressed:{path:'/__joey_custom_resources_v1',url:'custom-resource-bytes',length:packed.length,sha256:hash(packed)},spans:[[0,4,'overlay',0],[4,5,'original',0],[9,5,'overlay',4]]};
 const saved=new Map();let requests=0,reads=[],progress=[];
 const key=(f,a,b)=>f.sha256+':'+a+':'+b;
 const cache={read:async(f,a,b)=>saved.get(key(f,a,b))||null,save:async(f,a,b,v)=>{saved.set(key(f,a,b),v.slice());return true;},discard:async()=>saved.clear()};
 const original=()=>({stats:{},read:async(p,a,n)=>{reads.push([p,a,n]);return raw.subarray(a,a+n);},close(){},preload:async()=>true});
 const fetcher=async(url,options)=>{requests++;const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);return new Response(packed.subarray(+a,+b+1),{status:206,headers:{'Content-Range':`bytes ${a}-${b}/${packed.length}`}});};
 const make=()=>createCustomResourceReader(original(),{manifest:[sourceFile],descriptor,baseURL:'https://example.test/joey/custom-preview/',cache,fetcher,onProgress:p=>progress.push(p)});
 return {make,descriptor,sourceFile,requests:()=>requests,reads,progress,saved};
}
test('virtual DAT cross-boundary reads reuse original offsets, cached compressed overlay and unchanged source manifest',async()=>{
 const f=fixture(),reader=f.make();await reader.prepare();
 assert.equal(Buffer.from(await reader.read('/data.dat',0,99)).toString(),'HEADabcdeTAIL!');
 assert.deepEqual(f.reads,[['/data.dat',0,5]]);assert.equal(f.sourceFile.length,5);assert.equal(reader.manifest[0].length,14);
 assert.equal(Buffer.from(await reader.read('/data.dat',2,10)).toString(),'ADabcdeTAI');
 const requests=f.requests();assert.equal(requests,1);reader.close();
 const reopened=f.make();await reopened.prepare();assert.equal(f.requests(),requests);assert.ok(f.progress.some(p=>p.restoredBytes>0));reopened.close();
});
test('EOF is empty, invalid spans fail before network, closed reads reject',async()=>{
 const f=fixture(),reader=f.make();assert.equal((await reader.read('/data.dat',100,1e9)).length,0);assert.equal(f.requests(),0);
 await assert.rejects(reader.read('/data.dat',-1,2));reader.close();await assert.rejects(reader.read('/data.dat',0,1));
 f.descriptor.spans[1][0]++;assert.throws(f.make,/范围/);assert.equal(f.requests(),0);
});
test('incorrect content identity cannot reach original program',async()=>{
 const f=fixture();f.descriptor.blob.sha256='0'.repeat(64);const reader=f.make();await assert.rejects(reader.prepare(),/校验/);assert.deepEqual(f.reads,[]);reader.close();
});
