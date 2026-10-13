// Actual immutable-byte trace replay and simultaneous-reader eviction checks.
import assert from 'node:assert/strict';
import {open,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {setImmediate as tick} from 'node:timers/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorkerReadCache} from './worker-read-cache.mjs';
const synthetic=[{path:'/data.dat',length:16*1048576,sha256:'a'.repeat(64)}];
const pattern=offset=>(offset*17+Math.floor(offset/65536)*29)&255;
if(!isMainThread){
  const cache=createWorkerReadCache(synthetic,workerData.buffer);
  let hits=0;
  for(let n=0;n<5000;n++){
    const offset=(n*73537+workerData.id*16381)%(synthetic[0].length-70000),destination=new Uint8Array(70000).fill(0xad);
    const read=cache.readInto('/data.dat',offset,70000,destination);
    if(read===null){assert.ok(destination.every(byte=>byte===0xad));}
    else{assert.equal(read,70000);for(let i=0;i<read;i++)assert.equal(destination[i],pattern(offset+i));hits++;}
  }
  parentPort.postMessage({hits});
}else{
  const output=resolve('.bridge/joey-web/reverse/output'),root=resolve(output,'original-worker-read-cache-rejected-20261005-161901-a5bb2e09');
  const {createRangeReader}=await import(pathToFileURL(resolve(root,'range-reader.mjs')));
  const revision=JSON.parse(await readFile(resolve(root,'revision.json'),'utf8'));
  const {archiveLayouts:layouts}=await import(pathToFileURL(resolve(root,'resource-layout.mjs')));
  const tracePath=resolve(output,'original-preview-check-20261005-065713-85f093aa-audio-recovery-resource-trace/original-preview-webkit.json');
  const traceBytes=await readFile(tracePath),trace=JSON.parse(traceBytes);
  const manifest=revision.resources.map(file=>({...file,path:'/'+file.name,url:file.name})),files=new Map(manifest.map(file=>[file.path,file])),handles=new Map();
  const shared=createWorkerReadCache(manifest);
  const source=async(path,offset,length)=>{const bytes=new Uint8Array(Math.min(length,Math.max(0,files.get(path).length-offset)));if(bytes.length)assert.equal((await handles.get(path).read(bytes,0,bytes.length,offset)).bytesRead,bytes.length);return bytes;};
  const fetcher=async(url,options)=>{const path='/'+url,file=files.get(path),match=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);assert.ok(file&&match);const start=Number(match[1]),end=Number(match[2]);return new Response(await source(path,start,end-start+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${file.length}`}});};
  const reader=createRangeReader(manifest,{fetcher,layouts,onReadChunk:(path,start,bytes)=>shared.put(path,start,bytes)});
  let reads=0,misses=0,returnedBytes=0;
  const digest=createHash('sha256');
  try{
    for(const file of manifest)handles.set(file.path,await open(resolve('.bridge/joey-web/reverse/input',file.name),'r'));
    for(const read of [...trace.report.resourceReads,{path:'/Voice.dat',offset:files.get('/Voice.dat').length-3,requested:8},{path:'/Region.dat',offset:3,requested:8}]){
      const expected=await source(read.path,read.offset,read.requested),guarded=new Uint8Array(read.requested+16).fill(0xab),destination=guarded.subarray(8,-8);
      let count=shared.readInto(read.path,read.offset,read.requested,destination);
      if(count===null){assert.ok(destination.every(byte=>byte===0xab));const bytes=await reader.read(read.path,read.offset,read.requested);destination.set(bytes);count=bytes.length;misses++;}
      assert.equal(count,expected.length);assert.deepEqual(destination.subarray(0,count),expected);assert.ok(guarded.subarray(0,8).every(byte=>byte===0xab)&&guarded.subarray(-8).every(byte=>byte===0xab));
      digest.update(destination.subarray(0,count));reads++;returnedBytes+=count;
    }
    assert.ok(shared.stats().hits>100,'Observed original trace must exercise direct Worker reads');
    const unchanged=new Uint8Array(16).fill(0xcd);assert.equal(shared.readInto('/deck.ydc',0,16,unchanged),null);assert.ok(unchanged.every(byte=>byte===0xcd));
  }finally{reader.close();for(const file of handles.values())await file.close();}
  // Stress multiple readers while the producer overwrites and evicts slots.
  const concurrent=createWorkerReadCache(synthetic),seed=new Uint8Array(4*1048576);for(let i=0;i<seed.length;i++)seed[i]=pattern(i);concurrent.put('/data.dat',0,seed);
  const tasks=[0,1,2].map(id=>new Promise((done,fail)=>{const worker=new Worker(new URL(import.meta.url),{workerData:{id,buffer:concurrent.buffer}});worker.once('message',done);worker.once('error',fail);worker.once('exit',code=>{if(code)fail(Error('Concurrent cache check failed: '+code));});}));
  for(let n=0;n<256;n++){
    const start=(n*65536)%synthetic[0].length,bytes=new Uint8Array(65536);for(let i=0;i<bytes.length;i++)bytes[i]=pattern(start+i);concurrent.put('/data.dat',start,bytes);await tick();
  }
  const readers=await Promise.all(tasks);assert.ok(readers.some(reader=>reader.hits>0));
  const report={sourceVersion:trace.version,sourceTraceSHA256:createHash('sha256').update(traceBytes).digest('hex'),candidateVersion:revision.version,candidateWasmSHA256:revision.wasmSHA256,
    cacheModuleSHA256:createHash('sha256').update(await readFile(new URL('./worker-read-cache.mjs',import.meta.url))).digest('hex'),rangeReaderSHA256:createHash('sha256').update(await readFile(resolve(root,'range-reader.mjs'))).digest('hex'),
    reads,misses,returnedBytes,returnedBytesSHA256:digest.digest('hex'),workerCache:shared.stats(),concurrentReaders:readers,
    scope:'820 recorded real original reads plus2 EOF boundaries; every returned byte compared with the pinned original archives; misses preserve destination; three simultaneous readers with producer eviction; replay has no browser/network timing meaning'};
  await writeFile(resolve(output,'original-worker-read-cache-verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
