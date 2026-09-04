import { CoworkerAvatar, type AvatarColor, type AvatarGlasses } from "./coworker-brand";

/** Roles and avatar palettes mirror the Coworker app. */
export const TEAM: Array<{ name: string; color: AvatarColor; glasses: AvatarGlasses }> = [
  { name: "Scout", color: "blue", glasses: "round" },
  { name: "Editor", color: "rose", glasses: "square" },
  { name: "Ops", color: "mint", glasses: "none" },
];

/** A deliberately focused illustration, not an interactive app or recording. */
export function CoworkerVignette() {
  return (
    <div className="cw-chat" data-testid="coworker-vignette">
      <div className="cw-chat-header">
        <div className="flex items-center gap-3">
          <CoworkerAvatar name="Scout" color="blue" glasses="round" size={34} />
          <div><p className="text-sm font-medium">Scout</p><p className="mt-0.5 text-xs text-[var(--cw-muted)]">Research</p></div>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="hidden text-xs text-[var(--cw-muted)] sm:inline">Your coworkers</span>
          <div className="flex -space-x-1.5">
            {TEAM.slice(1).map((member) => <span key={member.name} className="rounded-full bg-[var(--cw-surface)] p-1"><CoworkerAvatar {...member} size={26} /></span>)}
          </div>
        </div>
      </div>
      <div className="cw-chat-thread">
        <div className="flex justify-end">
          <p className="cw-chat-request">How’s the launch brief coming along?</p>
        </div>
        <div className="flex items-start gap-3 sm:gap-4">
          <span className="mt-1 shrink-0"><CoworkerAvatar name="Scout" color="blue" glasses="round" size={28} /></span>
          <div className="min-w-0 max-w-[480px]">
            <p className="text-xs font-medium text-[var(--cw-muted)]">Scout</p>
            <p className="mt-2 text-[15px] leading-7 sm:text-base">First draft’s ready. I pulled the key points into a short brief. Take a look when you have a moment.</p>
            <div className="cw-chat-document">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h4M9 12h5M9 16h5" /></svg>
              <div className="flex-1"><p className="text-sm font-medium text-[var(--cw-text)]">Launch brief</p><p className="mt-0.5 text-xs text-[var(--cw-muted)]">Draft · Ready to review</p></div>
              <span aria-hidden="true">↗</span>
            </div>
          </div>
        </div>
        <div className="cw-chat-composer" aria-hidden="true">
          <span className="text-xl font-light">+</span><span className="flex-1">Message Scout</span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--cw-text)] text-[var(--cw-bg)]">↑</span>
        </div>
      </div>
    </div>
  );
}
