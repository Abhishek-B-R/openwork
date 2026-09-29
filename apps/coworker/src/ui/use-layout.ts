import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { coworkerBridge } from "@/lib/bridge";

/** Below this window width only the conversation shows; the team and the side panel open over it. */
export const COMPACT_WIDTH = 760;
const FOCUS_KEY = "open-coworker.focus-mode";

export type Layout = {
  /** The window is too narrow for side columns (a phone, or a small window). */
  compact: boolean;
  /** Focus mode: the person asked for the conversation alone. */
  focus: boolean;
  /** Only the conversation takes the window: in Focus mode, or whenever the window is compact. */
  chatOnly: boolean;
  /** The window's width, for panels that open over the conversation. */
  width: number;
  toggleFocus: () => void;
  /** The team list, sliding over the conversation while only the conversation shows (in Focus mode, the list of conversations). */
  teamOpen: boolean;
  openTeam: () => void;
  closeTeam: () => void;
  /** Something in the team list wants the person (an unread notification), shown on the team button. */
  teamAttention?: boolean;
  /** How many of those are unread, beside Focus mode's back button. */
  teamUnread?: number;
  /** In Focus mode with a coworker open: shrink to a floating bubble of its face. */
  bubble?: () => void;
};

const FULL_LAYOUT: Layout = { compact: false, focus: false, chatOnly: false, width: 1280, toggleFocus: () => {}, teamOpen: false, openTeam: () => {}, closeTeam: () => {} };

export const LayoutContext = createContext<Layout>(FULL_LAYOUT);

/** How the window is laid out right now; views read it to show the team button, the panel as an overlay, and so on. */
export function useLayout(): Layout {
  return useContext(LayoutContext);
}

function readFocus(): boolean {
  try { return window.localStorage.getItem(FOCUS_KEY) === "1"; } catch { return false; }
}

/** On a desktop, Focus mode also docks the window as a small conversation at the right of the screen. While the macOS window buttons are hidden, headers stop keeping room for them. */
function dockWindow(on: boolean): Promise<void> {
  return coworkerBridge.appWindow.focusMode(on)
    .then(() => undefined)
    .catch(() => { /* Without the native window the layout alone changes. */ });
}

/** The window has its size once resizing has been quiet this long after the native change reports back. */
const SETTLE_QUIET_MS = 140;
/** Longest the full layout waits for the window to finish growing back, if the window never reports it. */
const SETTLE_MAX_MS = 900;

/**
 * The window's layout, owned by the app shell. Focus mode is remembered across
 * launches and docks the window small at the right of the screen; compact
 * follows the window width. ⌘\ (Ctrl+\ elsewhere) toggles Focus mode; Escape
 * closes the team when it is open over the conversation.
 */
export function useLayoutState(): Layout {
  const [width, setWidth] = useState(() => window.innerWidth);
  const [focus, setFocus] = useState(readFocus);
  const [teamOpen, setTeamOpen] = useState(false);
  // Leaving Focus mode, the window grows back over a moment. The conversation alone keeps the window until it
  // has its size, then the team and the side panel come back once, instead of flickering at every width in between.
  const [settling, setSettling] = useState(false);
  const compact = width < COMPACT_WIDTH;
  const chatOnly = focus || compact || settling;

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Changing layout closes the team: it goes back to its column, or Focus mode starts on the conversation.
  useEffect(() => { setTeamOpen(false); }, [chatOnly, focus]);

  // A remembered Focus mode reopens docked.
  useEffect(() => { if (readFocus()) dockWindow(true); }, []);

  const toggleFocus = useCallback(() => {
    const next = !focus;
    setFocus(next);
    if (!next) setSettling(true);
    try { window.localStorage.setItem(FOCUS_KEY, next ? "1" : "0"); } catch { /* Focus mode still toggles for this session. */ }
    const docked = dockWindow(next);
    if (!next) {
      let reported = false;
      let quiet: number | undefined;
      const settled = () => {
        window.removeEventListener("resize", onResize);
        window.clearTimeout(fallback);
        window.clearTimeout(quiet);
        setSettling(false);
      };
      const onResize = () => {
        window.clearTimeout(quiet);
        quiet = window.setTimeout(() => { if (reported) settled(); }, SETTLE_QUIET_MS);
      };
      window.addEventListener("resize", onResize);
      const fallback = window.setTimeout(settled, SETTLE_MAX_MS);
      void docked.then(() => { reported = true; onResize(); });
    }
  }, [focus]);
  const openTeam = useCallback(() => setTeamOpen(true), []);
  const closeTeam = useCallback(() => setTeamOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "\\" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        toggleFocus();
        return;
      }
      if (event.key === "Escape" && teamOpen && !event.defaultPrevented) {
        event.preventDefault();
        setTeamOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [teamOpen, toggleFocus]);

  return useMemo(() => ({ compact, focus, chatOnly, width, toggleFocus, teamOpen: chatOnly && teamOpen, openTeam, closeTeam }), [chatOnly, closeTeam, compact, focus, openTeam, teamOpen, toggleFocus, width]);
}
