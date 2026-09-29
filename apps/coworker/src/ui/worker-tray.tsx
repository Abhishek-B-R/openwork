import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { isLiveWorker, type WorkerEvent, type WorkerSummary } from "@/lib/workers";
import { WorkerDetail } from "@/ui/worker-detail";
import { WorkerGlyph, WorkingDots } from "@/ui/worker-glyph";

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
      setWorkers((current) => JSON.stringify(current) === JSON.stringify(mine) ? current : mine);
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

/** What a Worker is doing, in a few words: its latest note, else its first step or goal. */
function activityOf(worker: WorkerSummary, note: WorkerNote | undefined): string {
  if (note) return note.text;
  if (worker.status === "starting") return "Getting started";
  return isLiveWorker(worker) ? worker.goal : worker.error || worker.goal;
}

/**
 * The coworker's Workers in this conversation, the way a coding agent shows
 * its subagents. It lives in the quiet line over the composer and floats: a
 * small "Working 3" pill, the list of what each is doing above it, or one
 * Worker's view in the same place, at the composer's width. Opening either
 * never pushes the conversation.
 */
export function WorkerTray({ coworker, feed, openWorkerId, onOpenWorker, onCloseWorker, onOpenWorkersView, onOpenThread, onOpenComputer, onOpenBrowser }: {
  coworker: CoworkerSummary;
  feed: WorkerFeed;
  /** The Worker whose view is open (from its row, or a link in a reply). */
  openWorkerId: string;
  onOpenWorker: (workerId: string) => void;
  onCloseWorker: () => void;
  /** The full Workers view in the panel. */
  onOpenWorkersView?: () => void;
  onOpenThread?: (threadId: string) => void;
  onOpenComputer?: () => void;
  onOpenBrowser?: () => void;
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
  const firstShown = items[0] ?? sheetWorker;

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
    <div className="contents" data-testid="coworker-worker-shelf" data-open={sheetWorker ? "worker" : listOpen ? "list" : "false"}>
      {sheetWorker ? (
        <div className="pointer-events-auto absolute inset-x-0 bottom-full mb-2" data-testid="worker-float">
          <WorkerDetail key={sheetWorker.id} variant="sheet" coworker={coworker} initialWorker={sheetWorker} onChanged={feed.changed} onClose={onCloseWorker} onExpand={onOpenWorkersView} onOpenThread={onOpenThread} onOpenComputer={onOpenComputer} onOpenBrowser={onOpenBrowser} />
        </div>
      ) : listOpen ? (
        <section aria-label={`${coworker.name}'s Workers`} className="pointer-events-auto absolute inset-x-0 bottom-full mb-2 rounded-2xl border border-line bg-panel/90 px-2 pb-1.5 pt-2.5 text-xs shadow-[0_16px_48px_rgb(0_0_0/0.4)] backdrop-blur-xl" data-testid="worker-list-panel">
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
            {items.map((worker) => <li key={worker.id} data-testid="worker-row" data-status={worker.status}><WorkerLine worker={worker} note={feed.notes[worker.id]} onOpen={() => onOpenWorker(worker.id)} /></li>)}
          </ul>
        </section>
      ) : null}
      <button
        type="button"
        aria-expanded={Boolean(sheetWorker) || listOpen}
        className="pointer-events-auto mb-1 inline-flex shrink-0 items-center gap-2 rounded-full border border-line bg-panel/80 py-1 pl-2.5 pr-3 text-[13px] text-snow backdrop-blur-xl transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
        onClick={() => {
          if (sheetWorker) { onCloseWorker(); setListOpen(true); return; }
          setListOpen((open) => !open);
        }}
        data-testid="coworker-worker-shelf-toggle"
      >
        {live.length > 0 ? <WorkingDots className="size-3" /> : firstShown ? <WorkerGlyph worker={firstShown} className="size-3" /> : null}
        <span>{pillLabel}</span>
        <span className="text-mist">{pillCount}</span>
        {needsPerson > 0 ? <span className="text-amber">· {needsPerson === 1 ? "1 needs you" : `${needsPerson} need you`}</span> : null}
      </button>
    </div>
  );
}

/** One Worker in a line: its mark, its name, and what it is doing now, shimmering while it works. Shared by the tray and the Workers view. */
export function WorkerLine({ worker, note, onOpen, trailing }: { worker: WorkerSummary; note?: WorkerNote; onOpen: () => void; trailing?: ReactNode }) {
  const working = worker.status === "running" || worker.status === "starting";
  return (
    <button type="button" className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none" onClick={onOpen} data-testid="worker-toggle">
      <WorkerGlyph worker={worker} />
      <span className="shrink-0 text-[13px] text-snow" data-testid="worker-name">{worker.name}</span>
      <span className={`min-w-0 flex-1 truncate text-[13px] ${working ? "worker-shimmer" : "text-mist"}`} data-testid="worker-note">{activityOf(worker, note)}</span>
      {trailing}
    </button>
  );
}
