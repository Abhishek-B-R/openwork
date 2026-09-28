import { useEffect, useEffectEvent, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { describeWorkerEvent, describeWorkerStatus, isLiveWorker, type WorkerEvent, type WorkerSummary } from "@/lib/workers";
import { useComposerDraft } from "@/ui/use-composer-draft";

/** Finished Workers stay beside the chat this long, so the outcome is seen instead of the row vanishing. */
export const RECENTLY_ENDED_MS = 10 * 60_000;

/** What a Worker last said about its work: its latest finding, or for one that ended, why. */
export type WorkerNote = { key: string; text: string; at: number; kind: "finding" | "decision" | "done" | "status" };

function noteKey(worker: WorkerSummary): string {
  return `${worker.status}:${worker.lastFindingAt ?? 0}:${worker.updatedAt}`;
}

function latestNote(events: readonly WorkerEvent[], worker: WorkerSummary): Omit<WorkerNote, "key"> | null {
  const finding = [...events].reverse().find((event) => event.kind === "finding" && event.text.trim());
  if (finding) return { text: finding.text.trim(), at: finding.at, kind: finding.report === "decision" ? "decision" : finding.report === "done" ? "done" : "finding" };
  if (isLiveWorker(worker)) return null;
  const status = [...events].reverse().find((event) => event.kind === "status" && event.text.trim());
  // The row already says how it ended; the note keeps only the why.
  const why = status?.text.trim().replace(/^(?:Didn't finish|Done|Stopped|Finished)[:.]\s*/i, "") ?? "";
  return status && why ? { text: why, at: status.at, kind: "status" } : null;
}

export function recentlyEnded(worker: WorkerSummary, now: number): boolean {
  return !isLiveWorker(worker) && worker.endedAt !== null && now - worker.endedAt < RECENTLY_ENDED_MS;
}

export type WorkerFeed = {
  workers: WorkerSummary[] | null;
  notes: Record<string, WorkerNote>;
  now: number;
  error: string;
  refresh: () => Promise<void>;
  changed: (worker: WorkerSummary) => void;
};

/**
 * One conversation's Workers, read while it is on screen: every 2 s while any
 * works, every 6 s otherwise. Each Worker's latest note is read only when its
 * record changed, and only for the Workers on show (`everyNote` for the full list).
 */
export function useWorkerFeed(coworker: CoworkerSummary, threadId: string, { enabled = true, everyNote = false }: { enabled?: boolean; everyNote?: boolean } = {}): WorkerFeed {
  const [workers, setWorkers] = useState<WorkerSummary[] | null>(null);
  const [notes, setNotes] = useState<Record<string, WorkerNote>>({});
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const request = useRef(0);
  const reading = useRef(false);
  const noteKeys = useRef(new Map<string, string>());
  const live = (workers ?? []).some(isLiveWorker);

  async function readNotes(shown: readonly WorkerSummary[], version: number) {
    for (const worker of shown) {
      const key = noteKey(worker);
      if (noteKeys.current.get(worker.id) === key) continue;
      try {
        const events = await coworkerBridge.workers.findings(coworker.slug, worker.id, 8);
        if (version !== request.current) return;
        noteKeys.current.set(worker.id, key);
        const note = latestNote(events, worker);
        setNotes((current) => {
          const next = { ...current };
          if (note) next[worker.id] = { key, ...note };
          else delete next[worker.id];
          return next;
        });
      } catch {
        // The row keeps its status line; the note returns with the next read.
      }
    }
  }

  async function refresh(): Promise<void> {
    if (!enabled || reading.current) return;
    reading.current = true;
    const version = ++request.current;
    try {
      const items = await coworkerBridge.workers.list(coworker.slug);
      if (version !== request.current) return;
      const mine = items.filter((worker) => worker.slug === coworker.slug && worker.spawnedFromThreadId === threadId);
      const at = Date.now();
      setWorkers(mine);
      setNow(at);
      setError("");
      await readNotes(everyNote ? mine : mine.filter((worker) => isLiveWorker(worker) || recentlyEnded(worker, at)), version);
    } catch (cause) {
      if (version === request.current) setError(`Task updates unavailable. Last known tasks are kept. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { reading.current = false; }
  }
  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    if (!enabled) return;
    void readLatest();
    const timer = window.setInterval(() => void readLatest(), live ? 2_000 : 6_000);
    return () => {
      request.current += 1;
      window.clearInterval(timer);
    };
  }, [enabled, live]);

  function changed(worker: WorkerSummary) {
    if (worker.slug !== coworker.slug || worker.spawnedFromThreadId !== threadId) return;
    // A list read begun before a confirmed action must not overwrite that action.
    request.current += 1;
    setWorkers((current) => current?.some((item) => item.id === worker.id) ? current.map((item) => item.id === worker.id ? worker : item) : [worker, ...(current ?? [])]);
  }

  return { workers, notes, now, error, refresh, changed };
}

/** Six dots taking turns, like a coding agent's subagent spinner; still when the Worker waits. */
export function WorkingDots({ className = "size-3.5", still = false }: { className?: string; still?: boolean }) {
  const dots: ReadonlyArray<readonly [number, number]> = [[2.5, 2.5], [7.5, 2.5], [7.5, 7], [7.5, 11.5], [2.5, 11.5], [2.5, 7]];
  return (
    <svg viewBox="0 0 10 14" className={`worker-dots shrink-0 ${still ? "worker-dots--still" : ""} ${className}`} aria-hidden="true" data-testid="worker-dots">
      {dots.map(([cx, cy], index) => <circle key={index} cx={cx} cy={cy} r="1.3" fill="currentColor" style={{ animationDelay: `${index * 0.13}s` }} />)}
    </svg>
  );
}

/** A Worker's state at a glance: dots while it works, a check when done, amber when it needs the person. */
export function WorkerGlyph({ worker, className = "size-3.5" }: { worker: WorkerSummary; className?: string }) {
  const needsPerson = isLiveWorker(worker) && (worker.control?.state === "needs-approval" || (worker.status === "waiting" && worker.waitingFor === "decision"));
  if (needsPerson) return <span className={`inline-flex shrink-0 items-center justify-center text-amber ${className}`} aria-hidden="true" data-testid="worker-glyph" data-state="attention"><span className="size-1.5 rounded-full bg-current" /></span>;
  if (worker.status === "running" || worker.status === "starting") return <span className="inline-flex shrink-0 text-snow/80" data-testid="worker-glyph" data-state="working"><WorkingDots className={className} /></span>;
  if (worker.status === "waiting" || worker.status === "paused") return <span className="inline-flex shrink-0 text-mist" data-testid="worker-glyph" data-state="waiting"><WorkingDots className={className} still /></span>;
  if (worker.status === "finished") return (
    <svg viewBox="0 0 14 14" className={`shrink-0 text-mint ${className}`} aria-hidden="true" data-testid="worker-glyph" data-state="done"><path d="m3 7.4 2.6 2.4L11 4.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
  );
  return <span className={`inline-flex shrink-0 items-center justify-center ${worker.status === "failed" ? "text-rose" : "text-mist"} ${className}`} aria-hidden="true" data-testid="worker-glyph" data-state="ended"><span className="h-px w-2 rounded-full bg-current" /></span>;
}

/** What a Worker is doing, in a few words: its latest note, else its first step or goal. */
function activityOf(worker: WorkerSummary, note: WorkerNote | undefined): string {
  if (note) return note.text;
  if (worker.status === "starting") return "Getting started";
  return isLiveWorker(worker) ? worker.goal : worker.error || worker.goal;
}

/**
 * The coworker's Workers in this conversation, the way a coding agent shows
 * its subagents: a small "Working 3" pill on the composer's edge; the list of
 * what each is doing above it; one Worker's own view in the same place. The
 * composer's width, never taller than a sheet.
 */
export function WorkerTray({ coworker, feed, openWorkerId, onOpenWorker, onCloseWorker, onOpenWorkersView }: {
  coworker: CoworkerSummary;
  feed: WorkerFeed;
  /** The Worker whose view is open (from its row, or a link in a reply). */
  openWorkerId: string;
  onOpenWorker: (workerId: string) => void;
  onCloseWorker: () => void;
  /** The full Workers view, where access is approved and work paused or resumed. */
  onOpenWorkersView?: () => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const all = feed.workers ?? [];
  const sheetWorker = openWorkerId ? all.find((worker) => worker.id === openWorkerId) ?? null : null;
  const items = all.filter((worker) => isLiveWorker(worker) || recentlyEnded(worker, feed.now));
  if (items.length === 0 && !sheetWorker) return null;
  const live = items.filter(isLiveWorker);
  const needsPerson = live.filter((worker) => worker.control?.state === "needs-approval" || (worker.status === "waiting" && worker.waitingFor === "decision")).length;
  const pillLabel = live.length > 0 ? "Working" : items.some((worker) => worker.status === "finished") ? "Done" : "Ended";
  const pillCount = live.length > 0 ? live.length : items.length;

  async function stopAll() {
    setStopping(true);
    try {
      for (const worker of live) {
        try { feed.changed(await coworkerBridge.workers.cancel(coworker.slug, worker.id, "Stopped by you from the Working list")); } catch { /* The next read shows what stopped. */ }
      }
    } finally {
      setStopping(false);
      setConfirmStop(false);
      void feed.refresh();
    }
  }

  return (
    <div className="mb-2 space-y-2" data-testid="coworker-worker-shelf" data-open={sheetWorker ? "worker" : listOpen ? "list" : "false"}>
      {sheetWorker ? (
        <WorkerSheet key={sheetWorker.id} coworker={coworker} worker={sheetWorker} onChanged={feed.changed} onClose={onCloseWorker} onOpenWorkersView={onOpenWorkersView} />
      ) : listOpen ? (
        <section aria-label={`${coworker.name}'s Workers`} className="rounded-2xl border border-line bg-panel/80 px-2 pb-1.5 pt-2.5 shadow-[0_12px_40px_rgb(0_0_0/0.3)] backdrop-blur-xl" data-testid="worker-list-panel">
          <div className="flex items-center gap-3 px-2 pb-1">
            <p className="flex-1 text-xs text-mist">{live.length > 0 ? "Working" : "Recently finished"}</p>
            {live.length > 0 ? (
              confirmStop ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-mist">Stop {live.length === 1 ? "it" : `all ${live.length}`}?</span>
                  <button type="button" className="text-rose hover:underline disabled:opacity-60" disabled={stopping} onClick={() => void stopAll()} data-testid="worker-stop-all-confirm">{stopping ? "Stopping…" : "Stop"}</button>
                  <button type="button" className="text-mist hover:text-snow" onClick={() => setConfirmStop(false)}>Keep working</button>
                </span>
              ) : <button type="button" className="text-xs text-mist transition-colors hover:text-snow" onClick={() => setConfirmStop(true)} data-testid="worker-stop-all">Stop all</button>
            ) : null}
            <button type="button" aria-label="Close" className="flex size-6 items-center justify-center rounded-md text-mist transition-colors hover:bg-white/5 hover:text-snow" onClick={() => { setListOpen(false); setConfirmStop(false); }}>
              <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
            </button>
          </div>
          <ul className="max-h-[min(30dvh,12rem)] overflow-y-auto overflow-x-hidden overscroll-contain" data-testid="worker-list">
            {items.map((worker) => {
              const working = worker.status === "running" || worker.status === "starting";
              return (
                <li key={worker.id} data-testid="worker-row" data-status={worker.status}>
                  <button type="button" className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none" onClick={() => onOpenWorker(worker.id)} data-testid="worker-toggle">
                    <WorkerGlyph worker={worker} />
                    <span className="shrink-0 text-[13px] text-snow" data-testid="worker-name">{worker.name}</span>
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${working ? "worker-shimmer" : "text-mist"}`} data-testid="worker-note">{activityOf(worker, feed.notes[worker.id])}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <button
        type="button"
        aria-expanded={Boolean(sheetWorker) || listOpen}
        className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/70 py-1 pl-2.5 pr-3 text-[13px] text-snow backdrop-blur-xl transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
        onClick={() => {
          if (sheetWorker) { onCloseWorker(); setListOpen(true); return; }
          setListOpen((open) => !open);
        }}
        data-testid="coworker-worker-shelf-toggle"
      >
        {live.length > 0 ? <WorkingDots className="size-3" /> : <WorkerGlyph worker={items[0] ?? sheetWorker!} className="size-3" />}
        <span>{pillLabel}</span>
        <span className="text-mist">{pillCount}</span>
        {needsPerson > 0 ? <span className="text-amber">· {needsPerson === 1 ? "1 needs you" : `${needsPerson} need you`}</span> : null}
      </button>
    </div>
  );
}

/**
 * One Worker's own view, in the tray's place: the brief it was sent, what it
 * has found and done so far, and a line to send it a follow-up.
 */
function WorkerSheet({ coworker, worker, onChanged, onClose, onOpenWorkersView }: {
  coworker: CoworkerSummary;
  worker: WorkerSummary;
  onChanged: (worker: WorkerSummary) => void;
  onClose: () => void;
  onOpenWorkersView?: () => void;
}) {
  const [events, setEvents] = useState<WorkerEvent[] | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [draft, setDraft] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:${worker.id}:steer`);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const alive = isLiveWorker(worker);
  const working = worker.status === "running" || worker.status === "starting";
  const approval = alive && worker.control?.state === "needs-approval";

  const read = useEffectEvent(async () => {
    try { setEvents(await coworkerBridge.workers.findings(coworker.slug, worker.id, 60)); } catch { /* Earlier updates stay on screen. */ }
  });
  useEffect(() => {
    void read();
    if (!alive) return;
    const timer = window.setInterval(() => void read(), 2_000);
    return () => window.clearInterval(timer);
  }, [alive, worker.updatedAt]);
  // New findings arrive at the bottom, where the reader already is.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [events?.length]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function act(label: string, action: () => Promise<WorkerSummary>, done?: () => void) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      onChanged(await action());
      done?.();
    } catch (cause) {
      setError(`${label} was not confirmed. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy("");
      void read();
    }
  }

  function send() {
    const text = draft.trim();
    if (!text || busy) return;
    void act("Sending", () => coworkerBridge.workers.steer(coworker.slug, worker.id, text), () => {
      setDraft((current) => current.trim() === text ? "" : current);
      setNotice("Sent. It reads this at its next step.");
    });
  }

  return (
    <section aria-label={worker.name} className="flex max-h-[min(62dvh,34rem)] flex-col overflow-hidden rounded-2xl border border-line bg-panel/85 shadow-[0_16px_48px_rgb(0_0_0/0.35)] backdrop-blur-xl" data-testid="worker-sheet" data-status={worker.status}>
      <header className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3">
        <WorkerGlyph worker={worker} />
        <h2 className="min-w-0 truncate text-sm text-snow">{worker.name}</h2>
        <span className="shrink-0 text-[11px] text-mist">{describeWorkerStatus(worker)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {alive ? <button type="button" className="rounded-md px-1.5 py-0.5 text-xs text-mist transition-colors hover:bg-white/5 hover:text-rose disabled:opacity-60" disabled={Boolean(busy)} onClick={() => void act("Stop", () => coworkerBridge.workers.cancel(coworker.slug, worker.id, "Stopped by you"))} data-testid="worker-sheet-stop">Stop</button> : null}
          {onOpenWorkersView ? (
            <button type="button" aria-label="Open in the Workers view" title="Open in the Workers view" className="flex size-6 items-center justify-center rounded-md text-mist transition-colors hover:bg-white/5 hover:text-snow" onClick={onOpenWorkersView} data-testid="worker-sheet-expand">
              <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.5 4H16v4.5M16 4l-5.5 5.5M8.5 16H4v-4.5M4 16l5.5-5.5" /></svg>
            </button>
          ) : null}
          <button type="button" aria-label="Close" className="flex size-6 items-center justify-center rounded-md text-mist transition-colors hover:bg-white/5 hover:text-snow" onClick={onClose} data-testid="worker-sheet-close">
            <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-4 [overflow-wrap:anywhere]">
        <button type="button" className="block w-full rounded-xl border border-line bg-white/[0.03] px-3.5 py-3 text-left" aria-expanded={briefOpen} onClick={() => setBriefOpen((open) => !open)} data-testid="worker-sheet-brief">
          <span className="flex items-center gap-1.5 text-[11px] text-mist">
            <svg viewBox="0 0 20 20" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h11l-3-3M16 13H5l3 3" /></svg>
            Sent by {worker.spawnedBy === "person" ? "you" : coworker.name}
          </span>
          <span className={`mt-1.5 block whitespace-pre-wrap text-[13px] leading-relaxed text-snow/90 ${briefOpen ? "" : "worker-brief-folded line-clamp-3"}`}>{worker.goal}</span>
        </button>
        {(events ?? []).map((event) => {
          const line = describeWorkerEvent(event, coworker.name);
          if (event.kind === "finding" && event.report === "decision") return (
            <div key={event.id} className="rounded-xl border border-amber/30 bg-amber/5 px-3 py-2" data-testid="worker-sheet-decision">
              <p className="text-[11px] font-medium text-amber">Needs a decision</p>
              <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-snow/90">{event.text}</p>
            </div>
          );
          if (event.kind === "finding") return (
            <div key={event.id} data-testid="worker-sheet-finding">
              {event.report === "done" ? <p className="text-[11px] font-medium text-mint">Done</p> : null}
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-snow/90">{event.text}</p>
            </div>
          );
          return <p key={event.id} className="text-xs text-mist" data-testid="worker-sheet-note">{line.label ? `${line.label}: ` : ""}{line.text}</p>;
        })}
        {approval ? (
          <p className="text-xs text-amber" data-testid="worker-sheet-approval">
            It is waiting for your approval to use {worker.control?.surface === "browser" ? "the browser" : "this Mac"}.{" "}
            {onOpenWorkersView ? <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={onOpenWorkersView}>Review access</button> : null}
          </p>
        ) : working ? <p className="worker-shimmer text-xs" data-testid="worker-sheet-live">{worker.status === "starting" ? "Getting started" : "Working"}</p>
          : worker.status === "waiting" ? <p className="text-xs text-mist">{worker.waitingFor === "decision" ? `Waiting for a decision. ${coworker.name} brings it to you.` : "Waiting for a free turn on this Mac."}</p>
          : null}
      </div>
      {alive ? (
        <form className="shrink-0 border-t border-line/60 p-2" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-ink/40 py-1 pl-3 pr-1 focus-within:border-spark/50">
            <input
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-snow outline-none placeholder:text-mist/70"
              placeholder={`Send follow-up to ${worker.name}`}
              value={draft}
              disabled={busy === "Sending"}
              onChange={(event) => setDraft(event.target.value)}
              data-testid="worker-sheet-followup"
            />
            <button type="submit" aria-label="Send follow-up" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-spark text-white transition-opacity disabled:opacity-35" disabled={!draft.trim() || Boolean(busy)}>
              <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 15V5M5.5 9.5 10 5l4.5 4.5" /></svg>
            </button>
          </div>
          {notice || error ? <p className={`px-2 pt-1.5 text-[11px] ${error ? "text-amber" : "text-mist"}`} role="status">{error || notice}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
