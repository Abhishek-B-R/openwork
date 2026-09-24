import type { ReactNode } from "react";
import type { CoworkerSummary } from "@/lib/bridge";
import type { CalendarData } from "@/ui/calendar-data";
import type {
  CalendarPreferences,
  CalendarPreferencesChange,
} from "@/ui/calendar-preferences";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { ActivityIcon } from "@/ui/kit";
import { CalendarIcon } from "@/ui/main-content-switch";

export function CalendarSidebar({
  coworkers,
  data,
  preferences,
  onPreferencesChange,
  query,
  compact = false,
}: {
  coworkers: CoworkerSummary[];
  data: CalendarData;
  preferences: CalendarPreferences;
  onPreferencesChange: CalendarPreferencesChange;
  query: string;
  compact?: boolean;
}) {
  const slugs = [
    ...new Set([
      ...coworkers.map((member) => member.slug),
      ...data.events.flatMap((event) => event.participantSlugs),
      ...data.eventRuns.flatMap((run) => run.event.participantSlugs),
      ...data.responsibilities.flatMap((item) => item.ownerSlugs),
    ]),
  ];
  const matching = slugs.filter((slug) => {
    const coworker = coworkers.find((member) => member.slug === slug);
    return `${coworker?.name ?? ""} ${coworker?.role ?? ""} ${slug}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });
  const toggleCoworker = (slug: string) => onPreferencesChange((value) => {
    const current = value.coworkerSlugs ?? slugs;
    return {
      ...value,
      coworkerSlugs: current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug],
    };
  });
  const sources: { key: "events" | "responsibilities"; label: string; count: number; icon: ReactNode; color: string }[] = [
    { key: "events", label: "Events", count: data.events.length, icon: <CalendarIcon />, color: "text-spark" },
    { key: "responsibilities", label: "Work", count: data.responsibilities.length, icon: <ActivityIcon />, color: "text-mint" },
  ];

  if (compact) return (
    <section className="min-h-0 flex-1 overflow-y-auto px-1 pb-3 pt-2" aria-label="Calendar filters" data-testid="calendar-sidebar">
      <p className="mb-1 text-center text-[9px] font-semibold uppercase tracking-wide text-mist">Sources</p>
      <div className="flex flex-col items-center gap-1 border-b border-line pb-2">
        {sources.map((source) => (
          <button key={source.key} type="button" aria-label={data.loading ? `Reading ${source.label.toLowerCase()}` : `${source.label}, ${source.count} total`} aria-pressed={preferences[source.key]}
            title={`${source.label}: ${data.loading ? "loading" : source.count} · ${preferences[source.key] ? "shown" : "hidden"}`}
            onClick={() => onPreferencesChange((value) => ({ ...value, [source.key]: !value[source.key] }))}
            className={`window-no-drag flex w-16 flex-col items-center rounded-lg px-1 py-1.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${preferences[source.key] ? "bg-white/8 text-snow" : "text-mist opacity-60 hover:opacity-100"}`}>
            <span className={source.color}>{source.icon}</span>
            <span className="mt-0.5 text-[10px] leading-3">{source.label}</span>
            <span className="text-[9px] tabular-nums text-mist">{data.loading ? "…" : source.count}</span>
          </button>
        ))}
      </div>
      <p className="mb-1 mt-2 text-center text-[9px] font-semibold uppercase tracking-wide text-mist">People</p>
      <div className="flex flex-col items-center gap-1">
        <button type="button" aria-label="Everyone on calendar" aria-pressed={preferences.coworkerSlugs === null}
          title={`Everyone · ${preferences.coworkerSlugs === null ? "shown" : "filtered"}`}
          onClick={() => onPreferencesChange((value) => ({ ...value, coworkerSlugs: value.coworkerSlugs === null ? [] : null }))}
          className={`window-no-drag flex w-16 flex-col items-center rounded-lg px-1 py-1.5 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${preferences.coworkerSlugs === null ? "bg-white/8 text-snow" : "text-mist hover:bg-white/5"}`}>
          <ActivityIcon /><span className="mt-0.5 leading-3">Everyone</span>
        </button>
        {matching.map((slug) => {
          const coworker = coworkers.find((member) => member.slug === slug);
          const selected = preferences.coworkerSlugs === null || preferences.coworkerSlugs.includes(slug);
          const name = coworker?.name ?? `${slug} (historical)`;
          return <button key={slug} type="button" aria-label={`${name} on calendar`} aria-pressed={selected} title={`${name} · ${selected ? "shown" : "hidden"}`}
            onClick={() => toggleCoworker(slug)}
            className={`window-no-drag flex w-16 flex-col items-center rounded-lg px-1 py-1.5 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${selected ? "bg-white/8 text-snow" : "text-mist opacity-60 hover:opacity-100"}`}>
            {coworker ? <CoworkerAvatar identity={coworker.slug} name={coworker.name} color={coworker.avatarColor} glasses={coworker.avatarGlasses} size={24} motion="quiet" animated={false} gaze={false} />
              : <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full border border-line">{slug.slice(0, 1).toUpperCase()}</span>}
            <span className="mt-0.5 block w-full truncate leading-3">{coworker?.name ?? slug}</span>
          </button>;
        })}
        {matching.length === 0 ? <p className="px-1 text-center text-[10px] leading-snug text-mist">{data.loading ? "Loading..." : query.trim() ? "No matches" : "No coworkers"}</p> : null}
      </div>
    </section>
  );

  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto p-3"
      aria-label="Calendar filters"
      data-testid="calendar-sidebar"
    >
      <header className="mb-4 border-b border-line pb-3">
        <h2 className="text-sm font-semibold text-snow">
          Your team's calendar
        </h2>
        <p className="mt-1 text-[10px] text-mist">Choose whose work appears.</p>
      </header>
      <fieldset
        className="mb-4 space-y-1 border-b border-line pb-4"
        aria-label="Calendar sources"
      >
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-mist">
          Sources
        </legend>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-snow hover:bg-white/4">
          <input
            type="checkbox"
            className="shrink-0 accent-spark"
            checked={preferences.events}
            onChange={(event) =>
              onPreferencesChange((value) => ({
                ...value,
                events: event.target.checked,
              }))
            }
          />
          <span className="shrink-0 text-spark">
            <CalendarIcon />
          </span>
          Events
        </label>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-snow hover:bg-white/4">
          <input
            type="checkbox"
            className="shrink-0 accent-mint"
            checked={preferences.responsibilities}
            onChange={(event) =>
              onPreferencesChange((value) => ({
                ...value,
                responsibilities: event.target.checked,
              }))
            }
          />
          <span className="shrink-0 text-mint">
            <ActivityIcon />
          </span>
          Responsibilities
        </label>
      </fieldset>
      <fieldset aria-label="Calendar coworkers" className="space-y-1">
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-mist">
          Coworkers
        </legend>
        <label className="flex min-h-9 items-center gap-2 rounded-lg px-1 py-1.5 text-xs font-medium text-snow hover:bg-white/4">
          <input
            type="checkbox"
            className="shrink-0 accent-spark"
            checked={preferences.coworkerSlugs === null}
            onChange={(event) =>
              onPreferencesChange((value) => ({
                ...value,
                coworkerSlugs: event.target.checked ? null : [],
              }))
            }
          />
          <span className="flex size-6 shrink-0 items-center justify-center text-mist">
            <ActivityIcon />
          </span>
          Everyone
        </label>
        {matching.map((slug) => {
          const coworker = coworkers.find((member) => member.slug === slug);
          return (
            <label
              key={slug}
              className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-mist hover:bg-white/4"
            >
              <input
                type="checkbox"
                className="shrink-0 accent-spark"
                checked={
                  preferences.coworkerSlugs === null ||
                  preferences.coworkerSlugs.includes(slug)
                }
                onChange={() => toggleCoworker(slug)}
              />
              <span className="flex size-6 shrink-0 items-center justify-center">
                {coworker ? (
                  <CoworkerAvatar
                    identity={coworker.slug}
                    name={coworker.name}
                    color={coworker.avatarColor}
                    glasses={coworker.avatarGlasses}
                    size={24}
                    motion="quiet"
                    animated={false}
                    gaze={false}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-6 items-center justify-center rounded-full border border-line text-[10px]"
                  >
                    {slug.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </span>
              <span className="min-w-0 break-words">
                {coworker?.name ?? `${slug} (historical)`}
              </span>
            </label>
          );
        })}
        {matching.length === 0 ? (
          <p className="px-1 py-2 text-xs text-mist">
            {data.loading
              ? "Reading calendars..."
              : query.trim()
                ? "No matching coworkers."
                : "No coworker calendars yet."}
          </p>
        ) : null}
      </fieldset>
    </section>
  );
}
