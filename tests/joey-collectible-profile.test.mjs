import assert from 'node:assert/strict';
import {assertOnlineDeck} from '../games/joey/original/collection-patch.mjs';
import {collectionCatalog} from '../games/joey/original/collection-catalog.mjs';

for(const preset of collectionCatalog.decks){
 const bytes=new Uint8Array(Buffer.from(preset.bytes,'base64'));
 assert.doesNotThrow(()=>assertOnlineDeck([{path:'/deck.ydc',bytes}]));
}
assert.doesNotThrow(()=>assertOnlineDeck([]));
for(let group=0;group<3;group++)for(let id=1950;id<=1954;id++)for(const alternate of [0,2000]){
 const bytes=new Uint8Array(16),view=new DataView(bytes.buffer);let p=8;
 for(let g=0;g<3;g++){
  view.setUint16(p,g===group?1:0,true);p+=2;
  if(g===group){view.setUint16(p,id+alternate,true);p+=2;}
 }
 assert.throws(()=>assertOnlineDeck([{path:'/deck.ydc',bytes}]),error=>error.code==='COLLECTIBLE_ONLINE_DECK');
}
for(const size of [0,13,15])assert.throws(()=>assertOnlineDeck([{path:'/deck.ydc',bytes:new Uint8Array(size)}]));
