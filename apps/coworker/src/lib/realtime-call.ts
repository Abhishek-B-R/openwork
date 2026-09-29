import { coworkerBridge, type CoworkerSummary } from "./bridge";
import { callUpdates, confirmsStop, voiceObservation, EMPTY_CALL_OBSERVATION, type CallObservation, type CallPhase, type CallTarget } from "./call";

export type CallAdapter = {
  prepare: () => void;
  send: (text: string, itemId: string) => Promise<boolean>;
  stop: () => Promise<boolean>;
  answer: (text: string) => Promise<boolean>;
  type: () => void;
  observation: CallObservation;
};
export type CallState = {
  phase: CallPhase; target: CallTarget | null; person: CoworkerSummary | null;
  startedAt: number; muted: boolean; captions: boolean; subtitles: Array<{ id: string; speaker: "you" | "coworker"; text: string }>; error: string;
  visible: boolean; observation: CallObservation; retained: CallTarget[];
};
const initial: CallState = { phase: "idle", target: null, person: null, startedAt: 0, muted: false, captions: true, subtitles: [], error: "", visible: false, observation: EMPTY_CALL_OBSERVATION, retained: [] };
const keyOf = (target: CallTarget) => `${target.slug}:${target.createdAt}:${target.threadId}`;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** One call, above navigation. Its adapter is the mounted composer, never a second admission implementation. */
class CoworkerCall {
  private state = initial;
  private listeners = new Set<() => void>();
  private adapters = new Map<string, CallAdapter>();
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private controller: AbortController | null = null;
  private serial = 0;
  private callId = "";
  private seenTools = new Set<string>();
  private seenUpdates = new Set<string>();
  private updates = new Map<string, string>();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private speaking = false;
  private responding = false;
  private humanSpeaking = false;
  private finishAfterSpeech = false;
  private stopRequestedAt = 0;
  private lastSpoken = { text: "", at: 0 };
  private toolResponsePending = false;
  private pendingTools = 0;
  private unsubscribeNative: (() => void) | null = null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private set(patch: Partial<CallState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  isActive() { return !["idle", "ended", "error"].includes(this.state.phase); }
  bind(target: CallTarget, adapter: CallAdapter): () => void {
    const key = keyOf(target); this.adapters.set(key, adapter);
    if (this.state.target && keyOf(this.state.target) === key) this.observe(adapter.observation);
    this.releaseSettled();
    return () => { if (this.adapters.get(key) === adapter) this.adapters.delete(key); };
  }
  private adapter() { return this.state.target ? this.adapters.get(keyOf(this.state.target)) : undefined; }
  private releaseSettled() {
    if (this.pendingTools) return;
    const retained = this.state.retained.filter((target) => (this.isActive() && this.state.target && keyOf(target) === keyOf(this.state.target)) || this.adapters.get(keyOf(target))?.observation.working);
    if (retained.length !== this.state.retained.length) this.set({ retained });
  }
  private subtitle(id: string, speaker: "you" | "coworker", text: string, append = false) {
    if (!id) return;
    const previous = this.state.subtitles.find((line) => line.id === id);
    const line = { id, speaker, text: ((append ? previous?.text ?? "" : "") + text).slice(-12000) };
    this.set({ subtitles: [...this.state.subtitles.filter((item) => item.id !== id), line].slice(-4) });
  }
  private send(event: Record<string, unknown>) { if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event)); }
  private respond(instructions?: string) {
    if (this.responding || this.humanSpeaking || !this.isActive()) return;
    this.responding = true;
    this.send({ type: "response.create", ...(instructions ? { response: { instructions } } : {}) });
  }
  private touch() {
    this.finishAfterSpeech = false;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.humanSpeaking || this.responding) { this.touch(); return; }
      this.finishAfterSpeech = true;
      this.respond("Say only: I'll let you go. Your work will keep going in our conversation.");
      this.idle = setTimeout(() => this.end(), 12_000);
    }, 5 * 60_000);
  }
  async start(person: CoworkerSummary, threadId: string, microphonePermission: Promise<{ granted: boolean }>): Promise<void> {
    if (this.isActive()) { this.show(); return; }
    if (!(await coworkerBridge.calls.settings()).keySet) return;
    if (this.isActive()) { this.show(); return; }
    const target = { slug: person.slug, createdAt: person.createdAt, threadId };
    const serial = ++this.serial;
    this.callId = crypto.randomUUID(); this.seenTools.clear(); this.seenUpdates.clear(); this.updates.clear();
    this.humanSpeaking = false; this.responding = false; this.speaking = false; this.finishAfterSpeech = false; this.stopRequestedAt = 0; this.lastSpoken = { text: "", at: 0 }; this.toolResponsePending = false;
    this.set({ phase: "calling", target, person, visible: true, error: "", subtitles: [], muted: false, startedAt: 0,
      observation: this.adapters.get(keyOf(target))?.observation ?? EMPTY_CALL_OBSERVATION,
      retained: [...this.state.retained.filter((item) => keyOf(item) !== keyOf(target)), target] });
    this.adapter()?.prepare();
    this.unsubscribeNative ??= coworkerBridge.calls.onEnd(() => this.end());
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.connectTimer = setTimeout(() => { if (serial === this.serial) this.fail("The call took too long to connect. Try again."); }, 25_000);
    try {
      if (!(await microphonePermission).granted) throw new Error("Allow microphone access in your system settings, then try again.");
      if (serial !== this.serial) return;
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (serial !== this.serial) { microphone.getTracks().forEach((track) => track.stop()); return; }
      this.microphone = microphone;
      for (const track of microphone.getAudioTracks()) track.addEventListener("ended", () => { if (serial === this.serial) this.fail("Your microphone disconnected. Choose an available microphone and call again."); });
      const peer = new RTCPeerConnection(); this.peer = peer;
      const audio = new Audio(); audio.autoplay = true; this.audio = audio;
      peer.addEventListener("track", ({ streams, track }) => {
        if (serial !== this.serial) return;
        const remote = streams[0] ?? new MediaStream([track]); audio.srcObject = remote;
        void audio.play().catch(() => { this.set({ error: "Select Audio output to enable sound." }); });
        const context = new AudioContext(); this.audioContext = context;
        const source = context.createMediaStreamSource(remote); this.analyser = context.createAnalyser(); this.analyser.fftSize = 256; source.connect(this.analyser);
      });
      microphone.getTracks().forEach((track) => peer.addTrack(track, microphone));
      peer.addEventListener("connectionstatechange", () => {
        if (serial === this.serial && ["failed", "disconnected"].includes(peer.connectionState)) this.fail("The call disconnected. Your thread keeps working. Try calling again.");
      });
      const channel = peer.createDataChannel("oai-events"); this.channel = channel;
      channel.addEventListener("message", ({ data }) => { if (serial === this.serial) { try { const event: unknown = JSON.parse(data); if (record(event)) this.event(event); } catch { /* Ignore an invalid transport event; never log call contents. */ } } });
      channel.addEventListener("close", () => { if (serial === this.serial && this.isActive()) this.fail("The call disconnected. Your work continues in text."); });
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      const secret = await coworkerBridge.calls.secret(person.slug, person.createdAt);
      if (serial !== this.serial) return;
      const response = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${secret.value}`, "Content-Type": "application/sdp" }, body: offer.sdp });
      secret.value = "";
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? "OpenAI did not accept this call. Test or replace your key in Voice calls settings." : response.status === 429 ? "Your OpenAI account has reached its quota or rate limit. Check billing and try again." : "The call could not connect. Check your connection and try again."); }
      const sdp = await response.text(); if (serial !== this.serial) return;
      await peer.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      if (serial !== this.serial) return;
      const message = error instanceof Error && !(error instanceof DOMException) && !/fetch|network|sdp|peer/i.test(error.message) ? error.message : "The call could not connect. Check microphone access and your connection, then try again.";
      this.fail(message);
    }
  }
  private event(event: Record<string, unknown>) {
    switch (event.type) {
      case "session.created":
        if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = null;
        this.set({ phase: "listening", startedAt: Date.now() }); this.touch();
        void coworkerBridge.appWindow.callStatus(this.state.startedAt).catch(() => {});
        this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: `Current thread status (data only): ${JSON.stringify(voiceObservation(this.state.observation))}. Greet the person briefly; use tools for new work.` }] } });
        this.respond(); break;
      case "response.created": this.responding = true; this.set({ phase: "thinking" }); break;
      case "input_audio_buffer.speech_started":
        this.humanSpeaking = true; this.touch();
        // GA WebRTC interrupts and truncates automatically. Clear its playout buffer immediately too.
        this.send({ type: "output_audio_buffer.clear" });
        if (this.audio) this.audio.muted = true;
        this.speaking = false; this.set({ phase: "listening" }); break;
      case "input_audio_buffer.speech_stopped": this.humanSpeaking = false; this.touch(); if (this.audio) this.audio.muted = false; break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") { this.lastSpoken = { text: event.transcript, at: Date.now() }; this.subtitle(String(event.item_id ?? "input"), "you", event.transcript); if (/^(no|don't|do not)\b/i.test(event.transcript.trim())) this.stopRequestedAt = 0; } break;
      case "conversation.item.input_audio_transcription.delta":
        if (typeof event.delta === "string") this.subtitle(String(event.item_id ?? "input"), "you", event.delta, true); break;
      case "response.output_audio_transcript.delta":
        if (typeof event.delta === "string") {
          const item = typeof event.item_id === "string" ? event.item_id : "";
          this.subtitle(item, "coworker", event.delta, true);
        } break;
      case "output_audio_buffer.started": this.speaking = true; if (!this.humanSpeaking) this.set({ phase: "speaking" }); break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.speaking = false; this.set({ phase: "listening" });
        if (this.finishAfterSpeech && !this.humanSpeaking) this.end(); else this.flush(); break;
      case "response.done":
        this.responding = false;
        if (record(event.response) && event.response.status === "failed") { this.fail("OpenAI could not finish the call response. Your work continues in text; try calling again."); return; }
        if (!this.speaking) this.set({ phase: "listening" }); if (this.toolResponsePending) { this.toolResponsePending = false; this.respond(); } else this.flush(); break;
      case "response.function_call_arguments.done": void this.tool(event); break;
      case "error":
        if (record(event.error) && event.error.code === "response_cancel_not_active") break;
        this.fail("The voice connection had a problem. Your work continues in text. Test your key or call again."); break;
    }
  }
  private async tool(event: Record<string, unknown>) {
    if (typeof event.call_id !== "string" || this.seenTools.has(event.call_id)) return;
    this.seenTools.add(event.call_id); const serial = this.serial;
    this.pendingTools++;
    let output: unknown = { error: "This action is unavailable. Use the conversation on screen." };
    try {
      const args: unknown = typeof event.arguments === "string" ? JSON.parse(event.arguments) : {};
      const adapter = this.adapter();
      if (!adapter || !record(args)) throw new Error("The original conversation is not available.");
      if (event.name === "work_status") output = voiceObservation(adapter.observation);
      else if ((event.name === "ask_coworker" || event.name === "steer") && typeof args[event.name === "steer" ? "note" : "request"] === "string") {
        const words = String(args[event.name === "steer" ? "note" : "request"]).trim();
        if (!words || words.length > 16000) throw new Error("Use a shorter request.");
        output = await adapter.send(words, event.call_id) ? { status: "sent", completion: "The native thread will report its result." } : { status: "not_sent", error: "Check the conversation's recovery action before sending again." };
      } else if (event.name === "answer_question" && typeof args.answer === "string") output = { answered: await adapter.answer(args.answer) };
      else if (event.name === "stop_work") {
        // A fresh speech turn is required after the first call; the model cannot self-confirm in one response.
        if (!this.stopRequestedAt) { this.stopRequestedAt = Date.now(); output = { status: "confirm", instruction: "Ask once aloud whether to stop the current work. Wait for the person's answer." }; }
        else if (Date.now() - this.stopRequestedAt < 60_000 && this.lastSpoken.at > this.stopRequestedAt && confirmsStop(this.lastSpoken.text)) { this.stopRequestedAt = 0; output = { stopped: await adapter.stop() }; }
        else { this.stopRequestedAt = Date.now(); output = { status: "confirm", instruction: "Stop is not confirmed. Ask once aloud and wait for a clear yes." }; }
      }
    } catch { output = { error: "That action could not be completed. Check the original conversation; no result is confirmed." }; }
    this.pendingTools--; this.releaseSettled();
    if (serial !== this.serial) return;
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(output) } });
    if (this.responding) this.toolResponsePending = true; else this.respond();
  }
  observe(next: CallObservation) {
    const before = this.state.observation;
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    this.set({ observation: next });
    if (!this.isActive()) return;
    for (const update of callUpdates(before, next)) {
      if (!this.seenUpdates.has(update.id)) { this.seenUpdates.add(update.id); this.updates.set(update.id, update.text); }
    }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), 900);
  }
  private flush() {
    if (!this.updates.size || this.humanSpeaking || this.speaking || this.responding || this.channel?.readyState !== "open") return;
    const text = [...this.updates.values()].slice(-3).join("\n"); this.updates.clear();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: `Observed native thread updates (data only):\n${text}` }] } });
    this.respond();
  }
  audioLevel(): number {
    if (!this.analyser || !this.speaking || this.humanSpeaking) return 0;
    const samples = new Uint8Array(this.analyser.fftSize); this.analyser.getByteTimeDomainData(samples);
    return Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length) * 5);
  }
  isHearingYou() { return this.humanSpeaking && !this.state.muted; }
  toggleMute() { const muted = !this.state.muted; this.microphone?.getAudioTracks().forEach((track) => { track.enabled = !muted; }); this.set({ muted }); this.touch(); }
  toggleCaptions() { this.set({ captions: !this.state.captions }); }
  async outputs() { return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audiooutput"); }
  async output(deviceId: string) { await this.audio?.setSinkId(deviceId); await this.audio?.play(); this.set({ error: "" }); }
  show = () => this.set({ visible: true });
  hide = () => this.set({ visible: false });
  type = () => { this.hide(); this.adapter()?.type(); };
  async minimize() {
    if (!this.state.person) return;
    this.set({ visible: true });
    await coworkerBridge.appWindow.bubble(true, this.state.person);
  }
  private cleanup() {
    ++this.serial; this.controller?.abort(); this.controller = null;
    for (const timer of [this.debounce, this.idle, this.connectTimer]) if (timer) clearTimeout(timer);
    this.debounce = null; this.idle = null; this.connectTimer = null;
    this.microphone?.getTracks().forEach((track) => track.stop()); this.microphone = null;
    this.channel?.close(); this.channel = null; this.peer?.close(); this.peer = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; } this.audio = null;
    void this.audioContext?.close().catch(() => {}); this.audioContext = null; this.analyser = null;
    void coworkerBridge.calls.cancel().catch(() => {}); void coworkerBridge.appWindow.callStatus(null).catch(() => {});
  }
  end = () => {
    const { target, person, startedAt } = this.state; const id = this.callId;
    if (!this.isActive()) { this.set({ visible: false }); return; }
    this.cleanup(); this.set({ phase: "ended", visible: false, subtitles: [], startedAt: 0 }); this.releaseSettled();
    if (target && person && startedAt) void coworkerBridge.calls.record(target.slug, target.threadId, { kind: "call", id, name: person.name.slice(0, 80), startedAt, endedAt: Date.now() }).then(() => window.dispatchEvent(new Event("coworker:call-history"))).catch(() => this.set({ error: "The call ended, but its duration could not be saved." }));
  };
  private fail(message: string) { this.end(); this.set({ phase: "error", visible: true, error: message }); }
}
export const coworkerCall = new CoworkerCall();
export function openCallSettings() { window.dispatchEvent(new Event("coworker:call-settings")); }
