import assert from 'node:assert/strict';
import {createOriginalSubtitleHost} from '../games/joey/original/subtitles.mjs';
import {SUBTITLE_CATALOG} from '../games/joey/original/subtitle-catalog.mjs';

let tasks=new Map(),next=1,checks=0;
globalThis.requestAnimationFrame=fn=>{const id=next++;tasks.set(id,fn);return id;};
globalThis.cancelAnimationFrame=id=>tasks.delete(id);
function flush(){const ready=[...tasks.values()];tasks.clear();for(const fn of ready)fn();}
function fixture(catalog={1:{verified:true,en:'fixture one',zh:'测试一'},2:{verified:true,en:'fixture two',zh:'测试二'}}){
  let clock={readFrame:0,writeFrame:0,sampleRate:44100,running:true};const changes=[],probe={};
  const host=createOriginalSubtitleHost({audio:{getPlaybackClock:()=>clock},enabled:true,onChange:value=>changes.push(value),probe,catalog});
  return {host,probe,changes,setClock:value=>{clock=value;flush();},advance:frame=>{clock.readFrame=frame;flush();},last:()=>changes.at(-1)};
}
function test(name,fn){try{fn();checks++;console.log('ok',name);}finally{tasks.clear();}}

test('only actual consumed audio starts captions and exact end clears them',()=>{
  const f=fixture();assert.equal(f.probe.events,0);assert.equal(f.changes.length,0);
  f.host.subtitle_event(1,1,1,1,100);f.host.subtitle_event(1,2,1,1,200);
  f.advance(100);assert.equal(f.last().visible,false);
  f.advance(101);assert.equal(f.last().voiceId,1);
  f.advance(199);assert.equal(f.last().visible,true);
  f.advance(200);assert.equal(f.last().visible,false);assert.equal(f.probe.active,0);assert.equal(tasks.size,0);f.host.close();
});
test('pause and resume use frames rather than elapsed wall time',()=>{
  const f=fixture();f.host.subtitle_event(1,1,1,1,0);f.host.subtitle_event(1,2,1,1,100);f.advance(1);
  for(let i=0;i<10;i++)flush();assert.equal(f.last().visible,true);
  f.setClock({readFrame:1,writeFrame:100,sampleRate:44100,running:false});assert.equal(f.last().visible,true);
  f.setClock({readFrame:100,writeFrame:100,sampleRate:44100,running:true});assert.equal(f.last().visible,false);f.host.close();
});
test('interrupting one playback cannot let its late end clear a newer instance',()=>{
  const f=fixture();f.host.subtitle_event(1,1,1,1,0);f.advance(1);
  f.host.subtitle_event(1,2,1,1,20);f.host.subtitle_event(1,1,2,2,20);f.advance(21);assert.equal(f.last().voiceId,2);
  f.host.subtitle_event(1,2,1,1,30);f.advance(31);assert.equal(f.last().voiceId,2);
  f.host.subtitle_event(1,2,2,2,40);f.advance(40);assert.equal(f.last().visible,false);f.host.close();
});
test('an end delivered before its start cannot resurrect finished speech',()=>{
  const f=fixture();f.advance(30);f.host.subtitle_event(1,2,1,1,20);
  f.host.subtitle_event(1,1,1,1,0);assert.equal(f.last().visible,false);assert.equal(f.probe.active,0);
  f.host.subtitle_event(1,2,2,2,60);f.host.subtitle_event(1,1,2,2,40);
  f.advance(41);assert.equal(f.last().voiceId,2);f.advance(60);assert.equal(f.last().visible,false);f.host.close();
});
test('settings change during a voice uses the current playback lifetime',()=>{
  const f=fixture();f.host.subtitle_event(1,1,1,1,0);f.host.subtitle_event(1,2,1,1,100);f.advance(1);
  f.host.setEnabled(false);assert.equal(f.last().visible,false);f.host.setEnabled(true);assert.equal(f.last().voiceId,1);
  f.host.setEnabled(false);f.advance(100);f.host.setEnabled(true);assert.equal(f.last().visible,false);f.host.close();
});
test('unreviewed or missing translations remain hidden and are counted',()=>{
  const f=fixture({1:{verified:false,en:'unreviewed',zh:'未经审核'},2:{verified:true,en:'one language',zh:''}});
  f.host.subtitle_event(1,1,1,1,0);f.advance(1);assert.equal(f.last().visible,false);
  f.host.subtitle_event(1,1,2,2,1);f.advance(2);assert.equal(f.last().visible,false);assert.equal(f.probe.missingText,2);
  f.host.subtitle_event(1,1,99,3,2);assert.equal(f.probe.unknownVoice,1);f.host.close();
});
test('PCM counter wrapping preserves start and end ordering',()=>{
  const f=fixture();f.advance(0xfffffff0);f.host.subtitle_event(1,1,1,1,0xfffffff8);f.host.subtitle_event(1,2,1,1,8);
  f.advance(0xfffffff9);assert.equal(f.last().visible,true);f.advance(7);assert.equal(f.last().visible,true);
  f.advance(8);assert.equal(f.last().visible,false);f.host.close();
});
test('stream teardown and host close discard queued and late events',()=>{
  const f=fixture();f.host.subtitle_event(1,1,1,1,0);f.advance(1);f.setClock(null);assert.equal(f.last().visible,false);
  f.host.close();assert.equal(f.host.subtitle_event(1,1,1,2,20),1);assert.equal(tasks.size,0);
});
test('bad events, duplicate starts and bounded queue never fail the game',()=>{
  const f=fixture();assert.equal(f.host.subtitle_event(1,1,1,0,0),1);assert.equal(f.probe.invalid,1);
  f.host.subtitle_event(1,1,1,1,100);f.host.subtitle_event(1,1,1,1,100);assert.equal(f.probe.invalid,2);
  for(let i=2;i<70;i++)assert.equal(f.host.subtitle_event(1,1,1,i,100+i),1);
  assert.ok(f.probe.overflow>0);assert.ok(f.probe.queued<=64);f.host.close();
});
test('display callback errors are isolated from host calls',()=>{
  const probe={};const host=createOriginalSubtitleHost({audio:{getPlaybackClock:()=>({readFrame:1})},enabled:true,probe,catalog:{1:{verified:true,en:'fixture',zh:'测试'}},onChange(){throw Error('render failure');}});
  assert.equal(host.subtitle_event(1,1,1,1,0),1);assert.equal(probe.callbackErrors,1);host.close();
});
test('generated catalog covers each pinned voice without invented text',()=>{
  assert.deepEqual(Object.keys(SUBTITLE_CATALOG).map(Number),[...Array.from({length:72},(_,i)=>i+1),74]);
  for(const entry of Object.values(SUBTITLE_CATALOG)){assert.equal(entry.sampleRate,22050);assert.match(entry.sourceSHA256,/^[0-9a-f]{64}$/);if(!entry.verified){assert.equal(entry.en,'');assert.equal(entry.zh,'');}}
});
console.log(`${checks} subtitle checks passed`);
