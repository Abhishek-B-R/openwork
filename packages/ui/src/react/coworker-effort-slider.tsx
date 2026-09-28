import { useId, type CSSProperties } from "react";

/** Stars inside the fill, in the order they light up as the pace climbs: [left %, top %, size px]. */
const STARS: [number, number, number][] = [
  [24, 30, 7], [60, 60, 9], [82, 26, 6], [40, 68, 6], [70, 36, 8],
  [12, 56, 6], [48, 20, 7], [90, 62, 7], [32, 44, 5], [64, 16, 5],
];
/** Stars lit at each stop: a calm track at Light, a sky full of them at All in. */
const STARS_BY_STOP = [0, 1, 2, 5, 10];
/** Sparks that rise off the thumb once the pace is high: [sideways drift px, delay s]. */
const SPARKS: [number, number][] = [
  [-10, 0], [8, -0.45], [-4, -0.9], [12, -0.2], [-13, -0.65], [4, -1.1],
  [-7, -0.3], [10, -0.8], [-16, -0.55], [15, -1], [0, -0.15], [-2, -0.7],
];
const SPARKS_BY_STOP = [0, 0, 0, 4, 12];
/** Rays in the burst that greets a high pace: a little one at Thorough, a big one at All in. */
const BURST_RAYS: Record<string, number> = { thorough: 6, "all-in": 14 };
const STAR_PATH = "M6 0 7.5 4.5 12 6 7.5 7.5 6 12 4.5 7.5 0 6 4.5 4.5Z";

/** How far the glasses' lenses have turned from round (0) to star-shaped (1) at each stop. */
const LENS_STAR = [0, 0, 0, 0.3, 1];
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * One lens as ten curves, so CSS can morph it: at 0 a circle (the everyday
 * glasses), at 1 a five-pointed star, and in between a softly pointed lens.
 */
function lensPath(cx: number, cy: number, star: number): string {
  const outer = 17.5 + 3.5 * star;
  const inner = outer * (1 - 0.52 * star);
  const vertices = Array.from({ length: 10 }, (_, vertex) => {
    const angle = ((-90 + vertex * 36) * Math.PI) / 180;
    const radius = vertex % 2 ? inner : outer;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), angle, radius };
  });
  // A 36° arc is a cubic with handles this long (times the radius), along the tangent.
  const handle = (4 / 3) * Math.tan(Math.PI / 20);
  const mix = (curved: number, straight: number) => round(curved + (straight - curved) * star);
  let path = `M${round(vertices[0]!.x)} ${round(vertices[0]!.y)}`;
  vertices.forEach((from, vertex) => {
    const to = vertices[(vertex + 1) % vertices.length]!;
    const c1x = mix(from.x - Math.sin(from.angle) * handle * from.radius, from.x + (to.x - from.x) / 3);
    const c1y = mix(from.y + Math.cos(from.angle) * handle * from.radius, from.y + (to.y - from.y) / 3);
    const c2x = mix(to.x + Math.sin(to.angle) * handle * to.radius, from.x + ((to.x - from.x) * 2) / 3);
    const c2y = mix(to.y - Math.cos(to.angle) * handle * to.radius, from.y + ((to.y - from.y) * 2) / 3);
    path += ` C${c1x} ${c1y} ${c2x} ${c2y} ${round(to.x)} ${round(to.y)}`;
  });
  return `${path}Z`;
}

/** The glasses at each stop: lenses, a bridge that reaches them, and arms that stay attached. */
const GLASSES = LENS_STAR.map((star) => {
  const reach = 7 * star;
  const armY = round(57 - 6.5 * star);
  return {
    left: lensPath(37.5, 57, star),
    right: lensPath(82.5, 57, star),
    bridge: `M${round(57.5 - reach)} 57 C${round(58.75 - reach * 0.5)} ${round(53 - star)} ${round(61.25 + reach * 0.5)} ${round(53 - star)} ${round(62.5 + reach)} 57`,
    arms: `M${round(15 - 3.5 * star)} ${armY} L${round(19.5 - 2 * star)} ${armY} M${round(100.5 + 2 * star)} ${armY} L${round(105 + 3.5 * star)} ${armY}`,
    // A glint in each lens, drawn in toward the middle as the lens sharpens into a star.
    glint: [37.5, 82.5].map((cx) => {
      const k = 1 - 0.5 * star;
      return `M${round(cx - 10.5 * k)} ${round(57 - 5.5 * k)} C${round(cx - 9 * k)} ${round(57 - 8.7 * k)} ${round(cx - 6.3 * k)} ${round(57 - 10.7 * k)} ${round(cx - 3 * k)} ${round(57 - 11.3 * k)}`;
    }).join(" "),
  };
});
const shape = (path: string) => ({ d: `path("${path}")` }) as CSSProperties;

/**
 * Shared visual control: native keyboard and pointer interaction, no inference.
 * The track gets livelier stop by stop (more stars, quicker light, sparks off
 * the thumb) and celebrates arriving at All in; reduced motion keeps it still.
 */
export function CoworkerEffortSlider({ index, stop, label, labelId, autoFocus = false, onChange }: {
  index: number; stop: string; label: string; labelId: string; autoFocus?: boolean; onChange: (index: number) => void;
}) {
  const tintId = `effort-tint-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const glasses = GLASSES[index] ?? GLASSES[2]!;
  const thumbCenter = `calc(${index * 25}% + ${16 - index * 8}px)`;
  const rays = BURST_RAYS[stop] ?? 0;
  return (
    <div className="effort-slider" data-stop={stop}>
    <div aria-hidden="true" className="effort-slider-track" data-testid="effort-dial-track">
      {/* The fill ends at the thumb's far edge so both rounded caps share a center. */}
      <div className="effort-slider-fill" data-testid="effort-dial-fill" style={{ width: `calc(${index * 25}% + ${32 - index * 8}px)` }}>
        <div className="effort-slider-aurora" />
        {[12, 25, 39, 51, 65, 78, 91].map((position, particle) => (
          <span key={position} className="effort-slider-particle" style={{ left: `${position}%`, top: `${32 + (particle % 3) * 18}%`, animationDelay: `${particle * -0.7}s` }} />
        ))}
        {STARS.slice(0, STARS_BY_STOP[index] ?? 0).map(([left, top, size], star) => (
          <svg key={star} className="effort-slider-star" viewBox="0 0 12 12" style={{ left: `${left}%`, top: `${top}%`, width: size }}>
            <path d={STAR_PATH} style={{ animationDelay: `${star * -0.37}s` }} />
          </svg>
        ))}
        <span className="effort-slider-sweep" />
      </div>
    </div>
    <div aria-hidden="true" className="effort-slider-stops">
      {[0, 1, 2, 3, 4].map((candidate) => <span key={candidate} />)}
    </div>
    {/* Behind the thumb and free of the track's clipping: its glow, its sparks, and the All in burst. */}
    <div aria-hidden="true" className="effort-slider-thumb-effects" style={{ left: thumbCenter }}>
      <span className="effort-slider-halo" />
      {SPARKS.slice(0, SPARKS_BY_STOP[index] ?? 0).map(([drift, delay], spark) => (
        <span key={spark} className="effort-slider-spark" style={{ "--effort-drift": `${drift}px`, animationDelay: `${delay}s` } as CSSProperties} />
      ))}
      {rays ? (
        <span key={stop} className="effort-slider-burst" data-size={stop === "all-in" ? "big" : "small"} data-testid="effort-dial-burst">
          {Array.from({ length: rays }, (_, ray) => <span key={ray} style={{ "--effort-turn": `${ray / rays}turn` } as CSSProperties} />)}
        </span>
      ) : null}
    </div>
    <input
      type="range"
      min={0}
      max={4}
      step={1}
      value={index}
      aria-labelledby={labelId}
      aria-valuetext={label}
      autoFocus={autoFocus}
      className="effort-dial-range"
      data-testid="effort-dial-range"
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
    />
    {/* The coworker's glasses ride on the thumb, above it: clear and round at an easy pace, sunglasses at Thorough, star shades at All in. */}
    <span aria-hidden="true" className="effort-slider-face" style={{ left: thumbCenter }}>
      <svg viewBox="10 32 100 50" data-testid="effort-dial-glasses" data-star={LENS_STAR[index]}>
        <defs>
          <linearGradient id={tintId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="effort-glasses-tint-from" />
            <stop offset="1" className="effort-glasses-tint-to" />
          </linearGradient>
        </defs>
        <path className="effort-glasses-lens" fill={`url(#${tintId})`} d={glasses.left} style={shape(glasses.left)} />
        <path className="effort-glasses-lens" fill={`url(#${tintId})`} d={glasses.right} style={shape(glasses.right)} />
        <path className="effort-glasses-glint" d={glasses.glint} style={shape(glasses.glint)} />
        <path className="effort-glasses-frame" d={glasses.bridge} style={shape(glasses.bridge)} />
        <path className="effort-glasses-frame" d={glasses.arms} style={shape(glasses.arms)} />
      </svg>
    </span>
  </div>
  );
}
