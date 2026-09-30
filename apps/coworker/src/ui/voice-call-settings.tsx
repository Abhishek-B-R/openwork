import { useEffect, useState } from "react";
import { coworkerBridge, type FastDecisionSettings } from "@/lib/bridge";
import { CALL_VOICES } from "@/lib/call";
import { Button, ErrorNote } from "@/ui/kit";

type CallSettings = Awaited<ReturnType<typeof coworkerBridge.calls.settings>>;
export function VoiceCallSettings() {
  const [settings, setSettings] = useState<CallSettings | null>(null);
  const [fast, setFast] = useState<FastDecisionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void Promise.allSettled([coworkerBridge.calls.settings(), coworkerBridge.fastDecisions.settings()]).then(([calls, decisions]) => {
      if (!current) return;
      if (calls.status === "fulfilled") setSettings(calls.value);
      if (decisions.status === "fulfilled") setFast(decisions.value);
      if (calls.status === "rejected" || decisions.status === "rejected") setError("Some OpenAI settings could not be loaded. Try reopening Settings.");
    });
    return () => { current = false; };
  }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(""); setMessage("");
    try {
      await action();
      const [calls, decisions] = await Promise.allSettled([coworkerBridge.calls.settings(), coworkerBridge.fastDecisions.settings()]);
      if (calls.status === "fulfilled") setSettings(calls.value);
      if (decisions.status === "fulfilled") setFast(decisions.value);
      if (calls.status === "rejected" || decisions.status === "rejected") setError("Some OpenAI settings could not be loaded. Try reopening Settings.");
      window.dispatchEvent(new Event("coworker:call-settings-changed"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That change could not be saved."); }
    finally { setBusy(false); }
  }
  const enter = () => run(() => coworkerBridge.calls.editKey());
  return <div className="space-y-5" data-testid="voice-call-settings">
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm"><span className="text-snow">OpenAI API key</span><span className="text-mist">{settings ? settings.keySet ? "Saved securely" : "No key saved" : "Checking…"}</span></div>
      <p className="text-xs leading-relaxed text-mist">Voice mode in chat and Call mode use this key on your computer. OpenAI bills audio usage separately from OpenWork. Transcripts and bounded replay clips are saved locally with the conversation.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !settings} onClick={() => void enter()}>{settings?.keySet ? "Replace key" : "Add key"}</Button><Button disabled={busy || !settings?.keySet} variant="ghost" onClick={() => void run(() => coworkerBridge.calls.removeKey())}>Remove key</Button></div>
      <span className="block text-xs text-mist">Key entry opens a masked system window.</span>
    </div>
    <div className="space-y-3 border-t border-line pt-4">
      <label className="flex items-center justify-between gap-3 text-sm text-snow"><span>Voice mode and calls</span><input type="checkbox" aria-label="Enable Voice mode and calls" checked={settings?.enabled ?? false} disabled={busy || !settings?.keySet} onChange={(event) => { const enabled = event.target.checked; void run(() => coworkerBridge.calls.setEnabled(enabled)); }} /></label>
      <p className="text-xs leading-relaxed text-mist">Audio calls use your OpenAI key. Audio and transcription usage are billed by OpenAI.</p>
      <div className="flex items-center gap-3"><label className="flex flex-1 items-center gap-3 text-xs text-mist"><span>Default voice</span><select disabled={busy || !settings?.keySet} value={settings?.voice ?? "marin"} onChange={(event) => { const voice = event.target.value; void run(() => coworkerBridge.calls.setVoice(voice)); }} className="min-w-0 flex-1 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-snow">{CALL_VOICES.map((voice) => <option key={voice} value={voice}>{voice[0]?.toUpperCase()}{voice.slice(1)}</option>)}</select></label><Button disabled={busy || !settings?.keySet || !settings.enabled} onClick={() => void run(async () => { setMessage((await coworkerBridge.calls.test()).message); })}>Test call</Button></div>
      <p className="text-xs text-mist">Choose a different voice in each coworker’s Settings once voice is enabled. Active sessions keep their current voice.</p>
    </div>
    <div className="space-y-3 border-t border-line pt-4">
      <label className="flex items-center justify-between gap-3 text-sm text-snow"><span>Fast decisions</span><input type="checkbox" aria-label="Enable Fast decisions" checked={fast?.enabled ?? false} disabled={busy || !fast} onChange={(event) => { const enabled = event.target.checked; if (fast) void run(() => coworkerBridge.fastDecisions.configure({ enabled, deadlineMs: fast.deadlineMs })); }} /></label>
      <p className="text-xs leading-relaxed text-mist">Uses Luna from your connected models to choose who replies to simple group requests. Usage follows that model connection.</p>
      <p className="text-xs text-mist">{fast ? fast.available ? "Luna connected · no separate key needed" : "Luna unavailable · using the existing facilitator. Check Available models." : "Checking Luna connection…"}</p>
      <div className="flex items-center gap-3"><label className="flex flex-1 items-center gap-3 text-xs text-mist"><span>Wait up to</span><select disabled={busy || !fast} value={fast?.deadlineMs ?? 2500} onChange={(event) => { const deadlineMs = Number(event.target.value); if (fast) void run(() => coworkerBridge.fastDecisions.configure({ enabled: fast.enabled, deadlineMs })); }} className="min-w-0 flex-1 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-snow"><option value={1000}>1 second</option><option value={2500}>2.5 seconds</option><option value={5000}>5 seconds</option></select></label><Button disabled={busy || !fast?.available || !fast.enabled} onClick={() => void run(async () => { setMessage((await coworkerBridge.fastDecisions.test()).message); })}>Test decision</Button></div>
      <details className="text-xs text-mist"><summary className="cursor-pointer">Technical details</summary><div className="space-y-2 pt-2"><p>Native model connection · {fast?.model ?? "gpt-6-luna"} · no reasoning · at most 64 output tokens · one request at a time. Your conversation keeps its chosen model.</p><p>The latest message and member roles go to the connected model provider. A timeout may still incur usage.</p>{fast?.last ? <p>Last attempt: {fast.last.outcome} · {fast.last.elapsedMs} ms{fast.last.costUsd !== undefined ? ` · reported $${fast.last.costUsd.toFixed(6)}` : ""}</p> : <p>No decision measured in this app session.</p>}</div></details>
    </div>
    {busy ? <p role="status" className="text-xs text-mist">Working…</p> : null}
    {message ? <p role="status" className="text-sm text-spark">{message}</p> : null}
    {error ? <ErrorNote>{error}</ErrorNote> : null}
  </div>;
}
