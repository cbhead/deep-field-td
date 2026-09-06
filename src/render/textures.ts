import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { BALANCE } from '../content/balance.ts';
import { TOWER_IDS, type TowerId } from '../content/towers.ts';
import { TILE_PX } from './constants.ts';
import { strokeArc } from './draw.ts';
import { MARK_STROKE, STATION_MARKS } from './stationShape.ts';
import { ENEMY_IDS, type EnemyId } from '../content/enemies.ts';
import { contactShape, polygon, vertex, type Part } from './contactShape.ts';
import { BAKE_NEUTRAL, DEFAULT_FIELD, THEME, step } from './theme.ts';

/**
 * Every repeated visual is baked into a GPU texture once, then instanced as
 * cheap batched Sprites.
 *
 * A live Graphics object re-tessellates its geometry and breaks the sprite
 * batch; 390 of them for the board — let alone hundreds of creeps — is the
 * difference between one draw call and hundreds. This is also why "colored
 * shapes, no art" costs nothing architecturally: swapping in real sprites later
 * only changes what this file returns.
 */
export interface Textures {
  /**
   * Every board tile, from one neutral square.
   *
   * There used to be three of these — `ground`, `groundAlt` and `path` — which
   * differed only in fill colour and alpha. Once the grid moved out of the bake
   * and into the lattice, nothing was left to distinguish them, so the checker
   * and the route are now `Sprite.tint` and `Sprite.alpha` over a shared
   * texture. Tint and alpha are packed into the vertex stream in Pixi 8, so 390
   * differently-coloured tiles are still one draw call, and the route can now
   * ramp per tile for free — which is what `route.ts` spends.
   */
  tile: Texture;
  /**
   * A soft radial falloff: opaque at the centre, transparent at the rim.
   *
   * One shape serving four jobs — the board's lit wash, the cold haze at the
   * spawn end, and the halos under the pulsar and the spawn — because all four
   * are the same gradient at different sizes, positions and tints. Stretched
   * and tinted per use, which is why there is one texture rather than four.
   *
   * A `Sprite` rather than a `Graphics`, and that is the whole trick: sprites
   * sitting next to the tile field in z collapse into the tile field's batch,
   * where four Graphics would each cost their own draw call and split the tile
   * batch in two.
   */
  falloff: Texture;
  /**
   * One soft streak, tiled along each straight run of the route to make the
   * road read as a current rather than as a road.
   *
   * The **only** thing on the board layer that moves, and the only thing that
   * costs anything per frame — one `tilePosition` write per run. See
   * `buildStream`.
   */
  stream: Texture;
  /**
   * One bake per contact type, each in its **own final colours**.
   *
   * This replaced a neutral bake plus a per-type `tint`. The property that
   * mattered was never "one texture" or "tinted" — it was *not one per entity*,
   * and six textures for 250 contacts keeps that completely. Do not add a
   * seventh for a state: states are chrome, drawn by `creepChrome`.
   */
  contacts: Readonly<Record<EnemyId, Texture>>;
  /**
   * One bake per station per tier, indexed `[defId][tier - 1]`.
   *
   * It used to be one silhouette per tier, tinted per station — which made five
   * stations five colours of the same shape, and a roster nobody could learn at
   * a glance. Each now carries its own mechanic mark (see `stationShape.ts`).
   *
   * That is 15 textures rather than 3. The property this file exists to protect
   * was never "exactly one texture" but "not one per entity": the towers layer
   * can now produce up to five batches instead of one, still O(station types)
   * and never O(stations placed). The contact layer already made the same trade
   * for armour.
   *
   * `towers[id][0]` doubles as the build ghost, since placement is always Mk I —
   * and the ghost must therefore re-texture when the armed station changes.
   */
  towers: Readonly<Record<TowerId, readonly Texture[]>>;
  /** Tinted by the firing tower, so you can read which tower landed a shot. */
  projectile: Texture;
}

/** Radius the projectile texture is baked at, in tiles. */
export const PROJECTILE_RADIUS = 0.11;

/** Radius the creep *core* is baked at, in tiles. Sprites scale from this. */
export const CREEP_BAKE_RADIUS = 0.5;

/**
 * `resolution` defaults to the canvas so tiles stay crisp on retina — but a
 * soft gradient stretched over hundreds of pixels gains nothing from DPR, and
 * doubling it costs a megabyte of VRAM for an image nobody can tell apart. Pass
 * 1 for those.
 */
function bake(renderer: Renderer, draw: (g: Graphics) => void, resolution?: number): Texture {
  const g = new Graphics();
  draw(g);
  const texture = renderer.generateTexture({
    target: g,
    resolution: resolution ?? renderer.resolution,
    antialias: true,
  });
  g.destroy();
  return texture;
}

/** One streak's length and thickness in the bake; tiled at draw time. */
const STREAM_PX = 56;
const STREAM_H = 6;

/** Baked once and stretched, so its own pixel size only sets the smoothness. */
const FALLOFF_PX = 256;

/**
 * Enough steps that the largest jump lands below 8-bit quantisation, so the
 * gradient does not band. Fewer would show rings; more would cost bake time for
 * a difference nothing can display.
 */
const FALLOFF_RINGS = 48;

/**
 * Concentric discs, largest first — **with the alphas solved, not divided.**
 *
 * Discs composite `over`, not additively, so painting n of them at `T/n` does
 * not accumulate to `T`; each one covers what is already there. Given a target
 * coverage `T` at each radius, the alpha the ring must be drawn at is
 * `(Tᵢ − Tᵢ₋₁) / (1 − Tᵢ₋₁)`.
 *
 * This is deliberately not a `FillGradient`. That exists and does radial with
 * alpha stops, but it rasterises a Canvas2D surface and uploads it as an image,
 * which puts low-alpha ramps on the wrong side of Pixi's premultiply handling —
 * for no benefit over the bake-and-tint idiom the rest of this file already uses.
 */
function drawFalloff(g: Graphics): void {
  const c = FALLOFF_PX / 2;
  let covered = 0;

  for (let i = 1; i <= FALLOFF_RINGS; i++) {
    const u = 1 - i / FALLOFF_RINGS; // 1 at the rim, approaching 0 at the core
    const target = (1 - u) ** 2; // bright core, quick shoulder, long tail
    const alpha = (target - covered) / (1 - covered);
    covered = target;

    if (alpha > 0) g.circle(c, c, c * u).fill({ color: BAKE_NEUTRAL, alpha });
  }
}

/**
 * The nebula used to be baked here, per tile, and the reasoning that put it
 * there is worth keeping because it is still correct — it was the *conclusion*
 * that was wrong.
 *
 * Overlapping soft discs at low alpha is the right way to draw gas: the union
 * of them has no outline, and an outline is the difference between gas and a
 * rock. But `generateTexture` sizes from geometry bounds, so every disc had to
 * be *contained within its 40px tile* — and a disc inscribed in a square meets
 * each edge at exactly one point. Adjacent blocked tiles therefore left a dark
 * cross along their shared borders, tracing the grid perfectly. Four coins, not
 * one cloud. A flat coat was added to fight it and only turned the cross into a
 * seam.
 *
 * The containment was never a design choice; it was a constraint of baking. So
 * the cloud moved to `buildNebula` in `mapLayer.ts`, where it is drawn in board
 * space and its puffs are free to overhang tiles — which is the entire fix.
 * Scenery that traces the grid tells the player the board is made of squares at
 * the exact moment it should be telling them it is made of gas.
 */

/**
 * A pointy-top hexagon inscribed in the tile — the Deep Field station.
 *
 * Drawn as an outline over a translucent body rather than a solid fill, so the
 * starfield shows through the emplacement. That is also why the body is baked
 * as neutral-at-low-alpha instead of a dark colour: `tint` multiplies, so a
 * baked dark interior would go muddy under a light tint, whereas alpha lets the
 * board itself supply the interior.
 */
function hexGeometry(pad: number) {
  return {
    cx: TILE_PX / 2,
    top: pad,
    bottom: TILE_PX - pad,
    left: TILE_PX * 0.15,
    right: TILE_PX * 0.85,
    yUpper: TILE_PX * 0.275,
    yLower: TILE_PX * 0.725,
  };
}

/**
 * Pin the bake to exactly one tile.
 *
 * `generateTexture` sizes from geometry bounds, and the station is inset on
 * every side — so without this the hex bakes to 30x36 and, drawn at the tile's
 * top-left, sits 5px left and 2px high of centre. Worse for tiers: pips extend
 * the bounds downward, so each tier would crop differently and a station would
 * visibly *jump* when upgraded.
 *
 * A zero-alpha full-tile rect fixes the frame at 40x40 for every tier, which
 * makes the sprite's origin the tile's origin and keeps the silhouette put.
 */
function pinToTile(g: Graphics): void {
  g.rect(0, 0, TILE_PX, TILE_PX).fill({ color: BAKE_NEUTRAL, alpha: 0 });
}

/**
 * The station at a given tier.
 *
 * Tier reads two ways at once, because one alone is not enough at 40px: a row
 * of pips gives the exact count, and a core that grows and gains a halo gives
 * the at-a-glance impression. Both are drawn in `BAKE_NEUTRAL` so the station's
 * tint carries them — brightness comes from *radius and alpha*, never from
 * colour, because `tint` multiplies and would erase a baked colour shift.
 */
/**
 * The station's own mark, drawn inside the hull.
 *
 * Five stations used to bake to one silhouette distinguished only by tint,
 * which meant the roster was unlearnable at a glance and the deck had nothing
 * to match. See `stationShape.ts` for why this geometry is shared rather than
 * duplicated, and for the annulus it has to stay inside.
 */
function drawMark(g: Graphics, defId: TowerId): void {
  const mark = STATION_MARKS[defId];
  const w = MARK_STROKE * TILE_PX;
  const px = (v: number): number => v * TILE_PX;

  for (const line of mark.lines) {
    const [head, ...rest] = line;
    if (head === undefined) continue;
    g.moveTo(px(head.x), px(head.y));
    for (const p of rest) g.lineTo(px(p.x), px(p.y));
    g.stroke({ width: w, color: BAKE_NEUTRAL, alpha: 0.85, cap: 'round', join: 'round' });
  }

  for (const a of mark.arcs) {
    const from = (a.from * Math.PI) / 180;
    strokeArc(g, px(0.5), px(0.5), px(a.r), from, from + (a.span * Math.PI) / 180, {
      width: w,
      color: BAKE_NEUTRAL,
      alpha: 0.85,
    });
  }

  for (const d of mark.discs) {
    g.circle(px(d.cx), px(d.cy), px(d.r)).fill({ color: BAKE_NEUTRAL, alpha: 0.85 });
  }
}

/**
 * Every station at every tier: `TOWER_IDS.length * maxTier` bakes, done once.
 *
 * Built by loop rather than `Object.fromEntries` so the record is typed by
 * `TowerId` without a cast — which matters because adding a station should be a
 * compile error everywhere it needs art, not a silent `undefined` at the first
 * frame it is placed.
 */
function bakeTowers(renderer: Renderer): Readonly<Record<TowerId, readonly Texture[]>> {
  const out = {} as Record<TowerId, readonly Texture[]>;
  for (const id of TOWER_IDS) {
    out[id] = Array.from({ length: BALANCE.upgrade.maxTier }, (_, i) =>
      bake(renderer, (g) => {
        drawTower(g, id, i + 1);
      }),
    );
  }
  return out;
}

function drawTower(g: Graphics, defId: TowerId, tier: number): void {
  const s = THEME.shape;
  pinToTile(g);

  const cx = TILE_PX / 2;

  if (s.tower === 'roundRect') {
    const size = TILE_PX - s.towerPad * 2;
    g.roundRect(s.towerPad, s.towerPad, size, size, s.towerCorner)
      .fill({ color: BAKE_NEUTRAL, alpha: s.towerFillAlpha })
      .stroke({ width: s.strokeWidth, color: BAKE_NEUTRAL });
  } else {
    const { top, bottom, left, right, yUpper, yLower } = hexGeometry(s.towerPad);
    g.poly([cx, top, right, yUpper, right, yLower, cx, bottom, left, yLower, left, yUpper])
      .fill({ color: BAKE_NEUTRAL, alpha: s.towerFillAlpha })
      .stroke({ width: s.strokeWidth, color: BAKE_NEUTRAL });

    // Internal bracing — three chords through the centre. Cheap, and it is what
    // stops the hex reading as a flat plate at 40px.
    if (s.towerStrutAlpha > 0) {
      g.moveTo(cx, top)
        .lineTo(cx, bottom)
        .moveTo(left, yUpper)
        .lineTo(right, yLower)
        .moveTo(right, yUpper)
        .lineTo(left, yLower)
        .stroke({ width: 1, color: BAKE_NEUTRAL, alpha: s.towerStrutAlpha });
    }
  }

  // No hub. A filled core that grew with tier, over a halo that brightened with
  // it, was a third encoding of what the collar and the pips already carry — and
  // it sat exactly where a mark is most legible, so Singularity's spiral and
  // Overclock's junction were paying for it. Tier reads on the collar.

  drawMark(g, defId);
  drawTierPips(g, tier);
}

/**
 * A centred row of pips low on the station, one per tier.
 *
 * Placed at 0.795 of the tile so they sit inside the hex's lower taper — the
 * hex is ~17px wide there, which fits three pips at this spacing with margin.
 */
function drawTierPips(g: Graphics, tier: number): void {
  const s = THEME.shape;
  const r = TILE_PX * s.pipRadius;
  const gap = TILE_PX * s.pipSpacing;
  const y = TILE_PX * s.pipRowY;
  const x0 = TILE_PX / 2 - (gap * (tier - 1)) / 2;

  for (let i = 0; i < tier; i++) {
    g.circle(x0 + i * gap, y, r).fill(BAKE_NEUTRAL);
  }
}


/**
 * One contact, in its own final colours.
 *
 * **Silhouette is the channel that carries type, and that is a decision.** The
 * gravity slow already owns the ring and the overshield owns the band above the
 * health bar — `THEME.fx.shield` says why in as many words: two cool rings
 * around one contact is a puzzle, not a readout. Shape was the one axis no
 * contact used, every type until now being the same circle at a different tint
 * and scale, which is why six of them bunched at 4x read as one pink mass.
 *
 * **Contacts are no longer baked neutral and tinted**, and that reversal is
 * deliberate. Tinting bought one texture for the whole roster — genuinely worth
 * it while every contact was a disc or a hexagon. Six distinct silhouettes
 * already mean six bakes, so the tint now buys nothing, and paying for it costs
 * the Mote's near-white core and the Cluster's nuclei: a `tint` *multiplies*,
 * so no highlight can ever be brighter than its token.
 *
 * Every internal value is the type's token through `step()`, so the palette
 * still has one number per contact and a reskin is still one line.
 *
 * The zero-alpha halo circle stays and is load-bearing: `generateTexture`
 * measures geometry rather than visible pixels, so it is the only thing making
 * all six bake to the same square. Without it a hexagon, a comet and a trefoil
 * get three different bounding boxes, and `worldView`'s
 * `def.radius / CREEP_BAKE_RADIUS` scaling would put sprite centres off their
 * contacts.
 */
/** Six bakes, done once. Typed by `EnemyId` so a new contact is a compile error. */
function bakeContacts(renderer: Renderer): Readonly<Record<EnemyId, Texture>> {
  const out = {} as Record<EnemyId, Texture>;
  for (const id of ENEMY_IDS) {
    out[id] = bake(renderer, (g) => {
      drawContact(g, id);
    });
  }
  return out;
}

function drawContact(g: Graphics, id: EnemyId): void {
  const { shape } = THEME;
  const token = THEME.enemies[id];
  const spec = contactShape(id);

  // R is the *bake* radius, so the sprite scale worldView applies lands the
  // shape on the contact's real radius exactly.
  const R = CREEP_BAKE_RADIUS * TILE_PX;
  const outer = R * Math.max(1, shape.glowRatio);
  const cx = outer;
  const cy = outer;

  const halo = shape.glowAlpha > 0 && shape.glowRatio > 1;
  g.circle(cx, cy, outer).fill({
    color: halo ? step(token, 1) : BAKE_NEUTRAL,
    alpha: halo ? shape.glowAlpha : 0,
  });

  const paint = (p: Part): { color: number; alpha: number } => ({
    color: p.k === undefined ? token : step(token, p.k),
    alpha: p.alpha ?? 1,
  });

  for (const p of spec.parts) {
    switch (p.kind) {
      case 'disc':
        g.circle(cx + p.cx * R, cy + p.cy * R, p.r * R).fill(paint(p));
        break;

      case 'ring':
        g.circle(cx, cy, p.r * R).stroke({ width: p.width * R, ...paint(p) });
        break;

      case 'lens': {
        // Two quadratics meeting at the tips. A quadratic reaches half its
        // control height at the midpoint, so the control sits at 2x to make the
        // curve pass through `half`.
        const x0 = cx + p.from * R;
        const x1 = cx + p.to * R;
        const xm = (x0 + x1) / 2;
        const h = p.half * R * 2;
        g.moveTo(x0, cy)
          .quadraticCurveTo(xm, cy + h, x1, cy)
          .quadraticCurveTo(xm, cy - h, x0, cy)
          .fill(paint(p));
        break;
      }

      case 'poly':
        g.poly(polygon(cx, cy, p.r * R, p.points, p.rotate)).fill(paint(p));
        break;

      case 'wedge': {
        const [ax, ay] = vertex(cx, cy, p.r * R, p.points, p.rotate, p.index);
        const [bx, by] = vertex(cx, cy, p.r * R, p.points, p.rotate, p.index + 1);
        g.poly([cx, cy, ax, ay, bx, by]).fill(paint(p));
        break;
      }
    }
  }

  // The seam last, over the plates it separates, in the board's own background
  // so it reads as a gap rather than as a line drawn on top.
  if (spec.seam !== undefined) {
    const outline = spec.parts.find((p) => p.kind === 'poly');
    if (outline !== undefined && outline.kind === 'poly') {
      g.poly(polygon(cx, cy, outline.r * R, outline.points, outline.rotate)).stroke({
        width: spec.seam.width * R,
        color: THEME.fields[DEFAULT_FIELD].bg,
        alpha: spec.seam.alpha,
      });
    }
  }
}

/**
 * **Nothing baked here knows which sector it is for**, and that is the shape the
 * board rebuild arrived at rather than the one it set out for.
 *
 * The design asked for textures to "bake per field at level load". But once the
 * grid moved into the lattice and the nebula moved into board space, every
 * remaining bake was `BAKE_NEUTRAL` — the field's colours are all applied as
 * `tint` at draw time. So the requirement dissolved instead of being satisfied,
 * and a fourth sector now costs zero GPU memory rather than a fresh set of
 * textures.
 */
export function createTextures(renderer: Renderer): Textures {
  const { shape } = THEME;

  return {
    contacts: bakeContacts(renderer),


    towers: bakeTowers(renderer),

    projectile: bake(renderer, (g) => {
      const pr = PROJECTILE_RADIUS * TILE_PX;
      // A soft halo under a hard core: at this size a plain dot disappears
      // against the board, and the halo is what makes fire legible.
      g.circle(pr * 2, pr * 2, pr * shape.haloRatio).fill({
        color: BAKE_NEUTRAL,
        alpha: shape.haloAlpha,
      });
      g.circle(pr * 2, pr * 2, pr).fill(BAKE_NEUTRAL);
    }),

    tile: bake(renderer, (g) => {
      g.rect(0, 0, TILE_PX, TILE_PX).fill(BAKE_NEUTRAL);
    }),

    falloff: bake(renderer, drawFalloff, 1),

    stream: bake(renderer, (g) => {
      // A soft streak that fades to nothing at both ends, so tiling it end to
      // end gives a repeating current with no seam to find. `sin²` rather than
      // a linear ramp: linear leaves a visible crease where two copies meet.
      for (let x = 0; x < STREAM_PX; x++) {
        const a = Math.sin((x / STREAM_PX) * Math.PI) ** 2;
        if (a > 0.01) g.rect(x, 0, 1, STREAM_H).fill({ color: BAKE_NEUTRAL, alpha: a });
      }
    }, 1),

    // The base sits at `groundAlpha` like open ground rather than staying
    // opaque. An opaque base would punch a starless rectangle out of the sky,
    // and a rectangular hole in a starfield is a far louder tile artefact than
    // the two-values-of-255 seam it would fix. The cloud is what occludes the
    // stars here, and it does it gradually, which is what a cloud should do.
  };
}
