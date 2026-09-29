import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { AvatarColor, AvatarGlasses } from "@openwork/ui/coworker";
import { CoworkerAvatar } from "@/ui/coworker-avatar";

type BubbleState = {
  coworker: { slug: string; name: string; avatarColor: string; avatarGlasses: string };
  speech: { text: string; from: string; hint?: boolean; at: number } | null;
  /** The speech is showing (a tap on the face shows or hides it). */
  open: boolean;
  side: "left" | "right";
  face: number;
};

type BubbleHost = {
  onState: (listener: (state: BubbleState) => void) => () => void;
  onCursor: (listener: (cursor: { dx: number; dy: number }) => void) => () => void;
  moveBy: (dx: number, dy: number) => void;
  open: () => void;
  toggle: () => void;
  dismiss: () => void;
};

/** Travelling this far is a drag; less is a tap. */
const TAP_SLOP = 4;
/** A second tap this soon is a double-click, which opens the conversation. */
const DOUBLE_TAP_MS = 260;
/** How far away (in points) the cursor is when the eyes reach the edge of their range. */
const GAZE_REACH = 360;
/** A speech bubble counts down and tucks itself away after this long (the hint sooner); hovering holds it. */
const SPEECH_MS = 30_000;
const HINT_MS = 6_000;
/* The easter egg: circle the cursor around the face fast enough, twice, and it gets dizzy. */
const DIZZY_RADIUS = 240;
const DIZZY_TURNS = 2;
const DIZZY_WINDOW_MS = 2_500;
const DIZZY_MS = 1_800;
const DIZZY_REST_MS = 5_000;

/**
 * The coworker as a tiny floating bubble, its own window above everything:
 * the face, whose eyes follow the cursor wherever it is. Drag it anywhere;
 * tap it to show or hide what it has to say; double-click it (or the speech,
 * or its expand button) to open the conversation.
 */
export function Bubble() {
  const host = (window as Window & { __COWORKER_BUBBLE__?: BubbleHost }).__COWORKER_BUBBLE__;
  const [state, setState] = useState<BubbleState | null>(null);
  const [regard, setRegard] = useState({ x: 0, y: 0 });
  const [dizzy, setDizzy] = useState(false);
  const faceRef = useRef<HTMLSpanElement>(null);
  const circling = useRef<{ angle: number | null; turns: Array<{ at: number; by: number }>; restUntil: number }>({ angle: null, turns: [], restUntil: 0 });
  const drag = useRef<{ x: number; y: number; travelled: number } | null>(null);
  const tap = useRef<number | null>(null);
  // Each showing gets a fresh countdown, including a message shown again with a tap.
  const [showing, setShowing] = useState(0);
  const wasOpen = useRef(false);
  useEffect(() => host?.onState((next) => {
    if (next.open && next.speech && !wasOpen.current) setShowing((count) => count + 1);
    wasOpen.current = Boolean(next.open && next.speech);
    setState(next);
  }), [host]);
  useEffect(() => host?.onCursor(({ dx, dy }) => {
    const clamp = (value: number) => Math.max(-1, Math.min(1, value / GAZE_REACH));
    setRegard({ x: clamp(dx), y: clamp(dy) });
    // How far the cursor has gone around the face lately, in turns; twice round, fast, is too much.
    const now = Date.now();
    const track = circling.current;
    if (Math.hypot(dx, dy) > DIZZY_RADIUS) { track.angle = null; track.turns = []; return; }
    const angle = Math.atan2(dy, dx);
    if (track.angle !== null) {
      let by = angle - track.angle;
      if (by > Math.PI) by -= 2 * Math.PI;
      if (by < -Math.PI) by += 2 * Math.PI;
      track.turns = [...track.turns.filter((turn) => now - turn.at < DIZZY_WINDOW_MS), { at: now, by }];
    }
    track.angle = angle;
    const around = Math.abs(track.turns.reduce((sum, turn) => sum + turn.by, 0)) / (2 * Math.PI);
    if (around >= DIZZY_TURNS && now >= track.restUntil) {
      track.turns = [];
      track.restUntil = now + DIZZY_MS + DIZZY_REST_MS;
      setDizzy(true);
      // The face's own dizzy eyes play too.
      const avatar = faceRef.current?.querySelector<HTMLElement>(".coworker-avatar");
      if (avatar) avatar.dataset.reaction = "dizzy";
      window.setTimeout(() => {
        setDizzy(false);
        if (avatar?.dataset.reaction === "dizzy") avatar.dataset.reaction = "none";
      }, DIZZY_MS);
    }
  }), [host]);
  useEffect(() => () => { if (tap.current !== null) window.clearTimeout(tap.current); }, []);
  if (!host || !state) return null;
  const { coworker, speech, open, side, face } = state;

  function down(event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.screenX, y: event.screenY, travelled: 0 };
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) return;
    const dx = event.screenX - current.x;
    const dy = event.screenY - current.y;
    if (!dx && !dy) return;
    drag.current = { x: event.screenX, y: event.screenY, travelled: current.travelled + Math.abs(dx) + Math.abs(dy) };
    host!.moveBy(dx, dy);
  }
  function up() {
    const current = drag.current;
    drag.current = null;
    if (!current || current.travelled >= TAP_SLOP) return;
    // One tap shows or hides the speech; two open the conversation.
    if (tap.current !== null) {
      window.clearTimeout(tap.current);
      tap.current = null;
      host!.open();
      return;
    }
    tap.current = window.setTimeout(() => { tap.current = null; host!.toggle(); }, DOUBLE_TAP_MS);
  }

  return (
    <div className={`flex h-screen w-screen select-none items-end ${side === "left" ? "flex-row" : "flex-row-reverse"}`} data-testid="coworker-bubble">
      {speech && open ? (
        <div className={`bubble-speech relative mb-3 flex min-w-0 flex-1 ${side === "left" ? "justify-end pl-2" : "justify-start pr-2"}`}>
          <div className="group/speech relative max-w-full overflow-hidden rounded-2xl border border-line bg-panel px-3.5 pb-3 pt-2" onDoubleClick={() => host.open()} data-testid="coworker-bubble-speech">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-mist">{speech.from || coworker.name}</span>
              {!speech.hint ? (
                <button type="button" aria-label="Open the conversation" title="Open the conversation" className="-mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-md text-mist transition-colors hover:bg-white/5 hover:text-snow" onClick={() => host.open()} data-testid="coworker-bubble-expand">
                  <svg viewBox="0 0 20 20" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.5 4H16v4.5M16 4l-5.5 5.5M8.5 16H4v-4.5M4 16l5.5-5.5" /></svg>
                </button>
              ) : null}
              <button type="button" aria-label="Close" title="Close" className="-mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-md text-mist transition-colors hover:bg-white/5 hover:text-snow" onClick={() => host.dismiss()} data-testid="coworker-bubble-close">
                <svg viewBox="0 0 20 20" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" /></svg>
              </button>
            </div>
            <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-snow">{speech.text}</p>
            {/* The time it stays: runs out, then tucks the speech away; hovering holds it. */}
            <span
              key={`${speech.at}:${showing}`}
              aria-hidden="true"
              className="bubble-countdown absolute inset-x-0 bottom-0 h-[2px] origin-left bg-spark/60 group-hover/speech:[animation-play-state:paused]"
              style={{ animationDuration: `${speech.hint ? HINT_MS : SPEECH_MS}ms` }}
              onAnimationEnd={() => host.dismiss()}
              data-testid="coworker-bubble-countdown"
            />
            <span aria-hidden="true" className={`absolute bottom-3 size-2.5 rotate-45 border-line bg-panel ${side === "left" ? "-right-[6px] border-r border-t" : "-left-[6px] border-b border-l"}`} />
          </div>
        </div>
      ) : null}
      <button
        type="button"
        aria-label={`${coworker.name}: tap for messages, double-click to open`}
        title={`${coworker.name} · tap for messages, double-click to open, drag to move`}
        className="relative flex shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing focus-visible:outline-none"
        style={{ width: face, height: face }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => { drag.current = null; }}
        data-testid="coworker-bubble-face"
      >
        <span ref={faceRef} className={`relative flex size-[50px] items-center justify-center rounded-full border border-white/12 bg-panel ${dizzy ? "bubble-dizzy" : ""}`} data-dizzy={dizzy ? "true" : "false"} data-testid="coworker-bubble-head">
          {dizzy ? (
            <span aria-hidden="true" className="bubble-dizzy-stars pointer-events-none absolute inset-0">
              {[0, 1, 2].map((star) => <span key={star} style={{ animationDelay: `${star * -0.33}s` }}>✦</span>)}
            </span>
          ) : null}
          <CoworkerAvatar identity={`${coworker.slug}:bubble`} name={coworker.name} color={coworker.avatarColor as AvatarColor} glasses={coworker.avatarGlasses as AvatarGlasses} size={38} motion="attentive" regard={regard} />
        </span>
        {speech && !open ? <span aria-hidden="true" className="absolute right-3 top-3 size-2.5 rounded-full bg-spark ring-2 ring-ink" data-testid="coworker-bubble-unread" /> : null}
      </button>
    </div>
  );
}
