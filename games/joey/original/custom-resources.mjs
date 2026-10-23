// A small immutable overlay extends the DAT directory and card tables. All other
// reads keep their original offsets and identities in the existing range cache.
import {createRangeReader} from './range-reader.mjs';
export function createCustomResourceReader(original,{manifest,descriptor,baseURL,cache,onProgress=()=>{},fetcher=fetch}={}){
 if(!descriptor)return {...original,get stats(){return original.stats;},manifest,prepare:async()=>{}};
 const d=descriptor,source=manifest.find(file=>file.path===d.path);
 const uint=value=>Number.isSafeInteger(value)&&value>=0;
 if(d.format!=='joey-custom-dat-v1'||d.rulesVersion!=='joey-five-collectible-cards-v2'||d.path!=='/data.dat'||!source||source.length!==d.sourceLength||source.sha256!==d.sourceSHA256||!uint(d.length)||d.length<=source.length||d.length>source.length+8388608||!d.blob||d.blob.url!=='custom-resources.bin'||!uint(d.blob.length)||d.blob.length<=0||d.blob.length>8388608||!/^[a-f0-9]{64}$/.test(d.blob.sha256)||!Array.isArray(d.spans)||d.spans.length!==3)throw Error('自创卡资源信息不匹配');
 let end=0;
 for(const span of d.spans){
  if(!Array.isArray(span)||span.length!==4||!uint(span[0])||!uint(span[1])||span[1]===0||!uint(span[3])||span[0]!==end||!['original','overlay'].includes(span[2])||span[3]+span[1]>(span[2]==='original'?source.length:d.blob.length))throw Error('自创卡资源范围不匹配');
  end+=span[1];
 }
 if(end!==d.length)throw Error('自创卡资源长度不匹配');
 const compressed=d.compressed;
 if(!compressed||compressed.url!=='custom-resource-bytes'||compressed.path!=='/__joey_custom_resources_v1'||!uint(compressed.length)||compressed.length<1||compressed.length>8388608||!/^[a-f0-9]{64}$/.test(compressed.sha256))throw Error('自创卡压缩资源信息不匹配');
 const useGzip=typeof DecompressionStream==='function';
 const file=useGzip?{...compressed,url:new URL(compressed.url,baseURL).href}:{...d.blob,path:'/__joey_custom_resources_raw_v1',url:new URL('custom-resource-raw-bytes',baseURL).href};
 const download=createRangeReader([file],{cache,fetcher,maxChunks:8});let bytes,preparing,closed=false;
 const check=()=>{if(closed)throw Error('Custom resource reader closed');};
 const prepare=()=>preparing||=(async()=>{
  check();let stream;
  try{
   await download.preload(null,progress=>{onProgress({...progress,stats:download.stats});return !closed;});check();
   const packed=new Uint8Array(file.length);
   for(let offset=0;offset<file.length;offset+=1048576)packed.set(await download.read(file.path,offset,Math.min(1048576,file.length-offset)),offset);
   const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
   if(await hash(packed)!==file.sha256){await cache?.discard(file);throw Error('自创卡资源下载校验失败');}
   const input=new Blob([packed]).stream();stream=(useGzip?input.pipeThrough(new DecompressionStream('gzip')):input).getReader();const parts=[];let count=0;
   for(;;){const {value,done}=await stream.read();check();if(done)break;count+=value.length;if(count>d.blob.length)throw Error('自创卡资源超出预期长度');parts.push(value);}
   if(count!==d.blob.length)throw Error('自创卡资源下载不完整');
   const output=new Uint8Array(count);let offset=0;for(const part of parts){output.set(part,offset);offset+=part.length;}
   const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',output)),x=>x.toString(16).padStart(2,'0')).join('');
   check();if(sha!==d.blob.sha256)throw Error('自创卡资源校验失败');bytes=output;
  }finally{stream?.cancel().catch(()=>{});stream?.releaseLock();}
 })();
 return {
  manifest:manifest.map(file=>file.path===d.path?{...file,length:d.length}:file),
  get stats(){return original.stats;},prepare,
  preload:(...args)=>original.preload(...args),
  async read(path,offset,length){
   check();if(path!==d.path)return original.read(path,offset,length);
   if(!uint(offset)||!uint(length))throw Error('Invalid custom resource read');
   const size=Math.min(length,Math.max(0,d.length-offset));if(!size)return new Uint8Array();
   if(size>8388608)throw Error('Custom resource read exceeds memory limit');
   await prepare();check();const result=new Uint8Array(size);
   let written=0;
   for(const [start,spanLength,kind,sourceOffset] of d.spans){
    const left=Math.max(offset,start),right=Math.min(offset+size,start+spanLength);if(left>=right)continue;
    const count=right-left,position=sourceOffset+left-start;
    const part=kind==='overlay'?bytes.subarray(position,position+count):await original.read(path,position,count);
    check();if(part.length!==count)throw Error('Incomplete original archive span');result.set(part,left-offset);written+=count;
   }
   if(written!==size)throw Error('Incomplete custom archive span');return result;
  },
  close(){if(closed)return;closed=true;download.close();bytes=undefined;original.close();}
 };
}
