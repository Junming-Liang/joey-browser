// One producer (the page), one consumer (the audio rendering thread).
// Header words: read frame, write frame, missing frames, enabled.
class OriginalPcmProcessor extends AudioWorkletProcessor {
  constructor({processorOptions: {buffer, channels, capacity}}) {
    super();
    if (![1, 2].includes(channels) || capacity < 128 || (capacity & (capacity - 1))) throw Error('Invalid PCM ring');
    this.header = new Int32Array(buffer, 0, 4);
    this.samples = new Int16Array(buffer, 16);
    if (this.samples.length !== channels * capacity) throw Error('Invalid PCM storage');
    this.channels = channels; this.capacity = capacity;
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (output.length !== this.channels) throw Error('Unexpected output channel count');
    for (const channel of output) channel.fill(0);
    if (!Atomics.load(this.header, 3)) return true;
    const read = Atomics.load(this.header, 0) >>> 0, write = Atomics.load(this.header, 1) >>> 0;
    const available = (write - read) >>> 0;
    if (available > this.capacity) throw Error('PCM ring ownership violated');
    const frames = output[0].length, take = Math.min(frames, available);
    for (let frame = 0; frame < take; frame++) {
      const index = ((read + frame) & (this.capacity - 1)) * this.channels;
      for (let channel = 0; channel < this.channels; channel++) output[channel][frame] = this.samples[index + channel] / 32768;
    }
    Atomics.store(this.header, 0, (read + take) | 0);
    if (take < frames) Atomics.add(this.header, 2, frames - take);
    return true;
  }
}
registerProcessor('joey-original-pcm', OriginalPcmProcessor);
