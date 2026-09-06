import type { EnemyId } from '../content/enemies.ts';
import type { SectorFieldId } from '../content/sectors.ts';
import type { TowerId } from '../content/towers.ts';

/**
 * Every colour in the game, in one file.
 *
 * This exists so that "apply a theme" is a one-file swap rather than a diff
 * across `constants.ts`, two content files and a stylesheet. Two consequences
 * are worth stating:
 *
 *  - **Colour lives in the renderer, not in content.** A tower's tint used to
 *    sit on `TowerDef` alongside its damage and cost. Harmless — no simulation
 *    code ever read it — but it put presentation inside the pure layer, and it
 *    meant a reskin touched files the sim imports. Balance and looks now have
 *    no file in common.
 *  - **One representation.** Colours are numbers, because that is what Pixi
 *    takes; the HUD's CSS custom properties are generated from those same
 *    numbers by `applyHudTheme`. The background used to be written twice, as
 *    `0x0f172a` here and `#0f172a` in the stylesheet. Now it cannot drift.
 */
/**
 * The ground one sector is played on: everything under the stations.
 *
 * Only the *field* varies between sectors. The contrast budget has to be
 * re-verified per field rather than once in total, because a lighter ground
 * eats headroom that the route and the pulsar were spending — and **no field
 * may be warm at any value**, since warm is what tells a player something is
 * a contact.
 */
export interface SectorField {
  readonly id: SectorFieldId;
  readonly bg: number;
  readonly ground: number;
  readonly groundAlt: number;
  readonly gridLine: number;
  /**
   * Grid stroke strength before `gridMaskAt` fades it toward the edges.
   *
   * Higher than the 0.6 the stroke was baked at, because it used to be drawn
   * *per tile*: two neighbouring tiles each stroked their own inset border, so
   * a shared edge carried two adjacent 1px lines. The lattice draws one line
   * per edge, and this is what buys back the weight that lost.
   */
  readonly gridAlpha: number;
  /** The nebula's mass, and the denser knots in it. */
  readonly blocked: number;
  readonly blockedEdge: number;
  /**
   * How opaque a blocked tile's own plate is.
   *
   * Sits a little under `groundAlpha`, so a clump reads as *denser* than open
   * ground rather than as a hole punched in it. The cloud is drawn on top, so
   * this no longer has to be nearly transparent to let its own nebula through —
   * see `buildNebula` for why that ordering changed.
   */
  readonly blockedAlpha: number;
  /**
   * Per-puff alpha, and how many puffs each blocked tile contributes.
   *
   * Density is per *field*, which is most of what separates the three sectors:
   * Cascade's board should feel emptier, Pincer's should feel pressed in on.
   */
  readonly nebulaAlpha: number;
  readonly nebulaPerTile: number;
  /**
   * The route, at the spawn end and at the pulsar end.
   *
   * A flat corridor says where contacts walk and nothing else — not which way
   * they travel, not how close to the core they are. The most information-dense
   * object on the board was carrying one bit. Interpolating the fill along
   * route distance makes direction readable from a still frame, which is one of
   * the design's acceptance tests.
   *
   * Both must stay legible in **greyscale**: the route reads lighter than the
   * field by value, never by hue alone.
   */
  readonly path: number;
  readonly pathLit: number;
  /**
   * `null` means the path tile gets no edge stroke, so the route reads as one
   * continuous road rather than 43 separate tiles. That is a deliberate look
   * and this is where a field opts out of it.
   */
  readonly pathEdge: number | null;

  /**
   * The road lighting the ground beside it, and the hot line down its middle.
   *
   * Both ramp from the spawn end to the pulsar end, so every cue on the board
   * points the same way. The spill is composited into the neighbouring tile's
   * own tint rather than drawn as extra sprites — it is free.
   *
   * The line is the brightest thing the board layer draws, which is deliberate
   * and also the risk: it must never out-glow a station. Stations cannot be
   * built on route tiles so the two never share a pixel, but if it starts
   * pulling the eye, cap the far end rather than dimming the whole run.
   */
  readonly spillNear: number;
  readonly spillNearAlpha: number;
  readonly spillFar: number;
  readonly spillFarAlpha: number;
  readonly lineNear: number;
  readonly lineNearAlpha: number;
  readonly lineFar: number;
  readonly lineFarAlpha: number;
  readonly spawn: number;
  readonly goal: number;

  /**
   * The board lit from the pulsar, and the cold haze at the spawn end.
   *
   * 390 identical tiles under a uniform grid read as graph paper: nothing says
   * where the board's centre of gravity is, so every corner looks equally
   * important including the ones no route passes through. Two washes give the
   * board a direction — warm-lit at the thing you are defending, cold at the
   * thing it arrives from — without adding a single per-frame instruction.
   */
  readonly lit: number;
  readonly litAlpha: number;
  readonly haze: number;
  readonly hazeAlpha: number;

  /**
   * The bloom under the pulsar, drawn *below* the tile field.
   *
   * Below, because a halo over the board would dim tiles the player has to
   * build on — and the objective quietly eating placement legibility is a worse
   * trade than a fainter glow. Open ground transmits `1 - groundAlpha`, so this
   * is set high to survive that; the route is opaque and hides it entirely,
   * which is correct. The rings and the core sit above and carry the weight.
   *
   * Named `bloom` rather than `halo` because `shape.haloAlpha` already means
   * the ring baked around a projectile. Two `haloAlpha`s in one theme is a
   * mistake waiting for whoever reads the second one first.
   */
  readonly bloomAlpha: number;

  /**
   * Starfield. Most stars are `star`; a scattered few are `starBright`.
   *
   * Count and rarity are per field because they are most of what separates one
   * sector from another once the hue has been chosen: Cascade runs fewer stars
   * at a higher bright-chance, so its open board reads as emptier *and* harder.
   *
   * `starFarAlpha` scales a second, dimmer pass drawn into the same Graphics —
   * depth for free, since two passes of one node still cost one draw call and
   * nothing per frame. The sky stays static: motion in the background means "a
   * contact", and that is the one thing it may never say.
   */
  readonly star: number;
  readonly starBright: number;
  readonly starCount: number;
  readonly starBrightChance: number;
  readonly starFarAlpha: number;
  /**
   * Ground tiles draw at this alpha so the starfield shows through open
   * space. The route stays fully opaque, which is what makes it read as a
   * structure laid over the void rather than another shade of tile.
   */
  readonly groundAlpha: number;
}

export interface Theme {
  readonly id: string;
  readonly name: string;

  /**
   * One ground per sector, keyed by `LevelDef.field`. Static, built once at
   * level load.
   *
   * Keyed rather than singular because three boards that look identical make a
   * campaign feel like one board with the label changed — travel is the thing
   * the sector fields buy. What must *not* vary is the foreground: the same
   * Lance is the same blue and the same Drifter the same pink on every board,
   * which is why `towers` and `enemies` below sit outside this record.
   */
  readonly fields: Readonly<Record<SectorFieldId, SectorField>>;

  /**
   * Per-type tints. Textures are baked neutral (see `BAKE_NEUTRAL`) and tinted
   * on the GPU, which is free and keeps every creep on one draw call.
   */
  readonly towers: Readonly<Record<TowerId, number>>;
  readonly enemies: Readonly<Record<EnemyId, number>>;

  readonly feedback: {
    /**
     * Rejected placement. There is deliberately no `valid` counterpart: a legal
     * ghost is drawn in the tint of the tower being placed, which says *which*
     * tower as well as *yes*.
     */
    readonly invalid: number;
    /** Ring around the tower the inspector is showing. */
    readonly selected: number;
    readonly rangeFillAlpha: number;
    readonly rangeStrokeAlpha: number;
    readonly tileOutlineAlpha: number;
  };

  /** Transient combat feedback, drawn by `effects.ts` and `worldView.ts`. */
  readonly fx: {
    /** A struck contact's tint is lerped toward this. Applied in `worldView`. */
    readonly hitFlash: number;
    /** Floating damage numbers, when no firing tower colour applies. */
    readonly damageText: number;
    readonly hpFull: number;
    readonly hpLow: number;
    readonly hpTrack: number;
    /** The goal flare and screen-edge rim when a creep gets through. */
    readonly leak: number;
    readonly leakBright: number;
    /** Ring drawn around a contact held in a gravity well. */
    readonly slowRing: number;
    /**
     * Outline behind in-world text.
     *
     * Canvas text sits over both the near-black field and the brightest thing
     * on screen — a contact taking a hit. A fill alone is legible on one or the
     * other, never both, so every in-world label carries this behind it.
     */
    readonly textOutline: number;
    /**
     * Overshield, drawn as a band above the hull bar.
     *
     * Deliberately *not* a ring: the gravity slow already owns that shape, and
     * two cool rings around one contact would be a puzzle rather than a
     * readout. A band over the bar says "there is a layer before the hull"
     * with no ambiguity, and reads at a glance in a crowd.
     */
    readonly shield: number;
  };

  /**
   * Bake parameters, in px unless noted. Changing these changes what
   * `createTextures` draws, so they only take effect at load.
   */
  readonly shape: {
    /** Tower silhouette. `hex` is the Deep Field station; `roundRect` was v1. */
    readonly tower: 'hex' | 'roundRect';
    readonly towerPad: number;
    readonly towerCorner: number;
    readonly towerFillAlpha: number;
    /** Internal bracing lines on the hex station. 0 disables them. */
    readonly towerStrutAlpha: number;
    readonly strokeWidth: number;
    readonly outline: number;
    readonly outlineAlpha: number;
    /** Soft ring baked around a creep. Radius multiple, then alpha. 0 = off. */
    readonly glowRatio: number;
    readonly glowAlpha: number;
    /** Projectile halo: radius multiple of the core, then alpha. */
    readonly haloRatio: number;
    readonly haloAlpha: number;

    /**
     * The plated contact silhouette — see `drawCreep` for why armour is drawn
     * as a shape and not as another ring. A heavier rim than the plain hull's
     * 2px is most of what sells it; the seam sits at this fraction of the rim.
     */
    readonly plateWidth: number;
    readonly plateSeam: number;

    /**
     * Tier marks baked into the station, as fractions of the tile.
     *
     * A row of pips low on the hex, one per tier, baked in `BAKE_NEUTRAL` so
     * they take the station's own tint like everything else — a higher tier must
     * read as a *stronger* station, never as a different one.
     *
     * The pips are now the whole of it. A growing core and its halo used to say
     * the same thing a second and third time, from the middle of the hex, where
     * they covered the one part of a mark that identifies the station.
     */
    readonly pipRadius: number;
    readonly pipRowY: number;
    readonly pipSpacing: number;
  };

  /** Screen-anchored chrome. Emitted as CSS custom properties at boot. */
  readonly hud: {
    readonly bg: number;
    readonly panel: number;
    readonly panelEdge: number;
    readonly slot: number;
    readonly text: number;
    /** Slightly dimmer than `text`, for values that aren't the headline. */
    readonly bright: number;
    readonly muted: number;
    /** Dimmest legible tier — hints, disabled labels. */
    readonly dim: number;
    readonly danger: number;
    readonly dangerBright: number;
    readonly accent: number;
    readonly accentSoft: number;
    readonly accentBright: number;
  };
}

/**
 * Textures are baked in this colour so `tint` can recolour them per entity.
 * Not a theme choice — a theme that changed it would break tinting entirely.
 */
export const BAKE_NEUTRAL = 0xffffff;

/**
 * How much of the way to white a highlight travels, per unit of `k` above 1.
 *
 * **Not a taste value — it reconciles two scales the design document mixes.**
 * Its shade multipliers behave like a plain channel multiply (measured Δ 3–13
 * against its own specimens), but its highlight multipliers do not: the quoted
 * highlights are *desaturated toward white*, which multiplying cannot produce
 * once a channel clips. `cluster ×1.22` is specified as `#ffc9c2`; a multiply
 * gives `#ff584d`, off by 117.
 *
 * So highlights mix toward white instead, and this constant is fixed by the
 * document's own arithmetic: it is the value that lands `mote ×1.35` on the
 * specified `#fff1ec` to within 1/255. It takes total highlight error from 141
 * to 47. `cluster ×1.22` remains the outlier at Δ 36 — recorded rather than
 * tuned away, because bending this to chase one specimen would break the other
 * two.
 */
const HIGHLIGHT_GAIN = 2.3;

/**
 * A contact's token at a lightness multiple: shade below 1, tint above it.
 *
 * Shared by the bake and by `contactIcon`, for the same reason the geometry is:
 * two copies of a ramp are two ramps that drift, and the failure is a legend
 * quietly disagreeing with the board.
 *
 * Two-sided because one operation cannot do both jobs. Multiplying darkens
 * correctly but cannot lighten a saturated colour — `#f4483f × 1.22` just clips
 * red and stays vivid. Mixing toward white lightens correctly but cannot
 * darken. So: multiply down, mix up.
 */
export function step(token: number, k: number): number {
  const ch = (shift: number): number => {
    const c = (token >> shift) & 255;
    const v = k <= 1 ? c * k : c + (255 - c) * (k - 1) * HIGHLIGHT_GAIN;
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Switchback — the shipped baseline, and the shape every other field is a
 * variation on.
 *
 * Cascade and Pincer currently clone it. They are separate entries rather than
 * aliases because the point of the record is that they *will* diverge, and a
 * spread here would quietly hide which keys a sector had actually chosen.
 */
const SWITCHBACK: SectorField = {
  id: 'switchback',
  bg: 0x07080f,
  // The checker has to survive `groundAlpha` compositing it back toward `bg`.
  // These were 2-4/255 apart, which after the alpha was ~1.5 — invisible, and
  // leaving the grid stroke to do the whole job of making tiles placeable.
  // Widened until the checker actually reads without competing with a star.
  ground: 0x0f1222,
  groundAlt: 0x0b0d19,
  gridLine: 0x1a1d33,
  gridAlpha: 0.85,
  blocked: 0x1e2030,
  blockedEdge: 0x2f3245,
  blockedAlpha: 0.72,
  nebulaAlpha: 0.14,
  nebulaPerTile: 4,
  // The route reads *lighter* than the field it crosses, so the path is
  // legible in greyscale rather than relying on hue.
  path: 0x1b1f36,
  pathLit: 0x2c3260,
  pathEdge: null,
  spillNear: 0x9184d9,
  spillNearAlpha: 0.1,
  spillFar: 0xd2cefd,
  spillFarAlpha: 0.44,
  lineNear: 0xd2cefd,
  lineNearAlpha: 0.2,
  lineFar: 0xf0eeff,
  lineFarAlpha: 0.62,
  spawn: 0xf9a8d4,
  goal: 0xb5abfc,
  lit: 0xb5abfc,
  // The design authored 0.17 with the light source at 84%/72% — inside its own
  // mock. Anchoring to the *real* pulsar puts it at the board's right edge on
  // Switchback, so half the gradient falls off-board and the on-board half does
  // less work. Raised to compensate, not to make the board brighter.
  litAlpha: 0.22,
  haze: 0x4f4678,
  hazeAlpha: 0.32,
  bloomAlpha: 0.45,
  star: 0x6f7699,
  starBright: 0xd7dcf0,
  starCount: 300,
  starBrightChance: 0.12,
  starFarAlpha: 0.45,
  groundAlpha: 0.72,
};

/**
 * Steel-cyan, thin nebula, harder stars — the open board should feel emptier.
 *
 * Fewer stars at a higher bright-chance is the whole trick: the same sky with
 * more space in it and sharper points where it is not empty.
 */
const CASCADE: SectorField = {
  ...SWITCHBACK,
  id: 'cascade',
  bg: 0x05090e,
  ground: 0x0d1520,
  groundAlt: 0x090f18,
  gridLine: 0x182a36,
  gridAlpha: 0.9,
  blocked: 0x1a2430,
  blockedEdge: 0x243444,
  nebulaPerTile: 2,
  path: 0x16222f,
  pathLit: 0x22384d,
  spillNear: 0x60a5be,
  spillFar: 0xc4f2fc,
  lineNear: 0xc4f2fc,
  lineFar: 0xe6fbff,
  spawn: 0xf9a8d4,
  goal: 0xa5eefb,
  lit: 0xa5eefb,
  litAlpha: 0.2,
  haze: 0x264454,
  star: 0x6d8b99,
  starBright: 0xd4ecf5,
  starCount: 210,
  starBrightChance: 0.2,
};

/** Cold teal-black, densest nebula pressing in on both lanes. */
const PINCER: SectorField = {
  ...SWITCHBACK,
  id: 'pincer',
  bg: 0x05090a,
  ground: 0x0a1512,
  groundAlt: 0x070f0d,
  gridLine: 0x1a302a,
  gridAlpha: 0.95,
  blocked: 0x16241f,
  blockedEdge: 0x1f3730,
  nebulaPerTile: 6,
  nebulaAlpha: 0.16,
  path: 0x122120,
  pathLit: 0x1d3a35,
  spillNear: 0x6eb496,
  spillFar: 0xcefae2,
  lineNear: 0xcefae2,
  lineFar: 0xeafff4,
  spawn: 0xf9a8d4,
  goal: 0x86e39b,
  lit: 0x86e39b,
  litAlpha: 0.17,
  haze: 0x1e3a32,
  hazeAlpha: 0.42,
  star: 0x6b8f80,
  starBright: 0xd2efe0,
};

/**
 * The five multi-lane sectors, each a value step off the nearest of the three
 * above rather than a palette invented from nothing.
 *
 * Paired by what the board *does*, not by where it sits in the order: Fork and
 * Crown are ring boards and take Switchback's violet; Delta and Sluice are open
 * boards and take Cascade's steel-cyan; Braid is the tight one and takes
 * Pincer's teal. Within a pair the later board is the deeper step, so the run
 * of eight reads as three families getting darker rather than as eight
 * unrelated skies.
 *
 * No new hues, which is the rule the map spec sets for lanes and the contact
 * spec set before it. Every one of these is checked by the contrast-order gate,
 * so a step that inverted the structural layers would not survive `npm run
 * check` — which is the only reason deriving them by hand is safe.
 */

/** Switchback one step deeper, for the first board that splits. */
const FORK: SectorField = {
  ...SWITCHBACK,
  id: 'fork',
  bg: 0x080a13,
  ground: 0x11142a,
  groundAlt: 0x0c0f20,
  gridLine: 0x1f2340,
  blocked: 0x22243a,
  blockedEdge: 0x353950,
  nebulaPerTile: 5,
  path: 0x1f2440,
  pathLit: 0x343b6e,
  spillNear: 0x9c8fe4,
  spillFar: 0xdcd8ff,
  lineNear: 0xdcd8ff,
  lineFar: 0xf3f1ff,
  goal: 0xc0b6ff,
  lit: 0xc0b6ff,
  haze: 0x584e85,
  star: 0x757ca4,
  starCount: 270,
};

/** Cascade opened up further still — the board with room to spare. */
const DELTA: SectorField = {
  ...CASCADE,
  id: 'delta',
  bg: 0x060b11,
  ground: 0x0f1826,
  groundAlt: 0x0a121c,
  gridLine: 0x1d3140,
  blocked: 0x1e2a38,
  blockedEdge: 0x293c4e,
  nebulaPerTile: 3,
  path: 0x1a2836,
  pathLit: 0x284158,
  goal: 0xb4f2fc,
  lit: 0xb4f2fc,
  haze: 0x2b4d5f,
  starCount: 230,
};

/** Pincer's teal pressed tighter, for the board where the lanes interleave. */
const BRAID: SectorField = {
  ...PINCER,
  id: 'braid',
  bg: 0x040a0b,
  ground: 0x0b1817,
  groundAlt: 0x08110f,
  gridLine: 0x1d3630,
  blocked: 0x18282a,
  blockedEdge: 0x224039,
  nebulaPerTile: 7,
  path: 0x142626,
  pathLit: 0x21433e,
  goal: 0x92ecac,
  lit: 0x92ecac,
  haze: 0x224238,
  starCount: 260,
};

/** The darkest of the cyan family: two lanes, and one of them barely a corridor. */
const SLUICE: SectorField = {
  ...CASCADE,
  id: 'sluice',
  bg: 0x04070c,
  ground: 0x0b1119,
  groundAlt: 0x080c13,
  gridLine: 0x16242f,
  blocked: 0x172029,
  blockedEdge: 0x212f3c,
  nebulaPerTile: 3,
  path: 0x131d28,
  pathLit: 0x1e3244,
  goal: 0x8fd8ec,
  lit: 0x8fd8ec,
  haze: 0x203c4c,
  starCount: 190,
  starBrightChance: 0.24,
};

/** The finale: the deepest field and the brightest core in the campaign. */
const CROWN: SectorField = {
  ...SWITCHBACK,
  id: 'crown',
  bg: 0x06060f,
  ground: 0x101024,
  groundAlt: 0x0b0b1a,
  gridLine: 0x20204a,
  blocked: 0x232338,
  blockedEdge: 0x38385a,
  nebulaPerTile: 5,
  path: 0x1d1d42,
  pathLit: 0x333376,
  spillNear: 0xa08fe8,
  spillFar: 0xe2dcff,
  lineNear: 0xe2dcff,
  lineFar: 0xf6f3ff,
  goal: 0xcabcff,
  lit: 0xcabcff,
  litAlpha: 0.24,
  haze: 0x5a4d90,
  star: 0x7a7aa8,
  starBright: 0xe0e0f8,
  starCount: 330,
};

/**
 * Front Line, the versus board: Pincer's teal opened back up.
 *
 * Derived rather than authored, under the same no-new-hues rule as the five
 * campaign steps above, and paired by what the board *does* — Front Line is a
 * two-lane board with a tight waist, which is Pincer's family. It steps
 * *brighter* rather than deeper, which none of the campaign fields do: the
 * campaign is a descent into the dark and this is not part of it, so reading
 * fractionally more open is the difference doing useful work.
 *
 * The core is warmer than any campaign goal on purpose. It is the one thing on
 * this board that belongs to the player rather than to the sector, and in a
 * mode where losing it is the entire loss condition it should not read as
 * scenery.
 */
const FRONTLINE: SectorField = {
  ...PINCER,
  id: 'frontline',
  bg: 0x060b0c,
  ground: 0x0c1a16,
  groundAlt: 0x081210,
  gridLine: 0x1f3a32,
  blocked: 0x1a2b25,
  blockedEdge: 0x264238,
  nebulaPerTile: 4,
  path: 0x152826,
  pathLit: 0x22463f,
  goal: 0xffc98a,
  lit: 0xffc98a,
  litAlpha: 0.19,
  haze: 0x24463c,
  starCount: 240,
};

export const SECTOR_FIELDS: Readonly<Record<SectorFieldId, SectorField>> = {
  switchback: SWITCHBACK,
  cascade: CASCADE,
  pincer: PINCER,
  fork: FORK,
  delta: DELTA,
  braid: BRAID,
  sluice: SLUICE,
  crown: CROWN,
  frontline: FRONTLINE,
};

/** What Race mode and any unknown level get. Race passes no level at all. */
export const DEFAULT_FIELD: SectorFieldId = 'switchback';

/**
 * Resolve a level's field id, tolerating absence.
 *
 * Race mode plays the baseline board without going through `CAMPAIGN`, so the
 * id genuinely can be missing — and an unrecognised one should degrade to a
 * playable board rather than to a black screen.
 */
export const fieldFor = (id: SectorFieldId | undefined): SectorField =>
  SECTOR_FIELDS[id ?? DEFAULT_FIELD];

/**
 * Deep Field — the direction that came back from the design session.
 *
 * The board is a starfield, stations are hexagonal emplacements, and the
 * contacts are the only warm thing on screen. That last part is the contrast
 * hierarchy doing its job: everything structural sits in the blue-black end of
 * the range, so a pink creep is the brightest object in any frame it occupies.
 */
export const DEEP_FIELD: Theme = {
  id: 'deep-field',
  name: 'Deep Field',

  fields: SECTOR_FIELDS,

  towers: {
    lance: 0x8fc4fa,
    nova: 0xfcc08a,
    singularity: 0xa5eefb,
    // Green and violet, because the three above are all blue-to-orange and a
    // fourth blue would be unreadable in a crowd — the damage numbers are tinted
    // by station, so these have to separate at a glance and at 13px.
    arc: 0x86e39b,
    filament: 0xc4a6ff,
    // Chartreuse, and picked by measurement rather than by eye — the first
    // guess was a warm yellow chosen to sit far from Singularity's pale cyan,
    // on the theory that the two support stations are the pair most likely to
    // be confused. It cleared Singularity comfortably and collided with *Nova*
    // instead, at a separation of 64.6 against a roster whose previous worst
    // pair was 91.2. It was the least legible tint in the game.
    //
    // The roster occupies five hues — Nova 28°, Arc 134°, Singularity 189°,
    // Lance 210°, Filament 260° — and the two real gaps are 128° from Filament
    // round to Nova, and 105° from Nova to Arc. The first is magenta, which is
    // spoken for: contacts are the only warm-pink thing on the board and the
    // whole contrast hierarchy rests on that. So this sits at the midpoint of
    // the second, 53° clear of both neighbours, at 121.0 separation — no longer
    // the tightest pair in the roster.
    overclock: 0xb4c868,
  },

  // Contacts share one warm family so "something is coming" reads before "what
  // is coming" does — they are the only warm thing on a blue-black board, and
  // that is the contrast hierarchy's whole job. Type is carried by variation
  // *within* the family, plus the size differences the defs already give them.
  /**
   * One token per contact — the **class hue**, and the only value a reskin
   * touches. Every internal value of every silhouette is this colour through
   * `step()`, so there is no second table of hexes to fall out of sync.
   */
  enemies: {
    /** Baseline. Unchanged, because everything else is read against it. */
    drifter: 0xf472b6,
    /**
     * Swarm. Coral rather than the old pale pink, and deliberately the light
     * end of the Cluster's red — Clusters are what *produce* Motes, and this is
     * the only causal relationship between two contact types the game shows.
     */
    mote: 0xffb0a3,
    /** Mass. Deep wine, to sit with its bulk. */
    monolith: 0x9e2f58,
    /** Protected. Washed, so the blue shield band reads against it. */
    warden: 0xd59ac0,
    /** Punishes you: the one whose death makes things worse. */
    cluster: 0xf4483f,
    /**
     * Protected, and the only non-round contact. Desaturated toward steel — it
     * reads as *plated* rather than as flesh, which is the one thing a player
     * needs to spot early enough to stop pouring chip damage into it.
     */
    bulwark: 0xc9a6ae,
  },

  feedback: {
    invalid: 0xe06d6d,
    selected: 0xb5abfc,
    rangeFillAlpha: 0.05,
    rangeStrokeAlpha: 0.35,
    tileOutlineAlpha: 0.9,
  },

  fx: {
    hitFlash: 0xffffff,
    damageText: 0xcfe4ff,
    hpFull: 0xf472b6,
    hpLow: 0xe06d6d,
    hpTrack: 0x0b0c16,
    leak: 0xe06d6d,
    leakBright: 0xffb4b4,
    slowRing: 0xa5eefb,
    shield: 0x9fbcff,
    textOutline: 0x05060d,
  },

  shape: {
    tower: 'hex',
    towerPad: 3,
    towerCorner: 7,
    towerFillAlpha: 0.2,
    towerStrutAlpha: 0.3,
    strokeWidth: 2.2,
    outline: 0x000000,
    outlineAlpha: 0.35,
    glowRatio: 1.75,
    glowAlpha: 0.22,
    haloRatio: 1.9,
    haloAlpha: 0.22,
    plateWidth: 3.2,
    plateSeam: 0.62,
    pipRadius: 0.045,
    pipRowY: 0.795,
    pipSpacing: 0.15,
  },

  hud: {
    bg: 0x090a14,
    panel: 0x141624,
    panelEdge: 0x2a2d40,
    slot: 0x232532,
    text: 0xe9e9ed,
    bright: 0xcfd3e5,
    muted: 0x9397ab,
    dim: 0x75798c,
    danger: 0xe06d6d,
    dangerBright: 0xffb4b4,
    accent: 0x9184d9,
    accentSoft: 0xb5abfc,
    accentBright: 0xd2cefd,
  },
};

/** The active theme. One binding, so swapping themes is a one-line change. */
export const THEME: Theme = DEEP_FIELD;

/** `0x60a5fa` → `"#60a5fa"`, for the DOM half of the HUD. */
export function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** `(0x60a5fa, 0.4)` → `"rgba(96,165,250,0.4)"`, for glows and washes. */
export function rgba(color: number, alpha: number): string {
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${alpha})`;
}

/**
 * Push the HUD palette into CSS custom properties.
 *
 * Call this before first paint — `styles.css` declares no colour of its own, so
 * until this runs every `var(--panel)` is unresolved. `color-scheme: dark` in
 * the stylesheet covers the gap so the flash is dark rather than white.
 */
export function applyHudTheme(theme: Theme = THEME): void {
  const { style } = document.documentElement;
  for (const [key, value] of Object.entries(theme.hud)) {
    // panelEdge → --panel-edge
    style.setProperty(`--${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`, css(value));
  }

  const ids = Object.keys(theme.towers);
  for (const id of ids) {
    style.setProperty(`--tower-${id}`, css(theme.towers[id as keyof typeof theme.towers]));
  }

  // There is deliberately no `--contact-<id>` counterpart.
  //
  // There was, until a contact stopped being one colour. A Bulwark is a hull,
  // six wedges at six lightnesses and a core, and a Mote's nucleus is *brighter*
  // than its token — none of which a single CSS custom property can express. So
  // `contactIcon` resolves its own values through `step()`, the same function
  // the bake calls, and carries the token as an inline `color` for the glow to
  // pick up. One source, and the deck cannot drift from the board by construction.
  style.setProperty('--shield', css(theme.fx.shield));

  /**
   * The `.t-<id>` rules are generated here rather than written in `styles.css`,
   * and that is the point.
   *
   * The variables above were already derived from the roster, but the rules that
   * *consume* them were three hand-written lines — so adding Arc and Filament
   * produced two perfectly good custom properties that nothing referenced, and
   * both stations rendered in the deck's default grey. Nothing caught it:
   * TypeScript does not read CSS, and the stylesheet is not wrong, merely
   * incomplete. `towers.ts` even warns about exactly this class of drift.
   *
   * Deriving both ends from the same loop makes a new station one content edit
   * again, which is what it was supposed to be.
   */
  const RULES_ID = 'tower-tints';
  let sheet = document.getElementById(RULES_ID);
  if (sheet === null) {
    sheet = document.createElement('style');
    sheet.id = RULES_ID;
    // Appended to head, so it lands after the linked stylesheet and wins ties
    // at equal specificity.
    document.head.appendChild(sheet);
  }
  sheet.textContent = ids.map((id) => `.t-${id}{color:var(--tower-${id})}`).join('');
}
