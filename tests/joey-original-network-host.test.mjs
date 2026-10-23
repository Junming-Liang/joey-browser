import test from 'node:test';
import assert from 'node:assert/strict';
import {createOriginalNetworkHost} from '../games/joey/original/network-host.mjs';

const HR={INVALID:0x80070057,UNSUPPORTED:0x80004001,NOCONNECTION:0x80158480,LOST:0x80158160,TIMEOUT:0x80158630,CANCEL:0x80158650};
function deckBody(main=[],side=[]){
 const body=new Uint8Array(4+2*(main.length+side.length)),view=new DataView(body.buffer);
 view.setUint16(0,0xf004,true);body[2]=main.length;body[3]=side.length;
 [...main,...side].forEach((id,index)=>view.setUint16(4+index*2,id,true));return body;
}
const enumArgs=handle=>[handle,0xffffffff,0,0xffffffff];
const room='ABCDEFG234',instance='00112233445566778899aabbccddeeff',application=new Uint8Array(16).fill(37);
const hosts=[];let nativeSocket;
class Socket{
 static all=[];
 constructor(url){this.url=url;this.readyState=0;this.bufferedAmount=0;this.sent=[];Socket.all.push(this);}
 open(){this.readyState=1;this.onopen?.({});}
 send(data){this.sent.push(typeof data==='string'?JSON.parse(data):new Uint8Array(data).slice());}
 receive(data){this.onmessage?.({data:data instanceof ArrayBuffer?data:JSON.stringify(data)});}
 reply(extra={}){this.receive({id:this.sent.at(-1).id,ok:true,...extra});}
 close(){this.readyState=3;}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test.beforeEach(()=>{nativeSocket=globalThis.WebSocket;globalThis.WebSocket=Socket;Socket.all=[];});
test.afterEach(()=>{for(const host of hosts.splice(0))host.close();globalThis.WebSocket=nativeSocket;});
function make(mode='host'){
 const memory=new WebAssembly.Memory({initial:3}),probe={},host=createOriginalNetworkHost({memory,baseURL:'https://game.example/joey/online-preview/',selection:{mode,room},probe});hosts.push(host);
 const call=(op,args=[],text='',data=new Uint8Array(),capacity=65568)=>{new Uint8Array(memory.buffer,0,data.length).set(data);return host.network_call(41,op,args,text,0,data.length,70000,capacity);};
 const poll=()=>{const result=call(7);if(!result[2])return null;const bytes=new Uint8Array(memory.buffer,70000,result[2]).slice(),view=new DataView(bytes.buffer);return {kind:view.getUint32(0,true),id:view.getUint32(4,true),flags:view.getUint32(8,true),extra:view.getUint32(12,true),payload:bytes.subarray(16)};};
 assert.deepEqual(call(1),[1,0,0]);assert.deepEqual(call(2,[],'Player'),[1,0,0]);return {host,memory,probe,call,poll};
}
async function hello(socket){socket.open();await flush();assert.equal(socket.sent.at(-1).type,'hello');socket.reply({protocol:1});await flush();}
async function hosted(){const context=make(),pending=context.call(3,[],'Friend duel',application),socket=Socket.all.at(-1);await hello(socket);socket.reply({localId:1,instance,players:[{id:1,name:'Player'}]});assert.deepEqual(await pending,[1,0,0]);return {...context,socket};}
function packet(sender,body=[10,20,30]){const bytes=new Uint8Array(7+body.length),view=new DataView(bytes.buffer);bytes[0]=2;view.setUint32(1,sender,true);view.setUint16(5,body.length,true);bytes.set(body,7);return bytes;}
function inbound(sender,bytes=packet(sender)){const frame=new Uint8Array(8+bytes.length);new DataView(frame.buffer).setUint32(4,sender,true);frame.set(bytes,8);return frame.buffer;}
async function joined(){const context=make('join');assert.deepEqual(context.call(5,[12],'',Uint8Array.from(instance.match(/../g),part=>parseInt(part,16))),[1,0,0]);const socket=Socket.all.at(-1);await hello(socket);socket.reply({localId:2,instance,players:[{id:1,name:'Host'},{id:2,name:'Player'}]});await flush();return {...context,socket};}

test('collection-only main/side cards and malformed decks cannot cross either browser boundary',async()=>{
 const cases=[];
 for(let id=1115;id<=1119;id++)cases.push([deckBody([id],[1]),'collection-only-card'],[deckBody([1],[id]),'collection-only-card']);
 for(const body of [[4,240],[4,240,1],[4,240,1,0],[4,240,0,0,1,0],deckBody(Array(81).fill(1)),deckBody([],Array(16).fill(1))])cases.push([body,'malformed-deck']);
 for(const [body,reason]of cases)for(const outgoing of [false,true]){
  const {call,poll,socket,probe,host}=await joined();while(poll());const before=socket.sent.length;
  if(outgoing)assert.equal(call(6,[1],'',packet(2,body))[1],HR.INVALID);else socket.receive(inbound(1,packet(1,body)));
  assert.equal(socket.sent.length,before);assert.equal(probe.state,'disconnected');assert.equal(probe.lastErrorCode,reason);assert.ok(probe.lastErrorReason);
  const events=[];for(let event;(event=poll());)events.push(event.kind);assert.deepEqual(events,[2,2,6]);
  assert.equal(probe.receivedPackets,0);assert.equal(probe.sentPackets,0);host.close();
 }
});
test('largest legal deck remains exact and relay policy errors have readable reasons',async()=>{
 const {call,poll,socket,probe}=await joined();while(poll());const body=deckBody(Array(80).fill(1114),Array(15).fill(1120));
 assert.equal(body.length,194);assert.deepEqual(call(6,[1],'',packet(2,body)),[1,0,0]);
 const sent=socket.sent.at(-1);assert.deepEqual(sent.subarray(8),packet(2,body));socket.receive({id:new DataView(sent.buffer).getUint32(0,true),ok:true});
 socket.receive(inbound(1,packet(1,body)));assert.deepEqual(poll().payload,packet(1,body));
 socket.receive({event:'terminated',hr:HR.INVALID,reason:'collection-only-card'});assert.equal(probe.lastErrorCode,'collection-only-card');assert.match(probe.lastErrorReason,/仅限单人/);
 call(9);call(1);assert.equal(probe.lastErrorReason,'');
});
test('single-player creates no sockets, including a network-menu attempt',async()=>{
 const {call,probe}=make('single');assert.equal(probe.state,'disabled');assert.equal(call(3,[],'Room',application)[1],HR.NOCONNECTION);assert.equal(Socket.all.length,0);
});
test('Host waits for actual registration and copies RPC input before awaiting',async()=>{
 const {call,memory,probe,poll}=make();const pending=call(3,[],'Friend duel',application),socket=Socket.all.at(-1);
 assert.equal(typeof pending.then,'function');assert.notEqual(probe.state,'hosting');new Uint8Array(memory.buffer,0,16).fill(0);
 assert.equal(socket.url,'wss://game.example/joey/online-preview/api/network');await hello(socket);
 assert.equal(socket.sent[0].room,room);assert.equal(socket.sent[0].identity,'2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77:shim-v1');
 assert.equal(socket.sent.at(-1).appGUID,Buffer.from(application).toString('hex'));assert.equal(poll(),null);
 socket.reply({localId:1,instance,players:[{id:1,name:'Player'}]});assert.deepEqual(await pending,[1,0,0]);assert.equal(probe.state,'hosting');
 assert.equal(call(7,[],'',new Uint8Array(),16)[1],HR.INVALID);const event=poll();assert.deepEqual([event.kind,event.id,event.flags],[1,1,6]);assert.equal(new TextDecoder().decode(event.payload),'Player');
 assert.equal(JSON.stringify(probe).includes(room),false);assert.equal(JSON.stringify(probe).includes('Player'),false);
});
test('persistent enumeration queues discovery and connection completes with correct local flags',async()=>{
 const {call,poll,probe}=make('join');assert.deepEqual(call(4,enumArgs(11),'',application),[1,0,0]);const socket=Socket.all.at(-1);await hello(socket);
 socket.reply({rooms:[{instance,appGUID:Buffer.from(application).toString('hex'),name:'Room',players:1}]});await flush();assert.equal(probe.state,'found');
 const found=poll();assert.deepEqual([found.kind,found.id,found.extra],[3,11,1]);assert.equal(Buffer.from(found.payload.subarray(0,16)).toString('hex'),instance);assert.equal(poll(),null);
 assert.deepEqual(call(5,[12],'',found.payload.subarray(0,16)),[1,0,0]);await flush();assert.equal(socket.sent.at(-1).type,'connect');
 socket.reply({localId:2,instance,players:[{id:1,name:'Host'},{id:2,name:'Player'}]});await flush();
 assert.deepEqual([poll(),poll(),poll()].map(event=>[event.kind,event.id,event.flags,event.extra]),[[1,1,4,0],[1,2,2,0],[4,12,0,2]]);assert.equal(probe.state,'connected');
});
test('ordered original packets are copied; SendTo returns before relay acknowledgment',async()=>{
 const {call,poll,socket,probe,memory}=await joined();while(poll());
 const received=packet(1);socket.receive(inbound(1,received));const event=poll();assert.equal(event.kind,5);assert.equal(event.id,1);assert.deepEqual(event.payload,received);
 const outgoing=packet(2),result=call(6,[1],'',outgoing);assert.deepEqual(result,[1,0,0]);new Uint8Array(memory.buffer,0,outgoing.length).fill(0);
 const frame=socket.sent.at(-1),view=new DataView(frame.buffer);assert.equal(view.getUint32(4,true),1);assert.deepEqual(frame.subarray(8),outgoing);socket.receive({id:view.getUint32(0,true),ok:true});
 assert.equal(probe.sentPackets,1);assert.equal(probe.receivedPackets,1);assert.equal(call(6,[1],'',packet(1))[1],HR.INVALID);assert.equal(probe.state,'disconnected');
 assert.deepEqual([poll(),poll(),poll()].map(event=>[event.kind,event.flags]),[[2,2],[2,2],[6,HR.INVALID]]);
});
test('malformed sender and length never reach the guest receive callback',async()=>{
 const {poll,socket,probe}=await joined();while(poll());socket.receive(inbound(1,packet(2)));
 const events=[];for(let event;(event=poll());)events.push([event.kind,event.flags]);assert.deepEqual(events,[[2,2],[2,2],[6,HR.LOST]]);assert.equal(probe.state,'disconnected');assert.equal(socket.readyState,3);
});
test('close/reinitialize resolves Host and ignores an old socket reply without stack writes',async()=>{
 const {call,memory,probe,poll}=make(),pending=call(3,[],'Room',application),socket=Socket.all.at(-1);await hello(socket);const delayed=socket.onmessage,id=socket.sent.at(-1).id;
 assert.deepEqual(call(9),[1,0,0]);assert.deepEqual(call(1),[1,0,0]);new Uint8Array(memory.buffer,70000,256).fill(73);
 delayed({data:JSON.stringify({id,ok:true,localId:1,instance,players:[{id:1,name:'Player'}]})});assert.equal((await pending)[1],HR.CANCEL);
 assert.equal(new Uint8Array(memory.buffer,70000,256).every(byte=>byte===73),true);assert.equal(poll(),null);assert.equal(probe.state,'ready');assert.equal(probe.generations,2);
});
test('cancelled connect cannot terminate a later socket or emit a late completion',async()=>{
 const {call,poll,probe}=make('join');call(5,[10],'',application);const old=Socket.all.at(-1);old.open();await flush();const oldHandler=old.onmessage;
 assert.deepEqual(call(8,[10]),[1,0,0]);assert.equal(poll(),null);call(4,enumArgs(11),'',application);const fresh=Socket.all.at(-1);assert.notEqual(fresh,old);await hello(fresh);
 oldHandler({data:JSON.stringify({id:1,ok:true,protocol:1})});fresh.reply({rooms:[]});await flush();assert.equal(poll(),null);assert.equal(probe.state,'not-found');
});
test('cancel removes enumeration results already queued for the guest',async()=>{
 const {call,poll,probe}=make('join');call(4,enumArgs(11),'',application);const socket=Socket.all.at(-1);await hello(socket);socket.reply({rooms:[{instance,appGUID:Buffer.from(application).toString('hex'),name:'Room',players:1}]});await flush();assert.equal(probe.queuedEvents,1);
 call(8,[11]);assert.equal(poll(),null);assert.equal(probe.queuedEvents,0);assert.equal(probe.queuedBytes,0);
});
test('queue overflow closes the session and leaves a bounded termination sequence',async()=>{
 const {poll,socket,probe}=await joined();while(poll());for(let index=0;index<257;index++)socket.receive(inbound(1));
 assert.equal(probe.state,'disconnected');assert.equal(probe.queuedEvents,3);assert.ok(probe.queuedBytes<=48);assert.equal(probe.receivedPackets,256);while(poll());assert.equal(probe.queuedBytes,0);
});
test('unacknowledged sends are bounded and cannot block the original game',async()=>{
 const {call,poll,probe}=await joined();while(poll());for(let index=0;index<64;index++)assert.deepEqual(call(6,[1],'',packet(2)),[1,0,0]);
 assert.equal(call(6,[1],'',packet(2))[1],HR.LOST);assert.equal(probe.state,'disconnected');await flush();
});
test('socket and command deadlines resolve pending calls without throwing',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const {call,poll,probe}=make();const pending=call(3,[],'Room',application);context.mock.timers.tick(10000);
 assert.equal((await pending)[1],HR.TIMEOUT);assert.equal(poll().kind,6);assert.equal(probe.state,'disconnected');
 const command=make(),waiting=command.call(3,[],'Room',application);await hello(Socket.all.at(-1));context.mock.timers.tick(10000);
 assert.equal((await waiting)[1],HR.TIMEOUT);assert.equal(command.poll().kind,6);assert.equal(command.probe.state,'disconnected');context.mock.timers.reset();
});
test('receive polling is immediate and does not reserve the command response buffer',async()=>{
 const {call,poll,memory}=make(),waiting=call(3,[],'Room',application);assert.deepEqual(call(7),[1,0,0]);new Uint8Array(memory.buffer,70000,32).fill(44);
 call(9);assert.equal((await waiting)[1],HR.CANCEL);assert.equal(poll(),null);assert.equal(new Uint8Array(memory.buffer,70000,32).every(byte=>byte===44),true);
});
test('invalid memory spans and UTF-8 names fail before any socket or memory access',()=>{
 const {host,call,memory}=make();new Uint8Array(memory.buffer,70000,32).fill(91);
 assert.equal(host.network_call(41,3,[],'Room',memory.buffer.byteLength-8,16,70000,32)[1],HR.INVALID);
 assert.equal(call(2,[],'\ud800')[1],HR.INVALID);assert.equal(call(2,[],'a'.repeat(129))[1],HR.INVALID);assert.equal(Socket.all.length,0);assert.equal(new Uint8Array(memory.buffer,70000,32).every(byte=>byte===91),true);
});
test('a terminated peer rejects another async operation until reinitialized',async()=>{
 const {call,poll,socket}=await joined();while(poll());socket.receive(inbound(1,packet(2)));while(poll());
 assert.equal(call(4,enumArgs(15),'',application)[1],HR.NOCONNECTION);assert.equal(poll(),null);assert.equal(Socket.all.length,1);
});
test('Host cannot report success when the room closes before its reply is consumed',async()=>{
 const {call,probe}=make(),pending=call(3,[],'Room',application),socket=Socket.all.at(-1);await hello(socket);
 socket.reply({localId:1,instance,players:[{id:1,name:'Player'}]});socket.onclose({});assert.equal((await pending)[1],HR.LOST);assert.equal(probe.state,'disconnected');
});
test('original infinite enumeration refreshes past the 4500ms game expiry without completing',async()=>{
 const {call,poll,probe,host}=make('join');call(4,enumArgs(11),'',application);const socket=Socket.all.at(-1);await hello(socket);
 const rooms=[{instance,appGUID:Buffer.from(application).toString('hex'),name:'Room',players:1}],send=socket.send.bind(socket);
 socket.send=data=>{send(data);if(socket.sent.at(-1).type==='enum')queueMicrotask(()=>socket.reply({rooms}));};
 socket.reply({rooms});await new Promise(resolve=>setTimeout(resolve,4700));
 const events=[];for(let event;(event=poll());)events.push(event);assert.ok(events.length>=4);assert.equal(events.every(event=>event.kind===3&&event.id===11),true);assert.equal(probe.state,'found');host.close();
});
test('enumeration has one in-flight query and Cancel discards a late reply and all timers',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const {call,poll,host}=make('join');call(4,enumArgs(11),'',application);const socket=Socket.all.at(-1);await hello(socket);
 const first=socket.sent.at(-1);context.mock.timers.tick(4500);await flush();assert.equal(socket.sent.filter(message=>message.type==='enum').length,1);
 assert.equal(call(4,enumArgs(12),'',application)[1],HR.INVALID);call(8,[11]);socket.receive({id:first.id,ok:true,rooms:[{instance,appGUID:Buffer.from(application).toString('hex'),name:'Room',players:1}]});
 context.mock.timers.tick(30000);await flush();assert.equal(socket.sent.filter(message=>message.type==='enum').length,1);assert.equal(poll(),null);assert.equal(socket.readyState,1);host.close();context.mock.timers.reset();
});
test('Connect pauses in-flight discovery; subsequent enum cancellation keeps the joined socket',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const {call,poll,probe,host}=make('join');call(4,enumArgs(11),'',application);const socket=Socket.all.at(-1);await hello(socket);const enumeration=socket.sent.at(-1);
 call(5,[12],'',Uint8Array.from(instance.match(/../g),part=>parseInt(part,16)));await flush();const connect=socket.sent.at(-1);assert.equal(connect.type,'connect');
 socket.receive({id:enumeration.id,ok:true,rooms:[{instance,appGUID:Buffer.from(application).toString('hex'),name:'Room',players:1}]});
 socket.receive({id:connect.id,ok:true,localId:2,instance,players:[{id:1,name:'Host'},{id:2,name:'Player'}]});await flush();
 assert.deepEqual([poll(),poll(),poll()].map(event=>event.kind),[1,1,4]);assert.equal(poll(),null);call(8,[11]);context.mock.timers.tick(30000);await flush();
 assert.equal(socket.sent.filter(message=>message.type==='enum').length,1);assert.equal(socket.readyState,1);assert.equal(probe.state,'connected');assert.equal(poll(),null);host.close();context.mock.timers.reset();
});
test('Close clears a scheduled enumeration refresh and its old generation',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const {call,poll,host}=make('join');call(4,enumArgs(11),'',application);const socket=Socket.all.at(-1);await hello(socket);socket.reply({rooms:[]});await flush();
 call(9);call(1);context.mock.timers.tick(30000);await flush();assert.equal(socket.sent.filter(message=>message.type==='enum').length,1);assert.equal(poll(),null);host.close();context.mock.timers.reset();
});
test('finite enumeration modes are explicitly unsupported without network or completion events',()=>{
 const {call,poll,probe}=make('join');
 for(const args of [[11,1,0,0xffffffff],[11,0xffffffff,0,1500],[11,0,0,0],[11,0xffffffff,20,0xffffffff]])assert.equal(call(4,args,'',application)[1],HR.UNSUPPORTED);
 assert.equal(call(4,[11],'',application)[1],HR.INVALID);assert.equal(Socket.all.length,0);assert.equal(probe.state,'ready');assert.equal(poll(),null);
});
