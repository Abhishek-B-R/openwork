/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { ActivityEmpty } from "@/react-app/domains/activity/activity-empty";
import { ActivityRow } from "@/react-app/domains/activity/activity-row";
import { ActivityLoading, ActivityRefreshError } from "@/react-app/domains/activity/activity-status";
import { useActivityActions } from "@/react-app/domains/activity/use-activity-actions";
import { useActivityFeed } from "@/react-app/domains/activity/use-activity-feed";
import { useNotificationStore } from "@/react-app/kernel/notification-store";
import { useControlAction, type OpenworkControlAction } from "./control/control-provider";
import { openNotificationCenterEvent } from "./notifications";
import { useShellConfig } from "./shell-config";

/** Shared Activity entry point. Opening it never changes persisted history. */
export function NotificationBell({ align = "end" }: { align?: "start" | "end" }) {
  const { config } = useShellConfig();
  const [open, setOpen] = useState(false);
  const notifications = useNotificationStore((state) => state.notifications);
  const { items, context, refreshState, loading, now } = useActivityFeed(open && config.notifications);
  const runAction = useActivityActions();
  const navigate = useNavigate();

  const notificationsListAction = useMemo<OpenworkControlAction>(() => ({
    id: "notifications.list",
    label: "List notifications",
    description: "Return the current background notification entries.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => notifications.map((notification) => ({
      id: notification.id,
      kind: notification.kind,
      severity: notification.severity,
      title: notification.title,
      body: notification.body,
      count: notification.count,
      readAt: notification.readAt,
      actionType: notification.action?.type ?? null,
      actionLabel: notification.actionLabel ?? null,
    })),
  }), [notifications]);
  useControlAction(notificationsListAction);
  const activityListAction = useMemo<OpenworkControlAction>(() => ({
    id: "activity.list",
    label: "List activity",
    description: "Read this member's device-observed activity and verification status.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => ({ entries: context.entries, verifiedAt: context.verifiedAt, refreshState }),
  }), [context, refreshState]);
  useControlAction(activityListAction);

  useEffect(() => {
    if (!config.notifications) return;
    const handler = () => setOpen(true);
    window.addEventListener(openNotificationCenterEvent, handler);
    return () => window.removeEventListener(openNotificationCenterEvent, handler);
  }, [config.notifications]);

  if (!config.notifications) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={
        <Button variant="ghost" size="icon-sm" data-notification-bell className="rounded-lg titlebar-no-drag" title={t("activity.title")} aria-label={t("activity.title")}>
          <Bell strokeWidth={1.5} />
        </Button>
      } />
      <PopoverContent align={align} side="bottom" sideOffset={4} data-notification-panel className={cn("max-w-[calc(100vw-1rem)] gap-0 overflow-hidden rounded-xl p-0 data-open:animate-none motion-reduce:animate-none!", items.length === 0 ? "w-95" : "w-85")}>
        <div className="flex h-10 items-center justify-between gap-3 px-3.5">
          <PopoverTitle className="text-sm font-semibold">{t("activity.title")}</PopoverTitle>
          <Button variant="ghost" size="xs" onClick={() => { setOpen(false); navigate("/activity"); }}>
            {t("activity.view_all")}
          </Button>
        </div>
        {refreshState === "error" ? <ActivityRefreshError verifiedAt={context.verifiedAt} now={now} /> : null}
        {loading ? <ActivityLoading compact /> : items.length === 0 ? (refreshState === "error" ? null : <ActivityEmpty compact />) : (
          <div role="list" className="px-1.5 pb-1.5">
            {items.slice(0, 5).map((item) => (
              <ActivityRow key={item.id} item={item} now={now} compact onResourceOpen={() => setOpen(false)} onSystemAction={(notification) => { setOpen(false); runAction(notification); }} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
