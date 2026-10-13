// Optional lossless byte predictors for compression experiments only.
// The inverse reconstructs original archive bytes, including headers/padding.
// Every independently decoded block carries its own initial predictor values.
export function filterOriginalBytes(bytes,kind,inverse=false){
 if(!(bytes instanceof Uint8Array))throw Error('Original byte filter needs bytes');
 if(kind==='delta-pcm16-plane'){
  const half=Math.ceil(bytes.length/2),shuffled=new Uint8Array(bytes.length);
  if(inverse){for(let i=0;i<bytes.length;i++)shuffled[i]=bytes[(i>>>1)+(i%2?half:0)];return filterOriginalBytes(shuffled,'delta-pcm16',true);}
  const delta=filterOriginalBytes(bytes,'delta-pcm16');
  for(let i=0;i<bytes.length;i++)shuffled[(i>>>1)+(i%2?half:0)]=delta[i];return shuffled;
 }
 const result=Uint8Array.from(bytes);
 if(kind==='none')return result;
 if(kind==='delta-rgb'){
  for(let i=3;i<bytes.length;i++)result[i]=inverse?bytes[i]+result[i-3]:bytes[i]-bytes[i-3];
 }else if(kind==='delta-pcm16'){
  const source=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),target=new DataView(result.buffer,result.byteOffset,result.byteLength);
  for(let i=4;i+1<bytes.length;i+=2)target.setUint16(i,inverse?source.getUint16(i,true)+target.getUint16(i-4,true):source.getUint16(i,true)-source.getUint16(i-4,true),true);
 }else throw Error('Unknown original byte filter');
 return result;
}
