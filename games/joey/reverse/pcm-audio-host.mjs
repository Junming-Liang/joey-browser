// The original DirectSound mixer submits signed 16-bit little-endian PCM.
// Playback advances on the audio thread; queue size never estimates wall time.
export async function createOriginalAudioHost(memory, workletUrl, report) {
  const session=navigator.audioSession,previousType=session?.type;
  const sessionState=()=>{report.sessionType=session?.type;report.sessionState=session?.state;};
  if(session){
    try{session.type='playback';}catch(error){report.sessionError=String(error);}
    sessionState();session.addEventListener('statechange',sessionState);
  }
  const context = new AudioContext({sampleRate: 44100, latencyHint: 'interactive'});
  const restoreSession=()=>{if(session){session.removeEventListener('statechange',sessionState);if(session.type==='playback')try{session.type=previousType;}catch{}}};
  // Call resume within the initiating user gesture, before awaiting module I/O.
  const resumed = context.resume();
  try {
    await Promise.all([resumed, context.audioWorklet.addModule(workletUrl)]);
    if (context.sampleRate !== 44100 || context.state !== 'running') throw Error('Original PCM device rate/state unavailable');
  } catch (error) {await context.close();restoreSession();throw error;}
  report.contextRate = context.sampleRate; report.contextState = context.state;
  context.onstatechange = () => {report.contextState = context.state;};
  const streams = new Map(); let nextId = 1;
  const resumeOutput=async()=>{await context.resume();report.contextState=context.state;sessionState();if(context.state!=='running')throw Error('Original PCM device remains suspended');};
  const get = id => {
    const stream = streams.get(id);
    if (!stream || stream.failed || context.state === 'closed') throw Error('Original PCM stream unavailable');
    return stream;
  };
  const queuedFrames = stream => {
    const read = Atomics.load(stream.header, 0) >>> 0, write = Atomics.load(stream.header, 1) >>> 0;
    const count = (write - read) >>> 0;
    if (count > stream.capacity) throw Error('PCM ring capacity violated');
    return count;
  };
  return {
    resumeOutput,
    create_audio_stream(rate, channels) {
      if (rate !== context.sampleRate || ![1, 2].includes(channels)) throw Error('Unsupported original PCM format');
      const capacity = 8192, buffer = new SharedArrayBuffer(16 + capacity * channels * 2);
      const node = new AudioWorkletNode(context, 'joey-original-pcm', {numberOfInputs: 0, numberOfOutputs: 1,
        outputChannelCount: [channels], processorOptions: {buffer, channels, capacity}});
      const id = nextId++, stream = {node, channels, capacity, header: new Int32Array(buffer, 0, 4), samples: new Int16Array(buffer, 16), failed: false};
      node.onprocessorerror = () => {stream.failed = true; report.processorFailed = true;};
      node.connect(context.destination); streams.set(id, stream);
      report.streamsCreated = (report.streamsCreated || 0) + 1;
      return id;
    },
    audio_stream_is_open(id) {return [1, streams.has(id) && !streams.get(id).failed && context.state !== 'closed' ? 1 : 0];},
    audio_stream_queued_bytes(id) {
      const stream = get(id), frames = queuedFrames(stream);
      report.lastQueuedFrames = frames;
      report.playedFrames=Atomics.load(stream.header,0)>>>0;
      report.missingFrames = Atomics.load(stream.header, 2) >>> 0;
      return [1, frames * stream.channels * 2];
    },
    audio_stream_put_data(id, pointer, length) {
      const stream = get(id), frameBytes = stream.channels * 2;
      if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 0 || length < 0 ||
          pointer + length > memory.buffer.byteLength || length % frameBytes) throw Error('Invalid original PCM span');
      const frames = length / frameBytes;
      if (frames > stream.capacity - queuedFrames(stream)) throw Error('Original PCM queue overflow');
      const input = new DataView(memory.buffer, pointer, length), write = Atomics.load(stream.header, 1) >>> 0;
      let nonzero=0,peak=0;
      for (let frame = 0; frame < frames; frame++) {
        const index = ((write + frame) & (stream.capacity - 1)) * stream.channels;
        for (let channel = 0; channel < stream.channels; channel++) {
          const sample=input.getInt16(frame * frameBytes + channel * 2, true);
          stream.samples[index + channel]=sample;
          if(sample)nonzero++;peak=Math.max(peak,Math.abs(sample));
        }
      }
      // Publish only after every sample of the submitted span has been copied.
      Atomics.store(stream.header, 1, (write + frames) | 0);
      report.pcmBytes = (report.pcmBytes || 0) + length;
      report.nonzeroSamples=(report.nonzeroSamples||0)+nonzero;
      report.lastPeak=peak;report.peak=Math.max(report.peak||0,peak);
      return 1;
    },
    async audio_stream_resume(id) {
      const stream = get(id);
      await resumeOutput();
      Atomics.store(stream.header, 3, 1);report.enabled=true; return 1;
    },
    async close() {
      for (const stream of streams.values()) {Atomics.store(stream.header, 3, 0); stream.node.disconnect();}
      streams.clear(); await context.close();report.contextState=context.state;restoreSession();
    }
  };
}
