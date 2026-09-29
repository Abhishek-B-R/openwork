import { useEffect, useState } from "react";
import { coworkerBridge } from "@/lib/bridge";
import { CALL_VOICES } from "@/lib/call";
import { Button, ErrorNote } from "@/ui/kit";
export function VoiceCallSettings() {
  const [settings, setSettings] = useState<{ keySet: boolean; voice: string } | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { let current = true; void coworkerBridge.calls.settings().then((value) => { if (current) setSettings(value); }).catch(() => { if (current) setError("Call settings could not be loaded. Try reopening Settings."); }); return () => { current = false; }; }, []);
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); setMessage(""); try { await action(); window.dispatchEvent(new Event("coworker:call-settings-changed")); } catch (cause) { setError(cause instanceof Error ? cause.message : "That change could not be saved."); } finally { setBusy(false); } }
  const enter = () => run(async () => { setSettings(await coworkerBridge.calls.editKey()); });
  return <div className="space-y-5" data-testid="voice-call-settings">
    <p className="text-sm leading-relaxed text-snow">Call your coworker with your own OpenAI API key. Calls use this key and bill your OpenAI account. Your conversation keeps using its chosen AI model.</p>
    <div className="space-y-3 rounded-2xl border border-line bg-panel/45 p-5">
      <label className="block space-y-2"><span className="text-xs font-medium text-mist">OpenAI API key</span><input type="password" readOnly value={settings?.keySet ? "••••••••••••••••" : ""} placeholder="Add your key securely" aria-label="OpenAI API key · opens secure entry" onClick={() => { if (!busy) void enter(); }} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !busy) { event.preventDefault(); void enter(); } }} className="w-full cursor-pointer rounded-xl border border-line bg-ink px-3 py-2.5 text-sm" /></label>
      <p className="text-xs leading-relaxed text-mist">Enter your key in the secure system window. It is stored on this computer for calls only.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void enter()}>{settings?.keySet ? "Replace key" : "Add key"}</Button><Button disabled={busy || !settings?.keySet} onClick={() => void run(async () => { setMessage((await coworkerBridge.calls.test()).message); })}>Test</Button><Button disabled={busy || !settings?.keySet} variant="ghost" onClick={() => void run(async () => { setSettings(await coworkerBridge.calls.removeKey()); })}>Remove</Button></div>
    </div>
    <label className="block space-y-2"><span className="text-xs font-medium text-mist">Call voice</span><select disabled={busy || !settings?.keySet} value={settings?.voice ?? "marin"} onChange={(event) => { const voice = event.target.value; void run(async () => { setSettings(await coworkerBridge.calls.setVoice(voice)); }); }} className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm text-snow disabled:opacity-40">{CALL_VOICES.map((voice) => <option key={voice} value={voice}>{voice[0]?.toUpperCase()}{voice.slice(1)}</option>)}</select><span className="block text-xs text-mist">{settings?.keySet ? "Applies to your next call." : "Add a key to enable voice calls."}</span></label>
    {busy ? <p role="status" className="text-xs text-mist">Working…</p> : null}{message ? <p role="status" className="text-sm text-spark">{message}</p> : null}{error ? <ErrorNote>{error}</ErrorNote> : null}
  </div>;
}
