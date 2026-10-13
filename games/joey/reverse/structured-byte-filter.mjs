// Experimental, independently reversible blocks. No image/audio transcoding:
// headers, padding, page boundaries and all original bytes are retained.
const paeth=(a,b,c)=>{
 const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);
 return da<=db&&da<=dc?a:db<=dc?b:c;
};
export function filterStructuredBytes(bytes,kind,spans=[],inverse=false){
 if(!(bytes instanceof Uint8Array))throw Error('Structured filter needs bytes');
 if(kind.startsWith('pcm')){
  const stride=kind.includes('mono')?2:4,second=kind.includes('second'),half=Math.ceil(bytes.length/2);
  let input=bytes;
  if(inverse){input=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)input[i]=bytes[(i>>>1)+(i%2?half:0)];}
  const result=Uint8Array.from(input),source=new DataView(input.buffer,input.byteOffset,input.byteLength),target=new DataView(result.buffer);
  for(let i=second?2*stride:stride;i+1<input.length;i+=2){
   const prior=inverse?target:source,prediction=second?2*prior.getUint16(i-stride,true)-prior.getUint16(i-2*stride,true):prior.getUint16(i-stride,true);
   target.setUint16(i,source.getUint16(i,true)+(inverse?prediction:-prediction),true);
  }
  if(inverse)return result;
  const shuffled=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)shuffled[(i>>>1)+(i%2?half:0)]=result[i];return shuffled;
 }
 if(!['bmp-up','bmp-paeth','bmp-paeth-green'].includes(kind))throw Error('Unknown structured filter');
 let previous=0;
 for(const [start,end,stride,rowBytes,bpp,rowOffset]of spans){
  if(![start,end,stride,rowBytes,bpp,rowOffset].every(Number.isSafeInteger)||start<previous||end>bytes.length||start>=end||rowBytes<1||rowBytes>stride||![1,3].includes(bpp)||rowOffset<0||rowOffset>=stride)throw Error('Invalid bitmap span');
  previous=end;
 }
 const green=(target,source,undo)=>{
  for(const [start,end,stride,rowBytes,bpp,rowOffset]of spans){
   if(bpp!==3)continue;
   for(let i=start;i+2<end;i++){
    const col=(i-start+rowOffset)%stride;if(col>=rowBytes||col%3||col+3>rowBytes)continue;
    const g=source[i+1];target[i]=source[i]+(undo?g:-g);target[i+2]=source[i+2]+(undo?g:-g);i+=2;
   }
  }
 };
 let input=bytes;
 if(kind==='bmp-paeth-green'&&!inverse){input=Uint8Array.from(bytes);green(input,bytes,false);}
 const result=Uint8Array.from(input);
 for(const [start,end,stride,rowBytes,bpp,rowOffset]of spans){
  const original=inverse?result:input;
  for(let i=start;i<end;i++){
   const col=(i-start+rowOffset)%stride;if(col>=rowBytes)continue;
   const a=col>=bpp&&i-bpp>=start?original[i-bpp]:0,b=i-stride>=start?original[i-stride]:0,c=col>=bpp&&i-stride-bpp>=start?original[i-stride-bpp]:0;
   const prediction=kind==='bmp-up'?b:paeth(a,b,c);result[i]=input[i]+(inverse?prediction:-prediction);
  }
 }
 if(kind==='bmp-paeth-green'&&inverse){const restored=Uint8Array.from(result);green(restored,result,true);return restored;}
 return result;
}
