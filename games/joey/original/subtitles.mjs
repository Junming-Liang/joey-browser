import {SUBTITLE_CATALOG} from './subtitle-catalog.mjs';

// All deadlines use the PCM consumer's frame counter, including suspension and underruns.
export function createOriginalSubtitleHost({audio,onChange=()=>{},enabled=false,probe={},catalog=SUBTITLE_CATALOG}) {
  const streams=new Map();let closed=false,timer=0,sequence=0,last='';
  Object.assign(probe,{events:0,starts:0,ends:0,missingText:0,unknownVoice:0,invalid:0,overflow:0,callbackErrors:0,queued:0,active:0,enabled:!!enabled});
  const valid=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
  const delta=(a,b)=>(a-b)|0;
  const counts=()=>{probe.queued=0;probe.active=0;for(const stream of streams.values()){probe.queued+=stream.events.length;probe.active+=stream.active.size;}};
  function publish(value){
    const next=value?{visible:true,zh:value.zh,en:value.en,voiceId:value.voiceId}:{visible:false,zh:'',en:'',voiceId:0};
    const key=JSON.stringify(next);if(key===last)return;last=key;
    try{onChange(next);}catch{probe.callbackErrors++;}
  }
  function tick(){
    timer=0;if(closed)return;
    let current=null,pending=false;
    for(const [id,stream] of streams){
      let clock;try{clock=audio.getPlaybackClock(id);}catch{clock=null;}
      if(!clock){streams.delete(id);continue;}
      stream.events.sort((a,b)=>delta(a.frame,b.frame)||a.order-b.order);
      const future=[];
      for(const event of stream.events){
        const elapsed=delta(clock.readFrame,event.frame);
        // A start frame denotes the first sample, so at least one sample must be consumed.
        if(elapsed<0||(event.kind===1&&elapsed===0)){future.push(event);continue;}
        if(event.kind===1){
          stream.active.set(event.instance,event);
          if(stream.active.size>8){probe.overflow++;stream.active.clear();}
        }else {
          stream.active.delete(event.instance);
          // Different guest Workers can post asynchronously; an already consumed end
          // also retires a start that has not reached this page yet.
          stream.lastInstance=Math.max(stream.lastInstance,event.instance);
        }
      }
      stream.events=future;
      for(const event of stream.active.values())if(!current||event.order>current.order)current=event;
      pending||=!!stream.events.length||!!stream.active.size;
    }
    const caption=current&&catalog[current.voiceId];
    publish(enabled&&caption?.verified===true&&caption.en&&caption.zh?{...caption,voiceId:current.voiceId}:null);
    counts();if(pending)timer=requestAnimationFrame(tick);
  }
  function update(){if(timer)cancelAnimationFrame(timer);tick();}
  return {
    subtitle_event(streamId,kind,voiceId,instance,targetFrame){
      if(closed)return 1;
      if(![streamId,voiceId,instance,targetFrame].every(valid)||streamId===0||![1,2,3].includes(kind)||kind!==3&&instance===0){probe.invalid++;return 1;}
      probe.events++;
      if(kind===3){streams.delete(streamId);update();return 1;}
      let stream=streams.get(streamId);
      if(!stream){if(streams.size>=4){probe.overflow++;return 1;}stream={events:[],active:new Map(),lastInstance:0};streams.set(streamId,stream);}
      if(kind===1){
        if(!catalog[voiceId]){probe.unknownVoice++;return 1;}
        if(instance<=stream.lastInstance){probe.invalid++;return 1;}
        stream.lastInstance=instance;probe.starts++;
        const caption=catalog[voiceId];if(caption.verified!==true||!caption.en||!caption.zh)probe.missingText++;
      }else probe.ends++;
      if(stream.events.length>=64){probe.overflow++;stream.events=[];stream.active.clear();publish(null);counts();return 1;}
      stream.events.push({kind,voiceId,instance,frame:targetFrame,order:++sequence});
      update();return 1;
    },
    setEnabled(value){if(closed)return;enabled=!!value;probe.enabled=enabled;update();},
    close(){if(closed)return;closed=true;if(timer)cancelAnimationFrame(timer);timer=0;streams.clear();counts();publish(null);}
  };
}
