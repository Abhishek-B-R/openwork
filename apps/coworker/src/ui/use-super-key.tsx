import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The super key: ⌘⇧ on a Mac, Ctrl+Shift elsewhere. Holding it shows what it
 * can do, right where it happens: a number beside each coworker, a few keys in
 * the composer, the thinking pace in place of its pill. While it is held a key
 * acts at once: a number opens that coworker, ↑ ↓ step through the team, ← →
 * set the pace, F toggles Focus mode. A quick tap keeps it open for one plain
 * key instead, which also reaches the numbers macOS keeps for screenshots
 * (⌘⇧3, 4 and 5 never reach an app).
 */

export type SuperAction =
  | { kind: "coworker"; index: number }
  | { kind: "cycle"; by: 1 | -1 }
  | { kind: "pace"; by: 1 | -1 }
  | { kind: "focus" };

export type SuperKey = {
  /** The layer shows: held past a moment, or kept open by a tap. */
  active: boolean;
  /** Kept open by a tap: plain keys act until one ends it, Escape, a click or another key. */
  latched: boolean;
  /** The key that just acted, for a moment, so its hint can answer. */
  pressed: string | null;
};

const SuperKeyContext = createContext<SuperKey>({ active: false, latched: false, pressed: null });
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

/** Long enough that a quick chord (⌘⇧Z, ⌘⇧← to select text) never flashes the layer or loses its keys. */
const SHOW_AFTER_MS = 300;
/** A press and release this quick, with no other key, is a tap: the layer stays open. */
const TAP_MAX_MS = 320;
const PRESSED_MS = 280;
/** A layer kept open by a tap closes by itself after this long without a key, so an aborted shortcut never swallows typing for long. */
const LATCH_MS = 3_000;
const MODIFIER_KEYS = new Set(["Meta", "Shift", "Control", "Alt"]);

export function onMac(): boolean {
  return document.documentElement.dataset.windowPlatform === "darwin" || /Mac/i.test(navigator.platform);
}

/** The chord as this platform spells it. */
export function superKeyLabel(): string {
  return onMac() ? "⌘⇧" : "Ctrl+Shift";
}

function isChord(event: KeyboardEvent): boolean {
  return onMac()
    ? event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
}

/** Text fields select with ⌘⇧ and arrows; until the layer shows, a field that uses them keeps them. */
function keepsArrows(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target.matches('[role="slider"], [role="separator"]')) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type);
}

/** The action a key names, read from the physical key: with Shift held, "1" arrives as "!". */
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
  const [latched, setLatched] = useState(false);
  const [pressed, setPressed] = useState<string | null>(null);
  const act = useRef(onAction);
  act.current = onAction;

  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      setLatched(false);
      return;
    }
    let isHeld = false;
    let isLatched = false;
    let downAt = 0;
    let otherKey = false;
    let showTimer: number | undefined;
    let pressedTimer: number | undefined;
    let latchTimer: number | undefined;
    const hold = (value: boolean) => { isHeld = value; setHeld(value); };
    const latch = (value: boolean) => {
      isLatched = value;
      setLatched(value);
      if (latchTimer !== undefined) window.clearTimeout(latchTimer);
      latchTimer = value ? window.setTimeout(() => latch(false), LATCH_MS) : undefined;
    };
    const stopShowing = () => {
      if (showTimer !== undefined) window.clearTimeout(showTimer);
      showTimer = undefined;
    };
    const close = () => {
      stopShowing();
      downAt = 0;
      hold(false);
      latch(false);
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
        if (isHeld || isLatched) close();
        return;
      }
      if (MODIFIER_KEYS.has(event.key)) {
        if (event.repeat || !isChord(event)) return;
        if (!downAt) {
          downAt = Date.now();
          otherKey = false;
        }
        stopShowing();
        if (!isHeld) showTimer = window.setTimeout(() => { showTimer = undefined; hold(true); }, SHOW_AFTER_MS);
        return;
      }
      otherKey = true;
      if (isChord(event)) {
        const found = actionFor(event);
        // Before the layer shows, a text field keeps ⌘⇧ with arrows for selecting.
        if (found && !(event.code.startsWith("Arrow") && !isHeld && !isLatched && keepsArrows(event.target))) {
          stopShowing();
          latch(false);
          hold(true);
          fire(found, event);
          return;
        }
        // Any other chord (⌘⇧Z, ⌘⇧4) is an ordinary shortcut; the layer steps aside for it.
        close();
        return;
      }
      if (!isLatched) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      const found = !event.metaKey && !event.ctrlKey && !event.altKey ? actionFor(event) : null;
      if (found) {
        fire(found, event);
        // The pace and the team can take a few steps (each one keeps it open a moment longer); a coworker or Focus mode ends it.
        if (found.action.kind === "coworker" || found.action.kind === "focus") close();
        else latch(true);
        return;
      }
      // Anything else goes on as typed.
      close();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!MODIFIER_KEYS.has(event.key) || !downAt) return;
      const tapped = !otherKey && Date.now() - downAt < TAP_MAX_MS;
      downAt = 0;
      stopShowing();
      hold(false);
      // A tap opens the layer for one plain key; a second tap puts it away.
      if (tapped) latch(!isLatched);
    };

    const onPointerDown = () => {
      if (isLatched) close();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", close);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      close();
      if (pressedTimer !== undefined) window.clearTimeout(pressedTimer);
      if (latchTimer !== undefined) window.clearTimeout(latchTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [enabled]);

  return { active: held || latched, latched, pressed };
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
        {superKey.latched ? <span className="text-[10px] text-mist">Esc to close</span> : null}
      </div>
    </div>
  );
}
