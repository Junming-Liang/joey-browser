// Immutable original bytes only. One producer (the page), multiple game Workers.
// A bounded shared cache removes a page RPC for already validated asset bytes.
const pageBytes=65536,slots=64,headerWords=8,slotWords=3;
const metadataBytes=(headerWords+slots*slotWords)*4;
const immutablePaths=new Set(['/data.dat','/Voice.dat','/Region.dat']);
export function createWorkerReadCache(manifest,buffer=new SharedArrayBuffer(metadataBytes+slots*pageBytes)){
  if(!(buffer instanceof SharedArrayBuffer)||buffer.byteLength!==metadataBytes+slots*pageBytes)throw Error('Invalid shared original read cache');
  const files=new Map();
  for(const [index,file] of manifest.entries()){
    if(!immutablePaths.has(file.path)||files.has(file.path)||!Number.isSafeInteger(file.length)||file.length<0||file.length>0x7fffffff||!/^[a-f0-9]{64}$/.test(file.sha256||''))throw Error('Invalid shared original archive');
    files.set(file.path,{id:index+1,length:file.length});
  }
  const words=new Int32Array(buffer,0,metadataBytes/4),bytes=new Uint8Array(buffer,metadataBytes);
  const lock=()=>Atomics.compareExchange(words,0,0,1)===0;
  const unlock=()=>Atomics.store(words,0,0);
  const find=(id,position)=>{
    for(let slot=0;slot<slots;slot++){
      const at=headerWords+slot*slotWords,start=words[at+1],length=words[at+2];
      if(words[at]===id&&start<=position&&position<start+length)return {slot,start,length};
    }
    return null;
  };
  return {
    buffer,
    put(path,start,source){
      const file=files.get(path);
      if(!file||!(source instanceof Uint8Array)||!Number.isSafeInteger(start)||start<0||source.length>slots*pageBytes||start+source.length>file.length||!lock())return false;
      try{
        for(let copied=0;copied<source.length;){
          const position=start+copied,length=Math.min(source.length-copied,pageBytes-position%pageBytes);
          const existing=find(file.id,position);
          if(!existing||position+length>existing.start+existing.length){
            const slot=words[1],at=headerWords+slot*slotWords;
            bytes.set(source.subarray(copied,copied+length),slot*pageBytes);
            words[at]=file.id;words[at+1]=position;words[at+2]=length;
            words[1]=(slot+1)%slots;
          }
          copied+=length;
        }
        return true;
      }finally{unlock();}
    },
    readInto(path,offset,length,destination){
      const file=files.get(path);
      if(!file||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||!(destination instanceof Uint8Array))return null;
      const size=Math.min(length,Math.max(0,file.length-offset));
      if(destination.length<size)return null;
      if(!size)return 0;
      if(size>slots*pageBytes||!lock()){Atomics.add(words,5,1);return null;}
      try{
        // Resolve the entire span before writing. A miss never changes guest data.
        const spans=[];
        for(let copied=0;copied<size;){
          const item=find(file.id,offset+copied);
          if(!item){Atomics.add(words,5,1);return null;}
          const length=Math.min(size-copied,item.start+item.length-offset-copied);
          spans.push({...item,length,copied});copied+=length;
        }
        for(const item of spans){
          const start=item.slot*pageBytes+offset+item.copied-item.start;
          destination.set(bytes.subarray(start,start+item.length),item.copied);
        }
        Atomics.add(words,2,1);
        const sum=(words[3]>>>0)+size;words[3]=sum>>>0;if(sum>0xffffffff)words[4]++;
        return size;
      }finally{unlock();}
    },
    stats(){return {capacityBytes:slots*pageBytes,sharedBufferBytes:buffer.byteLength,hits:Atomics.load(words,2)>>>0,
      hitBytes:(Atomics.load(words,4)>>>0)*4294967296+(Atomics.load(words,3)>>>0),misses:Atomics.load(words,5)>>>0,
      scope:'Worker reads of already validated immutable bytes; separate from page-host resourceStats'};}
  };
}
