import { ActivityIcon, Button, Tooltip } from "@/ui/kit";

export type MainContent = "chat" | "calendar" | "activity";

export function MainContentSwitch({
  value,
  onChange,
  chatAvailable = true,
  compact = false,
  unreadActivity = 0,
  unreadMentions = 0,
  activityError = false,
}: {
  value: MainContent;
  onChange: (value: MainContent) => void;
  chatAvailable?: boolean;
  compact?: boolean;
  unreadActivity?: number;
  unreadMentions?: number;
  activityError?: boolean;
}) {
  const activityLabel = `Activity${unreadActivity ? ` · ${unreadActivity} unread` : ""}${unreadMentions ? ` · ${unreadMentions} mentions of you` : ""}${activityError ? " · Refresh unavailable" : ""}`;
  return (
    <div
      role="group"
      aria-label="Main content"
      className="window-no-drag flex h-9 w-full shrink-0 items-center gap-0.5 rounded-lg border border-line bg-panel/60 p-0.5"
      data-testid="main-content-switch"
      data-compact={compact}
    >
      <Tooltip content={compact ? "Chat" : ""} side="right">
        <Button
          type="button"
          variant="ghost"
          aria-label="Chat"
          aria-pressed={value === "chat"}
          disabled={!chatAvailable}
          className={`inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-md py-0 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${compact ? "px-0" : "px-2.5"} ${value === "chat" ? "bg-white/8 text-snow" : ""}`}
          onClick={() => onChange("chat")}
        >
          {compact ? <svg className="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 2.75h9A1.75 1.75 0 0 1 14.25 4.5v5a1.75 1.75 0 0 1-1.75 1.75H6l-3.75 2v-2.6A1.75 1.75 0 0 1 1.75 9.5v-5A1.75 1.75 0 0 1 3.5 2.75Z" /></svg> : "Chat"}
        </Button>
      </Tooltip>
      <Tooltip content={compact ? "Calendar" : ""} side="right">
        <Button
          type="button"
          variant="ghost"
          aria-label="Calendar"
          aria-pressed={value === "calendar"}
          className={`inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-md py-0 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${compact ? "px-0" : "px-2.5"} ${value === "calendar" ? "bg-white/8 text-snow" : ""}`}
          onClick={() => onChange("calendar")}
        >
          {compact ? <CalendarIcon /> : "Calendar"}
        </Button>
      </Tooltip>
      <Tooltip content={activityLabel} side="right">
        <Button
          type="button"
          variant="ghost"
          aria-label={activityLabel}
          aria-pressed={value === "activity"}
          data-testid="coworker-activity-button"
          className={`relative inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-md py-0 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${compact ? "px-0" : "px-1"} ${value === "activity" ? "bg-white/8 text-snow" : ""}`}
          onClick={() => onChange("activity")}
        >
          {compact ? <ActivityIcon className="size-4" /> : "Activity"}
          {unreadActivity > 0 ? <span aria-hidden="true" className={`absolute -right-1 -top-2 flex min-w-4 items-center justify-center rounded-md px-1 text-[10px] font-semibold leading-4 tabular-nums ${unreadMentions ? "bg-spark/20 text-spark" : "bg-white/10 text-snow"}`}>{unreadActivity > 99 ? "99+" : unreadActivity}</span> : activityError ? <span aria-hidden="true" className="absolute right-0 -top-2 text-[10px] text-amber">!</span> : null}
        </Button>
      </Tooltip>
    </div>
  );
}

export function CalendarIcon() {
  return (
    <svg
      className="size-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.25" y="3.5" width="11.5" height="10" rx="2" />
      <path d="M5 2v3M11 2v3M2.5 7h11M5 9.5h1M9 9.5h1" />
    </svg>
  );
}
