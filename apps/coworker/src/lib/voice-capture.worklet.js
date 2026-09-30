/* Audio stays on this device. Mono PCM is sent only to the local replay recorder. */
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = new Float32Array(2048);
    this.used = 0;
    this.port.onmessage = () => {
      if (this.used) this.port.postMessage(this.frames.slice(0, this.used));
      this.used = 0;
      this.port.postMessage("flushed");
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] / channels.length;
      this.frames[this.used++] = sample;
      if (this.used === this.frames.length) {
        this.port.postMessage(this.frames);
        this.frames = new Float32Array(2048);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor("coworker-voice-capture", VoiceCapture);
