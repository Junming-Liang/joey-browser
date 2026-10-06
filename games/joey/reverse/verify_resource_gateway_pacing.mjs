// Reproduce the observed public8r/s ingress while retaining exact source spans.
import assert from 'node:assert/strict';
import {createRangeReader} from './range-reader.mjs';
const bytes=Uint8Array.from({length:50*4096},(_,i)=>i%251),sha256='a'.repeat(64);
const manifest=[{path:'/data.dat',url:'data.dat',length:bytes.length,sha256}];
const layouts={'/data.dat':{length:bytes.length,sha256,entries:Array.from({length:50},(_,i)=>[i*4096,4096,0])}};
const plan={'/data.dat':{sha256,assetStarts:layouts['/data.dat'].entries.map(e=>e[0])}};
const requests=[],blocks=new Map();let tokens=40,last=performance.now(),rejected=0;
const response=options=>{const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range),start=Number(a),end=Number(b);return new Response(bytes.slice(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});};
const cache={read:async(file,start,end)=>blocks.get(`${start}:${end}`)||null,save:async(file,start,end,value)=>blocks.set(`${start}:${end}`,value.slice())};
const reader=createRangeReader(manifest,{layouts,cache,fetcher:async(url,options)=>{
  const now=performance.now();tokens=Math.min(40,tokens+(now-last)*.008);last=now;requests.push(now);
  if(tokens<1){rejected++;return new Response('Too Many Requests',{status:429});}tokens--;
  return response(options);
}});
const progress=[];await reader.preload(plan,p=>progress.push(p));
assert.equal(requests.length,50);assert.equal(rejected,0);assert.equal(reader.stats.rateLimitRetries,0);
for(const began of requests)assert.ok(requests.filter(time=>time>=began&&time<began+1000).length<=8,'Cold preparation admission rate');
assert.equal(progress.at(-1).completed,progress.at(-1).total);
assert.deepEqual(await reader.read('/data.dat',36865,7000),bytes.slice(36865,43865));reader.close();
const warm=createRangeReader(manifest,{layouts,cache,fetcher:()=>{throw Error('Unexpected warm request');}});
const began=performance.now();await warm.preload(plan,()=>{});assert.equal(warm.stats.requests,0);assert.ok(performance.now()-began<500,'Cache hits must not wait for cold pacing');warm.close();
let attempts=0;
const retry=createRangeReader(manifest,{layouts,fetcher:async(url,options)=>++attempts<3?new Response('limited',{status:429,headers:{'Retry-After':'0'}}):response(options)});
assert.deepEqual(await retry.read('/data.dat',100,4096),bytes.slice(100,4196));assert.equal(attempts,3);assert.equal(retry.stats.rateLimitRetries,2);retry.close();
const unavailable=createRangeReader(manifest,{layouts,fetcher:async()=>new Response('limited',{status:429,headers:{'Retry-After':'0'}})});
const pending=unavailable.read('/data.dat',0,1);setTimeout(()=>unavailable.close(),30);await assert.rejects(pending);assert.equal(unavailable.stats.activeRequests,0);
console.log(JSON.stringify({coldRequests:requests.length,simulated8rPerSecondRejections:rejected,warmRequests:0,byteExact:true,retryAttempts:attempts,cancelDuringRetry:true}));
