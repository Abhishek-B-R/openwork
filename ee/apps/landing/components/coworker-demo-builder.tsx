"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, Check } from "lucide-react";
import { AvatarControls, CoworkerAvatar, type AvatarColor, type AvatarGlasses } from "./coworker-brand";
import { PERSONALITY_OPTIONS, previewSayings, type Personality } from "../../../../apps/coworker/src/lib/personalities";

export type DemoCoworker = { id: "custom"; name: string; role: string; mission: string; color: AvatarColor; glasses: AvatarGlasses; personality: Personality };
export const DEFAULT_DEMO_COWORKER: DemoCoworker = {
  id: "custom", name: "Milo", role: "Research partner", mission: "Find the useful details and turn them into a clear next step.",
  color: "violet", glasses: "round", personality: "warm",
};

/** The app's two creation steps, using its actual avatar/appearance components
 * and personality catalog, with a local-only submit instead of the desktop bridge. */
export function CoworkerDemoBuilder({ value, onChange, onCreate }: {
  value: DemoCoworker; onChange: (next: DemoCoworker) => void; onCreate: () => void;
}) {
  const [step, setStep] = useState<"identity" | "details">("identity");
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest(".cw-demo-content")?.scrollTo({ top: 0, behavior: "auto" });
    heading.current?.closest(".cw-demo")?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [step]);
  const saying = previewSayings(value.personality, value.name, 1)[0];
  return <div className="cw-demo-builder">
    <aside className="cw-demo-builder-preview" aria-label="Live coworker preview">
      <CoworkerAvatar name={value.name || "Your coworker"} color={value.color} glasses={value.glasses} size={104} />
      <div><h4>{value.name.trim() || "Your coworker"}</h4><p>{value.role.trim() || "A role you choose"}</p>
        <span className="cw-demo-personality-preview" data-testid="demo-personality-preview">{saying || "Working"}…</span>
      </div>
    </aside>
    <form className="cw-demo-builder-form" onSubmit={(event) => { event.preventDefault(); if (value.name.trim()) onCreate(); }}>
      <div className="cw-demo-step-label"><span className={step === "identity" ? "is-current" : ""}>01 · Name & look</span><span className={step === "details" ? "is-current" : ""}>02 · Role & mission</span></div>
      <h4 ref={heading} tabIndex={-1}>{step === "identity" ? "Make it your coworker." : "Give it a purpose."}</h4>
      <p className="cw-demo-description">{step === "identity" ? "Start with a name and a look. The preview changes as you go." : "Tell your coworker what to help with. You can change all of this later."}</p>
      {step === "identity" ? <>
        <label className="cw-demo-field">Name<input name="demo-name" aria-label="Coworker name" value={value.name} maxLength={32} required onChange={(event) => onChange({ ...value, name: event.target.value })} autoComplete="off" /></label>
        <div className="cw-demo-avatar-controls"><AvatarControls color={value.color} glasses={value.glasses} onColorChange={(color) => onChange({ ...value, color })} onGlassesChange={(glasses) => onChange({ ...value, glasses })} /></div>
      </> : <>
        <label className="cw-demo-field">Role<input name="demo-role" aria-label="Coworker role" maxLength={60} value={value.role} onChange={(event) => onChange({ ...value, role: event.target.value })} autoComplete="off" /></label>
        <label className="cw-demo-field">Mission<textarea name="demo-mission" aria-label="Coworker mission" maxLength={180} rows={2} value={value.mission} onChange={(event) => onChange({ ...value, mission: event.target.value })} /></label>
        <fieldset className="cw-demo-personalities"><legend>Personality</legend><div>{PERSONALITY_OPTIONS.filter((option) => ["neutral", "warm", "curious", "thoughtful"].includes(option.id)).map((option) => <button type="button" key={option.id} aria-pressed={value.personality === option.id} onClick={() => onChange({ ...value, personality: option.id })}>{option.label}</button>)}</div></fieldset>
        <p className="mt-3 text-[11px] leading-5 text-[var(--cw-muted)]">Personality changes the wording while working. Role and mission give the work its direction.</p>
      </>}
      <div className="cw-demo-builder-actions">{step === "identity" ? <button type="button" className="cw-demo-small-button" onClick={() => setStep("details")} disabled={!value.name.trim()}>Role, mission & personality<ArrowRight size={14} aria-hidden="true" /></button> : <><button type="button" className="cw-demo-text-button" onClick={() => setStep("identity")}><ChevronLeft size={14} aria-hidden="true" />Name & look</button><button type="submit" className="cw-demo-small-button" disabled={!value.name.trim()}>Add to demo<Check size={14} aria-hidden="true" /></button></>}</div>
      <p className="mt-4 text-[10px] leading-5 text-[var(--cw-muted)]">Try a fictional coworker. These details stay in this page and clear on reset.</p>
    </form>
  </div>;
}
