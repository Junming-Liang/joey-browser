// Only immutable game resources live here. Player files use a separate database.
const pageBytes=1048576;
const hex=bytes=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
const digest=bytes=>crypto.subtle.digest('SHA-256',bytes).then(hex);
export function createOriginalResourceCache(report,{databaseName='joey-original-resource-bytes-v1',maxBytes=536870912,maxEntries=4096}={}){
  report.available=false;report.capacityBytes=maxBytes;
  let disabled=false;
  // Four validated archive pages, bounded independently of the asset reader.
  const pages=new Map();let pageMemory=0;
  const disable=error=>{disabled=true;report.available=false;report.reason=String(error?.name||error).slice(0,200);};
  const opened=new Promise(resolve=>{
    try{
      const request=indexedDB.open(databaseName,1);
      request.onupgradeneeded=()=>{request.result.createObjectStore('blocks',{keyPath:'key'});request.result.createObjectStore('metadata',{keyPath:'key'});};
      request.onerror=()=>{disable(request.error);resolve(null);};
      request.onblocked=()=>{disable('Resource cache upgrade blocked');resolve(null);};
      request.onsuccess=()=>{if(disabled){request.result.close();resolve(null);return;}const database=request.result;database.onversionchange=()=>{disable('Resource cache version changed');database.close();};report.available=true;resolve(database);};
    }catch(error){disable(error);resolve(null);}
  });
  const key=(file,start,end)=>/^[a-f0-9]{64}$/.test(file.sha256||'')?file.sha256+':'+file.path+':'+start+':'+end:null;
  const transaction=(database,stores,operation)=>new Promise((resolve,reject)=>{
    const tx=database.transaction(stores,'readwrite');
    try{operation(tx);}catch(error){tx.abort();reject(error);return;}
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('Resource cache transaction aborted'));tx.onerror=()=>reject(tx.error);
  });
  const remove=async(database,key)=>transaction(database,['blocks','metadata'],tx=>{tx.objectStore('blocks').delete(key);tx.objectStore('metadata').delete(key);});
  const item=async(database,cacheKey)=>new Promise((resolve,reject)=>{const request=database.transaction('blocks','readonly').objectStore('blocks').get(cacheKey);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const write=async(file,start,end,bytes,partial)=>{
    const baseKey=key(file,start,end),cacheKey=baseKey+(partial?':partial':'');
    if(!baseKey||disabled||!(bytes instanceof Uint8Array)||bytes.length>maxBytes||!bytes.length||bytes.length>(end-start+1)||(partial?bytes.length===end-start+1:bytes.length!==end-start+1))return;
    try{
      const database=await opened;if(!database||disabled)return;
      const sha256=await digest(bytes);
      await transaction(database,['blocks','metadata'],tx=>{
        const metadata=tx.objectStore('metadata'),blocks=tx.objectStore('blocks'),request=metadata.getAll();
        request.onsuccess=()=>{
          const prior=request.result.filter(item=>item.key!==cacheKey&&(partial||item.key!==baseKey+':partial')).sort((a,b)=>a.createdAt-b.createdAt);
          let size=prior.reduce((sum,item)=>sum+item.length,0),count=prior.length;
          for(const item of prior){if(size+bytes.length<=maxBytes&&count<maxEntries)break;metadata.delete(item.key);blocks.delete(item.key);size-=item.length;count--;report.evictions=(report.evictions||0)+1;report.evictedBytes=(report.evictedBytes||0)+item.length;}
          if(!partial){metadata.delete(baseKey+':partial');blocks.delete(baseKey+':partial');}
          metadata.put({key:cacheKey,length:bytes.length,createdAt:Date.now()});blocks.put({key:cacheKey,bytes,sha256});
          report.storedBytes=size+bytes.length;report.entries=count+1;
        };
      });
    }catch(error){disable(error);}
  };
  const block=async(database,file,start,end)=>{
    const cacheKey=key(file,start,end);if(!cacheKey)return null;
    if(pages.has(cacheKey)){const bytes=pages.get(cacheKey);pages.delete(cacheKey);pages.set(cacheKey,bytes);return bytes;}
    const item=await new Promise((resolve,reject)=>{const request=database.transaction('blocks','readonly').objectStore('blocks').get(cacheKey);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    if(!item)return null;
    if(!(item.bytes instanceof Uint8Array)||item.bytes.length!==end-start+1||await digest(item.bytes)!==item.sha256){await remove(database,cacheKey);report.discarded=(report.discarded||0)+1;return null;}
    if(start%pageBytes===0&&end===Math.min(file.length,start+pageBytes)-1){
      if(pages.has(cacheKey))pageMemory-=pages.get(cacheKey).length;
      pages.set(cacheKey,item.bytes);pageMemory+=item.bytes.length;
      while(pageMemory>4*pageBytes){const oldest=pages.keys().next().value;pageMemory-=pages.get(oldest).length;pages.delete(oldest);}
      report.pageMemoryBytes=pageMemory;
    }
    return item.bytes;
  };
  return {
    async ready(){const database=await opened;return Boolean(database&&!disabled);},
    async readPartial(file,start,end){
      const baseKey=key(file,start,end);if(!baseKey||disabled)return null;
      try{
        const database=await opened;if(!database||disabled)return null;
        const cacheKey=baseKey+':partial',saved=await item(database,cacheKey);if(!saved)return null;
        if(!(saved.bytes instanceof Uint8Array)||!saved.bytes.length||saved.bytes.length>=end-start+1||await digest(saved.bytes)!==saved.sha256){await remove(database,cacheKey);report.discarded=(report.discarded||0)+1;return null;}
        return saved.bytes;
      }catch(error){disable(error);return null;}
    },
    savePartial(file,start,end,bytes){return write(file,start,end,bytes,true);},
    async discard(file){
      if(disabled||!key(file,0,0))return;
      const database=await opened;if(!database)return;
      const prefix=file.sha256+':'+file.path+':';
      await transaction(database,['blocks','metadata'],tx=>{
        const metadata=tx.objectStore('metadata'),blocks=tx.objectStore('blocks'),request=metadata.getAll();
        request.onsuccess=()=>{for(const item of request.result)if(item.key.startsWith(prefix)){metadata.delete(item.key);blocks.delete(item.key);}};
      });
      for(const cacheKey of pages.keys())if(cacheKey.startsWith(prefix)){pageMemory-=pages.get(cacheKey).length;pages.delete(cacheKey);}
      report.pageMemoryBytes=pageMemory;
    },
    async read(file,start,end){
      const cacheKey=key(file,start,end);if(!cacheKey||disabled)return null;
      try{
        const database=await opened;if(!database||disabled)return null;
        const exact=await block(database,file,start,end);if(exact)return exact;
        const result=new Uint8Array(end-start+1);
        for(let position=start;position<=end;){
          const first=Math.floor(position/pageBytes)*pageBytes,last=Math.min(file.length,first+pageBytes)-1;
          const bytes=await block(database,file,first,last);if(!bytes)return null;
          const count=Math.min(end-position+1,last-position+1);
          result.set(bytes.subarray(position-first,position-first+count),position-start);position+=count;
        }
        return result;
      }catch(error){disable(error);return null;}
    },
    save(file,start,end,bytes){return write(file,start,end,bytes,false);},
    async close(){const database=await opened;disabled=true;pages.clear();pageMemory=0;report.pageMemoryBytes=0;database?.close();}
  };
}
