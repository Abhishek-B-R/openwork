import { isLiveWorker, type WorkerSummary } from "@/lib/workers";

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
