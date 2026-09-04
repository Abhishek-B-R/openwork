/**
 * Coworker settings and the Memory view as one illustration: what is yours to
 * shape. Every label is one the app uses (`apps/coworker/src/ui/coworker-home.tsx`
 * Coworker settings → Profile / AI model / Memory; `personality-picker.tsx`;
 * `model-picker.tsx` Automatic; `memory.tsx` Soul / Working memory / Long-term /
 * Recent changes / Undo; `new-coworker.tsx` Add a coworker). Nothing here is a
 * screenshot and nothing shows a control the app lacks.
 */
import type { ReactNode } from "react";

import { CoworkerAvatar, type AvatarColor, type AvatarGlasses } from "./coworker-brand";

const INK = "#0b0e14";
const PANEL = "#141924";
const LINE = "rgba(255,255,255,0.08)";
const SNOW = "#f4f6fa";
const MIST = "#9aa3b2";
const SPARK = "#8fb0ff";

export const AVATAR_COLORS: AvatarColor[] = ["blue", "violet", "mint", "orange", "rose", "slate"];
export const GLASSES: AvatarGlasses[] = ["round", "square", "none"];

/** The app's twelve voices, as the picker lists them (`PERSONALITY_OPTIONS`). */
export const VOICES = ["Neutral", "Warm", "Calm", "Eager", "Playful", "Dry", "Blunt", "Curious", "Thoughtful", "Meticulous", "Detective", "None"] as const;

/** What Automatic would do with one provider connected, in the picker's own words. */
export const AUTOMATIC_PREVIEW = "Quick GPT-5 mini · Standard GPT-5 · Deep GPT-5 pro";

/** Recent changes as the Memory view lists them: the conversation's own action words, each with Undo. */
export const RECENT_CHANGES = [
  "Updated how I work · Shorter replies",
  "Moved to long-term memory · You work in Product",
  "Noted · Vendor comparison — two contracts read; next: call Beta",
] as const;

function Heading({ children }: { children: string }) {
  return <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: MIST }}>{children}</p>;
}

function Field({ label, value, placeholder = false }: { label: string; value: string; placeholder?: boolean }) {
  return (
    <label className="block">
      <span className="block text-[11px]" style={{ color: MIST }}>{label}</span>
      <span className="mt-1 block truncate rounded-lg px-2.5 py-1.5 text-[12.5px]" style={{ background: INK, boxShadow: `inset 0 0 0 1px ${LINE}`, color: placeholder ? "rgba(154,163,178,0.7)" : SNOW }}>
        {value}
      </span>
    </label>
  );
}

function Pill({ children, selected = false }: { children: string; selected?: boolean }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px]"
      style={selected ? { background: "rgba(255,255,255,0.12)", color: SNOW, boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.14)` } : { color: MIST, boxShadow: `inset 0 0 0 1px ${LINE}` }}
    >
      {children}
    </span>
  );
}

function Row({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5" style={last ? undefined : { borderBottom: `1px solid ${LINE}` }}>
      {children}
    </div>
  );
}

export function CoworkerSettingsVignette() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--lp-border)]" style={{ background: INK }} data-testid="coworker-settings-vignette">
      <div className="flex h-[48px] items-center gap-3 border-b px-4" style={{ borderColor: LINE }}>
        <span aria-hidden="true" className="text-[12px]" style={{ color: MIST }}>‹ Activity</span>
        <span className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold" style={{ color: SNOW }}>Coworker settings</span>
        <CoworkerAvatar name="Scout" color="blue" glasses="round" size={24} />
      </div>

      <div className="grid grid-cols-1 gap-px md:grid-cols-2" style={{ background: LINE }}>
        {/* Profile, voice, and face */}
        <section className="space-y-5 p-5" style={{ background: PANEL }}>
          <div className="space-y-3">
            <Heading>Profile</Heading>
            <Field label="Name" value="Scout" />
            <Field label="Role" value="Research" />
            <Field label="Mission" value="Keep the competitive picture current and say what changed." />
          </div>
          <div className="space-y-2">
            <Heading>Personality</Heading>
            <div className="flex flex-wrap gap-1.5">
              {VOICES.map((voice) => (
                <Pill key={voice} selected={voice === "Curious"}>{voice}</Pill>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed" style={{ color: MIST }}>Changes what the interface says while Scout works — never how Scout works or writes.</p>
          </div>
          <div className="space-y-2">
            <Heading>Face</Heading>
            <div className="flex items-center gap-3">
              <span className="flex gap-1.5">
                {AVATAR_COLORS.map((color) => (
                  <span key={color} className="rounded-full" style={color === "blue" ? { boxShadow: `0 0 0 2px ${INK}, 0 0 0 3.5px ${SPARK}` } : undefined}>
                    <CoworkerAvatar name={`Scout in ${color}`} color={color} glasses="round" size={22} />
                  </span>
                ))}
              </span>
              <span className="h-4 w-px" style={{ background: LINE }} aria-hidden="true" />
              <span className="flex gap-1.5">
                {GLASSES.map((glasses) => (
                  <span key={glasses} className="rounded-full" style={glasses === "round" ? { boxShadow: `0 0 0 2px ${INK}, 0 0 0 3.5px ${SPARK}` } : undefined}>
                    <CoworkerAvatar name={`Scout with ${glasses} glasses`} color="blue" glasses={glasses} size={22} />
                  </span>
                ))}
              </span>
            </div>
          </div>
        </section>

        {/* AI model and memory */}
        <section className="space-y-5 p-5" style={{ background: PANEL }}>
          <div className="space-y-2">
            <Heading>AI model</Heading>
            <div className="rounded-xl" style={{ background: INK, boxShadow: `inset 0 0 0 1px ${LINE}` }}>
              <Row>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[12.5px] font-semibold" style={{ color: SNOW }}>
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: "#3ed5a6" }} />
                    Automatic
                  </span>
                  <span className="mt-0.5 block truncate text-[11px]" style={{ color: MIST }}>{AUTOMATIC_PREVIEW}</span>
                </span>
                <span aria-hidden="true" style={{ color: MIST }}>⌄</span>
              </Row>
              <Row last>
                <span className="text-[11px]" style={{ color: MIST }}>Thinking effort for the standard model</span>
                <span className="text-[11px]" style={{ color: SNOW }}>Model default</span>
              </Row>
            </div>
            <p className="text-[11px] leading-relaxed" style={{ color: MIST }}>Scout reads each message and picks a quick, standard, or deep model for it; the conversation says which one is answering.</p>
          </div>
          <div className="space-y-2">
            <Heading>Memory</Heading>
            <div className="flex gap-1.5">
              <Pill selected>Soul</Pill>
              <Pill>Working memory</Pill>
              <Pill>Long-term</Pill>
            </div>
            <div className="rounded-xl px-3 py-2.5 text-[12px] leading-relaxed" style={{ background: INK, boxShadow: `inset 0 0 0 1px ${LINE}`, color: SNOW }}>
              <span className="block text-[11px]" style={{ color: MIST }}>## Principles</span>
              <span className="block">- Own assigned work end to end; surface blockers instead of stalling.</span>
              <span className="block">- Ask for approval before consequential or irreversible actions.</span>
              <span className="mt-1.5 flex justify-end gap-3 text-[11px]" style={{ color: MIST }}>
                <span>Edit</span>
              </span>
            </div>
            <p className="pt-1 text-[11px]" style={{ color: MIST }}>Recent changes</p>
            <div className="rounded-xl" style={{ background: INK, boxShadow: `inset 0 0 0 1px ${LINE}` }}>
              {RECENT_CHANGES.map((change, index) => (
                <Row key={change} last={index === RECENT_CHANGES.length - 1}>
                  <span className="min-w-0 truncate text-[11.5px]" style={{ color: SNOW }}>{change}</span>
                  <span className="shrink-0 text-[11px] font-medium" style={{ color: SPARK }}>Undo</span>
                </Row>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* Team strip */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-5 py-3 text-[12px]" style={{ borderColor: LINE, color: MIST }}>
        <Heading>Team</Heading>
        <span className="inline-flex items-center gap-2">
          <CoworkerAvatar name="Editor" color="rose" glasses="square" size={20} />
          <span style={{ color: SNOW }}>Editor</span> · Writing
        </span>
        <span className="inline-flex items-center gap-2">
          <CoworkerAvatar name="Ops" color="mint" glasses="none" size={20} />
          <span style={{ color: SNOW }}>Ops</span> · Operations
        </span>
        <span className="rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ color: SNOW, boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.16)` }}>Add a coworker</span>
        <span className="ml-auto text-[11px]">Retired coworkers · 1</span>
      </div>
    </div>
  );
}
