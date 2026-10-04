// A bounded mailbox prevents a suspended offscreen thread accumulating PCM.
class TrackPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(4096); this.used = 0; this.sequence = 0; this.outstanding = 0;
    this.port.onmessage = () => { this.outstanding = Math.max(0, this.outstanding - 1); };
  }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0] || [];
    const frames = outputs[0]?.[0]?.length || 128;
    for (let i = 0; i < frames; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.samples[this.used++] = channels.length ? value / channels.length : 0;
      if (this.used === this.samples.length) {
        this.sequence++;
        if (this.outstanding < 4) {
          this.outstanding++;
          this.port.postMessage({ samples: this.samples, endFrame: currentFrame + i + 1, sequence: this.sequence }, [this.samples.buffer]);
        }
        this.samples = new Float32Array(4096); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('track-pcm', TrackPcmProcessor);
