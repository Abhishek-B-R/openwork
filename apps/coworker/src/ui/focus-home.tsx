import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CoworkerActivityItem, CoworkerGroupSummary, CoworkerSummary } from "@/lib/bridge";
import { describeRailLine } from "@/lib/rail-status";
import type { CoworkerActivity } from "@/lib/threads";
import { CoworkerAvatar, GroupAvatars } from "@/ui/coworker-avatar";
import { ChevronIcon, ComposeIcon, IconButton, SearchIcon } from "@/ui/kit";
import { FocusToggle } from "@/ui/layout-controls";
import { useFeatures } from "@/ui/use-features";

type Conversation = {
  key: string;
  name: string;
  preview: string;
  at: number;
  unread: number;
  working: boolean;
  selected: boolean;
  search: string;
  face: ReactNode;
  open: () => void;
};

/** A messages app's clock: the time today, "Yesterday", the weekday this week, otherwise the date. */
function conversationTime(at: number): string {
  if (!at) return "";
  const date = new Date(at);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], { day: "numeric", month: "numeric", year: "2-digit" });
}

/**
 * Focus mode's home, like a messages app on a phone: every conversation with a
 * coworker or a group, newest first, each with its latest line, and a search
 * over all of them. The conversation's back button opens it; choosing a row
 * opens that conversation.
 */
export function FocusHome({
  open,
  coworkers,
  groups,
  eventGroupIds,
  activityBySlug,
  groupLines,
  groupActiveSlugs,
  items,
  selectedSlug,
  selectedGroupId,
  onSelect,
  onSelectGroup,
  onNewCoworker,
}: {
  open: boolean;
  coworkers: CoworkerSummary[];
  groups: CoworkerGroupSummary[];
  eventGroupIds: ReadonlySet<string>;
  activityBySlug: Record<string, CoworkerActivity>;
  groupLines: Record<string, string>;
  groupActiveSlugs: Record<string, string[]>;
  items: CoworkerActivityItem[];
  selectedSlug: string;
  selectedGroupId: string;
  onSelect: (slug: string) => void;
  onSelectGroup: (id: string) => void;
  onNewCoworker: () => void;
}) {
  const { calendar, notifications } = useFeatures();
  const [query, setQuery] = useState("");
  const sectionRef = useRef<HTMLElement>(null);

  // Arriving moves the keyboard here, off the conversation underneath; leaving forgets the search.
  useEffect(() => {
    if (open) sectionRef.current?.focus({ preventScroll: true });
    else setQuery("");
  }, [open]);

  const latest = new Map<string, { at: number; preview: string }>();
  const unread = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "event-reminder") continue;
    const key = item.target.kind === "private" ? `coworker:${item.slug}` : `group:${item.target.groupId}`;
    if (item.at > (latest.get(key)?.at ?? 0) && item.preview.trim()) latest.set(key, { at: item.at, preview: item.preview.trim() });
    if (item.readAt === null) unread.set(key, (unread.get(key) ?? 0) + 1);
  }
  const bySlug = new Map(coworkers.map((coworker) => [coworker.slug, coworker]));
  const list: Conversation[] = coworkers.map((coworker) => {
    const key = `coworker:${coworker.slug}`;
    const activity = activityBySlug[coworker.slug];
    const working = activity?.state === "working";
    const last = latest.get(key);
    const preview = working
      ? activity?.summary || activity?.label || "Working"
      : last?.preview || describeRailLine({ activity, personality: coworker.personality, seed: coworker.slug });
    return {
      key,
      name: coworker.name,
      preview,
      at: Math.max(last?.at ?? 0, activity?.last?.updatedAt ?? 0, working ? activity?.updatedAt ?? 0 : 0),
      unread: unread.get(key) ?? 0,
      working,
      selected: coworker.slug === selectedSlug && !selectedGroupId,
      search: `${coworker.name} ${coworker.role} ${preview}`.toLowerCase(),
      face: <CoworkerAvatar identity={coworker.slug} motion="navigation" color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={46} working={working} />,
      open: () => onSelect(coworker.slug),
    };
  });
  for (const group of groups) {
    // Without Calendar there are no events, so their group chats stay out of sight as they do in the team list.
    if (!calendar && (group.eventId || eventGroupIds.has(group.id))) continue;
    const key = `group:${group.id}`;
    const members = group.participantSlugs.map((slug) => bySlug.get(slug)).filter((member): member is CoworkerSummary => Boolean(member));
    const last = latest.get(key);
    const preview = last?.preview || groupLines[group.id] || members.map((member) => member.name).join(", ");
    list.push({
      key,
      name: group.name,
      preview,
      at: Math.max(last?.at ?? 0, group.updatedAt),
      unread: unread.get(key) ?? 0,
      working: (groupActiveSlugs[group.id]?.length ?? 0) > 0,
      selected: group.id === selectedGroupId,
      search: `${group.name} ${members.map((member) => member.name).join(" ")} ${preview}`.toLowerCase(),
      face: <GroupAvatars members={members} size={24} motion="navigation" activeSlugs={groupActiveSlugs[group.id]} />,
      open: () => onSelectGroup(group.id),
    });
  }
  // Newest first; conversations with nothing yet keep their team order at the end.
  const conversations = list.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.at - a.entry.at || a.index - b.index).map(({ entry }) => entry);

  const needle = query.trim().toLowerCase();
  const shown = needle ? conversations.filter((conversation) => conversation.search.includes(needle)) : conversations;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label="Your coworkers"
      inert={!open}
      data-testid="focus-home"
      data-open={open ? "true" : "false"}
      className={`fixed inset-0 z-50 flex flex-col bg-ink outline-none transition-transform duration-300 ease-out motion-reduce:transition-none ${open ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="window-drag flex h-12 shrink-0 items-center justify-end gap-1 px-3 pt-2">
        <IconButton label="New coworker" tooltip="New coworker" tooltipSide="bottom" className="window-no-drag" onClick={onNewCoworker} data-testid="focus-home-compose">
          <ComposeIcon />
        </IconButton>
        <FocusToggle />
      </div>
      <h1 className="window-drag px-4 pb-2 text-[28px] font-bold leading-tight tracking-tight text-snow">Coworkers</h1>
      <div className="px-4 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-xl bg-white/[0.07] px-2.5 text-mist focus-within:bg-white/10">
          <SearchIcon className="size-4 shrink-0" />
          <input
            type="search"
            aria-label="Search coworkers and chats"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }}
            className="min-w-0 flex-1 bg-transparent text-sm text-snow outline-none placeholder:text-mist/80 [&::-webkit-search-cancel-button]:hidden"
            data-testid="focus-home-search"
          />
        </label>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]" aria-label="Conversations">
        {shown.map((conversation) => (
          <li key={conversation.key} className="group/item">
            <button
              type="button"
              onClick={conversation.open}
              aria-current={conversation.selected ? "true" : undefined}
              aria-label={`${conversation.name}${notifications && conversation.unread ? `, ${conversation.unread} unread` : ""}`}
              aria-description={conversation.preview}
              data-testid="focus-home-row"
              data-key={conversation.key}
              className={`flex w-full items-center gap-2.5 pl-1.5 pr-3 text-left transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.07] focus-visible:outline-none ${conversation.selected ? "bg-white/[0.06]" : ""}`}
            >
              <span className="flex w-2.5 shrink-0 justify-center">
                {notifications && conversation.unread ? <span className="size-2.5 rounded-full bg-spark" aria-hidden="true" data-testid="focus-home-unread" /> : null}
              </span>
              <span className="flex size-12 shrink-0 items-center justify-center">{conversation.face}</span>
              <span className="flex min-w-0 flex-1 flex-col border-b border-line/70 py-3 group-last/item:border-b-0">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-snow">{conversation.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-mist">{conversationTime(conversation.at)}</span>
                  <ChevronIcon direction="right" className="size-3 shrink-0 text-mist/60" />
                </span>
                <span className={`mt-0.5 line-clamp-2 text-[13px] leading-snug ${conversation.working ? "text-spark" : "text-mist"}`}>{conversation.preview}</span>
              </span>
            </button>
          </li>
        ))}
        {conversations.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-mist">No coworkers yet. Start one with the compose button.</li>
        ) : shown.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-mist">No results for “{query.trim()}”</li>
        ) : null}
      </ul>
    </section>
  );
}
