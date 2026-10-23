// Transport for the original game's DirectPlay shim. Guest callbacks are pumped
// by Rust; this module only owns sockets, copied packets, and bounded queues.
import {originalDeckPacketError,networkPacketReasons} from './network-packet-policy.mjs';
const IDENTITY='2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77:shim-v1';
const HR={INVALID:0x80070057,UNSUPPORTED:0x80004001,FAIL:0x80004005,NOCONNECTION:0x80158480,LOST:0x80158160,TIMEOUT:0x80158630,CANCEL:0x80158650};
const LIMIT=65568,QUEUE_BYTES=1048576,QUEUE_EVENTS=256,DEADLINE=10000;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const uint=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
const guid=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const unhex=value=>Uint8Array.from(value.match(/../g),byte=>parseInt(byte,16));
function nameBytes(value){
 if(typeof value!=='string'||value.includes('\0'))throw HR.INVALID;
 const bytes=encoder.encode(value);
 if(bytes.length>128||decoder.decode(bytes)!==value)throw HR.INVALID;
 return bytes;
}
function packetValid(bytes,sender){
 if(bytes.length<7||bytes.length>65542||bytes[0]!==2)return false;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 return view.getUint32(1,true)===sender&&view.getUint16(5,true)===bytes.length-7;
}
function eventBytes(kind,id=0,flags=0,extra=0,payload=new Uint8Array()){
 const bytes=new Uint8Array(16+payload.length),view=new DataView(bytes.buffer);
 [kind,id,flags,extra].forEach((value,index)=>view.setUint32(index*4,value,true));bytes.set(payload,16);return bytes;
}

export function createOriginalNetworkHost({memory,baseURL=new URL('./',import.meta.url),selection=null,probe={},protocolIdentity=IDENTITY}){
 const mode=selection?.mode||'single',room=selection?.room;
 const enabled=(mode==='host'||mode==='join')&&typeof room==='string'&&/^[A-Z2-7]{10}$/.test(room);
 const peers=new Map();let stopped=false,generation=0;
 Object.assign(probe,{state:enabled?'ready':'disabled',generations:0,sockets:0,commands:0,sentPackets:0,receivedPackets:0,sentBytes:0,receivedBytes:0,queuedEvents:0,queuedBytes:0,errors:0,lastError:0,lastErrorCode:'',lastErrorReason:''});
 const policyReason=code=>{if(Object.hasOwn(networkPacketReasons,code)){probe.lastErrorCode=code;probe.lastErrorReason=networkPacketReasons[code];}};
 const current=state=>!stopped&&!state.closed&&peers.get(state.id)===state;
 const setStatus=(state,value)=>{if(current(state)&&(!state.terminated||value==='disconnected'))probe.state=value;};
 function recount(){probe.queuedEvents=0;probe.queuedBytes=0;probe.sockets=0;for(const state of peers.values()){probe.queuedEvents+=state.events.length;probe.queuedBytes+=state.eventBytes;if(state.socket)probe.sockets++;}}
 function stopOperation(state,operation){
  if(!operation)return;
  clearTimeout(operation.timer);operation.timer=null;
  const pending=state.requests.get(operation.requestId);
  if(pending){clearTimeout(pending.timer);state.requests.delete(operation.requestId);pending.reject(HR.CANCEL);}
  operation.requestId=null;
 }
 function dropSocket(state,hr){
  const socket=state.socket;state.socket=null;state.ready=null;
  if(state.openWait){clearTimeout(state.openWait.timer);state.openWait.reject(hr);state.openWait=null;}
  for(const pending of state.requests.values()){clearTimeout(pending.timer);pending.reject(hr);}state.requests.clear();
  if(socket){socket.onopen=socket.onmessage=socket.onerror=socket.onclose=null;try{socket.close();}catch{}}
  recount();
 }
 function terminate(state,hr=HR.LOST){
  if(!current(state)||state.terminated)return;
  state.terminated=true;probe.errors++;probe.lastError=hr;setStatus(state,'disconnected');dropSocket(state,hr);
  // Once delivery is incomplete, discard gameplay packets and preserve one
  // terminal event, so overflow cannot leave a silently desynchronized duel.
  state.events=[];state.eventBytes=0;
  for(const operation of state.operations.values()){operation.completed=true;stopOperation(state,operation);state.events.push(eventBytes(operation.op===5?4:7,operation.handle,hr));}
  for(const id of state.deliveredPlayers)state.events.push(eventBytes(2,id,2)); // DPNDESTROYPLAYERREASON_CONNECTIONLOST
  state.events.push(eventBytes(6,0,hr));state.eventBytes=state.events.reduce((sum,event)=>sum+event.length,0);recount();
 }
 function enqueue(state,bytes){
  if(!current(state)||state.terminated)return false;
  if(state.events.length>=QUEUE_EVENTS||state.eventBytes+bytes.length>QUEUE_BYTES){terminate(state,HR.LOST);return false;}
  state.events.push(bytes);state.eventBytes+=bytes.length;recount();return true;
 }
 function dispose(state){
  state.closed=true;for(const operation of state.operations.values())stopOperation(state,operation);state.operations.clear();state.events=[];state.eventBytes=0;dropSocket(state,HR.CANCEL);peers.delete(state.id);recount();
 }
 function readPlayers(value,expected){
  if(!Array.isArray(value)||value.length!==expected.length)throw HR.FAIL;
  const players=new Map();
  for(const player of value){if(!player||!expected.includes(player.id)||players.has(player.id))throw HR.FAIL;nameBytes(player.name);players.set(player.id,player.name);}
  return players;
 }
 function receive(state,socket,data){
  if(!current(state)||state.socket!==socket)return;
  try{
   if(data instanceof ArrayBuffer){
    const bytes=new Uint8Array(data),view=new DataView(data);
    if(bytes.length<15||bytes.length>65550||view.getUint32(0,true)!==0)throw HR.FAIL;
    const sender=view.getUint32(4,true),packet=bytes.subarray(8);
    if(!state.localId||sender===state.localId||!state.players.has(sender)||!packetValid(packet,sender))throw HR.FAIL;
    const policyError=originalDeckPacketError(packet);
    if(policyError){policyReason(policyError);terminate(state,HR.INVALID);return;}
    if(enqueue(state,eventBytes(5,sender,0,0,packet))){probe.receivedPackets++;probe.receivedBytes+=packet.length;}
    return;
   }
   if(typeof data!=='string'||data.length>4096)throw HR.FAIL;
   const message=JSON.parse(data);
   if(!message||Array.isArray(message)||typeof message!=='object')throw HR.FAIL;
   if(message.event==='player'){
    if(state.localId!==1||state.players.size!==1||message.player?.id!==2)throw HR.FAIL;
    const bytes=nameBytes(message.player.name);state.players.set(2,message.player.name);
    enqueue(state,eventBytes(1,2,0,0,bytes));setStatus(state,'connected');return;
   }
   if(message.event==='terminated'){if(!uint(message.hr)||message.hr===0)throw HR.FAIL;policyReason(message.reason);terminate(state,message.hr);return;}
   if(!uint(message.id)||message.id===0||typeof message.ok!=='boolean')throw HR.FAIL;
   const pending=state.requests.get(message.id);
   if(!pending)return; // A cancelled enumeration may still have a wire reply.
   clearTimeout(pending.timer);state.requests.delete(message.id);
   if(message.ok)pending.resolve(message);
   else {policyReason(message.error);pending.reject(uint(message.hr)&&message.hr!==0?message.hr:HR.FAIL);}
  }catch{terminate(state,HR.LOST);}
 }
 function request(state,fields,packet){
  if(!current(state)||state.terminated||state.socket?.readyState!==1)throw HR.NOCONNECTION;
  if(state.requests.size>=64)throw HR.LOST;
  const id=state.nextRequest++;if(id>0xffffffff)throw HR.FAIL;
  let payload;
  if(packet){payload=new Uint8Array(8+packet.length);const view=new DataView(payload.buffer);view.setUint32(0,id,true);view.setUint32(4,fields.target,true);payload.set(packet,8);}
  else payload=JSON.stringify({id,...fields});
  if(state.socket.bufferedAmount+(typeof payload==='string'?encoder.encode(payload).length:payload.length)>QUEUE_BYTES)throw HR.LOST;
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const pending={resolve,reject,timer:setTimeout(()=>terminate(state,HR.TIMEOUT),DEADLINE)};
  state.requests.set(id,pending);
  try{
   state.socket.send(payload);
   probe.commands++;
  }catch{clearTimeout(pending.timer);state.requests.delete(id);throw HR.LOST;}
  promise.requestId=id;return promise;
 }
 function connectSocket(state){
  if(state.ready)return state.ready;
  if(!enabled||!current(state)||state.terminated)return Promise.reject(HR.NOCONNECTION);
  setStatus(state,'connecting');
  state.ready=(async()=>{
   let socket;
   try{
    const url=new URL('api/network',baseURL);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    socket=new WebSocket(url.href);socket.binaryType='arraybuffer';state.socket=socket;recount();
    await new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>terminate(state,HR.TIMEOUT),DEADLINE);state.openWait={reject,timer};
     socket.onopen=()=>{if(!current(state)||state.socket!==socket)return;clearTimeout(timer);state.openWait=null;resolve();};
     socket.onmessage=event=>receive(state,socket,event.data);
     socket.onerror=socket.onclose=()=>{if(current(state)&&state.socket===socket)terminate(state,HR.LOST);};
    });
    if(!current(state)||state.socket!==socket)throw HR.CANCEL;
    const hello=await request(state,{type:'hello',identity:protocolIdentity,room,role:mode});
    if(!current(state)||state.socket!==socket)throw HR.CANCEL;
    if(hello.protocol!==1)throw HR.FAIL;
    return socket;
   }catch(error){if(current(state)&&(!socket||state.socket===socket))terminate(state,uint(error)?error:HR.LOST);throw uint(error)?error:HR.LOST;}
  })();
  return state.ready;
 }
 function active(state,operation){return current(state)&&state.operations.get(operation.handle)===operation;}
 function complete(state,operation,hr,extra=0){
  if(!active(state,operation)||operation.completed)return;
  operation.completed=true;stopOperation(state,operation);enqueue(state,eventBytes(operation.op===5?4:7,operation.handle,hr,extra));
 }
 async function enumerate(state,operation,data){
  const running=()=>active(state,operation)&&!operation.paused&&!operation.completed&&!state.terminated;
  if(!running())return;
  try{
   await connectSocket(state);if(!running())return;
   const appGUID=hex(data),pending=request(state,{type:'enum',appGUID});operation.requestId=pending.requestId;
   const reply=await pending;operation.requestId=null;if(!running())return;
   if(!Array.isArray(reply.rooms)||reply.rooms.length>1)throw HR.FAIL;
   for(const result of reply.rooms){
    if(!result||!guid(result.instance)||result.appGUID!==appGUID||![1,2].includes(result.players))throw HR.FAIL;
    const name=nameBytes(result.name),payload=new Uint8Array(32+name.length);payload.set(unhex(result.instance));payload.set(data,16);payload.set(name,32);
    enqueue(state,eventBytes(3,operation.handle,0,result.players,payload));
   }
   setStatus(state,reply.rooms.length?'found':'not-found');
   // The original requests INFINITE count/timeout and expires discoveries
   // after 4500 ms. Keep refreshing; completing this operation clears its UI.
   if(running())operation.timer=setTimeout(()=>{operation.timer=null;enumerate(state,operation,data);},1500);
  }catch(error){if(running())terminate(state,uint(error)?error:HR.FAIL);}
 }
 function beginAsync(state,op,handle,data){
  if(!handle||state.operations.has(handle)||state.operations.size>=4)throw HR.INVALID;
  if(op===4&&[...state.operations.values()].some(other=>other.op===4&&!other.completed))throw HR.INVALID;
  const operation={op,handle};state.operations.set(handle,operation);
  if(op===4){
   if(mode!=='join'||state.localId){terminate(state,HR.NOCONNECTION);return;}
   setStatus(state,'searching');enumerate(state,operation,data);return;
  }
  // Join uses this same socket. Pause discovery before Connect, leaving its
  // handle owned by Rust until normal Cancel/Close; never close on enum cancel.
  for(const other of state.operations.values())if(other.op===4){other.paused=true;stopOperation(state,other);}
  state.events=state.events.filter(bytes=>new DataView(bytes.buffer).getUint32(0,true)!==3);
  state.eventBytes=state.events.reduce((sum,bytes)=>sum+bytes.length,0);recount();
  (async()=>{
   try{
    if(mode!=='join'||state.localId)throw HR.NOCONNECTION;
    await connectSocket(state);if(!active(state,operation))return;
    setStatus(state,'joining');
     const instance=hex(data),pending=request(state,{type:'connect',instance,playerName:state.name});operation.requestId=pending.requestId;
     const reply=await pending;if(!active(state,operation)||state.terminated)return;
     if(reply.localId!==2||reply.instance!==instance)throw HR.FAIL;
     state.players=readPlayers(reply.players,[1,2]);state.localId=2;
     for(const [id,name]of state.players)enqueue(state,eventBytes(1,id,(id===2?2:0)|(id===1?4:0),0,nameBytes(name)));
     setStatus(state,'connected');complete(state,operation,0,2);
   }catch(error){if(!active(state,operation))return;const hr=uint(error)?error:HR.FAIL;terminate(state,hr);complete(state,operation,hr);}
  })();
 }
 function validSpan(ptr,length){return uint(ptr)&&uint(length)&&length<=LIMIT&&ptr+length<=memory.buffer.byteLength;}
 function network_call(peer,op,args,text,dataPtr,dataLen,responsePtr,responseCapacity){
  let state=peers.get(peer);
  try{
   if(!uint(peer)||peer===0||!uint(op)||!Array.isArray(args)||args.length>16||!args.every(uint)||!validSpan(dataPtr,dataLen)||!validSpan(responsePtr,responseCapacity))throw HR.INVALID;
   // The RPC caller may reuse its stack immediately after completion.
   const data=new Uint8Array(memory.buffer,dataPtr,dataLen).slice(),words=args.slice();nameBytes(text);
   if(stopped)return [1,HR.CANCEL,0];
   if(op===1){
    if(state)dispose(state);if(peers.size>=4)throw HR.FAIL;
    probe.lastErrorCode='';probe.lastErrorReason='';
    state={id:peer,generation:++generation,name:'Player',events:[],eventBytes:0,requests:new Map(),operations:new Map(),players:new Map(),deliveredPlayers:new Set(),nextRequest:1,localId:0,closed:false,terminated:false,socket:null,ready:null,openWait:null};
    peers.set(peer,state);probe.generations++;setStatus(state,enabled?'ready':'disabled');return [1,0,0];
   }
   if(op===9){if(state)dispose(state);probe.state=enabled?'ready':'disabled';return [1,0,0];}
   if(!state||!current(state))return [1,HR.NOCONNECTION,0];
   if(op===2){state.name=text;return [1,0,0];}
   if(op===7){
    const event=state.events[0];if(!event)return [1,0,0];if(event.length>responseCapacity)throw HR.INVALID;
    new Uint8Array(memory.buffer,responsePtr,event.length).set(event);state.events.shift();state.eventBytes-=event.length;
    const view=new DataView(event.buffer),kind=view.getUint32(0,true),id=view.getUint32(4,true);
    if(kind===1)state.deliveredPlayers.add(id);if(kind===2)state.deliveredPlayers.delete(id);if(kind===4||kind===7)state.operations.delete(id);
    recount();return [1,0,event.length];
   }
   if(op===8){
    const handle=words[0];if(!handle)throw HR.INVALID;
    const operation=state.operations.get(handle);state.operations.delete(handle);
    stopOperation(state,operation);
    state.events=state.events.filter(bytes=>{const view=new DataView(bytes.buffer);return ![3,4,7].includes(view.getUint32(0,true))||view.getUint32(4,true)!==handle;});
    state.eventBytes=state.events.reduce((sum,bytes)=>sum+bytes.length,0);recount();
    if(operation?.op===5){dropSocket(state,HR.CANCEL);state.events=[];state.eventBytes=0;state.players.clear();state.deliveredPlayers.clear();state.localId=0;setStatus(state,'ready');recount();}
    return [1,0,0]; // Rust owns the cancellation completion.
   }
   if([3,4,5].includes(op)&&data.length!==16)throw HR.INVALID;
   if(state.terminated)return [1,HR.NOCONNECTION,0];
   if(op===4){
    if(words.length!==4)throw HR.INVALID;
    // Only the observed persistent DirectPlay enumeration is implemented.
    // Finite count/timeout and other retry modes must not fake completion.
    if(words[1]!==0xffffffff||words[3]!==0xffffffff||![0,1500].includes(words[2]))return [1,HR.UNSUPPORTED,0];
   }
   if(op===4||op===5){beginAsync(state,op,words[0],data);return [1,0,0];}
   if(op===3){
    if(mode!=='host'||!enabled||state.localId||state.hosting)throw HR.NOCONNECTION;
    state.hosting=true;
    return (async()=>{
     try{
      await connectSocket(state);if(!current(state))return [1,HR.CANCEL,0];
      const result=await request(state,{type:'host',appGUID:hex(data),name:text,playerName:state.name});
      if(!current(state))return [1,HR.CANCEL,0];
      if(state.terminated)throw HR.LOST;
      if(result.localId!==1||!guid(result.instance))throw HR.FAIL;
      state.players=readPlayers(result.players,[1]);state.localId=1;enqueue(state,eventBytes(1,1,6,0,nameBytes(state.players.get(1))));setStatus(state,'hosting');return [1,0,0];
     }catch(error){const hr=uint(error)?error:HR.FAIL;if(current(state))terminate(state,hr);return [1,hr,0];}
     finally{state.hosting=false;}
    })();
   }
   if(op===6){
    const target=words[0];
    if(!state.localId||target===state.localId||!state.players.has(target))throw HR.NOCONNECTION;
    if(!packetValid(data,state.localId))throw HR.INVALID;
    const policyError=originalDeckPacketError(data);
    if(policyError){policyReason(policyError);throw HR.INVALID;}
    request(state,{target},data).catch(error=>terminate(state,uint(error)?error:HR.LOST));probe.sentPackets++;probe.sentBytes+=data.length;return [1,0,0];
   }
   throw HR.INVALID;
  }catch(error){const hr=uint(error)?error:HR.FAIL;if(state&&(op===6||hr!==HR.INVALID))terminate(state,hr);return [1,hr,0];}
 }
 function close(){if(stopped)return;stopped=true;for(const state of [...peers.values()])dispose(state);probe.state='closed';}
 return {network_call,close};
}
