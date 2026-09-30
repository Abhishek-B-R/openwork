import type { VoiceController } from "@/ui/use-voice";
import { coworkerCall, openCallSettings } from "@/lib/realtime-call";
import { callDuration } from "@/lib/call";
import { useCallState } from "@/ui/voice-call";
import { useEffect, useState } from "react";

function VoiceIcon() { return <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 8v4m3-7v10m4-13v16m4-13v10m3-7v4" /></svg>; }
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/60 motion-reduce:transition-none";
export function VoiceToggle({ voice, disabled = false }: { voice: VoiceController; disabled?: boolean }) {
  const title = voice.checking ? "Checking voice settings…" : !voice.ready ? "Add an OpenAI key and enable voice in Settings › OpenAI" : voice.enabled ? "End voice conversation" : "Talk in this chat";
  return <button ref={voice.toggleRef} type="button" aria-label="Voice mode" title={title} aria-pressed={voice.enabled} aria-busy={voice.busy} disabled={disabled || voice.checking || voice.busy} onClick={() => void voice.toggle()} data-testid="voice-toggle" className={`flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-40 ${focusRing} ${voice.enabled ? "border-spark/50 bg-spark/15 text-spark" : "border-line text-mist hover:border-spark/40 hover:text-snow"}`}><VoiceIcon /></button>;
}
export function VoicePanel({ voice }: { voice: VoiceController }) {
  const state = useCallState(); const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!voice.enabled) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [voice.enabled]);
  return <>
    {voice.enabled ? <div ref={voice.panelRef} role="group" aria-label="Realtime voice controls" className="mb-3 rounded-2xl border border-spark/25 bg-spark/5 p-3" data-testid="voice-panel" data-phase={voice.phase}>
      <div className="flex flex-wrap items-center gap-2 text-xs"><VoiceIcon /><span className="min-w-0 flex-1 text-snow" role="status">{state.muted ? "Microphone muted" : state.phase === "calling" ? "Connecting…" : state.phase === "speaking" ? "Speaking" : state.phase === "thinking" ? "Thinking" : "Listening"}{state.startedAt ? ` · ${callDuration(now - state.startedAt)}` : ""}</span>
        <button type="button" className={`rounded-full border border-line px-3 py-1.5 ${focusRing}`} aria-pressed={state.muted} onClick={() => coworkerCall.toggleMute()}>{state.muted ? "Unmute" : "Mute"}</button>
        <button type="button" className={`rounded-full border border-line px-3 py-1.5 ${focusRing}`} onClick={coworkerCall.show}>Call view</button>
        <button type="button" className={`rounded-full border border-line px-3 py-1.5 ${focusRing}`} onClick={coworkerCall.end}>End voice</button>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-mist">AI-generated voice · audio goes to OpenAI using your key. Transcripts and replay clips stay in this conversation on your computer. Ending voice lets work continue.</p>
    </div> : null}
    {voice.status ? <p role="status" className="mb-2 text-xs text-mist">{voice.status} <button type="button" className="underline" onClick={openCallSettings}>OpenAI settings</button></p> : null}
  </>;
}
