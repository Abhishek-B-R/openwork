/** @jsxImportSource react */
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { currentLocale, t } from "@/i18n";
import { ACTIVITY_REFRESH_EVENT } from "@/react-app/kernel/activity-types";
import { formatActivityTime } from "./activity-row";
import { cn } from "@/lib/utils";

export function ActivityLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div data-activity-loading aria-busy="true" aria-label={t("activity.title")}>
      {[0, 1, 2].map((row) => (
        <div key={row} className={cn("flex items-center gap-3 px-3", compact ? "h-8.5" : "h-13")} aria-hidden="true">
          <Skeleton className={cn("shrink-0 rounded-full motion-reduce:animate-none", compact ? "size-3.5" : "size-6")} />
          <Skeleton className="h-3 flex-1 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-10 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

export function ActivityRefreshError({ verifiedAt, now }: { verifiedAt: number | null; now: number }) {
  const message = verifiedAt === null
    ? t("activity.verify_failed")
    : t("activity.verify_failed_last", { time: formatActivityTime(verifiedAt, now) });
  return (
    <Alert role="status" className="rounded-none border-0" data-activity-refresh-error>
      <AlertTitle title={verifiedAt === null ? undefined : t("activity.last_verified", { time: new Date(verifiedAt).toLocaleString(currentLocale()) })}>{message}</AlertTitle>
      <AlertAction>
        <Button variant="ghost" size="sm" onClick={() => window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT))}>
          {t("activity.retry")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
