import { useEffect, useMemo, useState } from "react";

import { selectActivityContext, useActivityStore } from "@/react-app/kernel/activity-store";
import type { ActivitySource, MemberActivityEntry } from "@/react-app/kernel/activity-types";
import { useNotificationStore, type AppNotification } from "@/react-app/kernel/notification-store";

export type ActivityFeedItem =
  | { type: "member"; id: string; timestamp: number; entry: MemberActivityEntry; unavailable: boolean }
  | { type: "system"; id: string; timestamp: number; notification: AppNotification };

const RESOURCE_SOURCE: Record<MemberActivityEntry["resource"]["kind"], ActivitySource> = {
  provider: "providers",
  skill: "capabilities",
  plugin: "capabilities",
  connection: "connections",
};

/** Only the current member scope contributes resource history; notices stay local. */
export function useActivityFeed(active = true) {
  const context = useActivityStore(selectActivityContext);
  const activeScopeKey = useActivityStore((state) => state.activeScopeKey);
  const refreshState = useActivityStore((state) => state.refreshState);
  const notifications = useNotificationStore((state) => state.notifications);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [active]);

  const items = useMemo(() => {
    const result: ActivityFeedItem[] = context.entries.map((entry) => {
      const snapshot = context.snapshots[RESOURCE_SOURCE[entry.resource.kind]];
      const unavailable = entry.change === "unavailable" || snapshot?.every(
        (resource) => resource.kind !== entry.resource.kind || resource.id !== entry.resource.id,
      ) === true;
      return { type: "member", id: `member:${entry.id}`, timestamp: entry.observedAt, entry, unavailable };
    });
    result.push(...notifications.map((notification): ActivityFeedItem => ({
      type: "system", id: `system:${notification.id}`, timestamp: notification.updatedAt, notification,
    })));
    return result.sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id));
  }, [context, notifications]);

  const loading = activeScopeKey !== null && refreshState === "refreshing"
    && items.length === 0 && Object.keys(context.snapshots).length === 0;

  return { items, context, activeScopeKey, refreshState, loading, now };
}
