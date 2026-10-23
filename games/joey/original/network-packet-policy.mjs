// Applied after the original 7-byte envelope has passed sender/length checks.
// The five added collection cards are playable only in single-player games.
export const networkPacketReasons=Object.freeze({
 'collection-only-card':'这套卡组含有仅限单人使用的收藏卡，请移除后重新联机。',
 'malformed-deck':'联机卡组数据不完整或数量异常，连接已结束，请重新选择卡组。'
});
export function originalDeckPacketError(packet){
 const payload=packet.subarray(7);
 if(payload.length<2)return null;
 const view=new DataView(payload.buffer,payload.byteOffset,payload.byteLength);
 if(view.getUint16(0,true)!==0xf004)return null;
 if(payload.length<4)return 'malformed-deck';
 const main=payload[2],side=payload[3];
 if(main>80||side>15||payload.length!==4+2*(main+side))return 'malformed-deck';
 for(let offset=4;offset<payload.length;offset+=2){
  const id=view.getUint16(offset,true);
  if(id>=1115&&id<=1119)return 'collection-only-card';
 }
 return null;
}
