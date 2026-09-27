"use client";

import { Clock3, FileText, Folder, LayoutGrid, Monitor, Cloud, Plus, SquarePen, ArrowUp } from "lucide-react";
import { useState, type ReactNode } from "react";

import { OpenWorkMark } from "./openwork-mark";
import { GoogleDriveMark, LinearMark, SkillMark, SlackMark } from "./lp-service-marks";

export type DesktopView = "chat" | "library" | "automations";

type Props = {
  /** Show macOS window controls (desktop) or not (inside a browser). */
  windowControls?: boolean;
  /** Where the session runs, shown at the top right of the chat. */
  locationLabel?: string;
  locationIcon?: "folder" | "cloud";
};

const VIEWS: DesktopView[] = ["chat", "library", "automations"];

const VIEW_LABEL: Record<DesktopView, string> = {
  chat: "Chat",
  library: "Library",
  automations: "Automations"
};

export function LpDemoDesktop({ windowControls = true, locationLabel = "~/Marketing", locationIcon = "folder" }: Props) {
  const [view, setView] = useState<DesktopView>("chat");

  return (
    <div className="flex h-full min-h-0 w-full">
      <aside
        aria-label="OpenWork sidebar"
        className="hidden w-[236px] shrink-0 flex-col bg-[#ECEDEF] px-2 py-3 md:flex"
      >
        {windowControls ? (
          <div className="flex h-6 items-center gap-[7px] px-2" aria-hidden="true">
            <span className="h-[11px] w-[11px] rounded-full bg-[#FF5F57]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#FEBC2E]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#28C840]" />
          </div>
        ) : null}
        <div className={`${windowControls ? "mt-3.5" : "mt-1"} flex h-8 items-center gap-2 px-2.5`}>
          <OpenWorkMark className="h-4 w-5" />
          <span className="text-[15px] font-medium text-[var(--lp-ink)]">OpenWork</span>
        </div>
        <nav className="mt-2 flex flex-col gap-0.5" aria-label="App views">
          <SidebarNav icon={<SquarePen size={16} strokeWidth={1.5} />} label="New session" hint="⌘N" selected={false} onSelect={() => setView("chat")} />
          <SidebarNav icon={<Clock3 size={16} strokeWidth={1.5} />} label="Automations" selected={view === "automations"} onSelect={() => setView("automations")} />
          <SidebarNav icon={<LayoutGrid size={16} strokeWidth={1.5} />} label="Library" selected={view === "library"} onSelect={() => setView("library")} />
        </nav>
        <div className="mx-2.5 mb-1.5 mt-[18px] text-[11px] text-[#6B7280]">Pinned</div>
        <SessionRow title="Q3 board prep" meta="2d" selected={false} onSelect={() => setView("chat")} />
        <div className="mx-2.5 mb-1.5 mt-4 text-[11px] text-[#6B7280]">Workspaces</div>
        <WorkspaceRow name="Marketing" />
        <SessionRow title="Weekly update" meta="now" selected={view === "chat"} onSelect={() => setView("chat")} />
        <SessionRow title="Clean up invoices.xlsx" unread selected={false} onSelect={() => setView("chat")} />
        <SessionRow title="Draft launch post" meta="Mon" selected={false} onSelect={() => setView("chat")} />
        <WorkspaceRow name="Personal" />
        <div className="flex-1" />
        <div className="flex h-11 items-center gap-2.5 border-t border-[rgba(1,22,39,0.08)] px-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--lp-ink)] text-[10px] font-semibold text-white">SK</span>
          <span className="flex flex-col leading-tight">
            <span className="text-xs font-medium text-[#1F2937]">Sam K.</span>
            <span className="text-[11px] text-[#6B7280]">OpenWork Cloud</span>
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="flex gap-1 border-b border-[#F0F1F3] p-2 md:hidden" role="group" aria-label="App views">
          {VIEWS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={`h-8 flex-1 rounded-lg text-xs ${view === key ? "bg-[var(--lp-tonal)] font-medium text-[var(--lp-ink)]" : "text-[var(--lp-muted)]"}`}
            >
              {VIEW_LABEL[key]}
            </button>
          ))}
        </div>
        {view === "chat" ? <ChatView locationLabel={locationLabel} locationIcon={locationIcon} /> : null}
        {view === "library" ? <LibraryView /> : null}
        {view === "automations" ? <AutomationsView /> : null}
      </div>
    </div>
  );
}

function SidebarNav({ icon, label, hint, selected, onSelect }: { icon: ReactNode; label: string; hint?: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--lp-ink)] ${selected ? "bg-[#DCDEE2] font-medium text-[var(--lp-ink)]" : "text-[#374151] hover:bg-[#E3E5E8]"}`}
    >
      <span className="text-current" aria-hidden="true">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint ? <span className="text-[11px] text-[#8A93A0]">{hint}</span> : null}
    </button>
  );
}

function WorkspaceRow({ name }: { name: string }) {
  return (
    <div className="flex h-[30px] items-center gap-2.5 px-2.5">
      <Folder size={16} strokeWidth={1.5} className="text-[#4B5563]" aria-hidden="true" />
      <span className="text-[13px] font-medium text-[#1F2937]">{name}</span>
    </div>
  );
}

function SessionRow({ title, meta, unread, selected, onSelect }: { title: string; meta?: string; unread?: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={`flex h-[30px] items-center rounded-lg pl-[34px] pr-2.5 text-left text-[13px] text-[#1F2937] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--lp-ink)] ${selected ? "bg-[#DCDEE2] font-medium" : "hover:bg-[#E3E5E8]"}`}
    >
      <span className="flex-1 truncate">{title}</span>
      {unread ? <span className="h-1.5 w-1.5 rounded-full bg-[#3B82F6]" aria-label="Unread" /> : <span className="text-[11px] text-[#8A93A0]">{meta}</span>}
    </button>
  );
}

function Step({ mark, text, duration }: { mark: ReactNode; text: string; duration?: string }) {
  return (
    <div className="flex min-h-7 items-center gap-2.5">
      <span className="flex w-4 shrink-0" aria-hidden="true">{mark}</span>
      <span className="flex-1 text-[13px] text-[#374151]">{text}</span>
      <span className="w-10 shrink-0 text-right text-xs text-[#8A93A0]">{duration}</span>
    </div>
  );
}

function ChatView({ locationLabel, locationIcon }: { locationLabel: string; locationIcon: "folder" | "cloud" }) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#F0F1F3] px-5">
        <span className="text-[13px] font-medium text-[#111827]">Weekly update</span>
        <span className="flex items-center gap-1.5 text-xs text-[#6B7280]">
          {locationIcon === "cloud" ? <Cloud size={14} strokeWidth={1.5} aria-hidden="true" /> : <Folder size={14} strokeWidth={1.5} aria-hidden="true" />}
          {locationLabel}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-hidden px-4 pt-7">
        <div className="flex w-full max-w-[640px] flex-col gap-[18px]">
          <p className="max-w-[460px] self-end rounded-2xl bg-[#F1F2F4] px-3.5 py-2.5 text-sm leading-[21px] text-[#111827]">
            Pull last week&apos;s closed Linear issues and the Q3 numbers from Drive, then draft the weekly update for #launch.
          </p>
          <div className="flex flex-col border-l border-[var(--lp-border)] pl-3">
            <Step mark={<LinearMark className="h-4 w-4" />} text="Searched issues · Linear — “closed last week” · 23 issues" duration="1.2s" />
            <Step mark={<GoogleDriveMark className="h-4 w-4" />} text="Read Q3 revenue.xlsx · Google Drive" duration="0.8s" />
            <Step mark={<SkillMark className="h-4 w-4" />} text="Used your Weekly update skill" />
            <Step mark={<FileText size={16} strokeWidth={1.5} className="text-[#4B5563]" />} text="Wrote weekly-update.md" duration="0.3s" />
          </div>
          <p className="text-sm leading-[22px] text-[#111827]">
            Here&apos;s the draft. 23 issues closed, led by the new billing page. Q3 revenue is up 18% on Q2, mostly from the two new team plans.
          </p>
          <div className="flex items-center gap-3 rounded-xl px-3.5 py-3 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--lp-tonal)]">
              <FileText size={16} strokeWidth={1.5} className="text-[#4B5563]" aria-hidden="true" />
            </span>
            <span className="flex flex-1 flex-col">
              <span className="text-[13px] font-medium text-[#111827]">weekly-update.md</span>
              <span className="text-xs text-[#6B7280]">Draft · 214 words</span>
            </span>
            <span className="text-xs text-[#374151]">Open</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 justify-center px-4 pb-5 pt-3">
        <div className="w-full max-w-[664px] rounded-2xl bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.1),0_8px_24px_-12px_rgba(1,22,39,0.18)]">
          <div className="flex flex-wrap items-center gap-3 border-b border-[#F0F1F3] px-4 py-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F7F8FA]">
              <SlackMark className="h-[18px] w-[18px]" />
            </span>
            <span className="flex min-w-[180px] flex-1 flex-col">
              <span className="text-[13px] font-medium text-[#111827]">Post weekly-update.md to #launch?</span>
              <span className="text-xs text-[#6B7280]">48 people will see it. You can delete it from Slack.</span>
            </span>
            <span className="flex h-[30px] items-center rounded-lg px-3 text-xs text-[#374151] shadow-[0_0_0_1px_#E5E7EB]">Deny</span>
            <span className="flex h-[30px] items-center gap-2 rounded-lg bg-[var(--lp-ink)] px-3 text-xs text-white">
              Post to #launch <span className="text-[11px] opacity-60">⏎</span>
            </span>
          </div>
          <div className="flex flex-col gap-3.5 px-4 pb-3 pt-3.5">
            <span className="text-sm text-[#9AA2AE]">Describe your task...</span>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full text-[#4B5563] shadow-[0_0_0_1px_#E5E7EB]" aria-hidden="true">
                <Plus size={14} />
              </span>
              <span className="flex h-7 items-center rounded-full bg-[#F3F4F6] px-2.5 text-xs text-[#374151]">Claude Sonnet 5 · High</span>
              <span className="hidden h-7 items-center rounded-full bg-[#F3F4F6] px-2.5 text-xs text-[#374151] sm:flex">Ask before actions</span>
              <span className="flex-1" />
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[var(--lp-ink)] text-white" aria-hidden="true">
                <ArrowUp size={14} strokeWidth={2} />
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

type LibraryItem = { mark: ReactNode; name: string; kind: string; caption: string; action?: string };

const FROM_OPENWORK: LibraryItem[] = [
  { mark: <SkillMark className="h-5 w-5" />, name: "Weekly update", kind: "Skill", caption: "From Acme Studio" },
  { mark: <LinearMark className="h-5 w-5" />, name: "Linear", kind: "Connector", caption: "From Acme Studio" },
  { mark: <GoogleDriveMark className="h-5 w-5" />, name: "Google Drive", kind: "Connector", caption: "From Acme Studio" },
  { mark: <SlackMark className="h-5 w-5" />, name: "Slack", kind: "Connector", caption: "From Acme Studio", action: "Sign in" }
];

const ADDED_BY_YOU: LibraryItem[] = [
  { mark: <SkillMark className="h-5 w-5" />, name: "Brand voice", kind: "Skill", caption: "Just me" },
  { mark: <SkillMark className="h-5 w-5" />, name: "Invoice cleanup", kind: "Skill", caption: "Just me" }
];

function LibraryView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-hidden px-5 py-5 md:px-7">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Library</h3>
        <span className="flex h-8 items-center rounded-lg bg-[var(--lp-ink)] px-3.5 text-xs text-white">Add to library</span>
      </div>
      <div className="flex items-center gap-1.5">
        {["All", "Connectors", "Skills", "Plugins"].map((pill, index) => (
          <span key={pill} className={`flex h-7 items-center rounded-full px-3 text-xs ${index === 0 ? "bg-[var(--lp-ink)] text-white" : "bg-[#F3F4F6] text-[#374151]"}`}>{pill}</span>
        ))}
        <span className="flex-1" />
        <span className="hidden h-[30px] w-[200px] items-center rounded-lg px-2.5 text-xs text-[#9AA2AE] shadow-[0_0_0_1px_#E5E7EB] sm:flex">Filter by name</span>
      </div>
      <LibraryGroup title="From OpenWork" meta="4 shared with you" items={FROM_OPENWORK} />
      <LibraryGroup title="Added by you" meta="2 · only you so far" items={ADDED_BY_YOU} />
    </div>
  );
}

function LibraryGroup({ title, meta, items }: { title: string; meta: string; items: LibraryItem[] }) {
  return (
    <div className="flex flex-col">
      <div className="flex justify-between border-b border-[var(--lp-border)] pb-1.5 text-xs">
        <span className="font-medium text-[#374151]">{title}</span>
        <span className="text-[#6B7280]">{meta}</span>
      </div>
      {items.map((item) => (
        <div key={item.name} className="flex h-[52px] items-center gap-3 border-b border-[#F0F1F3]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F7F8FA]">{item.mark}</span>
          <span className="flex w-[150px] shrink-0 items-center gap-1.5 text-[13px] font-medium text-[#111827] md:w-[190px]">
            {item.name}
            {item.action ? null : <span className="h-1.5 w-1.5 rounded-full bg-[var(--lp-status-dot)]" aria-label="Ready" />}
          </span>
          <span className="hidden w-[84px] shrink-0 text-xs text-[#6B7280] sm:block">{item.kind}</span>
          <span className="flex-1 truncate text-xs text-[#6B7280]">{item.caption}</span>
          <span className="flex w-[84px] shrink-0 justify-end">
            {item.action ? <span className="flex h-7 items-center rounded-lg px-3 text-xs text-[#374151] shadow-[0_0_0_1px_#E5E7EB]">{item.action}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

type AutomationItem = {
  name: string;
  instructions: string;
  state: "Active" | "Needs attention" | "Inactive";
  where: "Desktop computer" | "Cloud computer";
  schedule: string;
  run: string;
};

const AUTOMATIONS: AutomationItem[] = [
  { name: "Weekly update to #launch", instructions: "Pull closed Linear issues and Q3 numbers, draft the update, ask before posting.", state: "Active", where: "Desktop computer", schedule: "Weekly · Mon · 09:00", run: "Last run: Completed" },
  { name: "Morning inbox triage", instructions: "Sort new email into Reply, Read later and Done. Draft replies for the first group.", state: "Active", where: "Cloud computer", schedule: "Daily · 08:30", run: "Next: Tomorrow 08:30" },
  { name: "Invoice cleanup", instructions: "Rename new invoices in ~/Invoices and add them to invoices.xlsx.", state: "Needs attention", where: "Desktop computer", schedule: "Daily · 18:00", run: "Last run: Run missed" },
  { name: "Competitor pricing check", instructions: "Visit three pricing pages and note any change in a table.", state: "Inactive", where: "Cloud computer", schedule: "Weekly · Fri · 10:00", run: "Last run: Completed" }
];

const STATE_CLASS: Record<AutomationItem["state"], string> = {
  Active: "bg-[#ECFDF5] text-[#047857]",
  "Needs attention": "bg-[#FFFBEB] text-[#B45309]",
  Inactive: "bg-[#F3F4F6] text-[#4B5563]"
};

function AutomationsView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-hidden px-5 py-5 md:px-7">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Automations</h3>
        <span className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--lp-ink)] px-3.5 text-xs text-white">
          <Plus size={13} aria-hidden="true" /> New Automation
        </span>
      </div>
      <span className="flex h-[30px] w-full max-w-[260px] items-center rounded-lg px-2.5 text-xs text-[#9AA2AE] shadow-[0_0_0_1px_#E5E7EB]">Search Automations</span>
      <div className="grid gap-3.5 sm:grid-cols-2">
        {AUTOMATIONS.map((item) => (
          <div key={item.name} className="flex flex-col gap-2.5 rounded-[14px] p-4 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-[#111827]">{item.name}</span>
              <span className={`flex h-[22px] shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${STATE_CLASS[item.state]}`}>{item.state}</span>
            </div>
            <span className="text-xs leading-[18px] text-[#4B5563]">{item.instructions}</span>
            <span className="flex items-center gap-1.5 text-xs text-[#6B7280]">
              {item.where === "Desktop computer" ? <Monitor size={14} strokeWidth={1.5} aria-hidden="true" /> : <Cloud size={14} strokeWidth={1.5} aria-hidden="true" />}
              {item.where}
            </span>
            <div className="flex justify-between border-t border-[#F0F1F3] pt-2.5 text-[11px] text-[#6B7280]">
              <span>{item.schedule}</span>
              <span>{item.run}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
