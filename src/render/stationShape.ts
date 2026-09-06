/**
 * What each station draws inside its hull, in unit space.
 *
 * **Shared between two renderers on purpose**, which reverses the call
 * `icons.ts` made for the hexagon. That call was right: the hull is decoration,
 * and coupling a Pixi `poly()` to an SVG `d` to save nine numbers was not worth
 * it. These are not decoration. A pierce line, a blast ring, a chain path — each
 * is *a claim about what the board is doing*, and the deck makes that claim in a
 * button while the board has to honour it in a sprite. A legend that drifts from
 * the thing it explains is worse than no legend, which is the same reasoning
 * that already made `COLLAR_SECTORS` shared. This is that precedent, applied to
 * the case the design's "deck and board teach each other" creates.
 *
 * Pure geometry: no colour, no Pixi, no DOM. `textures.ts` scales it to
 * `TILE_PX` and fills in `BAKE_NEUTRAL`; `icons.ts` scales it to a 40-unit
 * viewBox and strokes it in `currentColor`. Neither imports the other.
 *
 * **The annulus was the constraint, and half of it has lifted.** The hub used
 * to sit at `shape.hubRatio` (~0.14) and grow with tier, which put a floor
 * under every mark; it is gone, so the centre is a mark's to use. What still
 * binds is the outside: the tier pips own the row at `shape.pipRowY` (~0.80)
 * and the hull's vertices reach ~0.42, so a mark stays under r=0.34 and above
 * y≈0.72. `tools/check.ts` asserts both.
 *
 * Every mark is chosen to be *the shot the station already fires*, so the board
 * is teaching what the deck claims rather than inventing a second vocabulary:
 * Nova's ring is the detonation `effects.ts` draws, Singularity's spiral is the
 * pull itself, Filament's bars are `towerChrome`'s spin-up arc unrolled.
 */
import type { TowerId } from '../content/towers.ts';

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export interface Disc {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

/** Angles in degrees, clockwise from three o'clock, as the collar uses. */
export interface MarkArc {
  readonly r: number;
  readonly from: number;
  readonly span: number;
}

export interface StationMark {
  /** Open polylines, stroked. */
  readonly lines: readonly (readonly Pt[])[];
  /** Filled dots. */
  readonly discs: readonly Disc[];
  /** Stroked arcs centred on the station. */
  readonly arcs: readonly MarkArc[];
}

const NONE: StationMark = { lines: [], discs: [], arcs: [] };

/**
 * An Archimedean spiral, sampled into a polyline.
 *
 * Sampled rather than described because `StationMark` carries lines, discs and
 * arcs, and a spiral is none of those — adding a fourth kind would mean teaching
 * both renderers to draw it, when 32 segments already reads as a curve at 40px.
 *
 * `phase` is the one number here the design did not set. The spiral covers 1.7
 * turns, so its widest sweep has to pass *somewhere*, and at the drawn phase it
 * passed straight through the tier pip row — the collision `tools/check.ts`
 * catches as `lowest 0.76 of 0.72`. Rotating the whole curve moves the sweep off
 * the pips without touching a radius, a turn or a segment, which is why the fix
 * is a phase and not a smaller spiral: a spiral has no upright.
 */
function spiral(from: number, to: number, turns: number, phase: number, segments: number): Pt[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments;
    const a = turns * Math.PI * t + (phase * Math.PI) / 180;
    const r = from + (to - from) * t;
    return { x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r };
  });
}

export const STATION_MARKS: Readonly<Record<TowerId, StationMark>> = {
  /** A shot passing through, with what it has already hit trailing behind it. */
  lance: {
    ...NONE,
    lines: [[{ x: 0.18, y: 0.5 }, { x: 0.8, y: 0.5 }]],
    discs: [
      { cx: 0.68, cy: 0.5, r: 0.042 },
      { cx: 0.79, cy: 0.5, r: 0.028 },
    ],
  },

  /** The detonation ring, at the radius the blast actually draws. */
  nova: {
    ...NONE,
    arcs: [{ r: 0.31, from: 0, span: 360 }],
  },

  /**
   * A gravity well: everything winding in to a core that keeps it.
   *
   * The three arcs this replaces read as a clock — which is fair, because they
   * were the slow clock `creepChrome.ts` draws on a held contact, borrowed. But
   * a clock counts down, and what this station does is *pull*, so the mark was
   * teaching the wrong verb for the only station that deals no damage.
   *
   * Radii are the design's, in the 40-unit box it drew them in: 3.2 out to
   * 13.2, over 3.4π, with a filled core at 2.1. The core is the part the old
   * mark could not have had — it sits where the hub disc used to be, and only
   * became free to use when `textures.ts` stopped baking one.
   */
  singularity: {
    ...NONE,
    lines: [spiral(3.2 / 40, 13.2 / 40, 3.4, 141, 32)],
    discs: [{ cx: 0.5, cy: 0.5, r: 2.1 / 40 }],
  },

  /** A jump between contacts, which is what the chain is. */
  arc: {
    ...NONE,
    lines: [
      [
        { x: 0.25, y: 0.6 },
        { x: 0.42, y: 0.39 },
        { x: 0.58, y: 0.6 },
        { x: 0.75, y: 0.39 },
      ],
    ],
    discs: [
      { cx: 0.25, cy: 0.6, r: 0.036 },
      { cx: 0.58, cy: 0.6, r: 0.036 },
      { cx: 0.75, cy: 0.39, r: 0.036 },
    ],
  },

  /**
   * Provisional. Two short strokes feeding a longer one — the station handing
   * its neighbours something rather than pointing at anything down the route,
   * which is the one thing this mark has to say that no other station's does.
   */
  overclock: {
    ...NONE,
    lines: [
      [{ x: 0.28, y: 0.38 }, { x: 0.5, y: 0.5 }],
      [{ x: 0.28, y: 0.62 }, { x: 0.5, y: 0.5 }],
      [{ x: 0.5, y: 0.5 }, { x: 0.76, y: 0.5 }],
    ],
    discs: [{ cx: 0.76, cy: 0.5, r: 0.042 }],
  },

  /** Time on target, unrolled from the spin-up arc into rising bars. */
  filament: {
    ...NONE,
    lines: [
      [{ x: 0.3, y: 0.66 }, { x: 0.3, y: 0.58 }],
      [{ x: 0.43, y: 0.66 }, { x: 0.43, y: 0.48 }],
      [{ x: 0.57, y: 0.66 }, { x: 0.57, y: 0.38 }],
      [{ x: 0.7, y: 0.66 }, { x: 0.7, y: 0.3 }],
    ],
  },
};

/** Stroke weight for a mark, as a fraction of the tile. Thin: it is a legend. */
export const MARK_STROKE = 0.042;
