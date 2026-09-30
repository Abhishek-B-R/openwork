import { createContext, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { coworkerCall, openCallSettings } from "@/lib/realtime-call";
import { useCallState } from "@/ui/voice-call";
import type { VoiceExpectation, VoiceReply } from "@/lib/voice";

export const VoiceContext = createContext<{ accountKey: string; openModels: () => void; signIn: () => void } | null>(null);
export type VoicePreparation = { accountKey: string; origin: HTMLElement | null; field: HTMLTextAreaElement | null; isCurrent: () => boolean };
export type VoiceActivation = { accountKey: string; scope: string; focus: { origin: HTMLElement; target: "panel" | "draft"; start: number; end: number } | null };

/** Composer and phone use one Realtime controller, native admission path and secure key. */
export function useVoice({ active, person, threadId, prepare, groupId }: {
  active: boolean; scope: string; person?: CoworkerSummary; threadId?: string; prepare?: () => Promise<string>; groupId?: string;
  onTranscript: (text: string) => void; reply?: VoiceReply | null; endedTurn?: string | null;
  onReady?: (request: VoicePreparation) => Promise<void>; activation?: VoiceActivation; onActivationHandled?: () => void;
}) {
  const state = useCallState();
  const fieldRef = useRef<HTMLTextAreaElement | null>(null); const toggleRef = useRef<HTMLButtonElement | null>(null); const panelRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false); const [checking, setChecking] = useState(true); const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");
  const live = useRef({ active, person, threadId, prepare, groupId }); live.current = { active, person, threadId, prepare, groupId };
  useEffect(() => {
    let current = true;
    const read = () => void coworkerBridge.calls.settings().then((settings) => { if (current) { setReady(settings.keySet && settings.enabled); setChecking(false); } }).catch(() => { if (current) { setReady(false); setChecking(false); } });
    read(); window.addEventListener("coworker:call-settings-changed", read);
    return () => { current = false; window.removeEventListener("coworker:call-settings-changed", read); };
  }, []);
  const enabled = coworkerCall.isActive() && state.target?.slug === person?.slug && state.target?.threadId === threadId && state.target?.groupId === groupId;
  async function toggle() {
    if (!active || busy || !person) return;
    if (enabled) { coworkerCall.end(); return; }
    if (!ready) { openCallSettings(); return; }
    if (coworkerCall.isActive()) { coworkerCall.show(); return; }
    // Request in this click handler so preload sees transient user activation. Main gates on the key.
    const permission = coworkerBridge.calls.microphone().catch(() => ({ granted: false }));
    setBusy(true); setStatus("");
    const identity = `${person.slug}:${person.createdAt}:${threadId ?? "new"}:${groupId ?? ""}`;
    try {
      const id = threadId || await prepare?.(); const latest = live.current;
      if (!latest.active || `${latest.person?.slug}:${latest.person?.createdAt}:${latest.threadId ?? "new"}:${latest.groupId ?? ""}` !== identity) return;
      if (id) await coworkerCall.start(person, id, permission, { inline: true, groupId });
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Voice could not start. Try again."); }
    finally { setBusy(false); }
  }
  // The shared call adapter owns replies; there is no separate TTS queue.
  const expectReply = (_id: string | null): VoiceExpectation | null => null;
  const rebindExpected = (_intent: VoiceExpectation | null, _id: string): VoiceExpectation | null => null;
  const abandonReply = (_intent: VoiceExpectation | null) => {};
  const stop = (_note = "", _focus = false) => {};
  return { enabled, ready, checking, busy, phase: enabled ? state.phase : "idle", status: status || (enabled ? state.error : ""), fieldRef, panelRef, toggleRef, toggle, expectReply, rebindExpected, abandonReply, stop };
}
export type VoiceController = ReturnType<typeof useVoice>;
