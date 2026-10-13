// Integer decoding is isolated from painting/audio and killed on reader close.
import init,{DecompressStream,BrotliStreamResultCode} from './brotli-decoder.mjs';
let instance,identity;
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
async function initialize(descriptor){
 if(!descriptor||descriptor.url!=='/joey/original/brotli-decoder.wasm'||!Number.isSafeInteger(descriptor.length)||descriptor.length<1||descriptor.length>1048576||!/^[a-f0-9]{64}$/.test(descriptor.sha256))throw Error('Invalid integer decoder identity');
 if(instance){if(identity!==descriptor.sha256)throw Error('Decoder identity changed');return;}
 const response=await fetch(descriptor.url,{cache:'no-cache'});
 if(!response.ok||!response.body)throw Error('Integer decoder unavailable');
 const bytes=new Uint8Array(descriptor.length),reader=response.body.getReader();let position=0;
 try{
  for(;;){const {value,done}=await reader.read();if(done)break;if(position+value.length>bytes.length)throw Error('Oversized integer decoder');bytes.set(value,position);position+=value.length;}
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(position!==descriptor.length||await hash(bytes)!==descriptor.sha256)throw Error('Integer decoder checksum mismatch');
 instance=await init({module_or_path:bytes});identity=descriptor.sha256;
 if(instance.memory.buffer.byteLength>33554432)throw Error('Decoder memory limit exceeded');
}
self.onmessage=async({data:{id,bytes,length,descriptor}})=>{
 try{
  if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>1049600||!Number.isSafeInteger(length)||length<1||length>1048576)throw Error('Invalid compressed block');
  await initialize(descriptor);
  const stream=new DecompressStream(),output=new Uint8Array(length);let input=0,position=0;
  try{
   for(;;){
    const result=stream.decompress(bytes.subarray(input),Math.min(65536,length-position+1));
    let code,consumed,chunk;
    try{code=result.code;consumed=result.input_offset;chunk=result.buf;}finally{result.free();}
    if(consumed>bytes.length-input||position+chunk.length>length)throw Error('Oversized Brotli output');
    input+=consumed;output.set(chunk,position);position+=chunk.length;
    if(instance.memory.buffer.byteLength>33554432)throw Error('Decoder memory limit exceeded');
    if(code===BrotliStreamResultCode.ResultSuccess){if(input!==bytes.length||position!==length)throw Error('Brotli input/output length mismatch');break;}
    if(code===BrotliStreamResultCode.NeedsMoreInput||(!consumed&&!chunk.length))throw Error('Truncated Brotli input');
    if(code!==BrotliStreamResultCode.NeedsMoreOutput)throw Error('Invalid Brotli decoder state');
   }
  }finally{stream.free();}
  self.postMessage({id,bytes:output,memoryBytes:instance.memory.buffer.byteLength},[output.buffer]);
 }catch(error){self.postMessage({id,error:String(error)});}
};
