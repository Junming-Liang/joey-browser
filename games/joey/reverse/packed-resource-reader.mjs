// Opt-in complete installation. Cache and resume offsets are compressed bytes;
// original game still receives byte-exact original archive offsets.
import {createRangeReader} from './range-reader.mjs';
import {filterOriginalBytes} from './resource-byte-filter.mjs';
import {filterStructuredBytes} from './structured-byte-filter.mjs';
import {createBrotliBlockDecoder} from './brotli-block-decoder.mjs';
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const validHash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const simpleKinds=['none','delta-rgb','delta-pcm16','delta-pcm16-plane'];
const structuredKinds=['bmp-up','bmp-paeth','bmp-paeth-green','pcm-mono-first-plane','pcm-stereo-second-plane','pcm-mono-second-plane'];
export function createPackedResourceReader(manifest,{originalManifest,cache,fetcher=fetch,cacheOnly=false,decodedMemoryBytes=2097152,stallTimeoutMs=3000}={}){
 const light=manifest?.format==='joey-light-pack-v3',v2=light||manifest?.format==='joey-lossless-pack-v2';
 if(![ 'joey-lossless-gzip-pack-v1','joey-lossless-pack-v2','joey-light-pack-v3'].includes(manifest?.format)||manifest.pageBytes!==1048576||!Array.isArray(originalManifest)||originalManifest.length!==3||!Array.isArray(manifest.archives)||manifest.archives.length!==3||!Array.isArray(manifest.blocks)||manifest.blocks.length>10000||!Number.isSafeInteger(decodedMemoryBytes)||decodedMemoryBytes<manifest.pageBytes||decodedMemoryBytes>4194304)throw Error('Invalid packed resource manifest');
 if(v2&&(manifest.decoder?.url!=='/joey/original/brotli-decoder.wasm'||!validHash(manifest.decoder.sha256)||!Number.isSafeInteger(manifest.decoder.length)||manifest.decoder.length<1||manifest.decoder.length>1048576||manifest.decoder.memoryLimitBytes!==33554432))throw Error('Invalid packed integer decoder');
 const pack=manifest.pack;
 if(pack?.path!=='/__joey_packed_resources_v1'||typeof pack.url!=='string'||!pack.url.startsWith('/')||pack.url.startsWith('//')||!validHash(pack.sha256)||!Number.isSafeInteger(pack.length)||pack.length<1||pack.length>536870912)throw Error('Invalid compressed pack identity');
 const files=new Map();
 for(const file of manifest.archives){
  const original=originalManifest.find(f=>f.path===file.path);
  if(!original||original.length!==file.length||original.sha256!==file.sha256||!validHash(file.sha256)||(light&&!validHash(file.derivedSHA256))||files.has(file.path)||!Number.isSafeInteger(file.length)||file.length<1)throw Error('Packed archive source mismatch');
  files.set(file.path,{...file,blocks:[]});
 }
 let packedEnd=0;
 for(const block of manifest.blocks){
  const file=files.get(block.path),end=file?.blocks.at(-1);
  if(v2&&!['gzip','brotli'].includes(block.codec))throw Error('Invalid packed block codec');
  if(light&&!validHash(block.sourceSHA256))throw Error('Missing original block identity');
  if(!file||![block.start,block.length,block.packedStart,block.packedLength].every(Number.isSafeInteger)||block.start!==(end?end.start+end.length:0)||block.length!==Math.min(manifest.pageBytes,file.length-block.start)||block.length<1||block.packedStart!==packedEnd||block.packedLength<1||block.packedLength>manifest.pageBytes+1024||!validHash(block.sha256)||!validHash(block.packedSHA256)||!Array.isArray(block.spans)||block.spans.length>10000||![...simpleKinds,...structuredKinds].includes(block.kind))throw Error('Invalid packed block');
  // Validate descriptor bounds before any network/decompression allocation.
  let spanEnd=0;
  for(const span of block.spans){
   if(!Array.isArray(span)||span.length!==6)throw Error('Invalid packed bitmap geometry');
   const [start,end,stride,rowBytes,bpp,rowOffset]=span;
   if(!span.every(Number.isSafeInteger)||start<spanEnd||end>block.length||start>=end||stride<1||stride>manifest.pageBytes||rowBytes<1||rowBytes>stride||![1,3].includes(bpp)||rowOffset<0||rowOffset>=stride)throw Error('Invalid packed bitmap geometry');
   spanEnd=end;
  }
  if(block.spans.length&&!block.kind.startsWith('bmp-'))throw Error('Unexpected packed geometry');
  packedEnd+=block.packedLength;file.blocks.push(block);
 }
 if(packedEnd!==pack.length||[...files.values()].some(f=>f.blocks.at(-1)?.start+f.blocks.at(-1)?.length!==f.length))throw Error('Incomplete packed resource manifest');
 new DecompressionStream('gzip');
 const transfer=createRangeReader([pack],{chunkSize:1048576,maxChunks:1,cache,fetcher:cacheOnly?()=>{transfer.close();const error=Error('Installed compressed resource is missing');error.name='PackedCacheIncomplete';throw error;}:fetcher,stallTimeoutMs});
 const decoded=new Map(),inflight=new Map();let memory=0,closed=false,queue=Promise.resolve();
 const stats=transfer.stats;Object.assign(stats,{packedResources:true,resourceVariant:light?'light':'original',decodedMemoryBytes:0,decodedMemoryLimitBytes:decodedMemoryBytes,decodedBlocks:0,decodedHits:0,decodeMs:0,maxDecodeMs:0,integrityRetries:0});
 const brotli=v2?createBrotliBlockDecoder(manifest.decoder,stats):undefined;
 const check=()=>{if(closed)throw Error('Packed resource reader closed');};
 const serial=task=>{const result=queue.then(task);queue=result.catch(()=>{});return result;};
 async function restore(block,transport=transfer,repair=true){
  let packed;
  for(let attempt=0;;attempt++){
   check();packed=await transport.read(pack.path,block.packedStart,block.packedLength);check();
   if(await hash(packed)===block.packedSHA256)break;
   if(!repair||attempt){if(repair)await transport.invalidate(pack.path,block.packedStart,block.packedStart+block.packedLength-1);const error=Error('Compressed original block checksum mismatch');error.name='PackedBlockChecksumMismatch';throw error;}
   stats.integrityRetries++;await transport.invalidate(pack.path,block.packedStart,block.packedStart+block.packedLength-1);
  }
  const began=performance.now();let bytes;
  if(v2&&block.codec==='brotli')bytes=await brotli.decode(packed,block.length);
  else{
  const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();bytes=new Uint8Array(block.length);
  let position=0;
  try{
   for(;;){const item=await stream.read();check();if(item.done)break;if(position+item.value.length>bytes.length)throw Error('Oversized decompressed original block');bytes.set(item.value,position);position+=item.value.length;}
  }catch(error){await stream.cancel().catch(()=>{});throw error;}finally{stream.releaseLock();}
  if(position!==bytes.length)throw Error('Truncated decompressed original block');
  }
  check();
  const original=simpleKinds.includes(block.kind)?filterOriginalBytes(bytes,block.kind,true):filterStructuredBytes(bytes,block.kind,block.spans,true);
  if(await hash(original)!==block.sha256)throw Error('Restored original block checksum mismatch');check();
  const elapsed=performance.now()-began;stats.decodeMs+=elapsed;stats.maxDecodeMs=Math.max(stats.maxDecodeMs,elapsed);stats.decodedBlocks++;
  if(decoded.has(block)){memory-=decoded.get(block).length;decoded.delete(block);}
  decoded.set(block,original);memory+=original.length;
  while(memory>decodedMemoryBytes){const oldest=decoded.keys().next().value;memory-=decoded.get(oldest).length;decoded.delete(oldest);}
  stats.decodedMemoryBytes=memory;return original;
 }
 function load(block){
  check();if(decoded.has(block)){const bytes=decoded.get(block);decoded.delete(block);decoded.set(block,bytes);stats.decodedHits++;return Promise.resolve(bytes);}
  if(inflight.has(block))return inflight.get(block);
  // Bound native decompression and inverse-filter working buffers to one block.
  const task=serial(()=>restore(block));inflight.set(block,task);
  task.finally(()=>inflight.delete(block)).catch(()=>{});return task;
 }
 return {stats,pack,
  async preload(plan,onProgress){
   check();if(plan!==null)throw Error('Packed installer supports opt-in complete preparation only');
   if(!cache||!await cache.ready())throw Error('Complete compressed installation needs persistent storage');
   let progress;
   const notify=phase=>onProgress?.({...progress,phase,byteDomain:'compressed',originalLogicalBytes:[...files.values()].reduce((sum,f)=>sum+f.length,0)});
   if(!await transfer.preload(null,value=>{progress=value;return notify('downloading');}))return false;
   if(!await cache.ready())throw Error('Complete compressed installation could not be saved');
   const verifier=()=>{
    const reader=createRangeReader([pack],{chunkSize:1048576,maxChunks:1,cache,fetcher:()=>{reader.close();const error=Error('Complete compressed installation is missing persisted bytes');error.name='PackedCacheIncomplete';throw error;}});
    return reader;
   };
   let verification=verifier(),repairs=0;progress={...progress,verifiedBlocks:0,totalBlocks:manifest.blocks.length,verificationRestarts:0};
   try{
    if(notify('verifying')===false)return false;
    for(let index=0;index<manifest.blocks.length;){
     const block=manifest.blocks[index];
     try{await serial(()=>restore(block,verification,false));}
     catch(error){
      if(error.name!=='PackedBlockChecksumMismatch')throw error;
      // Clear only overlapping physical pages and prefixes, then repair once.
      await transfer.invalidate(pack.path,block.packedStart,block.packedStart+block.packedLength-1);
      if(repairs)throw error;
      stats.integrityRetries++;repairs++;verification.close();
      try{await serial(()=>restore(block,transfer,false));}
      catch(failure){await transfer.invalidate(pack.path,block.packedStart,block.packedStart+block.packedLength-1);throw failure;}
      // Refilled physical pages can also contain previously verified blocks.
      // Require a complete verification pass with no cache modifications.
      verification=verifier();index=0;progress.verifiedBlocks=0;progress.verificationRestarts=repairs;
      if(notify('verifying')===false)return false;continue;
     }
     if(!await cache.ready())throw Error('Complete compressed installation could not be saved');
     index++;progress.verifiedBlocks=index;if(notify('verifying')===false)return false;
    }
    if(notify('ready')===false)return false;return true;
   }finally{verification.close();}
  },
  async read(path,offset,length){
   check();const file=files.get(path);
   if(!file||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0)throw Error('Invalid original packed read');
   // Match the existing reader: past EOF returns zero bytes, and requested
   // lengths are clipped to EOF rather than restricted by the decoded LRU.
   const size=Math.min(length,Math.max(0,file.length-offset)),result=new Uint8Array(size);let copied=0;
   while(copied<size){const position=offset+copied,block=file.blocks[Math.floor(position/manifest.pageBytes)],bytes=await load(block),count=Math.min(size-copied,block.length-(position-block.start));result.set(bytes.subarray(position-block.start,position-block.start+count),copied);copied+=count;}
   return result;
  },
  close(){closed=true;transfer.close();brotli?.close();decoded.clear();memory=0;stats.decodedMemoryBytes=0;}
 };
}
