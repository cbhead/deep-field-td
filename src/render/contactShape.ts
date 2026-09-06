/**
 * What each contact is, as geometry.
 *
 * Pure, colour-free, Pixi-free — the `stationShape.ts` precedent, applied to the
 * other half of the roster. `textures.ts` scales it to pixels and bakes it;
 * `icons.ts` scales it to a viewBox and emits SVG. Neither imports the other,
 * and a legend that drew a different silhouette from the board would be exactly
 * the drift these modules exist to prevent.
 *
 * **Everything is in units of `R`** — the contact's own body radius,
 * `def.radius × TILE_PX`, which is the same quantity `worldView` scales the
 * sprite by. That is what lets one set of numbers hold across a roster whose
 * radii span 2.7×: a Mote and a Monolith are the same shapes at different
 * sizes, not different shapes.
 *
 * Angles are degrees clockwise from three o'clock, as `COLLAR_SECTORS` uses.
 *
 * Each part carries **either** a lightness multiplier `k` **or** an `alpha`,
 * never both. That is not a style rule: `k` resolves to a literal colour through
 * `step()`, while `alpha` means "let what is behind show through". A part that
 * did both would be asking to be composited two ways at once, and the bake and
 * the SVG would disagree about which won.
 */
import { ENEMIES, type EnemyId } from '../content/enemies.ts';

/** A filled circle. `cx`/`cy` are offsets from the body centre, in R. */
export interface Disc {
  readonly kind: 'disc';
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly k?: number;
  readonly alpha?: number;
}

/** A stroked circle — an annulus, given as centre radius plus width. */
export interface Ring {
  readonly kind: 'ring';
  readonly r: number;
  readonly width: number;
  readonly k?: number;
  readonly alpha?: number;
}

/**
 * A pointed ellipse along the x axis: the Mote's tail.
 *
 * Given as the two tips and a half-height, because that is how the shape is
 * actually reasoned about — "from the nucleus, back this far, this fat".
 */
export interface Lens {
  readonly kind: 'lens';
  readonly from: number;
  readonly to: number;
  readonly half: number;
  readonly k?: number;
  readonly alpha?: number;
}

/** A regular polygon, `points` sides, first vertex at `rotate` degrees. */
export interface Poly {
  readonly kind: 'poly';
  readonly r: number;
  readonly points: number;
  readonly rotate: number;
  readonly k?: number;
  readonly alpha?: number;
}

/**
 * One slice of a regular polygon: centre out to two adjacent vertices.
 *
 * The Bulwark's six plates. A wedge rather than an arc because the hull is a
 * hexagon — an arc would round the corners the faceting exists to show.
 */
export interface Wedge {
  readonly kind: 'wedge';
  readonly r: number;
  readonly points: number;
  readonly rotate: number;
  readonly index: number;
  readonly k?: number;
  readonly alpha?: number;
}

export type Part = Disc | Ring | Lens | Poly | Wedge;

export interface ContactShape {
  readonly parts: readonly Part[];
  /** The Mote alone. A comet that does not point along travel is meaningless. */
  readonly rotates: boolean;
  /**
   * Outer edge stroke, in the board's background colour, so plates read as
   * separate rather than as one faceted blob. Width is in R.
   *
   * Derived from `armor` by the caller, not stored here — a contact with
   * armour 2 gets a visibly thinner plate line than one with armour 5, which
   * is the seam carrying a number rather than a decoration.
   */
  readonly seam?: { readonly width: number; readonly alpha: number };
}

/** The Bulwark's plate line, from its armour. Clamped so it stays a line. */
const seamWidth = (armor: number): number =>
  Math.min(0.1, Math.max(0.03, 0.055 * (armor / 5)));

/**
 * Wedge lightness, clockwise from the apex.
 *
 * Fixes a single light source at the top: lit apex, two mid faces, a dark
 * bottom, and back up. This is what gives the Bulwark a machined read no other
 * contact has — and faceting survives scale where a 1px highlight does not.
 */
const BULWARK_WEDGES: readonly number[] = [1.13, 1.0, 0.78, 0.58, 0.78, 1.0];

function bulwark(armor: number): ContactShape {
  const wedges: Part[] = BULWARK_WEDGES.map((k, index) => ({
    kind: 'wedge',
    r: 1,
    points: 6,
    rotate: -90,
    index,
    k,
  }));

  return {
    rotates: false,
    seam: { width: seamWidth(armor), alpha: 0.55 },
    parts: [
      // The hull sits under the wedges as their darkest common ground, so a
      // seam between two plates reveals hull rather than background.
      { kind: 'poly', r: 1, points: 6, rotate: -90, k: 0.47 },
      ...wedges,
      { kind: 'disc', cx: 0, cy: 0, r: 0.2, k: 0.28 },
    ],
  };
}

/**
 * Three lobes, or however many this contact actually splits into.
 *
 * Lobe count is `splitInto.count`, so a Cluster that split into four would draw
 * four lobes with no other edit. The nuclei are what make the children
 * *countable* — which is the whole reason this contact needs a distinct
 * silhouette rather than a distinct interior: it has to be identifiable before
 * the killing shot, not after it.
 */
function cluster(lobes: number): ContactShape {
  const parts: Part[] = [];
  const step = 360 / lobes;

  for (let i = 0; i < lobes; i++) {
    const a = ((-90 + i * step) * Math.PI) / 180;
    const cx = Math.cos(a) * 0.44;
    const cy = Math.sin(a) * 0.44;
    parts.push({ kind: 'disc', cx, cy, r: 0.56, alpha: 0.55 });
  }
  for (let i = 0; i < lobes; i++) {
    const a = ((-90 + i * step) * Math.PI) / 180;
    const cx = Math.cos(a) * 0.44;
    const cy = Math.sin(a) * 0.44;
    parts.push({ kind: 'disc', cx, cy, r: 0.23, k: 1.22 });
  }

  return { rotates: false, parts };
}

/**
 * The six.
 *
 * Built per contact from its own def, so the two shapes that carry a number —
 * the Cluster's lobes and the Bulwark's seam — read it from content rather than
 * restating it.
 */
export function contactShape(id: EnemyId): ContactShape {
  const def = ENEMIES[id];

  switch (id) {
    case 'mote':
      return {
        rotates: true,
        parts: [
          // Tail first, so the nucleus sits on top of it. Capped at 1.45R by
          // the spec so the comet still fits the shared bake frame.
          { kind: 'lens', from: 0.35, to: -1.45, half: 0.3, alpha: 0.22 },
          { kind: 'disc', cx: -0.72, cy: 0, r: 0.16, alpha: 0.35 },
          { kind: 'disc', cx: -0.3, cy: 0, r: 0.23, alpha: 0.55 },
          { kind: 'disc', cx: 0.35, cy: 0, r: 0.52, alpha: 0.35 },
          { kind: 'disc', cx: 0.35, cy: 0, r: 0.3, k: 1.35 },
        ],
      };

    case 'monolith':
      return {
        rotates: false,
        parts: [
          // The only fully opaque body in the roster, because it is the only
          // contact that is nothing but hull. Strata and core sit *darker* than
          // the shell so it reads as dense rather than hollow — the inverse of
          // the Drifter's translucent mantle.
          { kind: 'disc', cx: 0, cy: 0, r: 1, k: 1 },
          { kind: 'ring', r: 0.68, width: 0.14, k: 0.62 },
          { kind: 'disc', cx: 0, cy: 0, r: 0.34, k: 0.62 },
        ],
      };

    case 'warden':
      return {
        rotates: false,
        parts: [
          { kind: 'disc', cx: 0, cy: 0, r: 1, alpha: 0.38 },
          // The overshield's shape, read as a layer inside the hull — but in
          // the contact's own tint, so it never competes with the blue band
          // that reports the shield's actual level.
          { kind: 'ring', r: 0.75, width: 0.13, k: 1 },
          { kind: 'disc', cx: 0, cy: 0, r: 0.43, k: 1 },
        ],
      };

    case 'cluster':
      return cluster(def.splitInto?.count ?? 3);

    case 'bulwark':
      return bulwark(def.armor);

    // Reuses Bulwark's plate machinery on its own armour value, so the silhouette
    // states the real number for the same reason Bulwark's does — and so the two
    // read as one family, which is the thing a player has to spot early.
    case 'ironclad':
      return bulwark(def.armor);

    case 'aegis':
      return {
        rotates: false,
        parts: [
          // Warden's layered read, one ring further out and thinner. More shield
          // showing, less body: this is the contact that is mostly its overshield.
          { kind: 'disc', cx: 0, cy: 0, r: 1, alpha: 0.3 },
          { kind: 'ring', r: 0.86, width: 0.1, k: 1 },
          { kind: 'ring', r: 0.62, width: 0.1, k: 0.85 },
          { kind: 'disc', cx: 0, cy: 0, r: 0.34, k: 1 },
        ],
      };

    case 'skimmer':
      return {
        rotates: true,
        // A Mote sharpened: shorter tail, tighter nucleus, no loose motes
        // trailing behind it. Same comet grammar so the family reads, but this
        // one is drawn as something committed to a direction — which is exactly
        // what makes it the contact a slow cannot bend.
        parts: [
          { kind: 'lens', from: 0.4, to: -1.15, half: 0.2, alpha: 0.24 },
          { kind: 'disc', cx: -0.2, cy: 0, r: 0.18, alpha: 0.5 },
          { kind: 'disc', cx: 0.4, cy: 0, r: 0.44, alpha: 0.32 },
          { kind: 'disc', cx: 0.4, cy: 0, r: 0.26, k: 1.35 },
        ],
      };

    case 'drifter':
    default:
      return {
        rotates: false,
        // Nothing derived, and that is the point — the Drifter is the shape
        // every other contact is a deviation from. It gets the plainest form
        // available so the others have something to be read against.
        parts: [
          { kind: 'disc', cx: 0, cy: 0, r: 1, alpha: 0.42 },
          { kind: 'disc', cx: 0, cy: 0, r: 0.5, k: 1 },
        ],
      };
  }
}

/**
 * Regular polygon as a flat coordinate list, first vertex at `rotate` degrees.
 *
 * Lives here rather than in either renderer because a `poly` and a `wedge` are
 * only meaningful if both agree where the vertices are — and the Bulwark's six
 * plates are wedges cut from the same hexagon its hull is drawn as. Two
 * implementations of "where is vertex 3" is a Bulwark whose seams miss its
 * corners.
 */
export function polygon(
  cx: number,
  cy: number,
  r: number,
  points: number,
  rotate: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const [x, y] = vertex(cx, cy, r, points, rotate, i);
    out.push(x, y);
  }
  return out;
}

/** One vertex, wrapped — so `index + 1` on the last one closes the ring. */
export function vertex(
  cx: number,
  cy: number,
  r: number,
  points: number,
  rotate: number,
  i: number,
): [number, number] {
  const a = ((rotate + (360 / points) * (i % points)) * Math.PI) / 180;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

/**
 * The box a shape actually occupies, in R, relative to the body centre.
 *
 * Not symmetric, and that is the point: the Mote spans −1.45 to +0.87 in x,
 * because its tail trails behind a nucleus that sits forward of centre. On the
 * board that asymmetry is correct — the sprite's origin is the contact's
 * position, and the tail belongs behind it. In a 26px chip the same shape hugs
 * the left edge and reads as a rendering fault, so the glyph centres this box
 * instead. Same geometry, different framing, and the difference is stated here
 * rather than discovered.
 */
export function contactBounds(shape: ContactShape): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  const span = (x0: number, x1: number, y0: number, y1: number): void => {
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0);
    maxY = Math.max(maxY, y1);
  };

  for (const p of shape.parts) {
    switch (p.kind) {
      case 'disc':
        span(p.cx - p.r, p.cx + p.r, p.cy - p.r, p.cy + p.r);
        break;
      case 'ring': {
        const e = p.r + p.width / 2;
        span(-e, e, -e, e);
        break;
      }
      case 'lens':
        span(Math.min(p.from, p.to), Math.max(p.from, p.to), -p.half, p.half);
        break;
      case 'poly':
      case 'wedge':
        // The circumradius, not the true bbox. Conservative on purpose: a
        // hexagon is shorter than it is wide, and the Bulwark's wedges all sit
        // inside a full polygon anyway, so tightening this would buy fractions
        // of a pixel in exchange for a second opinion about where a shape ends.
        span(-p.r, p.r, -p.r, p.r);
        break;
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * How far a shape reaches from its centre, in R.
 *
 * Radial rather than boxed, because what it answers is whether a shape fits the
 * *bake* frame — which is a square of `glowRatio × R` centred on the body, and
 * which every contact has to share for `worldView`'s scaling to land. The
 * Mote's tail is what makes this exceed 1.
 */
export function contactExtent(shape: ContactShape): number {
  let max = 0;
  for (const p of shape.parts) {
    switch (p.kind) {
      case 'disc':
        max = Math.max(max, Math.hypot(p.cx, p.cy) + p.r);
        break;
      case 'ring':
        max = Math.max(max, p.r + p.width / 2);
        break;
      case 'lens':
        max = Math.max(max, Math.abs(p.from), Math.abs(p.to));
        break;
      case 'poly':
      case 'wedge':
        max = Math.max(max, p.r);
        break;
    }
  }
  return max;
}
