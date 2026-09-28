import { useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { relativeTime } from "@/lib/activity-summary";
import { workerTurnsFor } from "@/lib/effort";
import {
  describeLifespan,
  describeWorkerStatus,
  isLiveWorker,
  lifespanFromChoice,
  workerTone,
  type LifespanChoice,
  type WorkerSummary,
  type WorkerPurpose,
} from "@/lib/workers";
import { Button, ErrorNote, inputClass } from "@/ui/kit";
import { WorkerDetail } from "@/ui/worker-detail";
import { useWorkerFeed, type WorkerNote } from "@/ui/worker-tray";

type WorkersPanelProps = {
  coworker: CoworkerSummary;
  threadId?: string;
  onOpenThread?: (threadId: string) => void;
  onOpenComputer?: () => void;
  onOpenBrowser?: () => void;
};

/** The Workers view in the panel; never borrows another discussion's tasks. Beside the chat, `WorkerTray` shows the same feed. */
export function WorkersPanel({ coworker, threadId = coworker.conversationThreadId, ...props }: WorkersPanelProps) {
  return <WorkerList key={`${coworker.slug}:${threadId}`} coworker={coworker} threadId={threadId} {...props} />;
}

/** Every Worker of one discussion, in the Workers view: what each is doing, and each opens to steer, approve or stop it. */
function WorkerList({ coworker, threadId, onOpenThread, onOpenComputer, onOpenBrowser }: WorkersPanelProps & { threadId: string }) {
  const feed = useWorkerFeed(coworker, threadId, { everyNote: true });
  const [expandedId, setExpandedId] = useState("");
  const [creating, setCreating] = useState(false);
  const items = feed.workers ?? [];

  return (
    <div className="flex min-h-full flex-col gap-5" data-testid="coworker-workers" data-origin-thread={threadId}>
      <section aria-label="Workers in this discussion">
        <div className="mb-1 flex shrink-0 items-center justify-between px-1">
          <h3 className="text-[11px] font-semibold text-mist">Workers in this discussion</h3>
          {!creating ? (
            <Button variant="ghost" className="shrink-0 px-2 text-xs" onClick={() => setCreating(true)} data-testid="new-worker-button">New Worker</Button>
          ) : null}
        </div>
        {feed.error ? <div className="mb-2"><p role="alert" className="text-xs text-amber">{feed.error}</p><Button variant="ghost" className="text-xs" onClick={() => void feed.refresh()}>Check tasks</Button></div> : null}
        {creating ? (
          <NewWorker
            coworker={coworker}
            threadId={threadId}
            onCancel={() => setCreating(false)}
            onCreated={async (worker) => {
              feed.changed(worker);
              setCreating(false);
              setExpandedId(worker.id);
            }}
          />
        ) : null}
        {feed.workers !== null && items.length === 0 && !creating ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-mist" data-testid="workers-empty">
            No Workers in this discussion. Ask {coworker.name} to delegate a task, or start one here.
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className="space-y-1.5 pb-1.5" data-testid="worker-list">
            {items.map((worker) => {
              const expanded = expandedId === worker.id;
              return (
                <li key={worker.id} className={`overflow-hidden rounded-xl border transition-colors ${expanded ? "border-white/12 bg-white/[0.04]" : "border-transparent"}`} data-testid="worker-row" data-status={worker.status} data-expanded={expanded ? "true" : "false"}>
                  <WorkerRow worker={worker} note={feed.notes[worker.id] ?? null} now={feed.now} expanded={expanded} detailed onToggle={() => setExpandedId(expanded ? "" : worker.id)} />
                  {expanded ? (
                    <div className="px-2 pb-2">
                      <WorkerDetail key={worker.id} coworker={coworker} initialWorker={worker} onChanged={feed.changed} onOpenThread={onOpenThread} onOpenComputer={onOpenComputer} onOpenBrowser={onOpenBrowser} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/** "just now", "3m ago", "2h ago". */
function ago(at: number, now: number): string {
  const since = relativeTime(at, now);
  return !since || since === "now" ? "just now" : `${since} ago`;
}

function elapsed(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** One Worker at a glance: what it is, what state it is in, what it last said, and how much of its budget is spent. */
function WorkerRow({ worker, note, now, expanded, detailed, onToggle }: {
  worker: WorkerSummary;
  note: WorkerNote | null;
  now: number;
  expanded: boolean;
  detailed: boolean;
  onToggle: () => void;
}) {
  const alive = isLiveWorker(worker);
  const tone = workerTone(worker);
  const turns = worker.lifespan.kind === "turns" ? worker.lifespan : null;
  const since = alive ? `for ${elapsed(worker.createdAt, now)}` : worker.endedAt ? ago(worker.endedAt, now) : "";
  const noteText = note?.text ?? (alive ? (worker.status === "starting" ? "Getting started…" : worker.goal) : worker.error || worker.goal);
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="worker-toggle"
    >
      <span className="mt-0.5 shrink-0"><WorkerMark worker={worker} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-xs font-semibold text-snow" data-testid="worker-name">{worker.name}</span>
          <span className={`shrink-0 text-[10px] ${tone === "amber" ? "text-amber" : tone === "rose" ? "text-rose" : tone === "mint" ? "text-mint" : "text-mist"}`} data-testid="worker-line">
            {describeWorkerStatus(worker)}{since ? ` · ${since}` : ""}
          </span>
        </span>
        <span className={`mt-1 line-clamp-2 text-[11px] leading-snug ${note ? "text-snow/85" : "text-mist"}`} title={noteText} data-testid="worker-note" data-kind={note?.kind ?? "goal"}>
          {note?.kind === "decision" ? <span className="font-medium text-amber">Needs a decision: </span> : null}
          {noteText}
          {note ? <span className="whitespace-nowrap text-mist"> · {ago(note.at, now)}</span> : null}
        </span>
        {alive && turns ? (
          <span className="mt-1.5 flex items-center gap-2" data-testid="worker-budget">
            <span className="h-1 w-20 overflow-hidden rounded-full bg-white/8" aria-hidden="true">
              <span className="block h-full rounded-full bg-spark/70 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.round((turns.used / Math.max(1, turns.max)) * 100))}%` }} />
            </span>
            <span className="text-[10px] text-mist">{describeLifespan(worker.lifespan, now)}</span>
          </span>
        ) : alive ? <span className="mt-1 block text-[10px] text-mist" data-testid="worker-budget">{describeLifespan(worker.lifespan, now)}</span> : null}
        {worker.control ? <span className={`mt-1 block text-[11px] ${worker.control.state === "approved" ? "text-mist" : "text-amber"}`}>{worker.control.surface === "browser" ? "Discussion browser" : "This Mac"} · {worker.control.state === "approved" ? "Task access approved" : worker.control.state === "revoked" ? "Access revoked" : "Review access request"}</span> : null}
        {detailed ? <span className="mt-0.5 block truncate text-[10px] text-mist" data-testid="worker-model">
          {worker.purpose === "thinking" ? "Deep thinking" : "Delivery"} · {worker.modelSnapshot ? `${worker.modelSnapshot.providerId}/${worker.modelSnapshot.modelId} · ${worker.modelSnapshot.variant || "model default"} effort` : "Coworker model (legacy)"}
        </span> : null}
      </span>
      <span className="mt-0.5 shrink-0 text-mist" aria-hidden="true">{expanded ? "▾" : "›"}</span>
    </button>
  );
}

/** A Worker's state as a small mark: a turning ring while it works, a check when done, amber when it needs the person. */
function WorkerMark({ worker, size = "regular" }: { worker: WorkerSummary; size?: "regular" | "small" }) {
  const tone = workerTone(worker);
  const box = size === "small" ? "size-4" : "size-5";
  const working = worker.status === "running" || worker.status === "starting";
  const color = { spark: "text-spark", mint: "text-mint", amber: "text-amber", rose: "text-rose", mist: "text-mist" }[tone];
  return (
    <span className={`relative inline-flex ${box} shrink-0 items-center justify-center rounded-full bg-ink ring-1 ring-line ${color}`} data-testid="worker-mark" data-tone={tone}>
      {working ? (
        <svg viewBox="0 0 20 20" className="size-full motion-safe:animate-[loading-spin_1.1s_linear_infinite]" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" /><path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      ) : worker.status === "finished" ? (
        <svg viewBox="0 0 20 20" className="size-3/5" aria-hidden="true"><path d="m5 10.5 3.2 3L15 6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : worker.status === "paused" ? (
        <svg viewBox="0 0 20 20" className="size-1/2" aria-hidden="true"><path d="M7 5v10M13 5v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
      ) : worker.status === "waiting" && worker.waitingFor !== "decision" && tone === "spark" ? (
        <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />
      ) : tone === "amber" || tone === "rose" ? (
        <span className="text-[10px] font-bold leading-none" aria-hidden="true">!</span>
      ) : (
        <span className="size-1.5 rounded-sm bg-current" aria-hidden="true" />
      )}
    </span>
  );
}

/** A person can explicitly choose until stopped; defaults always have a turn limit. */
function NewWorker({
  coworker,
  threadId,
  onCancel,
  onCreated,
}: {
  coworker: CoworkerSummary;
  threadId: string;
  onCancel: () => void;
  onCreated: (worker: WorkerSummary) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [purpose, setPurpose] = useState<WorkerPurpose>("delivery");
  const [control, setControl] = useState<"" | "browser" | "computer">("");
  const [kind, setKind] = useState<LifespanChoice["kind"]>("turns");
  const [turns, setTurns] = useState(String(workerTurnsFor(coworker.effortPreference)));
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const starting = useRef(false);
  useEffect(() => () => { request.current += 1; }, []);

  async function start(): Promise<void> {
    if (starting.current) return;
    const choice: LifespanChoice = kind === "turns" ? { kind, turns } : kind === "until" ? { kind, at: until } : { kind };
    const resolved = lifespanFromChoice(choice);
    if ("error" in resolved) {
      setError(resolved.error);
      return;
    }
    if (!name.trim()) {
      setError("Give the Worker a name.");
      return;
    }
    if (!goal.trim()) {
      setError("Say what the Worker should work toward.");
      return;
    }
    starting.current = true;
    const version = ++request.current;
    setBusy(true);
    setError("");
    try {
      const worker = await coworkerBridge.workers.spawn(coworker.slug, {
        name: name.trim(),
        goal: goal.trim(),
        purpose,
        lifespan: resolved.lifespan,
        spawnedFromThreadId: threadId,
        ...(threadId && control ? { control } : {}),
      });
      if (version !== request.current) return;
      await onCreated(worker);
    } catch (cause) {
      if (version === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === request.current) { starting.current = false; setBusy(false); }
    }
  }

  const choiceClass = (active: boolean) => `rounded-md px-2 py-1.5 text-[11px] font-medium ${active ? "bg-white/8 text-snow" : "text-mist hover:text-snow"}`;

  return (
    <div className="mb-3 space-y-3 border-y border-line px-1 py-3" data-testid="new-worker">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-snow">New Worker</p>
        <Button variant="ghost" className="px-2 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
      <div className="flex rounded-lg border border-line bg-panel/60 p-0.5" role="radiogroup" aria-label="Worker purpose">
        <button type="button" role="radio" aria-checked={purpose === "delivery"} className={`flex-1 ${choiceClass(purpose === "delivery")}`} onClick={() => { setPurpose("delivery"); setTurns(String(workerTurnsFor(coworker.effortPreference))); }}>Delivery</button>
        <button type="button" role="radio" aria-checked={purpose === "thinking"} className={`flex-1 ${choiceClass(purpose === "thinking")}`} onClick={() => { setPurpose("thinking"); setTurns("2"); }}>Deep thinking</button>
      </div>
      <p className="break-words text-[11px] text-mist" data-testid="new-worker-model">
        {purpose === "thinking" ? "Decision, constraints, acceptance criteria, and open risks." : "Deliver from a brief and file references; return evidence."} Model: {(purpose === "thinking" ? coworker.thinkingModel : coworker.deliveryModel) || "App default for this purpose (resolved when started)"}. Pinned when started; no automatic fallback.
      </p>
      <input className={inputClass} placeholder="Name, e.g. Market scan" aria-label="Worker name" value={name} onChange={(event) => setName(event.target.value)} data-testid="new-worker-name" />
      <textarea
        className={`${inputClass} min-h-[72px] resize-y`}
        placeholder={`Goal, acceptance criteria, and file references. ${coworker.name} receives the result.`}
        aria-label="Worker goal"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        data-testid="new-worker-goal"
      />
      {threadId ? <label className="block space-y-1.5 text-xs text-mist">
        <span>Browser or Mac app access</span>
        <select className={`${inputClass} bg-panel text-xs`} aria-label="Worker control request" data-testid="new-worker-control" disabled={busy} value={control} onChange={(event) => {
          const value = event.target.value;
          if (value === "" || value === "browser" || value === "computer") setControl(value);
        }}>
          <option value="">None requested</option>
          <option value="browser">Request this discussion's browser</option>
          <option value="computer">Request Mac app control</option>
        </select>
        {control ? <span className="block text-[11px]">{control === "browser" ? "Uses existing discussion tabs and Coworker's shared local logins, not a separate account." : "Uses this Mac, not a remote computer. Requires discussion allowance and native app/window approval."} Creating the Worker only requests access. It stays paused until you review and approve the named task.</span> : <span className="block text-[11px]">Existing files and connected tools stay available. No browser or computer permission is granted here.</span>}
      </label> : null}
      <div className="grid grid-cols-3 rounded-lg border border-line bg-panel/60 p-0.5" role="radiogroup" aria-label="How long it works">
        <button type="button" role="radio" aria-checked={kind === "turns"} className={choiceClass(kind === "turns")} onClick={() => setKind("turns")}>Number of turns</button>
        <button type="button" role="radio" aria-checked={kind === "until"} className={choiceClass(kind === "until")} onClick={() => setKind("until")}>Until a time</button>
        <button type="button" role="radio" aria-checked={kind === "open"} className={choiceClass(kind === "open")} onClick={() => setKind("open")}>Until stopped</button>
      </div>
      {kind === "turns" ? (
        <label className="flex items-center gap-2 text-[11px] text-mist">
          <span>Turns</span>
          <input type="number" min={1} max={100} className={`${inputClass} w-24 py-1.5 text-xs`} value={turns} onChange={(event) => setTurns(event.target.value)} data-testid="new-worker-turns" />
          <span>Each turn is one bounded step; it reports after each.</span>
        </label>
      ) : null}
      {kind === "until" ? (
        <label className="flex items-center gap-2 text-[11px] text-mist">
          <span>Stop at</span>
          <input type="datetime-local" className={`${inputClass} w-auto py-1.5 text-xs`} value={until} onChange={(event) => setUntil(event.target.value)} data-testid="new-worker-until" />
        </label>
      ) : null}
      {kind === "open" ? <p className="text-[11px] text-mist">It keeps working until you or {coworker.name} stop it.</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button variant="primary" className="w-full text-xs" disabled={busy} aria-busy={busy} onClick={() => void start()} data-testid="new-worker-start">
        {busy ? "Creating..." : control ? "Create Worker for review" : "Start Worker"}
      </Button>
    </div>
  );
}
