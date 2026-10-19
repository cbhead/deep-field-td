import { Container, Graphics, Sprite, Text, TilingSprite } from 'pixi.js';
import type { MapDef, Vec2 } from '../sim/types.ts';
import { mulberry32 } from '../sim/util/rng.ts';
import { TILE_PX, gridMaskAt } from './constants.ts';
import { OFF_ROUTE, SPILL_FALLOFF, SPILL_RINGS, routeDistance, routeSpill } from './route.ts';
import { THEME, type SectorField } from './theme.ts';
import type { Textures } from './textures.ts';

/**
 * The board. Built once and never touched again — nothing on this layer moves,
 * so it costs a few static batched draw calls per frame and no per-frame work
 * at all.
 *
 * That last property is why the starfield does not twinkle. Animating it was
 * considered and dropped: it would convert the one layer in the renderer with
 * zero running cost into a per-frame one, and it would put motion in the
 * background of a game where motion is how you spot a contact.
 */
/**
 * The board, plus the one thing on it that moves.
 *
 * `step` exists only for the stream. Everything else here is built once and
 * never touched again — which was true of the *whole* layer until the design
 * asked for a current, and is the reason that ask needed arguing rather than
 * assuming. It is a handful of `tilePosition` writes per frame and no
 * tessellation, which is the cheap way to do it; the expensive way is a shader
 * or a per-tile animation, and writing the cheap one down is most of what stops
 * someone reaching for those.
 */
export interface MapLayer {
  readonly view: Container;
  step(dt: number): void;
}

export function buildMapLayer(map: MapDef, tex: Textures, field: SectorField): MapLayer {
  const layer = new Container();

  // Beneath the tiles, which are baked translucent so it shows through.
  layer.addChild(buildStarfield(map.cols * TILE_PX, map.rows * TILE_PX, field));

  // Below the tiles, so a bloom can never dim ground the player has to build on.
  layer.addChild(halo(tex, map.goal.x, map.goal.y, PULSAR_REACH, field.goal, field.bloomAlpha));
  const entries = spawnPoints(map);
  for (const e of entries) {
    layer.addChild(halo(tex, e.x, e.y, PULSAR_REACH, field.spawn, field.bloomAlpha * SPAWN_SHARE));
  }

  const dist = routeDistance(map);
  layer.addChild(buildTileField(map, tex, field, dist, routeSpill(map, dist, SPILL_RINGS)));

  // Above the tiles, because ground is translucent: a wash underneath would
  // arrive at `1 - groundAlpha` and be most of a layer you paid for and cannot
  // see. Above, it lands at the value it was authored at.
  layer.addChild(wash(tex, map, map.goal, WASH_REACH, field.lit, field.litAlpha));
  for (const e of entries) {
    layer.addChild(wash(tex, map, e, HAZE_REACH, field.haze, field.hazeAlpha));
  }

  // Over the tiles, under the lattice — see `buildNebula` for why this is not
  // where the design put it.
  layer.addChild(buildNebula(map, field));

  layer.addChild(buildLattice(map, field));

  const stream = buildStream(map, tex, field);
  for (const run of stream) layer.addChild(run);

  layer.addChild(buildRouteLine(map, field));
  layer.addChild(buildEndMarkers(map, field));

  // Last, so nothing on the board draws over the type. Everything that could —
  // stations, contacts, the overlay — lives on a layer above this one anyway,
  // which is the right order: a name is furniture and must never occlude a
  // contact.
  layer.addChild(buildLaneLabels(map, field));

  return {
    view: layer,
    step(dt) {
      // Constant, and deliberately **not** scaled by the 1x/2x/4x multiplier.
      // A current that sped up with the game would read as the board reacting
      // to the speed control rather than as something the road is doing.
      for (const run of stream) run.tilePosition.x -= STREAM_TILES_PER_SEC * TILE_PX * dt;
    },
  };
}

/** Alpha and speed. Both ceilings — see the budget note in `buildStream`. */
const STREAM_ALPHA = 0.1;
const STREAM_TILES_PER_SEC = 0.35;

/** How thick the current is across the road, in tiles. */
const STREAM_WIDTH = 0.44;

/**
 * One `TilingSprite` per straight run of the route, scrolling toward the pulsar.
 *
 * Runs rather than segments: consecutive collinear waypoints merge, so
 * Switchback's forty-three tiles become seven scrolling strips. **No run has to
 * turn** — a corner is where one strip ends and the next begins, which is what
 * keeps this to a rotation and a scalar per run instead of a curved mesh.
 *
 * The budget that matters is not CPU, it is attention: *at 4x on Switchback, a
 * single Mote must still be the first thing the eye finds.* If it is not, halve
 * the alpha before touching the speed — a dim fast crawl reads as current, a
 * bright slow one reads as an object, and an object is what a contact is.
 */
function buildStream(map: MapDef, tex: Textures, field: SectorField): TilingSprite[] {
  const runs: TilingSprite[] = [];

  map.routes.forEach((route, lane) => {
    const wp = route.waypoints;
    if (wp.length < 2) return;

    let start = wp[0]!;
    for (let i = 1; i < wp.length; i++) {
      const here = wp[i]!;
      const next = wp[i + 1];

      // Keep extending while the heading does not change.
      if (
        next !== undefined &&
        Math.sign(here.x - start.x) === Math.sign(next.x - here.x) &&
        Math.sign(here.y - start.y) === Math.sign(next.y - here.y)
      ) {
        continue;
      }

      const dx = here.x - start.x;
      const dy = here.y - start.y;
      const len = Math.hypot(dx, dy) * TILE_PX;
      if (len > 0) runs.push(strip(tex, field, start.x, start.y, Math.atan2(dy, dx), len, lane));

      start = here;
    }
  });

  return runs;
}

/**
 * How far each lane's current is offset from the first, in tiles.
 *
 * Without it, two lanes sharing a trunk lay identical strips on identical
 * tiles: the shared road would show one current at double alpha and read as a
 * single lane, which is precisely the fact a merge board needs the player to
 * see. A phase offset is enough — the strips are the same texture at the same
 * speed, so offsetting is the only way to tell them apart that costs nothing.
 */
const STREAM_LANE_PHASE = 0.37;

function strip(
  tex: Textures,
  field: SectorField,
  tileX: number,
  tileY: number,
  rotation: number,
  length: number,
  lane: number,
): TilingSprite {
  const s = new TilingSprite({ texture: tex.stream, width: length, height: STREAM_WIDTH * TILE_PX });

  // Pivot on the strip's own centre line so a run rotates about the road rather
  // than about its edge.
  s.pivot.set(0, (STREAM_WIDTH * TILE_PX) / 2);
  s.position.set(tileX * TILE_PX, tileY * TILE_PX);
  s.rotation = rotation;
  s.tint = field.lineFar;
  s.alpha = STREAM_ALPHA;
  // Lane 0 is unshifted, so a single-lane board is untouched by this.
  s.tilePosition.x = lane * STREAM_LANE_PHASE * TILE_PX;
  return s;
}

/**
 * The distinct off-board entries, deduped by position.
 *
 * By entry rather than by lane: Crown runs four lanes out of two spawns, and
 * lighting a spawn twice only makes it brighter than the board it shares a
 * palette with. Each *place* contacts arrive from gets one haze and one halo,
 * at the alpha it was authored at — two hazy corners is what a two-spawn board
 * should look like.
 */
function spawnPoints(map: MapDef): Vec2[] {
  const seen = new Set<string>();
  const out: Vec2[] = [];
  for (const route of map.routes) {
    const e = route.waypoints[0];
    if (e === undefined) continue;
    const key = `${e.x},${e.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * How far the pulsar's bloom reaches, in tiles.
 *
 * The objective used to be drawn inside one 40px tile — smaller than a station,
 * for the thing whose loss ends the run. When a leak happens the eye has to
 * already have been somewhere, and a detail in the corner is not somewhere.
 */
const PULSAR_REACH = 2.5;

/** Arrival is quiet, the core is loud. The spawn gets the same shape, dimmer. */
const SPAWN_SHARE = 0.25;

/** Wash extents as a fraction of the board, from the design's gradient stops. */
const WASH_REACH = { x: 0.64, y: 0.52 };
const HAZE_REACH = { x: 0.51, y: 0.45 };

/**
 * The shared falloff, stretched and tinted.
 *
 * A `Sprite` rather than a `Graphics` on purpose: these sit next to the tile
 * field in z, so they join its batch. Four Graphics here would cost four extra
 * draw calls *and* split the tile batch in two.
 */
function falloffSprite(
  tex: Textures,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tint: number,
  alpha: number,
): Sprite {
  const s = new Sprite(tex.falloff);
  s.anchor.set(0.5);
  s.setSize(rx * 2, ry * 2);
  s.position.set(cx, cy);
  s.tint = tint;
  s.alpha = alpha;
  return s;
}

/** A bloom centred on a tile, measured in tiles. */
const halo = (
  tex: Textures,
  tileX: number,
  tileY: number,
  reach: number,
  tint: number,
  alpha: number,
): Sprite =>
  falloffSprite(
    tex,
    tileX * TILE_PX,
    tileY * TILE_PX,
    reach * TILE_PX,
    reach * TILE_PX,
    tint,
    alpha,
  );

/**
 * A board-wide wash, centred on something that matters.
 *
 * Anchored to the real `goal` and `spawn` rather than to the fixed 84%/72% the
 * design's mock used, because the mock was drawn over Switchback and the other
 * two boards put their ends elsewhere. "Lit from the pulsar" is the intent; the
 * percentage was only ever one board's arithmetic for it.
 */
const wash = (
  tex: Textures,
  map: MapDef,
  at: { readonly x: number; readonly y: number },
  reach: { readonly x: number; readonly y: number },
  tint: number,
  alpha: number,
): Sprite =>
  falloffSprite(
    tex,
    at.x * TILE_PX,
    at.y * TILE_PX,
    map.cols * TILE_PX * reach.x,
    map.rows * TILE_PX * reach.y,
    tint,
    alpha,
  );

/**
 * Every tile, from one texture.
 *
 * The colour is `tint` and the translucency is `alpha`, both of which Pixi 8
 * packs into the vertex stream — so 390 tiles in four different colours are
 * still a single batched draw call, exactly as 390 identical ones were.
 *
 * The alpha is what lets the starfield through. Open ground sits short of
 * opaque so the sky reads as being *behind* the board rather than as one more
 * shade of tile; the route stays at 1 and occludes it, which is what makes the
 * road read as a structure laid over the void. That is a legibility win as much
 * as a visual one — a route you can trace without the field competing under it
 * is a route you can plan against.
 */
function buildTileField(
  map: MapDef,
  tex: Textures,
  field: SectorField,
  dist: Float32Array,
  spill: Uint8Array,
): Container {
  const tileField = new Container();

  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      const i = row * map.cols + col;
      const kind = map.tiles[i]!;
      const sprite = new Sprite(tex.tile);

      if (kind === 'path') {
        // Ramps toward the pulsar, so a still frame says which way contacts
        // travel — one of the design's acceptance tests, and free because tint
        // is a vertex attribute rather than a new texture.
        sprite.tint = mixColor(field.path, field.pathLit, dist[i]!);
      } else if (kind === 'blocked') {
        // A thin plate, so the cloud drawn beneath it reads through. The plate
        // is the rule and the cloud is the atmosphere; the lattice draws the
        // clump's perimeter, which is what keeps "no build here" tile-accurate.
        sprite.tint = field.blocked;
        sprite.alpha = field.blockedAlpha;
      } else {
        // Checker the buildable ground, so a tile is countable without a hard
        // grid line having to do the whole job.
        const base = (col + row) % 2 === 0 ? field.ground : field.groundAlt;
        sprite.tint = withSpill(base, field, map, dist, spill, i);
        sprite.alpha = field.groundAlpha;
      }

      sprite.position.set(col * TILE_PX, row * TILE_PX);
      tileField.addChild(sprite);
    }
  }

  return tileField;
}

/** Channel-wise lerp between two packed colours. */
function mixColor(from: number, to: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = ((from >> 16) & 255) + (((to >> 16) & 255) - ((from >> 16) & 255)) * k;
  const g = ((from >> 8) & 255) + (((to >> 8) & 255) - ((from >> 8) & 255)) * k;
  const b = (from & 255) + ((to & 255) - (from & 255)) * k;
  return (r << 16) | (g << 8) | b;
}

/**
 * The road's light on a tile beside it, composited into that tile's own colour.
 *
 * **Not a second sprite.** Alpha-over is associative and collapses to a single
 * `(rgb, a)`, so a spill tile can be one tinted sprite rather than two stacked
 * ones — the tile field stays at exactly one sprite per tile, and therefore at
 * one draw call, however much of the board the road touches.
 *
 * The spill takes its colour and strength from the *nearest* route tile's
 * position along the route, so the glow beside the road ramps with the road
 * rather than being uniform along it.
 */
function withSpill(
  base: number,
  field: SectorField,
  map: MapDef,
  dist: Float32Array,
  spill: Uint8Array,
  i: number,
): number {
  const ring = spill[i]!;
  if (ring === 0 || ring > SPILL_RINGS) return base;

  const t = nearestRouteT(map, dist, i);
  const tint = mixColor(field.spillNear, field.spillFar, t);
  const strength =
    (field.spillNearAlpha + (field.spillFarAlpha - field.spillNearAlpha) * t) *
    SPILL_FALLOFF[ring]!;

  return mixColor(base, tint, strength);
}

/** The route position of the closest road tile, for a tile beside the road. */
function nearestRouteT(map: MapDef, dist: Float32Array, i: number): number {
  const col = i % map.cols;
  const row = (i / map.cols) | 0;
  let best = 0;
  let bestD = Infinity;

  for (let r = row - SPILL_RINGS; r <= row + SPILL_RINGS; r++) {
    for (let c = col - SPILL_RINGS; c <= col + SPILL_RINGS; c++) {
      if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) continue;
      const t = dist[r * map.cols + c]!;
      if (t === OFF_ROUTE) continue;

      const d = Math.abs(c - col) + Math.abs(r - row);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
  }

  return best;
}

/**
 * A literal, like `SKY_SEED`, and for the same reason: a cloud that reshuffled
 * on every reload would read as a rendering fault rather than as a place.
 */
const NEBULA_SEED = 0x2be7;

/**
 * The nebula, as one board-space cloud rather than a per-tile bake.
 *
 * **The overhang is the entire point.** Baking forced every disc inside its own
 * 40px tile, and a disc inscribed in a square touches each edge at exactly one
 * point — so a clump of blocked tiles left a dark cross tracing the grid.
 * Nothing here calls `generateTexture`, so bounds no longer matter and the
 * puffs can spill across tile borders and into the ground beside them, which is
 * what makes a clump read as one mass instead of four coins.
 *
 * **Drawn over the tiles, not under them — which is not where the design put
 * it, and the reason is worth recording.** Under the tile field the plate has
 * to be nearly transparent for its own cloud to show through, and a blocked
 * tile at 0.15 against ground at 0.72 stops reading as gas and starts reading
 * as a *hole in the board*. Tried it, looked wrong, moved it. Above the tiles
 * the plate can sit at a normal weight, the cloud lands at the value it was
 * authored at, and the spill onto neighbouring ground costs a few percent of
 * dimming there — which is what atmosphere is.
 *
 * The lattice still draws above this, so the clump's perimeter survives and
 * "you cannot build here" stays tile-accurate. That was the actual constraint;
 * being underneath was only one way of meeting it.
 *
 * One Graphics for the whole cloud, built once — this layer's per-frame cost
 * stays at zero.
 */
function buildNebula(map: MapDef, field: SectorField): Graphics {
  const g = new Graphics();
  const rand = mulberry32(NEBULA_SEED);

  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      if (map.tiles[row * map.cols + col] !== 'blocked') continue;

      for (let i = 0; i < field.nebulaPerTile; i++) {
        // Centres wander up to half a tile out and radii run well past one, so
        // no puff shares a boundary with the tile that spawned it.
        const cx = (col + 0.5 + (rand() - 0.5)) * TILE_PX;
        const cy = (row + 0.5 + (rand() - 0.5)) * TILE_PX;
        const r = (0.45 + rand() * 1.15) * TILE_PX;

        // A denser knot now and then, so the mass has structure rather than
        // being an even smear — the failure mode of stacking equal discs.
        const knot = rand() < 0.25;
        g.circle(cx, cy, knot ? r * 0.45 : r).fill({
          color: knot ? field.blockedEdge : field.blocked,
          alpha: field.nebulaAlpha,
        });
      }
    }
  }

  return g;
}

/**
 * The hot line down the middle of the road.
 *
 * Stroked **per segment** rather than as one polyline, because a Graphics path
 * carries a single stroke style and the whole point here is that the colour and
 * alpha ramp along it. Segments meet at waypoint centres with a round cap,
 * which at 2px is indistinguishable from a mitre and costs nothing — the
 * design asked for mitred corners, and this is the honest way to have both the
 * ramp and the joins.
 *
 * Drawn above the tiles and the nebula but below the end markers, so the pulsar
 * still terminates it rather than being crossed by it.
 */
function buildRouteLine(map: MapDef, field: SectorField): Graphics {
  const g = new Graphics();
  // One normaliser for the board, matching `routeDistance` — see the argument
  // there for why the ramp is measured back from the goal rather than forward
  // from a spawn, and why a short lane starting part-lit is the truth.
  const longest = Math.max(...map.routes.map((r) => r.length));

  for (const route of map.routes) {
    const wp = route.waypoints;
    let travelled = 0;

    for (let i = 1; i < wp.length; i++) {
      const a = wp[i - 1]!;
      const b = wp[i]!;
      const steps = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

      // The midpoint's distance from the goal sets the segment's colour, so the
      // ramp follows the road rather than the screen.
      const t = longest > 0 ? 1 - (route.length - travelled - steps / 2) / longest : 0;
      travelled += steps;

      g.moveTo(a.x * TILE_PX, a.y * TILE_PX)
        .lineTo(b.x * TILE_PX, b.y * TILE_PX)
        .stroke({
          width: 2,
          cap: 'round',
          join: 'round',
          color: mixColor(field.lineNear, field.lineFar, t),
          alpha: field.lineNearAlpha + (field.lineFarAlpha - field.lineNearAlpha) * t,
        });
    }
  }

  return g;
}

/**
 * The grid, as one board-space object above the tiles.
 *
 * It used to be baked into each tile's own texture, which cost no extra nodes
 * but made the fade in `gridMaskAt` impossible: you cannot mask a texture that
 * is repeated across 390 sprites. Lifting it out buys the fade, and it also
 * collapsed three tile textures into one, because the stroke was the only thing
 * that distinguished them.
 *
 * Two consequences worth knowing:
 *
 *  - **It draws above the tiles, not below.** Open ground is translucent, so a
 *    lattice underneath would come through at `1 - groundAlpha` and lose most
 *    of its weight. Above, it lands at full strength, which is where placement
 *    legibility lives.
 *  - **One line per edge, where there used to be two.** Neighbouring tiles each
 *    stroked their own inset border, so a shared edge carried two adjacent 1px
 *    lines. `field.gridAlpha` is raised to compensate.
 */
function buildLattice(map: MapDef, field: SectorField): Graphics {
  const g = new Graphics();
  const boardW = map.cols * TILE_PX;
  const boardH = map.rows * TILE_PX;

  // Off-board reads as ground, so the board keeps its outer border.
  const kindAt = (col: number, row: number): string =>
    col < 0 || row < 0 || col >= map.cols || row >= map.rows
      ? 'ground'
      : map.tiles[row * map.cols + col]!;

  /**
   * An edge is drawn unless both sides are the same thing you would not want
   * subdivided: the route reads as one continuous road, and a nebula is gas
   * rather than a set of squares. Everything else — including the boundary
   * *between* road and ground — is a line the player uses.
   */
  const skip = (a: string, b: string): boolean =>
    (a === 'path' && b === 'path') || (a === 'blocked' && b === 'blocked');

  const stroke = (x0: number, y0: number, x1: number, y1: number): void => {
    const alpha = field.gridAlpha * gridMaskAt((x0 + x1) / 2, (y0 + y1) / 2, boardW, boardH);
    if (alpha <= 0) return;
    g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 1, color: field.gridLine, alpha });
  };

  // Half-pixel offsets so a 1px stroke lands *on* a pixel rather than across
  // two — the same convention the baked tile border used.
  for (let col = 0; col <= map.cols; col++) {
    for (let row = 0; row < map.rows; row++) {
      if (skip(kindAt(col - 1, row), kindAt(col, row))) continue;
      const x = col * TILE_PX + 0.5;
      stroke(x, row * TILE_PX, x, (row + 1) * TILE_PX);
    }
  }

  for (let row = 0; row <= map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      if (skip(kindAt(col, row - 1), kindAt(col, row))) continue;
      const y = row * TILE_PX + 0.5;
      stroke(col * TILE_PX, y, (col + 1) * TILE_PX, y);
    }
  }

  return g;
}

/**
 * Star count and bright-chance moved onto `SectorField`.
 *
 * They were 300 and 0.12 for every board, which is the right density for
 * Switchback — roughly one star every two tiles, enough that no tile is
 * conspicuously empty and sparse enough that the field never resolves into
 * texture the eye has to look past. But density is exactly what a sector has to
 * be able to vary: Cascade's open board should feel emptier, and rarity is what
 * makes the bright ones read as depth rather than as noise.
 */

/**
 * A literal, and deliberately not the match seed. The sky is set dressing, not
 * content: a board that reshuffled its stars on every reload would read as a
 * rendering fault rather than as space, and the board is the fixed thing a
 * player learns. Unseeded randomness is legal in the renderer — see the
 * boundary rules in eslint.config.js — but it is the wrong tool for anything
 * that outlives a frame.
 */
const SKY_SEED = 0x5c1f;

/**
 * The whole sky in one Graphics.
 *
 * Board-wide rather than baked into a tile: at any density that reads as a sky,
 * a 40px tile repeated 390 times shows its period immediately, and the eye finds
 * a lattice faster than it finds a star. One node rather than 300 for the same
 * reason the tiles are Sprites — 300 renderables walked every frame to draw a
 * thing that never changes is the cost this layer exists to avoid.
 */
function buildStarfield(width: number, height: number, field: SectorField): Graphics {
  const g = new Graphics();

  // Two passes into one node: a near field, then a dimmer, smaller far field
  // behind it. Depth comes from the two populations differing, not from either
  // one moving — the sky stays static because motion in the background means
  // "a contact", and that is the one thing it may never say.
  //
  // Separate seeds, or the far pass would land a companion beside every near
  // star and read as astigmatism rather than as distance.
  drawStarPass(g, width, height, field, mulberry32(SKY_SEED), field.starCount, 1);
  drawStarPass(
    g,
    width,
    height,
    field,
    mulberry32(SKY_SEED ^ 0x9e37),
    Math.round(field.starCount * 0.7),
    field.starFarAlpha,
  );

  return g;
}

function drawStarPass(
  g: Graphics,
  width: number,
  height: number,
  field: SectorField,
  rand: () => number,
  count: number,
  depth: number,
): void {
  for (let i = 0; i < count; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const bright = rand() < field.starBrightChance;

    // The ceilings matter more than the exact numbers. Even the brightest star
    // has to sit below a station stroke, which sits below a contact: the sky is
    // the bottom of the contrast hierarchy, and anything up here that pulls the
    // eye is spending attention the pink creeps have already been promised.
    const radius = (bright ? 1 + rand() * 0.6 : 0.45 + rand() * 0.65) * (0.6 + depth * 0.4);
    const alpha = (bright ? 0.55 + rand() * 0.25 : 0.16 + rand() * 0.34) * depth;

    g.circle(x, y, radius).fill({
      color: bright ? field.starBright : field.star,
      alpha,
    });
  }
}

/**
 * The pulsar at the goal: radius **in tiles**, stroke width, alpha.
 *
 * Several rings at falling alpha rather than one at a constant one. That
 * falloff is the whole difference — a single even ring reads as a targeting
 * reticle borrowed from the HUD, while a stack that fades outward reads as
 * something emitting, which is what the thing the creeps are walking towards
 * ought to look like.
 *
 * These used to be fractions of a single tile, which made the game's entire
 * loss condition a 40px detail at the board's edge — smaller than any station,
 * and nowhere the eye would already be when a leak happened. Now they reach
 * `PULSAR_REACH`, and the outermost two are faint enough to read as bloom
 * rather than as more rings.
 */
const PULSAR_RINGS: readonly (readonly [number, number, number])[] = [
  [2.5, 1, 0.05],
  [1.85, 1, 0.08],
  [1.3, 1.2, 0.13],
  [0.85, 1.5, 0.2],
  [0.46, 2, 0.34],
];

/** Spawn chevrons and goal pulsar. A handful of markers, so plain Graphics is fine. */
function buildEndMarkers(map: MapDef, field: SectorField): Graphics {
  const g = new Graphics();

  // One chevron per *entry tile*, not per lane. Crown runs four lanes out of
  // two spawns, and stacking two chevrons on one tile just draws it darker.
  const drawn = new Set<string>();

  for (const route of map.routes) {
    // The spawn point sits one tile off-board; draw the chevron on the first
    // on-board tile instead, pointing the way creeps will travel.
    const entry = route.waypoints[0]!;
    const first = route.waypoints[1];
    if (first === undefined) continue;

    const key = `${first.x},${first.y}`;
    if (drawn.has(key)) continue;
    drawn.add(key);

    const dx = Math.sign(first.x - entry.x);
    const dy = Math.sign(first.y - entry.y);
    const ax = first.x * TILE_PX;
    const ay = first.y * TILE_PX;
    const r = TILE_PX * 0.3;

    // Tip points along travel; the base is the perpendicular through the centre.
    g.moveTo(ax + dx * r, ay + dy * r)
      .lineTo(ax - dx * r + dy * r, ay - dy * r + dx * r)
      .lineTo(ax - dx * r - dy * r, ay - dy * r - dx * r)
      .fill({ color: field.spawn, alpha: 0.85 });
  }

  const gx = map.goal.x * TILE_PX;
  const gy = map.goal.y * TILE_PX;
  const goal = field.goal;

  // The bloom is the `falloff` sprite under the tile field, not a disc here —
  // see the halos added in `buildMapLayer`. What is left in this Graphics is
  // only what has to sit *above* the board: the rings and the core.
  for (const [radius, width, alpha] of PULSAR_RINGS) {
    g.circle(gx, gy, TILE_PX * radius).stroke({ width, color: goal, alpha });
  }
  // Core: a soft shoulder under a hard centre, so the middle blooms instead of
  // sitting there as a flat dot the rings happen to be centred on. It grew with
  // the rings — a 0.08-tile dot inside a 2.5-tile ring stack would read as a
  // target the rings were aimed at rather than as the thing emitting them.
  g.circle(gx, gy, TILE_PX * 0.34).fill({ color: goal, alpha: 0.16 });
  g.circle(gx, gy, TILE_PX * 0.2).fill({ color: goal, alpha: 0.34 });
  g.circle(gx, gy, TILE_PX * 0.11).fill({ color: goal, alpha: 0.95 });

  return g;
}

/**
 * How far a name sits off the road it belongs to, in tiles, centre to centre.
 *
 * One whole tile, so the type lands on the middle of the neighbouring tile and
 * clears the edge of the road by about three tenths of it at this size. Closer
 * and the outline touches the road's own border; further and the name stops
 * reading as belonging to the lane it is naming and starts reading as a caption
 * on the board.
 */
const LANE_LABEL_OFFSET = 1;

/**
 * A ceiling, in the sense the stream's alpha is one.
 *
 * This is the only thing the board layer draws that is *read* rather than
 * glanced at, and it never moves, so it has the whole match in which to pull the
 * eye. If it ever competes with a contact, dim it here — do not shrink it, since
 * a name you have to squint at costs attention rather than saving it.
 */
const LANE_LABEL_ALPHA = 0.8;

/**
 * Lane names, once each, beside the tile their contacts arrive on.
 *
 * **The word comes from the route's own id, and so does the deck's.** The
 * sortie deck's lane picker prints the same string under
 * `text-transform: capitalize` (see `.seg.lanes button` in styles.css), so
 * picking a lane and watching one are the same vocabulary by construction
 * rather than by two lists agreeing. There is deliberately no table of display
 * names here: a table is a thing that can drift from the map, and the failure
 * would be a board quietly labelled with the previous author's word for it.
 *
 * **Two rules about which lanes get one, both derived rather than listed:**
 *
 *  - A single-lane board gets nothing. "Main" over the only road on Sector 01
 *    distinguishes it from nothing, and that board's deck has no lane control to
 *    share the word with — the name would be decoration on the one layer that
 *    has argued hardest against it.
 *  - Lanes that arrive on the *same* tile get nothing either. Fork's north and
 *    south share an entry and the six tiles after it, so a name there would sit
 *    beside road that is both lanes and identify neither, and two names stacked
 *    on one tile only draw it darker. This is the same dedupe `buildEndMarkers`
 *    does, resolved the other way round: a chevron says "contacts arrive here",
 *    which stays true of a shared entry, and a name does not. Front Line, Delta
 *    and Sluice enter separately and are labelled; Fork, Braid and Crown are
 *    not, which is the honest answer for boards whose lanes are only distinct
 *    downstream of where the label would go.
 *
 * Built once with the rest of the layer, and this adds no per-frame work: Pixi
 * rasterises each string to a texture on first render and then draws one sprite
 * per name, for a board that never asks for a second rasterisation.
 */
function buildLaneLabels(map: MapDef, field: SectorField): Container {
  const labels = new Container();
  if (map.routes.length < 2) return labels;

  const key = (v: Vec2): string => `${v.x},${v.y}`;
  const lanesAt = new Map<string, number>();
  for (const route of map.routes) {
    const first = route.waypoints[1];
    if (first === undefined) continue;
    lanesAt.set(key(first), (lanesAt.get(key(first)) ?? 0) + 1);
  }

  for (const route of map.routes) {
    // `waypoints[0]` is the off-board lead-in and the canvas is exactly the
    // board, so the first *on-board* tile is both what can be labelled and what
    // the entry chevron already marks.
    const entry = route.waypoints[0]!;
    const first = route.waypoints[1];
    if (first === undefined || lanesAt.get(key(first)) !== 1) continue;

    const dx = Math.sign(first.x - entry.x);
    const dy = Math.sign(first.y - entry.y);

    // Perpendicular to travel and pointing at the nearer edge. The road runs
    // *into* the board from here, so outward is the side with nothing on it —
    // and on the two-lane boards it is also the side away from the other lane,
    // which keeps the pair of names as far apart as the pair of roads.
    const ox = dx === 0 ? outward(first.x, map.cols) : 0;
    const oy = dy === 0 ? outward(first.y, map.rows) : 0;

    const label = new Text({
      text: laneName(route.id),
      style: {
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 12,
        fontWeight: '600',
        // Muted board furniture takes the *sky's* colour, not the road's. The
        // starfield is the bottom of this board's contrast hierarchy, which is
        // exactly where a label that never changes belongs; anything from the
        // route family would put a static word in the same tier as the brightest
        // thing on the board. It is per-field, so a reskin carries it. There is
        // no in-world text token to reach for — `hud.muted` is the right word
        // for the wrong layer, being screen chrome with one fixed palette for
        // all nine sectors.
        fill: field.star,
        // A star can land behind a letter, and at this weight that is enough to
        // break the word. The theme's rule for in-world text — see
        // `fx.textOutline` — is that a fill alone is never sufficient. Thinner
        // than the 3px the damage numbers carry, because those sit over the
        // brightest object on screen and this sits over the dimmest.
        stroke: { color: THEME.fx.textOutline, width: 2, join: 'round' },
        // Letters spaced like signage rather than like prose: it says "this is
        // a name for the place" at a size too small to say it any other way.
        letterSpacing: 1.2,
      },
    });

    // Anchored so the word grows away from the road it names — into the board
    // for a lane entering along a row, out toward the edge for one entering
    // down a column. Either way nothing runs off the canvas and nothing crosses
    // the tiles the label is offset from in the first place.
    label.anchor.set(dx < 0 || ox < 0 ? 1 : 0, 0.5);
    label.position.set(
      (first.x + ox * LANE_LABEL_OFFSET) * TILE_PX,
      (first.y + oy * LANE_LABEL_OFFSET) * TILE_PX,
    );
    label.alpha = LANE_LABEL_ALPHA;
    labels.addChild(label);
  }

  return labels;
}

/**
 * Which way to step off the road: toward the nearer edge, unless that would put
 * the type off the board, in which case back inward.
 *
 * The fallback matters because the stage is exactly the board's pixel size —
 * there is no margin to spill into, and a label centred outside it is simply
 * not drawn. Crown already enters one tile from the top edge, which spends the
 * whole of that clearance; a board that ran a lane along the outermost row
 * would put the name off the canvas, and losing it silently is the worst of the
 * available outcomes. Stepping inward there is a compromise the player can at
 * least read.
 */
function outward(at: number, span: number): number {
  const out = at < span / 2 ? -1 : 1;
  const landed = at + out * LANE_LABEL_OFFSET;
  return landed < 0.5 || landed > span - 0.5 ? -out : out;
}

/**
 * `crest` → `Crest`, `inner-high` → `Inner-High`.
 *
 * Matched to what CSS `text-transform: capitalize` does to the same string in
 * the deck, hyphens included, so the board and the lane picker never disagree
 * about a word they both take from the map.
 */
const laneName = (id: string): string => id.replace(/\b\w/g, (c) => c.toUpperCase());
