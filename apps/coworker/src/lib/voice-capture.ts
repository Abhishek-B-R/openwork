import worklet from "./voice-capture.worklet.js?url";

/** Bounded local replay clips. This does not send audio or request microphone access. */
export class VoiceCapture {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private prelude: Float32Array[] = [];
  private chunks: Float32Array[] | null = null;
  private samples = 0;
  private rate = 24000;
  private flush: (() => void) | null = null;
  private flushing: { chunks: Float32Array[]; samples: number } | null = null;
  private pendingStart: number | null = null;
  private closed = false;
  async connect(stream: MediaStream) {
    const context = new AudioContext({ sampleRate: 24000 }); this.context = context;
    try {
      await context.audioWorklet.addModule(worklet);
      if (this.closed) return;
      this.rate = context.sampleRate;
      const node = new AudioWorkletNode(context, "coworker-voice-capture"); this.node = node;
      node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (data === "flushed") { this.flush?.(); this.flush = null; return; }
        if (!(data instanceof Float32Array)) return;
        if (this.flushing && this.flushing.samples < this.rate * 60) {
          const chunk = data.slice(0, this.rate * 60 - this.flushing.samples);
          this.flushing.chunks.push(chunk); this.flushing.samples += chunk.length;
        }
        this.prelude.push(data);
        while (this.prelude.length > Math.ceil(this.rate * 2 / 2048)) this.prelude.shift();
        if (this.chunks && this.samples < this.rate * 60) {
          const chunk = data.slice(0, Math.min(data.length, this.rate * 60 - this.samples));
          this.chunks.push(chunk); this.samples += chunk.length;
        }
      };
      this.source = context.createMediaStreamSource(stream); this.source.connect(node);
      // The worklet has silent output; connecting keeps capture running without doubling playback.
      node.connect(context.destination); await context.resume();
      if (this.pendingStart !== null) this.begin(this.pendingStart);
    } catch { await this.close(); }
  }
  begin(preRollSeconds = 0.2) {
    this.pendingStart = preRollSeconds;
    if (!this.node) return;
    this.chunks = this.prelude.slice(-Math.ceil(this.rate * preRollSeconds / 2048));
    this.samples = this.chunks.reduce((count, chunk) => count + chunk.length, 0);
  }
  async finish(): Promise<string | undefined> {
    if (!this.chunks || !this.node || this.flush) return;
    const recording = { chunks: this.chunks, samples: this.samples };
    this.prelude = [];
    this.flushing = recording; this.chunks = null; this.samples = 0; this.pendingStart = null;
    // Flush the last partial block before encoding; cap the wait if the device suspended.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.flush = null; resolve(); }, 250);
      this.flush = () => { clearTimeout(timer); resolve(); }; this.node?.port.postMessage("flush");
    });
    const chunks = recording.chunks; const count = recording.samples; this.flushing = null;
    if (!chunks || !count) return;
    const bytes = new Uint8Array(44 + count * 2); const view = new DataView(bytes.buffer);
    for (const [offset, word] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] satisfies Array<[number, string]>) for (let i = 0; i < word.length; i++) bytes[offset + i] = word.charCodeAt(i);
    view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, this.rate, true); view.setUint32(28, this.rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, count * 2, true);
    let offset = 44;
    for (const chunk of chunks) for (const sample of chunk) { view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true); offset += 2; }
    let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
  async close() {
    this.closed = true; this.flush?.(); this.flush = null;
    this.source?.disconnect(); this.node?.disconnect(); if (this.node) this.node.port.onmessage = null;
    this.source = null; this.node = null; this.prelude = []; this.chunks = null;
    await this.context?.close().catch(() => {}); this.context = null;
  }
}
