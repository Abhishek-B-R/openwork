import type { Ref } from "react";
import type { AvatarMotion } from "./coworker-avatar-motion";

export type AvatarColor =
  | "blue" | "violet" | "mint" | "orange" | "rose" | "slate" | "sand" | "sage"
  | "sky" | "lagoon" | "lime" | "lemon" | "coral" | "grape";
export type AvatarGlasses = "round" | "square" | "oval" | "none" | "sunglasses" | "monocle" | "star";
/**
 * A face held while something lasts: `thinking` (eyes up and aside, a small
 * "hmm" mouth) while a reply is being worked out, `curious` (a gentle tilt,
 * round eyes, a small "o") while the coworker waits on the person. Short
 * reactions, happy or sorry, are cues instead (see `expressCoworker`).
 */
export type AvatarExpression = "none" | "thinking" | "curious";
/**
 * A coworker's temperament: which small habits its face falls into when idle
 * (a playful one winks, a detective squints) and the signature move it shows
 * when you pick that personality. Any other value behaves like "neutral".
 */
export type AvatarTemperament =
  | "none" | "neutral" | "warm" | "calm" | "eager" | "playful" | "dry" | "blunt"
  | "curious" | "thoughtful" | "meticulous" | "detective";

/* Soft colors keep their original values. The bold six share the same lightness steps
 * (fill, edge, depth) at two to three times the chroma, so glasses stay legible and the
 * cut-paper construction reads the same; each sits between existing hues, not on one. */
const PALETTES: Record<AvatarColor, { fill: string; edge: string; depth: string }> = {
  blue: { fill: "#b8c9f0", edge: "#91a9dc", depth: "#7389b7" },
  violet: { fill: "#c8c1e2", edge: "#aaa1d0", depth: "#81789f" },
  mint: { fill: "#b2d5cb", edge: "#8dbbae", depth: "#668e84" },
  orange: { fill: "#e4c3ad", edge: "#cda589", depth: "#9d7961" },
  rose: { fill: "#e2c1cb", edge: "#cda1ae", depth: "#9c7682" },
  slate: { fill: "#e3e6ea", edge: "#c2c8d0", depth: "#939aa4" },
  sand: { fill: "#ded0b0", edge: "#c1ae86", depth: "#95825c" },
  sage: { fill: "#becab4", edge: "#9eaf91", depth: "#788b6c" },
  sky: { fill: "#a1d0fd", edge: "#63b1f9", depth: "#4c8bc5" },
  lagoon: { fill: "#73dfe0", edge: "#25c2c3", depth: "#1d989a" },
  lime: { fill: "#addb88", edge: "#89bd5b", depth: "#6b9544" },
  lemon: { fill: "#e4ca5f", edge: "#c5aa2b", depth: "#9c851a" },
  coral: { fill: "#fdb6ac", edge: "#f2897c", depth: "#bf6b60" },
  grape: { fill: "#e3b6ff", edge: "#c692e6", depth: "#9c72b6" },
};

/** A face's main color, for things drawn around it (a card's backdrop, a tint). */
export function avatarFill(color: AvatarColor): string {
  return PALETTES[color].fill;
}

export type StaticCoworkerAvatarProps = {
  name: string;
  color: AvatarColor;
  glasses: AvatarGlasses;
  size?: number;
  animated?: boolean;
  working?: boolean;
  expression?: AvatarExpression;
  identity?: string;
  motion?: AvatarMotion;
  temperament?: AvatarTemperament;
  /** The coworker whose conversation is open: it keeps glancing toward it. */
  selected?: boolean;
  svgRef?: Ref<SVGSVGElement>;
};

/** Hook-free SVG shared by the animated client and server image renderer. */
export function StaticCoworkerAvatar({
  name,
  color,
  glasses,
  size = 96,
  animated = false,
  working = false,
  expression = "none",
  svgRef,
  identity = name,
  motion = size <= 44 ? "quiet" : "attentive",
  temperament = "neutral",
  selected = false,
}: StaticCoworkerAvatarProps) {
  const palette = PALETTES[color];

  return (
    <svg
      ref={svgRef}
      aria-label={`${name || "Coworker"} avatar`}
      className={`coworker-avatar ${working ? "is-working" : ""}`}
      data-identity={identity}
      data-testid="coworker-avatar"
      data-motion={motion}
      data-context={size <= 44 ? "compact" : "prominent"}
      data-animated={animated}
      data-motion-paused="true"
      data-reaction="none"
      data-expression={expression}
      data-cue="none"
      data-temperament={temperament}
      data-selected={selected}
      data-glasses={glasses}
      role="img"
      style={{ width: size, height: size }}
      width={size}
      height={size}
      viewBox="0 0 122 122"
    >
      <g className="coworker-avatar__pointer-body">
        <g className="coworker-avatar__body">
          <g className="coworker-avatar__depth">
            <path
              d="M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z"
              fill={palette.depth}
              opacity="0.72"
              transform="translate(3 3)"
            />
          </g>
          <path
            d="M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z"
            fill={palette.fill}
            stroke={palette.edge}
            strokeWidth="1.25"
          />
          <path
            d="M26 11h64c12 0 20 7 21 19"
            fill="none"
            stroke="#ffffff"
            strokeLinecap="round"
            strokeOpacity="0.24"
            strokeWidth="1"
          />
          <g className="coworker-avatar__pointer-features">
            <g className="coworker-avatar__features">
              <g className="coworker-avatar__pointer-gaze">
                <g className="coworker-avatar__gaze">
                  <g className="coworker-avatar__pupils" fill="#0b0e14">
                    <rect className="coworker-avatar__mood" x="34.5" y="50" width="6" height="14" rx="3" />
                    <rect className="coworker-avatar__mood" x="79.5" y="50" width="6" height="14" rx="3" />
                  </g>
                  {/* Closed, smiling eyes for a happy moment; hidden until one plays. */}
                  <g className="coworker-avatar__happy-eyes" fill="none" stroke="#0b0e14" strokeLinecap="round" strokeWidth="4.5">
                    <path className="coworker-avatar__mood" d="M31.5 60.5q6-7.5 12 0" opacity="0" />
                    <path className="coworker-avatar__mood" d="M76.5 60.5q6-7.5 12 0" opacity="0" />
                  </g>
                  {/* Lids: flat over half-open eyes when unimpressed, closed curves when dozing; hidden until used. */}
                  <g className="coworker-avatar__lids" fill="none" stroke="#0b0e14" strokeLinecap="round" strokeWidth="3.4">
                    <path className="coworker-avatar__mood coworker-avatar__lid-flat" d="M32 55h11" opacity="0" />
                    <path className="coworker-avatar__mood coworker-avatar__lid-flat" d="M77 55h11" opacity="0" />
                    <path className="coworker-avatar__mood coworker-avatar__lid-sleep" d="M32 57.5q5.5 4.5 11 0" opacity="0" />
                    <path className="coworker-avatar__mood coworker-avatar__lid-sleep" d="M77 57.5q5.5 4.5 11 0" opacity="0" />
                  </g>
                </g>
              </g>
              {glasses === "round" || glasses === "star" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="5">
                  <circle cx="37.5" cy="57" r="17.5" />
                  <circle cx="82.5" cy="57" r="17.5" />
                  <path d="M57.5 57c1.25-4 3.75-4 5 0" />
                  <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
                  {glasses === "star" ? (
                    <path d="M100 34.5 102 38.8 106.7 39.4 103.2 42.6 104.1 47.2 100 44.9 95.9 47.2 96.8 42.6 93.3 39.4 98 38.8Z" fill="#11151d" strokeWidth="1" strokeLinejoin="round" />
                  ) : null}
                </g>
              ) : null}
              {glasses === "oval" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="5">
                  <ellipse cx="37.5" cy="57" rx="18" ry="14" />
                  <ellipse cx="82.5" cy="57" rx="18" ry="14" />
                  <path d="M57.5 57c1.25-4 3.75-4 5 0" />
                  <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
                </g>
              ) : null}
              {glasses === "square" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5">
                  <rect x="19.5" y="39" width="36" height="36" rx="10" />
                  <rect x="64.5" y="39" width="36" height="36" rx="10" />
                  <path d="M58 57c1-3.5 3-3.5 4 0" />
                  <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
                </g>
              ) : null}
              {glasses === "sunglasses" ? (
                <g className="coworker-avatar__glasses" stroke="#11151d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4.5">
                  <rect x="19.5" y="41" width="36" height="32" rx="12" fill="#263349" fillOpacity="0.24" />
                  <rect x="64.5" y="41" width="36" height="32" rx="12" fill="#263349" fillOpacity="0.24" />
                  <path d="M57.5 55c1.25-2.5 3.75-2.5 5 0M15 55h4.5M100.5 55h4.5" fill="none" />
                  <path d="M27 47h12M72 47h12" stroke="#ffffff" strokeOpacity="0.25" strokeWidth="1.5" />
                </g>
              ) : null}
              {glasses === "monocle" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round">
                  <circle cx="82.5" cy="57" r="17.5" strokeWidth="3.5" />
                  <path d="M96 68l2 2" strokeWidth="2.5" />
                  {size > 36 ? <path className="coworker-avatar__monocle-chain" d="M98 70c5 6 6 16 0 20-3 2-5 1-5-2" strokeWidth="1.25" strokeOpacity="0.7" /> : null}
                </g>
              ) : null}
              {/* A small mouth, shown only with an expression: "hmm" while thinking, "o" when curious, a smile or a frown for a moment.
                  Hidden by attribute so artwork rendered without the stylesheet (a social image) shows the plain face. */}
              {/* Soft cheeks for a delighted, poked or greeting moment; hidden by attribute like the mouth. */}
              <g className="coworker-avatar__cheeks" fill="#ff8fa3">
                <ellipse className="coworker-avatar__mood" cx="27" cy="82" rx="6.5" ry="3.6" opacity="0" />
                <ellipse className="coworker-avatar__mood" cx="93" cy="82" rx="6.5" ry="3.6" opacity="0" />
              </g>
              <g className="coworker-avatar__mouth" fill="none" stroke="#11151d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.4">
                <path className="coworker-avatar__mood coworker-avatar__mouth-hmm" d="M55 89.5q4.5-3.6 9.5-0.6" opacity="0" />
                <ellipse className="coworker-avatar__mood coworker-avatar__mouth-o" cx="60" cy="89" rx="2.6" ry="3.2" strokeWidth="2.8" opacity="0" />
                <path className="coworker-avatar__mood coworker-avatar__mouth-smile" d="M53.5 86.5q6.5 6 13 0" opacity="0" />
                <path className="coworker-avatar__mood coworker-avatar__mouth-frown" d="M54.5 91q5.5-4.2 11 0" opacity="0" />
                <path className="coworker-avatar__mood coworker-avatar__mouth-flat" d="M55 89.5h10" opacity="0" />
              </g>
            </g>
          </g>
        </g>
        {/* Two small sparkles for a new look (a color or glasses change); hidden until one plays. */}
        <g className="coworker-avatar__sparkles" fill="#ffffff">
          <path className="coworker-avatar__mood" d="M105 4l1.7 4.6 4.6 1.7-4.6 1.7L105 16.6l-1.7-4.6-4.6-1.7 4.6-1.7Z" opacity="0" />
          <path className="coworker-avatar__mood" d="M13 20l1.2 3.2 3.2 1.2-3.2 1.2L13 28.8l-1.2-3.2-3.2-1.2 3.2-1.2Z" opacity="0" />
        </g>
      </g>
    </svg>
  );
}
