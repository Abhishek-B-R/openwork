import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { connectCardState, connectorForCard, signInWith, type ConnectCardData, type ConnectCardState } from "@/lib/connect-cards";
import { buildDenLibraryUrl, startConnection, type DenSession } from "@/lib/den";
import type { ConnectorCatalog, MarketplaceConnector } from "@/lib/marketplace";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { ConnectorLogo } from "@/ui/marketplace";
import { workPopoverPlacement, type WorkPopoverPlacement } from "@/ui/work-popover";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/70 focus-visible:ring-offset-2 focus-visible:ring-offset-panel-2";
const PRIMARY = `inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-snow px-4 text-[13px] font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-60 ${FOCUS}`;
const QUIET = `inline-flex h-9 shrink-0 items-center justify-center rounded-full px-3 text-[13px] text-mist transition-colors hover:bg-white/[0.06] hover:text-snow ${FOCUS}`;
/** How long a browser sign-in is watched before the card stops looking. */
const WATCH_MS = 3 * 60_000;
const WATCH_EVERY_MS = 2_000;

type Phase = { kind: "idle" } | { kind: "starting" } | { kind: "waiting"; authorizeUrl: string | null; since: number; connectedAt: string | null } | { kind: "error"; message: string };
type Asker = Pick<CoworkerSummary, "slug" | "name"> & Partial<Pick<CoworkerSummary, "avatarColor" | "avatarGlasses">>;
type CardState = ConnectCardState | { kind: "checking" };

function AppLogo({ entry, app, size }: { entry: MarketplaceConnector | undefined; app: string; size: number }) {
  if (entry) return <ConnectorLogo entry={entry} size={size} />;
  return (
    <span className="flex items-center justify-center bg-white/90 text-[15px] font-semibold text-ink" style={{ width: size, height: size, borderRadius: Math.max(5, Math.round(size * 0.22)) }} aria-hidden="true">
      {app.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function CheckBadge() {
  return (
    <span className="absolute -bottom-1 -right-1 flex size-[18px] items-center justify-center rounded-full bg-mint text-ink ring-2 ring-[var(--color-ink)]" aria-hidden="true">
      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>
    </span>
  );
}

function Spinner({ tone = "dark" }: { tone?: "dark" | "light" }) {
  return <span className={`size-3.5 shrink-0 rounded-full border-2 motion-safe:animate-spin ${tone === "dark" ? "border-ink/25 border-t-ink" : "border-white/20 border-t-spark"}`} aria-hidden="true" />;
}

function LockIcon() {
  return <svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.6" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></svg>;
}

/** "to read your inbox" → "read your inbox": the coworker's reason, ready for "so I can …". */
function reasonClause(reason: string): string {
  return reason.trim().replace(/^to\s+/i, "").replace(/[.\s]+$/, "");
}

/** What the coworker says on the card, in its own voice, for where the app stands. */
function wording(state: CardState, app: string, reason: string, continued: boolean, latest: boolean): { title: string; body: string } {
  const why = reasonClause(reason);
  const soICan = why ? `So I can ${why}.` : "I need it for this.";
  switch (state.kind) {
    case "connect": return state.reconnect
      ? { title: `I need you to reconnect ${app}`, body: `Its sign-in expired. ${soICan}` }
      : { title: `I need you to connect ${app} first`, body: soICan };
    case "checking": return { title: `I need you to connect ${app} first`, body: soICan };
    case "signin": return { title: "First, sign in to OpenWork", body: `Then connect ${app}${why ? `, so I can ${why}` : ""}.` };
    case "setup": return { title: `I can't reach ${app} yet`, body: "It isn't in your OpenWork yet. Set it up, or ask an admin to add it." };
    case "elsewhere": return { title: `I can't reach ${app} yet`, body: state.words };
    case "connected": return { title: `Thanks, ${app} is connected`, body: continued ? "I'll take it from here." : latest ? "Continue and I'll pick up where I left off." : "I can use it now." };
  }
}

/**
 * The coworker asking, in the conversation, for an app the work needs: "I need
 * you to connect Gmail first", the app with its logo, and one button. Connect
 * opens a small sheet that explains the sign-in and starts it in the browser;
 * the card watches for the connection and, when it lands, thanks the person and
 * lets the work go on. Its layout follows its own width (container queries),
 * so it reads well beside a wide chat and in a phone-sized window alike.
 */
export function ConnectCard({
  card,
  catalog,
  checking,
  refresh,
  session,
  coworker,
  latest,
  onSignIn,
  onContinue,
}: {
  card: ConnectCardData;
  catalog: ConnectorCatalog;
  /** The person's connections are still being read: hold the card's button until they are. */
  checking: boolean;
  refresh: () => Promise<void>;
  session: DenSession | null;
  /** Who is asking: the coworker the card speaks for. */
  coworker: Asker;
  /** The card belongs to the latest turn, so connecting can carry the work straight on. */
  latest: boolean;
  onSignIn: () => void;
  onContinue: (words: string) => void;
}) {
  const entry = connectorForCard(card, catalog);
  const app = entry?.name ?? card.app;
  const provider = signInWith(entry, app);
  const ids = useId();
  const titleId = `${ids}-title`;
  const bodyId = `${ids}-body`;
  const sheetTitleId = `${ids}-sheet`;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [renewed, setRenewed] = useState(false);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<WorkPopoverPlacement>("above");
  const [continued, setContinued] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const anchorRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const sheetActionRef = useRef<HTMLButtonElement | null>(null);
  const read = connectCardState(card, catalog, renewed);
  // Until the first read lands, an app looks unset-up; say it is being checked instead.
  const state: CardState = checking && catalog.signedIn && catalog.connections.length === 0 && read.kind === "setup" ? { kind: "checking" } : read;
  const connection = state.kind === "connected" || state.kind === "connect" ? catalog.connections.find((candidate) => candidate.id === state.connectionId) : undefined;
  const connected = state.kind === "connected";
  const waiting = phase.kind === "waiting";
  const { title, body } = wording(state, app, card.reason, continued, latest);

  function carryOn() {
    if (continued) return;
    setContinued(true);
    onContinue(`${app} is connected. Go ahead.`);
  }

  // While the browser sign-in is open, look for the connection every few seconds (and on focus, via the catalog).
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const timer = window.setInterval(() => {
      if (Date.now() - phase.since > WATCH_MS) { window.clearInterval(timer); return; }
      void refresh();
    }, WATCH_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [phase, refresh]);

  // A reconnect is done when the connection's time moves on; a first connection when it shows as connected.
  // It checks after every render (the catalog changes under it); only a waiting sign-in lets it act, once.
  const waitingFor = phase.kind === "waiting" ? phase : null;
  useEffect(() => {
    if (!waitingFor || !connection?.connectedForMe) return;
    if (state.kind === "connect" && state.reconnect && (connection.connectedAt ?? null) === waitingFor.connectedAt) return;
    setRenewed(true);
    setPhase({ kind: "idle" });
    setAnnouncement(`${app} is connected.`);
    window.setTimeout(() => setOpen(false), 900);
    if (latest) carryOn();
  });

  // The sheet takes the keyboard when it opens and gives it back to its button when it closes.
  useEffect(() => {
    if (!open) return;
    sheetActionRef.current?.focus({ preventScroll: true });
    const close = (restore: boolean) => { setOpen(false); if (restore) triggerRef.current?.focus({ preventScroll: true }); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(true); } };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (popoverRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      close(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("pointerdown", onPointerDown, true); };
  }, [open]);

  function openSheet() {
    if (anchorRef.current) setPlacement(workPopoverPlacement(anchorRef.current.getBoundingClientRect(), window.innerHeight));
    setOpen(true);
  }

  async function begin() {
    if (!session || state.kind !== "connect") return;
    const before = connection?.connectedAt ?? null;
    setPhase({ kind: "starting" });
    try {
      const started = await startConnection(session, state.connectionId);
      if (started.status === "needs_auth" && started.authorizeUrl) await coworkerBridge.openExternal(started.authorizeUrl);
      setPhase({ kind: "waiting", authorizeUrl: started.status === "needs_auth" ? started.authorizeUrl : null, since: Date.now(), connectedAt: before });
      setAnnouncement(started.status === "needs_auth" ? `Finish signing in to ${app} in your browser.` : `Checking ${app}.`);
      if (started.status === "connected") await refresh();
    } catch (cause) {
      const message = `${app} could not start connecting. ${cause instanceof Error ? cause.message : String(cause)}`;
      setPhase({ kind: "error", message });
      setAnnouncement(message);
    }
  }

  const verb = state.kind === "connect" && state.reconnect ? "Reconnect" : "Connect";
  const rowLine: ReactNode = connected ? <span className="text-mint">Connected</span>
    : state.kind === "checking" ? "Checking your apps…"
    : waiting ? "Waiting for you to finish signing in"
    : state.kind === "setup" ? "Not in your OpenWork yet"
    : state.kind === "elsewhere" ? (card.status?.actor === "organization_admin" ? "Waiting on an admin" : "Waiting on someone else")
    : entry?.description ?? "An OpenWork Connect app";
  const action: ReactNode = connected ? (latest && !continued
    ? <button ref={triggerRef} type="button" className={`${PRIMARY} w-full @sm:w-auto`} onClick={carryOn} data-testid="connect-card-continue">Continue</button> : null)
    : state.kind === "connect" ? (
      <button ref={triggerRef} type="button" className={`${PRIMARY} w-full @sm:w-auto`} onClick={openSheet} aria-haspopup="dialog" aria-expanded={open} aria-label={waiting ? `Finishing sign-in to ${app}` : `${verb} ${app}`} data-testid="connect-card-button">
        {waiting ? <><Spinner />Waiting…</> : verb}
      </button>
    ) : state.kind === "signin" ? (
      <button ref={triggerRef} type="button" className={`${PRIMARY} w-full @sm:w-auto`} onClick={onSignIn} aria-label="Sign in to OpenWork" data-testid="connect-card-signin">Sign in</button>
    ) : state.kind === "setup" ? (
      <button ref={triggerRef} type="button" className={`${PRIMARY} w-full @sm:w-auto`} onClick={() => { if (session) void coworkerBridge.openExternal(buildDenLibraryUrl(session.baseUrl, state.path)); }} disabled={!session} aria-label={`Set up ${app} in OpenWork`} data-testid="connect-card-setup">Set up</button>
    ) : state.kind === "checking" ? <span className="flex h-9 items-center justify-center @sm:justify-end" aria-hidden="true"><Spinner tone="light" /></span> : null;
  const footnote = state.kind === "connect" ? <><LockIcon />{waiting ? `Finish in your browser, then come back` : `Secure sign-in with ${provider}`}</>
    : state.kind === "signin" ? "Apps come with your OpenWork account"
    : state.kind === "setup" ? "Opens OpenWork in your browser" : null;

  return (
    <section
      ref={anchorRef}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="@container relative w-full max-w-[28rem]"
      data-testid="connect-card"
      data-app={app}
      data-state={state.kind}
    >
      <div className={`rounded-[20px] border p-4 shadow-[0_10px_30px_rgba(0,0,0,0.22)] transition-colors ${connected ? "border-mint/25 bg-[linear-gradient(180deg,rgba(62,213,166,0.08),rgba(62,213,166,0.02))]" : "border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] bg-panel-2"}`}>
        <div className="flex items-center gap-2 text-[11.5px] text-mist">
          <CoworkerAvatar identity={coworker.slug} name={coworker.name} color={coworker.avatarColor ?? "blue"} glasses={coworker.avatarGlasses ?? "round"} size={20} motion="quiet" />
          <span className="truncate font-medium text-snow/80">{coworker.name}</span>
        </div>
        <h3 id={titleId} className="mt-2 text-[15px] font-semibold leading-snug text-snow [text-wrap:balance]">{title}</h3>
        <p id={bodyId} className="mt-1 text-[13px] leading-snug text-mist [text-wrap:pretty]">{body}</p>
        <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-white/[0.06] bg-ink/45 p-3 @sm:flex-row @sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="relative shrink-0">
              <AppLogo entry={entry} app={app} size={40} />
              {connected ? <CheckBadge /> : null}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-snow">{app}</p>
              <p className="line-clamp-2 text-[12px] leading-snug text-mist">{rowLine}</p>
            </div>
          </div>
          {action}
        </div>
        {footnote ? <p className="mt-2.5 flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-mist/80">{footnote}</p> : null}
      </div>
      <p className="sr-only" aria-live="polite">{announcement}</p>

      {open && state.kind === "connect" ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={sheetTitleId}
          className={`thinking-popover absolute left-0 z-40 w-[min(22rem,calc(100vw-32px))] rounded-[20px] border border-line bg-panel p-4 text-left shadow-[0_18px_48px_rgba(0,0,0,0.45)] ${placement === "above" ? "bottom-full mb-2" : "top-full mt-2"}`}
          data-testid="connect-sheet"
        >
          <div className="flex items-center gap-3">
            <AppLogo entry={entry} app={app} size={44} />
            <div className="min-w-0">
              <p id={sheetTitleId} className="text-[15px] font-semibold text-snow">{verb} {app}</p>
              <p className="text-[12px] leading-snug text-mist">{entry?.description ?? `Use ${app} through OpenWork Connect.`}</p>
            </div>
          </div>
          {waiting ? (
            <div className="mt-4 rounded-2xl border border-line/70 bg-ink/40 p-3" role="status">
              <p className="flex items-center gap-2 text-[13px] font-medium text-snow"><Spinner tone="light" />Finish signing in to {app} in your browser</p>
              <p className="mt-1 text-[12px] text-mist">This updates by itself as soon as you're done.</p>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                {phase.authorizeUrl ? <button ref={sheetActionRef} type="button" className={`rounded text-spark hover:underline ${FOCUS}`} onClick={() => void coworkerBridge.openExternal(phase.authorizeUrl ?? "")}>Open sign-in again</button> : null}
                <button type="button" className={`rounded text-mist hover:text-snow ${FOCUS}`} onClick={() => setPhase({ kind: "idle" })}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-3.5 flex items-start gap-2 rounded-2xl bg-white/[0.04] p-3">
                <CoworkerAvatar identity={coworker.slug} name={coworker.name} color={coworker.avatarColor ?? "blue"} glasses={coworker.avatarGlasses ?? "round"} size={22} motion="quiet" />
                <p className="text-[13px] leading-snug text-snow/90">{reasonClause(card.reason) ? `I'll use it to ${reasonClause(card.reason)}.` : `I need ${app} for this.`}</p>
              </div>
              <ul className="mt-3 space-y-1.5 text-[12px] text-mist">
                <li className="flex gap-2"><span aria-hidden="true" className="text-mint">✓</span>You sign in with {provider} in your browser.</li>
                <li className="flex gap-2"><span aria-hidden="true" className="text-mint">✓</span>It stays in your OpenWork account. Disconnect anytime.</li>
              </ul>
              {phase.kind === "error" ? <p role="alert" className="mt-3 text-[12px] text-rose">{phase.message}</p> : null}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button ref={sheetActionRef} type="button" className={PRIMARY} onClick={() => void begin()} disabled={phase.kind === "starting"} aria-busy={phase.kind === "starting"} data-testid="connect-sheet-continue">
                  {phase.kind === "starting" ? <><Spinner />Opening sign-in…</> : phase.kind === "error" ? "Try again" : `Continue with ${provider}`}
                </button>
                <button type="button" className={QUIET} onClick={() => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }}>Not now</button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
