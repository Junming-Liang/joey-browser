// Each original Win32 background thread uses the same module and memory.
import init,* as exe from './joey_original.js';
import {isPlayerFile} from './player-files.mjs';
import {createOriginalResourceCache} from './resource-cache.mjs';
import {createRangeReader} from './range-reader.mjs';
const browserError=console.error.bind(console);
console.error=(...args)=>{self.postMessage({diagnostic:args.map(String).join(' ').slice(0,12000)});browserError(...args);};
self.send_to_host=(func,args,retAddr)=>self.postMessage({func,args,retAddr});
async function programResponse(program){
 if(program?.compressedURL&&typeof DecompressionStream==='function')return resumableProgramResponse(program);
 const response=await fetch(new URL('./joey_original_bg.wasm',import.meta.url));
 if(!response.ok||!response.body)throw Error('原版程序下载失败：HTTP '+response.status);
 const reader=response.body.getReader(),total=program?.length;let received=0,lastUpdate=0;
 self.postMessage({stage:'downloading-program'});
 const body=new ReadableStream({async pull(controller){
  try{
   const {done,value}=await reader.read();
   if(done){
    if(Number.isSafeInteger(total)&&received!==total)throw Error('原版程序下载不完整');
    self.postMessage({programProgress:{received,total}});self.postMessage({stage:'compiling-program'});controller.close();return;
   }
   received+=value.byteLength;
   if(performance.now()-lastUpdate>=100){self.postMessage({programProgress:{received,total}});lastUpdate=performance.now();}
   controller.enqueue(value);
  }catch(error){controller.error(error);}
 },cancel(reason){return reader.cancel(reason);}});
 // Fetch's body is already decompressed. Preserve streaming compilation, and
 // count those bytes against the server's uncompressed program size.
 return new Response(body,{headers:{'Content-Type':'application/wasm'}});
}
async function resumableProgramResponse(program){
 if(!Number.isSafeInteger(program.compressedBytes)||program.compressedBytes<=0||program.compressedBytes>33554432||!Number.isSafeInteger(program.length)||program.length<=0||!/^[a-f0-9]{64}$/.test(program.compressedSHA256||''))throw Error('原版程序信息不完整');
 const report={},file={path:'/joey_original_bg.wasm.gz',url:new URL(program.compressedURL,import.meta.url).href,length:program.compressedBytes,sha256:program.compressedSHA256};
 const cache=createOriginalResourceCache(report,{databaseName:'joey-original-program-bytes-v1',maxBytes:33554432,maxEntries:256});
 const reader=createRangeReader([file],{cache,maxChunks:8});
 self.postMessage({stage:'downloading-program'});
 try{
  let preparation;
  await reader.preload(null,progress=>{preparation=progress;self.postMessage({programDownload:{...progress,cache:{...report},stats:{...reader.stats}}});});
  const compressed=new Uint8Array(file.length);
  for(let start=0;start<file.length;start+=1048576)compressed.set(await reader.read(file.path,start,Math.min(1048576,file.length-start)),start);
  const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',compressed)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(actual!==file.sha256){await cache.discard(file);throw Error('原版程序校验失败，已移除损坏的程序缓存，请重新打开页面');}
  self.postMessage({programDownload:{...preparation,cache:{...report},stats:{...reader.stats}}});
  let offset=0,received=0,lastUpdate=0;
  const packed=new ReadableStream({pull(controller){if(offset===compressed.length){controller.close();return;}const end=Math.min(compressed.length,offset+262144);controller.enqueue(compressed.subarray(offset,end));offset=end;}});
  const decoded=packed.pipeThrough(new DecompressionStream('gzip')).getReader();
  self.postMessage({stage:'compiling-program'});
  const body=new ReadableStream({async pull(controller){try{
   const {done,value}=await decoded.read();
   if(done){if(received!==program.length)throw Error('原版程序解压不完整');self.postMessage({programProgress:{received,total:program.length}});controller.close();return;}
   received+=value.byteLength;if(received>program.length)throw Error('原版程序长度不匹配');
   if(performance.now()-lastUpdate>=100){self.postMessage({programProgress:{received,total:program.length}});lastUpdate=performance.now();}controller.enqueue(value);
  }catch(error){controller.error(error);}},cancel(reason){return decoded.cancel(reason);}});
  return new Response(body,{headers:{'Content-Type':'application/wasm'}});
 }finally{reader.close();await cache.close();}
}
self.onmessage=async({data:{memory,task,module,manifest=[],program,initialFiles=[],traceSpec=''}})=>{
 try {
  const exports=await init({module_or_path:module||await programResponse(program),memory,thread_stack_size:1048576});
  if(task){
   self.postMessage({threadStage:'ready',task});exe.run_thread_task(task);
   exports.__wbindgen_thread_destroy();self.postMessage({threadStage:'finished',task});self.close();return;
  }
  for(const file of manifest)exe.mount_external_file(file.path,file.length);
  for(const file of initialFiles){
   if(!isPlayerFile(file.path)||!(file.bytes instanceof Uint8Array)||file.bytes.length>262144)throw Error('Invalid initial player file');
   exe.mount_file(file.path,file.bytes);
  }
  exe.set_trace(traceSpec);self.postMessage({stage:'instantiated'});exe.main();self.postMessage({stage:'returned'});
 }catch(error){self.postMessage({stage:'failed',task:task||null,error:String(error),errorName:error.name,stack:error.stack});}
};
