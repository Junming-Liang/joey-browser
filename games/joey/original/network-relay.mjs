// The server owns room membership. It forwards original bytes, never game rules.
import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {WebSocketServer,WebSocket} from './vendor/ws/wrapper.mjs';
import {originalDeckPacketError,networkPacketReasons} from './network-packet-policy.mjs';

const HR={invalid:0x80070057,failed:0x80004005,noConnection:0x80158480,lost:0x80158160,timeout:0x80158630};
export const networkRelayLimits=Object.freeze({
  messageBytes:65550,controlBytes:4096,bufferBytes:1048576,
  helloMs:5000,heartbeatMs:15000,unjoinedIdleMs:60000,
  waitingMs:600000,sessionMs:7200000,commandsPerSecond:120,commandBurst:240,
  bytesPerSecond:2097152,byteBurst:4194304,connectionsPerAddress:16
});
const L=networkRelayLimits,codePattern=/^[A-Z2-7]{10}$/,guidPattern=/^[a-f0-9]{32}$/;
const guidValid=value=>typeof value==='string'&&guidPattern.test(value);
const textValid=value=>typeof value==='string'&&!value.includes('\0')&&Buffer.byteLength(value,'utf8')<=128&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const objectValid=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fieldsValid=(value,fields)=>Object.keys(value).every(key=>fields.includes(key));
const idValid=id=>Number.isInteger(id)&&id>0&&id<=0xffffffff;

export function attachNetworkRelay(server,{path,origin,protocolIdentity,maxRooms=32}){
  if(!/^\/[a-zA-Z0-9/_-]+$/.test(path)||new URL(origin).origin!==origin||!/^https?:/.test(origin)||typeof protocolIdentity!=='string'||!/^[a-zA-Z0-9:._-]{1,256}$/.test(protocolIdentity)||!Number.isInteger(maxRooms)||maxRooms<1||maxRooms>256)throw Error('Invalid network relay configuration');
  const rooms=new Map(),peers=new Set(),addresses=new Map();
  const maxConnections=maxRooms*4+8;
  // Bounds include fragmented messages and compression is deliberately disabled.
  const wss=new WebSocketServer({noServer:true,clientTracking:false,perMessageDeflate:false,maxPayload:L.messageBytes,maxFragments:128,maxBufferedChunks:1024});
  let closing=false,closed;

  function closeSocket(peer,code=1000,reason='session-ended'){
    if(peer.closing)return;
    peer.closing=true;clearTimeout(peer.helloTimer);
    if(peer.socket.readyState===WebSocket.OPEN)peer.socket.close(code,reason);
    else if(peer.socket.readyState!==WebSocket.CLOSED)peer.socket.terminate();
    peer.closeTimer=setTimeout(()=>peer.socket.terminate(),1000);peer.closeTimer.unref();
  }
  function write(peer,data,binary=false){
    if(peer.closing||peer.socket.readyState!==WebSocket.OPEN)return false;
    const payload=binary?data:JSON.stringify(data);
    if(peer.socket.bufferedAmount+Buffer.byteLength(payload)>L.bufferBytes){drop(peer,1008,'slow-consumer');return false;}
    peer.socket.send(payload,{binary,compress:false},error=>{if(error)drop(peer,1011,'send-failed');});
    return true;
  }
  function endRoom(room,actor,hr,reason){
    if(rooms.get(room.code)!==room)return;
    rooms.delete(room.code);
    const members=[room.host,room.guest].filter(Boolean);
    for(const member of members)member.room=null;
    for(const member of members){
      if(member!==actor)write(member,{event:'terminated',hr,...(Object.hasOwn(networkPacketReasons,reason)?{reason}:{})});
      if(member!==actor)closeSocket(member);
    }
  }
  function drop(peer,code=1008,reason='invalid-message',hr=HR.lost){
    if(peer.room)endRoom(peer.room,peer,hr,reason);
    closeSocket(peer,code,reason);
  }
  const reply=(peer,id,extra={})=>write(peer,{id,ok:true,...extra});
  function reject(peer,id,error,hr=HR.invalid,fatal=false){
    if(idValid(id))write(peer,{id,ok:false,error,hr});
    if(fatal)drop(peer,1008,error,hr);
  }
  function acceptId(peer,id){
    if(!idValid(id)||id<=peer.lastId){reject(peer,id,'invalid-request-id',HR.invalid,true);return false;}
    peer.lastId=id;return true;
  }
  function consume(peer,bytes){
    const now=Date.now(),seconds=Math.max(0,now-peer.rateAt)/1000;
    peer.commands=Math.min(L.commandBurst,peer.commands+seconds*L.commandsPerSecond)-1;
    peer.bytes=Math.min(L.byteBurst,peer.bytes+seconds*L.bytesPerSecond)-bytes;
    peer.rateAt=now;peer.activeAt=now;
    if(peer.commands<0||peer.bytes<0){drop(peer,1008,'rate-limit');return false;}
    return true;
  }
  function binaryMessage(peer,bytes){
    if(bytes.length<15||bytes.length>L.messageBytes){drop(peer,1008,'invalid-packet-size');return;}
    const id=bytes.readUInt32LE(0),target=bytes.readUInt32LE(4),packet=bytes.subarray(8);
    if(!acceptId(peer,id))return;
    if(!peer.hello||!peer.room){reject(peer,id,'not-connected',HR.noConnection);return;}
    const room=peer.room,other=peer===room.host?room.guest:room.host;
    if(!other||other.closing||other.room!==room){reject(peer,id,'not-connected',HR.noConnection);return;}
    if(target!==other.playerId){reject(peer,id,'invalid-target',HR.invalid,true);return;}
    if(packet[0]!==2||packet.readUInt32LE(1)!==peer.playerId||packet.readUInt16LE(5)!==packet.length-7){reject(peer,id,'invalid-original-packet',HR.invalid,true);return;}
    const policyError=originalDeckPacketError(packet);
    if(policyError){reject(peer,id,policyError,HR.invalid,true);return;}
    // Build a separate envelope; never forward attacker-supplied sender fields.
    const delivered=Buffer.allocUnsafe(bytes.length);
    delivered.writeUInt32LE(0,0);delivered.writeUInt32LE(peer.playerId,4);packet.copy(delivered,8);
    if(write(other,delivered,true))reply(peer,id);
    else reject(peer,id,'peer-unavailable',HR.lost);
  }
  function controlMessage(peer,bytes){
    if(bytes.length>L.controlBytes){drop(peer,1008,'control-too-large');return;}
    let message;
    try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch{drop(peer,1008,'invalid-json');return;}
    if(!objectValid(message)){drop(peer,1008,'invalid-json-object');return;}
    if(!acceptId(peer,message.id))return;
    const {id,type}=message;
    if(!peer.hello){
      if(type!=='hello'||!fieldsValid(message,['id','type','identity','room','role'])||message.identity!==protocolIdentity||typeof message.room!=='string'||!codePattern.test(message.room)||!['host','join'].includes(message.role)){reject(peer,id,'invalid-hello',HR.invalid,true);return;}
      peer.hello=true;peer.code=message.room;peer.role=message.role;clearTimeout(peer.helloTimer);
      reply(peer,id,{protocol:1});return;
    }
    if(type==='host'){
      if(!fieldsValid(message,['id','type','appGUID','name','playerName'])||!guidValid(message.appGUID)||!textValid(message.name)||!textValid(message.playerName)){reject(peer,id,'invalid-host',HR.invalid,true);return;}
      if(peer.role!=='host'||peer.room){reject(peer,id,'invalid-state');return;}
      if(rooms.has(peer.code)){reject(peer,id,'room-exists',HR.failed);return;}
      if(rooms.size>=maxRooms){reject(peer,id,'room-limit',HR.failed);return;}
      const room={code:peer.code,instance:randomBytes(16).toString('hex'),appGUID:message.appGUID,name:message.name,host:peer,guest:null,createdAt:Date.now()};
      peer.room=room;peer.playerId=1;peer.name=message.playerName;rooms.set(peer.code,room);
      reply(peer,id,{localId:1,instance:room.instance,players:[{id:1,name:peer.name}]});return;
    }
    if(type==='enum'){
      if(!fieldsValid(message,['id','type','appGUID'])||!guidValid(message.appGUID)){reject(peer,id,'invalid-enum',HR.invalid,true);return;}
      if(peer.role!=='join'||peer.room){reject(peer,id,'invalid-state');return;}
      const room=rooms.get(peer.code);
      reply(peer,id,{rooms:room&&room.appGUID===message.appGUID?[{instance:room.instance,appGUID:room.appGUID,name:room.name,players:room.guest?2:1}]:[]});return;
    }
    if(type==='connect'){
      if(!fieldsValid(message,['id','type','instance','playerName'])||!guidValid(message.instance)||!textValid(message.playerName)){reject(peer,id,'invalid-connect',HR.invalid,true);return;}
      if(peer.role!=='join'||peer.room){reject(peer,id,'invalid-state');return;}
      const room=rooms.get(peer.code);
      if(!room||room.instance!==message.instance||room.host.closing){reject(peer,id,'session-unavailable',HR.noConnection);return;}
      if(room.guest){reject(peer,id,'room-full',HR.noConnection);return;}
      // There is no await between capacity check and membership assignment.
      room.guest=peer;peer.room=room;peer.playerId=2;peer.name=message.playerName;
      if(reply(peer,id,{localId:2,instance:room.instance,players:[{id:1,name:room.host.name},{id:2,name:peer.name}]}))write(room.host,{event:'player',player:{id:2,name:peer.name}});
      return;
    }
    if(type==='close'){
      if(!fieldsValid(message,['id','type'])){reject(peer,id,'invalid-close',HR.invalid,true);return;}
      reply(peer,id);drop(peer,1000,'client-close');return;
    }
    reject(peer,id,'unsupported-command',HR.invalid,true);
  }
  function addressOf(req){
    const local=req.socket.remoteAddress||'',forwarded=req.headers['x-real-ip'];
    return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(local)&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:local;
  }
  function refuse(socket,status){
    socket.on('error',()=>{});
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function upgrade(req,socket,head){
    if(req.url!==path){
      // Do not consume another explicit upgrade handler's route.
      if(server.listenerCount('upgrade')===1)refuse(socket,'404 Not Found');
      return;
    }
    if(closing){refuse(socket,'503 Service Unavailable');return;}
    if(req.method!=='GET'||req.headers.origin!==origin){refuse(socket,'403 Forbidden');return;}
    const now=Date.now(),address=addressOf(req);
    for(const [key,bucket]of addresses)if(!bucket.connections&&now-bucket.at>60000)addresses.delete(key);
    let bucket=addresses.get(address);
    if(!bucket){
      if(addresses.size>=1024){refuse(socket,'503 Service Unavailable');return;}
      bucket={connections:0,tokens:40,at:now};addresses.set(address,bucket);
    }
    bucket.tokens=Math.min(40,bucket.tokens+Math.max(0,now-bucket.at)*40/60000);bucket.at=now;
    if(peers.size>=maxConnections||bucket.connections>=L.connectionsPerAddress||bucket.tokens<1){refuse(socket,'429 Too Many Requests');return;}
    bucket.tokens--;
    wss.handleUpgrade(req,socket,head,ws=>{
      // handleUpgrade may finish after another upgrade filled the last seat.
      if(closing||peers.size>=maxConnections||bucket.connections>=L.connectionsPerAddress){ws.close(1013,'connection-limit');return;}
      bucket.connections++;
      const peer={socket:ws,hello:false,room:null,lastId:0,closing:false,alive:true,activeAt:now,rateAt:now,commands:L.commandBurst,bytes:L.byteBurst};
      peers.add(peer);
      peer.helloTimer=setTimeout(()=>drop(peer,1008,'hello-timeout',HR.timeout),L.helloMs);peer.helloTimer.unref();
      ws.on('pong',()=>{peer.alive=true;});
      ws.on('message',(bytes,binary)=>{
        if(peer.closing||!consume(peer,bytes.length))return;
        if(binary)binaryMessage(peer,bytes);else controlMessage(peer,bytes);
      });
      ws.on('error',()=>drop(peer,1008,'transport-error'));
      ws.on('close',()=>{
        if(peer.room)endRoom(peer.room,peer,HR.lost);
        peer.closing=true;clearTimeout(peer.helloTimer);clearTimeout(peer.closeTimer);peers.delete(peer);bucket.connections--;
      });
    });
  }
  server.on('upgrade',upgrade);
  const heartbeat=setInterval(()=>{
    const now=Date.now();
    for(const room of rooms.values())if(now-room.createdAt>(room.guest?L.sessionMs:L.waitingMs)){
      endRoom(room,null,HR.timeout);
    }
    for(const peer of peers){
      if(peer.closing)continue;
      if(!peer.alive||(!peer.room&&now-peer.activeAt>L.unjoinedIdleMs)){drop(peer,1001,'peer-timeout',HR.timeout);continue;}
      peer.alive=false;peer.socket.ping();
    }
  },L.heartbeatMs);heartbeat.unref();

  function close(){
    if(closed)return closed;
    closing=true;server.off('upgrade',upgrade);server.off('close',close);clearInterval(heartbeat);
    for(const peer of peers){if(peer.room)endRoom(peer.room,peer,HR.lost);clearTimeout(peer.helloTimer);clearTimeout(peer.closeTimer);peer.socket.terminate();}
    rooms.clear();addresses.clear();
    closed=new Promise(resolve=>wss.close(()=>resolve()));return closed;
  }
  server.once('close',close);
  return {close};
}
