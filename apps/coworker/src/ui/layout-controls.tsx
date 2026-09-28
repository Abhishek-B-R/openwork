import { ChevronIcon, FocusIcon, IconButton, SidebarIcon } from "@/ui/kit";
import { useLayout } from "@/ui/use-layout";

function shortcut(): string {
  return typeof document !== "undefined" && document.documentElement.dataset.windowPlatform === "darwin" ? "⌘\\" : "Ctrl+\\";
}

/**
 * While only the conversation shows, the way back to the team. In Focus mode it
 * is a messages app's back button, with the unread count beside it, and opens
 * the list of conversations; in a narrow window it slides the team in as a drawer.
 */
export function TeamButton() {
  const layout = useLayout();
  if (!layout.chatOnly) return null;
  if (layout.focus) {
    const unread = layout.teamUnread ?? 0;
    return (
      <button
        type="button"
        aria-label={unread ? `Coworkers, ${unread} unread` : "Coworkers"}
        title="Coworkers"
        className="window-no-drag flex h-8 shrink-0 items-center rounded-lg pl-0.5 pr-1.5 text-spark transition-colors hover:bg-white/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
        onClick={layout.openTeam}
        data-testid="focus-back"
      >
        <ChevronIcon direction="left" className="size-5" />
        {unread ? <span className="text-[15px] font-medium tabular-nums" data-testid="focus-back-unread">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
    );
  }
  return (
    <IconButton label="Show your team" tooltip="Your team" tooltipSide="bottom" className="window-no-drag relative" onClick={layout.openTeam} data-testid="team-drawer-button">
      <SidebarIcon side="left" />
      {layout.teamAttention ? <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-spark" data-testid="team-drawer-attention" /> : null}
    </IconButton>
  );
}

/** Focus mode on or off: the conversation alone in a small window docked at the right of the screen. In Focus mode it is the only control at the top. */
export function FocusToggle() {
  const layout = useLayout();
  const label = layout.focus ? "Leave Focus mode" : "Focus mode";
  return (
    <IconButton label={label} tooltip={`${label} · ${shortcut()}`} tooltipSide="bottom" className="window-no-drag" aria-pressed={layout.focus} onClick={layout.toggleFocus} data-testid="focus-mode-toggle">
      <FocusIcon active={layout.focus} />
    </IconButton>
  );
}
