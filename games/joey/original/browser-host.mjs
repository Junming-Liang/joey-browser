// Shared browser host for the original translated EXE; no replacement game UI.
import {createRangeReader} from './range-reader.mjs';
import {createOriginalAudioHost} from './pcm-audio-host.mjs';
import {createOriginalResourceCache} from './resource-cache.mjs';
import {archiveLayouts,preloadAssets} from './resource-layout.mjs';

export function createOriginalBrowserHost({manifest,program,preloadMode='common',baseURL=new URL('./',import.meta.url),container=document.body,onStatus=()=>{},traceSpec='',loadFiles=async()=>[],saveFile=async()=>{}}){
if(!['common','complete'].includes(preloadMode))throw Error('Invalid original resource preparation mode');
const probe = {stages: [], threads:[], calls: [], console: '', renders: 0, writes: [], windows: [], inputQueued:0,inputConsumed:0, launchArguments: ['-win','-e']};
probe.environment={secureContext:isSecureContext,isolated:crossOriginIsolated,sharedMemory:typeof SharedArrayBuffer==='function',browser:navigator.userAgent};
probe.programSource=program;
if(!probe.environment.secureContext)throw Error('当前页面未获得安全连接，无法启动原版程序');
if(!probe.environment.isolated||!probe.environment.sharedMemory)throw Error('当前 Safari 页面未启用原版程序所需的共享内存');
probe.audio = {};
probe.resourceCache={};const resourceCache=createOriginalResourceCache(probe.resourceCache);
const reader = createRangeReader(manifest,{cache:resourceCache,layouts:archiveLayouts});
probe.resourceReads = []; probe.resourceStats = reader.stats;
// 512 initial pages cover the original program and embedded native glyphs.
const memory = new WebAssembly.Memory({initial: 512, maximum: 16384, shared: true});
let closeAudio,resumeOutput,stopped=false;const surfaces = new Map(); let nextSurface = 1, gameWindow,framePixels;
probe.drawTiming={uploads:0,uploadMs:0,maxUploadMs:0,presents:0,presentMs:0,maxPresentMs:0};
const resumeAudio=()=>resumeOutput?resumeOutput():Promise.reject(Error('声音设备尚未准备好'));
let position=[400,300],held=0;const heldKeys=new Map();
const input=[];let inputWaiter;
const enqueue=message=>{
  if(stopped)return;
  probe.inputQueued++;
  probe.lastInput={type:message[0],at:Date.now()};
  if(inputWaiter){const resolve=inputWaiter;inputWaiter=undefined;probe.inputConsumed++;resolve(message);return;}
  if(message[0]===4&&input.at(-1)?.[0]===4){input[input.length-1]=message;return;}
  if(input.length>=256)throw Error('Diagnostic input queue overflow');
  input.push(message);
};
const pollInput=()=>{const message=input.shift();if(message)probe.inputConsumed++;return message||[-1];};
const listenInput=canvas=>{
  canvas.tabIndex=0;canvas.style.touchAction='none';
  canvas.oncontextmenu=event=>event.preventDefault();
  const keyCodes={Enter:[28,13,0],Escape:[1,27,0],Space:[57,32,0],
    ArrowLeft:[75,37,1],ArrowUp:[72,38,1],ArrowRight:[77,39,1],ArrowDown:[80,40,1],
    Tab:[15,9,0],Backspace:[14,8,0]};
  for(const type of ['keydown','keyup'])canvas.addEventListener(type,event=>{
    const code=keyCodes[event.code];if(!code)return;event.preventDefault();
    enqueue([type==='keydown'?5:6,code[0],code[1],code[2]|(event.repeat?2:0)]);
  });
  const heldButtons=buttons=>(buttons&1)|((buttons&4)>>1)|((buttons&2)<<1);
  for(const type of ['pointerdown','pointerup','pointermove','pointercancel'])canvas.addEventListener(type,event=>{
    if(!event.isPrimary)return;event.preventDefault();
    const box=canvas.getBoundingClientRect();
    position=[Math.max(0,Math.min(canvas.width-1,Math.floor((event.clientX-box.left)*canvas.width/box.width))),Math.max(0,Math.min(canvas.height-1,Math.floor((event.clientY-box.top)*canvas.height/box.height)))];
    const changed=[1,2,4][event.button]||0;
    if(type==='pointerdown'){canvas.focus();canvas.setPointerCapture(event.pointerId);if(probe.audio.contextState!=='running')resumeAudio().catch(error=>{probe.audio.resumeError=String(error);});}
    if(type==='pointercancel'){
      for(const button of [1,2,4])if(held&button){held&=~button;enqueue([3,...position,button|(held<<16)]);}
      return;
    }
    held=heldButtons(event.buttons);
    enqueue([type==='pointerdown'?2:type==='pointerup'?3:4,...position,changed|(held<<16)]);
  });
  canvas.addEventListener('keydown',event=>{const code=keyCodes[event.code];if(code)heldKeys.set(event.code,code);});
  canvas.addEventListener('keyup',event=>heldKeys.delete(event.code));
  canvas.addEventListener('blur',()=>{
    for(const code of heldKeys.values())enqueue([6,...code]);heldKeys.clear();
    for(const button of [1,2,4])if(held&button){held&=~button;enqueue([3,...position,button|(held<<16)]);}
  });
};
const reply = (addr, value) => {
  const values = Array.isArray(value) ? value : [value];
  if (!Number.isFinite(values[0]) || !values[0]) throw Error('Invalid synchronous response');
  const words = new Int32Array(memory.buffer, addr, values.length);
  words.set(values.slice(1), 1);
  Atomics.store(words, 0, values[0]); Atomics.notify(words, 0, 1);
};
const workers=new Set();
const terminateWorkers=()=>{for(const worker of workers)worker.terminate();workers.clear();};
const fail=(stage,error,details={})=>{if(stopped)return;const data={...details,stage,error:String(error),startupPhase:probe.stages.at(-1)?.stage||'creating-host'};probe.stages.push(data);onStatus(data);stopped=true;terminateWorkers();if(closeAudio)closeAudio().catch(()=>{});};
const methods = {
  spawn_thread(task,module){
    if(!Number.isInteger(task)||task<=0||!(module instanceof WebAssembly.Module))throw Error('Invalid Worker task');
    const thread=createWorker();
    probe.threads.push({threadStage:'created',task});
    thread.postMessage({memory,task,module});return 1;
  },
  console_write(ptr, length) {
    probe.console = (probe.console + new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length).slice())).slice(-20000);
  },
  create_surface(width, height) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const id = nextSurface++; surfaces.set(id, canvas); return id;
  },
  create_window(title, width, height) {
    probe.windows.push({title, width, height});
    gameWindow = document.createElement('canvas'); gameWindow.width = width; gameWindow.height = height;
    listenInput(gameWindow);
    container.append(gameWindow); return 1;
  },
  resize_window(id, width, height) { probe.windows.push({resize: id, width, height}); gameWindow.width = width; gameWindow.height = height; },
  render(id, surface) {
    const began=performance.now();
    gameWindow.getContext('2d').drawImage(surfaces.get(surface), 0, 0);
    const elapsed=performance.now()-began;probe.drawTiming.presents++;probe.drawTiming.presentMs+=elapsed;probe.drawTiming.maxPresentMs=Math.max(probe.drawTiming.maxPresentMs,elapsed);
    const now=Date.now(),timing=probe.renderTiming||={windowStartedAt:now,windowFrames:0,maxIntervalMs:0};
    if(timing.lastRenderAt){timing.lastIntervalMs=now-timing.lastRenderAt;timing.maxIntervalMs=Math.max(timing.maxIntervalMs,timing.lastIntervalMs);}
    timing.lastRenderAt=now;timing.windowFrames++;
    if(now-timing.windowStartedAt>=1000){timing.framesPerSecond=Math.round(1000*timing.windowFrames/(now-timing.windowStartedAt));timing.windowStartedAt=now;timing.windowFrames=0;}
    probe.renders++;if(probe.renders===1){const stage={stage:'first-frame'};probe.stages.push(stage);onStatus(stage);}
  },
  set_pixels(id, ptr, length) {
    const canvas = surfaces.get(id);
    if(length!==canvas.width*canvas.height*4)throw Error('Original surface pixel length mismatch');
    const began=performance.now();
    if(!framePixels||framePixels.width!==canvas.width||framePixels.height!==canvas.height)framePixels=new ImageData(canvas.width,canvas.height);
    // putImageData copies synchronously, so one owned buffer can be reused
    // across surfaces. This avoids allocating another full frame each upload.
    framePixels.data.set(new Uint8ClampedArray(memory.buffer,ptr,length));
    canvas.getContext('2d').putImageData(framePixels,0,0);
    const elapsed=performance.now()-began;probe.drawTiming.uploads++;probe.drawTiming.uploadMs+=elapsed;probe.drawTiming.maxUploadMs=Math.max(probe.drawTiming.maxUploadMs,elapsed);return 1;
  },
  poll_message() { return pollInput(); },
  wait_message() { const queued=pollInput();return queued[0]===-1?new Promise(resolve=>{if(inputWaiter)throw Error('Duplicate input waiter');inputWaiter=resolve;}):queued; },
  write_file(path, ptr, length) {
    if(!Number.isInteger(ptr)||!Number.isInteger(length)||ptr<0||length<0||length>262144||ptr+length>memory.buffer.byteLength)throw Error('Invalid saved-file span');
    const bytes=new Uint8Array(memory.buffer,ptr,length).slice();
    probe.writes.push({path,length});return Promise.resolve(saveFile(path,bytes)).then(()=>1);
  },
  async read_file(path, offset, ptr, length) {
    const startedAt=Date.now(),rendersAtRead=probe.renders;
    const bytes = await reader.read(path, offset, length);
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    probe.resourceReads.push({path, offset, requested: length, read: bytes.length,startedAt,durationMs:Date.now()-startedAt,rendersAtRead});
    if (probe.resourceReads.length > 200) probe.resourceReads.shift();
    return [1, bytes.length];
  }
};
function createWorker(){
 const worker = new Worker(new URL('original-worker.mjs',baseURL), {type: 'module'});
 workers.add(worker);
 worker.onmessage = ({data}) => {
  if(data.diagnostic){(probe.diagnostics||=[]).push(data.diagnostic);if(probe.diagnostics.length>20)probe.diagnostics.shift();return;}
  if(data.programProgress){probe.programProgress=data.programProgress;return;}
  if(data.programDownload){probe.programDownload=data.programDownload;return;}
  if(data.threadStage){probe.threads.push(data);if(data.threadStage==='finished')workers.delete(worker);return;}
  if (data.stage) { if(data.stage==='failed'){fail('failed',data.error,data);return;}probe.stages.push(data); onStatus(data);return; }
  if (data.fileProbes) {probe.fileProbes = data.fileProbes; return;}
  const {func, args, retAddr} = data;
  probe.calls.push(func); if (probe.calls.length > 200) probe.calls.shift();
  try {
    if (!methods[func]) throw Error('Unsupported browser host call: ' + func);
    const result = methods[func](...args);
    if (retAddr) Promise.resolve(result).then(value => reply(retAddr, value)).catch(error => {
      fail('host-failed',error);
    });
  } catch (error) { fail('host-failed',error); }
};
 worker.onerror = event => fail('worker-error',event.message,{filename:event.filename,line:event.lineno,column:event.colno});
 return worker;
}
const worker=createWorker();
let started=false;
const start=async()=>{
  if(started)throw Error('Original program already started');started=true;
  try {
    probe.stages.push({stage:'starting-audio'});onStatus({stage:'starting-audio'});
    const audio = await createOriginalAudioHost(memory, new URL('pcm-worklet.js',baseURL).href, probe.audio);
    Object.assign(methods, audio);closeAudio=audio.close;resumeOutput=audio.resumeOutput;
    if(await resourceCache.ready()){
      const stage={stage:'preloading-resources'};probe.stages.push(stage);onStatus(stage);
      // Full installation is opt-in. The pinned common-resource plan keeps the
      // original byte ranges and leaves other assets to bounded on-demand reads.
      const complete=await reader.preload(preloadMode==='complete'?null:preloadAssets,progress=>{probe.resourcePreload={...progress,mode:preloadMode,scope:preloadMode==='complete'?'complete immutable original archives':'common original startup and duel resources; other assets remain on demand'};return probe.resourceCache.available&&!stopped;});
      probe.resourcePreload.complete=complete;
      if(!complete)probe.resourcePreload.skipped='Resource storage became unavailable';
    }else probe.resourcePreload={skipped:'Resource storage unavailable'};
    probe.stages.push({stage:'loading-saves'});onStatus({stage:'loading-saves'});
    const initialFiles=await loadFiles();
    probe.stages.push({stage:'loading-program'});onStatus({stage:'loading-program'});
    worker.postMessage({memory,manifest,program,initialFiles,traceSpec});
  } catch (error) {fail('host-failed',error);throw error;}
};
const pressKey=code=>{
 const key={Enter:[28,13,0],Escape:[1,27,0],Space:[57,32,0]}[code];
 if(!key)throw Error('Unsupported toolbar key');
 enqueue([5,...key]);setTimeout(()=>enqueue([6,...key]),100);
};
const rightClick=()=>{const point=[...position];enqueue([2,...point,4|((held|4)<<16)]);setTimeout(()=>enqueue([3,...point,4|(held<<16)]),100);};
let shutdown;
const stop=()=>shutdown||(shutdown=(async()=>{stopped=true;terminateWorkers();reader.close();if(closeAudio)await closeAudio();await resourceCache.close();})());
return {probe,start,stop,pressKey,rightClick,resumeAudio};
}
