// Bounded, byte-exact reads from immutable original archives. Music is read ahead
// by one page; asset boundaries come from the original DAT directory.
export function createRangeReader(manifest, {chunkSize = 131072, maxChunks = 32, fetcher = fetch, cache, layouts = {}} = {}) {
  const files = new Map(manifest.map(file => [file.path, {...file}]));
  const chunks = new Map(), inflight = new Map(), reads = new Map(), controllers = new Set();
  const limit = chunkSize * maxChunks, streamPage = 262144;
  let closed = false, nextRead = 0, preparing = 0, nextPreparationRequest = 0;
  const stats = {requests: 0, downloadedBytes: 0, cacheBytes: 0, evictions: 0, requestedBytes: 0, activeRequests: 0, activeReads: 0, pendingReads: [], diskCacheHits: 0, diskCacheBytes: 0, memoryHits: 0, memoryBytes: 0, sharedRequests: 0, prefetchedPages: 0, prefetchErrors: 0, networkMs: 0, diskReadMs: 0, diskWriteMs: 0, readMs: 0, rateLimitRetries: 0, networkRetries:0, networkAttempts:0, partialCacheBytes:0, resumedRequests:0};
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
  async function request(file, start, end, prefetch, onTransfer) {
    const diskStarted = performance.now();
    const cached = cache ? await cache.read(file, start, end) : null;
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
      // preparation requests; cache hits and ordinary in-game reads stay prompt.
      if(preparing){
        const now=performance.now(),admission=Math.max(now,nextPreparationRequest);nextPreparationRequest=admission+150;
        if(admission>now)await delay(admission-now,controller.signal);
      }
      const networkStarted = performance.now();
      const checkpoint=async()=>{
        if(cache?.savePartial&&received>saved&&received<bytes.length){const began=performance.now();await cache.savePartial(file,start,end,bytes.slice(0,received));stats.diskWriteMs+=performance.now()-began;saved=received;}
      };
      for(let attempt=0;received<bytes.length;attempt++){
        const first=start+received;let response;
        try{
          stats.networkAttempts++;if(received)stats.resumedRequests++;
          response=await fetcher(file.compressedURL?file.compressedURL+`?start=${first}&end=${end}`:file.url,{headers:file.compressedURL?{}:{Range:`bytes=${first}-${end}`},signal:controller.signal});
        }catch(error){
          if(controller.signal.aborted||attempt>=5)throw error;
          stats.networkRetries++;await delay(Math.min(10000,1000*2**attempt),controller.signal);continue;
        }
        if(response.status===429||response.status===503){
          await response.body?.cancel();if(attempt>=5)throw Error('资源下载暂时不可用：HTTP '+response.status);
          if(response.status===429)stats.rateLimitRetries++;else stats.networkRetries++;
          const retry=response.headers.get('Retry-After'),seconds=Number(retry),date=Date.parse(retry||'');
          const wait=retry!==null&&(Number.isFinite(seconds)||Number.isFinite(date))?(Number.isFinite(seconds)?seconds*1000:date-Date.now()):1000*2**attempt;
          await delay(Math.min(30000,Math.max(1000,wait)),controller.signal);continue;
        }
        if(response.status!==(file.compressedURL?200:206)||response.headers.get(file.compressedURL?'X-Original-Range':'Content-Range')!==`bytes ${first}-${end}/${file.length}`){await response.body?.cancel();throw Error(`Invalid resource range response: ${file.path} ${first}-${end}`);}
        const stream=response.body?.getReader();if(!stream)throw Error('Missing resource response body');
        let overflow=false;
        try{
          for(;;){
            const {done,value}=await stream.read();if(done)break;
            if(received+value.length>bytes.length){overflow=true;throw Error('Oversized resource range: '+file.path);}
            bytes.set(value,received);received+=value.length;stats.downloadedBytes+=value.length;onTransfer?.(received,0);
            // Commit a bounded prefix every128KiB, before consuming more data.
            if(received-saved>=131072)await checkpoint();
          }
          if(received!==bytes.length)throw Error('Truncated resource range: '+file.path);
        }catch(error){
          // A final decoder/transport error can arrive after the last byte.
          // Retry its uncommitted tail instead of accepting an errored body.
          if(received===bytes.length){received=saved;onTransfer?.(received,0);}
          await stream.cancel().catch(()=>{});await checkpoint();
          if(overflow||controller.signal.aborted||attempt>=5)throw error;
          stats.networkRetries++;await delay(Math.min(10000,1000*2**attempt),controller.signal);continue;
        }finally{stream.releaseLock();}
      }
      stats.networkMs += performance.now() - networkStarted;
      stats.requests++;
      const saveStarted = performance.now();
      if (cache) await cache.save(file, start, end, bytes);
      stats.diskWriteMs += performance.now() - saveStarted;
      return bytes;
    } finally { stats.activeRequests--; controllers.delete(controller); }
  }
  async function chunk(file, start, end, prefetch = false, onTransfer) {
    const key = file.path + ':' + start + ':' + end;
    if (chunks.has(key)) {
      const item = chunks.get(key); chunks.delete(key); chunks.set(key, item);
      if (!prefetch) { stats.memoryHits++; stats.memoryBytes += item.bytes.length; }
      onTransfer?.(item.bytes.length,item.bytes.length);return item.bytes;
    }
    if (inflight.has(key)) { if (!prefetch) stats.sharedRequests++; return inflight.get(key); }
    const task = request(file, start, end, prefetch,onTransfer).then(bytes => {
      if (!closed && bytes.length <= limit) {
        chunks.set(key, {path: file.path, start, end, bytes}); stats.cacheBytes += bytes.length;
        while (stats.cacheBytes > limit || chunks.size > 4096) {
          const oldest = chunks.keys().next().value;
          stats.cacheBytes -= chunks.get(oldest).bytes.length; chunks.delete(oldest); stats.evictions++;
        }
      }
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
    const start = streaming ? assetStart + Math.floor((pos - assetStart) / streamPage) * streamPage : assetStart;
    const end = Math.min(file.length, (streaming ? Math.min(assetEnd, start + streamPage) : assetEnd) + 4095) - 1;
    return {start, end, next: streaming && start + streamPage < assetEnd ? start + streamPage : null, assetEnd};
  }
  return {
    stats,
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
      // Four bounded requests avoid one round-trip per asset. IndexedDB writes
      // remain atomic; live progress also includes the received active prefixes.
      let next=0,continuing=true;
      preparing++;let results;
      try{results=await Promise.allSettled(Array.from({length:Math.min(4,spans.length)},async()=>{
        try{
          while(continuing&&next<spans.length){
            const index=next++,{file,start,end,musicStart}=spans[index];
            await chunk(file,start,end,false,(received,restored)=>{active.set(index,received);restoredBytes+=restored;if(progress()===false)continuing=false;});
            if(musicStart!==undefined)file.primedMusic.add(musicStart);
            completed+=end-start+1;
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
          const bytes = await chunk(file, unit.start, unit.end);
          const n = Math.min(size - copied, bytes.length - (pos - unit.start));
          if (n <= 0) throw Error('Invalid original resource span');
          result.set(bytes.subarray(pos - unit.start, pos - unit.start + n), copied); copied += n;
          if (unit.next !== null && unit.next !== undefined) {
            const end = Math.min(file.length, Math.min(unit.assetEnd, unit.next + streamPage) + 4095) - 1;
            chunk(file, unit.next, end, true).catch(error => { if (!closed) { stats.prefetchErrors++; stats.lastPrefetchError = String(error).slice(0,200); } });
          }
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
