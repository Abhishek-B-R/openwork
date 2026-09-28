import { useState, type CSSProperties, type ReactNode } from "react";
import { FEATURES, featureProfile, profileFeatures } from "@/lib/features";
import { Button } from "@/ui/kit";
import { setFeatures, useFeatures } from "@/ui/use-features";

type Experience = "simple" | "advanced";

const EXPERIENCES: { id: Experience; label: string; detail: string }[] = [
  { id: "simple", label: "Simple", detail: "Your coworkers and your conversations. Everything else waits until you want it." },
  { id: "advanced", label: "Power user", detail: "Every feature on: the Marketplace, notifications, calendar, computer use and more." },
];

/** Soft coworker colors for the drawing: blue, violet and mint, as the avatars wear them. */
const SKETCH_FACES = ["#b8c9f0", "#c8c1e2", "#b2d5cb"];

/**
 * "Start simple, or with everything?": the same choice as Settings › Features,
 * made once during onboarding. Simple turns every optional feature off, Power
 * user turns every one on. Whatever is set now is chosen already; a custom mix
 * chooses neither, and Continue keeps it as it is.
 */
export function OnboardingExperience({ onBack, onContinue, replay = false }: {
  onBack: () => void;
  onContinue: () => void;
  /** Settings › Fresh start's tour: the last step, so Continue returns to the team. */
  replay?: boolean;
}) {
  const features = useFeatures();
  const current = featureProfile(features);
  const [choice, setChoice] = useState<Experience | null>(current === "custom" ? null : current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const action = replay ? "Back to my team" : "Continue";

  async function next() {
    setSaving(true);
    setError("");
    try {
      if (choice && choice !== featureProfile(features)) await setFeatures(profileFeatures(choice));
      onContinue();
    } catch {
      setError("Your choice could not be saved. Try again, or set it later in Settings › Features.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="window-shell flex h-full min-h-[520px] flex-col overflow-y-auto" data-testid="onboarding-experience">
      <header className="window-drag flex h-[52px] shrink-0 items-center px-4 pl-20">
        <button
          type="button"
          className="window-no-drag flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
          onClick={onBack}
          data-testid="onboarding-experience-back"
        >
          <span aria-hidden="true">←</span>
          <span>Back</span>
        </button>
      </header>
      <main className="window-no-drag flex flex-1 items-center justify-center px-6 py-8 short:py-4">
        <section className="w-full max-w-[720px]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">Your experience</p>
          <h1 id="onboarding-experience-title" tabIndex={-1} className="mt-2 text-[32px] font-semibold leading-[1.08] tracking-[-0.045em] text-snow outline-none md:text-[36px]">Start simple, or with everything?</h1>
          <p className="mt-2 text-sm leading-6 text-mist">You can switch any time, or turn features on one at a time, in Settings › Features.</p>

          <div role="radiogroup" aria-labelledby="onboarding-experience-title" className="mt-6 grid gap-3 sm:grid-cols-2 short:mt-4">
            {EXPERIENCES.map((experience) => {
              const selected = choice === experience.id;
              return (
                <label
                  key={experience.id}
                  className={`group/experience flex min-w-0 cursor-pointer flex-col rounded-[20px] border p-2 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-spark/50 ${
                    // Both cards keep the dark panel under them, so the words stay readable over a light desktop.
                    selected ? "border-spark/60 bg-panel/60 bg-[linear-gradient(rgb(91_141_255/0.1),rgb(91_141_255/0.1))]" : "border-white/10 bg-panel/60 hover:border-white/20 hover:bg-panel/80"
                  }`}
                  data-testid={`onboarding-experience-${experience.id}`}
                >
                  <input type="radio" name="onboarding-experience" value={experience.id} checked={selected} onChange={() => setChoice(experience.id)} className="sr-only" />
                  <ExperienceSketch full={experience.id === "advanced"} />
                  <span className="flex items-center gap-2 px-2 pt-3 text-[14px] font-semibold text-snow short:pt-2">
                    <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-spark" : "border-white/25"}`}>
                      {selected ? <span className="size-2 rounded-full bg-spark" /> : null}
                    </span>
                    {experience.label}
                  </span>
                  <span className="block px-2 pb-2 pl-8 pt-1 text-[12px] leading-relaxed text-mist">{experience.detail}</span>
                </label>
              );
            })}
          </div>
          {current === "custom" && !choice ? (
            <p className="mt-3 text-xs text-mist" data-testid="onboarding-experience-custom">
              You have your own mix: {FEATURES.filter(({ id }) => features[id]).length} of {FEATURES.length} features on. {action} keeps it.
            </p>
          ) : null}
          {error ? <p role="alert" className="mt-3 text-xs text-rose">{error}</p> : null}

          <div className="mt-8 flex justify-end short:mt-5">
            <Button variant="primary" disabled={saving} aria-busy={saving || undefined} onClick={() => void next()} data-testid="onboarding-experience-continue">
              {action}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * A small drawing of the app. Power user's adds what its features bring: the
 * bell, the calendar tab and each coworker's calendar, the Marketplace, and
 * more side panels. They light up in turn while that card is hovered or
 * chosen, and go quiet at once when it is not.
 */
function ExperienceSketch({ full }: { full: boolean }) {
  let order = 0;
  const extra = (shape: string): ReactNode => (
    <span
      className={`${shape} bg-white/20 transition-colors duration-300 group-hover/experience:bg-spark group-hover/experience:delay-(--lit) group-has-checked/experience:bg-spark group-has-checked/experience:delay-(--lit)`}
      style={{ "--lit": `${order++ * 50}ms` } as CSSProperties}
    />
  );
  return (
    <span aria-hidden="true" className="flex h-[124px] overflow-hidden rounded-[12px] border border-white/10 bg-ink short:h-[96px]">
      <span className="flex w-[34%] flex-col gap-[5px] border-r border-white/[0.06] bg-panel/80 p-2 short:gap-[3px] short:p-1.5">
        <span className="flex h-[6px] items-center gap-[3px]">
          <span className="size-[4px] rounded-full bg-white/25" />
          <span className="size-[4px] rounded-full bg-white/25" />
          <span className="size-[4px] rounded-full bg-white/25" />
          {full ? <span className="ml-auto flex">{extra("size-[6px] rounded-[2px]")}</span> : null}
        </span>
        {full ? (
          <span className="flex gap-[3px] rounded-[4px] bg-white/[0.04] p-[2px]">
            <span className="h-[5px] flex-1 rounded-[2px] bg-white/25" />
            {extra("h-[5px] flex-1 rounded-[2px]")}
          </span>
        ) : null}
        <span className="h-[7px] shrink-0 rounded-[3px] border border-white/10" />
        {SKETCH_FACES.map((face) => (
          <span key={face} className="flex items-center gap-[4px]">
            <span className="size-[10px] shrink-0 rounded-[3px]" style={{ background: face }} />
            <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
              <span className="h-[3px] w-[70%] rounded-full bg-white/40" />
              <span className="flex items-center gap-[2px]">
                {full ? extra("size-[3px] shrink-0 rounded-[1px]") : null}
                <span className="h-[3px] w-1/2 rounded-full bg-white/15" />
              </span>
            </span>
          </span>
        ))}
        <span className="mt-auto flex items-center gap-[4px]">
          <span className="size-[8px] shrink-0 rounded-full bg-white/60" />
          <span className="h-[3px] w-[40%] rounded-full bg-white/25" />
          {full ? <span className="ml-auto flex">{extra("size-[6px] rounded-[2px]")}</span> : null}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[5px] p-2">
        <span className="mx-auto h-[7px] w-[42%] shrink-0 rounded-full border border-white/10 bg-white/[0.05]" />
        <span className="ml-auto mt-1 h-[8px] w-[38%] shrink-0 rounded-full bg-spark/70" />
        <span className="h-[8px] w-[62%] shrink-0 rounded-full bg-white/12" />
        <span className="h-[8px] w-[46%] shrink-0 rounded-full bg-white/12" />
        <span className="mt-auto flex h-[16px] shrink-0 items-center justify-end rounded-[6px] border border-white/10 bg-white/[0.03] px-[3px]">
          <span className="size-[8px] rounded-full bg-white/20" />
        </span>
      </span>
      <span className="flex w-[16px] shrink-0 flex-col items-center gap-[4px] border-l border-white/[0.06] py-2">
        <span className="size-[6px] rounded-[2px] bg-white/25" />
        {full ? extra("size-[6px] rounded-[2px]") : null}
        <span className="size-[6px] rounded-[2px] bg-white/25" />
        {full ? extra("size-[6px] rounded-[2px]") : null}
      </span>
    </span>
  );
}
