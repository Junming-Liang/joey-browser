// The original 8-bit symbols are stored as 9-bit modular powers (00439c00).
// Checksums and layout were verified against the pinned original executable.
export const systemPath='/Yu-Gi-Oh! Power of Chaos Common/system.dat';
export const keyPath='/joey-profile-key.bin';
export const deckLibraryPath='/joey-deck-library-v1.bin';
const seeds=[0x7d,0x13,0x8a,0xbb],playerBytes=4488;
function power(value,exponent){let result=1;while(exponent){if(exponent&1)result=result*value%299;value=value*value%299;exponent>>=1;}return result;}
const encodeTable=Uint16Array.from({length:256},(_,i)=>power(i,5));
const decodeTable=Uint16Array.from({length:512},(_,i)=>power(i,53));
function checksum(bytes,length){return seeds.map((seed,index)=>{let sum=seed;for(let i=4+index;i<length;i+=4)sum+=bytes[i];return -sum&255;});}
export function decodeOriginal(bytes,length){
 if(!(bytes instanceof Uint8Array)||bytes.length!==4+Math.ceil(length/8)*9||checksum(bytes,length).some((value,i)=>bytes[i]!==value))throw Error('原版存档校验失败，已保留原文件');
 const decoded=new Uint8Array(length);
 for(let i=0;i<length;i++){const position=4+Math.floor(i/8)*9+i%8,symbol=(bytes[position]|bytes[position+1]<<8)>>(i%8)&511;if(symbol>=299||decodeTable[symbol]>255)throw Error('原版存档编码无效，已保留原文件');decoded[i]=decodeTable[symbol];}
 return decoded;
}
export function encodeOriginal(bytes){
 const encoded=new Uint8Array(4+Math.ceil(bytes.length/8)*9);
 for(let i=0;i<bytes.length;i++){const position=4+Math.floor(i/8)*9+i%8,symbol=encodeTable[bytes[i]]<<(i%8);encoded[position]|=symbol&255;encoded[position+1]|=symbol>>8;}
 encoded.set(checksum(encoded,bytes.length));return encoded;
}
export function decodeCollection(bytes){
 const decoded=decodeOriginal(bytes,playerBytes+8),view=new DataView(decoded.buffer),offset=8;
 if(view.getUint16(offset+0x1182,true)!==0xfba5)throw Error('不支持此存档格式，已保留原文件');
 let sum=0;for(let i=0;i<0x1186;i+=2)sum+=view.getUint16(offset+i,true);
 if((sum&65535)!==0)throw Error('卡片收藏校验失败，已保留原文件');
 return decoded;
}
export function collectionInfo(files){
 const system=files.find(file=>file.path===systemPath);if(!system)return null;
 const decoded=decodeCollection(system.bytes);let kinds=0,copies=0;
 for(let i=0;i<2048;i++){const count=decoded[20+i*2];if(count)kinds++;copies+=count;}
 return {kinds,copies};
}
export function withProfileKey(files){
 const system=files.find(file=>file.path===systemPath);if(!system)return files;
 return [...files.filter(file=>file.path!==keyPath),{path:keyPath,bytes:encodeOriginal(decodeCollection(system.bytes).subarray(0,8))}];
}
export function assertOnlineDeck(files){
 const bytes=files.find(file=>file.path==='/deck.ydc')?.bytes;
 if(!bytes)return; // A fresh profile uses the original starter deck.
 if(!(bytes instanceof Uint8Array)||bytes.length<14)throw Error('当前卡组文件无效，请选择一套预设卡组后重试');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8;
 for(let group=0;group<3;group++){
  if(offset+2>bytes.length)throw Error('当前卡组文件不完整，请选择一套预设卡组后重试');
  const count=view.getUint16(offset,true);offset+=2;
  if(offset+count*2>bytes.length)throw Error('当前卡组文件不完整，请选择一套预设卡组后重试');
  for(let i=0;i<count;i++,offset+=2){const id=view.getUint16(offset,true)%2000;if(id>=1950&&id<=1954){const error=Error('收藏卡仅限单人游戏。请从主卡组、副卡组和融合卡组移除凉茶、年糕、大葱、猴子、仙人掌，或在启动前选择一套原版预设卡组。');error.code='COLLECTIBLE_ONLINE_DECK';throw error;}}
 }
 if(offset!==bytes.length)throw Error('当前卡组文件格式无效，请选择一套预设卡组后重试');
}
export function applyCollectionPatch(files,catalog,{unlock=false,deckId='',installDecks=false}={}){
 const system=files.find(file=>file.path===systemPath);
 if(!unlock&&!deckId&&!installDecks)return withProfileKey(files);
 const fromBase64=text=>Uint8Array.from(atob(text),char=>char.charCodeAt(0));
 const decoded=decodeCollection(system?.bytes||fromBase64(catalog.freshSystem));
 if(unlock){
  for(const index of catalog.cardIndices){if(!Number.isInteger(index)||index<=0||index>=2048)throw Error('卡片索引无效');decoded[20+index*2]=Math.max(3,decoded[20+index*2]);}
  const view=new DataView(decoded.buffer);let copies=0;for(let i=0;i<2048;i++)copies+=decoded[20+i*2];view.setUint16(18,copies,true);
  let sum=0;for(let i=0;i<0x1184;i+=2)sum+=view.getUint16(8+i,true);view.setUint16(8+0x1184,-sum&65535,true);
 }
 const updates=new Map([[systemPath,encodeOriginal(decoded)],[keyPath,encodeOriginal(decoded.subarray(0,8))]]);
 if(installDecks){
  for(const preset of catalog.decks){
   const bytes=fromBase64(preset.bytes);
   if(!preset.filePath?.endsWith('.ydc')||bytes.length<94)throw Error('预设卡组文件格式无效');
   bytes.set(decoded.subarray(0,8));
   const existing=files.find(file=>file.path===preset.filePath);
   // Native saves to an existing preset remain editable after installation.
   if(!existing||!decoded.subarray(0,8).every((byte,i)=>existing.bytes[i]===byte))updates.set(preset.filePath,bytes);
  }
  if(!files.some(file=>file.path===deckLibraryPath)){
   updates.set(deckLibraryPath,new Uint8Array([1]));
   if(!deckId&&unlock)deckId=catalog.decks[0].id;
  }
 }
 if(deckId){const preset=catalog.decks.find(deck=>deck.id===deckId);if(!preset)throw Error('预设卡组不存在');const bytes=fromBase64(preset.bytes);bytes.set(decoded.subarray(0,8));updates.set('/deck.ydc',bytes);}
 return [...files.filter(file=>!updates.has(file.path)),...Array.from(updates,([path,bytes])=>({path,bytes}))];
}
