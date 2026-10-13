// Bounded, byte-exact reads from immutable original archives. Small music ranges
// are read ahead sequentially; asset boundaries come from the original DAT.
export function createRangeReader(manifest, {chunkSize = 131072, maxChunks = 32, fetcher = fetch, cache, layouts = {}, stallTimeoutMs = 3000} = {}) {
  const files = new Map(manifest.map(file => [file.path, {...file}]));
  const chunks = new Map(), inflight = new Map(), reads = new Map(), controllers = new Set();
  // Keep the startup plan and existing 256KiB cache keys stable. Live music
  // needs only 64KiB per response, with at most 768KiB of future PCM queued.
  const limit = chunkSize * maxChunks, streamPage = 262144, musicPage = 65536, musicAhead = 12;
  if(!Number.isFinite(stallTimeoutMs)||stallTimeoutMs<=0)throw Error('Invalid resource stall timeout');
  let closed = false, nextRead = 0, preparing = 0, nextPreparationRequest = 0;
  const stats = {requests: 0, downloadedBytes: 0, cacheBytes: 0, evictions: 0, requestedBytes: 0, activeRequests: 0, activeReads: 0, activePrefetch:0, pendingReads: [], diskCacheHits: 0, diskCacheBytes: 0, memoryHits: 0, memoryBytes: 0, sharedRequests: 0, prefetchedPages: 0, prefetchErrors: 0, networkMs: 0, diskReadMs: 0, diskWriteMs: 0, readMs: 0, rateLimitRetries: 0, networkRetries:0, networkAttempts:0, networkStalls:0, partialCacheBytes:0, resumedRequests:0};
  for (const file of files.values()) {
    const layout = layouts[file.path];
    if (!layout) continue;
    if (layout.sha256 !== file.sha256 || layout.length !== file.length || !Array.isArray(layout.entries) || layout.entries.length > 100001) throw Error('Original archive directory mismatch: ' + file.path);
    let end = 0;
    for (const entry of layout.entries) {
      if (!Array.isArray(entry) || entry.length !== 3 || !Number.isSafeInteger(entry[0]) || entry[0] !== end || !Number.isSafeInteger(entry[1]) || entry[1] <= 0 || ![0, 1].includes(entry[2]) || (!entry[2] && entry[1] + 4095 > 8388608)) throw Error('Invalid original asset span');
      end += entry[1];
    }
    if (end !== file.length) throw Error('Truncated original archive directory');
    file.entries = layout.entries;
    file.primedMusic = new Set();
  }
  const pending = () => { stats.activeReads = reads.size; stats.pendingReads = [...reads.values()]; };
  const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
    const aborted=()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted);reject(signal.reason||Error('Original resource reader closed'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},milliseconds);
    signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
  });
  const networkWait = (task,controller) => {
    let timer,aborted;
    const interrupted=new Promise((resolve,reject)=>{
      aborted=()=>reject(controller.signal.reason||Error('Original resource request aborted'));
      controller.signal.addEventListener('abort',aborted,{once:true});
      if(controller.signal.aborted){aborted();return;}
      timer=setTimeout(()=>{stats.networkStalls++;const error=Error('Original resource download made no progress');error.name='OriginalResourceStall';controller.abort(error);},stallTimeoutMs);
    });
    return Promise.race([task,interrupted]).finally(()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',aborted);});
  };
  async function request(file, start, end, prefetch, onTransfer, containingSpan, saveComplete = true) {
    const diskStarted = performance.now();
    const cached = cache ? await cache.read(file, start, end, containingSpan) : null;
    stats.diskReadMs += performance.now() - diskStarted;
    if (cached) { stats.diskCacheHits++; stats.diskCacheBytes += cached.length; onTransfer?.(cached.length,cached.length);return cached; }
    if (closed) throw Error('Original resource reader closed');
    const controller = new AbortController(); controllers.add(controller);
    stats.activeRequests++; stats.lastRequest = {path: file.path, start, end, prefetch, startedAt: Date.now()};
    try {
      const bytes=new Uint8Array(end-start+1),partial=await cache?.readPartial?.(file,start,end);
      let received=partial?.length||0,saved=received;
      if(partial){bytes.set(partial);stats.partialCacheBytes+=received;}
      onTransfer?.(received,received);
      // The shared public ingress is8r/s with a40-request burst. Pace only cold
      // preparation and music read-ahead requests; cache hits and foreground
      // reads stay prompt. Small music ranges must not create a request burst.
      if(preparing||prefetch){
        const now=performance.now(),admission=Math.max(now,nextPreparationRequest);nextPreparationRequest=admission+150;
        if(admission>now)await delay(admission-now,controller.signal);
      }
      const networkStarted = performance.now();
      const checkpoint=async()=>{
        if(cache?.savePartial&&received>saved&&received<bytes.length){const began=performance.now();await cache.savePartial(file,start,end,bytes.slice(0,received));stats.diskWriteMs+=performance.now()-began;saved=received;}
      };
      for(let attempt=0;received<bytes.length;attempt++){
        const first=start+received,transfer=new AbortController();
        const abort=()=>transfer.abort(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();
        let stream,invalid=false,overflow=false,retryWait;
        try{
          stats.networkAttempts++;if(received)stats.resumedRequests++;
          const response=await networkWait(fetcher(file.compressedURL?file.compressedURL+`?start=${first}&end=${end}`:file.url,{headers:file.compressedURL?{}:{Range:`bytes=${first}-${end}`},signal:transfer.signal}),transfer);
          if(response.status===429||response.status===503){
            response.body?.cancel().catch(()=>{});if(attempt>=5){invalid=true;throw Error('资源下载暂时不可用：HTTP '+response.status);}
            if(response.status===429)stats.rateLimitRetries++;else stats.networkRetries++;
            const retry=response.headers.get('Retry-After'),seconds=Number(retry),date=Date.parse(retry||'');
            const wait=retry!==null&&(Number.isFinite(seconds)||Number.isFinite(date))?(Number.isFinite(seconds)?seconds*1000:date-Date.now()):1000*2**attempt;
            retryWait=Math.min(30000,Math.max(1000,wait));
          }else{
          if(response.status!==(file.compressedURL?200:206)||response.headers.get(file.compressedURL?'X-Original-Range':'Content-Range')!==`bytes ${first}-${end}/${file.length}`){response.body?.cancel().catch(()=>{});invalid=true;throw Error(`Invalid resource range response: ${file.path} ${first}-${end}`);}
          stream=response.body?.getReader();if(!stream){invalid=true;throw Error('Missing resource response body');}
          for(;;){
            const {done,value}=await networkWait(stream.read(),transfer);if(done)break;
            if(received+value.length>bytes.length){overflow=true;throw Error('Oversized resource range: '+file.path);}
            bytes.set(value,received);received+=value.length;stats.downloadedBytes+=value.length;onTransfer?.(received,0);
            // Commit a bounded prefix every128KiB, before consuming more data.
            if(received-saved>=131072)await checkpoint();
          }
          if(received!==bytes.length)throw Error('Truncated resource range: '+file.path);
          }
        }catch(error){
          // A final decoder/transport error can arrive after the last byte.
          // Retry its uncommitted tail instead of accepting an errored body.
          if(received===bytes.length){received=saved;onTransfer?.(received,0);}
          stream?.cancel().catch(()=>{});transfer.abort(error);await checkpoint();
          if(invalid||overflow||controller.signal.aborted||attempt>=5)throw error;
          stats.networkRetries++;retryWait=Math.min(10000,(error.name==='OriginalResourceStall'?250:1000)*2**attempt);
        }finally{stream?.releaseLock();controller.signal.removeEventListener('abort',abort);}
        if(retryWait!==undefined)await delay(retryWait,controller.signal);
      }
      stats.networkMs += performance.now() - networkStarted;
      stats.requests++;
      const saveStarted = performance.now();
      if (cache && saveComplete) await cache.save(file, start, end, bytes);
      stats.diskWriteMs += performance.now() - saveStarted;
      return bytes;
    } finally { stats.activeRequests--; controllers.delete(controller); }
  }
  function remember(file,start,end,bytes){
    if(closed||bytes.length>limit)return;
    const key=file.path+':'+start+':'+end;
    if(chunks.has(key)){stats.cacheBytes-=chunks.get(key).bytes.length;chunks.delete(key);}
    chunks.set(key,{path:file.path,start,end,bytes});stats.cacheBytes+=bytes.length;
    while(stats.cacheBytes>limit||chunks.size>4096){
      const oldest=chunks.keys().next().value;
      stats.cacheBytes-=chunks.get(oldest).bytes.length;chunks.delete(oldest);stats.evictions++;
    }
  }
  async function chunk(file, start, end, prefetch = false, onTransfer, containingSpan) {
    const key = file.path + ':' + start + ':' + end;
    if (chunks.has(key)) {
      const item = chunks.get(key); chunks.delete(key); chunks.set(key, item);
      if (!prefetch) { stats.memoryHits++; stats.memoryBytes += item.bytes.length; }
      onTransfer?.(item.bytes.length,item.bytes.length);return item.bytes;
    }
    const parentKey=containingSpan&&file.path+':'+containingSpan.start+':'+containingSpan.end;
    if(parentKey&&chunks.has(parentKey)){
      const item=chunks.get(parentKey);chunks.delete(parentKey);chunks.set(parentKey,item);
      const bytes=item.bytes.subarray(start-containingSpan.start,end-containingSpan.start+1);
      if(!prefetch){stats.memoryHits++;stats.memoryBytes+=bytes.length;}onTransfer?.(bytes.length,bytes.length);return bytes;
    }
    if (inflight.has(key)) { if (!prefetch) stats.sharedRequests++; return inflight.get(key); }
    const task = request(file, start, end, prefetch,onTransfer,containingSpan).then(bytes => {
      remember(file,start,end,bytes);
      if (prefetch) stats.prefetchedPages++;
      return bytes;
    }).finally(() => inflight.delete(key));
    inflight.set(key, task); return task;
  }
  function span(file, pos, remaining) {
    if (!file.entries) {
      const block = file.path === '/Voice.dat' ? Math.min(chunkSize, 4096) : chunkSize;
      const start = remaining >= block ? pos : Math.floor(pos / block) * block;
      return {start, end: Math.min(file.length, start + (remaining >= block ? remaining : block)) - 1};
    }
    let low = 0, high = file.entries.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (file.entries[middle][0] <= pos) low = middle; else high = middle; }
    const [assetStart, length, streaming] = file.entries[low], assetEnd = assetStart + length;
    // Opening a WAV header must not preload every music track at startup.
    if (streaming && pos === assetStart && remaining <= 4096 && !file.primedMusic.has(assetStart)) return {start: pos, end: Math.min(file.length, pos + 4096) - 1};
    const start = streaming ? assetStart + Math.floor((pos - assetStart) / musicPage) * musicPage : assetStart;
    const end = Math.min(file.length, streaming ? Math.min(assetEnd, start + musicPage) : assetEnd + 4095) - 1;
    const oldStart=assetStart+Math.floor((pos-assetStart)/streamPage)*streamPage;
    const containingSpan=streaming?{start:oldStart,end:Math.min(file.length,Math.min(assetEnd,oldStart+streamPage)+4095)-1}:undefined;
    return {start, end, next: streaming && end+1<assetEnd ? end+1 : null, assetStart,assetEnd,containingSpan};
  }
  function startMusicPrefetch(file){
    if(closed||file.musicPrefetchTask)return;
    stats.activePrefetch++;
    file.musicPrefetchTask=(async()=>{
      while(!closed){
        const job=file.musicPrefetch;
        if(!job||job.next>=job.target)break;
        const unit=span(file,job.next,musicPage);
        try{await chunk(file,unit.start,unit.end,true,undefined,unit.containingSpan);}
        catch(error){if(!closed){stats.prefetchErrors++;stats.lastPrefetchError=String(error).slice(0,200);}if(file.musicPrefetch===job)job.target=job.next;}
        if(file.musicPrefetch===job)job.next=Math.max(job.next,unit.end+1);
      }
    })().finally(()=>{stats.activePrefetch--;file.musicPrefetchTask=null;if(!closed&&file.musicPrefetch.next<file.musicPrefetch.target)startMusicPrefetch(file);});
  }
  function readAhead(file,unit){
    if(unit.next===null||unit.next===undefined)return;
    let job=file.musicPrefetch;
    if(!job||job.assetStart!==unit.assetStart||unit.start<job.lastStart)job=file.musicPrefetch={assetStart:unit.assetStart,next:unit.next,target:unit.next,lastStart:unit.start};
    job.lastStart=unit.start;job.next=Math.max(job.next,unit.next);
    job.target=Math.min(unit.assetEnd,Math.max(job.target,unit.next+musicAhead*musicPage));
    startMusicPrefetch(file);
  }
  return {
    stats,
    async invalidate(path,start,end){
      const file=files.get(path);
      if(!file||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||end>=file.length)throw Error('Invalid resource reader invalidation');
      for(const [key,item]of chunks)if(item.path===path&&item.start<=end&&item.end>=start){stats.cacheBytes-=item.bytes.length;chunks.delete(key);}
      return cache?.invalidate?cache.invalidate(file,start,end):false;
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); chunks.clear(); stats.cacheBytes = 0; },
    async preload(plan, onProgress) {
      const spans=[];
      // A null plan prepares every immutable archive in fixed 1MiB pages. The
      // persistent cache serves arbitrary original reads from these pages.
      if(plan===null){
        for(const file of files.values()){
          if(!/^[a-f0-9]{64}$/.test(file.sha256||''))throw Error('Full archive preparation needs a pinned source');
          for(let start=0;start<file.length;start+=1048576)spans.push({file,start,end:Math.min(file.length,start+1048576)-1});
        }
      }
      for(const [path,assets] of Object.entries(plan||{})){
        const file=files.get(path);
        if(!file?.entries||assets.sha256!==file.sha256||!Array.isArray(assets.assetStarts))throw Error('Invalid original preload source');
        for(const start of assets.assetStarts){
          const entry=file.entries.find(entry=>entry[0]===start);
          if(!entry||entry[2])throw Error('Invalid original preload asset');
          spans.push({file,start,end:Math.min(file.length,start+entry[1]+4095)-1});
        }
        for(const [start,end] of assets.streamSpans||[]){
          const entry=file.entries.find(entry=>entry[0]<=start&&start<entry[0]+entry[1]);
          if(!entry?.[2]||(start-entry[0])%streamPage||end!==Math.min(file.length,Math.min(entry[0]+entry[1],start+streamPage)+4095)-1)throw Error('Invalid original preload music page');
          spans.push({file,start,end,musicStart:entry[0]});
        }
      }
      const total=spans.reduce((sum,span)=>sum+span.end-span.start+1,0);
      if(total>(plan===null?536870912:67108864))throw Error('Original preload budget exceeded');
      let completed=0,restoredBytes=0;const active=new Map();
      const progress=()=>onProgress({completed:completed+[...active.values()].reduce((sum,value)=>sum+value,0),total,restoredBytes});
      if(progress()===false)return false;
      let jobs=spans;
      if(plan!==null){
        const cold=[];
        // Probe old keys one at a time: warm records never connect cold gaps,
        // and preparation does not retain the whole plan in memory.
        for(const unit of spans){
          if(closed)throw Error('Original resource reader closed');
          const {file,start,end,musicStart}=unit,key=file.path+':'+start+':'+end;
          let bytes;
          if(chunks.has(key)){
            bytes=chunks.get(key).bytes;stats.memoryHits++;stats.memoryBytes+=bytes.length;
          }else{
            const began=performance.now();bytes=await cache?.read(file,start,end);stats.diskReadMs+=performance.now()-began;
            if(bytes){stats.diskCacheHits++;stats.diskCacheBytes+=bytes.length;}
          }
          if(closed)throw Error('Original resource reader closed');
          if(bytes){
            remember(file,start,end,bytes);
            completed+=bytes.length;restoredBytes+=bytes.length;
            if(musicStart!==undefined)file.primedMusic.add(musicStart);
            if(progress()===false)return false;
          }else{
            // An older reader may already have persisted this exact prefix.
            // Keep its original request identity so the prefix remains reusable.
            unit.partial=Boolean(await cache?.readPartial?.(file,start,end));cold.push(unit);
          }
        }
        if(closed)throw Error('Original resource reader closed');
        cold.sort((a,b)=>a.file.path.localeCompare(b.file.path)||a.start-b.start||a.end-b.end);
        jobs=[];
        for(const unit of cold){
          const previous=jobs.at(-1),end=Math.max(previous?.end??0,unit.end);
          if(previous&&!previous.partial&&!unit.partial&&previous.file===unit.file&&unit.start<=previous.end+1&&end-previous.start+1<=1048576){
            previous.end=end;previous.members.push(unit);
          }else jobs.push({...unit,members:[unit]});
        }
      }
      // Four bounded requests avoid one round-trip per asset. IndexedDB writes
      // remain atomic; live progress also includes the received active prefixes.
      let next=0,continuing=true;
      preparing++;let results;
      try{results=await Promise.allSettled(Array.from({length:Math.min(4,jobs.length)},async()=>{
        try{
          while(continuing&&next<jobs.length){
            const index=next++,{file,start,end,members}=jobs[index];
            const merged=members?.length>1,units=members||[jobs[index]];
            const logical=received=>units.reduce((sum,unit)=>sum+Math.max(0,Math.min(unit.end+1,start+received)-unit.start),0);
            const transferred=(received,restored)=>{active.set(index,logical(received));restoredBytes+=logical(restored);if(progress()===false)continuing=false;};
            if(merged){
              const bytes=await request(file,start,end,false,transferred,undefined,false);
              let saved=true;
              for(const unit of units){
                if(closed)throw Error('Original resource reader closed');
                const part=bytes.slice(unit.start-start,unit.end-start+1),began=performance.now();
                if(await cache?.save(file,unit.start,unit.end,part)!==true)saved=false;
                stats.diskWriteMs+=performance.now()-began;remember(file,unit.start,unit.end,part);
              }
              if(closed)throw Error('Original resource reader closed');
              // Delete only the merged prefix, after all original records commit.
              // A missing/disabled cache or interrupted split retains its restart.
              if(saved&&!closed)await cache?.discardPartial?.(file,start,end);
            }else await chunk(file,start,end,false,transferred);
            for(const unit of units)if(unit.musicStart!==undefined)file.primedMusic.add(unit.musicStart);
            completed+=logical(end-start+1);
            active.delete(index);if(progress()===false)continuing=false;
          }
        }catch(error){continuing=false;throw error;}
      }));}finally{preparing--;}
      const failure=results.find(result=>result.status==='rejected');
      if(failure)throw failure.reason;
      if(continuing&&plan===null)for(const file of files.values())for(const entry of file.entries||[])if(entry[2])file.primedMusic.add(entry[0]);
      return continuing;
    },
    async read(path, offset, length) {
      const file = files.get(path);
      if (!file) throw Error('Unregistered original resource: ' + path);
      if (closed) throw Error('Original resource reader closed');
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw Error('Invalid resource read');
      const size = Math.min(length, Math.max(0, file.length - offset));
      if (!size) return new Uint8Array();
      stats.requestedBytes += size;
      const id = ++nextRead, started = performance.now();
      const record = {path, offset, length: size, startedAt: Date.now()}; reads.set(id, record); pending();
      try {
        const result = new Uint8Array(size);
        let copied = 0;
        while (copied < size) {
          const pos = offset + copied, unit = span(file, pos, size - copied);
          const bytes = await chunk(file, unit.start, unit.end,false,undefined,unit.containingSpan);
          const n = Math.min(size - copied, bytes.length - (pos - unit.start));
          if (n <= 0) throw Error('Invalid original resource span');
          result.set(bytes.subarray(pos - unit.start, pos - unit.start + n), copied); copied += n;
          readAhead(file,unit);
        }
        return result;
      } finally {
        record.durationMs = Math.round(performance.now() - started); stats.lastRead = record; stats.readMs += record.durationMs;
        if (!stats.longestRead || record.durationMs > stats.longestRead.durationMs) stats.longestRead = record;
        reads.delete(id); pending();
      }
    }
  };
}
