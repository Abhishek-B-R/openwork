/** @jsxImportSource react */
import { LockKeyhole, Minus, Plus, RefreshCw } from "lucide-react";
import { Link } from "react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";
import { IconImage } from "@/react-app/design-system/icon-image";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import type { ActivityResource, MemberActivityEntry } from "@/react-app/kernel/activity-types";
import type { AppNotification } from "@/react-app/kernel/notification-store";
import type { ActivityFeedItem } from "./use-activity-feed";

function activityLabel(entry: MemberActivityEntry, compact: boolean) {
  if (entry.change === "available") return t("activity.available", { label: entry.resource.label });
  if (entry.change === "updated") return t(compact ? "activity.compact_updated" : "activity.updated", { label: entry.resource.label });
  return t(compact ? "activity.compact_unavailable" : "activity.unavailable", { label: entry.resource.label });
}

export function formatActivityTime(timestamp: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return t("activity.just_now");
  if (minutes < 60) return t("activity.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("activity.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("activity.yesterday");
  if (days < 7) return new Date(timestamp).toLocaleDateString(currentLocale(), { weekday: "short" });
  return new Date(timestamp).toLocaleDateString(currentLocale(), { month: "short", day: "numeric" });
}

function ObservedTime({ timestamp, now, compact = false }: { timestamp: number; now: number; compact?: boolean }) {
  const label = t("activity.observed_at", { time: new Date(timestamp).toLocaleString(currentLocale()) });
  if (compact) {
    return <time dateTime={new Date(timestamp).toISOString()} aria-label={label} title={label} className="shrink-0 text-[11px] text-muted-foreground/70">{formatActivityTime(timestamp, now)}</time>;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={new Date(timestamp).toISOString()} aria-label={label} tabIndex={0} />} className="w-16 shrink-0 rounded-sm text-right text-xs text-muted-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {formatActivityTime(timestamp, now)}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ResourceMark({ entry, compact }: { entry: MemberActivityEntry; compact: boolean }) {
  const { resource } = entry;
  const initial = <span className="text-xs font-medium">{resource.label.slice(0, 1).toLocaleUpperCase()}</span>;
  const ChangeIcon = entry.change === "available" ? Plus : entry.change === "updated" ? RefreshCw : Minus;
  if (compact && (!resource.serviceId || entry.change === "unavailable")) {
    return <ChangeIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={1.5} />;
  }
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center text-muted-foreground", compact ? "size-3.5" : "size-6 rounded-full", !compact && !resource.serviceId && "bg-muted")}>
      {resource.kind === "provider" && resource.serviceId ? (
        <ProviderIcon providerId={resource.serviceId} providerName={resource.label} />
      ) : (
        <IconImage src={resolveExtensionIconUrl({ iconSlug: resource.serviceId })} size={compact ? 14 : 16} fallback={initial} />
      )}
    </span>
  );
}

const RESOURCE_ACTION: Record<ActivityResource["kind"], string> = {
  provider: "activity.open_models",
  skill: "activity.open_skill",
  plugin: "activity.open_plugin",
  connection: "activity.open_connection",
};

const RESOURCE_KIND: Record<ActivityResource["kind"], string> = {
  provider: "activity.kind_provider", skill: "activity.kind_skill", plugin: "activity.kind_plugin", connection: "activity.kind_connection",
};

const ACTION_LAYOUT = "w-18 shrink-0 justify-end px-0";

export function ActivityRow({ item, now, compact = false, onResourceOpen, onSystemAction }: {
  item: ActivityFeedItem;
  now: number;
  compact?: boolean;
  onResourceOpen?: () => void;
  onSystemAction: (notification: AppNotification) => void;
}) {
  const rowLayout = cn("flex min-w-0 items-center rounded-lg", compact ? "h-8.5 gap-2.5 px-2" : "min-h-13 gap-3 px-3 py-2 hover:bg-muted/40");
  if (item.type === "system") {
    const notice = item.notification;
    const detail = notice.body ? `${notice.title}\n${notice.body}` : notice.title;
    const content = (
      <>
        <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center", compact ? "size-3.5" : "size-6")}><ProviderIcon providerId="openwork" /></span>
        <span className="min-w-0 flex-1 text-start" title={detail}>
          <span className={cn("block truncate text-sm font-normal", notice.severity === "error" && "text-destructive", notice.severity === "warning" && "text-warning")}>{notice.title}</span>
          {!compact && notice.body ? <span className="block truncate text-xs text-muted-foreground/70">{notice.body}</span> : null}
        </span>
        <ObservedTime timestamp={item.timestamp} now={now} compact={compact} />
      </>
    );
    if (compact && notice.action) {
      return (
        <div role="listitem" data-activity-row={notice.id} data-activity-kind="system">
          <Button variant="ghost" className={cn(rowLayout, "w-full justify-start")} aria-label={notice.actionLabel ?? notice.title} aria-description={detail} onClick={() => onSystemAction(notice)}>
            {content}
          </Button>
        </div>
      );
    }
    return (
      <div role="listitem" data-activity-row={notice.id} data-activity-kind="system" className={rowLayout}>
        {content}
        {!compact && notice.action && notice.actionLabel ? (
          <Button variant="ghost" size="xs" className="min-w-18 shrink-0 justify-end px-0" onClick={() => onSystemAction(notice)}>{notice.actionLabel}</Button>
        ) : null}
      </div>
    );
  }

  const { entry, unavailable } = item;
  const label = activityLabel(entry, compact);
  const detail = entry.resource.pluginName
    ? t("activity.skill_in_plugin", { plugin: entry.resource.pluginName })
    : t(RESOURCE_KIND[entry.resource.kind]);
  const hasDestination = entry.resource.href.startsWith("/") && !entry.resource.href.startsWith("//");
  const content = (
    <>
      <ResourceMark entry={entry} compact={compact} />
      <span className="min-w-0 flex-1 text-start" title={label}>
        <span className="block truncate text-sm font-normal leading-4.5">{label}</span>
        {!compact ? <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground/70">{detail}</span> : null}
      </span>
      <ObservedTime timestamp={item.timestamp} now={now} compact={compact} />
    </>
  );
  if (compact && !unavailable && hasDestination) {
    return (
      <div role="listitem" data-activity-row={entry.id} data-activity-kind={entry.resource.kind}>
        <Link to={entry.resource.href} onClick={onResourceOpen} className={cn(buttonVariants({ variant: "ghost" }), rowLayout, "w-full justify-start")} aria-label={t("activity.open_resource", { label: entry.resource.label })} aria-description={label}>
          {content}
        </Link>
      </div>
    );
  }
  return (
    <div role="listitem" data-activity-row={entry.id} data-activity-kind={entry.resource.kind} data-unavailable={unavailable || undefined} className={cn(rowLayout, unavailable && "text-muted-foreground/70")}>
      {content}
      {!compact && !unavailable && hasDestination ? (
        <Link to={entry.resource.href} className={cn(buttonVariants({ variant: "ghost", size: "xs" }), ACTION_LAYOUT)} aria-label={t("activity.open_resource", { label: entry.resource.label })}>
          {t(RESOURCE_ACTION[entry.resource.kind])}
        </Link>
      ) : !compact ? <span className="flex w-18 shrink-0 justify-end">{unavailable ? <LockKeyhole aria-label={t("activity.resource_unavailable")} className="size-3.5" strokeWidth={1.5} /> : null}</span> : null}
    </div>
  );
}
