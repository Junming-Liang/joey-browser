// One outstanding block: the owning packed reader already serializes restores.
export function createBrotliBlockDecoder(descriptor,stats){
 let worker,pending,next=0,closed=false;
 const terminate=error=>{
  worker?.terminate();worker=undefined;
  if(pending){clearTimeout(pending.timer);const reject=pending.reject;pending=undefined;reject(error);}
 };
 return{
  decode(bytes,length){
   if(closed)return Promise.reject(Error('Packed decoder closed'));
   if(pending)return Promise.reject(Error('Concurrent packed decoder request'));
   if(!worker){
    const created=new Worker(new URL('./brotli-decoder-worker.mjs',import.meta.url),{type:'module'});worker=created;
    worker.onerror=event=>{event.preventDefault();if(worker===created)terminate(Error('Integer decoder Worker failed'));};
    worker.onmessage=({data})=>{
     if(worker!==created)return;
     if(!pending||data.id!==pending.id)return;
     if(data.error){terminate(Error(data.error));return;}
     if(!(data.bytes instanceof Uint8Array)||data.bytes.length!==pending.length||!Number.isSafeInteger(data.memoryBytes)||data.memoryBytes<0||data.memoryBytes>33554432){terminate(Error('Invalid integer decoder result'));return;}
     stats.decoderMemoryBytes=data.memoryBytes;stats.maxDecoderMemoryBytes=Math.max(stats.maxDecoderMemoryBytes||0,data.memoryBytes);
     clearTimeout(pending.timer);const resolve=pending.resolve;pending=undefined;resolve(data.bytes);
    };
   }
   return new Promise((resolve,reject)=>{
    const id=++next;pending={id,length,resolve,reject,timer:setTimeout(()=>terminate(Error('Integer decoder timed out')),10000)};
    // Transfer an owned copy; the validated transport/cache bytes remain intact.
    try{const owned=bytes.slice();worker.postMessage({id,bytes:owned,length,descriptor},[owned.buffer]);}catch(error){terminate(error);}
   });
  },
  close(){closed=true;terminate(Error('Packed decoder closed'));}
 };
}
