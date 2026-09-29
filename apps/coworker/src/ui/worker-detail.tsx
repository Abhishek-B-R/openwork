import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { describeLifespan, describeWorkerEvent, describeWorkerStatus, isLiveWorker, type WorkerEvent, type WorkerSummary } from "@/lib/workers";
import { relativeTime } from "@/lib/activity-summary";
import { Button } from "@/ui/kit";
import { WorkerGlyph } from "@/ui/worker-glyph";
import { useComposerDraft } from "@/ui/use-composer-draft";

/**
 * One exact Worker, inspected without leaving its conversation: the brief it
 * was sent, what it has done so far as it happens, its access, and a line to
 * send it a follow-up. `sheet` floats over the conversation from the Working
 * pill; `inline` opens under its row in the Workers view.
 */
export function WorkerDetail({ coworker, initialWorker, onChanged, onOpenThread, onOpenComputer, onOpenBrowser, variant = "inline", onClose, onExpand }: {
  coworker: CoworkerSummary;
  initialWorker: WorkerSummary;
  onChanged: (worker: WorkerSummary) => void;
  onOpenThread?: (threadId: string) => void;
  onOpenComputer?: () => void;
  onOpenBrowser?: () => void;
  variant?: "inline" | "sheet";
  onClose?: () => void;
  /** From the floating sheet: the full Workers view. */
  onExpand?: () => void;
}) {
  const [worker, setWorker] = useState(initialWorker);
  const [briefOpen, setBriefOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [events, setEvents] = useState<WorkerEvent[] | null>(null);
  const [steer, setSteer] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:${initialWorker.id}:steer`);
  const [busy, setBusy] = useState("");
  const [readError, setReadError] = useState("");
  const [findingsError, setFindingsError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [verified, setVerified] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef(0);
  const reading = useRef(false);
  const changing = useRef(false);
  const labelId = useId();
  const alive = isLiveWorker(worker);
  const control = worker.control;
  const surface = control?.surface === "browser" ? "Browser" : "This Mac";

  function accept(next: WorkerSummary) {
    if (next.id !== initialWorker.id || next.slug !== coworker.slug || next.spawnedFromThreadId !== initialWorker.spawnedFromThreadId) {
      throw new Error("This update does not belong to the selected task.");
    }
    setWorker(next);
    onChanged(next);
  }

  async function refresh() {
    if (reading.current || changing.current) return;
    reading.current = true;
    const version = ++request.current;
    setRefreshing(true);
    const [record, findings] = await Promise.allSettled([
      coworkerBridge.workers.get(coworker.slug, initialWorker.id),
      coworkerBridge.workers.findings(coworker.slug, initialWorker.id, 40),
    ]);
    reading.current = false;
    if (version !== request.current) return;
    setRefreshing(false);
    try {
      if (record.status === "rejected") throw record.reason;
      accept(record.value);
      setReadError("");
      setVerified(true);
    } catch (cause) {
      setVerified(false);
      setReadError(`Updates unavailable. Last known state is shown. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (findings.status === "fulfilled") { setEvents(findings.value); setFindingsError(""); }
    else setFindingsError("Findings could not refresh. Earlier updates are kept.");
  }
  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    void readLatest();
    const timer = window.setInterval(() => void readLatest(), 2_000);
    return () => { request.current += 1; window.clearInterval(timer); };
  }, []);

  async function act(label: string, action: () => Promise<WorkerSummary>, steering = "") {
    if (changing.current) return;
    changing.current = true;
    const version = ++request.current;
    setBusy(label);
    setRefreshing(false);
    setActionError("");
    setNotice("");
    try {
      const next = await action();
      if (version !== request.current) return;
      accept(next);
      setVerified(true);
      setReadError("");
      if (steering) {
        setSteer((current) => current.trim() === steering ? "" : current);
        setNotice("Sent. It reads this at its next step.");
      }
    } catch (cause) {
      if (version !== request.current) return;
      setVerified(false);
      setActionError(`${label} was not confirmed. ${cause instanceof Error ? cause.message : String(cause)} Check status before retrying; no action is repeated automatically.`);
    } finally {
      if (version === request.current) { changing.current = false; setBusy(""); }
    }
    if (version === request.current) void refresh();
  }

  const working = worker.status === "running" || worker.status === "starting";
  const sheet = variant === "sheet";
  const eventCount = events?.length ?? 0;
  const deciding = alive && worker.status === "waiting" && worker.waitingFor === "decision";
  // The question it waits on is asked once, at the end, with the answer box; the log keeps the rest.
  const question = deciding ? [...(events ?? [])].reverse().find((event) => event.kind === "finding" && event.report === "decision") ?? null : null;
  const needsAccess = Boolean(control && control.state !== "approved" && alive);
  // New activity lands at the bottom of the sheet, where the reader already is.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (sheet && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [sheet, eventCount]);
  useEffect(() => {
    if (!sheet || !onClose) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, onClose]);

  const status = `${!verified ? "Last known: " : ""}${describeWorkerStatus(worker)}${alive && !deciding && !needsAccess ? ` · ${describeLifespan(worker.lifespan)}` : ""}`;
  const menuItem = "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-snow/90 transition-colors hover:bg-white/5 disabled:opacity-50";
  // Everything but the work itself waits behind one menu.
  const menu = (
    <details className="group/menu relative" data-testid="worker-menu">
      <summary aria-label="More" title="More" className="flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-mist transition-colors hover:bg-white/5 hover:text-snow [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden="true"><circle cx="4.5" cy="10" r="1.4" /><circle cx="10" cy="10" r="1.4" /><circle cx="15.5" cy="10" r="1.4" /></svg>
      </summary>
      <div className="absolute right-0 top-full z-10 mt-1 w-52 rounded-xl border border-line bg-panel p-1 shadow-[0_12px_32px_rgb(0_0_0/0.45)]">
        {alive && worker.status !== "paused" ? <button type="button" className={menuItem} disabled={Boolean(busy) || !verified} data-testid="worker-pause" onClick={() => void act("Pause", () => coworkerBridge.workers.pause(coworker.slug, worker.id))}>Pause after this step</button> : null}
        {worker.status === "paused" && (!control || control.state === "approved") ? <button type="button" className={menuItem} disabled={Boolean(busy) || !verified} data-testid="worker-resume" onClick={() => void act("Resume", () => coworkerBridge.workers.resume(coworker.slug, worker.id))}>Resume</button> : null}
        {alive || worker.cleanupPending ? <button type="button" className={`${menuItem} text-rose`} disabled={Boolean(busy)} aria-busy={busy === "Stop"} data-testid="worker-stop" onClick={() => void act("Stop", () => coworkerBridge.workers.cancel(coworker.slug, worker.id))}>{worker.cleanupPending ? "Retry Stop" : "Stop"}</button> : null}
        {onExpand ? <button type="button" className={menuItem} onClick={onExpand} data-testid="worker-sheet-expand">Open in Workers</button> : null}
        {worker.threadId && onOpenThread ? <button type="button" className={menuItem} data-testid="worker-open-work" onClick={() => onOpenThread(worker.threadId)}>Open full transcript</button> : null}
        <button type="button" className={menuItem} disabled={Boolean(busy) || refreshing} onClick={() => void refresh()} data-testid="worker-refresh">{refreshing ? "Checking..." : "Check status"}</button>
        <p className="mt-1 border-t border-line/60 px-2.5 pb-1 pt-2 text-[11px] leading-snug text-mist">{worker.spawnedBy === "coworker" ? `Started by ${coworker.name}` : "Started by you"} · {worker.purpose === "thinking" ? "thinking" : "delivery"}{worker.modelSnapshot ? ` · ${worker.modelSnapshot.modelId}${worker.modelSnapshot.variant ? `, ${worker.modelSnapshot.variant}` : ""}` : ""}</p>
      </div>
    </details>
  );
  const steerForm = alive ? (
    <form onSubmit={(event) => {
      event.preventDefault();
      const text = steer.trim();
      if (text && !busy && verified) void act("Steering", () => coworkerBridge.workers.steer(coworker.slug, worker.id, text), text);
    }}>
      <label className="sr-only" htmlFor={`${labelId}-steer`}>{deciding ? "Your answer" : `Send a follow-up to ${worker.name}`}</label>
      <div className="flex items-center gap-2 rounded-xl border border-line bg-ink/40 py-1 pl-3 pr-1 focus-within:border-spark/50">
        <input id={`${labelId}-steer`} className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-snow outline-none placeholder:text-mist/70" placeholder={deciding ? "Your answer" : `Send follow-up to ${worker.name}`} value={steer} disabled={busy === "Steering"} onChange={(event) => setSteer(event.target.value)} data-testid="worker-steer-input" />
        <button type="submit" aria-label={deciding ? "Send answer" : "Send follow-up"} className="flex size-7 shrink-0 items-center justify-center rounded-full bg-spark text-white transition-opacity disabled:opacity-35" disabled={!steer.trim() || Boolean(busy) || !verified} aria-busy={busy === "Steering"} data-testid="worker-steer-send">
          <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 15V5M5.5 9.5 10 5l4.5 4.5" /></svg>
        </button>
      </div>
    </form>
  ) : null;

  return <section aria-labelledby={labelId} className={sheet
    ? "pointer-events-auto flex max-h-[min(62dvh,34rem)] flex-col overflow-hidden rounded-2xl border border-line bg-panel/90 text-xs leading-relaxed text-mist shadow-[0_16px_48px_rgb(0_0_0/0.4)] backdrop-blur-xl [overflow-wrap:anywhere]"
    : "text-xs leading-relaxed text-mist [overflow-wrap:anywhere]"} data-testid="worker-detail" data-variant={variant} data-status={worker.status}>
    <header className={`flex shrink-0 items-start gap-2.5 ${sheet ? "px-4 pb-2 pt-3" : "px-3 pb-1 pt-0.5"}`}>
      {sheet ? <span className="mt-1"><WorkerGlyph worker={worker} /></span> : null}
      <div className="min-w-0 flex-1">
        {sheet ? <h2 id={labelId} className="truncate text-sm font-normal text-snow">{worker.name}</h2> : <span id={labelId} className="sr-only">{worker.name}</span>}
        <p className={`truncate text-[11px] ${deciding || needsAccess ? "text-amber" : "text-mist"}`} role="status">{status}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {menu}
        {onClose ? (
          <button type="button" aria-label="Close" className="flex size-6 items-center justify-center rounded-md text-mist transition-colors hover:bg-white/5 hover:text-snow" onClick={onClose} data-testid="worker-sheet-close">
            <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        ) : null}
      </div>
    </header>
    <div ref={scrollRef} className={sheet ? "min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-4" : "space-y-3 px-3 pb-3"}>
      <button type="button" className="block w-full rounded-xl border border-line bg-white/[0.03] px-3 py-2.5 text-left" aria-expanded={briefOpen} onClick={() => setBriefOpen((open) => !open)} data-testid="worker-goal">
        <span className="flex items-center gap-1.5 text-[11px] text-mist">
          <svg viewBox="0 0 20 20" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h11l-3-3M16 13H5l3 3" /></svg>
          Sent by {worker.spawnedBy === "coworker" ? coworker.name : "you"}
        </span>
        <span className={`mt-1 block whitespace-pre-wrap text-[13px] leading-relaxed text-snow/90 ${briefOpen ? "" : "worker-brief-folded line-clamp-2"}`}>{worker.goal}</span>
      </button>
      {control ? <section aria-label={`${surface} access for ${worker.name}`} data-testid="worker-control" data-state={control.state} className={`space-y-2 rounded-xl border px-3.5 py-3 ${needsAccess ? "border-amber/35 bg-amber/5" : "border-line bg-white/[0.02]"}`}>
        {needsAccess ? <>
          <p className="text-[13px] text-snow">{!verified ? "Last known: " : ""}Allow {surface === "Browser" ? "browser" : "Mac app"} use for this task?</p>
          <p>This does not approve purchases, messages, deletions or other consequential actions.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" className="text-xs" aria-describedby={labelId} disabled={Boolean(busy) || !verified} aria-busy={busy === "Approval"} data-testid="worker-control-approve" onClick={() => void act("Approval", () => coworkerBridge.workers.approveControl({ slug: coworker.slug, id: worker.id, expectedRevision: control!.revision }))}>Approve {control.surface === "browser" ? "browser" : "Mac app"} access</Button>
            {control.surface === "computer" && onOpenComputer ? <Button type="button" variant="ghost" className="text-xs" onClick={onOpenComputer}>Computer setup</Button> : null}
          </div>
        </> : <>
          <p className="text-snow/90">{!verified ? "Last known: " : ""}{surface} · {control.state === "approved" ? "Task access approved" : "Task access revoked"}</p>
          {control.state === "approved" ? <div className="flex flex-wrap gap-2">
            {control.surface === "browser" && onOpenBrowser ? <Button type="button" className="text-xs" onClick={onOpenBrowser}>Watch browser beside chat</Button> : null}
            <Button type="button" variant="ghost" className="text-xs text-rose" disabled={Boolean(busy)} aria-busy={busy === "Revocation"} data-testid="worker-control-revoke" onClick={() => void act("Revocation", () => coworkerBridge.workers.revokeControl({ slug: coworker.slug, id: worker.id, expectedRevision: control!.revision }))}>Revoke control</Button>
          </div> : null}
        </>}
        <details className="text-[11px]">
          <summary className="cursor-pointer select-none text-mist/80 hover:text-snow">More about access</summary>
          <div className="mt-1.5 space-y-1.5">
            {control.detail ? <p>{control.detail}</p> : null}
            {needsAccess ? <>
              <p>Approve {surface === "Browser" ? "browser use" : "Mac app use"} for <strong className="font-medium text-snow">{worker.name}</strong> to work on the goal above. Approval lets this task proceed when its access requirements are met. It must be approved again after restarting the app.</p>
              <p>{control.surface === "browser" ? "Uses this discussion's tabs and Coworker's shared local login profile, not a new private account. Use Take over in Browser before signing in." : "First enable Computer in this discussion, then approve this Worker's named task. A single eligible app window opens automatically; choose one in the Computer view when several are available. This is your Mac, not a remote computer. Window content can be sent to your selected model provider; sensitive actions still need separate authorization."}</p>
            </> : control.state === "approved" ? <>
              <p>{control.surface === "browser" ? "Watch the discussion browser beside chat. Take over pauses browser tools; only you can return control." : "Approval is not proof of active control. The floating Computer view shows recent window frames and input feedback, but never forwards your clicks or typing. Human input pauses control. Use Take over, Continue, or Stop there; minimizing or leaving the discussion stops preview capture, not work. macOS permissions remain separate."}</p>
              <p>Revoke removes this task's control permission. Stop ends the Worker.</p>
            </> : null}
          </div>
        </details>
      </section> : null}
      <section aria-label={`Updates from ${worker.name}`} className="space-y-3" data-testid="worker-timeline">
        {findingsError ? <p role="status" className="text-amber">{findingsError}</p> : null}
        {events === null ? <p className="worker-shimmer">Reading its updates</p> : events.length === 0 && !working ? <p>No updates yet.</p> : events.map((event) => {
          if (event.id === question?.id) return null;
          const line = describeWorkerEvent(event, coworker.name);
          if (event.kind === "finding") return (
            <div key={event.id} data-testid="worker-event" data-kind={event.kind}>
              {event.report === "done" ? <p className="text-[11px] font-medium text-mint">Done</p> : event.report === "decision" ? <p className="text-[11px] font-medium text-amber">Asked</p> : null}
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-snow/90">{event.text}</p>
            </div>
          );
          return (
            <p key={event.id} data-testid="worker-event" data-kind={event.kind} className="text-xs text-mist">
              {line.label ? <span className="text-snow/70">{line.label}: </span> : null}
              <span className="whitespace-pre-wrap">{line.text}</span>
              <span className="text-mist/60" title={new Date(event.at).toLocaleString()}> · {relativeTime(event.at) || "now"}</span>
            </p>
          );
        })}
        {working && !needsAccess ? <p className="worker-shimmer text-xs" data-testid="worker-live">{worker.status === "starting" ? "Getting started" : "Working"}</p> : null}
      </section>
      {question ? (
        <section aria-label="Its question" className="space-y-2.5 rounded-xl border border-amber/35 bg-amber/5 px-3.5 py-3" data-testid="worker-question">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-snow">{question.text}</p>
          {steerForm}
        </section>
      ) : null}
      {worker.error && worker.status === "failed" ? <p className="text-amber" data-testid="worker-error">{worker.error}</p> : null}
      {notice ? <p role="status" data-testid="worker-steer-notice">{notice}</p> : null}
      {readError ? <p role="alert" className="text-amber">{readError}</p> : null}
      {actionError ? <p role="alert" className="text-rose">{actionError}</p> : null}
    </div>
    {steerForm && !question ? <div className={sheet ? "shrink-0 border-t border-line/60 p-2" : "px-3 pb-3"}>{steerForm}</div> : null}
  </section>;
}
