import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import WebSocket from './vendor/ws/wrapper.mjs';
import {attachNetworkRelay,networkRelayLimits as limits} from './network-relay.mjs';
import {createOriginalNetworkHost} from './network-host.mjs';

const identity='2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77:shim-v1';
const appGUID='6c3e72d9b95a9440b977d3526270d881',path='/joey/original/api/network';
const codeA='ABCDEFGH23',codeB='ABCDEFGH45';
let checks=0;
function check(condition,message){assert(condition,message);checks++;}
class Client{
  constructor(url,origin,options={}){
    this.socket=new WebSocket(url,{headers:{Origin:origin,...options.headers},autoPong:options.autoPong??true});
    this.items=[];this.waiters=[];this.seq=0;
    this.opened=new Promise((resolve,reject)=>{this.socket.once('open',resolve);this.socket.once('error',reject);});
    this.closed=new Promise(resolve=>this.socket.once('close',(code,reason)=>{this.closedValue={code,reason:reason.toString()};resolve(this.closedValue);}));
    this.socket.on('error',()=>{});
    this.socket.on('message',(bytes,binary)=>{
      const item=binary?Buffer.from(bytes):JSON.parse(bytes.toString());
      const index=this.waiters.findIndex(waiter=>waiter.predicate(item));
      if(index===-1)this.items.push(item);
      else{const [waiter]=this.waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(item);}
    });
  }
  next(predicate,timeout=3000){
    const index=this.items.findIndex(predicate);
    if(index!==-1)return Promise.resolve(this.items.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{
      const waiter={predicate,resolve};
      waiter.timer=setTimeout(()=>{this.waiters.splice(this.waiters.indexOf(waiter),1);reject(Error('Expected relay message did not arrive'));},timeout);
      this.waiters.push(waiter);
    });
  }
  request(type,extra={}){
    const id=++this.seq;this.socket.send(JSON.stringify({id,type,...extra}));
    return this.next(item=>!Buffer.isBuffer(item)&&item.id===id);
  }
  async hello(room=codeA,role='join',overrides={}){await this.opened;return this.request('hello',{room,role,identity,...overrides});}
  async host(room=codeA){assert((await this.hello(room,'host')).ok);const response=await this.request('host',{appGUID,name:'原版双人',playerName:'Host'});this.playerId=response.localId;return response;}
  async connect(room,instance){assert((await this.hello(room,'join')).ok);const response=await this.request('connect',{instance,playerName:'Guest'});this.playerId=response.localId;return response;}
  sendOriginal(target,body,{sender=this.playerId,kind=2,declared=body.length}={}){
    const id=++this.seq,bytes=Buffer.alloc(15+body.length);
    bytes.writeUInt32LE(id,0);bytes.writeUInt32LE(target,4);bytes[8]=kind;bytes.writeUInt32LE(sender,9);bytes.writeUInt16LE(declared,13);Buffer.from(body).copy(bytes,15);
    this.socket.send(bytes);return this.next(item=>!Buffer.isBuffer(item)&&item.id===id);
  }
}
async function fixture(run,options={}){
  const origin='http://127.0.0.1',server=createServer((req,res)=>{res.writeHead(404);res.end();});
  const relay=attachNetworkRelay(server,{path,origin,protocolIdentity:identity,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,clients=[];
  const client=(settings={})=>{const item=new Client(`ws://127.0.0.1:${port}${path}`,origin,settings);clients.push(item);return item;};
  try{await run({client,server,relay,port,origin});}
  finally{
    const stopping=relay.close();for(const item of clients)item.socket.terminate();await stopping;
    await new Promise(resolve=>server.close(resolve));
  }
}
async function pair(client,code=codeA){
  const host=client(),hosted=await host.host(code),guest=client();
  const connected=await guest.connect(code,hosted.instance);
  assert(connected.ok);await host.next(item=>item.event==='player');
  return {host,guest,instance:hosted.instance};
}
function upgradeStatus(port,origin,url=path){
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path:url,headers:{Origin:origin,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':randomBytes(16).toString('base64')}},res=>{res.resume();resolve(res.statusCode);});
    req.once('error',reject);req.once('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode);});req.end();
  });
}

function deckBody(main=[],side=[]){
  const body=Buffer.alloc(4+2*(main.length+side.length));body.writeUInt16LE(0xf004);body[2]=main.length;body[3]=side.length;
  [...main,...side].forEach((id,index)=>body.writeUInt16LE(id,4+index*2));return body;
}
const deckCases=[];
for(let id=1115;id<=1119;id++)deckCases.push([deckBody([id],[1]),'collection-only-card'],[deckBody([1],[id]),'collection-only-card']);
for(const body of [[4,240],[4,240,1],[4,240,1,0],[4,240,0,0,1,0],deckBody(Array(81).fill(1)),deckBody([],Array(16).fill(1))])deckCases.push([Buffer.from(body),'malformed-deck']);
for(const [body,reason]of deckCases)for(const hostSends of [true,false])await fixture(async({client})=>{
  const {host,guest}=await pair(client),sender=hostSends?host:guest,receiver=hostSends?guest:host;
  const result=await sender.sendOriginal(receiver.playerId,body);
  check(!result.ok&&result.error===reason,'Modified clients cannot bypass deck policy');
  const end=await receiver.next(item=>item.event==='terminated');assert.equal(end.reason,reason);
  await sender.closed;await receiver.closed;check(!receiver.items.some(Buffer.isBuffer),'Forbidden or malformed deck is never forwarded');
});
await fixture(async({client})=>{
  const {host,guest}=await pair(client),body=deckBody(Array(80).fill(1114),Array(15).fill(1120));
  assert.equal(body.length,194);assert((await host.sendOriginal(2,body)).ok);assert.deepEqual((await guest.next(Buffer.isBuffer)).subarray(15),body);
  assert((await guest.sendOriginal(1,body)).ok);assert.deepEqual((await host.next(Buffer.isBuffer)).subarray(15),body);checks+=2;
});

// Pin the actual server implementation and license, independent of root npm deps.
const vendorRoot=new URL('./vendor/ws/',import.meta.url),provenance=JSON.parse(await readFile(new URL('provenance.json',vendorRoot)));
assert.equal(provenance.version,'8.21.3');assert.equal(provenance.license,'MIT');
for(const [name,hash]of Object.entries(provenance.vendoredFilesSHA256))assert.equal(createHash('sha256').update(await readFile(new URL(name,vendorRoot))).digest('hex'),hash,name);
check((await readFile(new URL('LICENSE',vendorRoot),'utf8')).includes('Permission is hereby granted'),'The fixed dependency includes its MIT permission notice');

await fixture(async({client,port,origin})=>{
  assert.equal(await upgradeStatus(port,'https://foreign.invalid'),403);
  assert.equal(await upgradeStatus(port,origin,path+'?room=private'),404);
  assert.equal(await upgradeStatus(port,origin,'/another-business'),404);
  checks+=3;
  const wrong=client();check(!(await wrong.hello(codeA,'join',{identity:'wrong'})).ok,'Version mismatch fails');await wrong.closed;
  const malformed=client();check(!(await malformed.hello(codeA,'join',{room:{toString:'invalid'}})).ok,'Object room values cannot coerce into valid input');await malformed.closed;
  const empty=client();assert((await empty.hello()).ok);assert.deepEqual((await empty.request('enum',{appGUID})).rooms,[]);checks++;
  const host=client(),hosted=await host.host();check(hosted.ok&&hosted.localId===1,'Only Host creates a real room');
  check(/^[a-f0-9]{32}$/.test(hosted.instance),'Instance is a raw GUID identity');
  const duplicate=client();assert((await duplicate.hello(codeA,'host')).ok);assert.equal((await duplicate.request('host',{appGUID,name:'duplicate',playerName:'x'})).error,'room-exists');checks++;
  const enumerator=client();assert((await enumerator.hello()).ok);
  assert.deepEqual((await enumerator.request('enum',{appGUID})).rooms,[{instance:hosted.instance,appGUID,name:'原版双人',players:1}]);checks++;
  assert.deepEqual((await enumerator.request('enum',{appGUID:'0'.repeat(32)})).rooms,[]);checks++;
  const otherRoom=client();assert((await otherRoom.hello(codeB)).ok);assert.deepEqual((await otherRoom.request('enum',{appGUID})).rooms,[]);checks++;
  const badInstance=await enumerator.request('connect',{instance:'0'.repeat(32),playerName:'guest'});check(!badInstance.ok&&badInstance.hr===0x80158480,'Stale or wrong instance cannot connect');
  const guest=client(),connected=await guest.connect(codeA,hosted.instance);check(connected.ok&&connected.localId===2,'Connect assigns guest identity');
  assert.deepEqual(connected.players,[{id:1,name:'Host'},{id:2,name:'Guest'}]);checks++;
  assert.deepEqual(await host.next(item=>item.event==='player'),{event:'player',player:{id:2,name:'Guest'}});checks++;
  assert.equal((await enumerator.request('connect',{instance:hosted.instance,playerName:'third'})).error,'room-full');checks++;
  const body=Buffer.from([0,1,2,255]);assert((await host.sendOriginal(2,body)).ok);
  const received=await guest.next(Buffer.isBuffer);assert.equal(received.readUInt32LE(0),0);assert.equal(received.readUInt32LE(4),1);assert.equal(received.readUInt32LE(9),1);assert.deepEqual(received.subarray(15),body);checks++;
  assert((await guest.sendOriginal(1,Buffer.from('reply'))).ok);assert.equal((await host.next(Buffer.isBuffer)).subarray(15).toString(),'reply');checks++;
  check(!host.items.some(Buffer.isBuffer),'There is no accidental local echo');
  await guest.request('close');assert.equal((await host.next(item=>item.event==='terminated')).hr,0x80158160);await host.closed;await guest.closed;checks++;
  const replacement=client(),rehosted=await replacement.host();check(rehosted.ok&&rehosted.instance!==hosted.instance,'Same room invitation gets a new instance after close');
  check(!(await enumerator.request('connect',{instance:hosted.instance,playerName:'old'})).ok,'Old instance remains rejected after room reuse');
});

await fixture(async({client})=>{
  const a=await pair(client,codeA),b=await pair(client,codeB);
  assert((await a.host.sendOriginal(2,Buffer.from('room A'))).ok);
  assert.equal((await a.guest.next(Buffer.isBuffer)).subarray(15).toString(),'room A');
  assert((await b.host.sendOriginal(2,Buffer.from('room B'))).ok);
  assert.equal((await b.guest.next(Buffer.isBuffer)).subarray(15).toString(),'room B');
  check(![...b.host.items,...a.host.items,...b.guest.items,...a.guest.items].some(Buffer.isBuffer),'Parallel rooms never receive each other’s packets');
  a.host.socket.terminate();await a.guest.next(item=>item.event==='terminated');await a.guest.closed;
  check((await b.guest.sendOriginal(1,Buffer.from('still alive'))).ok,'Unrelated room remains usable after a peer disconnects');await b.host.next(Buffer.isBuffer);
});

for(const [name,options,target]of [
  ['forged sender',{sender:2},2],['truncated declared payload',{declared:8},2],
  ['trailing payload',{declared:0},2],['wrong original type',{kind:3},2],
  ['self target',{},1],['unknown target',{},99],['broadcast target',{},0]
])await fixture(async({client})=>{
  const {host,guest}=await pair(client);
  const result=await host.sendOriginal(target,Buffer.from([1]),options);
  check(!result.ok,name+' is rejected');await host.closed;await guest.next(item=>item.event==='terminated');await guest.closed;
  check(!guest.items.some(Buffer.isBuffer),name+' cannot reach guest memory');
});

await fixture(async({client})=>{
  const {host,guest}=await pair(client);
  const maximum=Buffer.alloc(65535,0x5a);check((await host.sendOriginal(2,maximum)).ok,'Largest original u16 payload passes within the wire bound');
  assert.deepEqual((await guest.next(Buffer.isBuffer)).subarray(15),maximum);checks++;
  const invalid=Buffer.alloc(limits.messageBytes+1);host.socket.send(invalid);
  check((await host.closed).code===1009,'Oversized WebSocket messages are rejected by the fixed framing implementation');
  await guest.next(item=>item.event==='terminated');await guest.closed;check(!guest.items.some(Buffer.isBuffer),'Oversized packet never gets forwarded');
});

await fixture(async({client})=>{
  const repeated=client();assert((await repeated.hello()).ok);repeated.socket.send(JSON.stringify({id:repeated.seq,type:'enum',appGUID}));
  check((await repeated.next(item=>item.ok===false)).error==='invalid-request-id','Duplicate IDs fail instead of replaying state changes');await repeated.closed;
  const malformed=client();await malformed.opened;malformed.socket.send('[]');check((await malformed.closed).code===1008,'Non-object JSON closes the connection');
  const badGuid=client();assert((await badGuid.hello()).ok);check(!(await badGuid.request('enum',{appGUID:{toString:'bad'}})).ok,'Non-string GUID is rejected without coercion');await badGuid.closed;
  const badName=client();assert((await badName.hello(codeA,'host')).ok);check(!(await badName.request('host',{appGUID,name:'bad\0name',playerName:'x'})).ok,'NUL names are rejected');await badName.closed;
  const badUnicode=client();assert((await badUnicode.hello(codeA,'host')).ok);check(!(await badUnicode.request('host',{appGUID,name:'\ud800',playerName:'x'})).ok,'Lone surrogate names are rejected');await badUnicode.closed;
  const large=client();await large.opened;large.socket.send(JSON.stringify({id:1,type:'hello',padding:'x'.repeat(limits.controlBytes)}));check((await large.closed).code===1008,'Control size is independently bounded');
  const short=client();assert((await short.hello()).ok);short.socket.send(Buffer.alloc(8));check((await short.closed).code===1008,'Binary packet shorter than original header is rejected');
});

await fixture(async({client,relay})=>{
  const h=client();check((await h.host()).ok,'First room fits capacity');
  const extra=client();assert((await extra.hello(codeB,'host')).ok);check((await extra.request('host',{appGUID,name:'limit',playerName:'x'})).error==='room-limit','Room count is bounded');
  const waiter=client();await waiter.opened;
  check((await waiter.closed).reason==='hello-timeout','Unauthenticated sockets have a finite hello deadline');
  const g=client(),enumerated=await g.hello();assert(enumerated.ok);const room=(await g.request('enum',{appGUID})).rooms[0];assert((await g.request('connect',{instance:room.instance,playerName:'Guest'})).ok);
  await relay.close();await h.closed;await g.closed;check(true,'Relay close terminates active members and is awaitable');await relay.close();
},{maxRooms:1});

await fixture(async({client})=>{
  const peers=Array.from({length:limits.connectionsPerAddress},()=>client());await Promise.all(peers.map(peer=>peer.opened));
  const excess=client();let refused=false;try{await excess.opened;}catch(error){refused=/429/.test(String(error));}
  check(refused,'Per-address connection bound is enforced before joining');
});

await fixture(async({client})=>{
  const peer=client();assert((await peer.hello()).ok);
  for(let index=0;index<limits.commandBurst+50;index++)peer.socket.send(JSON.stringify({id:++peer.seq,type:'enum',appGUID}));
  check((await peer.closed).reason==='rate-limit','Command bursts are bounded');
});

// Cross-check the separately implemented browser RPC bridge against the actual
// relay, with two independent memories and real WebSocket frames (no echo stub).
await fixture(async({port,origin})=>{
  const originalWebSocket=globalThis.WebSocket,hosts=[];
  globalThis.WebSocket=class extends WebSocket{constructor(url){super(url,{origin});}};
  const waitFor=async predicate=>{
    const deadline=Date.now()+3000;
    while(!predicate()){if(Date.now()>deadline)throw Error('Browser/relay integration did not reach expected state');await new Promise(resolve=>setTimeout(resolve,5));}
  };
  const make=mode=>{
    const memory=new WebAssembly.Memory({initial:3}),probe={};
    const host=createOriginalNetworkHost({memory,baseURL:`http://127.0.0.1:${port}/joey/original/`,selection:{mode,room:codeA},probe});hosts.push(host);
    const call=(op,args=[],text='',data=new Uint8Array())=>{new Uint8Array(memory.buffer,0,data.length).set(data);return host.network_call(41,op,args,text,0,data.length,70000,65568);};
    const poll=()=>{const result=call(7);assert.equal(result[1],0);if(!result[2])return null;const bytes=new Uint8Array(memory.buffer,70000,result[2]).slice(),view=new DataView(bytes.buffer);return {kind:view.getUint32(0,true),id:view.getUint32(4,true),flags:view.getUint32(8,true),extra:view.getUint32(12,true),payload:bytes.subarray(16)};};
    assert.deepEqual(call(1),[1,0,0]);assert.deepEqual(call(2,[],mode==='host'?'Host':'Guest'),[1,0,0]);return {call,poll,probe};
  };
  try{
    const host=make('host'),guest=make('join'),application=Buffer.from(appGUID,'hex');
    assert.deepEqual(await host.call(3,[],'Friend duel',application),[1,0,0]);
    let event=host.poll();assert.deepEqual([event.kind,event.id,event.flags],[1,1,6]);checks++;
    assert.deepEqual(guest.call(4,[11,0xffffffff,0,0xffffffff],'',application),[1,0,0]);await waitFor(()=>guest.probe.state==='found');
    const discovered=guest.poll();assert.deepEqual([discovered.kind,discovered.id,discovered.extra],[3,11,1]);assert.equal(Buffer.from(discovered.payload.subarray(16,32)).toString('hex'),appGUID);
    assert.equal(guest.poll(),null);checks++;
    await new Promise(resolve=>setTimeout(resolve,4700));
    const refreshed=[];while((event=guest.poll()))refreshed.push(event);
    check(refreshed.length>=3&&refreshed.every(item=>item.kind===3&&item.id===11),'Persistent browser enumeration refreshes beyond the original 4500ms expiry without completing');
    assert.deepEqual(guest.call(5,[12],'',discovered.payload.subarray(0,16)),[1,0,0]);await waitFor(()=>host.probe.state==='connected'&&guest.probe.state==='connected');
    const joined=[guest.poll(),guest.poll(),guest.poll()];assert.deepEqual(joined.map(item=>[item.kind,item.id,item.flags,item.extra]),[[1,1,4,0],[1,2,2,0],[4,12,0,2]]);checks++;
    assert.deepEqual(guest.call(8,[11]),[1,0,0]);const commands=guest.probe.commands;await new Promise(resolve=>setTimeout(resolve,1600));
    check(guest.probe.state==='connected'&&guest.probe.commands===commands&&guest.poll()===null,'Cancelling discovery after Connect leaves the joined socket live with no late polling or completion');
    assert.deepEqual([host.poll().kind,host.poll()],[1,null]);checks++;
    const packet=Buffer.from([2,1,0,0,0,3,0,0x10,0x20,0x30]);
    check(Array.isArray(host.call(6,[2],'',packet)),'Browser SendTo completes without waiting for a relay round trip');
    await waitFor(()=>guest.probe.receivedPackets===1);event=guest.poll();assert.equal(event.kind,5);assert.equal(event.id,1);assert.deepEqual(Buffer.from(event.payload),packet);checks++;
    packet.writeUInt32LE(2,1);assert.deepEqual(guest.call(6,[1],'',packet),[1,0,0]);await waitFor(()=>host.probe.receivedPackets===1);assert.deepEqual(Buffer.from(host.poll().payload),packet);checks++;
    assert.deepEqual(guest.call(9),[1,0,0]);await waitFor(()=>host.probe.state==='disconnected');
    const ended=[];while((event=host.poll()))ended.push(event.kind);assert.deepEqual(ended,[2,2,6]);checks++;
    assert.deepEqual(host.call(9),[1,0,0]);assert.deepEqual(host.call(1),[1,0,0]);assert.deepEqual(await host.call(3,[],'Fresh duel',application),[1,0,0]);
    check(host.probe.state==='hosting'&&host.probe.generations===2,'Browser Peer reinitialization establishes a fresh actual room');
  }finally{for(const host of hosts)host.close();globalThis.WebSocket=originalWebSocket;}
});

if(process.argv.includes('--heartbeat'))await fixture(async({client})=>{
  const host=client({autoPong:false}),hosted=await host.host(),guest=client();assert((await guest.connect(codeA,hosted.instance)).ok);
  await host.next(item=>item.event==='player');
  const end=await host.closed;check(end.reason==='peer-timeout','A socket that never responds to heartbeat is expired');
  assert.equal((await guest.next(item=>item.event==='terminated')).hr,0x80158630);await guest.closed;checks++;
});

if(process.argv.includes('--backpressure'))await fixture(async({client})=>{
  const {host,guest}=await pair(client),pending=[],body=Buffer.alloc(65535,0x5a);
  // Pausing the actual receiving TCP socket models a consumer that stops
  // draining. Continue below the sender byte/command rate so the exercised
  // limit is specifically the receiver's outgoing socket buffer.
  guest.socket._socket.pause();
  const terminated=host.next(item=>item.event==='terminated',15000);
  for(let batch=0;batch<15&&!host.closedValue;batch++){
    for(let index=0;index<16&&host.socket.readyState===1;index++)pending.push(host.sendOriginal(2,body).catch(()=>null));
    await new Promise(resolve=>setTimeout(resolve,600));
  }
  assert.equal((await terminated).hr,0x80158160);await host.closed;
  check(host.closedValue.reason==='session-ended','A slow receiver terminates its paired sender rather than silently losing reliable packets');
  guest.socket._socket.resume();await guest.closed;
  check(guest.closedValue.reason==='slow-consumer'||guest.closedValue.code===1006,'The bounded receiver socket is closed or forcibly terminated');
  await Promise.all(pending);
});

console.log(JSON.stringify({scope:'actual-WebSocket relay and browser-RPC integration; not a real original-game duel',checks,vendorVersion:provenance.version,heartbeatTested:process.argv.includes('--heartbeat'),backpressureTested:process.argv.includes('--backpressure'),passed:true}));
