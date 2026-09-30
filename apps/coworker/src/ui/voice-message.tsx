import { useEffect, useId, useRef, useState } from "react";
import { coworkerBridge } from "@/lib/bridge";
import { mergeVoiceTurns, type VoiceTurn } from "@/lib/call";
import { useCallState } from "@/ui/voice-call";
import "./voice-message.css";

export function useVoiceTurns(slug: string, threadId: string, saved: readonly VoiceTurn[]) {
  const state = useCallState();
  return mergeVoiceTurns(saved, state.target?.slug === slug && state.target.threadId === threadId ? state.turns : []);
}
function audioTime(seconds: number) {
  const whole = Math.floor(Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function VoiceMessage({ turn, slug, threadId, name: fallbackName, compact = false, active = true }: { turn: VoiceTurn; slug: string; threadId: string; name: string; compact?: boolean; active?: boolean }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerId = useId();
  const mounted = useRef(true);
  const player = useRef<HTMLAudioElement | null>(null);
  const activeRef = useRef(active);
  const expandedRef = useRef(expanded);
  activeRef.current = active;
  expandedRef.current = expanded;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; player.current?.pause(); }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { if (!active) player.current?.pause(); }, [active]);

  async function play() {
    if (loading || !active) return;
    if (playing) { player.current?.pause(); return; }
    setError("");
    if (url) {
      const audio = player.current;
      if (!audio) return;
      if (audio.ended) audio.currentTime = 0;
      try { await audio.play(); }
      catch { if (mounted.current) setError("Audio could not be played. The transcript is kept."); }
      return;
    }
    setLoading(true);
    try {
      const recording = await coworkerBridge.calls.audio(slug, threadId, turn.id);
      const bytes = Uint8Array.from(atob(recording.data), (character) => character.charCodeAt(0));
      if (mounted.current) setUrl(URL.createObjectURL(new Blob([bytes], { type: recording.mimeType })));
    } catch { if (mounted.current) setError("Audio could not be loaded. The transcript is kept."); }
    finally { if (mounted.current) setLoading(false); }
  }

  function togglePlayer() {
    if (expanded) {
      expandedRef.current = false;
      setExpanded(false);
      player.current?.pause();
    } else {
      expandedRef.current = true;
      setExpanded(true);
      void play();
    }
  }

  const you = turn.speaker === "you";
  const name = turn.name || fallbackName;
  const speaker = you ? "you" : name;
  const progress = duration > 0 ? Math.min(100, elapsed / duration * 100) : 0;
  const status = !turn.final ? you ? "Transcribing…" : "Speaking…" : turn.interrupted ? "Interrupted audio" : "Audio message";

  return <div className={`flex items-center gap-1.5 ${you ? "flex-row-reverse" : ""}`} data-testid="voice-message" data-speaker={turn.speaker} data-voice-id={turn.id} data-expanded={expanded}>
    <div className={`my-1 min-w-0 max-w-[min(85%,38rem)] rounded-2xl border px-4 py-3 ${you ? "border-spark/25 bg-spark/10" : "border-line bg-panel"}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 text-[11px] text-mist">
        <span className="font-medium text-snow">{you ? "You" : name}</span>
        {expanded || compact || !turn.final || turn.interrupted ? <span className="inline-flex items-center gap-1.5"><svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2 6v4m3-6v8m3-10v12m3-10v8m3-6v4" /></svg>{status}</span> : null}
      </div>
      {turn.audio && expanded ? <div id={playerId} className="voice-message-player mt-3 flex items-center gap-3" role="group" aria-label={`Audio from ${speaker}`}>
        <button type="button" disabled={loading || !active} onClick={() => void play()} className={`voice-message-play flex size-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${you ? "bg-spark text-white hover:bg-spark/80" : "bg-spark/15 text-spark hover:bg-spark/25"}`} aria-label={`${playing ? "Pause" : "Play"} audio from ${speaker}`} aria-busy={loading}>
          {loading ? <svg viewBox="0 0 20 20" className="size-4 animate-spin motion-reduce:animate-none" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="7" opacity=".25" /><path d="M10 3a7 7 0 0 1 7 7" strokeLinecap="round" /></svg> : <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden="true">{playing ? <path d="M5 4h3v12H5zm7 0h3v12h-3z" /> : <path d="M6 3.5a.8.8 0 0 1 1.2-.7l9 6.5a.9.9 0 0 1 0 1.4l-9 6.5a.8.8 0 0 1-1.2-.7z" />}</svg>}
        </button>
        <div className="min-w-0 flex-1">
          <div className="relative flex h-6 items-center">
            <div className="h-1 w-full overflow-hidden rounded-full bg-line" aria-hidden="true"><div className="h-full rounded-full bg-spark" style={{ width: `${progress}%` }} /></div>
            <input type="range" className="voice-message-seek absolute inset-0 m-0 w-full" min="0" max={duration || 1} step="0.05" value={Math.min(elapsed, duration)} disabled={!url || !duration || !active} aria-label={`Seek audio from ${speaker}`} aria-valuetext={`${audioTime(elapsed)} of ${audioTime(duration)}`} onChange={(event) => {
              if (player.current) { const seconds = Number(event.currentTarget.value); player.current.currentTime = seconds; setElapsed(seconds); }
            }} />
          </div>
          <div className="flex items-center justify-between gap-3 text-[10px] leading-4 text-mist">
            <span>{loading ? "Loading recording…" : url ? playing ? "Playing" : elapsed >= duration && duration > 0 ? "Replay recording" : "Voice recording" : "Play recording"}</span>
            <span className="shrink-0 tabular-nums" aria-hidden="true">{url && duration ? `${audioTime(elapsed)} / ${audioTime(duration)}` : ""}</span>
          </div>
        </div>
      </div> : null}
      {!compact ? <p className={`${turn.audio && expanded ? "mt-3 border-t border-line/60 pt-3" : "mt-2"} whitespace-pre-wrap text-sm leading-relaxed text-snow [overflow-wrap:anywhere]`} data-testid="voice-message-transcript">{turn.text || "Waiting for transcript…"}</p> : null}
      {turn.interrupted && !compact ? <p className="mt-1 text-[10px] text-mist">Transcript may include words whose audio was interrupted.</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-mist">{error}</p> : null}
      {url ? <audio ref={player} className="hidden" preload="metadata" src={url} onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
          if (activeRef.current && expandedRef.current) void audio.play().catch(() => { if (mounted.current) setError("Audio could not be played. The transcript is kept."); });
        }} onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)} onPlay={() => { if (!activeRef.current || !expandedRef.current) player.current?.pause(); else setPlaying(true); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setError("Audio could not be played. The transcript is kept."); }} /> : null}
    </div>
    {turn.audio ? <button type="button" className="voice-message-replay flex size-6 shrink-0 items-center justify-center rounded-full text-mist transition-colors hover:bg-panel-2 hover:text-snow disabled:opacity-30" aria-label={`${expanded ? "Collapse" : "Play"} audio from ${speaker}`} title={expanded ? "Hide playback controls" : "Play recording"} aria-expanded={expanded} aria-controls={expanded ? playerId : undefined} disabled={(!expanded && loading) || !active} onClick={togglePlayer}>
      <svg viewBox="0 0 20 20" className="size-3" aria-hidden="true">{expanded ? <path d="m5 12 5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M6 3.5a.8.8 0 0 1 1.2-.7l9 6.5a.9.9 0 0 1 0 1.4l-9 6.5a.8.8 0 0 1-1.2-.7z" fill="currentColor" />}</svg>
    </button> : null}
  </div>;
}
