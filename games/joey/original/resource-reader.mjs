// Ordinary play keeps the existing small-range protocol. A fully verified pack
// is an optional local source; it never causes a cold large-page game download.
import {createRangeReader} from './range-reader.mjs';
import {createPackedResourceReader} from './packed-resource-reader.mjs';
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
export function createOriginalResourceReader(manifest,{cache,layouts,packedResources,legacyPackedResources=[],fetcher=fetch}={}){
 const original=createRangeReader(manifest,{cache,layouts,fetcher});
 let packed,packedManifest,selected=original,closed=false;const indexRequests=new Set();
 const check=()=>{if(closed)throw Error('Original resource reader closed');};
 const loadManifest=async descriptor=>{
  check();const controller=new AbortController();indexRequests.add(controller);let timer,stream;
  const interrupted=new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason||Error('Compressed resource index aborted')),{once:true}));
  const wait=task=>Promise.race([task,interrupted]);
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(Error('Compressed resource index download made no progress')),3000);};
  try{
  arm();const response=await wait(fetcher(descriptor.manifestURL,{cache:'no-cache',signal:controller.signal}));
  if(!response.ok||!response.body)throw Error('Compressed resource index unavailable');
  stream=response.body.getReader();const chunks=[];let length=0;
  for(;;){arm();const {done,value}=await wait(stream.read());if(done)break;length+=value.length;if(length>1048576)throw Error('Compressed resource index too large');chunks.push(value);}
  clearTimeout(timer);check();const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(bytes.length>1048576||await hash(bytes)!==descriptor.manifestSHA256)throw Error('Compressed resource index checksum mismatch');
  const value=JSON.parse(new TextDecoder().decode(bytes)),expected=descriptor.pack;
  if(!value.pack||['path','url','length','sha256'].some(key=>value.pack[key]!==expected[key]))throw Error('Compressed resource index identity mismatch');
  return value;
  }finally{clearTimeout(timer);indexRequests.delete(controller);stream?.cancel().catch(()=>{});stream?.releaseLock();controller.abort();}
 };
 const usePacked=()=>{packed=createPackedResourceReader(packedManifest,{originalManifest:manifest,cache,cacheOnly:true});selected=packed;packed.stats.resourceMode='compressed-complete';};
 return {
  get stats(){return selected.stats;},
  async preload(plan,onProgress){
   check();
   if(!Array.isArray(legacyPackedResources)||legacyPackedResources.length>2)throw Error('Invalid previous packed resources');
   for(const descriptor of [packedResources,...legacyPackedResources].filter(Boolean))if(await cache.hasComplete([descriptor.pack],descriptor.manifestSHA256)){
    try{packedManifest=await loadManifest(descriptor);check();usePacked();onProgress({completed:packed.pack.length,total:packed.pack.length,restoredBytes:packed.pack.length,phase:'ready',byteDomain:'compressed',source:descriptor===packedResources?'installed-pack':'installed-legacy-pack'});return true;}
    catch(error){check();original.stats.packedFallback=String(error);}
   }
   if(await cache.hasComplete(manifest)){
    original.stats.resourceMode='original-complete';const total=manifest.reduce((sum,file)=>sum+file.length,0);
    onProgress({completed:total,total,restoredBytes:total,source:'installed-original',byteDomain:'original'});return true;
   }
   if(plan===null&&packedResources){
    // Continue an interrupted previous installation rather than throwing away
    // its compressed prefixes when the codec changes. Fresh installs use v2.
    let descriptor=packedResources;
    if(cache.storedBytes&&!await cache.storedBytes(descriptor.pack))for(const legacy of legacyPackedResources)if(await cache.storedBytes(legacy.pack)){descriptor=legacy;break;}
    packedManifest=await loadManifest(descriptor);check();
    const installer=createPackedResourceReader(packedManifest,{originalManifest:manifest,cache,fetcher});selected=installer;
    let complete;
    try{complete=await installer.preload(null,onProgress);check();if(complete)complete=await cache.markComplete(installer.pack,descriptor.manifestSHA256);}
    finally{installer.close();selected=original;}
    if(!complete)return false;
    // Preserve existing validated raw bytes. The cache's existing capacity
    // eviction remains the only storage policy; never purge on codec upgrade.
    usePacked();return true;
   }
   original.stats.resourceMode='on-demand';return original.preload(plan,onProgress);
  },
  async read(path,offset,length){
   check();if(selected===original)return original.read(path,offset,length);
   try{return await packed.read(path,offset,length);}
   catch(error){check();packed.close();selected=original;original.stats.resourceMode='on-demand';original.stats.packedFallback=String(error);return original.read(path,offset,length);}
  },
  close(){closed=true;for(const controller of indexRequests)controller.abort();packed?.close();selected.close();original.close();}
 };
}
