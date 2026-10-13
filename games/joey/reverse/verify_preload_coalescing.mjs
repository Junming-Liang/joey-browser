// Same pinned original bytes and deterministic, controlled transport on both readers.
// Virtual time drives the real 150ms admission and retry timers; it is not phone timing.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync,readSync,closeSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const output=resolve('.bridge/joey-web/reverse/output/audit-20261013/preload');
mkdirSync(output,{recursive:true});
const hash=value=>createHash('sha256').update(value).digest('hex');
const baselineSource=readFileSync(resolve(output,'baseline-range-reader.mjs'),'utf8');
const candidateSource=readFileSync(new URL('./range-reader.mjs',import.meta.url),'utf8');
const planSource=readFileSync('games/joey/original/preload-assets.json');
assert.equal(hash(planSource),'8f474dbe6c3c98d25f12e482cd2dbcb6deb18a243a9e96dd31dd377f6c09dd1b');
const planDocument=JSON.parse(planSource),plan=planDocument.archives;
const layoutPath=resolve('.bridge/joey-web/reverse/output/original-preview/resource-layout.mjs');
const {archiveLayouts:layouts}=await import(pathToFileURL(layoutPath));
const manifest=Object.entries(layouts).map(([path,layout])=>({path,url:path,length:layout.length,sha256:layout.sha256}));
const key=(file,start,end)=>file.path+':'+start+':'+end;
const spansFor=(files,directories,preload)=>Object.entries(preload).flatMap(([path,assets])=>{
  const file=files.find(file=>file.path===path);
  return [...assets.assetStarts.map(start=>({file,start,end:Math.min(file.length,start+directories[path].entries.find(entry=>entry[0]===start)[1]+4095)-1})),...(assets.streamSpans||[]).map(([start,end])=>({file,start,end}))];
});
const originalSpans=spansFor(manifest,layouts,plan);
assert.equal(originalSpans.length,335);assert.equal(originalSpans.reduce((sum,s)=>sum+s.end-s.start+1,0),50040206);
function clock(){
  let now=0,next=0;const timers=new Map();
  const set=(callback,ms=0)=>{const id=++next;timers.set(id,{at:now+Math.max(0,ms),callback});return id;};
  return {performance:{now:()=>now},setTimeout:set,clearTimeout:id=>timers.delete(id),wait:ms=>new Promise(done=>set(done,ms)),now:()=>now,
    async run(task){
      let settled=false,result,error;Promise.resolve(task).then(value=>{settled=true;result=value;},reason=>{settled=true;error=reason;});
      for(let turns=0;!settled;turns++){
        assert.ok(turns<100000,'Virtual transport must finish');
        await new Promise(setImmediate);if(settled)break;
        const first=[...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
        assert.ok(first,'Unsettled operation without any transport or reader timer');
        timers.delete(first[0]);now=first[1].at;first[1].callback();
      }
      if(error)throw error;return result;
    }};
}
function factory(source,time){
  return new Function('performance','setTimeout','clearTimeout',source.replace('export function createRangeReader','function createRangeReader')+'\nreturn createRangeReader;')(time.performance,time.setTimeout,time.clearTimeout);
}
function memoryCache(){
  const blocks=new Map(),partials=new Map();let available=true,discarded=0;
  return {blocks,partials,get discarded(){return discarded;},disable(){available=false;},ready:async()=>available,
    read:async(file,start,end,parent)=>available?(blocks.get(key(file,start,end))||(parent&&blocks.get(key(file,parent.start,parent.end))?.slice(start-parent.start,end-parent.start+1))||null):null,
    readPartial:async(file,start,end)=>available?partials.get(key(file,start,end))||null:null,
    savePartial:async(file,start,end,bytes)=>{if(!available)return false;partials.set(key(file,start,end),bytes.slice());return true;},
    save:async(file,start,end,bytes)=>{if(!available)return false;blocks.set(key(file,start,end),bytes.slice());partials.delete(key(file,start,end));return true;},
    discardPartial:async(file,start,end)=>{if(!available)return false;discarded++;partials.delete(key(file,start,end));return true;}};
}
function transport(time,files,source,{rttMs=150,bytesPerSecond=2000000,chunkBytes=65536,compressed=false,mutate}={}){
  const requests=[];let active=0,maxActive=0;
  const fetcher=async(url,options)=>{
    const parsed=compressed?new URL(url,'https://fixture.invalid'):null;
    const file=files.find(file=>file.path===(parsed?parsed.pathname:url));assert.ok(file);
    const match=parsed?[null,parsed.searchParams.get('start'),parsed.searchParams.get('end')]:/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);assert.ok(match);
    const start=Number(match[1]),end=Number(match[2]);assert.ok(start>=0&&start<=end&&end<file.length);
    const record={path:file.path,start,end,atMs:time.now(),received:0};requests.push(record);active++;maxActive=Math.max(maxActive,active);
    let finished=false;const finish=()=>{if(!finished){finished=true;active--;}};
    await time.wait(rttMs);let position=start;
    const body=new ReadableStream({async pull(controller){
      if(options.signal.aborted){finish();controller.error(options.signal.reason);return;}
      if(position>end){finish();controller.close();return;}
      const count=Math.min(chunkBytes,end-position+1);await time.wait(count*1000/bytesPerSecond);
      if(options.signal.aborted){finish();controller.error(options.signal.reason);return;}
      const bytes=source(file.path,position,count);position+=count;record.received+=count;controller.enqueue(bytes);
    },cancel:finish},{highWaterMark:0});
    const response=new Response(body,{status:compressed?200:206,headers:{[compressed?'X-Original-Range':'Content-Range']:`bytes ${start}-${end}/${file.length}`}});
    return mutate?mutate(response,{file,start,end,options,record}):response;
  };
  return {fetcher,requests,get maxActive(){return maxActive;}};
}
const uniqueBytes=requests=>{
  let sum=0;for(const path of new Set(requests.map(r=>r.path))){let end=-1;for(const r of requests.filter(r=>r.path===path).sort((a,b)=>a.start-b.start)){sum+=Math.max(0,r.start+r.received-Math.max(r.start,end+1));end=Math.max(end,r.start+r.received-1);}}return sum;
};
function checkSpans(cache,spans,source){
  const digest=createHash('sha256');for(const span of spans){const bytes=cache.blocks.get(key(span.file,span.start,span.end));assert.ok(bytes,'Missing original cache key '+key(span.file,span.start,span.end));assert.deepEqual(bytes,source(span.file.path,span.start,span.end-span.start+1));digest.update(bytes);}return digest.digest('hex');
}
async function replay(readerSource,mode,{files=manifest,directories=layouts,preload=plan,source,compressed=false}={}){
  const spans=spansFor(files,directories,preload),time=clock(),cache=memoryCache();
  const seeded=mode==='warm'?spans:mode==='mixed'?spans.filter((_,index)=>index%3===1):[];
  for(const span of seeded)await cache.save(span.file,span.start,span.end,source(span.file.path,span.start,span.end-span.start+1));
  const network=transport(time,files,source,{compressed}),progress=[];
  const reader=factory(readerSource,time)(files.map(file=>({...file,...compressed?{compressedURL:file.url}:{}})),{layouts:directories,cache,fetcher:network.fetcher});
  assert.equal(await time.run(reader.preload(preload,value=>{progress.push(value);assert.ok(reader.stats.cacheBytes<=4194304);assert.ok(reader.stats.activeRequests<=4);})),true);
  assert.equal(progress.at(-1).completed,spans.reduce((sum,s)=>sum+s.end-s.start+1,0));
  assert.equal(progress.at(-1).restoredBytes,seeded.reduce((sum,s)=>sum+s.end-s.start+1,0));
  assert.ok(progress.every((p,i)=>p.completed<=p.total&&(!i||p.completed>=progress[i-1].completed)));
  assert.ok(network.maxActive<=4);assert.ok(reader.stats.cacheBytes<=4194304);
  for(const request of network.requests){assert.ok(!seeded.some(s=>s.file.path===request.path&&s.start===request.start&&s.end===request.end),'Old warm exact span must not redownload');assert.ok(network.requests.filter(r=>r.atMs>=request.atMs&&r.atMs<request.atMs+1000).length<=8,'Original cold pacing');}
  const report={mode,controlledElapsedMs:time.now(),sourceRequests:network.requests.length,sourceBytes:network.requests.reduce((sum,r)=>sum+r.received,0),uniqueSourceBytes:uniqueBytes(network.requests),maxConcurrentNetwork:network.maxActive,logicalBytes:progress.at(-1).completed,restoredLogicalBytes:progress.at(-1).restoredBytes,returnedOriginalSpansSHA256:checkSpans(cache,spans,source),remainingPartialKeys:cache.partials.size,readerStats:{...reader.stats},requests:network.requests};
  reader.close();return report;
}
function fixture(lengths=Array(12).fill(65536),selected){
  let length=0;const entries=lengths.map(size=>{const entry=[length,size,0];length+=size;return entry;});
  const data=Uint8Array.from({length},(_,i)=>(i*31+(i>>>9))%251),sha256=hash(data),file={path:'/data.dat',url:'/data.dat',length,sha256};
  return {files:[file],directories:{[file.path]:{length,sha256,entries}},preload:{[file.path]:{sha256,assetStarts:selected||entries.map(entry=>entry[0])}},source:(path,start,size)=>data.slice(start,start+size)};
}
async function regressions(){
  const f=fixture(),spans=spansFor(f.files,f.directories,f.preload),file=f.files[0],logical=received=>spans.reduce((sum,s)=>sum+Math.max(0,Math.min(s.end+1,received)-s.start),0);
  const make=({cache=memoryCache(),fixture:f2=f,mutate,compressed=false}={})=>{
    const time=clock(),network=transport(time,f2.files,f2.source,{mutate,compressed}),reader=factory(candidateSource,time)(f2.files.map(file=>({...file,...compressed?{compressedURL:file.url}:{}})),{layouts:f2.directories,cache,fetcher:network.fetcher});
    return {time,network,reader,cache};
  };
  for(const compressed of [false,true]){
    const candidate=await replay(candidateSource,'cold',{...f,compressed}),baseline=await replay(baselineSource,'cold',{...f,compressed});
    assert.equal(candidate.sourceRequests,1);assert.equal(candidate.sourceBytes,file.length);assert.equal(candidate.returnedOriginalSpansSHA256,baseline.returnedOriginalSpansSHA256);
  }
  // A warm middle member must not bridge two cold components through its body.
  const gaps=fixture([65536,65536,65536],[0,65536,131072]),gapSpans=spansFor(gaps.files,gaps.directories,gaps.preload),gapCache=memoryCache();
  await gapCache.save(gaps.files[0],gapSpans[1].start,gapSpans[1].end,gaps.source(file.path,gapSpans[1].start,gapSpans[1].end-gapSpans[1].start+1));
  const gapRun=make({fixture:gaps,cache:gapCache});await gapRun.time.run(gapRun.reader.preload(gaps.preload,()=>{}));assert.equal(gapRun.network.requests.length,2);assert.equal(gapRun.network.requests[0].end,gapSpans[0].end);assert.equal(gapRun.network.requests[1].start,gapSpans[2].start);gapRun.reader.close();
  // The largest asset keeps its old identity; new unions are bounded by 1MiB.
  const bounded=fixture([...Array(24).fill(65536),1200000,65536,65536]);
  const bounds=await replay(candidateSource,'cold',bounded);
  const oversized=spansFor(bounded.files,bounded.directories,bounded.preload).filter(s=>s.end-s.start+1>1048576);
  assert.ok(bounds.requests.every(r=>r.end-r.start+1<=1048576||oversized.some(s=>s.start===r.start&&s.end===r.end)));
  assert.equal(oversized.length,1);
  // Several nested tiny spans can have exactly the same union as one old key.
  const nested=fixture([1000,1000,1000,1000]),nestedRun=make({fixture:nested});
  await nestedRun.time.run(nestedRun.reader.preload(nested.preload,()=>{}));assert.equal(nestedRun.cache.blocks.size,4);assert.equal(nestedRun.cache.partials.size,0);checkSpans(nestedRun.cache,spansFor(nested.files,nested.directories,nested.preload),nested.source);nestedRun.reader.close();
  // Closing a live merged transfer preserves its exact resumable original prefix.
  const interrupted=make();let interruptedProgress;
  await assert.rejects(interrupted.time.run(interrupted.reader.preload(f.preload,p=>{interruptedProgress=p;if(p.completed>=logical(196608))interrupted.reader.close();})));
  assert.equal(interrupted.cache.partials.get(key(file,0,file.length-1)).length,196608);assert.equal(interrupted.reader.stats.activeRequests,0);
  const resumed=make({cache:interrupted.cache}),resumeProgress=[];
  await resumed.time.run(resumed.reader.preload(f.preload,p=>resumeProgress.push(p)));
  assert.equal(resumed.network.requests[0].start,196608);assert.equal(resumeProgress.at(-1).restoredBytes,logical(196608));assert.equal(resumeProgress.at(-1).completed,logical(file.length));assert.equal(resumed.cache.partials.size,0);checkSpans(resumed.cache,spans,f.source);resumed.reader.close();
  // Preserve partial keys written by older clients, even inside a mergeable run.
  const legacy=memoryCache(),old=spans[3],oldPrefix=16384;
  await legacy.savePartial(file,old.start,old.end,f.source(file.path,old.start,oldPrefix));
  const oldRun=make({cache:legacy}),oldProgress=[];await oldRun.time.run(oldRun.reader.preload(f.preload,p=>oldProgress.push(p)));
  assert.ok(oldRun.network.requests.some(r=>r.start===old.start+oldPrefix&&r.end===old.end));assert.equal(oldProgress.at(-1).restoredBytes,oldPrefix);checkSpans(legacy,spans,f.source);assert.equal(legacy.partials.size,0);oldRun.reader.close();
  // Decoder failure after the final byte must roll progress back to a checkpoint.
  let bodies=0;const rollback=make({mutate:response=>{
    if(bodies++)return response;const original=response.body.getReader();
    return new Response(new ReadableStream({async pull(controller){const {done,value}=await original.read();if(done)controller.error(Error('Controlled final decoder error'));else controller.enqueue(value);},cancel:()=>original.cancel()}),{status:response.status,headers:response.headers});
  }}),rollProgress=[];
  await rollback.time.run(rollback.reader.preload(f.preload,p=>rollProgress.push(p)));
  assert.equal(rollback.network.requests.length,2);assert.equal(rollback.network.requests[1].start,655360);assert.ok(rollProgress.some((p,i)=>i&&p.completed<rollProgress[i-1].completed));assert.equal(rollProgress.at(-1).completed,logical(file.length));assert.equal(rollback.reader.stats.networkRetries,1);checkSpans(rollback.cache,spans,f.source);rollback.reader.close();
  // False progress callbacks stop new jobs both before and during preparation.
  const denied=make();assert.equal(await denied.time.run(denied.reader.preload(f.preload,()=>false)),false);assert.equal(denied.network.requests.length,0);denied.reader.close();
  const cancelled=make();assert.equal(await cancelled.time.run(cancelled.reader.preload(f.preload,p=>p.completed===0)),false);assert.equal(cancelled.network.requests.length,1);cancelled.reader.close();
  const warmCancelCache=memoryCache();await warmCancelCache.save(file,spans[0].start,spans[0].end,f.source(file.path,spans[0].start,spans[0].end-spans[0].start+1));
  const warmCancel=make({cache:warmCancelCache});assert.equal(await warmCancel.time.run(warmCancel.reader.preload(f.preload,p=>p.completed===0)),false);assert.equal(warmCancel.network.requests.length,0);warmCancel.reader.close();
  const unavailable=memoryCache();unavailable.disable();const noCache=make({cache:unavailable});assert.equal(await noCache.time.run(noCache.reader.preload(f.preload,p=>p.completed===0)),false);assert.equal(noCache.cache.blocks.size,0);assert.equal(noCache.cache.discarded,0);assert.ok(noCache.reader.stats.cacheBytes<=4194304);noCache.reader.close();
  // Save failures and closure during the split may not discard a merged prefix.
  for(const failure of ['false','throw','close']){
    const run=make(),save=run.cache.save;let saves=0;
    run.cache.save=async(...args)=>{if(++saves===2){if(failure==='throw')throw Error('Controlled save failure');if(failure==='close')run.reader.close();else return false;}return save(...args);};
    const operation=run.time.run(run.reader.preload(f.preload,()=>{}));
    if(failure==='false')await operation;else await assert.rejects(operation);
    assert.ok(run.cache.partials.has(key(file,0,file.length-1)));assert.equal(run.cache.discarded,0);run.reader.close();
  }
  // Bad response metadata and body overflow must never populate an old full key.
  for(const compressed of [false,true])for(const invalid of ['range','oversized']){
    const run=make({compressed,mutate:response=>{response.body.cancel();return new Response(invalid==='oversized'?new Uint8Array(file.length+1):new Uint8Array(1),{status:response.status,headers:{[compressed?'X-Original-Range':'Content-Range']:invalid==='range'?'wrong':`bytes 0-${file.length-1}/${file.length}`}});}});
    await assert.rejects(run.time.run(run.reader.preload(f.preload,()=>{})),invalid==='range'?/Invalid resource range/:/Oversized resource range/);
    assert.equal(run.cache.blocks.size,0);assert.equal(run.reader.stats.activeRequests,0);run.reader.close();
  }
  // The full-program path retains its fixed 1MiB request/cache identities.
  const full=fixture(Array(40).fill(65536)),fullResults=[];
  for(const source of [baselineSource,candidateSource]){
    const time=clock(),cache=memoryCache(),network=transport(time,full.files,full.source),reader=factory(source,time)(full.files,{layouts:full.directories,cache,fetcher:network.fetcher}),progress=[];
    await time.run(reader.preload(null,p=>progress.push(p)));fullResults.push({ranges:network.requests.map(({start,end})=>({start,end})),progress,keys:[...cache.blocks.keys()]});reader.close();
  }
  assert.deepEqual(fullResults[0],fullResults[1]);
  // Foreground/on-demand reads keep the existing asset range and sharing policy.
  const liveResults=[];
  for(const source of [baselineSource,candidateSource]){
    const time=clock(),network=transport(time,f.files,f.source),reader=factory(source,time)(f.files,{layouts:f.directories,fetcher:network.fetcher});
    const [a,b]=await time.run(Promise.all([reader.read(file.path,17,4096),reader.read(file.path,17,4096)]));assert.deepEqual(a,f.source(file.path,17,4096));assert.deepEqual(a,b);
    liveResults.push(network.requests.map(({start,end,atMs})=>({start,end,atMs})));reader.close();
  }
  assert.deepEqual(liveResults[0],liveResults[1]);
  // Small live music responses, sequential read-ahead, and old 256KiB keys stay stable.
  const music=fixture([1048576,1048576]);music.directories[file.path].entries.forEach(entry=>entry[2]=1);
  music.preload[file.path].assetStarts=[];music.preload[file.path].streamSpans=[[0,266238],[262144,528382]];
  const musicResults=[];
  for(const source of [baselineSource,candidateSource]){
    const time=clock(),network=transport(time,music.files,music.source),reader=factory(source,time)(music.files,{layouts:music.directories,fetcher:network.fetcher});
    await time.run((async()=>{
      assert.deepEqual(await reader.read(file.path,0,44),music.source(file.path,0,44));
      assert.equal(network.requests.length,1);assert.equal(network.requests[0].end,4095);
      assert.deepEqual(await reader.read(file.path,44,40960),music.source(file.path,44,40960));
      while(reader.stats.activePrefetch)await time.wait(50);
    })());musicResults.push(network.requests.map(({start,end,atMs})=>({start,end,atMs})));reader.close();
  }
  assert.deepEqual(musicResults[0],musicResults[1]);
  assert.ok(musicResults[1].slice(1).every(r=>r.end-r.start+1===65536));
  const musicWarm=make({fixture:music});await musicWarm.time.run(musicWarm.reader.preload(music.preload,()=>{}));
  const musicSpans=spansFor(music.files,music.directories,music.preload);checkSpans(musicWarm.cache,musicSpans,music.source);assert.equal(musicWarm.network.requests.length,1);
  musicWarm.reader.close();const musicRestart=make({fixture:music,cache:musicWarm.cache});
  await musicRestart.time.run(musicRestart.reader.preload(music.preload,()=>{}));assert.equal(musicRestart.network.requests.length,0);
  assert.deepEqual(await musicRestart.time.run(musicRestart.reader.read(file.path,0,44)),music.source(file.path,0,44));
  assert.equal(musicRestart.reader.stats.diskCacheHits,2);assert.ok(musicRestart.reader.stats.memoryHits>0);musicRestart.reader.close();
  assert.ok(musicRestart.network.requests.length<=1,'Only background prefetch may extend beyond prepared music');
  return {compressedAndRangeByteExact:true,warmGapPreserved:true,mergedLimitBytes:1048576,oversizedOriginalAssetUnchanged:true,nestedOriginalKeyPreserved:true,interruptedMergedPrefixBytes:196608,resumedLogicalBytes:logical(196608),legacyPartialPrefixBytes:oldPrefix,finalDecoderRollbackChecked:true,progressCancellationChecked:true,cacheUnavailableChecked:true,splitFailuresRetainPartial:true,invalidAndOversizedResponsesRejected:true,fullArchivePathUnchanged:true,foregroundReadPathUnchanged:true,musicReadAheadCadenceUnchanged:true,oldMusicCacheKeysReused:true};
}
const handles=new Map();
try{
  for(const file of manifest){
    const path=resolve('.bridge/joey-web/reverse/input',file.path.slice(1)),digest=createHash('sha256');
    for await(const bytes of createReadStream(path))digest.update(bytes);
    assert.equal(digest.digest('hex'),file.sha256,'Pinned original '+file.path);handles.set(file.path,openSync(path,'r'));
  }
  const source=(path,start,length)=>{const bytes=new Uint8Array(length);assert.equal(readSync(handles.get(path),bytes,0,length,start),length);return bytes;};
  const baseline=[];for(const mode of ['cold','warm','mixed'])baseline.push(await replay(baselineSource,mode,{source}));
  const report={scope:'Same pinned 335-span common plan. Actual original DAT bytes; deterministic 150ms RTT, 2MB/s per active request, max four jobs, real reader admission timers. Response body bytes are original/decompressed bytes, not gzip wire bytes or measured phone/FPS/network timing.',planSHA256:hash(planSource),layoutSHA256:hash(readFileSync(layoutPath)),baselineReaderSHA256:hash(baselineSource),candidateReaderSHA256:hash(candidateSource),baseline};
  if(!process.argv.includes('--baseline')){
    const candidate=[];for(const mode of ['cold','warm','mixed'])candidate.push(await replay(candidateSource,mode,{source}));
    for(let i=0;i<baseline.length;i++){assert.equal(candidate[i].returnedOriginalSpansSHA256,baseline[i].returnedOriginalSpansSHA256);assert.equal(candidate[i].logicalBytes,baseline[i].logicalBytes);assert.equal(candidate[i].restoredLogicalBytes,baseline[i].restoredLogicalBytes);assert.equal(candidate[i].remainingPartialKeys,0);}
    assert.equal(candidate[0].sourceRequests,108);assert.equal(candidate[0].sourceBytes,49117108);assert.equal(candidate[1].sourceRequests,0);assert.ok(candidate[2].sourceRequests<baseline[2].sourceRequests);
    report.candidate=candidate;
    report.regressions=await regressions();
  }
  writeFileSync(resolve(output,process.argv.includes('--baseline')?'baseline.json':'verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({scope:report.scope,baseline:baseline.map(({mode,sourceRequests,sourceBytes,uniqueSourceBytes,controlledElapsedMs})=>({mode,sourceRequests,sourceBytes,uniqueSourceBytes,controlledElapsedMs})),candidate:report.candidate?.map(({mode,sourceRequests,sourceBytes,uniqueSourceBytes,controlledElapsedMs})=>({mode,sourceRequests,sourceBytes,uniqueSourceBytes,controlledElapsedMs}))}));
}finally{for(const handle of handles.values())closeSync(handle);}
