// Reproduce the user's exact original WAV read, then exercise stalled transport.
// Timing is a controlled model, not an estimate of physical-phone performance.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {createRangeReader} from './range-reader.mjs';
const output=resolve('.bridge/joey-web/reverse/output');
const baseline=output+'/music-stall-baseline-20261006-112036';
const revision=JSON.parse(await readFile(baseline+'/revision.json'));
const baselineSource=await readFile(baseline+'/range-reader.mjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(baselineSource),revision.files['range-reader.mjs']);
const {createRangeReader:oldReader}=await import(pathToFileURL(baseline+'/range-reader.mjs'));
const {archiveLayouts:layouts}=await import(pathToFileURL(output+'/original-preview/resource-layout.mjs'));
const bytes=await readFile('.bridge/joey-web/reverse/input/Voice.dat');
assert.equal(hash(bytes),layouts['/Voice.dat'].sha256);
const file={path:'/Voice.dat',url:'voice',length:bytes.length,sha256:layouts['/Voice.dat'].sha256};
const asset=65522888,offset=66556660,length=24576,priorStart=asset+3*262144,priorEnd=priorStart+262144+4095-1;
const range=options=>{const match=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);assert(match);return {start:Number(match[1]),end:Number(match[2])};};
const response=(start,end,body=bytes.subarray(start,end+1))=>new Response(body,{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
const idle=async reader=>{while(reader.stats.activeRequests||reader.stats.activePrefetch)await sleep(5);};
const cached=(start,end)=>start===priorStart&&end===priorEnd?bytes.subarray(start,end+1):null;
const cache={read:async(f,start,end,parent)=>cached(start,end)||(parent&&cached(parent.start,parent.end)?.subarray(start-parent.start,end-parent.start+1)),save:async()=>{}};
async function tail(factory){
 const requests=[],reader=factory([file],{layouts,cache,fetcher:async(url,options)=>{
  const {start,end}=range(options);requests.push({start,end});let sent=false;
  return response(start,end,new ReadableStream({async pull(controller){
   if(options.signal.aborted){controller.error(options.signal.reason);return;}
   if(!sent){sent=true;controller.enqueue(bytes.subarray(start,Math.min(start+65536,end+1)));return;}
   if(end-start+1>65536){await sleep(600);if(options.signal.aborted){controller.error(options.signal.reason);return;}controller.enqueue(bytes.subarray(start+65536,end+1));}controller.close();
  }}));
 }});
 const began=performance.now(),actual=await reader.read(file.path,offset,length),blockingMs=Math.round(performance.now()-began);
 assert.deepEqual(Buffer.from(actual),bytes.subarray(offset,offset+length));reader.close();await idle(reader);
 return {blockingMs,requests,byteExact:true};
}
const before=await tail(oldReader),after=await tail(createRangeReader);
assert(before.blockingMs>=550);assert(after.blockingMs<300);assert(after.requests.every(r=>r.end-r.start+1<=65536));

// Silent body stall: save even a small prefix, abort, and request only the tail.
const blocks=new Map(),partials=new Map(),key=(s,e)=>s+':'+e;
const checkpointCache={read:async(f,s,e)=>blocks.get(key(s,e)),save:async(f,s,e,b)=>{blocks.set(key(s,e),b.slice());partials.delete(key(s,e));},readPartial:async(f,s,e)=>partials.get(key(s,e)),savePartial:async(f,s,e,b)=>partials.set(key(s,e),b.slice())};
const resumeStarts=[];let fetchCount=0,cancels=0;
const stalled=createRangeReader([file],{cache:checkpointCache,stallTimeoutMs:60,fetcher:async(url,options)=>{
 const {start,end}=range(options);resumeStarts.push(start);if(fetchCount++)return response(start,end);
 let sent=false;return response(start,end,new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(bytes.subarray(start,start+4096));}},cancel(){cancels++;}}));
}});
assert.deepEqual(Buffer.from(await stalled.read(file.path,offset,length)),bytes.subarray(offset,offset+length));
assert.deepEqual(resumeStarts,[offset,offset+4096]);assert.equal(stalled.stats.networkStalls,1);assert.equal(stalled.stats.networkRetries,1);assert.equal(stalled.stats.downloadedBytes,length);assert.equal(partials.size,0);assert.equal(cancels,1);stalled.close();

// A pending headers promise must also be bounded, even if a fetch shim ignores abort.
let headersAttempts=0;
const noHeaders=createRangeReader([file],{stallTimeoutMs:60,fetcher:async(url,options)=>{const {start,end}=range(options);if(!headersAttempts++)return new Promise(()=>{});return response(start,end);}});
assert.deepEqual(Buffer.from(await noHeaders.read(file.path,offset,length)),bytes.subarray(offset,offset+length));assert.equal(noHeaders.stats.networkStalls,1);noHeaders.close();

// Slow but advancing transport must not be confused with a silent stall.
const advancing=createRangeReader([file],{stallTimeoutMs:100,fetcher:async(url,options)=>{
 const {start,end}=range(options);let pos=start;
 return response(start,end,new ReadableStream({async pull(controller){await sleep(25);if(pos>end){controller.close();return;}const next=Math.min(pos+4096,end+1);controller.enqueue(bytes.subarray(pos,next));pos=next;}}));
}});
assert.deepEqual(Buffer.from(await advancing.read(file.path,offset,length)),bytes.subarray(offset,offset+length));assert.equal(advancing.stats.networkStalls,0);advancing.close();

// One foreground PCM read queues <=12 future small pages, never a whole song.
const aheadRequests=[];let active=0,maxActive=0;
const ahead=createRangeReader([file],{layouts,fetcher:async(url,options)=>{const {start,end}=range(options);aheadRequests.push({start,end});active++;maxActive=Math.max(maxActive,active);try{await sleep(5);return response(start,end);}finally{active--;}}});
const musicOffset=asset+44;
assert.deepEqual(Buffer.from(await ahead.read(file.path,musicOffset,40960)),bytes.subarray(musicOffset,musicOffset+40960));await idle(ahead);
assert.equal(aheadRequests.length,13);assert.equal(maxActive,1);assert.equal(ahead.stats.downloadedBytes,13*65536);assert(ahead.stats.cacheBytes<=4194304);
const aheadCount=aheadRequests.length;
assert.deepEqual(Buffer.from(await ahead.read(file.path,asset+9*65536,40960)),bytes.subarray(asset+9*65536,asset+9*65536+40960));
assert.equal(aheadRequests.length,aheadCount,'Already buffered PCM must return before future cold prefetch starts');ahead.close();await idle(ahead);

// Opening WAV headers must retain the original small reads without queuing tracks.
const headerRequests=[];
const headers=createRangeReader([file],{layouts,fetcher:async(url,options)=>{const r=range(options);headerRequests.push(r);return response(r.start,r.end);}});
for(const [start,,streaming]of layouts[file.path].entries)if(streaming)assert.deepEqual(Buffer.from(await headers.read(file.path,start,4096)),bytes.subarray(start,start+4096));
await idle(headers);assert(headerRequests.every(r=>r.end-r.start+1===4096));assert.equal(headers.stats.activePrefetch,0);headers.close();

// Closing cancels an outstanding read immediately, rather than waiting for timeout.
const closing=createRangeReader([file],{fetcher:()=>new Promise(()=>{})});
const closingRead=closing.read(file.path,offset,length);await sleep(10);const closedAt=performance.now();closing.close();await assert.rejects(closingRead);assert(performance.now()-closedAt<200);
const report={scope:'Pinned m_kaban WAV, same user offset/length and old-page cache; synthetic 600ms tail delay. Controlled transport faults, not physical iPhone or complete-duel acceptance.',baselineVersion:revision.version,baselineReaderSHA256:hash(baselineSource),candidateReaderSHA256:hash(await readFile(new URL('./range-reader.mjs',import.meta.url))),voiceSHA256:file.sha256,offset,length,byteExact:true,tailDelayMs:600,baseline:before,candidate:after,stallResume:{resumeStarts,networkStalls:stalled.stats.networkStalls,networkRetries:stalled.stats.networkRetries,downloadedBytes:stalled.stats.downloadedBytes,partialRemoved:partials.size===0},headerStallBounded:true,slowProgressAccepted:true,readAhead:{requests:13,decodedBytes:13*65536,maxConcurrentNetwork:maxActive},openingHeadersDoNotPreload:true,closeCancelsImmediately:true};
await writeFile(output+'/cards-patch/music-stall-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
