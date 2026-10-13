import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createOriginalAudioHost} from './pcm-audio-host.mjs';
let Processor;
runInNewContext(await readFile(new URL('./pcm-worklet.js',import.meta.url),'utf8'), {
  AudioWorkletProcessor: class {},
  registerProcessor(name, type) {assert.equal(name,'joey-original-pcm');Processor=type;},
  Atomics, Int16Array, Int32Array, Error
});
let node;
globalThis.AudioContext=class {
  constructor({sampleRate}) {this.sampleRate=sampleRate;this.state='suspended';this.audioWorklet={addModule:async()=>{}};}
  async resume(){this.state='running';}
  async close(){this.state='closed';}
};
globalThis.AudioWorkletNode=class {
  constructor(context,name,options){node=this;this.options=options;this.processor=new Processor(options);}
  connect(){}
  disconnect(){this.disconnected=true;}
};
const memory={buffer:new SharedArrayBuffer(4096)},report={};
const host=await createOriginalAudioHost(memory,'/pcm-worklet.js',report);
const id=host.create_audio_stream(44100,2);
await host.audio_stream_resume(id);
const view=new DataView(memory.buffer);
const packet=values=>{values.forEach((v,i)=>view.setInt16(128+i*2,v,true));return host.audio_stream_put_data(id,128,values.length*2);};
const process=()=>{const output=[new Float32Array(128).fill(77),new Float32Array(128).fill(77)];node.processor.process([], [output]);return output;};
packet([-32768,32767,16384,-16384,0,1]);
assert.deepEqual(host.audio_stream_queued_bytes(id),[1,12]);
let output=process();
assert.deepEqual(Array.from(output[0].slice(0,3)),[-1,0.5,0]);
assert.deepEqual(Array.from(output[1].slice(0,3)),[32767/32768,-0.5,1/32768]);
assert(output.every(channel=>channel.slice(3).every(value=>value===0)));
assert.deepEqual(host.audio_stream_queued_bytes(id),[1,0]);
const header=node.processor.header;
Atomics.store(header,0,-2);Atomics.store(header,1,-2);
packet([111,222,333,444]);
assert.deepEqual(host.audio_stream_queued_bytes(id),[1,8]);
output=process();
assert.deepEqual(Array.from(output[0].slice(0,2)),[111/32768,333/32768]);
assert.deepEqual(Array.from(output[1].slice(0,2)),[222/32768,444/32768]);
assert.equal(Atomics.load(header,0),0);
assert.deepEqual(host.audio_stream_queued_bytes(id),[1,0]);
assert.throws(()=>host.audio_stream_put_data(id,128,3),/Invalid original PCM span/);
assert.throws(()=>host.audio_stream_put_data(id,4090,16),/Invalid original PCM span/);
assert.throws(()=>host.create_audio_stream(48000,2),/Unsupported original PCM format/);
await host.close();assert(node.disconnected);assert.equal(report.contextState,'closed');
assert.deepEqual(host.audio_stream_is_open(id),[1,0]);
console.log('PCM signed stereo samples, silence, cursor wrap, queue accounting, bounds and cleanup passed; audio hardware not tested');
