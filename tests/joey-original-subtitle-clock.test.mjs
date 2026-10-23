import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createOriginalAudioHost} from '../games/joey/reverse/pcm-audio-host.mjs';
import {createOriginalSubtitleHost} from '../games/joey/original/subtitles.mjs';

let Processor,context,node,next=1;
const tasks=new Map();
globalThis.requestAnimationFrame=fn=>{const id=next++;tasks.set(id,fn);return id;};
globalThis.cancelAnimationFrame=id=>tasks.delete(id);
const tick=()=>{const ready=[...tasks.values()];tasks.clear();for(const fn of ready)fn();};
runInNewContext(await readFile(new URL('../games/joey/reverse/pcm-worklet.js',import.meta.url),'utf8'),{
  AudioWorkletProcessor:class {},Atomics,Int16Array,Int32Array,Error,
  registerProcessor(name,type){assert.equal(name,'joey-original-pcm');Processor=type;}
});
globalThis.AudioContext=class {
  constructor({sampleRate}){context=this;this.sampleRate=sampleRate;this.state='suspended';this.audioWorklet={addModule:async()=>{}};}
  async resume(){this.state='running';}
  async close(){this.state='closed';}
};
globalThis.AudioWorkletNode=class {
  constructor(ctx,name,options){node=this;this.processor=new Processor(options);}
  connect(){}
  disconnect(){}
};
if(!globalThis.navigator)globalThis.navigator={};
const memory={buffer:new SharedArrayBuffer(4096)},report={};
const audio=await createOriginalAudioHost(memory,'/pcm-worklet.js',report);
const id=audio.create_audio_stream(44100,2);
const changes=[];
const subtitles=createOriginalSubtitleHost({audio,enabled:true,onChange:event=>changes.push(event),
  catalog:{1:{verified:true,en:'fixture',zh:'测试'}}});
const process=()=>{node.processor.process([],[new Array(2).fill(null).map(()=>new Float32Array(128))]);tick();};
assert.equal(audio.getPlaybackClock(999),null);
assert.deepEqual(audio.getPlaybackClock(id),{readFrame:0,writeFrame:0,sampleRate:44100,running:false});
subtitles.subtitle_event(id,1,1,1,0);
audio.audio_stream_put_data(id,0,8);
process(); // The ring has data, but the stream has not been resumed.
assert.equal(audio.getPlaybackClock(id).readFrame,0);
assert.equal(changes.at(-1).visible,false);
await audio.audio_stream_resume(id);
process();
assert.deepEqual(audio.getPlaybackClock(id),{readFrame:2,writeFrame:2,sampleRate:44100,running:true});
assert.equal(changes.at(-1).visible,true);
subtitles.subtitle_event(id,2,1,1,4);
for(let i=0;i<5;i++)process(); // Missing output samples do not advance the caption clock.
assert.equal(audio.getPlaybackClock(id).readFrame,2);
assert.equal(changes.at(-1).visible,true);
context.state='suspended';tick();assert.equal(audio.getPlaybackClock(id).running,false);
context.state='running';audio.audio_stream_put_data(id,0,8);process();
assert.equal(audio.getPlaybackClock(id).readFrame,4);
assert.equal(changes.at(-1).visible,false);
assert.equal(tasks.size,0);
subtitles.subtitle_event(id,1,1,2,4);audio.audio_stream_put_data(id,0,8);process();
assert.equal(changes.at(-1).visible,true);
node.onprocessorerror();tick();
assert.equal(audio.getPlaybackClock(id),null);assert.equal(changes.at(-1).visible,false);
await audio.close();subtitles.close();assert.equal(audio.getPlaybackClock(id),null);
console.log('PCM worklet consumption, suspension, underrun, completion, failure and shutdown keep subtitles synchronized');
