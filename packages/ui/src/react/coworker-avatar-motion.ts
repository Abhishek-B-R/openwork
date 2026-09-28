"use client";

import { useEffect, useRef } from "react";
import type { AvatarTemperament } from "./coworker-avatar-artwork";

export type AvatarMotion = "quiet" | "navigation" | "attentive" | "playful" | "presentation";
/**
 * Intentional moments from the person: `engage` (a message sent, a mention),
 * `greet` (this coworker was just chosen), `wake` (joined or back in view),
 * and while setting one up, `restyle` (new color), `glasses` (new glasses) and
 * `personality` (plays the chosen temperament's signature move).
 */
export type AvatarReaction = "engage" | "wake" | "greet" | "restyle" | "glasses" | "personality";
/** A short face for something the coworker just did: happy when a reply lands, sorry when a turn fails. */
export type AvatarCue = "happy" | "sorry";
/** Body cues share one attribute: intentional reactions, pointer play, and the idle habits a face picks itself. */
type BodyCue = Exclude<AvatarReaction, "personality">
  | "shake" | "perk" | "delight" | "boop" | "dizzy"
  | "wink" | "smile" | "nod" | "adjust" | "squint" | "unimpressed" | "ponder";
type IdleGesture = "glance" | "blink" | "double-blink" | "tilt" | BodyCue;

const WAKE_COOLDOWN = 60_000;
const CUE_RETENTION = 1_500;
const REACTION_COOLDOWN: Record<AvatarReaction, number> = { engage: 2_000, greet: 2_000, wake: WAKE_COOLDOWN, restyle: 180, glasses: 180, personality: 180 };
const CUE_DURATION: Record<BodyCue, number> = {
  engage: 640, wake: 1_000, greet: 1_050, restyle: 1_150, glasses: 900,
  shake: 720, perk: 820, delight: 760, boop: 460, dizzy: 1_500,
  wink: 760, smile: 1_700, nod: 900, adjust: 760, squint: 1_300, unimpressed: 1_600, ponder: 1_800,
};
/* Weighted like a real idle: mostly glances and blinks, an occasional curious tilt, and a rare shiver or perk-up. */
const IDLE_GESTURES: readonly IdleGesture[] = [
  "glance", "glance", "glance", "glance", "glance", "glance", "glance",
  "blink", "blink", "blink",
  "double-blink", "double-blink",
  "tilt", "tilt",
  "shake", "perk",
];
/* Each temperament adds its own habits to the idle mix, sets the pace (a calm face moves less often), and
 * has one signature move it shows when that personality is picked. */
const TEMPERAMENTS: Record<AvatarTemperament, { habits: readonly IdleGesture[]; pace: number; signature: IdleGesture }> = {
  none: { habits: [], pace: 1, signature: "perk" },
  neutral: { habits: [], pace: 1, signature: "perk" },
  warm: { habits: ["smile", "smile"], pace: 1, signature: "smile" },
  calm: { habits: ["nod"], pace: 1.35, signature: "nod" },
  eager: { habits: ["perk", "perk", "glance"], pace: 0.75, signature: "perk" },
  playful: { habits: ["wink", "wink", "perk"], pace: 0.9, signature: "wink" },
  dry: { habits: ["unimpressed", "unimpressed"], pace: 1.2, signature: "unimpressed" },
  blunt: { habits: ["nod", "nod"], pace: 1.1, signature: "nod" },
  curious: { habits: ["tilt", "tilt", "glance"], pace: 0.9, signature: "tilt" },
  thoughtful: { habits: ["ponder", "ponder"], pace: 1.2, signature: "ponder" },
  meticulous: { habits: ["adjust", "adjust"], pace: 1.1, signature: "adjust" },
  detective: { habits: ["squint", "squint", "glance"], pace: 1, signature: "squint" },
};
const QUICK_GESTURES = new Set<IdleGesture>(["glance", "blink", "double-blink", "tilt"]);
const RARE_GESTURE_REST = 4_000;
/* Hovering a face delights it once in a while; four quick pokes make it dizzy. */
const DELIGHT_COOLDOWN = 3_500;
const POKE_WINDOW = 1_600;
const DIZZY_POKES = 4;
/* After a while with no pointer or keys, faces get drowsy; the first movement wakes them one by one. */
const DOZE_AFTER = 150_000;
/* The face drifts on a longer, non-integer multiple of the float so the two layers never realign for long. */
const DRIFT_RATIO = 1.37;
const identities = new Map<string, {
  engageAt?: number;
  wakeAt?: number;
  lastAt?: Partial<Record<AvatarReaction, number>>;
  appeared?: boolean;
  leftAt?: number;
  cue?: { reaction: AvatarReaction; at: number };
}>();
const groups = new Map<string, { at: number; owner: object }>();
const listeners = new Set<(identity: string) => void>();

const CUE_FACE_DURATION: Record<AvatarCue, number> = { happy: 1_700, sorry: 1_900 };
/* A face in the background (window behind, scrolled away) plays a recent cue when it comes back,
 * so a reply that landed while you were elsewhere still gets its smile. */
const CUE_FACE_RETENTION = 12_000;
/* Two sources reporting the same moment (the open conversation and the team list) make one reaction. */
const CUE_FACE_ECHO = 10_000;
const cueFaces = new Map<string, { cue: AvatarCue; at: number }>();
const cueFaceListeners = new Set<(identity: string) => void>();

/** Every face of this coworker shows the cue once: now if in view, or when it next comes into view while the cue is recent. */
export function expressCoworker(identity: string, cue: AvatarCue): void {
  const now = Date.now();
  const last = cueFaces.get(identity);
  if (last && last.cue === cue && now - last.at < CUE_FACE_ECHO) return;
  cueFaces.delete(identity);
  cueFaces.set(identity, { cue, at: now });
  if (cueFaces.size > 128) {
    const oldest = cueFaces.keys().next().value;
    if (oldest !== undefined) cueFaces.delete(oldest);
  }
  for (const listener of cueFaceListeners) listener(identity);
}

function memory(identity: string) {
  let entry = identities.get(identity);
  if (!entry) {
    entry = {};
    identities.set(identity, entry);
  } else {
    identities.delete(identity);
    identities.set(identity, entry);
  }
  if (identities.size > 128) {
    const oldest = identities.keys().next().value;
    if (oldest !== undefined) identities.delete(oldest);
  }
  return entry;
}

/** Fleeting, local acknowledgement only. Call at the actual user event, not on status changes. */
export function acknowledgeCoworker(identity: string, reaction: AvatarReaction = "engage"): void {
  const entry = memory(identity);
  const now = Date.now();
  if (reaction === "wake" && entry.engageAt !== undefined && now - entry.engageAt < CUE_RETENTION) return;
  const last = reaction === "wake" ? entry.wakeAt : entry.lastAt?.[reaction];
  if (last !== undefined && now - last < REACTION_COOLDOWN[reaction]) return;
  // Anything the person just did outranks a wake-up.
  if (reaction === "wake") entry.wakeAt = now;
  else entry.engageAt = now;
  entry.lastAt = { ...entry.lastAt, [reaction]: now };
  entry.cue = { reaction, at: now };
  for (const listener of listeners) listener(identity);
}

function seedFor(identity: string) {
  let value = 2166136261;
  for (const character of identity) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

type PointerTarget = {
  element: SVGSVGElement;
  /** A showcase face (Customize, a profile, the Marketplace) watches the pointer anywhere in the window. */
  watcher: boolean;
  follow: (x: number, y: number) => void;
  leave: () => void;
  poke: () => void;
};
const pointerTargets = new Set<PointerTarget>();
let pointerTarget: PointerTarget | undefined;

function leavePointer() {
  pointerTarget?.leave();
  pointerTarget = undefined;
  for (const target of pointerTargets) if (target.watcher) target.leave();
}

function followPointer(event: PointerEvent) {
  if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
    leavePointer();
    return;
  }
  // Nearby attention still belongs to one list face at a time; showcase faces all watch.
  let nearest: PointerTarget | undefined;
  let nearestDistance = Infinity;
  for (const target of pointerTargets) {
    if (target.watcher) {
      target.follow(event.clientX, event.clientY);
      continue;
    }
    const bounds = target.element.getBoundingClientRect();
    const distance = Math.hypot(event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2);
    if (bounds.width > 0 && distance <= Math.max(64, Math.min(150, bounds.width * 1.5)) && distance < nearestDistance) {
      nearest = target;
      nearestDistance = distance;
    }
  }
  if (pointerTarget !== nearest) {
    pointerTarget?.leave();
    pointerTarget = nearest;
  }
  nearest?.follow(event.clientX, event.clientY);
}

/** A press on a face pokes it, even when the face sits under a row's own click target. */
function pokePointer(event: PointerEvent) {
  let hit: PointerTarget | undefined;
  let hitDistance = Infinity;
  for (const target of pointerTargets) {
    const bounds = target.element.getBoundingClientRect();
    if (bounds.width === 0 || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) continue;
    const distance = Math.hypot(event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2);
    if (distance < hitDistance) {
      hit = target;
      hitDistance = distance;
    }
  }
  hit?.poke();
}

function addPointerTarget(target: PointerTarget) {
  if (pointerTargets.size === 0) {
    window.addEventListener("pointermove", followPointer, { passive: true });
    window.addEventListener("pointerdown", pokePointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", leavePointer);
  }
  pointerTargets.add(target);
  return () => {
    if (pointerTarget === target) pointerTarget = undefined;
    target.leave();
    pointerTargets.delete(target);
    if (pointerTargets.size === 0) {
      window.removeEventListener("pointermove", followPointer);
      window.removeEventListener("pointerdown", pokePointer);
      document.documentElement.removeEventListener("pointerleave", leavePointer);
    }
  };
}

type Sleeper = { doze: () => void; rouse: () => void };
const sleepers = new Set<Sleeper>();
let lastActive = Date.now();
let dozing = false;
let dozeTimer: number | undefined;

function checkDoze() {
  dozeTimer = undefined;
  if (sleepers.size === 0) return;
  const idle = Date.now() - lastActive;
  if (idle < DOZE_AFTER) {
    dozeTimer = window.setTimeout(checkDoze, DOZE_AFTER - idle);
    return;
  }
  dozing = true;
  for (const sleeper of sleepers) sleeper.doze();
}

/* Cheap on every event: a timestamp and a flag; the single timer re-arms itself only when it fires. */
function noteActivity() {
  lastActive = Date.now();
  if (dozing) {
    dozing = false;
    for (const sleeper of sleepers) sleeper.rouse();
  }
  if (dozeTimer === undefined && sleepers.size > 0) dozeTimer = window.setTimeout(checkDoze, DOZE_AFTER);
}

const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel"] as const;

function addSleeper(sleeper: Sleeper) {
  if (sleepers.size === 0) {
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, noteActivity, { passive: true, capture: true });
    lastActive = Date.now();
    dozing = false;
    dozeTimer = window.setTimeout(checkDoze, DOZE_AFTER);
  }
  sleepers.add(sleeper);
  if (dozing) sleeper.doze();
  return () => {
    sleepers.delete(sleeper);
    if (sleepers.size === 0) {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, noteActivity, { capture: true });
      if (dozeTimer !== undefined) window.clearTimeout(dozeTimer);
      dozeTimer = undefined;
      dozing = false;
    }
  };
}

export type AvatarGather = { key: string; owner: object; index: number };

/** No render-time browser access, per-frame React state, or background polling. */
export function useAvatarMotion({
  identity,
  motion = "attentive",
  animated = true,
  gaze = true,
  prominent = false,
  intensity = 1,
  gather,
  regardX = 0,
  regardY = 0,
  temperament = "neutral",
}: {
  identity: string;
  motion?: AvatarMotion;
  animated?: boolean;
  gaze?: boolean;
  prominent?: boolean;
  intensity?: number;
  gather?: AvatarGather;
  /** Resting look direction in -1..1, e.g. toward a neighbour who is replying; idle glances return to it. */
  regardX?: number;
  regardY?: number;
  /** Which idle habits and signature move this face has; read live, so a change never restarts the face. */
  temperament?: AvatarTemperament;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const seenCue = useRef<{ identity: string; at: number } | null>(null);
  const seenFace = useRef<{ identity: string; at: number } | null>(null);
  const regard = useRef({ x: regardX, y: regardY });
  const character = useRef(TEMPERAMENTS[temperament] ?? TEMPERAMENTS.neutral);
  character.current = TEMPERAMENTS[temperament] ?? TEMPERAMENTS.neutral;
  const retarget = useRef<() => void>(() => {});
  const groupKey = gather?.key;
  const groupOwner = gather?.owner;
  const groupIndex = gather?.index ?? 0;

  // A new regard retargets the resting pose in place; it never restarts timers, float phase or wake.
  useEffect(() => {
    regard.current = { x: regardX, y: regardY };
    retarget.current();
  }, [regardX, regardY]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const avatar = element;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const seed = seedFor(identity);
    const timers = new Set<number>();
    let idleTimer: number | undefined;
    let gesture = 0;
    let lastGesture: IdleGesture | undefined;
    let inView = typeof IntersectionObserver === "undefined";
    let focused = document.hasFocus();
    let paused = true;
    let started = false;
    let awaySince = Date.now();
    let interacting = false;
    let reacting = false;
    let removePointer: (() => void) | undefined;
    // A cue's face runs on its own timer, so idle gestures and reactions never cut it short.
    let faceTimer: number | undefined;
    let removeSleeper: (() => void) | undefined;
    let insideFace = false;
    let delightAt = 0;
    let pokes: number[] = [];
    const watcher = motion === "playful" || motion === "presentation";

    avatar.dataset.avatarMotion = "true";
    avatar.dataset.motion = motion;
    const floatDuration = 7.6 + (seed % 2400) / 1000;
    avatar.style.setProperty("--avatar-float-duration", `${floatDuration}s`);
    avatar.style.setProperty("--avatar-drift-duration", `${(floatDuration * DRIFT_RATIO).toFixed(3)}s`);
    avatar.style.setProperty("--avatar-float-delay", `${-(seed % 7000) / 1000}s`);

    function later(work: () => void, delay: number) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        work();
      }, delay);
      timers.add(timer);
      return timer;
    }

    function clearTimers() {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      idleTimer = undefined;
    }

    /** Rest: straight ahead, or toward the current regard while paused copies always rest straight. */
    function neutral() {
      const { x, y } = regard.current;
      if (!paused && (x || y)) look(x, y, "neutral");
      else {
        avatar.style.setProperty("--avatar-look-x", "0px");
        avatar.style.setProperty("--avatar-look-y", "0px");
        avatar.style.setProperty("--avatar-feature-look-x", "0px");
        avatar.style.setProperty("--avatar-feature-look-y", "0px");
        avatar.style.setProperty("--avatar-turn", "0deg");
        avatar.style.setProperty("--avatar-lean", "0deg");
        avatar.dataset.gaze = "neutral";
      }
      avatar.dataset.blinking = "false";
    }

    /** Eyes lead, features follow a little, and the whole body leans a touch toward the same side. */
    function look(x: number, y: number, source: "pointer" | "idle" | "neutral", lean = x * 1.5) {
      const strength = Math.max(0, Math.min(1, intensity));
      avatar.style.setProperty("--avatar-look-x", `${(x * 2.4 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-look-y", `${(y * 2.1 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-feature-look-x", `${(x * 0.35 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-feature-look-y", `${(y * 0.2 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-turn", `${(x * 0.65 * strength).toFixed(3)}deg`);
      avatar.style.setProperty("--avatar-lean", `${(lean * strength).toFixed(3)}deg`);
      avatar.dataset.gaze = source;
    }

    function blink(at: number) {
      later(() => { avatar.dataset.blinking = "true"; }, at);
      later(() => { avatar.dataset.blinking = "false"; }, at + 240);
    }

    function scheduleIdle() {
      if (paused || motion === "quiet" || reacting || interacting || idleTimer !== undefined || avatar.dataset.sleepy === "true") return;
      const { habits, pace } = character.current;
      const rest = lastGesture && !QUICK_GESTURES.has(lastGesture) ? RARE_GESTURE_REST : 0;
      idleTimer = later(() => {
        idleTimer = undefined;
        if (paused || interacting || reacting) return;
        const phase = seedFor(`${identity}:${gesture++}`);
        const table = habits.length ? [...IDLE_GESTURES, ...habits] : IDLE_GESTURES;
        let kind = table[phase % table.length] ?? "glance";
        // A habit or rare gesture never plays twice in a row; the seeded sequence stays deterministic per identity.
        if (!QUICK_GESTURES.has(kind) && kind === lastGesture) kind = "glance";
        lastGesture = kind;
        perform(kind, (phase >> 4) % 2 ? 1 : -1);
      }, Math.round((5_600 + rest + ((seed + gesture * 2357) % 6_400)) * pace));
    }

    /** One gesture, from the idle mix or a temperament's signature: glances and tilts move the gaze, the rest are body cues. */
    function perform(kind: IdleGesture, side = 1) {
      const settle = (after: number) => later(() => {
        neutral();
        scheduleIdle();
      }, after);
      switch (kind) {
        case "glance":
          look(side * 0.72, 0.18, "idle");
          blink(260);
          settle(1_100);
          break;
        case "blink":
          blink(0);
          settle(360);
          break;
        case "double-blink":
          blink(0);
          blink(360);
          settle(760);
          break;
        case "tilt":
          look(side * 0.22, -0.3, "idle", side * 2.4);
          blink(520);
          settle(1_500);
          break;
        default:
          react(kind);
      }
    }

    function react(cue: BodyCue, delay = 0) {
      if (paused) return;
      clearTimers();
      neutral();
      reacting = true;
      avatar.dataset.reaction = "none";
      const play = () => {
        // A repeat (boop, boop) must restart its animation, so let the cleared state reach the style first.
        avatar.dataset.reaction = "none";
        void avatar.getBoundingClientRect();
        avatar.dataset.reaction = cue;
        later(() => {
          reacting = false;
          avatar.dataset.reaction = "none";
          neutral();
          scheduleIdle();
        }, CUE_DURATION[cue]);
      };
      if (delay) later(play, delay);
      else play();
    }

    function endFace() {
      if (faceTimer !== undefined) window.clearTimeout(faceTimer);
      faceTimer = undefined;
      avatar.dataset.cue = "none";
    }

    function showFace(eventIdentity: string) {
      if (eventIdentity !== identity || paused) return;
      const face = cueFaces.get(identity);
      if (!face || Date.now() - face.at > CUE_FACE_RETENTION) return;
      if (seenFace.current?.identity === identity && seenFace.current.at === face.at) return;
      seenFace.current = { identity, at: face.at };
      endFace();
      avatar.dataset.cue = face.cue;
      faceTimer = window.setTimeout(endFace, CUE_FACE_DURATION[face.cue]);
    }

    function receive(eventIdentity: string) {
      if (eventIdentity !== identity || paused) return;
      const cue = memory(identity).cue;
      if (!cue || Date.now() - cue.at > CUE_RETENTION) return;
      if (seenCue.current?.identity === identity && seenCue.current.at === cue.at) return;
      seenCue.current = { identity, at: cue.at };
      avatar.dataset.sleepy = "false";
      if (cue.reaction !== "personality") {
        react(cue.reaction);
        return;
      }
      // The picker's new personality reaches this face on its next render; show that one's signature.
      clearTimers();
      neutral();
      later(() => perform(character.current.signature), 60);
    }

    function wake(returning: boolean) {
      const now = Date.now();
      const entry = memory(identity);
      if (entry.engageAt !== undefined && now - entry.engageAt < CUE_RETENTION) return;
      if (groupKey !== undefined && groupOwner) {
        const last = groups.get(groupKey);
        if (last && now - last.at < WAKE_COOLDOWN && (last.owner !== groupOwner || now - last.at > CUE_RETENTION)) return;
        if (!last || now - last.at >= WAKE_COOLDOWN) {
          groups.delete(groupKey);
          groups.set(groupKey, { at: now, owner: groupOwner });
          if (groups.size > 64) {
            const oldest = groups.keys().next().value;
            if (oldest !== undefined) groups.delete(oldest);
          }
        }
      } else {
        if (!prominent || motion === "quiet") return;
        if (entry.appeared && !returning && (entry.leftAt === undefined || now - entry.leftAt < WAKE_COOLDOWN)) return;
      }
      entry.appeared = true;
      if (entry.wakeAt !== undefined && now - entry.wakeAt < WAKE_COOLDOWN) return;
      entry.wakeAt = now;
      react("wake", groupKey === undefined ? 0 : groupIndex * 140);
    }

    const target: PointerTarget = {
      element: avatar,
      watcher,
      follow: (x, y) => {
        const bounds = avatar.getBoundingClientRect();
        const dx = x - bounds.left - bounds.width / 2;
        const dy = y - bounds.top - bounds.height / 2;
        const distance = Math.hypot(dx, dy);
        // Arriving on the face itself delights it now and then: sparkly eyes, cheeks, a small lift.
        const inside = distance <= bounds.width * 0.45;
        if (inside && !insideFace && !reacting && Date.now() - delightAt > DELIGHT_COOLDOWN) {
          insideFace = true;
          delightAt = Date.now();
          interacting = true;
          react("delight");
          return;
        }
        insideFace = inside;
        interacting = true;
        if (reacting) return;
        clearTimers();
        avatar.dataset.blinking = "false";
        const divisor = Math.max(watcher ? 90 : 60, distance);
        look(dx / divisor, dy / divisor, "pointer");
      },
      leave: () => {
        if (!interacting && !insideFace) return;
        interacting = false;
        insideFace = false;
        if (reacting) return;
        neutral();
        scheduleIdle();
      },
      poke: () => {
        const now = Date.now();
        pokes = [...pokes.filter((at) => now - at < POKE_WINDOW), now];
        if (pokes.length >= DIZZY_POKES) {
          pokes = [];
          react("dizzy");
        } else react("boop");
      },
    };

    const sleeper: Sleeper = {
      doze: () => {
        // A face at work or waiting on the person never looks asleep.
        if (paused || avatar.classList.contains("is-working") || avatar.dataset.expression !== "none") return;
        clearTimers();
        reacting = false;
        avatar.dataset.reaction = "none";
        neutral();
        avatar.dataset.sleepy = "true";
      },
      rouse: () => {
        if (avatar.dataset.sleepy !== "true") return;
        avatar.dataset.sleepy = "false";
        if (paused) return;
        // The team wakes one by one rather than all at once.
        react("perk", 120 + (seed % 5) * 110);
      },
    };

    function sync() {
      const nextPaused = !animated || reduced.matches || document.hidden || !focused || !inView;
      avatar.dataset.motionPaused = String(nextPaused);
      if (paused !== nextPaused) {
        paused = nextPaused;
        if (paused) {
          awaySince = Date.now();
          if (prominent) memory(identity).leftAt = awaySince;
          clearTimers();
          removePointer?.();
          removePointer = undefined;
          reacting = false;
          interacting = false;
          insideFace = false;
          avatar.dataset.reaction = "none";
          avatar.dataset.sleepy = "false";
          removeSleeper?.();
          removeSleeper = undefined;
          endFace();
          neutral();
        } else {
          neutral();
          receive(identity);
          showFace(identity);
          if (!reacting && (!started || Date.now() - awaySince >= WAKE_COOLDOWN)) wake(started);
          if (prominent && motion !== "quiet") memory(identity).appeared = true;
          started = true;
          scheduleIdle();
        }
      }
      if (!paused && motion !== "quiet" && !removeSleeper) removeSleeper = addSleeper(sleeper);
      const trackPointer = !paused && gaze && motion !== "quiet" && finePointer.matches;
      if (trackPointer && !removePointer) removePointer = addPointerTarget(target);
      if (!trackPointer && removePointer) {
        removePointer();
        removePointer = undefined;
      }
    }

    const onBlur = () => { focused = false; sync(); };
    const onFocus = () => { focused = true; sync(); };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
      inView = !!entry?.isIntersecting && entry.intersectionRatio >= 0.15;
      sync();
    }, { threshold: [0, 0.15] });
    retarget.current = () => {
      // Mid-glance or mid-reaction poses settle into the new regard on their own.
      if (paused || interacting || reacting || avatar.dataset.gaze === "idle") return;
      neutral();
    };
    neutral();
    avatar.dataset.reaction = "none";
    avatar.dataset.cue = "none";
    avatar.dataset.sleepy = "false";
    listeners.add(receive);
    cueFaceListeners.add(showFace);
    observer?.observe(avatar);
    reduced.addEventListener("change", sync);
    finePointer.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    sync();

    return () => {
      const leftAt = paused ? awaySince : Date.now();
      retarget.current = () => {};
      paused = true;
      clearTimers();
      removePointer?.();
      removeSleeper?.();
      neutral();
      avatar.dataset.reaction = "none";
      avatar.dataset.sleepy = "false";
      endFace();
      avatar.dataset.motionPaused = "true";
      if (prominent && started) memory(identity).leftAt = leftAt;
      listeners.delete(receive);
      cueFaceListeners.delete(showFace);
      observer?.disconnect();
      reduced.removeEventListener("change", sync);
      finePointer.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [identity, motion, animated, gaze, prominent, intensity, groupKey, groupOwner, groupIndex]);

  return ref;
}
