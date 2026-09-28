import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The super key: ⌥⌘ on a Mac, Ctrl+Shift elsewhere. Holding it shows what it
 * can do, right where it happens: a number beside each coworker, a few keys in
 * the composer, the thinking pace in place of its pill. While it is held a key
 * acts at once: a number opens that coworker, ↑ ↓ step through the team, ← →
 * set the pace, F toggles Focus mode.
 *
 * ⌥⌘ because nothing else wants those keys with it: macOS keeps ⇧⌘3, 4 and 5
 * for screenshots, text fields select with ⇧⌘, ⌃⇧ and ⌥⇧ arrows, and window
 * managers such as Magnet take ⌃⌥. With ⌥⌘ a text field binds only Space, so
 * every number reaches the app and nothing needs to wait. macOS does keep a
 * few ⌥⌘ keys (D, H, M, W, Esc, Space, F5; I opens the developer tools), so
 * the layer never uses those.
 */

export type SuperAction =
  | { kind: "coworker"; index: number }
  | { kind: "cycle"; by: 1 | -1 }
  | { kind: "pace"; by: 1 | -1 }
  | { kind: "focus" };

export type SuperKey = {
  /** The layer shows: the super key has been held past a moment, or has just acted. */
  active: boolean;
  /** The key that just acted, for a moment, so its hint can answer. */
  pressed: string | null;
};

const SuperKeyContext = createContext<SuperKey>({ active: false, pressed: null });
export const SuperKeyProvider = SuperKeyContext.Provider;

export function useSuperKey(): SuperKey {
  return useContext(SuperKeyContext);
}

/** Components that own an action (the pace dial, the team list) take it from here. */
const SUPER_ACTION_EVENT = "coworker:super-action";

export function onSuperAction(handler: (action: SuperAction) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<SuperAction>).detail);
  window.addEventListener(SUPER_ACTION_EVENT, listener);
  return () => window.removeEventListener(SUPER_ACTION_EVENT, listener);
}

export function sendSuperAction(action: SuperAction): void {
  window.dispatchEvent(new CustomEvent<SuperAction>(SUPER_ACTION_EVENT, { detail: action }));
}

/** Long enough that a quick chord of the same keys (⌥⌘I, ⌥⌘H) never flashes the layer. Its own keys act at once, without waiting. */
const SHOW_AFTER_MS = 300;
const PRESSED_MS = 280;
const MODIFIER_KEYS = new Set(["Meta", "Shift", "Control", "Alt"]);

export function onMac(): boolean {
  return document.documentElement.dataset.windowPlatform === "darwin" || /Mac/i.test(navigator.platform);
}

/** The chord as this platform spells it. */
export function superKeyLabel(): string {
  return onMac() ? "⌥⌘" : "Ctrl+Shift";
}

/** The chord for aria-keyshortcuts, followed by a key: "Alt+Meta+F". */
export function superKeyShortcut(key: string): string {
  return `${onMac() ? "Alt+Meta" : "Control+Shift"}+${key}`;
}

function isChord(event: KeyboardEvent): boolean {
  return onMac()
    ? event.altKey && event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
}

/**
 * Off a Mac, Ctrl+Shift with arrows selects text: until the layer shows, a
 * field that uses arrows keeps them. On a Mac, ⌥⌘ arrows mean nothing to a field.
 */
function keepsArrows(target: EventTarget | null): boolean {
  if (onMac() || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target.matches('[role="slider"], [role="separator"]')) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type);
}

/** The action a key names, read from the physical key: with ⌥ held, "1" arrives as "¡" and F as "ƒ". */
function actionFor(event: KeyboardEvent): { action: SuperAction; key: string } | null {
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1];
  if (digit) return { action: { kind: "coworker", index: Number(digit) - 1 }, key: digit };
  switch (event.code) {
    case "KeyF": return { action: { kind: "focus" }, key: "F" };
    case "ArrowLeft": return { action: { kind: "pace", by: -1 }, key: "←" };
    case "ArrowRight": return { action: { kind: "pace", by: 1 }, key: "→" };
    case "ArrowUp": return { action: { kind: "cycle", by: -1 }, key: "↑" };
    case "ArrowDown": return { action: { kind: "cycle", by: 1 }, key: "↓" };
    default: return null;
  }
}

/**
 * The super key's state for the app shell, which provides it to the views.
 * Off while `enabled` is false (settings, a new coworker), and it steps aside
 * whenever a dialog is open, so dialogs keep their own keys.
 */
export function useSuperKeyState({ enabled, onAction }: { enabled: boolean; onAction: (action: SuperAction) => void }): SuperKey {
  const [held, setHeld] = useState(false);
  const [pressed, setPressed] = useState<string | null>(null);
  const act = useRef(onAction);
  act.current = onAction;

  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    let isHeld = false;
    let showTimer: number | undefined;
    let pressedTimer: number | undefined;
    const hold = (value: boolean) => { isHeld = value; setHeld(value); };
    const stopShowing = () => {
      if (showTimer !== undefined) window.clearTimeout(showTimer);
      showTimer = undefined;
    };
    const close = () => {
      stopShowing();
      hold(false);
    };
    const fire = (found: { action: SuperAction; key: string }, event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (pressedTimer !== undefined) window.clearTimeout(pressedTimer);
      setPressed(found.key);
      pressedTimer = window.setTimeout(() => setPressed(null), PRESSED_MS);
      act.current(found.action);
    };
    const dialogOpen = () => Boolean(document.querySelector('[aria-modal="true"]'));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (dialogOpen()) {
        if (isHeld) close();
        return;
      }
      if (MODIFIER_KEYS.has(event.key)) {
        if (event.repeat) return;
        // A modifier beyond the chord (⌃⌥⌘ is Magnet's) means another shortcut: step aside.
        if (!isChord(event)) {
          close();
          return;
        }
        if (!isHeld && showTimer === undefined) showTimer = window.setTimeout(() => { showTimer = undefined; hold(true); }, SHOW_AFTER_MS);
        return;
      }
      if (!isChord(event)) return;
      const found = actionFor(event);
      if (found && !(event.code.startsWith("Arrow") && !isHeld && keepsArrows(event.target))) {
        stopShowing();
        hold(true);
        fire(found, event);
        return;
      }
      // Any other chord (⌥⌘I, ⌥⌘H) is an ordinary shortcut; the layer steps aside for it.
      close();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(event.key)) close();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", close);
    return () => {
      close();
      if (pressedTimer !== undefined) window.clearTimeout(pressedTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", close);
    };
  }, [enabled]);

  return { active: held, pressed };
}

/** A key, drawn like one: it rises in when the layer shows and presses down when it acts. */
export function SuperKeyCap({ children, pressed = false, delay = 0, className = "" }: { children: ReactNode; pressed?: boolean; delay?: number; className?: string }) {
  return (
    <kbd
      className={`super-keycap inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 font-sans text-[10px] font-semibold leading-none text-snow ${className}`}
      data-pressed={pressed ? "true" : "false"}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </kbd>
  );
}

/** One quick action as the composer lists it: its keys, then what they do. */
export function SuperHint({ keys, label, pressed }: { keys: string[]; label: string; pressed: string | null }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-snow/85">
      <span className="flex items-center gap-0.5">
        {keys.map((key) => <SuperKeyCap key={key} pressed={pressed === key || (key === "1–9" && /^[1-9]$/.test(pressed ?? ""))}>{key}</SuperKeyCap>)}
      </span>
      {label}
    </span>
  );
}

/**
 * The composer's quick actions while the super key is down, floating in the
 * middle of the field over whatever is being written.
 */
export function SuperKeyStrip({ pace = true }: { pace?: boolean }) {
  const superKey = useSuperKey();
  if (!superKey.active) return null;
  return (
    <div aria-hidden="true" className="super-strip pointer-events-none absolute inset-x-3 top-2.5 z-20 flex justify-center" data-testid="super-key-strip">
      <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 rounded-2xl border border-spark/25 bg-panel/95 px-3 py-2 shadow-[0_12px_32px_rgb(0_0_0/0.45)] backdrop-blur-md">
        <SuperKeyCap className="super-keycap--chord">{superKeyLabel()}</SuperKeyCap>
        <SuperHint keys={["↑", "↓"]} label="Team" pressed={superKey.pressed} />
        <SuperHint keys={["1–9"]} label="Coworker" pressed={superKey.pressed} />
        {pace ? <SuperHint keys={["←", "→"]} label="Pace" pressed={superKey.pressed} /> : null}
        <SuperHint keys={["F"]} label="Focus" pressed={superKey.pressed} />
      </div>
    </div>
  );
}

/**
 * The super key at rest: one quiet line at the bottom center of the composer
 * saying how to call it up. It floats in the controls row, so it adds no
 * height; it fades while the layer shows, and stays out of a composer too
 * narrow to hold it beside its controls.
 */
export function SuperKeyHint() {
  const superKey = useSuperKey();
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute bottom-5 left-1/2 hidden -translate-x-1/2 items-center gap-1.5 whitespace-nowrap text-[10px] text-mist/60 transition-opacity duration-200 motion-reduce:transition-none @2xl:flex ${superKey.active ? "opacity-0" : "opacity-100"}`}
      data-testid="super-key-hint"
    >
      Hold
      <kbd className="rounded border border-line bg-white/5 px-1 font-sans text-[10px] leading-4 text-mist">{superKeyLabel()}</kbd>
      for shortcuts
    </div>
  );
}
