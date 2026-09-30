import { useEffect, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { CALL_VOICES } from "@/lib/call";
import { coworkerCall } from "@/lib/realtime-call";

export function CoworkerVoiceSettings({ person, onChanged }: { person: CoworkerSummary; onChanged: (person: CoworkerSummary) => void }) {
  const [enabled, setEnabled] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const read = () => void coworkerBridge.calls.settings().then((settings) => { if (current) setEnabled(settings.keySet && settings.enabled); }).catch(() => { if (current) setEnabled(false); });
    read(); window.addEventListener("coworker:call-settings-changed", read);
    return () => { current = false; window.removeEventListener("coworker:call-settings-changed", read); };
  }, []);
  if (!enabled) return null;
  return <section className="space-y-2 border-t border-line/60 pt-4" data-testid="coworker-voice-settings">
    <label className="flex items-center justify-between gap-3 text-sm text-snow"><span>Voice</span><select aria-label={`${person.name}'s voice`} disabled={busy} value={person.realtimeVoice ?? ""} className="min-w-0 rounded-xl border border-line bg-panel px-3 py-2 text-sm" onChange={(event) => {
      const voice = event.target.value; setBusy(true); setError("");
      void coworkerBridge.calls.personVoice(person.slug, person.createdAt, voice).then(onChanged).catch(() => setError("The voice could not be saved. Try again.")).finally(() => setBusy(false));
    }}><option value="">App default</option>{CALL_VOICES.map((voice) => <option key={voice} value={voice}>{voice[0]?.toUpperCase()}{voice.slice(1)}</option>)}</select></label>
    <p className="text-xs text-mist">Used in chat and Call mode.{coworkerCall.isActive() ? " Your current session keeps its voice; this applies next time." : " Takes effect on the next voice session."}</p>
    {error ? <p role="alert" className="text-xs text-rose">{error}</p> : null}
  </section>;
}
