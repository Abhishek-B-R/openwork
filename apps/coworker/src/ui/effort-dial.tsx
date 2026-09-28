import { CoworkerEffortSlider } from "@openwork/ui/coworker-effort";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { DEFAULT_EFFORT_STOP, EFFORT_STOPS, describeEffortStop, effortLevelFor, effortStopLabel, laneWithPreference, replyKindForLane, type EffortKind, type EffortStop } from "@/lib/effort";
import { HelpTip } from "@/ui/kit";
import { onMac, onSuperAction, superKeyLabel, useSuperKey } from "@/ui/use-super-key";

/** How long a chosen stop waits for the save to come back before the saved one shows again. */
const CHOSEN_SETTLE_MS = 3000;

/**
 * Dynamic effort sets the coworker's pace. The composer pill opens the
 * five-stop selector on top of itself, with the slider at the foot; what each
 * stop means opens above it, so the slider never moves under the pointer.
 * While the super key (⌘⇧, Ctrl+Shift elsewhere) is down, the pill becomes the
 * slider in place and ← → move it. Each turn derives its effort from this
 * preference and the kind of work; a supported fixed effort in Customize › AI
 * model still takes priority.
 */
export function EffortDial({
  stop: savedStop,
  onChange,
  coworkerName,
  compact = true,
  fixedVariant = "",
}: {
  stop: EffortStop;
  onChange: (stop: EffortStop) => void;
  coworkerName: string;
  /** The pill and popover (default); false renders the dial inline for a settings row. */
  compact?: boolean;
  fixedVariant?: string;
}) {
  // A click opens the selector until it is dismissed.
  const [open, setOpen] = useState<false | "click">(false);
  const superKey = useSuperKey();
  const [explained, setExplained] = useState(false);
  // A stop just chosen shows at once, so quick presses add up; the saved one catches up (or wins back if the save failed).
  const [chosen, setChosen] = useState<EffortStop | null>(null);
  const stop = chosen ?? savedStop;
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const explainerId = useId();

  useEffect(() => {
    if (!chosen) return;
    if (chosen === savedStop) {
      setChosen(null);
      return;
    }
    const settle = window.setTimeout(() => setChosen(null), CHOSEN_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [chosen, savedStop]);

  const choose = (next: EffortStop | undefined) => {
    if (!next || next === stop) return;
    setChosen(next);
    onChange(next);
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(false);
        if (rootRef.current?.contains(document.activeElement)) pillRef.current?.focus();
        return;
      }
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const step = useEffectEvent((by: number) => choose(EFFORT_STOPS[Math.min(EFFORT_STOPS.length - 1, Math.max(0, EFFORT_STOPS.indexOf(stop) + by))]));

  // The super key's ← → belong to the composer on screen: not a hidden one, and not one under a dialog.
  useEffect(() => {
    if (!compact) return;
    return onSuperAction((action) => {
      if (action.kind !== "pace") return;
      const root = rootRef.current;
      if (!root || root.getClientRects().length === 0 || root.closest("[inert]") || document.querySelector('[aria-modal="true"]')) return;
      step(action.by);
    });
  }, [compact]);
  /** While the super key is down, the pill becomes the slider where it stands. */
  const inPlace = compact && superKey.active && !open;

  const index = EFFORT_STOPS.indexOf(stop);
  const label = effortStopLabel(stop);
  const shortcut = superKeyLabel();
  const examples: { label: string; kind: EffortKind }[] = [
    { label: "Quick questions", kind: replyKindForLane(laneWithPreference("quick", stop)) },
    { label: "Planning & research", kind: replyKindForLane(laneWithPreference("deep", stop)) },
    { label: "Background work", kind: "worker-turn" },
  ];
  const keys = (
    <span className="flex items-center gap-1" aria-hidden="true">
      <kbd className="rounded border border-line bg-white/5 px-1 font-sans text-[10px] leading-4 text-mist">{shortcut}</kbd>
      <kbd className="rounded border border-line bg-white/5 px-1 font-sans text-[10px] leading-4 text-mist">←</kbd>
      <kbd className="rounded border border-line bg-white/5 px-1 font-sans text-[10px] leading-4 text-mist">→</kbd>
    </span>
  );
  const dial = (
    <div className={compact ? "w-[300px] max-w-[calc(100vw-48px)]" : "w-full min-w-0"} data-testid="effort-dial-panel" data-stop={stop} data-mode={compact ? open || undefined : "inline"}>
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-mist">
          <DynamicEffortIcon />{compact ? "Thinking pace" : "My thinking pace"}
          {!compact ? <HelpTip label="thinking pace" content={`This sets how much ${coworkerName} thinks for different tasks. It also changes how long helpers can work. A fixed model effort, when chosen, takes priority.`} /> : null}
        </p>
        <button
          type="button"
          aria-expanded={explained}
          aria-controls={explainerId}
          className="-mr-1 flex shrink-0 items-center gap-1 rounded-lg px-1 py-0.5 text-[11px] text-mist transition-colors hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
          data-testid="effort-explainer"
          onClick={() => setExplained((was) => !was)}
        >
          What this means<span aria-hidden="true" className={`inline-block transition-transform duration-200 ${explained ? "-rotate-90" : "rotate-90"}`}>›</span>
        </button>
      </div>
      {/* Opens above the slider and grows the popover upward; the height eases instead of jumping. */}
      <div id={explainerId} inert={!explained} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${explained ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`} data-testid="effort-adapts-preview" data-open={explained}>
        <div className="min-h-0 overflow-hidden">
          <div className={`mt-3 space-y-2.5 rounded-xl border border-line bg-ink/30 p-3 ${compact ? "max-h-[max(120px,calc(75vh-240px))] overflow-y-auto" : ""}`}>
            <p className="text-[11px] leading-relaxed text-snow/90" data-testid="effort-dial-detail">{describeEffortStop(stop)}</p>
            {fixedVariant ? (
              <p className="text-[11px] leading-relaxed text-mist">Fixed effort is set to {fixedVariant} in Customize › AI model. This pace still guides Automatic model selection and how many turns new delivery Workers get.</p>
            ) : (
              <>
                <p className="text-[10px] font-medium text-mint">Effort by task</p>
                {examples.map(({ label: task, kind }) => (
                  <div key={task} className="flex items-center justify-between gap-3 text-[11px] text-mist">
                    <span>{task}</span>
                    <span className="flex gap-1" aria-label={`${task}: ${effortLevelFor(kind, stop) + 1} of 6 thinking levels`}>
                      {Array.from({ length: 6 }, (_, level) => <span key={level} aria-hidden="true" className={`h-1.5 w-3.5 rounded-full transition-colors ${level <= effortLevelFor(kind, stop) ? "bg-spark/75" : "bg-white/8"}`} />)}
                    </span>
                  </div>
                ))}
                <p className="text-[10px] leading-relaxed text-mist/70">Starting points, adapted to the thinking levels your model supports. Models without adjustable thinking use their default.</p>
              </>
            )}
            <p className="text-[10px] leading-relaxed text-mist/70">Higher effort can take longer and cost more.</p>
            {compact ? <p className="text-[10px] leading-relaxed text-mist/70">Hold {shortcut} while you write and press ← → to change the pace without leaving the message.</p> : null}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p id={inPlace ? undefined : labelId} className="effort-dial-name text-lg font-semibold tracking-tight text-snow" data-testid="effort-dial-stop">{label}</p>
        {compact ? <span className="flex items-center gap-1.5 text-[10px] text-mist/70" data-testid="effort-shortcut-hint">Hold{keys}</span> : stop !== DEFAULT_EFFORT_STOP ? (
          <button
            type="button"
            className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-mist hover:border-white/20 hover:text-snow"
            title="Back to Balanced"
            data-testid="effort-dial-reset"
            onClick={() => choose(DEFAULT_EFFORT_STOP)}
          >
            Use Balanced
          </button>
        ) : null}
      </div>
      {!compact ? <p className="text-[11px] leading-relaxed text-mist" data-testid="effort-dial-meaning">{({ light: "Quickest for everyday questions.", steady: "A little quicker than Balanced.", balanced: "Adapts to the work you give it.", thorough: "Takes more time for careful work.", "all-in": "Takes the most time for hard work." } satisfies Record<EffortStop, string>)[stop]}</p> : null}
      {fixedVariant ? <p className="mt-1 text-[11px] leading-relaxed text-mist" data-testid="effort-fixed-note">Fixed effort {fixedVariant} takes priority when the model supports it.</p> : null}
      <div className="mt-2">
        <CoworkerEffortSlider index={index} stop={stop} label={label} labelId={labelId} autoFocus={open === "click"} onChange={(nextIndex) => choose(EFFORT_STOPS[nextIndex])} />
        <div className="mt-1 flex justify-between gap-1 text-[10px] text-mist/70">
          {EFFORT_STOPS.map((candidate) => (
            <button key={candidate} type="button" tabIndex={-1} aria-pressed={candidate === stop} className={`rounded-md px-1 py-1 transition-colors ${candidate === stop ? "font-semibold text-snow" : "hover:text-snow"}`} onClick={() => choose(candidate)}>{effortStopLabel(candidate)}</button>
          ))}
        </div>
      </div>
    </div>
  );

  if (!compact) return <div data-testid="effort-dial" data-stop={stop}>{dial}</div>;

  return (
    <div ref={rootRef} className="relative" data-testid="effort-dial" data-stop={stop}>
      <button
        ref={pillRef}
        type="button"
        className={`inline-flex min-h-8 items-center gap-2 rounded-xl px-2.5 py-1.5 text-[11px] text-mist transition-colors hover:bg-spark/10 hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50 ${inPlace ? "invisible" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(open)}
        aria-keyshortcuts={onMac() ? "Meta+Shift+ArrowLeft Meta+Shift+ArrowRight" : "Control+Shift+ArrowLeft Control+Shift+ArrowRight"}
        title={`${coworkerName}'s thinking pace: ${label}. Hold ${shortcut} and press ← → to change it.`}
        data-testid="effort-dial-pill"
        onClick={() => setOpen((was) => (was ? false : "click"))}
      >
        <DynamicEffortIcon /><span className="hidden font-medium text-snow/90 sm:inline">Dynamic effort</span>{" "}
        <span className="text-mist">{label}</span>{" "}
        <span aria-hidden="true">⌄</span>
      </button>
      {inPlace ? (
        // The pill's own spot, a little wider: the pace and its slider, moved by ← → while the super key is down.
        <div className="effort-inplace absolute right-0 top-1/2 z-30 flex h-11 w-[min(300px,calc(100vw-96px))] -translate-y-1/2 items-center gap-2 rounded-2xl border border-spark/30 bg-panel/95 pl-2.5 pr-1.5 shadow-[0_10px_30px_rgb(0_0_0/0.45)] backdrop-blur-md" data-testid="effort-dial-inplace">
          <DynamicEffortIcon />
          <span id={labelId} aria-live="polite" className="w-[4.75rem] shrink-0 truncate text-[12px] font-semibold text-snow" data-testid="effort-dial-stop">{label}</span>
          <div className="min-w-0 flex-1">
            <CoworkerEffortSlider index={index} stop={stop} label={label} labelId={labelId} onChange={(nextIndex) => choose(EFFORT_STOPS[nextIndex])} />
          </div>
        </div>
      ) : null}
      {open ? (
        // On top of the pill, anchored at its foot: what each stop means grows upward and the slider stays put.
        <div role="dialog" aria-label={`Thinking pace for ${coworkerName}`} className="effort-popover absolute bottom-0 right-0 z-30 max-w-[calc(100vw-24px)] rounded-[20px] border border-line bg-panel p-4 shadow-[0_16px_48px_rgba(0,0,0,0.4)]">
          {dial}
        </div>
      ) : null}
    </div>
  );
}

function DynamicEffortIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 shrink-0 fill-none stroke-spark" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13V9m5 6V5m5 8V7m4 4V9" /></svg>;
}
