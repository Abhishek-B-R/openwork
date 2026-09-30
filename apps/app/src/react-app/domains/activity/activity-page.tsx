/** @jsxImportSource react */
import { useMemo, useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { currentLocale, t } from "@/i18n";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { ActivityEmpty } from "./activity-empty";
import { ActivityRow } from "./activity-row";
import { ActivityLoading, ActivityRefreshError } from "./activity-status";
import { useActivityActions } from "./use-activity-actions";
import { useActivityFeed, type ActivityFeedItem } from "./use-activity-feed";

function dayLabel(timestamp: number, now: number) {
  const day = new Date(timestamp);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return t("activity.today");
  if (day.toDateString() === yesterday.toDateString()) return t("activity.yesterday");
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
  if (day >= weekStart) return t("activity.earlier_this_week");
  return day.toLocaleDateString(currentLocale(), {
    month: "long", day: "numeric", year: day.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

export function ActivityPage() {
  const { config } = useShellConfig();
  const [filter, setFilter] = useState("all");
  const { items, context, refreshState, loading, now } = useActivityFeed(config.notifications);
  const runAction = useActivityActions();
  const groups = useMemo(() => {
    const byDay = new Map<string, ActivityFeedItem[]>();
    for (const item of items) {
      if (filter !== "all" && (item.type !== "member" || item.entry.resource.kind !== filter)) continue;
      const day = dayLabel(item.timestamp, now);
      const group = byDay.get(day);
      if (group) group.push(item);
      else byDay.set(day, [item]);
    }
    return [...byDay.entries()];
  }, [filter, items, now]);

  if (!config.notifications) return null;

  return (
    <section data-activity-page aria-label={t("activity.title")} className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-198 flex-col gap-5 px-4 pb-12 pt-12 lg:pt-32">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl font-semibold tracking-tight">{t("activity.title")}</h1>
          <div className="max-w-full overflow-x-auto">
            <ToggleGroup value={[filter]} onValueChange={(values) => { if (values[0]) setFilter(values[0]); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("activity.filter")}>
              <ToggleGroupItem value="all">{t("activity.filter_all")}</ToggleGroupItem>
              <ToggleGroupItem value="provider">{t("activity.filter_models")}</ToggleGroupItem>
              <ToggleGroupItem value="skill">{t("activity.filter_skills")}</ToggleGroupItem>
              <ToggleGroupItem value="plugin">{t("activity.filter_plugins")}</ToggleGroupItem>
              <ToggleGroupItem value="connection">{t("activity.filter_connections")}</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        {refreshState === "error" ? <ActivityRefreshError verifiedAt={context.verifiedAt} now={now} /> : null}
        {loading ? <ActivityLoading /> : groups.length === 0 ? (
          refreshState === "error" && items.length === 0 ? null : <ActivityEmpty onShowAll={filter === "all" ? undefined : () => setFilter("all")} />
        ) : <div>{groups.map(([day, group]) => (
          <section key={day} aria-label={day} className="flex flex-col">
            <h2 className="px-3 pb-1.5 pt-4 text-xs font-medium text-muted-foreground">{day}</h2>
            <div role="list">
              {group.map((item) => <ActivityRow key={item.id} item={item} now={now} onSystemAction={runAction} />)}
            </div>
          </section>
        ))}</div>}
      </div>
    </section>
  );
}
