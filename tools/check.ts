/**
 * Headless simulation gates. `npm run check`.
 *
 * These exist because `src/sim/` is pure — no PixiJS, no DOM, no wall-clock
 * time — so Node can run the real gameplay code with nothing stubbed. Every
 * assertion below drives the *actual* production functions, not a
 * reimplementation of them; that distinction is the whole point.
 *
 * Milestone gates from the plan land here as they come due. M10 adds the
 * determinism gate (same seed → byte-identical wave log).
 */
import { readFileSync } from 'node:fs';
import { LEVEL01 } from '../src/content/maps/level01.ts';
import { VERSUS } from '../src/content/maps/versus.ts';
import {
  DECK_PX,
  DOCK_BUILD_PX,
  DOCK_DETAIL_PX,
  DOCK_ERA_PX,
  DOCK_GAP,
  DOCK_MARGIN,
  GRID_MASK_FLOOR,
  TAP_PX,
  TILE_PX,
  gridMaskAt,
} from '../src/render/constants.ts';
import { OFF_ROUTE, SPILL_RINGS, routeDistance, routeSpill } from '../src/render/route.ts';
import { SECTOR_FIELDS, THEME, step } from '../src/render/theme.ts';
import { SECTOR_FIELD_IDS } from '../src/content/sectors.ts';
import { STATION_MARKS } from '../src/render/stationShape.ts';
import { deckKey, renderArmed, renderDeck, renderInspector, renderNextContact, renderPaused, renderSlots } from '../src/ui/hud.ts';
import { createUiState } from '../src/app/uiState.ts';
import { boardFacts, boardThumb } from '../src/ui/boardThumb.ts';
import { CAMPAIGN, VERSUS_LEVEL } from '../src/content/levels.ts';
import { contactGlyphRadius, contactIcon } from '../src/ui/icons.ts';
import { contactExtent, contactShape } from '../src/render/contactShape.ts';
import { BALANCE } from '../src/content/balance.ts';
import { WAVES, WAVES_FRONTLINE } from '../src/content/waves.ts';
import { SORTIES, SORTIE_IDS } from '../src/content/sorties.ts';
import {
  PROTOCOL_VERSION,
  decodeC2S,
  encode,
  type C2S,
  type S2C,
} from '../src/net/protocol.ts';
import { sortieCost, sortieUnlocked } from '../src/sim/sortie.ts';
import {
  LEAK,
  SORTIE_INBOUND,
  SORTIE_LANDED,
  SORTIE_SENT,
} from '../src/audio/palette.ts';
import { planWave, scaledStats, waveCount } from '../src/sim/wavePlan.ts';
import { TOWERS, TOWER_IDS, type TowerId } from '../src/content/towers.ts';
import { ENEMIES, ENEMY_IDS, type EnemyId } from '../src/content/enemies.ts';
import {
  advanceEraCost,
  buildTower,
  computeStats,
  damageAtTier,
  effectiveInterval,
  isUnlocked,
  hasRangePath,
  placementError,
  salvageBonus,
  tierCeiling,
  upgradeCost,
  upgradeError,
  visualTier,
} from '../src/sim/build.ts';
import { placeAtProgress } from '../src/sim/systems/movement.ts';
import { coverage, formatDamage, laneCoverage, toughestArmour } from '../src/sim/analysis.ts';
import {
  UPGRADE_PATHS,
  type SimEvent,
  type TargetMode,
  type Tower,
} from '../src/sim/types.ts';
import { buildOrder, spotFor } from './buildOrder.ts';
import { rampFactor } from '../src/sim/systems/targeting.ts';
import { stepWorld } from '../src/sim/step.ts';
import { damageCreep, effectiveDamage } from '../src/sim/damage.ts';
import { parseMap, isBuildableTile, mergeRunway, tileAt, tileOf } from '../src/sim/util/grid.ts';
import { mulberry32, streamFor, STREAM, hashSeed } from '../src/sim/util/rng.ts';
import { createWorld, spawnCreep, type World } from '../src/sim/world.ts';
import { DEFAULT_RULES, resolveRules, versusRules, type Rules } from '../src/sim/rules.ts';
import { advance, DT, TICK_HZ, type Accumulator } from '../src/app/loop.ts';
import {
  idleGesture,
  reduce,
  type Effect,
  type Gesture,
  type GestureInput,
  type Tile,
} from '../src/app/gesture.ts';
import type { MapSource } from '../src/content/types.ts';

let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32mok \x1b[0m' : '\x1b[31mBAD\x1b[0m'} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

const section = (name: string): void => console.log(`\n\x1b[1m${name}\x1b[0m`);

const map = parseMap(LEVEL01);

// ---------------------------------------------------------------------------
section('map — parsing');

check(map.tiles.length === map.cols * map.rows, 'tile count matches dimensions', `${map.cols}x${map.rows}`);
check(map.routes.length > 0, 'the map has at least one route', `${map.routes.length}`);
check(
  map.routes.every((r) => r.length > 0 && r.waypoints.length >= 2),
  'every route has length and waypoints',
  map.routes.map((r) => `${r.id} ${r.length}t`).join(', '),
);
check(!isBuildableTile(map, 0, 2), 'spawn tile is not buildable');
check(!isBuildableTile(map, 3, 5), 'scenery is not buildable', `kind=${tileAt(map, 3, 5)}`);
check(isBuildableTile(map, 0, 0), 'open ground is buildable');
check(tileAt(map, -1, 0) === undefined, 'off-board lookups return undefined');

// ---------------------------------------------------------------------------
// The ASCII board and the waypoint route are two representations of one thing,
// so they can drift. Each mutation below is a drift mode that must crash at
// load rather than produce creeps gliding over grass.
section('map — drift detection');

interface MutantRoute {
  id: string;
  waypoints: number[][];
}

function expectReject(label: string, mutate: (rows: string[], routes: MutantRoute[]) => void): void {
  const rows = [...LEVEL01.rows];
  const routes: MutantRoute[] = LEVEL01.routes.map((r) => ({
    id: r.id,
    waypoints: r.waypoints.map((w) => [...w]),
  }));
  mutate(rows, routes);
  try {
    parseMap({ id: 'mutant', name: 'mutant', rows, routes } as unknown as MapSource);
    check(false, label, 'accepted — should have thrown');
  } catch (e) {
    check(true, label, (e as Error).message.replace('map "mutant": ', ''));
  }
}

const wps = (routes: MutantRoute[]): number[][] => routes[0]!.waypoints;

expectReject('route over an erased path tile', (rows) => { rows[7] = rows[7]!.replace('#######', '#.#####'); });
expectReject('path art nothing walks on', (rows) => { rows[0] = rows[0]!.replace('..', '##'); });
expectReject('waypoint moved off the road', (_r, rs) => { wps(rs)[3] = [14, 8]; });
expectReject('ragged row length', (rows) => { rows[4] = rows[4]! + '.'; });
expectReject('missing spawn', (rows) => { rows[2] = rows[2]!.replace('S', '.'); });
expectReject('unknown legend character', (rows) => { rows[0] = 'Z' + rows[0]!.slice(1); });

// The three rules multiple lanes added. Each is a way a multi-route board can
// be wrong that a single-route board could not be, so none of them was reachable
// before and all three are reachable now.
expectReject('a map with no routes at all', (_r, rs) => { rs.length = 0; });
expectReject('two routes sharing an id', (_r, rs) => { rs.push({ id: rs[0]!.id, waypoints: wps(rs).map((w) => [...w]) }); });
expectReject('a route starting somewhere that is not a spawn', (_r, rs) => { wps(rs)[0] = [7, 2]; });
expectReject('a route stopping short of the goal', (_r, rs) => { wps(rs).pop(); });
expectReject('a painted spawn no route leaves', (rows) => { rows[0] = 'S' + rows[0]!.slice(1); });
expectReject('a second goal', (rows) => { rows[0] = 'E' + rows[0]!.slice(1); });

// ---------------------------------------------------------------------------
// LANES.
//
// Every gate above runs on a board with one route, where a lane index is always
// 0 and "furthest along" and "closest to the goal" are the same ordering. None
// of them can fail the way a multi-lane board fails.
//
// So this fixture, rather than a shipped map: two spawns, two lanes of
// deliberately unequal length — 8 tiles against 13 — merging onto a shared
// trunk. It is the smallest board that makes every multi-lane rule reachable,
// and the length ratio is what makes the targeting gate below able to fail.
//
//   ........S....      chute:  [8,0] → [8,3] → [12,3]
//   ........#....      coil:   [0,3] → [12,3]
//   ........#....
//   S###########E      the last four tiles are walked by both
// ---------------------------------------------------------------------------
section('map — lanes');

const FORKED = {
  id: 'forked',
  name: 'Forked',
  rows: [
    '........S....',
    '........#....',
    '........#....',
    'S###########E',
    '.............',
    '.............',
    '.............',
  ],
  routes: [
    { id: 'chute', waypoints: [[8, 0], [8, 3], [12, 3]] },
    { id: 'coil', waypoints: [[0, 3], [12, 3]] },
  ],
} as unknown as MapSource;

const forked = parseMap(FORKED);

{
  check(forked.routes.length === 2, 'a board may carry more than one lane', `${forked.routes.length}`);
  check(
    forked.routes[0]!.length === 8 && forked.routes[1]!.length === 13,
    'each lane measures its own length, lead-in included',
    forked.routes.map((r) => `${r.id} ${r.length}t`).join(', '),
  );
  // The merge is the thing that had to stop being an error. Four tiles of road
  // carry both lanes, and the old "every tile once" rule rejected exactly this.
  const painted = forked.tiles.filter((t) => t === 'path').length;
  check(painted === 16, 'shared tiles are road once, not twice', `${painted} painted`);
  check(
    forked.routes[0]!.waypoints[0]!.y === -0.5 && forked.routes[1]!.waypoints[0]!.x === -0.5,
    'each lane gets its own off-board lead-in',
    forked.routes.map((r) => `${r.id} enters ${r.waypoints[0]!.x},${r.waypoints[0]!.y}`).join(' · '),
  );
}

// ---------------------------------------------------------------------------
// 'split' has to be reproducible from the seed alone, because a race replays
// the same plan on two machines and a lane that differs is a desync.
section('waves — lane dealing');

{
  const laneRules = (route: string, count: number): never =>
    ({ ...DEFAULT_RULES, waves: [{ groups: [{ enemy: 'drifter', count, every: 0.5, after: 0, route }] }] }) as never;

  const rules = laneRules('split', 12);
  const plan = planWave(1234, 0, rules, forked.routes);
  const perLane = [0, 1].map((r) => plan.filter((p) => p.route === r).length);
  check(perLane[0] === 6 && perLane[1] === 6, "'split' deals 12 across two lanes as 6 and 6", perLane.join(' / '));

  const again = planWave(1234, 0, rules, forked.routes);
  check(
    JSON.stringify(plan) === JSON.stringify(again),
    'and deals the same lanes on a replay of the same seed',
  );

  const named = planWave(1234, 0, laneRules('coil', 4), forked.routes);
  check(named.every((p) => p.route === 1), 'a group naming a lane walks only that lane', `${named.length} on coil`);

  let threw = false;
  try {
    planWave(1, 0, laneRules('rim', 1), forked.routes);
  } catch {
    threw = true;
  }
  check(threw, 'a group naming a lane the board does not have is a crash, not lane 0');
}

// ---------------------------------------------------------------------------
section('sim — walking two lanes');

{
  const w = createWorld(forked, 99);
  w.wave.phase = 'done';

  const chute = spawnCreep(w, 'drifter', { route: 0 });
  const coil = spawnCreep(w, 'drifter', { route: 1 });
  check(
    chute.route === 0 && coil.route === 1 && chute.x !== coil.x,
    'contacts enter at their own lane, not the first one',
    `chute ${chute.x},${chute.y} · coil ${coil.x},${coil.y}`,
  );

  for (let i = 0; i < 60 * 20 && w.creeps.some((c) => !c.dead); i++) stepWorld(w, DT);
  check(w.lives === BALANCE.startingLives - 2, 'both lanes reach the same goal', `${w.lives} lives`);

  // The shorter lane must arrive first, and by roughly the length difference.
  const w2 = createWorld(forked, 99);
  w2.wave.phase = 'done';
  spawnCreep(w2, 'drifter', { route: 1 });
  let coilTime = 0;
  for (let i = 0; i < 60 * 30 && w2.lives === BALANCE.startingLives; i++) {
    stepWorld(w2, DT);
    coilTime = w2.time;
  }
  const w3 = createWorld(forked, 99);
  w3.wave.phase = 'done';
  spawnCreep(w3, 'drifter', { route: 0 });
  let chuteTime = 0;
  for (let i = 0; i < 60 * 30 && w3.lives === BALANCE.startingLives; i++) {
    stepWorld(w3, DT);
    chuteTime = w3.time;
  }
  check(
    chuteTime < coilTime,
    'the short lane arrives first, as its geometry says it must',
    `chute ${chuteTime.toFixed(2)}s vs coil ${coilTime.toFixed(2)}s`,
  );
}

// ---------------------------------------------------------------------------
// THE ORDERING BUG UNEQUAL LANES INTRODUCE.
//
// `first` used to rank by distance *travelled*, which is the same ordering as
// "closest to the goal" only while every lane is the same length. Here the coil
// is 13 tiles and the chute is 8, so a contact one tile from the pulsar down the
// chute has *less* progress than one still six tiles out on the coil — and the
// old rule shot the wrong one at exactly the moment it mattered.
// ---------------------------------------------------------------------------
section('targeting — first means closest to the goal');

{
  const w = createWorld(forked, 7);
  w.wave.phase = 'done';

  const nearGoal = spawnCreep(w, 'drifter', { route: 0 });
  nearGoal.x = 11.5;
  nearGoal.y = 3.5;
  nearGoal.leg = 3;
  nearGoal.progress = 7; //          8-tile lane: 1 tile left

  const farOut = spawnCreep(w, 'drifter', { route: 1 });
  farOut.x = 7.5;
  farOut.y = 3.5;
  farOut.leg = 2;
  farOut.progress = 9; //            13-tile lane: 4 tiles left

  check(
    farOut.progress > nearGoal.progress,
    'the setup is the trap: the further contact has the higher progress',
    `coil ${farOut.progress} vs chute ${nearGoal.progress}`,
  );

  w.commands.push({ type: 'placeTower', defId: 'lance', col: 9, row: 4 });
  stepWorld(w, DT);
  const t = w.towers[0]!;
  t.targeting = 'first' as TargetMode;
  t.cooldown = 0;
  stepWorld(w, DT);

  const shot = w.projectiles[0];
  check(
    shot !== undefined && Math.abs(shot.tx - nearGoal.x) < 0.6,
    "'first' shoots the contact nearest the goal, across lanes of different length",
    shot === undefined ? 'nothing fired' : `aimed at ${shot.tx.toFixed(1)},${shot.ty.toFixed(1)}`,
  );
}

// ---------------------------------------------------------------------------
section('lanes — coverage and the brightness ramp');

{
  const w = createWorld(forked, 3);
  const cov = coverage(w);
  check(
    cov.total === forked.tiles.filter((t) => t === 'path').length,
    'union coverage counts the shared trunk once',
    `${cov.total} tiles for two lanes of 8 and 13`,
  );
  const lanes = laneCoverage(w);
  check(
    lanes.length === 2 && lanes[0]!.id === 'chute' && lanes[1]!.id === 'coil',
    'per-lane coverage names its lanes',
    lanes.map((l) => `${l.id} ${l.total}`).join(' · '),
  );

  // The ramp is measured back from the goal, so the goal is 1 on every board
  // and a *short* lane starts part-lit rather than at 0 — which is the truth:
  // the chute's entry really is closer to the core than the coil's.
  const dist = routeDistance(forked);
  const at = (col: number, row: number): number => dist[row * forked.cols + col]!;
  check(Math.abs(at(12, 3) - 1) < 1e-6, 'the goal tile sits at exactly 1', at(12, 3).toFixed(4));
  check(
    at(8, 0) > at(0, 3) && at(0, 3) >= 0,
    'the short lane enters part-lit, the long one at the floor',
    `chute entry ${at(8, 0).toFixed(2)} vs coil entry ${at(0, 3).toFixed(2)}`,
  );
  // Monotone *along each lane* — the claim the design actually makes. A single
  // global ordering is not available once lanes merge, and asserting one would
  // be asserting something untrue.
  let monotone = true;
  for (const route of forked.routes) {
    let prev = -Infinity;
    for (let i = 1; i < route.waypoints.length; i++) {
      const a = route.waypoints[i - 1]!;
      const b = route.waypoints[i]!;
      const steps = Math.round(Math.abs(b.x - a.x) + Math.abs(b.y - a.y));
      const sx = Math.sign(b.x - a.x);
      const sy = Math.sign(b.y - a.y);
      for (let s = 0; s <= steps; s++) {
        const col = Math.floor(a.x + sx * s);
        const row = Math.floor(a.y + sy * s);
        if (col < 0 || row < 0 || col >= forked.cols || row >= forked.rows) continue;
        const v = at(col, row);
        if (v === OFF_ROUTE || v < prev - 1e-6) monotone = false;
        prev = Math.max(prev, v);
      }
    }
  }
  check(monotone, 'brightness rises toward the goal along every lane');
}

// ---------------------------------------------------------------------------
section('lanes — splits stay on their parent’s lane');

{
  const w = createWorld(forked, 5);
  w.wave.phase = 'done';
  const parent = spawnCreep(w, 'cluster', { route: 1 });
  for (let i = 0; i < 120; i++) stepWorld(w, DT);
  parent.hp = 1;
  damageCreep(w, parent, 999, undefined);
  stepWorld(w, DT);

  const kids = w.creeps.filter((c) => !c.dead && c.defId === 'mote');
  check(kids.length > 0, 'the parent split', `${kids.length} children`);
  check(
    kids.every((k) => k.route === 1),
    'children inherit the lane their parent died on, never lane 0',
    kids.map((k) => k.route).join(','),
  );
}

// ---------------------------------------------------------------------------
// THE MAP SPEC PRINTED ITS OWN NUMBERS. THESE ARE THEM.
//
// Sectors 04-08 arrived as ASCII rows *and* a table of figures — road tiles,
// buildable tiles, per-lane length, merge runway. Two of the three earlier
// design specs shipped arithmetic that was wrong on contact with a real board,
// so the figures are transcribed here and checked against what `parseMap`
// actually builds rather than trusted.
//
// (See also the ramp gate below, which pins a rule the eight-board sweep priced.)
//
// Same argument as the ASCII/waypoint cross-check: a second representation is
// worth having precisely because it can disagree.
// ---------------------------------------------------------------------------
section('combat · the ramp cools, it does not extinguish');
{
  // These were one case until the eight-board sweep priced it. Snapping the
  // charge to zero on any change of target made a ramping station worth having
  // only where contacts arrive in a single unbroken file — on Braid, where the
  // lanes cross at every rung and the file breaks about twice a second, a
  // Filament measured at *minus eleven lives*: not a weak pick but a station a
  // player was strictly better off never building.
  //
  // The two situations are different and now behave differently. Killing
  // something and moving to the contact behind it never stopped the beam, so it
  // cools by half. Running out of targets does stop it, and that still clears
  // the charge — the rule that stops a station idling through an intermission
  // and opening the next wave at full power.
  const w = createWorld(map, 31337);
  w.wave.phase = 'done';
  w.wave.index = 10; //                                   past every unlock
  w.money = 5000;
  w.commands.push({ type: 'placeTower', defId: 'filament', col: 8, row: 3 });
  stepWorld(w, DT);
  const t = w.towers[0]!;
  check(t !== undefined && t.defId === 'filament', 'a filament is on the board');

  const park = (c: { x: number; y: number }): void => {
    c.x = 8.5;
    c.y = 2.5;
  };

  const held = spawnCreep(w, 'monolith', { hp: 1_000_000 });
  for (let i = 0; i < 60 * 4; i++) {
    park(held);
    stepWorld(w, DT);
  }
  const peak = t.focusTime;
  check(peak > 0, 'holding one target builds a charge', `focusTime ${peak.toFixed(2)}s`);
  check(
    Math.abs(rampFactor(t) - t.stats.rampMax) < 1e-6,
    'and holding it long enough reaches the ceiling',
    `x${rampFactor(t).toFixed(2)} of x${t.stats.rampMax}`,
  );

  held.dead = true;
  const next = spawnCreep(w, 'monolith', { hp: 1_000_000 });
  for (let i = 0; i < 40 && t.focusId !== next.id; i++) {
    park(next);
    stepWorld(w, DT);
  }
  check(t.focusId === next.id, 'the station re-targets when its focus dies');
  check(
    t.focusTime > 0,
    'switching targets does not extinguish the charge',
    `focusTime ${t.focusTime.toFixed(2)}s, was ${peak.toFixed(2)}s`,
  );
  check(
    t.focusTime < peak,
    'but it does cool it — a switch is never free',
    `${t.focusTime.toFixed(2)}s < ${peak.toFixed(2)}s`,
  );

  // A full fire interval, not a couple of ticks. The reset lives on the path
  // that runs when a station is *ready to fire* and finds nothing in reach, so
  // one still inside its cooldown has not been asked the question yet — which
  // this gate got wrong on the first attempt and is worth leaving written down.
  next.dead = true;
  for (let i = 0; i < 60; i++) stepWorld(w, DT);
  check(
    t.focusTime === 0 && t.focusId === null,
    'an empty board clears the charge entirely',
    `focusTime ${t.focusTime}`,
  );
  check(rampFactor(t) === 1, 'so a lull cannot be banked into the next wave');
}

// ---------------------------------------------------------------------------
section('map spec — the five boards match their own table');
{
  const SPEC: Readonly<Record<string, { road: number; build: number; runway: number; lanes: number[] }>> = {
    Fork: { road: 54, build: 318, runway: 6, lanes: [33, 33] },
    Delta: { road: 51, build: 325, runway: 9, lanes: [31, 28] },
    Braid: { road: 65, build: 316, runway: 4, lanes: [43, 43] },
    Sluice: { road: 65, build: 310, runway: 6, lanes: [20, 50] },
    Crown: { road: 92, build: 282, runway: 5, lanes: [31, 31, 31, 31] },
    // Not a campaign sector — the versus board, held to exactly the same
    // arithmetic. Its lanes are equal on purpose, which is the one figure here
    // that is a design rule rather than a measurement: a short lane and a long
    // one would make the sortie's lane choice trivial.
    'Front Line': { road: 62, build: 311, runway: 5, lanes: [33, 33] },
  };

  for (const level of [...CAMPAIGN, VERSUS_LEVEL]) {
    const spec = SPEC[level.name];
    if (spec === undefined) continue;
    const m = parseMap(level.map);

    const road = m.tiles.filter((t) => t === 'path').length;
    const build = m.tiles.filter((t) => t === 'ground').length;
    // Lane length carries the off-board lead-in; the spec counts tiles walked
    // on the board, so both sides of this comparison drop one.
    const lanes = m.routes.map((r) => r.length - 1);
    const run = mergeRunway(m);

    check(road === spec.road, `${level.name}: ${spec.road} tiles of road`, `${road}`);
    check(build === spec.build, `${level.name}: ${spec.build} buildable`, `${build}`);
    check(
      JSON.stringify(lanes) === JSON.stringify(spec.lanes),
      `${level.name}: lanes measure ${spec.lanes.join(' / ')}`,
      lanes.join(' / '),
    );
    check(
      run.tiles === spec.runway,
      `${level.name}: ${spec.runway} tiles of merge runway`,
      `${run.tiles} — ${(run.fraction * 100).toFixed(0)}% of the shortest lane`,
    );
    check(
      road + build + m.tiles.filter((t) => t === 'blocked').length === 390,
      `${level.name}: 26x15 fully accounted for`,
    );
  }

  // Sluice is the board the targeting rule was rewritten for. If its lanes ever
  // become equal that gate stops testing anything, and this is where it shows.
  const sluice = parseMap(CAMPAIGN.find((l) => l.name === 'Sluice')!.map);
  const [short, long] = sluice.routes.map((r) => r.length - 1) as [number, number];
  check(long / short >= 2, 'Sluice keeps the length ratio the targeting rule exists for', `${long} : ${short}`);
}

// ---------------------------------------------------------------------------
// Race mode rests entirely on this: both players must face identical waves.
section('rng — determinism');

{
  const a = streamFor(42, STREAM.WAVE, 7);
  const b = streamFor(42, STREAM.WAVE, 7);
  check(a() === b() && a() === b(), 'same (seed, purpose, index) reproduces');

  // The trap the plan calls out: with one global stream, an extra roll in an
  // early wave shifts every later wave. Per-wave streams make that impossible.
  const clean = streamFor(42, STREAM.WAVE, 23);
  const noisy = streamFor(42, STREAM.WAVE, 3);
  for (let i = 0; i < 500; i++) noisy();
  const after = streamFor(42, STREAM.WAVE, 23);
  check(clean() === after(), 'wave 23 is unaffected by extra draws in wave 3');

  const w1 = streamFor(42, STREAM.WAVE, 0);
  const c1 = streamFor(42, STREAM.COMBAT, 0);
  check(w1() !== c1(), 'purposes do not correlate');

  const r = mulberry32(7);
  let sum = 0;
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < 200_000; i++) {
    const v = r();
    sum += v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const mean = sum / 200_000;
  check(Math.abs(mean - 0.5) < 0.005 && lo >= 0 && hi < 1, 'uniform over [0,1)', `mean=${mean.toFixed(5)}`);
  check(hashSeed('hunter2') === hashSeed('hunter2') && hashSeed('a') !== hashSeed('b'), 'string seeds hash stably');
}

// ---------------------------------------------------------------------------
section('loop — traversal');

/**
 * A world with the wave machine parked, so the loop gates measure the loop.
 * Without this, wave 1 auto-starts partway through and the board fills with
 * creeps the assertion never meant to count.
 */
function soloWorld(): ReturnType<typeof createWorld> {
  const w = createWorld(map, 1234);
  w.wave.phase = 'done';
  return w;
}

{
  const w = soloWorld();
  const c = spawnCreep(w, 'drifter');
  const acc: Accumulator = { debt: 0 };
  const expected = map.routes[c.route]!.length / c.speed;

  while (w.lives === BALANCE.startingLives && w.time < 60) advance(w, acc, 1000 / TICK_HZ, 1);

  check(w.lives === BALANCE.startingLives - 1, 'a leak costs exactly one life', `lives=${w.lives}`);
  check(w.creeps.length === 0, 'the leaked creep is swept up', `creeps=${w.creeps.length}`);
  check(
    Math.abs(w.time - expected) < DT * 2,
    'traversal takes route length / speed seconds',
    `sim=${w.time.toFixed(4)}s expected=${expected.toFixed(4)}s`,
  );
}

// ---------------------------------------------------------------------------
// THE M2 GATE: the same wall clock must produce the same game, whatever the
// monitor is doing. A variable-timestep loop fails this, and in Race mode that
// would be a fairness bug rather than just a wobble.
section('loop — M2 gate: refresh-rate independence');

{
  // Deliberately shorter than the ~24s traversal so creeps are compared
  // mid-leg. Run it past the end and every case has parked on the goal tile,
  // and the position check passes for the wrong reason.
  const TOTAL_MS = 12_000;

  // Every pattern must total EXACTLY the same wall clock, short final frame
  // included — otherwise a rate whose period doesn't divide TOTAL_MS silently
  // gets less simulated time and "fails" for a reason that isn't the loop.
  const atRate = (hz: number): number[] => {
    const step = 1000 / hz;
    const out: number[] = [];
    for (let t = 0; t < TOTAL_MS; ) {
      const d = Math.min(step, TOTAL_MS - t);
      out.push(d);
      t += d;
    }
    return out;
  };

  // Deterministic jitter, kept under the 83ms five-tick cap so this exercises
  // the normal path rather than the hitch guard.
  const jittery = (): number[] => {
    const r = mulberry32(99);
    const out: number[] = [];
    for (let t = 0; t < TOTAL_MS; ) {
      const d = Math.min(4 + r() * 60, TOTAL_MS - t);
      out.push(d);
      t += d;
    }
    return out;
  };

  const run = (frames: number[]): { tick: number; x: number; y: number } => {
    const w = soloWorld();
    const c = spawnCreep(w, 'drifter');
    const acc: Accumulator = { debt: 0 };
    for (const d of frames) advance(w, acc, d, 1);
    return { tick: w.tick, x: c.x, y: c.y };
  };

  const cases: [string, number[]][] = [
    ['60Hz', atRate(60)],
    ['144Hz', atRate(144)],
    ['30Hz', atRate(30)],
    ['75Hz', atRate(75)],
    ['jittery', jittery()],
  ];

  const base = run(cases[0]![1]);
  for (const [label, frames] of cases) {
    const got = run(frames);
    const dTick = Math.abs(got.tick - base.tick);
    const dPos = Math.hypot(got.x - base.x, got.y - base.y);
    // One tick of slack: TICK_MS is 16.666…, so summing frame deltas can
    // legitimately land either side of a tick boundary. One tick of creep
    // movement is 0.03 tiles — 1.2px, which is why v1 skips interpolation.
    check(
      dTick <= 1 && dPos <= 0.031,
      label,
      `${frames.length} frames, tick=${got.tick} (±${dTick}), drift=${(dPos * 40).toFixed(2)}px`,
    );
  }
}

// ---------------------------------------------------------------------------
section('loop — hitch guards');

{
  for (const speed of [1, 2, 4]) {
    const w = soloWorld();
    spawnCreep(w, 'drifter');
    const acc: Accumulator = { debt: 0 };
    // A backgrounded tab returns with a delta like this. Without the guards the
    // sim would try to run 300 seconds of ticks in one frame and lock the page.
    const ticks = advance(w, acc, 5_000, speed);
    check(
      ticks === 5 * speed && acc.debt === 0,
      `${speed}x: a 5s stall is capped and its debt dropped`,
      `ticks=${ticks}`,
    );
  }

  const at = (speed: number): number => {
    const w = soloWorld();
    spawnCreep(w, 'drifter');
    const acc: Accumulator = { debt: 0 };
    for (let i = 0; i < 300; i++) advance(w, acc, 1000 / 60, speed);
    return w.tick;
  };
  const [x1, x2, x4] = [at(1), at(2), at(4)];
  check(
    Math.abs(x2 - x1 * 2) <= 1 && Math.abs(x4 - x1 * 4) <= 1,
    'speed multiplier scales simulated time',
    `1x=${x1} 2x=${x2} 4x=${x4}`,
  );
}

// ---------------------------------------------------------------------------
// The plan's N2 fairness gate in embryo: wave content must be a pure function
// of (seed, waveIndex). If this holds, two machines in a Race face identical
// boards, and it holds without any networking existing yet.
section('waves — content is a pure function of (seed, wave)');

{
  const dump = (seed: number): string =>
    JSON.stringify(Array.from({ length: waveCount() }, (_, i) => planWave(seed, i)));

  check(dump(4242) === dump(4242), 'same seed reproduces every wave byte-for-byte');
  check(dump(4242) !== dump(4243), 'a different seed gives a different match');

  // The specific trap: with one global stream, drawing extra numbers early
  // shifts every later wave. Planning waves out of order must change nothing.
  const forward = JSON.stringify(Array.from({ length: waveCount() }, (_, i) => planWave(77, i)));
  const shuffled: string[] = [];
  for (const i of [7, 2, 9, 0, 5, 1, 8, 3, 6, 4]) shuffled[i] = JSON.stringify(planWave(77, i));
  check(forward === `[${shuffled.join(',')}]`, 'planning waves out of order changes nothing');

  const totalPlanned = Array.from({ length: waveCount() }, (_, i) => planWave(77, i).length)
    .reduce((a, b) => a + b, 0);
  const totalAuthored = WAVES.reduce(
    (sum, wv) => sum + wv.groups.reduce((s, gr) => s + gr.count, 0),
    0,
  );
  check(totalPlanned === totalAuthored, 'plan spawns exactly what the table authors', `${totalPlanned} creeps over ${waveCount()} waves`);

  const w9 = planWave(77, 9);
  check(
    w9.every((s, i) => i === 0 || s.at >= w9[i - 1]!.at),
    'spawns are ordered by time even with overlapping groups',
  );
  check(w9.every((s) => s.at >= 0), 'jitter never pulls a spawn before its group starts');

  // Checked against the configured growth rate rather than a hardcoded range,
  // so tuning the curve cannot silently invalidate the gate.
  const scale = planWave(77, 9)[0]!.hp / planWave(77, 0)[0]!.hp;
  const expected = Math.pow(BALANCE.hpGrowth, waveCount() - 1);
  check(
    Math.abs(scale - expected) / expected < 0.02,
    'hp compounds at the configured growth rate',
    `wave 10 is ${scale.toFixed(1)}x wave 1 (${BALANCE.hpGrowth}^9 = ${expected.toFixed(1)})`,
  );
}

// ---------------------------------------------------------------------------
// A full match, headlessly, at a speed no browser could render. This is the
// seed of M9's balance harness, and it exists only because the sim is pure.
section('waves — full match');

{
  const play = (opts: { invincible: boolean }): { w: ReturnType<typeof createWorld>; waves: number } => {
    const w = createWorld(map, 4242);
    const acc: Accumulator = { debt: 0 };
    let cleared = 0;
    for (let i = 0; i < 200_000 && w.phase === 'playing'; i++) {
      advance(w, acc, 1000 / TICK_HZ, 1);
      // Stand in for the towers M5 will bring: vaporise everything on the path.
      if (opts.invincible) for (const c of w.creeps) c.dead = true;
      for (const ev of w.events) if (ev.type === 'waveCleared') cleared++;
      w.events.length = 0;
    }
    return { w, waves: cleared };
  };

  const lost = play({ invincible: false });
  check(lost.w.phase === 'lost', 'undefended, the match is lost', `wave ${lost.w.wave.index + 1}, ${lost.w.time.toFixed(0)}s`);
  check(lost.w.lives === 0, 'lives bottom out at zero, never negative', `lives=${lost.w.lives}`);

  const won = play({ invincible: true });
  check(won.w.phase === 'won', 'with everything killed, the match is won', `${won.w.time.toFixed(0)}s`);
  check(won.waves === waveCount(), 'every wave reports cleared exactly once', `${won.waves}/${waveCount()}`);
  check(won.w.lives === BALANCE.startingLives, 'a perfect run loses no lives');
  check(won.w.wave.phase === 'done', 'the wave machine parks in done');

  // Sending waves early must not skip or duplicate them.
  {
    const w = createWorld(map, 4242);
    const acc: Accumulator = { debt: 0 };
    let started = 0;
    for (let i = 0; i < 200_000 && w.phase === 'playing'; i++) {
      w.commands.push({ type: 'startWave' });
      advance(w, acc, 1000 / TICK_HZ, 1);
      for (const c of w.creeps) c.dead = true;
      for (const ev of w.events) if (ev.type === 'waveStarted') started++;
      w.events.length = 0;
    }
    check(
      started === waveCount() && w.phase === 'won',
      'spamming startWave neither skips nor repeats a wave',
      `${started} starts, ${w.time.toFixed(0)}s vs ${won.w.time.toFixed(0)}s idle`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sending early is the mechanic the wave machine was restructured around, and
// the thing that was silently broken before: startWave only acted during the
// intermission, which is a minority of the runtime.
section('waves — sending early');

{
  // Overlap: with no defence, wave 0's creeps are still walking when wave 1 is
  // sent. Two waves on the board at once is the whole point.
  const w = createWorld(map, 4242);
  w.lives = 1_000_000;
  w.commands.push({ type: 'startWave' });
  while (w.wave.phase === 'spawning' || w.wave.dispatchedThrough < 0) stepWorld(w, DT);
  w.events.length = 0;

  w.commands.push({ type: 'startWave' });
  stepWorld(w, DT);
  for (let i = 0; i < 60 * 3; i++) stepWorld(w, DT);

  const livingWaves = new Set(w.creeps.map((c) => c.wave));
  check(livingWaves.size >= 2, 'two waves can be on the board at once', `waves alive: ${[...livingWaves].join(', ')}`);
  check(w.wave.clearedThrough === -1, 'neither counts as cleared while creeps live');
}

// ---------------------------------------------------------------------------
// AUTO-RUSH IS THE SAME DECISION, MADE STANDING.
//
// Waves already start on their own when the intermission runs out, so this is
// not "start waves automatically" — it is the *rush*, armed permanently. That
// makes it an economy change rather than a convenience, because the rush pays
// `rushBonusPerSecond` for every second forfeited, and armed it forfeits all of
// them on every wave.
//
// So the gates are about two things: that the money is exactly what a manual
// rush at the same instant would have paid, and that turning it on cannot make
// the wave machine skip, repeat or overrun the arc — the same three failures
// `spamming startWave` is checked for above.
// ---------------------------------------------------------------------------
section('waves — auto-rush');

{
  const armed = (): World => {
    const w = createWorld(map, 4242);
    w.lives = 1_000_000;
    w.commands.push({ type: 'setAutoStart', on: true });
    stepWorld(w, DT);
    return w;
  };

  {
    const w = createWorld(map, 4242);
    check(!w.wave.autoStart, 'a fresh world is not armed — this is opt-in');
  }

  // Full bonus: armed, the wave goes on the first tick of the intermission with
  // the timer untouched, so the payout is the whole intermission.
  {
    const w = armed();
    w.wave.phase = 'intermission';
    w.wave.timer = BALANCE.intermission;
    w.events.length = 0;
    const before = w.money;
    stepWorld(w, DT);
    const rushed = w.events.find((e) => e.type === 'waveRushed');
    const want = Math.round(BALANCE.intermission * BALANCE.rushBonusPerSecond);
    check(
      rushed !== undefined && rushed.bonus === want && w.money - before === want,
      'an armed intermission pays the whole rush bonus',
      `+${w.money - before} vs ${want}`,
    );
  }

  // ...and it is the same number a hand on the key would have earned. The point
  // is that auto-rush is not a discount or a premium, only a standing order.
  {
    const w = createWorld(map, 4242);
    w.lives = 1_000_000;
    w.wave.phase = 'intermission';
    w.wave.timer = BALANCE.intermission;
    w.events.length = 0;
    const before = w.money;
    w.commands.push({ type: 'startWave' });
    stepWorld(w, DT);
    const manual = w.money - before;
    check(
      manual === Math.round(BALANCE.intermission * BALANCE.rushBonusPerSecond),
      'and exactly what a manual rush at the same instant pays',
      `manual +${manual}`,
    );
  }

  // Neither skips nor repeats, and stops at the end of the arc rather than
  // running off it — the failure a per-tick trigger is most likely to have.
  {
    const w = armed();
    const seen: number[] = [];
    for (let i = 0; i < 60 * 400; i++) {
      stepWorld(w, DT);
      for (const ev of w.events) if (ev.type === 'waveStarted') seen.push(ev.wave);
      w.events.length = 0;
      if (w.wave.phase === 'done' && w.creeps.length === 0) break;
    }
    const expected = [...Array(waveCount(w.rules)).keys()];
    check(
      JSON.stringify(seen) === JSON.stringify(expected),
      'armed, every wave starts exactly once and in order',
      `${seen.length} of ${expected.length}`,
    );
    check(w.wave.phase === 'done', 'and the arc still ends rather than running past it');
  }

  // Disarming mid-run hands the clock back rather than stranding the wave.
  {
    const w = armed();
    w.commands.push({ type: 'setAutoStart', on: false });
    stepWorld(w, DT);
    check(!w.wave.autoStart, 'it can be disarmed again');
  }

  // Versus refuses it at the command, not at the button — the sim never trusts
  // the caller. See `Rules.autoStart` for why the mode is scoped out.
  {
    const w = createWorld(map, 4242, versusRules(VERSUS_LEVEL, 'standard'));
    w.commands.push({ type: 'setAutoStart', on: true });
    stepWorld(w, DT);
    check(!w.wave.autoStart, 'versus refuses to arm it at all');
  }
}

// ---------------------------------------------------------------------------
// THE V1 GATE: a sortie is not wave traffic.
//
// `settleClearedWaves` works from the lowest wave still alive, and `spawnCreep`
// defaults a contact's wave tag to whatever is spawning now. Put those two
// together with a second source of contacts and one slow sortie holds a wave
// open for as long as it walks: no clear reward, `clearedThrough` frozen, and
// the Race status pump — which reports `clearedThrough + 1` — stuck. Every
// assertion here fails without `Creep.origin`.
section('versus — V1 gate: sorties are outside the wave system');

{
  const clearOf = (opts: { sortie: boolean }): { cleared: number; reward: number; leaked: number } => {
    const w = createWorld(map, 4242);
    w.lives = 1_000_000;

    // Wave 0 out of the door and killed, so the only thing that can keep it
    // from settling is whatever else is on the board.
    w.commands.push({ type: 'startWave' });
    while (w.wave.dispatchedThrough < 0) stepWorld(w, DT);

    // A Monolith is the worst case on purpose: 0.85 tiles/sec over a 43-tile
    // route is ~50s of walking, far longer than the wave it would otherwise
    // hold open.
    if (opts.sortie) spawnCreep(w, 'monolith', { origin: 'sortie' });

    for (const c of w.creeps) if (c.origin === 'wave') c.dead = true;

    let reward = 0;
    for (let i = 0; i < 60 * 5; i++) {
      stepWorld(w, DT);
      for (const ev of w.events) if (ev.type === 'waveCleared') reward += ev.reward;
      w.events.length = 0;
    }
    return {
      cleared: w.wave.clearedThrough,
      reward,
      leaked: w.perWave.reduce((sum, s) => sum + (s?.leaked ?? 0), 0),
    };
  };

  const clean = clearOf({ sortie: false });
  const withSortie = clearOf({ sortie: true });

  check(clean.cleared === 0, 'baseline: wave 1 settles once its own contacts are gone', `clearedThrough=${clean.cleared}`);
  check(
    withSortie.cleared === clean.cleared,
    'a sortie on the board does not stall the clear',
    `clearedThrough=${withSortie.cleared} vs ${clean.cleared} clean`,
  );
  check(
    withSortie.reward === clean.reward && clean.reward === BALANCE.waveClearReward,
    'the clear reward is paid on time regardless',
    `$${withSortie.reward} vs $${clean.reward}`,
  );
}

{
  // The per-wave itemisation must not acquire kills and leaks the wave never
  // caused — those figures are printed in the clear summary.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.lives = 1_000_000;

  const sortie = spawnCreep(w, 'drifter', { origin: 'sortie' });
  const before = w.money;
  damageCreep(w, sortie, 10_000);
  stepWorld(w, DT);

  check(w.stats.kills === 1, 'a killed sortie counts in the run total', `kills=${w.stats.kills}`);
  check(
    w.money === before + sortie.bounty,
    'the defender collects the bounty for killing a sortie',
    `+$${w.money - before}`,
  );
  check(
    w.perWave.every((s) => s === undefined || (s.kills === 0 && s.bounty === 0)),
    'the kill is charged to no wave',
  );
}

{
  // A leaked sortie: costs a life, tallied in the run total, absent from the
  // per-wave books.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  const acc: Accumulator = { debt: 0 };
  spawnCreep(w, 'drifter', { origin: 'sortie' });
  while (w.lives === BALANCE.startingLives && w.time < 60) advance(w, acc, 1000 / TICK_HZ, 1);

  check(w.stats.leaks === 1, 'a leaked sortie counts in the run total', `leaks=${w.stats.leaks}`);
  check(
    w.perWave.every((s) => s === undefined || s.leaked === 0),
    'the leak is charged to no wave',
  );
}

{
  // A Cluster sent as a sortie must not die into three contacts that count as
  // wave traffic — the children would be tagged with a wave they never joined
  // and would hold it open exactly as the parent was stopped from doing.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.lives = 1_000_000;

  const parent = spawnCreep(w, 'cluster', { origin: 'sortie' });
  damageCreep(w, parent, 10_000);
  stepWorld(w, DT);

  const children = w.creeps.filter((c) => c.defId === 'mote');
  check(children.length === 3, 'a sortie Cluster still splits', `${children.length} motes`);
  check(
    children.every((c) => c.origin === 'sortie'),
    'the children inherit the sortie origin',
  );
}

// ---------------------------------------------------------------------------
// THE V2 GATE: leak weight is a dial, and the campaign is not on it.
//
// `hpGrowth` is a swept number with a table of evidence behind it, and making
// a Monolith cost three lives everywhere would relitigate that arc by feel.
// The field exists so a *sortie* can weigh more than the contact it is drawn
// from; every contact the wave machine dispatches still costs exactly one.
section('versus — V2 gate: leakDamage');

{
  check(
    ENEMY_IDS.every((id) => ENEMIES[id].leakDamage === 1),
    'every campaign contact costs exactly one life',
    ENEMY_IDS.map((id) => `${id}=${ENEMIES[id].leakDamage}`).join(' '),
  );
}

{
  // The weight is carried by the contact, not looked up from its def — which
  // is what lets the same silhouette be scenery or a purchase.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  const acc: Accumulator = { debt: 0 };

  spawnCreep(w, 'drifter', { origin: 'sortie', leakDamage: 3 });
  const before = w.lives;
  let cost = 0;
  while (w.lives === before && w.time < 60) {
    advance(w, acc, 1000 / TICK_HZ, 1);
    for (const ev of w.events) if (ev.type === 'creepLeaked') cost = ev.cost;
    w.events.length = 0;
  }

  check(w.lives === before - 3, 'a weighted leak takes its full weight', `${before} → ${w.lives}`);
  check(cost === 3, 'the event reports what it cost', `cost=${cost}`);

  const sameDef = spawnCreep(w, 'drifter');
  check(sameDef.leakDamage === 1, 'the def is unchanged by the override', `leakDamage=${sameDef.leakDamage}`);
}

{
  // Lives floor at zero rather than going negative, so a heavy contact landing
  // on a thin reserve reads as a loss and not as a debt.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.lives = 2;
  const acc: Accumulator = { debt: 0 };
  spawnCreep(w, 'drifter', { origin: 'sortie', leakDamage: 9 });
  while (w.phase === 'playing' && w.time < 60) advance(w, acc, 1000 / TICK_HZ, 1);

  check(w.lives === 0, 'lives floor at zero, never negative', `lives=${w.lives}`);
  check(w.phase === 'lost', 'and the run ends');
}

// ---------------------------------------------------------------------------
// THE V3 GATE: the endless arc.
//
// Composition wraps around the table; difficulty does not. That split is the
// whole mechanism — wrap the RNG stream too and wave 25 would be a byte-
// identical replay of wave 13, jitter and lane deal included, and the board
// would visibly loop. Scaling on the true index is also what makes this a
// terminator rather than a missing one: a versus match ends when a core does,
// because compounding hp eventually beats every defence.
section('versus — V3 gate: the endless arc');

const ENDLESS: Rules = { ...DEFAULT_RULES, endless: true };

{
  check(waveCount() === WAVES.length, 'a finite arc still counts its table', `${waveCount()} waves`);
  check(waveCount(ENDLESS) === Infinity, 'an endless arc never runs out');

  const far = 40;
  check(
    JSON.stringify(planWave(4242, far, ENDLESS)) === JSON.stringify(planWave(4242, far, ENDLESS)),
    'a wave past the table is still a pure function of (seed, index)',
    `wave ${far + 1}`,
  );
  check(
    planWave(4242, far, ENDLESS).length > 0,
    'and it is not empty, the way a finite arc past its end is',
  );
  check(
    planWave(4242, far, DEFAULT_RULES).length === 0,
    'the finite arc is unchanged past its end',
  );

  // Same shape, different roll: composition repeats, the arrival pattern does
  // not. Comparing the enemy sequence catches the wrap; comparing the whole
  // plan would fail on jitter, which is the point.
  const shapeOf = (i: number): string => planWave(4242, i, ENDLESS).map((s) => s.enemy).join(',');
  const timesOf = (i: number): string => planWave(4242, i, ENDLESS).map((s) => s.at.toFixed(4)).join(',');
  const wrapped = WAVES.length * 4;
  check(shapeOf(wrapped) === shapeOf(0), 'composition wraps around the table', `wave ${wrapped + 1} draws wave 1's shape`);
  check(timesOf(wrapped) !== timesOf(0), 'but the arrival pattern does not repeat');

  const scale = planWave(4242, far, ENDLESS)[0]!.hp / planWave(4242, 0, ENDLESS)[0]!.hp;
  const expected = Math.pow(BALANCE.hpGrowth, far);
  check(
    Math.abs(scale - expected) / expected < 0.02,
    'hp compounds on the true index, not the wrapped one',
    `wave ${far + 1} is ${scale.toExponential(2)}x wave 1`,
  );
}

{
  // No won state at all. An endless run that kills everything must keep going
  // rather than declaring victory at the end of the table.
  const w = createWorld(map, 4242, ENDLESS);
  const acc: Accumulator = { debt: 0 };
  for (let i = 0; i < 60 * 600 && w.phase === 'playing'; i++) {
    advance(w, acc, 1000 / TICK_HZ, 1);
    for (const c of w.creeps) c.dead = true;
    w.events.length = 0;
  }
  check(w.phase === 'playing', 'killing everything never wins an endless arc', `phase=${w.phase}`);
  check(w.wave.phase !== 'done', 'and the wave machine never parks', `wave phase=${w.wave.phase}`);
  check(
    w.wave.index > WAVES.length,
    'it is past the end of the table and still dispatching',
    `wave ${w.wave.index + 1} of a ${WAVES.length}-wave table`,
  );
}

// The horizon probe. Not an assertion about a number — the assertion is that a
// horizon *exists*, which is what makes "endless" a terminator rather than a
// stalemate. The figure is printed so a balance change that moves it is visible
// rather than silent.
{
  const build: TowerId[] = ['nova', 'lance', 'singularity', 'arc', 'filament'];
  const w = createWorld(map, 4242, ENDLESS);
  w.money = 1_000_000;
  w.wave.index = 6; // past every unlockWave, so the whole roster places
  const spots = rankedSpots(Math.max(...build.map((b) => TOWERS[b].range))).slice(0, 20);
  spots.forEach(([col, row], i) => {
    w.commands.push({ type: 'placeTower', defId: build[i % build.length]!, col, row });
  });
  stepWorld(w, DT);
  const placed = w.towers.length;

  // Every path upgraded to the ceiling, so this is a genuinely strong defence
  // and the horizon it measures is an upper bound rather than a typical run.
  for (const t of w.towers) {
    for (const path of ['damage', 'range', 'effect'] as const) {
      for (let tier = 1; tier < BALANCE.upgrade.maxTier; tier++) {
        w.commands.push({ type: 'upgradeTower', id: t.id, path });
      }
    }
  }
  stepWorld(w, DT);

  w.wave.index = 0;
  const acc: Accumulator = { debt: 0 };
  for (let i = 0; i < 60 * 3_600 && w.phase === 'playing'; i++) {
    advance(w, acc, 1000 / TICK_HZ, 1);
    w.events.length = 0;
  }

  check(
    w.phase === 'lost',
    'a fully upgraded defence eventually falls to the endless arc',
    `${placed} stations, all paths Mk ${BALANCE.upgrade.maxTier}`,
  );
  check(
    w.wave.index >= WAVES.length,
    'and it survives past the end of the authored table first',
    `fell on wave ${w.wave.index + 1} at ${(w.time / 60).toFixed(1)} min`,
  );
}

// ---------------------------------------------------------------------------
// THE V4 GATE: Front Line's two lanes have to stay two questions.
//
// The board's whole read is "which of their two defences is thinner", and that
// only exists while covering both lanes is materially worse than committing to
// one. Fork encodes the same rule by blocking its centre pocket; this measures
// it, because on a board with a waist the offending tile is not somewhere you
// would think to look. The arithmetic below is what chose the scenery — the
// second assertion runs the same measurement on the board with the blocks
// removed and requires it to *fail*, so the plug can never be tidied away as
// decoration.
section('versus — V4 gate: Front Line coverage');

{
  const MAX_RANGE =
    Math.max(...TOWER_IDS.map((id) => TOWERS[id].range)) *
    Math.pow(BALANCE.upgrade.rangeFactor, BALANCE.upgrade.maxTier - 1);

  /** The tiles one lane walks on the board, dropping the off-board lead-in. */
  const laneTiles = (route: { waypoints: readonly { x: number; y: number }[] }): Set<string> => {
    const out = new Set<string>();
    for (let i = 2; i < route.waypoints.length; i++) {
      const a = route.waypoints[i - 1]!;
      const b = route.waypoints[i]!;
      const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      for (let s = 0; s <= steps; s++) {
        const [c, r] = tileOf({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
        out.add(`${c},${r}`);
      }
    }
    return out;
  };

  const exclusive = (own: Set<string>, other: Set<string>): [number, number][] =>
    [...own].filter((k) => !other.has(k)).map((k) => k.split(',').map(Number) as [number, number]);

  const score = (src: MapSource): { hedge: number; commit: number; at: string } => {
    const m = parseMap(src);
    const [a, b] = m.routes.map(laneTiles) as [Set<string>, Set<string>];
    const aOnly = exclusive(a, b);
    const bOnly = exclusive(b, a);

    let hedge = 0;
    let commit = 0;
    let at = '';
    for (let row = 0; row < m.rows; row++) {
      for (let col = 0; col < m.cols; col++) {
        if (!isBuildableTile(m, col, row)) continue;
        const covers = (list: [number, number][]): number =>
          list.filter(([c, r]) => (c - col) ** 2 + (r - row) ** 2 <= MAX_RANGE ** 2).length;
        const ca = covers(aOnly);
        const cb = covers(bOnly);
        if (Math.min(ca, cb) > hedge) {
          hedge = Math.min(ca, cb);
          at = `${col},${row}`;
        }
        commit = Math.max(commit, ca, cb);
      }
    }
    return { hedge, commit, at };
  };

  const shipped = score(VERSUS);
  check(
    shipped.commit > 2 * shipped.hedge,
    'committing to one lane beats hedging both',
    `commit ${shipped.commit} vs hedge ${shipped.hedge} @ ${shipped.at} — ${(shipped.commit / shipped.hedge).toFixed(2)}x at range ${MAX_RANGE.toFixed(2)}`,
  );

  // Same board, scenery removed. This must FAIL the rule above, or the scenery
  // is not doing the job its comment claims and is merely decoration.
  const bare = score({ ...VERSUS, rows: VERSUS.rows.map((r) => r.replace(/x/g, '.')) });
  check(
    !(bare.commit > 2 * bare.hedge),
    'and the scenery is what buys that, not the lane shapes',
    `bare board: commit ${bare.commit} vs hedge ${bare.hedge} @ ${bare.at} — ${(bare.commit / bare.hedge).toFixed(2)}x`,
  );

  // Both lanes must stay worth defending on their own terms. A lane no tile can
  // cover well is a lane every sortie goes down, and the read collapses again.
  const m = parseMap(VERSUS);
  const [crest, trough] = m.routes.map(laneTiles) as [Set<string>, Set<string>];
  const bestFor = (own: Set<string>, other: Set<string>): number => {
    const tiles = exclusive(own, other);
    let best = 0;
    for (let row = 0; row < m.rows; row++) {
      for (let col = 0; col < m.cols; col++) {
        if (!isBuildableTile(m, col, row)) continue;
        best = Math.max(
          best,
          tiles.filter(([c, r]) => (c - col) ** 2 + (r - row) ** 2 <= MAX_RANGE ** 2).length,
        );
      }
    }
    return best;
  };
  const bc = bestFor(crest, trough);
  const bt = bestFor(trough, crest);
  check(
    Math.min(bc, bt) >= 10 && Math.abs(bc - bt) <= 3,
    'neither lane is the obviously weaker one to send down',
    `crest best ${bc}, trough best ${bt}`,
  );
}

// ---------------------------------------------------------------------------
// THE V5 GATE: the era ladder.
//
// One purchase does two things — it opens a station and it raises the upgrade
// ceiling on every station already standing. Both halves are asserted here,
// along with the property that makes the ladder a tempo decision rather than a
// shop: the campaign must not be able to see any of it.
section('versus — V5 gate: eras');

const VERSUS_RULES = versusRules(VERSUS_LEVEL, 'standard');
const versusWorld = (): ReturnType<typeof createWorld> =>
  createWorld(parseMap(VERSUS), 4242, VERSUS_RULES);

{
  // -------------------------------------------------------------------------
  // TWO CLIENTS IN ONE ROOM MUST BOOT ONE RULE SET.
  //
  // This is the shape of a bug that shipped. Each client decided versus-or-race
  // from its OWN URL and nothing reconciled the two, so a room could hold one
  // player on each. The server knew the room's mode all along and used it to
  // settle; it simply never told anyone. `start` carries it now.
  //
  // What follows is why that was not cosmetic. Eras cap the upgrade ceiling at
  // the current rung, so at era I a versus world can buy NO upgrade at all
  // while a race world can buy every one of them. The player on the wrong side
  // of the split reported it as "the joiner cannot upgrade towers", which is
  // exactly what it looked like from inside.
  //
  // The wire itself is not reachable from here, so this gates the consequence:
  // if the two rule sets ever stop differing this way the note above is stale,
  // and while they do differ, mode has to keep arriving from one place.
  // -------------------------------------------------------------------------
  const raceAtEra1 = createWorld(parseMap(VERSUS), 4242, resolveRules(VERSUS_LEVEL, 'standard'));
  const versusAtEra1 = versusWorld();
  raceAtEra1.money = 100_000;
  versusAtEra1.money = 100_000;

  check(
    raceAtEra1.era === versusAtEra1.era,
    'race and versus start on the same rung',
    `race ${raceAtEra1.era} · versus ${versusAtEra1.era}`,
  );
  check(
    tierCeiling(versusAtEra1) === 1 && tierCeiling(raceAtEra1) === BALANCE.upgrade.maxTier,
    'and the same rung means different ceilings',
    `versus ${tierCeiling(versusAtEra1)} · race ${tierCeiling(raceAtEra1)}`,
  );

  // The damage, stated as the player met it: same board, same money, same
  // station, one client can upgrade and the other cannot.
  const placeLance = (w: ReturnType<typeof createWorld>): Tower => {
    w.commands.push({ type: 'placeTower', defId: 'lance', col: 10, row: 2 });
    stepWorld(w, DT);
    return w.towers[0]!;
  };
  const raceTower = placeLance(raceAtEra1);
  const versusTower = placeLance(versusAtEra1);
  check(
    upgradeError(raceAtEra1, raceTower, 'range') === null,
    'a race client can upgrade at era I',
    String(upgradeError(raceAtEra1, raceTower, 'range')),
  );
  check(
    upgradeError(versusAtEra1, versusTower, 'range') === 'maxTier',
    'and a versus client cannot — so mode may not be decided per-client',
    String(upgradeError(versusAtEra1, versusTower, 'range')),
  );
}

{
  // Every station sits on exactly one rung, the roster is spread across all
  // three, and era I can build something — a ladder whose first rung is empty
  // is a mode that opens on a board you cannot defend.
  const eras = TOWER_IDS.map((id) => TOWERS[id].era);
  check(
    eras.every((e) => Number.isInteger(e) && e >= 1 && e <= BALANCE.upgrade.maxTier),
    'every station names a real era',
    TOWER_IDS.map((id) => `${id}=${TOWERS[id].era}`).join(' '),
  );
  check(
    new Set(eras).size === BALANCE.upgrade.maxTier,
    'the roster spans every rung',
    `${new Set(eras).size} of ${BALANCE.upgrade.maxTier} rungs used`,
  );
  check(
    eras.filter((e) => e === 1).length >= 2,
    'era I can build more than one thing',
    `${eras.filter((e) => e === 1).length} stations at era I`,
  );
  check(
    BALANCE.eras.advanceCost.length === BALANCE.upgrade.maxTier - 1,
    'there is a price for every rung above the first',
  );
  check(
    BALANCE.eras.advanceCost.every((c, i) => i === 0 || c > BALANCE.eras.advanceCost[i - 1]!),
    'and the ladder gets more expensive as it goes',
    BALANCE.eras.advanceCost.join(' → '),
  );
}

{
  // The campaign cannot see the ladder at all: same world, same stations, and
  // `advanceEra` is refused out loud rather than silently doing nothing.
  const w = createWorld(map, 4242);
  w.money = 1_000_000;
  check(tierCeiling(w) === BALANCE.upgrade.maxTier, 'a campaign world is never era-capped');
  check(advanceEraCost(w) === null, 'and has no era to buy');

  w.commands.push({ type: 'advanceEra' });
  stepWorld(w, DT);
  const rejected = w.events.find((e) => e.type === 'eraRejected');
  check(
    rejected?.type === 'eraRejected' && rejected.reason === 'noEras',
    'advanceEra on a campaign board is refused out loud',
    rejected?.type === 'eraRejected' ? rejected.reason : 'no event',
  );
  check(w.era === 1, 'and changes nothing', `era=${w.era}`);
}

{
  // Station gating: era N opens exactly the stations that named era N or less,
  // and nothing above it, whatever the wave clock says.
  const w = versusWorld();
  // Deliberately past every `unlockWave`. Under eras the wave clock must not
  // be able to open a station on its own — if it can, the two gates are racing
  // and the campaign's schedule is quietly still in charge.
  w.wave.index = 20;

  for (let era = 1; era <= BALANCE.upgrade.maxTier; era++) {
    w.era = era;
    const open = TOWER_IDS.filter((id) => isUnlocked(w, id));
    const expected = TOWER_IDS.filter((id) => TOWERS[id].era <= era);
    check(
      JSON.stringify(open) === JSON.stringify(expected),
      `era ${era} opens exactly its own rung and below`,
      `${open.join(', ') || '(none)'}`,
    );
  }
}

{
  // The upgrade ceiling moves with the era, and it moves for stations that
  // were already standing — that second half is what makes the purchase a
  // tempo decision instead of a shop.
  const w = versusWorld();
  w.money = 1_000_000;
  const spot = rankedSpots(TOWERS['lance'].range).find(
    ([c, r]: readonly [number, number]) => placementError(w, 'lance', c, r) === null,
  )!;
  w.commands.push({ type: 'placeTower', defId: 'lance', col: spot[0], row: spot[1] });
  stepWorld(w, DT);
  const t = w.towers[0]!;

  check(tierCeiling(w) === 1, 'era I caps every path at Mk I', `ceiling=${tierCeiling(w)}`);
  w.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
  stepWorld(w, DT);
  check(t.tiers.damage === 1, 'so an upgrade at era I is refused', `tier=${t.tiers.damage}`);
  check(
    upgradeCost(t, 'damage', tierCeiling(w)) === null,
    'and the inspector prices it as unavailable',
  );

  const before = w.money;
  w.commands.push({ type: 'advanceEra' });
  stepWorld(w, DT);
  const advanced = w.events.find((e) => e.type === 'eraAdvanced');
  check(w.era === 2, 'buying an era advances exactly one rung', `era=${w.era}`);
  check(
    advanced?.type === 'eraAdvanced' && advanced.cost === BALANCE.eras.advanceCost[0],
    'the event names what it cost',
    advanced?.type === 'eraAdvanced' ? `$${advanced.cost}` : 'no event',
  );
  check(
    w.money === before - BALANCE.eras.advanceCost[0]! && w.eraSpent === BALANCE.eras.advanceCost[0],
    'and the money actually left',
    `$${before} → $${w.money}, sunk $${w.eraSpent}`,
  );

  check(tierCeiling(w) === 2, 'the ceiling rose with it');
  w.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
  stepWorld(w, DT);
  check(
    t.tiers.damage === 2,
    'a station built before the advance can now be upgraded',
    `tier=${t.tiers.damage}`,
  );
}

{
  // Poverty and the top of the ladder are both refusals, and they say
  // different things — a player who cannot afford it and one who has bought
  // everything are not in the same situation.
  const w = versusWorld();
  w.money = 0;
  w.commands.push({ type: 'advanceEra' });
  stepWorld(w, DT);
  const poor = w.events.find((e) => e.type === 'eraRejected');
  check(
    poor?.type === 'eraRejected' && poor.reason === 'tooPoor',
    'an era you cannot afford is refused as tooPoor',
    poor?.type === 'eraRejected' ? poor.reason : 'no event',
  );
  check(w.era === 1 && w.money === 0, 'and costs nothing', `era=${w.era} $${w.money}`);

  w.money = 1_000_000;
  for (let i = 0; i < BALANCE.upgrade.maxTier + 3; i++) {
    w.commands.push({ type: 'advanceEra' });
    stepWorld(w, DT);
    w.events.length = 0;
  }
  check(w.era === BALANCE.upgrade.maxTier, 'the ladder stops at the top', `era=${w.era}`);
  check(
    w.eraSpent === BALANCE.eras.advanceCost.reduce((a, b) => a + b, 0),
    'having charged for each rung exactly once',
    `$${w.eraSpent}`,
  );

  w.commands.push({ type: 'advanceEra' });
  stepWorld(w, DT);
  const maxed = w.events.find((e) => e.type === 'eraRejected');
  check(
    maxed?.type === 'eraRejected' && maxed.reason === 'maxEra',
    'and says so, rather than charging for nothing',
    maxed?.type === 'eraRejected' ? maxed.reason : 'no event',
  );
}

{
  // Re-validated on the tick, not trusted from the click. This is the largest
  // single spend in the mode and the wave spawning underneath it is exactly
  // what can empty the bank between the two.
  const w = versusWorld();
  w.money = BALANCE.eras.advanceCost[0]!;
  w.commands.push({ type: 'advanceEra' }, { type: 'advanceEra' });
  stepWorld(w, DT);
  check(w.era === 2, 'two advances queued on one tick buy exactly one', `era=${w.era}`);
  check(w.money === 0, 'and the second is refused for want of money', `$${w.money}`);
}

// ---------------------------------------------------------------------------
// THE V6 GATE: the sortie economy.
//
// Two rules do all the anti-degenerate work and they are symmetric: the
// defender collects the bounty for killing a sortie, and the sender collects a
// kickback when one lands. Everything below is a way of asserting that those
// two swings are real, opposite, and cannot be gamed into a free lunch.
section('versus — V6 gate: sorties');

{
  // Roster shape, before any money moves. A rung with nothing to send is an
  // era you would never buy for offence, which would quietly make the ladder
  // half decorative.
  const eras = SORTIE_IDS.map((id) => SORTIES[id].era);
  check(
    new Set(eras).size === BALANCE.upgrade.maxTier,
    'the sortie table spans every rung',
    SORTIE_IDS.map((id) => `${id}=${SORTIES[id].era}`).join(' '),
  );
  check(
    [1, 2, 3].every((e) => eras.some((x) => x === e)),
    'and every rung has something to send',
  );
  check(
    SORTIE_IDS.every((id) => SORTIES[id].weight >= 1),
    'no sortie is worth less than a leak',
  );
  check(
    SORTIE_IDS.some((id) => SORTIES[id].weight > 1),
    'and at least one is worth more, or the deck has no expensive end',
    SORTIE_IDS.map((id) => `${id}×${SORTIES[id].weight}`).join(' '),
  );
  check(
    BALANCE.sortie.markup > 1,
    'a sortie costs more than the bounty it hands over',
    `markup ${BALANCE.sortie.markup}`,
  );
  check(
    BALANCE.sortie.kickback > 0 && BALANCE.sortie.kickback < 1,
    'and landing pays back some of the price, never all of it',
    `kickback ${BALANCE.sortie.kickback}`,
  );
}

{
  // The campaign has no deck at all, and says so rather than dropping the
  // command.
  const w = createWorld(map, 4242);
  w.money = 1_000_000;
  w.commands.push({ type: 'sortie', sortie: 'drifter', lane: 0 });
  stepWorld(w, DT);
  const ev = w.events.find((e) => e.type === 'sortieRejected');
  check(
    ev?.type === 'sortieRejected' && ev.reason === 'noSorties',
    'a sortie on a campaign board is refused out loud',
    ev?.type === 'sortieRejected' ? ev.reason : 'no event',
  );
  check(w.creeps.length === 0, 'and puts nothing on the board');
}

{
  // Era gating on the offensive half, mirroring the station gate.
  const w = versusWorld();
  w.money = 1_000_000;
  for (let era = 1; era <= BALANCE.upgrade.maxTier; era++) {
    w.era = era;
    const open = SORTIE_IDS.filter((id) => sortieUnlocked(w, id));
    const expected = SORTIE_IDS.filter((id) => SORTIES[id].era <= era);
    check(
      JSON.stringify(open) === JSON.stringify(expected),
      `era ${era} can send exactly its own rung and below`,
      open.join(', '),
    );
  }
  w.era = 1;
  w.commands.push({ type: 'sortie', sortie: 'monolith', lane: 0 });
  stepWorld(w, DT);
  const ev = w.events.find((e) => e.type === 'sortieRejected');
  check(
    ev?.type === 'sortieRejected' && ev.reason === 'locked',
    'sending above your era is refused as locked',
    ev?.type === 'sortieRejected' ? ev.reason : 'no event',
  );
}

{
  // Launch charges, names its price, and puts nothing on the sender's board.
  // That last one is the whole shape of the mechanic: `sortie` and `inbound`
  // run in different worlds, and collapsing them would give the sim a notion
  // of which side of the wire it is on.
  const w = versusWorld();
  w.money = 1_000_000;
  const price = sortieCost('drifter', w.wave.index, w);
  const before = w.money;

  w.commands.push({ type: 'sortie', sortie: 'drifter', lane: 1 });
  stepWorld(w, DT);
  const launched = w.events.find((e) => e.type === 'sortieLaunched');

  check(launched?.type === 'sortieLaunched', 'launching emits an event');
  check(
    launched?.type === 'sortieLaunched' && launched.cost === price,
    'the event names the price that was charged',
    launched?.type === 'sortieLaunched' ? `$${launched.cost} vs $${price}` : '-',
  );
  check(w.money === before - price, 'and the money left', `$${before} → $${w.money}`);
  check(w.creeps.length === 0, 'nothing appears on the sender’s own board');
  check(
    w.stats.sortiesSent === 1 && w.stats.sortieSpend === price,
    'the run tallies it',
    `${w.stats.sortiesSent} sent, $${w.stats.sortieSpend}`,
  );
  check(
    launched?.type === 'sortieLaunched' && launched.lane === 1,
    'the lane the player picked is the lane on the wire',
  );
}

{
  // Arrival: on the chosen lane, at midfield, scaled to the receiving board,
  // costing its weight and paying its kickback to nobody here.
  const w = versusWorld();
  const kick = 99;
  w.commands.push({ type: 'inbound', sortie: 'monolith', lane: 1, kickback: kick });
  stepWorld(w, DT);

  const c = w.creeps[0]!;
  check(w.creeps.length === 1 && c.defId === 'monolith', 'an inbound sortie spawns');
  check(c.origin === 'sortie', 'tagged as a sortie, so it never holds a wave open');
  check(c.route === 1, 'on the lane it was sent down', `route=${c.route}`);
  check(c.leakDamage === SORTIES['monolith'].weight, 'carrying its table weight', `×${c.leakDamage}`);
  check(c.kickback === kick, 'and the kickback it owes its sender', `$${c.kickback}`);

  const scaled = scaledStats('monolith', w.wave.index, w.rules);
  check(
    c.maxHp === scaled.hp && c.bounty === scaled.bounty,
    'scaled to the board it landed on, not the one it was bought on',
    `hp=${c.maxHp} bounty=${c.bounty}`,
  );

  // A lane the map does not have is clamped, never dropped — somebody paid for
  // this contact and silently eating it is the worst possible handling.
  const w2 = versusWorld();
  w2.commands.push({ type: 'inbound', sortie: 'drifter', lane: 99, kickback: 0 });
  stepWorld(w2, DT);
  check(
    w2.creeps.length === 1 && w2.creeps[0]!.route === w2.map.routes.length - 1,
    'an impossible lane is clamped rather than dropped',
    `route=${w2.creeps[0]?.route}`,
  );
}

{
  // Killing a sortie pays the defender exactly its bounty — the anti-spam
  // valve — and pays the sender nothing.
  const w = versusWorld();
  w.wave.phase = 'done';
  w.commands.push({ type: 'inbound', sortie: 'drifter', lane: 0, kickback: 50 });
  stepWorld(w, DT);
  const c = w.creeps[0]!;
  const before = w.money;
  damageCreep(w, c, 1_000_000);
  stepWorld(w, DT);

  check(w.money === before + c.bounty, 'the defender is paid the bounty', `+$${w.money - before}`);
  check(
    !w.events.some((e) => e.type === 'sortieLanded'),
    'and a killed sortie pays its sender nothing',
  );
}

{
  // Landing: costs the defender its weight in lives, and reports the kickback
  // outward rather than crediting the world it landed on. A sortie that paid
  // the person it just hit would be the exact inverse of the intended rule.
  const w = versusWorld();
  w.wave.phase = 'done';
  const acc: Accumulator = { debt: 0 };
  w.commands.push({ type: 'inbound', sortie: 'monolith', lane: 0, kickback: 77 });
  stepWorld(w, DT);

  const lives = w.lives;
  const money = w.money;
  let landed: Extract<SimEvent, { type: 'sortieLanded' }> | undefined;
  while (landed === undefined && w.time < 200) {
    advance(w, acc, 1000 / TICK_HZ, 1);
    for (const e of w.events) if (e.type === 'sortieLanded') landed = e;
    w.events.length = 0;
  }

  check(landed !== undefined, 'a sortie that reaches the core reports it');
  check(
    w.lives === lives - SORTIES['monolith'].weight,
    'costing the defender its full weight',
    `${lives} → ${w.lives}`,
  );
  check(w.money === money, 'the defender is not paid for being hit', `$${w.money}`);
  check(landed?.kickback === 77, 'and the kickback rides out on the event', `$${landed?.kickback}`);
  check(w.stats.sortiesTaken === 1, 'tallied apart from ordinary leaks', `taken=${w.stats.sortiesTaken}`);
  check(w.stats.leaks === 1, 'though it is still a leak', `leaks=${w.stats.leaks}`);
}

{
  // The full round trip, the way the loopback and the relay both drive it:
  // launch → inbound → land → credit. The figures either close or they don't.
  const w = versusWorld();
  w.wave.phase = 'done';
  w.money = 1_000_000;
  const acc: Accumulator = { debt: 0 };
  const opened = w.money;

  w.commands.push({ type: 'sortie', sortie: 'drifter', lane: 0 });
  stepWorld(w, DT);
  const launch = w.events.find((e) => e.type === 'sortieLaunched')!;
  const cost = launch.type === 'sortieLaunched' ? launch.cost : 0;
  const kick = launch.type === 'sortieLaunched' ? launch.kickback : 0;
  w.events.length = 0;

  w.commands.push({ type: 'inbound', sortie: 'drifter', lane: 0, kickback: kick });
  let credited = false;
  while (!credited && w.time < 200) {
    advance(w, acc, 1000 / TICK_HZ, 1);
    for (const e of w.events) {
      if (e.type === 'sortieLanded') w.commands.push({ type: 'creditSortie', amount: e.kickback });
    }
    if (w.stats.sortieEarned > 0) credited = true;
    w.events.length = 0;
  }

  check(credited, 'the loopback closes: launch → inbound → land → credit');
  check(
    kick === Math.round(cost * BALANCE.sortie.kickback),
    'the kickback is the configured fraction of the price',
    `$${kick} of $${cost}`,
  );
  // Bought for `cost`, got `kick` back, and took the hit itself because in a
  // loopback the sender is also the receiver. The net is what a real sender
  // pays for a landed sortie, and it must be a loss — aggression is never free.
  check(
    w.money === opened - cost + kick && kick < cost,
    'a landed sortie still costs its sender, net',
    `$${opened} → $${w.money}, net -$${opened - w.money}`,
  );
}

{
  // The economic invariant the whole design rests on: **spam into a wall is a
  // transfer to your opponent.** Sending N contacts and having every one of
  // them die must leave the sender down more than the defender is up.
  const w = versusWorld();
  w.money = 1_000_000;
  let spent = 0;
  let paid = 0;
  for (let i = 0; i < 12; i++) {
    w.commands.push({ type: 'sortie', sortie: 'drifter', lane: i % 2 });
    stepWorld(w, DT);
    for (const e of w.events) {
      if (e.type === 'sortieLaunched') {
        spent += e.cost;
        // Straight into a defence that kills everything: the receiving world
        // collects the bounty and the sender collects nothing.
        w.commands.push({ type: 'inbound', sortie: e.sortie, lane: e.lane, kickback: e.kickback });
      }
    }
    w.events.length = 0;
    stepWorld(w, DT);
    for (const c of w.creeps) {
      if (c.origin === 'sortie' && !c.dead) {
        paid += c.bounty;
        damageCreep(w, c, 1_000_000);
      }
    }
    stepWorld(w, DT);
    w.events.length = 0;
  }
  check(
    spent > paid,
    'twelve sorties into a wall cost the sender more than they pay the defender',
    `spent $${spent}, handed over $${paid} — ratio ${(spent / paid).toFixed(2)}`,
  );
  check(
    Math.abs(spent / paid - BALANCE.sortie.markup) < 0.05,
    'and the ratio is the configured markup',
    `${(spent / paid).toFixed(2)} vs ${BALANCE.sortie.markup}`,
  );
}

{
  // Sorties must not disturb the wave machine, however many are walking. This
  // is V1's gate re-run through the real command path rather than a hand-placed
  // creep, because that path is what a match will actually use.
  const w = versusWorld();
  w.lives = 1_000_000;
  w.commands.push({ type: 'startWave' });
  while (w.wave.dispatchedThrough < 0) stepWorld(w, DT);
  for (let i = 0; i < 6; i++) {
    w.commands.push({ type: 'inbound', sortie: 'monolith', lane: i % 2, kickback: 10 });
  }
  stepWorld(w, DT);
  for (const c of w.creeps) if (c.origin === 'wave') c.dead = true;

  let reward = 0;
  for (let i = 0; i < 60 * 5; i++) {
    stepWorld(w, DT);
    for (const e of w.events) if (e.type === 'waveCleared') reward += e.reward;
    w.events.length = 0;
  }
  check(
    w.wave.clearedThrough === 0 && reward === BALANCE.waveClearReward,
    'six Monolith sorties on the board do not stall wave settlement',
    `clearedThrough=${w.wave.clearedThrough}, paid $${reward}`,
  );
  check(
    w.creeps.filter((c) => c.origin === 'sortie').length === 6,
    'and they are all still walking',
    `${w.creeps.filter((c) => c.origin === 'sortie').length} alive`,
  );
}

// ---------------------------------------------------------------------------
// THE V7 GATE: the wire contract.
//
// Deliberately about *shape*, not about a running socket — a real match
// exercises the relay, and a headless test that stood one up would mostly be
// testing `ws`. What goes wrong silently, and is therefore checked here, is
// the contract: a frame losing a field in transit, a version skew that is not
// refused, or a round trip that does not close across two separate worlds.
section('versus — V7 gate: the wire');

{
  check(PROTOCOL_VERSION === 2, 'the protocol version was raised', `v${PROTOCOL_VERSION}`);

  // Encode → decode with every field intact. JSON drops `undefined` silently,
  // which is exactly how an optional field that should have been required goes
  // missing in a real match.
  const roundTrip = (msg: C2S | S2C): boolean =>
    JSON.stringify(decodeC2S(encode(msg))) === JSON.stringify(msg);

  const frames: (C2S | S2C)[] = [
    { t: 'sortie', sortie: 'monolith', lane: 1, kickback: 45 },
    { t: 'landed', kickback: 45 },
    { t: 'inbound', sortie: 'bulwark', lane: 0, kickback: 24 },
    { t: 'credit', amount: 24 },
    { t: 'status', wave: 7, lives: 12, elapsedMs: 91_000, era: 3 },
    { t: 'peer', wave: 7, lives: 12, elapsedMs: 91_000, era: 3 },
    { t: 'hello', v: PROTOCOL_VERSION, name: 'vega', mode: 'versus' },
    { t: 'result', winnerId: 'p2', standings: [], reason: 'core' },
  ];
  for (const f of frames) check(roundTrip(f), `${f.t} survives the wire intact`);

  // A sortie frame is self-contained on purpose: no tick, no timestamp, no
  // wave. Nothing in either world depends on the other's state, so there is
  // nothing two clocks could disagree about — and a wave number on the wire
  // would be a value one client could put anything into.
  const sortie = { t: 'sortie', sortie: 'drifter', lane: 0, kickback: 8 } as const;
  check(
    !('tick' in sortie) && !('wave' in sortie) && !('at' in sortie),
    'and carries no clock, because there is nothing to synchronise',
    Object.keys(sortie).join(', '),
  );
}

{
  // Every sortie the table can produce must name a lane the versus board has,
  // and survive as an id the receiver can look up. A frame naming a contact
  // the far side cannot resolve is the one wire failure that would spawn
  // nothing and say nothing.
  const m = parseMap(VERSUS);
  const ok = SORTIE_IDS.every((id) =>
    m.routes.every((_, lane) => {
      const decoded = decodeC2S(encode({ t: 'sortie', sortie: id, lane, kickback: 1 }));
      return (
        decoded?.t === 'sortie' &&
        Object.hasOwn(SORTIES, decoded.sortie) &&
        decoded.lane >= 0 &&
        decoded.lane < m.routes.length
      );
    }),
  );
  check(ok, 'every sortie × lane pair resolves on the far side', `${SORTIE_IDS.length} × ${m.routes.length}`);
}

{
  // The full relayed round trip across two *separate* worlds — the thing V6's
  // loopback could not test. Sender charges, receiver spawns and takes the
  // hit, sender collects. The relay is stubbed as a pair of function calls,
  // because that is precisely what the socket is.
  const sender = versusWorld();
  const receiver = versusWorld();
  receiver.wave.phase = 'done';
  sender.money = 1_000_000;
  // A Monolith is era III on both halves of the ladder. Without this the
  // launch is refused as `locked` and every figure below reads zero — which is
  // how this gate caught its own setup the first time it ran.
  sender.era = BALANCE.upgrade.maxTier;
  const opened = sender.money;
  const acc: Accumulator = { debt: 0 };

  // main.ts's relay, in miniature: launch → their inbound, land → our credit.
  const relay = (from: ReturnType<typeof createWorld>, to: ReturnType<typeof createWorld>): void => {
    for (const e of from.events) {
      if (e.type === 'sortieLaunched') {
        to.commands.push({ type: 'inbound', sortie: e.sortie, lane: e.lane, kickback: e.kickback });
      } else if (e.type === 'sortieLanded') {
        to.commands.push({ type: 'creditSortie', amount: e.kickback });
      }
    }
  };

  sender.commands.push({ type: 'sortie', sortie: 'monolith', lane: 1 });
  stepWorld(sender, DT);
  const launch = sender.events.find((e) => e.type === 'sortieLaunched');
  const cost = launch?.type === 'sortieLaunched' ? launch.cost : 0;
  relay(sender, receiver);
  sender.events.length = 0;

  check(cost > 0 && sender.money === opened - cost, 'the sender is charged on their own board', `-$${cost}`);
  check(sender.creeps.length === 0, 'and nothing spawns there');

  const theirLives = receiver.lives;
  for (let i = 0; i < 60 * 200 && receiver.lives === theirLives; i++) {
    advance(receiver, acc, 1000 / TICK_HZ, 1);
    relay(receiver, sender);
    receiver.events.length = 0;
  }
  stepWorld(sender, DT);

  check(
    receiver.lives === theirLives - SORTIES['monolith'].weight,
    'the receiver takes the full weight',
    `${theirLives} → ${receiver.lives}`,
  );
  check(
    receiver.stats.sortiesTaken === 1 && receiver.stats.sortieEarned === 0,
    'and is paid nothing for being hit',
    `$${receiver.stats.sortieEarned}`,
  );
  check(
    sender.stats.sortieEarned === Math.round(cost * BALANCE.sortie.kickback),
    'while the sender collects the kickback across the wire',
    `+$${sender.stats.sortieEarned} of $${cost}`,
  );
  check(
    sender.money < opened,
    'a landed sortie is still a net cost to whoever sent it',
    `$${opened} → $${sender.money}`,
  );
  check(
    sender.lives === sender.rules.startingLives,
    'and costs the sender no lives — the two boards are genuinely separate',
    `${sender.lives} lives`,
  );
}

// ---------------------------------------------------------------------------
// THE V8 GATE: the mode says what it is.
//
// Every screen in this game was written for a campaign sector, and versus is
// not one — it cannot be cleared, retried, or advanced from, and half its
// damage was bought by somebody. The copy gates below exist because that kind
// of wrongness is invisible to a typechecker and easy to ship: the results
// screen said "Race over" on a versus match through the whole of V7.
section('versus — V8 gate: what the screens say');

{
  // The leak event carries whether it was bought, so a consumer never has to
  // correlate two events to pick a voice. Asserted because the alternative —
  // reading the `sortieLanded` that follows — depends on the order they are
  // pushed in, and both the mixer and the renderer drain forward once.
  const w = versusWorld();
  w.wave.phase = 'done';
  const acc: Accumulator = { debt: 0 };
  w.commands.push({ type: 'inbound', sortie: 'bulwark', lane: 0, kickback: 12 });
  stepWorld(w, DT);

  let leak: Extract<SimEvent, { type: 'creepLeaked' }> | undefined;
  while (leak === undefined && w.time < 200) {
    advance(w, acc, 1000 / TICK_HZ, 1);
    for (const e of w.events) if (e.type === 'creepLeaked') leak = e;
    w.events.length = 0;
  }
  check(leak?.bought === true, 'a bought leak says so on the event itself');
  check(
    leak?.cost === SORTIES['bulwark'].weight,
    'and reports the weight it actually took',
    `cost=${leak?.cost}`,
  );

  const plain = createWorld(map, 4242);
  plain.wave.phase = 'done';
  const acc2: Accumulator = { debt: 0 };
  spawnCreep(plain, 'drifter');
  let ordinary: Extract<SimEvent, { type: 'creepLeaked' }> | undefined;
  while (ordinary === undefined && plain.time < 200) {
    advance(plain, acc2, 1000 / TICK_HZ, 1);
    for (const e of plain.events) if (e.type === 'creepLeaked') ordinary = e;
    plain.events.length = 0;
  }
  check(
    ordinary?.bought === false && ordinary?.cost === 1,
    'and an ordinary wave leak says the opposite',
    `bought=${ordinary?.bought} cost=${ordinary?.cost}`,
  );
}

{
  // The three sortie cues must be distinguishable from each other and from the
  // leak they sit beside. Checked as *properties* rather than literals, the
  // way the contact-ramp gates are: the send rises, the arrival falls, and the
  // bought breach sits under the ordinary one.
  const first = (s: typeof LEAK): { a: number; b: number } => {
    const l = s.layers[0]!;
    return { a: l.freq, b: l.freqEnd ?? l.freq };
  };
  const sent = first(SORTIE_SENT);
  const inbound = first(SORTIE_INBOUND);
  const landed = first(SORTIE_LANDED);
  const leak = first(LEAK);

  check(sent.b > sent.a, 'the send rises — the one thing you cause off-board', `${sent.a} → ${sent.b}`);
  check(inbound.b < inbound.a, 'the arrival falls', `${inbound.a} → ${inbound.b}`);
  check(
    landed.a < leak.a && landed.b < leak.b,
    'a bought breach sits under an ordinary one at both ends',
    `${landed.a}→${landed.b} vs leak ${leak.a}→${leak.b}`,
  );
  check(
    SORTIE_LANDED.priority === LEAK.priority,
    'and shares its priority band, because it is still a breach',
  );
  check(
    SORTIE_SENT.bus === 'ui' && SORTIE_LANDED.bus === 'impacts',
    'a purchase is UI, a breach is an impact',
  );
}

{
  // Word budget, the same rule the deck copy is already held to. These strings
  // are read while a wave is walking.
  const versusCopy = [
    'Core lost',
    'Play it again',
    'Their core went dark',
    'Your core went dark',
    'Sorties taken',
    'Still standing',
  ];
  check(
    versusCopy.every((c) => c.split(/\s+/).length <= 4),
    'every versus label is four words or fewer',
    versusCopy.map((c) => `${c.split(/\s+/).length}`).join(' '),
  );
  check(
    versusCopy.every((c) => !/sector/i.test(c)),
    'and none of them calls this a sector',
  );
}

{
  // The bonus must be payment for time actually forfeited, and nothing else.
  const w = createWorld(map, 4242);
  const beforeMoney = w.money;
  const secondsLeft = w.wave.timer;
  w.commands.push({ type: 'startWave' });
  stepWorld(w, DT);

  const rushed = w.events.find((e) => e.type === 'waveRushed');
  const expected = Math.round(secondsLeft * BALANCE.rushBonusPerSecond);
  check(rushed !== undefined, 'rushing emits an event');
  check(
    w.money === beforeMoney + expected,
    'the bonus matches the time forfeited',
    `${secondsLeft.toFixed(1)}s → +$${w.money - beforeMoney}`,
  );
}

{
  // Letting the timer run out must pay nothing, or the "bonus" is just income.
  const w = createWorld(map, 4242);
  const beforeMoney = w.money;
  let rushEvents = 0;
  while (w.wave.phase === 'intermission') {
    stepWorld(w, DT);
    for (const ev of w.events) if (ev.type === 'waveRushed') rushEvents++;
    w.events.length = 0;
  }
  check(rushEvents === 0 && w.money === beforeMoney, 'waiting it out earns no bonus', `$${w.money - beforeMoney}`);
}

{
  // Refusals must be audible. Silence here is exactly the bug that was reported.
  const w = createWorld(map, 4242);
  w.lives = 1_000_000;
  w.commands.push({ type: 'startWave' });
  stepWorld(w, DT);
  w.events.length = 0;

  w.commands.push({ type: 'startWave' });
  stepWorld(w, DT);
  const midSpawn = w.events.find((e) => e.type === 'waveRejected');
  check(
    midSpawn !== undefined && midSpawn.reason === 'spawning',
    'a wave sent mid-spawn is refused out loud',
    `phase=${w.wave.phase}`,
  );

  // Drive every wave out, then ask for one more.
  for (let i = 0; i < 400_000 && w.wave.phase !== 'done'; i++) {
    w.commands.push({ type: 'startWave' });
    stepWorld(w, DT);
    w.events.length = 0;
  }
  w.commands.push({ type: 'startWave' });
  stepWorld(w, DT);
  const exhausted = w.events.find((e) => e.type === 'waveRejected');
  check(
    exhausted !== undefined && exhausted.reason === 'done',
    'and so is one sent after the last wave',
  );
}

{
  // Victory is about the board being clear, not about the spawner being
  // finished. Under the old model those were the same thing; now they are not.
  const w = createWorld(map, 4242);
  w.lives = 1_000_000;
  for (let i = 0; i < 400_000 && w.wave.phase !== 'done'; i++) {
    w.commands.push({ type: 'startWave' });
    stepWorld(w, DT);
    w.events.length = 0;
  }
  check(w.creeps.length > 0, 'the last wave is dispatched with creeps still walking', `${w.creeps.length} alive`);
  check(w.phase === 'playing', 'and the match is NOT yet won');

  // Settling several stacked waves at once must pay for each exactly once.
  const clearedBefore = w.wave.clearedThrough;
  for (const c of w.creeps) c.dead = true;
  let cleared = 0;
  for (let i = 0; i < 60 && w.phase === 'playing'; i++) {
    stepWorld(w, DT);
    for (const ev of w.events) if (ev.type === 'waveCleared') cleared++;
    w.events.length = 0;
  }
  check(w.phase === 'won', 'clearing the board wins it');
  check(
    cleared === waveCount() - 1 - clearedBefore,
    'each stacked wave settles exactly once',
    `${cleared} waves settled together`,
  );
}

// ---------------------------------------------------------------------------
section('build — placement rules');

{
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';

  check(placementError(w, 'lance', 0, 0) === null, 'open ground accepts a tower');
  check(placementError(w, 'lance', 5, 2) === 'onRoute', 'the road refuses a tower');
  check(placementError(w, 'lance', 3, 5) === 'blocked', 'scenery refuses a tower');
  check(placementError(w, 'lance', -1, 0) === 'offBoard', 'off-board is rejected');
  check(placementError(w, 'lance', map.cols, 0) === 'offBoard', 'past the right edge is rejected');
  check(placementError(w, 'lance', 0.5, 0) === 'offBoard', 'a fractional tile is rejected');

  const before = w.money;
  w.commands.push({ type: 'placeTower', defId: 'lance', col: 0, row: 0 });
  stepWorld(w, DT);
  check(w.towers.length === 1, 'a valid command builds exactly one tower');
  check(w.money === before - TOWERS.lance.cost, 'the cost is deducted once', `$${before} → $${w.money}`);
  check(placementError(w, 'lance', 0, 0) === 'occupied', 'the tile is now occupied');

  // The same tile twice in one tick is the double-click case, and it must not
  // build two towers or charge twice.
  const moneyBefore = w.money;
  w.commands.push({ type: 'placeTower', defId: 'lance', col: 1, row: 1 });
  w.commands.push({ type: 'placeTower', defId: 'lance', col: 1, row: 1 });
  stepWorld(w, DT);
  check(w.towers.length === 2, 'a duplicate command in the same tick is rejected', `${w.towers.length} towers`);
  check(w.money === moneyBefore - TOWERS.lance.cost, 'and is not charged for');

  // Spend down to nothing and confirm the wallet cannot go negative.
  let built = 2;
  for (let col = 2; col < 20 && w.money >= 0; col++) {
    w.commands.push({ type: 'placeTower', defId: 'lance', col, row: 0 });
    stepWorld(w, DT);
    if (w.towers.length > built) built = w.towers.length;
  }
  check(w.money >= 0, 'money never goes negative', `$${w.money} after ${w.towers.length} towers`);
  check(placementError(w, 'nova', 21, 0) === 'tooPoor', 'unaffordable towers are refused');
}

// ---------------------------------------------------------------------------
// The placement ghost calls placementError and so does applyCommands. If they
// could disagree, the player would be shown a green tile that then refuses the
// build. Sweeping every tile proves they cannot.
section('build — the ghost cannot lie');

{
  let mismatches = 0;
  let legal = 0;
  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      const w = createWorld(map, 4242);
      w.wave.phase = 'done';
      const shown = placementError(w, 'lance', col, row) === null;
      w.commands.push({ type: 'placeTower', defId: 'lance', col, row });
      stepWorld(w, DT);
      const built = w.towers.length === 1;
      if (shown !== built) mismatches++;
      if (built) legal++;
    }
  }
  check(mismatches === 0, 'every tile agrees between ghost and sim', `${map.cols * map.rows} tiles swept`);
  check(legal === 339, 'the buildable tile count matches the map', `${legal} legal tiles`);
}

// ---------------------------------------------------------------------------
section('combat — the loop closes');

{
  // One Lance station beside the entry lane, one creep walking into it.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.money = 1000;
  w.commands.push({ type: 'placeTower', defId: 'lance', col: 3, row: 3 });
  stepWorld(w, DT);

  const c = spawnCreep(w, 'drifter');
  const startMoney = w.money;
  let sawProjectile = false;
  for (let i = 0; i < 60 * 30 && w.creeps.length > 0; i++) {
    stepWorld(w, DT);
    if (w.projectiles.length > 0) sawProjectile = true;
  }

  check(sawProjectile, 'a tower in range fires');
  check(c.dead && c.hp <= 0, 'the creep dies of damage, not of leaking', `hp=${c.hp}`);
  check(w.lives === BALANCE.startingLives, 'a killed creep never reaches the goal');
  check(w.money === startMoney + c.bounty, 'bounty is paid exactly once', `+$${w.money - startMoney}`);

  // The loop above exits the tick the contact dies, and a *piercing* shot
  // deliberately outlives its target — it carries on to the edge of reach. So
  // the property worth asserting is that nothing leaks, not that a shot
  // vanishes the instant its target does, which was only ever true of homing.
  for (let i = 0; i < 60 * 2; i++) stepWorld(w, DT);
  check(w.projectiles.length === 0, 'spent projectiles are swept up');
}

{
  // Overkill: many towers, one creep. The bounty must still be paid once, and
  // the death event must fire once, however many shots land on the same tick.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.money = 100_000;
  for (const [col, row] of [[6, 6], [8, 6], [6, 8], [8, 8], [7, 9], [5, 7]] as const) {
    w.commands.push({ type: 'placeTower', defId: 'nova', col, row });
  }
  stepWorld(w, DT);
  check(w.towers.length === 6, 'six towers cover one stretch of road');

  const c = spawnCreep(w, 'drifter');
  const before = w.money;
  let kills = 0;
  for (let i = 0; i < 60 * 30 && !c.dead; i++) {
    stepWorld(w, DT);
    for (const ev of w.events) if (ev.type === 'creepKilled') kills++;
    w.events.length = 0;
  }
  check(kills === 1, 'a creep dies exactly once under concentrated fire', `${kills} death events`);
  check(w.money === before + c.bounty, 'and pays exactly one bounty', `+$${w.money - before}`);
}

{
  // Fire rate must be exact. `cooldown = fireInterval` would round every
  // tower's rate up to a tick multiple and quietly falsify every balance
  // number; `cooldown += fireInterval` does not.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.money = 1000;
  w.commands.push({ type: 'placeTower', defId: 'lance', col: 3, row: 3 });
  stepWorld(w, DT);

  // A creep that cannot die and crawls, so it stays in range long enough to
  // measure many intervals rather than the three or four a normal-speed creep
  // allows. Timestamping every shot is the only way to see drift; a shot
  // *count* would pass even if the rate were wrong by a tick each time.
  const c = spawnCreep(w, 'drifter', { hp: 1e9, bounty: 0 });
  c.speed = 0.15;

  const shotTicks: number[] = [];
  for (let i = 0; i < 60 * 60; i++) {
    const before = w.projectiles.length;
    stepWorld(w, DT);
    if (w.projectiles.length > before) shotTicks.push(w.tick);
  }
  c.dead = true;

  const gaps: number[] = [];
  for (let i = 1; i < shotTicks.length; i++) gaps.push(shotTicks[i]! - shotTicks[i - 1]!);
  const idealTicks = TOWERS.lance.fireInterval / DT;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const worst = Math.max(...gaps.map((g) => Math.abs(g - idealTicks)));

  check(gaps.length > 30, 'the tower fired steadily', `${shotTicks.length} shots`);
  check(
    Math.abs(mean - idealTicks) < 0.05,
    'mean interval matches fireInterval — no drift',
    `${mean.toFixed(3)} ticks vs ${idealTicks} ideal`,
  );
  check(worst <= 1, 'and no individual gap is off by more than a tick', `worst ±${worst}`);
}

{
  // A tower that idles through an intermission must not bank cooldown and fire
  // a burst when the next wave arrives.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.money = 1000;
  w.commands.push({ type: 'placeTower', defId: 'nova', col: 3, row: 3 });
  stepWorld(w, DT);
  for (let i = 0; i < 60 * 30; i++) stepWorld(w, DT); // 30s with nothing to shoot

  const t = w.towers[0]!;
  check(t.cooldown === 0, 'an idle tower clamps its cooldown at zero', `cooldown=${t.cooldown}`);

  spawnCreep(w, 'drifter', { hp: 1e9, bounty: 0 });
  let shotsInFirstSecond = 0;
  for (let i = 0; i < 60; i++) {
    const before = w.projectiles.length;
    stepWorld(w, DT);
    if (w.projectiles.length > before) shotsInFirstSecond++;
  }
  check(shotsInFirstSecond <= 1, 'and does not burst when a target appears', `${shotsInFirstSecond} shots`);
}

{
  // No projectile may outlive its target's death or the flight guard.
  const w = createWorld(map, 4242);
  w.wave.phase = 'done';
  w.money = 1000;
  w.commands.push({ type: 'placeTower', defId: 'singularity', col: 3, row: 3 });
  stepWorld(w, DT);
  for (let i = 0; i < 6; i++) spawnCreep(w, 'drifter');
  for (let i = 0; i < 60 * 60; i++) stepWorld(w, DT);
  check(w.projectiles.length === 0, 'no projectile is left in flight', `${w.projectiles.length} stragglers`);
  check(w.creeps.length === 0, 'the board empties');
}

// ---------------------------------------------------------------------------
// M7's three identities. Each station now does something the others cannot, and
// these are the assertions that say so.
section('stations — pierce, splash, slow');

/** A station with no wave machine running, so the gate measures the mechanic. */
function stationWorld(defId: TowerId, col: number, row: number, seed = 909) {
  const w = createWorld(map, seed);
  w.wave.phase = 'done';
  w.money = 5000;
  w.commands.push({ type: 'placeTower', defId, col, row });
  stepWorld(w, DT);
  return { w, t: w.towers[0]! };
}

{
  // Lance pierces. Three contacts strung along the firing line: one shot must
  // damage all three, and each exactly once.
  const { w, t } = stationWorld('lance', 3, 3);
  const line = [0.8, 1.5, 2.2].map((d) => {
    const c = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
    c.x = t.x + d;
    c.y = t.y;
    return c;
  });

  t.cooldown = 0;
  for (let i = 0; i < 60; i++) stepWorld(w, DT);

  const dmg = TOWERS.lance.damage;
  const hurt = line.filter((c) => c.hp < c.maxHp).length;
  check(hurt === 3, 'one Lance shot reaches every contact in the line', `${hurt}/3`);
  check(
    line.every((c) => (c.maxHp - c.hp) % dmg === 0),
    'and damages each a whole number of times — never twice per pass',
  );
  check(TOWERS.lance.pierce === 2, 'pierce budget is 2 extra contacts', `${TOWERS.lance.pierce}`);
}

{
  // The budget is finite: a fourth contact in the same line must be untouched
  // by a shot that has already spent its two passes.
  const { w, t } = stationWorld('lance', 3, 3, 910);
  const line = [0.6, 1.1, 1.6, 2.1].map((d) => {
    const c = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
    c.x = t.x + d;
    c.y = t.y;
    return c;
  });

  t.cooldown = 0;
  stepWorld(w, DT);
  // Exactly one shot is in flight; run it out without letting the station refire.
  t.cooldown = 999;
  for (let i = 0; i < 60; i++) stepWorld(w, DT);

  const touched = line.filter((c) => c.hp < c.maxHp).length;
  check(touched === 3, 'a single shot stops after pierce is spent', `${touched} of 4 hit`);
}

{
  // Nova detonates. A cluster off to one side of the target must still take
  // damage, and less of it than the direct hit.
  const { w, t } = stationWorld('nova', 3, 3, 911);
  const direct = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
  direct.x = t.x + 1.5;
  direct.y = t.y;
  const near = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
  near.x = t.x + 1.5;
  near.y = t.y + 0.9;
  const far = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
  far.x = t.x + 1.5;
  far.y = t.y + 4;

  t.cooldown = 0;
  for (let i = 0; i < 120; i++) stepWorld(w, DT);

  check(direct.hp < direct.maxHp, 'Nova damages its target');
  check(near.hp < near.maxHp, 'and everything inside the blast');
  check(
    direct.maxHp - direct.hp > near.maxHp - near.hp,
    'with falloff — the rim takes less than the centre',
    `${direct.maxHp - direct.hp} vs ${near.maxHp - near.hp}`,
  );
  check(far.hp === far.maxHp, 'and nothing outside the radius');
}

{
  // Singularity slows. Same contact, same stretch, with and without a station.
  const travel = (withStation: boolean): number => {
    const w = createWorld(map, 912);
    w.wave.phase = 'done';
    if (withStation) {
      w.money = 5000;
      w.commands.push({ type: 'placeTower', defId: 'singularity', col: 3, row: 3 });
    }
    stepWorld(w, DT);
    const c = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
    for (let i = 0; i < 60 * 4; i++) stepWorld(w, DT);
    return c.progress;
  };

  const free = travel(false);
  const held = travel(true);
  check(held < free, 'a contact in a gravity well covers less ground', `${held.toFixed(2)} vs ${free.toFixed(2)} tiles`);
  check(
    TOWERS.singularity.slowFactor < 1 && TOWERS.singularity.slowSeconds > 0,
    'and the slow is real content, not a no-op',
    `x${TOWERS.singularity.slowFactor} for ${TOWERS.singularity.slowSeconds}s`,
  );
}

{
  // Slows refresh, never stack — two wells must not compound into a stop.
  const { w, t } = stationWorld('singularity', 3, 3, 913);
  w.commands.push({ type: 'placeTower', defId: 'singularity', col: 3, row: 5 });
  stepWorld(w, DT);

  const c = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
  c.x = t.x + 1;
  c.y = t.y + 1;
  for (let i = 0; i < 60; i++) stepWorld(w, DT);

  check(
    c.slowFactor >= TOWERS.singularity.slowFactor,
    'two wells do not compound below a single one',
    `x${c.slowFactor.toFixed(2)}`,
  );
  check(c.speed === ENEMIES[c.defId].speed, 'and base speed is never mutated', `${c.speed}`);
}

{
  // The slow must expire, or one hit would hold a contact forever.
  const { w, t } = stationWorld('singularity', 3, 3, 914);
  const c = spawnCreep(w, 'drifter', { hp: 1e6, bounty: 0 });
  c.x = t.x + 1;
  c.y = t.y;
  t.cooldown = 0;
  // Several ticks, not one: even at 40 tiles/sec a shot covers 0.67 tiles per
  // tick, so a contact a tile away is struck on the second tick at the earliest.
  for (let i = 0; i < 10; i++) stepWorld(w, DT);
  check(c.slowTimer > 0, 'a hit applies the slow', `${c.slowTimer.toFixed(2)}s left`);

  // Move it out of reach and let the timer run down.
  c.x = t.x + 40;
  for (let i = 0; i < 60 * 3; i++) stepWorld(w, DT);
  check(c.slowTimer === 0, 'and it expires', `${c.slowTimer}`);
  check(c.slowFactor === 1, 'leaving the factor reset so the fields cannot disagree');
}

// ---------------------------------------------------------------------------
section('stations — upgrade, sell, targeting');

{
  const w = createWorld(map, 77);
  w.wave.phase = 'done';
  w.money = 1000;
  w.commands.push({ type: 'placeTower', defId: 'lance', col: 3, row: 3 });
  stepWorld(w, DT);

  const t = w.towers[0]!;
  const base = TOWERS.lance;
  check(
    t.tiers.damage === 1 && t.tiers.range === 1 && t.tiers.effect === 1,
    'a new station is Mk I on all three paths',
  );
  check(t.spent === base.cost, 'and has its cost recorded', `$${t.spent}`);
  check(t.targeting === 'first', 'and targets the leader by default');

  const before = w.money;
  const cost = upgradeCost(t, 'damage')!;
  w.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
  stepWorld(w, DT);
  check(t.tiers.damage === 2, 'upgrading a path raises that path');
  check(
    t.stats.damage === damageAtTier('lance', 2),
    'and the damage',
    `${base.damage} → ${t.stats.damage}`,
  );
  check(w.money === before - cost, 'and charges exactly once', `−$${cost}`);
  check(t.spent === base.cost + cost, 'and adds to the sunk total', `$${t.spent}`);

  // The escalating curve is what stops stacking one path from dominating, so
  // it is worth asserting rather than trusting the formula.
  check(
    upgradeCost(t, 'damage')! > cost,
    'the next tier of a path costs more than the last',
    `$${cost} → $${upgradeCost(t, 'damage')!}`,
  );

  // The paths are independent: buying one must not move the others' stats,
  // costs, or tiers. This is the property the whole redesign is for.
  check(
    t.stats.range === base.range && t.stats.pierce === base.pierce,
    'a damage purchase leaves range and effect untouched',
  );
  check(
    upgradeCost(t, 'range')! === Math.round(base.cost * BALANCE.upgrade.costFactor),
    'and the other paths still price from their own tier',
    `$${upgradeCost(t, 'range')!}`,
  );

  const beforeRange = t.stats.range;
  w.commands.push({ type: 'upgradeTower', id: t.id, path: 'range' });
  stepWorld(w, DT);
  check(
    t.stats.range > beforeRange && t.tiers.range === 2,
    'a range purchase grows reach',
    `${beforeRange.toFixed(2)} → ${t.stats.range.toFixed(2)}`,
  );
  check(t.stats.damage === damageAtTier('lance', 2), 'without touching damage');

  const beforePierce = t.stats.pierce;
  w.commands.push({ type: 'upgradeTower', id: t.id, path: 'effect' });
  stepWorld(w, DT);
  check(
    t.stats.pierce === beforePierce + TOWERS.lance.effectUpgrade.perTier.pierce!,
    "an effect purchase deepens the station's mechanic",
    `pierce ${beforePierce} → ${t.stats.pierce}`,
  );
  check(t.stats.damage === damageAtTier('lance', 2), 'and also leaves damage alone');

  while (upgradeCost(t, 'damage') !== null) {
    w.money = 10_000;
    w.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
    stepWorld(w, DT);
  }
  check(
    t.tiers.damage === BALANCE.upgrade.maxTier,
    'a path stops at the ceiling',
    `damage Mk ${t.tiers.damage}`,
  );
  check(
    upgradeCost(t, 'effect') !== null,
    'while the other paths remain buyable',
    `effect next: $${upgradeCost(t, 'effect')!}`,
  );
  check(
    visualTier(t) === BALANCE.upgrade.maxTier,
    'and the art tier is capped at the baked set',
    `Mk ${visualTier(t)}`,
  );

  const moneyAtMax = w.money;
  w.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
  stepWorld(w, DT);
  check(w.money === moneyAtMax, 'a purchase past the ceiling is refused, not charged');
  check(
    w.events.some((e) => e.type === 'towerActionRejected' && e.reason === 'maxTier'),
    'with a reason, not silence',
  );
}

{
  const w = createWorld(map, 78);
  w.wave.phase = 'done';
  w.money = 1000;
  w.commands.push({ type: 'placeTower', defId: 'nova', col: 4, row: 4 });
  stepWorld(w, DT);
  const t = w.towers[0]!;
  w.money = 1000;
  w.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
  stepWorld(w, DT);

  const expected = Math.floor(t.spent * BALANCE.sellRefund);
  const before = w.money;
  w.commands.push({ type: 'sellTower', id: t.id });
  stepWorld(w, DT);

  check(w.towers.length === 0, 'selling removes the station');
  check(w.money === before + expected, 'and refunds a cut of everything sunk in', `+$${expected}`);
  check(placementError(w, 'lance', 4, 4) === null, 'and frees the tile');

  // A stale id must be refused rather than crash or refund twice.
  const afterSale = w.money;
  w.commands.push({ type: 'sellTower', id: t.id });
  stepWorld(w, DT);
  check(w.money === afterSale, 'selling the same station twice pays nothing');
}

{
  // Each mode must actually pick a different creep. Two in reach: one far along
  // and nearly dead, one fresh, healthier and closer — so every mode but
  // `first` should prefer the straggler, and for a different reason each time.
  const modes: [TargetMode, string][] = [
    ['first', 'the leader'],
    ['last', 'the straggler'],
    ['strong', 'the healthiest'],
    ['close', 'the nearest'],
  ];

  for (const [mode, label] of modes) {
    const w = createWorld(map, 79);
    w.wave.phase = 'done';
    w.money = 1000;
    w.commands.push({ type: 'placeTower', defId: 'lance', col: 3, row: 3 });
    stepWorld(w, DT);
    const t = w.towers[0]!;
    w.commands.push({ type: 'setTargeting', id: t.id, mode });
    stepWorld(w, DT);

    const leader = spawnCreep(w, 'drifter');
    leader.x = t.x + 1.6;
    leader.y = t.y;
    leader.progress = 30;
    leader.hp = 5;
    const straggler = spawnCreep(w, 'drifter');
    straggler.x = t.x + 0.4;
    straggler.y = t.y;
    straggler.progress = 2;
    straggler.hp = 40;

    t.cooldown = 0;
    stepWorld(w, DT);
    const shot = w.projectiles[0];
    const hit =
      shot?.target === leader ? 'leader' : shot?.target === straggler ? 'straggler' : 'none';
    check(hit === (mode === 'first' ? 'leader' : 'straggler'), `targeting "${mode}" picks ${label}`, hit);
  }
}

{
  // Counters must survive a full match and agree with each other. These feed
  // the wave-clear, defeat and victory screens, and a screen that reports a
  // number nobody checked is worse than one that reports nothing.
  const w = createWorld(map, 4141);
  w.money = 2000;
  for (const [c, r] of [
    [3, 1],
    [7, 3],
    [12, 8],
    [18, 4],
    [22, 10],
  ] as [number, number][]) {
    w.commands.push({ type: 'placeTower', defId: 'lance', col: c, row: r });
  }
  for (let i = 0; i < 60 * 60 * 6 && w.phase === 'playing'; i++) stepWorld(w, DT);

  const perWaveKills = w.perWave.reduce((a, s) => a + (s?.kills ?? 0), 0);
  const perWaveLeaks = w.perWave.reduce((a, s) => a + (s?.leaked ?? 0), 0);
  check(perWaveKills === w.stats.kills, 'per-wave kills sum to the run total', `${w.stats.kills}`);
  check(perWaveLeaks === w.stats.leaks, 'and so do leaks', `${w.stats.leaks}`);
  check(
    w.lives === Math.max(0, BALANCE.startingLives - w.stats.leaks),
    'lives lost matches leaks counted',
    `${w.lives} lives, ${w.stats.leaks} leaks`,
  );

  const towerKills = w.towers.reduce((a, t) => a + t.kills, 0);
  check(towerKills <= w.stats.kills, 'no station claims a kill nobody made', `${towerKills}/${w.stats.kills}`);

  const cov = coverage(w);
  check(
    cov.covered + cov.gaps.length === cov.total,
    'coverage partitions the route',
    `${cov.total} tiles`,
  );
  // The union of the lanes, which on a one-lane board is the lane. Counted
  // against painted road rather than against a route length, so a board whose
  // lanes share a trunk cannot report more road than it has.
  const painted = map.tiles.filter((t) => t === 'path').length;
  check(
    cov.total === painted,
    'and counts every painted road tile exactly once',
    `${cov.total} vs ${painted} painted`,
  );
  const lanes = laneCoverage(w);
  check(
    lanes.length === map.routes.length && lanes.every((l) => l.covered + l.gaps.length === l.total),
    'per-lane coverage partitions each lane',
    lanes.map((l) => `${l.id} ${l.covered}/${l.total}`).join(' · '),
  );
}

/**
 * Rank buildable tiles by how much road they cover. A competent player finds
 * these tiles by eye; ranking them here means a gate or a probe measures the
 * design rather than my ability to guess coordinates.
 *
 * **A thin call into `buildOrder`, which is the point.** This used to be a
 * hand-rolled second implementation of the same heuristic — same scan, same
 * `covered` count, same col-then-row tie-break — sitting beside the one
 * `sweep.ts` and `campaign.ts` share. Two copies of a ranking is exactly what
 * that module's header says it exists to prevent, and a gate suite grading a
 * defence by a *different* notion of a good tile than the balance tools use is
 * the worst possible place for that drift to live.
 *
 * A `function` and not a `const`: three call sites above this line rely on
 * hoisting.
 */
function rankedSpots(range: number): readonly (readonly [number, number])[] {
  return buildOrder(map, range, 'cluster');
}

// ---------------------------------------------------------------------------
section('contacts — content');

{
  // Scans every arc in the campaign plus Front Line, not just Switchback.
  //
  // It used to read `WAVES` alone — sector 1's ten-wave table — which quietly
  // required every contact in the game to be introduced on the first board.
  // That was fine while the roster was six and the table introduced six, and it
  // stopped being fine at nine: the alternative was cramming three more types
  // into waves 8-9 of an arc whose pacing `hpGrowth` is swept against, purely to
  // satisfy a gate.
  //
  // Widening it makes the assertion *stronger* rather than weaker — it now
  // covers nine tables instead of one — and it is honest about what the campaign
  // actually is, which is eight sectors that teach in sequence. A contact
  // introduced in sector 4 is still taught before it matters; it is just not
  // taught on sector 1.
  const tables = [...CAMPAIGN.map((l) => l.waves), WAVES_FRONTLINE];
  const used = new Set<string>();
  for (const table of tables) for (const wv of table) for (const gr of wv.groups) used.add(gr.enemy);
  const missing = ENEMY_IDS.filter((id) => !used.has(id));
  check(
    missing.length === 0,
    'every contact type appears somewhere in the campaign',
    missing.length ? `unused: ${missing.join(', ')}` : `${ENEMY_IDS.length} types across ${tables.length} arcs`,
  );

  const unknown = [...used].filter((id) => !(ENEMY_IDS as string[]).includes(id));
  check(unknown.length === 0, 'and no wave references a type that does not exist');

  // The one property that makes runaway splitting impossible rather than
  // merely unlikely: whatever a type splits into must not itself split.
  const recursive = ENEMY_IDS.filter((id) => {
    const s = ENEMIES[id].splitInto;
    return s !== null && ENEMIES[s.enemy as typeof id].splitInto !== null;
  });
  check(recursive.length === 0, 'nothing splits into something that splits', recursive.join(', '));
}

// ---------------------------------------------------------------------------
// A Warden is a test of *coverage*, not of damage: sustained fire holds its
// shield down, a gap hands it back. These gates pin both halves.
section('contacts — shields');

{
  const w = soloWorld();
  const c = spawnCreep(w, 'warden');
  const base = ENEMIES.warden;
  check(c.shield === base.shield && c.maxShield === base.shield, 'a warden spawns shielded', `${c.shield}`);

  // Absorbed by the shield, not the hull.
  damageCreep(w, c, 10);
  check(c.hp === c.maxHp && c.shield === base.shield - 10, 'the shield absorbs first', `hull ${c.hp}, shield ${c.shield}`);

  // Overflow carries through rather than being wasted on a thin shield.
  const before = c.hp;
  damageCreep(w, c, base.shield - 10 + 7);
  check(c.shield === 0 && c.hp === before - 7, 'overflow carries into the hull', `hull ${c.hp}, shield ${c.shield}`);
}

{
  const w = soloWorld();
  const c = spawnCreep(w, 'warden');
  const base = ENEMIES.warden;
  damageCreep(w, c, 10);
  const dented = c.shield;

  // Nothing comes back while the delay is still running.
  for (let i = 0; i < Math.floor((base.shieldRegenDelay - 0.2) * 60); i++) stepWorld(w, DT);
  check(c.shield === dented, 'no regen during the delay', `${c.shield}`);

  for (let i = 0; i < 60 * 6; i++) stepWorld(w, DT);
  check(c.shield === c.maxShield, 'and it returns to full, never past it', `${c.shield}/${c.maxShield}`);
}

{
  // The property that matters in play: a shield is extra effective health.
  const kill = (defId: 'drifter' | 'warden'): number => {
    const w = soloWorld();
    const c = spawnCreep(w, defId, { hp: 30, shield: defId === 'warden' ? 30 : 0 });
    let ticks = 0;
    // Steady chip, faster than regen, so the shield only ever delays the kill.
    while (!c.dead && ticks < 60 * 120) {
      damageCreep(w, c, 1);
      stepWorld(w, DT);
      ticks++;
    }
    return ticks;
  };
  const plain = kill('drifter');
  const shielded = kill('warden');
  check(shielded > plain, 'a shielded contact takes longer to kill', `${shielded} vs ${plain} ticks`);
}

// ---------------------------------------------------------------------------
section('contacts — armour');

{
  const w = soloWorld();
  const c = spawnCreep(w, 'bulwark');
  const armor = ENEMIES.bulwark.armor;
  const before = c.hp;

  damageCreep(w, c, 20);
  check(
    c.hp === before - (20 - armor),
    'armour comes off every hit',
    `−${20 - armor} of 20 raw`,
  );
}

{
  // Never immunity. A station whose shots literally cannot scratch something
  // reads as a bug, and it would make a bad build unrecoverable rather than
  // merely bad — no chipping your way to the money for the station you need.
  const w = soloWorld();
  const c = spawnCreep(w, 'bulwark');
  const before = c.hp;
  const raw = 2; // Singularity's damage, far under the armour value.

  damageCreep(w, c, raw);
  const landed = before - c.hp;
  check(landed > 0, 'a hit smaller than the armour still lands something', `${landed.toFixed(2)}`);
  check(
    Math.abs(landed - raw * BALANCE.armorFloor) < 1e-9,
    'and lands exactly the floor, not the difference',
    `${landed.toFixed(2)} = ${raw} × ${BALANCE.armorFloor}`,
  );
}

{
  // Everything unarmoured must be bit-identical to before armour existed.
  const w = soloWorld();
  const c = spawnCreep(w, 'drifter');
  const before = c.hp;
  damageCreep(w, c, 7);
  check(c.hp === before - 7, 'an unarmoured contact takes the whole hit', '−7 of 7');
}

{
  // The defining property, and the one that a "simplification" to percentage
  // armour would silently destroy: the same damage total is worth more
  // delivered as one heavy hit than as chip. That asymmetry is the entire
  // reason this mechanic exists — it is the axis Nova is strong on and the
  // Lance/Singularity pair is weak on.
  const spend = 60;
  const hullAfter = (hits: number): number => {
    const w = soloWorld();
    const c = spawnCreep(w, 'bulwark', { hp: 500 });
    for (let i = 0; i < hits; i++) damageCreep(w, c, spend / hits);
    return c.hp;
  };

  const heavy = hullAfter(1);
  const chip = hullAfter(10);
  check(heavy < chip, 'one heavy hit beats the same total as chip', `hull ${heavy.toFixed(1)} vs ${chip.toFixed(1)}`);
}

{
  // Armour must not distort attribution or bounty: a kill still pays once, and
  // a tower is credited what it actually landed rather than what it fired.
  const w = soloWorld();
  const c = spawnCreep(w, 'bulwark', { hp: 10, bounty: 9 });
  const money = w.money;

  damageCreep(w, c, 1e6);
  check(c.dead && w.money === money + 9, 'an armoured kill pays its bounty once', `+$9`);
}

// ---------------------------------------------------------------------------
// The inspector prints effective damage, and the sim applies it. They call the
// same function so they cannot disagree — this is the analogue of the "ghost
// cannot lie" sweep, for the same failure mode in a new place.
section('inspector — armour readout');

{
  check(effectiveDamage(20, 0) === 20, 'no armour is identity');
  check(effectiveDamage(20, 5) === 15, 'armour comes off the hit', `${effectiveDamage(20, 5)}`);
  check(effectiveDamage(3, 5) > 0, 'armour is never immunity', `${effectiveDamage(3, 5)}`);
  check(
    Math.abs(effectiveDamage(3, 5) - 3 * BALANCE.armorFloor) < 1e-9,
    'and floors at armorFloor rather than going negative',
    `${effectiveDamage(3, 5).toFixed(2)} = 3 × ${BALANCE.armorFloor}`,
  );

  let floorHolds = true;
  for (let amount = 0; amount <= 60; amount += 0.5) {
    for (const armor of [0, 1, 5, 40]) {
      const e = effectiveDamage(amount, armor);
      if (e < 0 || e > amount || e < amount * BALANCE.armorFloor - 1e-9) floorHolds = false;
    }
  }
  check(floorHolds, 'never negative, never above the raw hit, never under the floor');
}

{
  // What the panel would print must equal what the sim actually removes, for
  // every station at every tier. Drift here would mislead a player at the exact
  // moment they are spending money on an upgrade.
  const w = soloWorld();
  let worst = 0;
  for (const defId of TOWER_IDS) {
    for (let tier = 1; tier <= BALANCE.upgrade.maxTier; tier++) {
      const raw = damageAtTier(defId, tier);
      const shown = effectiveDamage(raw, ENEMIES.bulwark.armor);

      const c = spawnCreep(w, 'bulwark', { hp: 1e6 });
      const before = c.hp;
      damageCreep(w, c, raw);
      const actual = before - c.hp;
      c.dead = true;

      worst = Math.max(worst, Math.abs(actual - shown));
    }
  }
  check(worst < 1e-9, 'the panel figure equals what the sim removes', `worst delta ${worst}`);

  // A floored hit is small, not absent. Rounding it to a whole number renders
  // "0", which tells the player the station did nothing at all.
  //
  // Derived from the roster's *actual* weakest hit against its heaviest plating
  // rather than naming Singularity and Bulwark. It used to name both, which kept
  // passing after the roster doubled while quietly no longer testing the worst
  // case — Ironclad's armour is more than twice Bulwark's, and Salvage's damage
  // is below Singularity's.
  const weakest = Math.min(
    ...TOWER_IDS.filter((id) => TOWERS[id].damage > 0).map((id) => damageAtTier(id, 1)),
  );
  const heaviest = Math.max(...ENEMY_IDS.map((id) => ENEMIES[id].armor));
  const floored = effectiveDamage(weakest, heaviest);
  check(
    Number(formatDamage(floored)) > 0,
    'a floored hit never renders as zero',
    `${floored.toFixed(3)} → "${formatDamage(floored)}"`,
  );
}

{
  const w = soloWorld();
  check(toughestArmour(w) === null, 'no armour reference on an empty board');

  spawnCreep(w, 'drifter');
  check(toughestArmour(w) === null, 'and none when nothing alive is armoured');

  spawnCreep(w, 'bulwark');
  const ref = toughestArmour(w);
  check(
    ref !== null && ref.defId === 'bulwark' && !ref.inbound,
    'a live armoured contact is picked, and not flagged inbound',
    `${ref?.defId}`,
  );
}

{
  // The intermission fallback: upgrades get bought when the board is empty, and
  // a readout that vanished exactly then would be useless.
  const w = createWorld(map, 4242);
  // Wave index 6 is the first that contains a bulwark.
  w.wave.index = 6;
  w.wave.phase = 'intermission';
  check(w.creeps.length === 0, 'board is empty during the intermission');
  const ref = toughestArmour(w);
  check(
    ref !== null && ref.defId === 'bulwark' && ref.inbound,
    'the inbound wave supplies the reference, flagged as inbound',
    `${ref?.defId} inbound=${ref?.inbound}`,
  );
}

// ---------------------------------------------------------------------------
// THE SIX NEW MECHANICS, AND THE ONE RULE THEY ALL HAVE TO KEEP.
//
// `damageCreep` is the single place a contact can lose health, and that is what
// makes a double bounty or a double death event impossible rather than merely
// unlikely. Five of the six additions honour it for free — a multi-target pull is N
// ordinary shots, shred changes the `armor` *argument*, a breaker changes how
// `effective` is split, a shove moves a contact, salvage changes the payout
// inside the kill block. Only the burn adds a new call site, so the burn is what
// most of this section is about.
//
// The arithmetic gates matter as much as the behavioural ones. A shield
// multiplier that forgot to divide its overflow back out would look correct on
// a shielded contact and silently be a general damage multiplier on a bare one,
// which is exactly the sort of thing that ships.
// ---------------------------------------------------------------------------
section('stations — shred, break, burn, shove, salvage, no range');

{
  // --- the shield multiplier, and that it still splits normally at 1 ---
  {
    const w = soloWorld();
    const c = spawnCreep(w, 'warden', { hp: 100, shield: 45 });
    damageCreep(w, c, 10, undefined, 3);
    check(
      c.shield === 15 && c.hp === 100,
      'a 3x breaker spends a 10 hit as 30 shield and no hull',
      `shield ${c.shield} · hp ${c.hp}`,
    );
    damageCreep(w, c, 10, undefined, 3);
    check(
      c.shield === 0 && Math.abs(c.hp - 95) < 1e-9,
      'and the spill into hull is divided back out, not tripled with it',
      `shield ${c.shield} · hp ${c.hp}`,
    );
  }
  {
    const w = soloWorld();
    const c = spawnCreep(w, 'warden', { hp: 26, shield: 30 });
    damageCreep(w, c, 50);
    check(
      c.shield === 0 && c.hp === 6,
      'an ordinary hit splits shield then hull exactly as before',
      `shield ${c.shield} · hp ${c.hp}`,
    );
  }

  // --- shred comes off the plating, not onto the shot ---
  {
    const w = soloWorld();
    const c = spawnCreep(w, 'bulwark');
    const before = c.hp;
    damageCreep(w, c, 8);
    const plain = before - c.hp;
    c.shred = 4;
    const mid = c.hp;
    damageCreep(w, c, 8);
    check(
      plain === 3 && mid - c.hp === 7,
      'four points of strip turn a Lance hit on a Bulwark from 3 into 7',
      `${plain} → ${mid - c.hp}`,
    );
  }

  // --- the burn: cadence, the one funnel, and cleaning up after itself ---
  {
    const w = soloWorld();
    const c = spawnCreep(w, 'monolith', { hp: 500 });
    c.burnTimer = 4;
    c.burnDamage = 5;
    c.burnTick = BALANCE.burnTick;
    let ticks = 0;
    for (let i = 0; i < 60 * 5; i++) {
      const hp = c.hp;
      stepWorld(w, 1 / 60);
      if (c.hp < hp) ticks++;
    }
    check(ticks === 4, 'a 4s burn lands exactly four ticks, not 240', `${ticks}`);
    check(c.burnDamage === 0 && c.burnSource === null, 'and clears itself when it lapses');
  }
  {
    const w = soloWorld();
    const c = spawnCreep(w, 'drifter', { hp: 4, bounty: 50 });
    c.burnTimer = 4;
    c.burnDamage = 5;
    c.burnTick = BALANCE.burnTick;
    const before = w.money;
    let kills = 0;
    for (let i = 0; i < 180; i++) {
      stepWorld(w, 1 / 60);
      kills += w.events.filter((e) => e.type === 'creepKilled').length;
      w.events.length = 0;
    }
    check(kills === 1, 'a burn kill fires exactly one death event', `${kills}`);
    check(w.money - before === 50, 'and pays its bounty exactly once', `+${w.money - before}`);
  }
  {
    // The tick order is what makes this work: statuses run before splits
    // resolve, so a burn kill queues its children like any other kill.
    const w = soloWorld();
    const c = spawnCreep(w, 'cluster', { hp: 4 });
    c.burnTimer = 4;
    c.burnDamage = 5;
    c.burnTick = BALANCE.burnTick;
    for (let i = 0; i < 180; i++) {
      stepWorld(w, 1 / 60);
      w.events.length = 0;
    }
    check(
      w.creeps.filter((x) => x.defId === 'mote').length === 3,
      'a Cluster killed by fire still breaks into three',
      `${w.creeps.filter((x) => x.defId === 'mote').length} motes`,
    );
  }

  // --- the shove is a pure function of progress, and clamps at the mouth ---
  {
    const w = soloWorld();
    const c = spawnCreep(w, 'drifter');
    placeAtProgress(w, c, 6);
    const at6 = { x: c.x, y: c.y, leg: c.leg };
    placeAtProgress(w, c, 5.1);
    check(c.progress === 5.1, 'a shove writes progress and position together', `leg ${c.leg}`);
    placeAtProgress(w, c, 6);
    check(
      Math.abs(c.x - at6.x) < 1e-9 && Math.abs(c.y - at6.y) < 1e-9 && c.leg === at6.leg,
      'and is exact enough to round-trip — no drift across a shove',
    );
    placeAtProgress(w, c, -50);
    check(c.progress === 0, 'a shove past the lane mouth clamps rather than going behind it');
  }

  // --- salvage pays, takes the max, and two of them are not two payouts ---
  {
    const w = soloWorld();
    w.money = 100_000;
    w.wave.index = 20;
    let placed = 0;
    for (let r = 0; r < map.rows && placed < 2; r++) {
      for (let col = 0; col < map.cols && placed < 2; col++) {
        if (placementError(w, 'salvage', col, r) === null) {
          buildTower(w, 'salvage', col, r);
          placed++;
        }
      }
    }
    const near = w.towers[0]!;
    check(
      placed === 2 && Math.abs(salvageBonus(w, near.x, near.y) - TOWERS.salvage.bountyBonus) < 1e-9,
      'two overlapping salvage stations pay the max, never the sum',
      `${salvageBonus(w, near.x, near.y)}`,
    );

    const before = w.money;
    const c = spawnCreep(w, 'drifter', { hp: 1, bounty: 100 });
    c.x = near.x;
    c.y = near.y;
    damageCreep(w, c, 10);
    check(w.money - before === 135, 'a kill inside the reach pays bounty x1.35', `+${w.money - before}`);

    const far = spawnCreep(w, 'drifter', { hp: 1, bounty: 100 });
    far.x = -50;
    far.y = -50;
    const mid = w.money;
    damageCreep(w, far, 10);
    check(w.money - mid === 100, 'and one outside it pays the plain bounty', `+${w.money - mid}`);
  }

  // --- the one station with no radius ---
  //
  // Every other entry in the roster is a circle, so this is the only place the
  // range test can be wrong in a way no other gate would notice: a Sentinel that
  // quietly respected `range` would read as a station that never fires, and a
  // `range: 0` station that respected it would fire at literally nothing.
  {
    const sentinel = TOWER_IDS.filter((id) => TOWERS[id].boardWide);
    check(
      sentinel.length === 1,
      'exactly one station is rangeless',
      sentinel.join(' ') || 'none',
    );

    const w = soloWorld();
    w.money = 100_000;
    w.wave.index = 20;
    let tower;
    for (let r = 0; r < map.rows && tower === undefined; r++) {
      for (let col = 0; col < map.cols && tower === undefined; col++) {
        if (placementError(w, 'sentinel', col, r) === null) tower = buildTower(w, 'sentinel', col, r);
      }
    }

    // Deliberately the far corner of the board — well outside any radius in the
    // roster, and outside this station's own `range` of 0 by definition.
    const far = spawnCreep(w, 'drifter', { hp: 5000 });
    far.x = map.cols - 0.5;
    far.y = map.rows - 0.5;
    const reach = Math.hypot(far.x - tower!.x, far.y - tower!.y);
    tower!.cooldown = 0;
    w.projectiles.length = 0;
    w.events.length = 0;
    stepWorld(w, 1 / 60);
    check(
      w.projectiles.length === 1 && w.projectiles[0]!.target.id === far.id,
      'it reaches a contact in the far corner, with a range of 0',
      `${reach.toFixed(1)} tiles away · range ${TOWERS.sentinel.range}`,
    );

    // ...and it takes the one closest to the core, which is the only preference
    // a station that can see everything can coherently have.
    const behind = spawnCreep(w, 'drifter', { hp: 5000 });
    behind.progress = far.progress - 6;
    tower!.cooldown = 0;
    w.projectiles.length = 0;
    stepWorld(w, 1 / 60);
    check(
      w.projectiles.length === 1 && w.projectiles[0]!.target.id === far.id,
      'and prefers the contact closest to the core over the one behind it',
    );

    // The effect path is what widens it, since a range path would be inert —
    // and the range button is withdrawn rather than sold. Same posture as
    // Overclock's damage track.
    check(
      !hasRangePath('sentinel') && hasRangePath('lance'),
      'its range track is withdrawn, not sold as an inert purchase',
    );
    check(
      upgradeError(w, tower!, 'range') === 'noSuchPath',
      'and buying one is refused in its own words',
      `got ${upgradeError(w, tower!, 'range')}`,
    );

    const maxed = computeStats('sentinel', { damage: 1, range: 1, effect: BALANCE.upgrade.maxTier });
    check(
      maxed.volleyTargets === 3,
      'a Mk III Sentinel watches three contacts at once',
      `${maxed.volleyTargets}`,
    );

    // Maxed, against contacts scattered to opposite corners rather than clumped:
    // three shots, three distinct targets, and *one* report. A sound per shot
    // would make this station loudest exactly when the board is worst.
    tower!.stats = maxed;
    const third = spawnCreep(w, 'drifter', { hp: 5000 });
    third.x = 1.5;
    third.y = map.rows - 1.5;
    third.progress = far.progress - 12;
    tower!.cooldown = 0;
    w.projectiles.length = 0;
    w.events.length = 0;
    stepWorld(w, 1 / 60);
    const hit = new Set(w.projectiles.map((p) => p.target.id)).size;
    check(
      w.projectiles.length === 3 && hit === 3,
      'and puts one shot into each of three contacts, anywhere on the board',
      `${w.projectiles.length} shots · ${hit} targets`,
    );
    check(
      w.events.filter((e) => e.type === 'towerFired').length === 1,
      'and still reports once per trigger, not once per shot',
    );
  }
}

// ---------------------------------------------------------------------------
section('contacts — splits');

{
  const w = soloWorld();
  const parent = spawnCreep(w, 'cluster', { wave: 4 });
  // Walk it onto the board so the children have a real position to inherit.
  for (let i = 0; i < 120; i++) stepWorld(w, DT);
  const px = parent.x;
  const pProgress = parent.progress;

  damageCreep(w, parent, 1e6);
  check(w.creeps.includes(parent), 'the parent is still in the array before cleanup');
  check(w.pendingSplits.length === 1, 'the split is queued, not spawned inline');

  stepWorld(w, DT);
  const kids = w.creeps.filter((c) => c.defId === 'mote');
  const expected = ENEMIES.cluster.splitInto!.count;
  check(kids.length === expected, 'a cluster yields exactly its child count', `${kids.length}`);
  check(kids.every((k) => k.wave === 4), "children carry the PARENT's wave tag", `${kids.map((k) => k.wave).join(',')}`);
  check(
    kids.every((k) => Math.abs(k.x - px) < 1 && k.progress > 0 && k.progress <= pProgress + 1),
    'and appear where the parent died, not back at the entry',
    `progress ${kids.map((k) => k.progress.toFixed(1)).join(', ')} vs parent ${pProgress.toFixed(1)}`,
  );

  // Kill the children too; nothing further may appear.
  for (const k of kids) damageCreep(w, k, 1e6);
  stepWorld(w, DT);
  check(w.creeps.length === 0, 'children do not split again', `${w.creeps.length} left`);
}

{
  // The sharpest one. Splits are the obvious way to break wave settlement:
  // a child tagged with the wrong wave would let its parent's wave settle
  // early, paying the reward while contacts were still walking — and at the
  // end of a run, declaring victory with the board occupied.
  const w = createWorld(map, 4242);
  w.lives = 1_000_000;
  let cleared = 0;
  let splits = 0;

  for (let i = 0; i < 400_000 && w.phase === 'playing'; i++) {
    // Kill everything the moment it is fully spawned, so every wave settles.
    if (w.wave.phase !== 'spawning') for (const c of w.creeps) damageCreep(w, c, 1e6);
    w.commands.push({ type: 'startWave' });
    stepWorld(w, DT);
    for (const ev of w.events) {
      if (ev.type === 'waveCleared') cleared++;
      if (ev.type === 'creepSplit') splits++;
    }
    w.events.length = 0;
  }

  check(splits > 0, 'the run actually produced splits', `${splits}`);
  check(w.phase === 'won', 'a run full of splits still reaches victory');
  check(cleared === waveCount(), 'and every wave settles exactly once', `${cleared}/${waveCount()}`);
  check(w.creeps.length === 0, 'with nothing left on the board');
}

{
  // Splits draw no random numbers, so a whole match must replay identically.
  const run = (): string => {
    const w = createWorld(map, 8888);
    w.money = 100_000;
    for (const [col, row] of rankedSpots(3).slice(0, 14)) {
      w.commands.push({ type: 'placeTower', defId: 'nova', col, row });
    }
    const log: string[] = [];
    for (let i = 0; i < 60 * 400 && w.phase === 'playing'; i++) {
      stepWorld(w, DT);
      for (const ev of w.events) {
        if (ev.type === 'creepSplit') log.push(`${w.tick}:${ev.into}x${ev.count}@${ev.x.toFixed(3)},${ev.y.toFixed(3)}`);
      }
      w.events.length = 0;
    }
    return log.join('|');
  };
  const a = run();
  check(a.length > 0, 'the determinism run produced splits', `${a.split('|').length} events`);
  check(a === run(), 'one seed replays split-for-split identically');
}

// ---------------------------------------------------------------------------
// Not assertions — a readout. The plan calls M5 the point where we find out
// whether the game is fun, and this is the cheapest way to see whether the
// numbers are anywhere near sane before playing it.
section('matchup matrix (informational)');

{
  /**
   * Every station against every contact, in isolation.
   *
   * The whole-run probe below answers "does this build survive the arc", which
   * stopped being diagnostic the moment there were five contact types — a
   * station can beat Drifters comfortably and still be helpless against
   * Monoliths, and the run probe reports both as one number.
   *
   * This asks the design question instead: **is each station the answer to
   * something, and is anything unanswerable?** A row of zeros is a station that
   * beats everything; a column that nothing clears is a contact with no counter.
   * Both are balance failures, and neither is visible from win rates.
   *
   * Money is unlimited here on purpose. This measures combat, not economy —
   * the run probe is where affordability gets tested.
   */
  const DUEL_WAVE = 5;
  const DUEL_STATIONS = 8;

  /**
   * Counts and spacing per contact, taken from how each actually appears in
   * `WAVES` rather than a flat ten of everything.
   *
   * The flat version was tried first and was actively misleading: ten Motes
   * read as zero leaks against every station, which says Motes are trivial.
   * They are not — they arrive fourteen and sixteen at a time, and the swarm is
   * the entire point of them. Measuring a contact at a pressure it never occurs
   * at measures nothing.
   */
  const PRESSURE: Record<EnemyId, { count: number; every: number }> = {
    drifter: { count: 10, every: 0.9 },
    mote: { count: 15, every: 0.27 },
    monolith: { count: 3, every: 2.5 },
    warden: { count: 4, every: 1.6 },
    cluster: { count: 4, every: 1.6 },
    // Each at the pressure its own question implies: a plated contact arrives
    // few and slow, a shielded one in a stream that never gives regen a gap, and
    // a Skimmer in numbers, fast, because being unslowable only matters when
    // there are enough of them to matter.
    ironclad: { count: 3, every: 2.4 },
    aegis: { count: 4, every: 1.6 },
    skimmer: { count: 12, every: 0.3 },
    bulwark: { count: 4, every: 1.9 },
  };

  const duel = (tower: TowerId, enemy: EnemyId): number => {
    const w = createWorld(map, 4242);
    w.wave.phase = 'done';
    // The duel measures wave-DUEL_WAVE stats, so the world has to *be* at that
    // wave — stations gate on `wave.index >= unlockWave`, and at index 0 every
    // station that unlocks later silently failed to place. The matrix then read
    // as "leaks everything", which is indistinguishable from a useless station
    // and is exactly the false signal this table exists to avoid.
    w.wave.index = DUEL_WAVE;
    w.money = 1_000_000;
    // Deep enough that a leak never ends the run — we want the count, not a loss.
    w.lives = 9999;

    for (const [col, row] of rankedSpots(TOWERS[tower].range).slice(0, DUEL_STATIONS)) {
      w.commands.push({ type: 'placeTower', defId: tower, col, row });
    }
    stepWorld(w, DT);

    const stats = scaledStats(enemy, DUEL_WAVE);
    const { count, every } = PRESSURE[enemy];
    let spawned = 0;
    let t = 0;

    for (let i = 0; i < 60 * 300; i++) {
      if (spawned < count && t >= spawned * every) {
        spawnCreep(w, enemy, { ...stats, wave: DUEL_WAVE });
        spawned++;
      }
      stepWorld(w, DT);
      w.events.length = 0;
      t += DT;
      if (spawned >= count && w.creeps.length === 0) break;
    }
    return 9999 - w.lives;
  };

  const pad = (s: string, n: number): string => s.padStart(n);
  console.log(
    `  \x1b[2m${DUEL_STATIONS} stations vs a representative group at wave ${DUEL_WAVE} stats · unlimited money · leaks of N sent (lower is better)\x1b[0m`,
  );
  console.log(`  \x1b[2m${pad('', 13)}${ENEMY_IDS.map((e) => pad(e, 10)).join('')}\x1b[0m`);

  for (const t of TOWER_IDS) {
    const cells = ENEMY_IDS.map((e) => pad(`${duel(t, e)}/${PRESSURE[e].count}`, 10)).join('');
    console.log(`  \x1b[2m${t.padEnd(13)}${cells}\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
section('balance probe (informational)');

{
  /**
   * Play a real economy: start with the real budget and buy the best remaining
   * tile whenever it becomes affordable. Handing the probe unlimited money
   * measures tower damage but says nothing about whether bounty income can
   * fund a defence, which is the actual question at M5.
   */
  const SEED_POOL = [4242, 7, 999, 31337, 12345];
  // `SEEDS=N` for a fast pass; a short run is a prefix of the long one.
  const SEEDS = SEED_POOL.slice(0, Number(process.env['SEEDS'] ?? SEED_POOL.length));

  const play = (
    build: TowerId[],
    rush: boolean,
    seed: number,
  ): { won: boolean; lives: number; towers: number; wave: number; earned: number } => {
    // Rank by the widest range in the build so every strategy shares one notion
    // of "good tile" and none is flattered by its own ordering.
    // Attacking reach only: a support station's radius buffs towers rather than
    // covering road, so ranking tiles by it would rank them for nothing.
    const guns = build.filter((b) => TOWERS[b].buffShotsPerSecond === 0);
    const spots = rankedSpots(Math.max(...(guns.length > 0 ? guns : build).map((b) => TOWERS[b].range)));
    const w = createWorld(map, seed);
    const acc: Accumulator = { debt: 0 };
    const taken = new Set<number>();
    let next = 0;

    for (let i = 0; i < 400_000 && w.phase === 'playing'; i++) {
      // **Locked stations are stepped over, not waited on.** This used to hold
      // the cursor on a locked slot, so the whole build stalled until that
      // station unlocked — the `filament` row measured 0/5 having built two
      // towers and earned $1, and `arc+filament` built 3.4, both of which were
      // facts about this loop rather than about the stations. Shared in spirit
      // with `sweep.ts` and `campaign.ts`, which carry the same block.
      //
      // A local offset that does not advance `next`: advancing it per tick
      // rotates the cycle thousands of times while a station is locked, making
      // which station lands on which ranked tile arbitrary.
      let skip = 0;
      while (skip < build.length && w.wave.index < TOWERS[build[(next + skip) % build.length]!].unlockWave) {
        skip++;
      }
      if (skip === build.length) {
        if (rush) w.commands.push({ type: 'startWave' });
        advance(w, acc, 1000 / TICK_HZ, 1);
        w.events.length = 0;
        continue;
      }

      const want = build[(next + skip) % build.length]!;
      const def = TOWERS[want];
      // Support is not placed by rank — it goes where it feeds the most
      // stations. Same shared rule the balance tools use.
      const at = spotFor(
        spots,
        taken,
        def.buffShotsPerSecond > 0 ? { range: def.range, towers: w.towers } : null,
      );
      // Money still blocks rather than skipping: waiting to afford what the
      // build asked for is what a player does.
      if (at >= 0 && w.money >= def.cost) {
        w.commands.push({ type: 'placeTower', defId: want, col: spots[at]![0], row: spots[at]![1] });
        taken.add(at);
        next += skip + 1;
      }
      if (rush) w.commands.push({ type: 'startWave' });
      advance(w, acc, 1000 / TICK_HZ, 1);
      w.events.length = 0;
    }
    return {
      won: w.phase === 'won',
      lives: w.lives,
      // How far the economy got, not just whether it survived. A run that dies
      // with four stations built is an income problem; one that dies with
      // twenty is a station-power problem, and the win rate alone cannot tell
      // those apart.
      towers: w.towers.length,
      wave: w.wave.clearedThrough + 1,
      earned: w.stats.bounty,
    };
  };

  const mean = (ns: number[]): number => ns.reduce((a, b) => a + b, 0) / ns.length;

  const row = (label: string, build: TowerId[], rush: boolean): string => {
    const rs = SEEDS.map((s) => play(build, rush, s));
    const wins = rs.filter((r) => r.won).length;
    return (
      `${rush ? 'rush' : 'wait'} ${label.padEnd(13)}` +
      ` won ${wins}/${SEEDS.length}` +
      `  lives ${mean(rs.map((r) => r.lives)).toFixed(1).padStart(4)}/${BALANCE.startingLives}` +
      `  waves ${mean(rs.map((r) => r.wave)).toFixed(1).padStart(4)}/${waveCount()}` +
      `  built ${mean(rs.map((r) => r.towers)).toFixed(1).padStart(4)}` +
      `  bounty $${Math.round(mean(rs.map((r) => r.earned)))}`
    );
  };

  /**
   * Mixed builds matter more than pure ones now.
   *
   * A pure Singularity build cannot win by construction — it is a support
   * station, and slowing without killing just delays a leak. `singularity` at
   * 0/5 is therefore not evidence of a weak station; the question is whether
   * adding one to a working build *helps*, which only a mix can answer.
   */
  const builds: [string, TowerId[]][] = [
    ['lance', ['lance']],
    ['nova', ['nova']],
    ['singularity', ['singularity']],
    ['arc', ['arc']],
    ['filament', ['filament']],
    ['nova+2lance', ['nova', 'lance', 'lance']],
    ['arc+filament', ['arc', 'filament']],
    ['overclock', ['overclock']],
    ['nova+overclock', ['nova', 'overclock']],
    ['all six', ['nova', 'lance', 'singularity', 'arc', 'filament', 'overclock']],
    ['nova+lance+sing', ['nova', 'lance', 'singularity']],
    ['2nova+sing', ['nova', 'nova', 'singularity']],
  ];

  console.log(`  \x1b[2mgreedy auto-builder · real starting money · ${SEEDS.length} seeds\x1b[0m`);
  console.log('  \x1b[2m"wait" lets each intermission run out; "rush" sends every wave early\x1b[0m');
  for (const rush of [false, true]) {
    for (const [label, build] of builds) console.log(`  \x1b[2m${row(label, build, rush)}\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// A BOARD CANNOT LIE ABOUT ITS OWN SHAPE.
//
// The front-door cards state road length and turn count, and the whole point of
// deriving them is that changing a map's `rows` changes its card with no other
// edit. So the derivation is pinned here rather than trusted.
//
// The turn count is the interesting one. The spec prescribes
// `waypoints.length - 2`; measured against the shipped maps that gives 7/7/9
// where the real heading changes are 6/6/8 — and Switchback's own blurb says
// "six turns". Implementing the formula literally would have put a numeral on
// the card contradicting the prose beside it.
// ---------------------------------------------------------------------------
section('front door · derived board facts');
{
  /** An independent second implementation, so the gate is a check and not an echo. */
  const headingChanges = (route: { waypoints: readonly { x: number; y: number }[] }): number => {
    const w = route.waypoints;
    let n = 0;
    for (let i = 1; i < w.length - 1; i++) {
      const ax = Math.sign(w[i]!.x - w[i - 1]!.x);
      const ay = Math.sign(w[i]!.y - w[i - 1]!.y);
      const bx = Math.sign(w[i + 1]!.x - w[i]!.x);
      const by = Math.sign(w[i + 1]!.y - w[i]!.y);
      if (ax !== bx || ay !== by) n++;
    }
    return n;
  };

  for (const level of CAMPAIGN) {
    const facts = boardFacts(level.map);
    const m = parseMap(level.map);

    check(
      facts.road === m.tiles.filter((t) => t === 'path').length,
      `${level.name}: road length is counted, not written`,
      `${facts.road} tiles`,
    );
    const interior = Math.max(...m.routes.map((r) => r.waypoints.length - 2));
    check(
      facts.turns < interior,
      `${level.name}: turns are heading changes, not waypoints`,
      `${facts.turns} turns vs ${interior} interior waypoints`,
    );
    check(
      facts.lanes === m.routes.length && facts.turns === Math.max(...m.routes.map(headingChanges)),
      `${level.name}: turns come from the twistiest lane, never summed`,
      `${facts.lanes} lane(s), ${facts.turns} turns`,
    );

    // The thumbnail has to cover the board and draw every road tile, or the
    // card is showing a different map from the one that will be played.
    const svg = boardThumb(level.map, 120);
    const rects = (svg.match(/<rect /g) ?? []).length;
    check(rects > facts.road, `${level.name}: the thumbnail draws its road`, `${rects} rects`);
    check(!svg.includes('#'), `${level.name}: thumbnail carries no colour literal`);
  }

  // Switchback's blurb names its turn count in words; the numeral must agree.
  const sw = CAMPAIGN[0]!;
  check(
    /six turns/i.test(sw.blurb) === (boardFacts(sw.map).turns === 6),
    'Switchback: the numeral agrees with its own prose',
    `blurb says six, derived ${boardFacts(sw.map).turns}`,
  );
}

// ---------------------------------------------------------------------------
// TEN WORDS OR FEWER IN THE INSPECTOR, INCLUDING THE SELL BUTTON.
//
// The panel a player consults *while under attack* was the most text-dense
// surface in the game — roughly sixty words and two dozen numbers in a 150px
// band, with contacts walking. Reading it cost a wave.
//
// `title` text is free, and correctly so: it is not on screen, so the sentences
// moved there are not lost, only moved. Numerals and units are not words —
// "1.2s" and "74%" are figures the eye takes without reading.
//
// **The budget and "Max" share one fixture on purpose.** The cheapest way to
// pass a word count is to delete the word "Max" from a maxed upgrade card, so
// the all-maxed case has to satisfy both assertions at once or neither.
// ---------------------------------------------------------------------------
section('hud · inspector word budget');
{
  const spot = (() => {
    for (let row = 0; row < map.rows; row++) {
      for (let col = 0; col < map.cols; col++) {
        if (isBuildableTile(map, col, row)) return { col, row };
      }
    }
    throw new Error('no buildable tile');
  })();

  const BUDGET = 10;
  /** Units read as part of the figure they follow, not as words of their own. */
  const UNITS = new Set(['tl', 's', 'ehp', 'hp', 'kills']);
  /** "Mk III" is one word and one numeral — the accounting the design used. */
  const ROMAN = /^[IVX]+$/;

  const words = (html: string): string[] =>
    html
      // Strips tags AND their attributes, so `title` costs nothing on screen.
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/g, ' ')
      .split(/[\s·—–|,]+/)
      .filter((t) => /[A-Za-z]/.test(t))
      .filter((t) => !/\d/.test(t))
      .filter((t) => !ROMAN.test(t))
      .filter((t) => !UNITS.has(t.toLowerCase()));

  let worst = 0;
  let worstAt = '';
  let worstList: string[] = [];

  for (const id of TOWER_IDS) {
    for (const maxed of [false, true]) {
      for (const armoured of [false, true]) {
        const w = createWorld(map, 4242);
        w.money = 100_000;
        // Late enough that every station is past its unlock gate. Without this
        // the two gated ones silently never place, and the whole gate passes on
        // an empty string — which is how it read "worst 0" the first time.
        w.wave.index = 20;
        // Something armoured on the board, so the armour line renders.
        if (armoured) spawnCreep(w, 'bulwark');

        w.commands.push({ type: 'placeTower', defId: id, col: spot.col, row: spot.row });
        stepWorld(w, DT);
        const t = w.towers.at(-1);
        if (t === undefined) throw new Error(`could not place ${id} for the word-budget gate`);

        if (maxed) {
          for (const path of UPGRADE_PATHS) {
            for (let i = 1; i < BALANCE.upgrade.maxTier; i++) {
              w.commands.push({ type: 'upgradeTower', id: t.id, path });
              stepWorld(w, DT);
            }
          }
        }

        const html = renderInspector(w, t);
        const list = words(html);
        if (list.length > worst) {
          worst = list.length;
          worstAt = `${id}${maxed ? ' maxed' : ''}${armoured ? ' +armour' : ''}`;
          worstList = list;
        }

        if (maxed) check(html.includes('Max'), `${id}: a maxed path still reads "Max"`);
      }
    }
  }

  check(
    worst <= BUDGET,
    `inspector stays within ${BUDGET} words`,
    `worst ${worst} · ${worstAt} · ${worstList.join(' ')}`,
  );
}

// ---------------------------------------------------------------------------
// THE WAVE PREVIEW CANNOT PROMISE A WAVE THE SPAWNER WILL NOT DELIVER.
//
// The panel whose whole job is "prepare for this" once read `plan[0]`'s name
// and applied it to `plan.length`, announcing a six-type wave as forty
// Drifters. It is grouped now, but the property worth pinning is the one that
// made that possible: the preview is derived from `planWave`, not from any
// single element of it.
//
// Contact glyph sizing is checked here too, because "compress but preserve
// order" is exactly the kind of rule a later tweak breaks silently.
// ---------------------------------------------------------------------------
section('hud · wave preview');
{
  for (let wave = 0; wave < 6; wave++) {
    const w = createWorld(map, 4242);
    w.wave.index = wave;
    const plan = planWave(w.seed, wave, w.rules);
    const html = renderNextContact(w);

    const nums = [...html.matchAll(/<b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
    // The last <b> is the ehp figure; everything before it is a chip count.
    const chipTotal = nums.slice(0, -1).reduce((a, b) => a + b, 0);

    check(
      chipTotal === plan.length,
      `wave ${wave + 1}: the chips account for every contact`,
      `${chipTotal} of ${plan.length}`,
    );

    // Effective health, so an overshield counts — it is health that has to be
    // chewed through whichever pool it sits in.
    const worst = Math.max(...plan.map((p) => p.hp + p.shield));
    check(
      html.includes(`<b>${worst}</b> ehp`),
      `wave ${wave + 1}: toughest is the real effective health`,
      `${worst} ehp`,
    );
  }

  // Order-preserving compression: a bigger contact must never draw smaller.
  //
  // Measured from the size decision itself rather than from the markup. This
  // used to scrape `r="…"` off the single `<circle>` a contact was, which was
  // fine while every contact was a circle and became meaningless the moment
  // four of the six stopped being one — a Bulwark has no `r` at all, and a Mote
  // has four, none of them the body.
  const sized = [...ENEMY_IDS]
    .sort((a, b) => ENEMIES[a].radius - ENEMIES[b].radius)
    .map((id) => ({ id, drawn: contactGlyphRadius(id, 26) }));

  let monotonic = true;
  for (let i = 1; i < sized.length; i++) {
    if (sized[i]!.drawn < sized[i - 1]!.drawn) monotonic = false;
  }
  check(
    monotonic,
    'a bigger contact never draws smaller',
    sized.map((s) => `${s.id} ${s.drawn.toFixed(2)}`).join(' < '),
  );
  check(
    sized.every((s) => s.drawn >= 6),
    'and the smallest is still legible at chip size',
    sized.map((s) => `${s.id} ${s.drawn.toFixed(2)}`).join(' '),
  );

  // Shield is a band, never a ring: the slow already owns that shape on the
  // board, and two meanings for one shape is a puzzle rather than a readout.
  //
  // The negative half had to be re-aimed. It used to assert that the glyph
  // contained no stroked circle at all — true when a contact was one filled
  // disc, false now that the Warden's own silhouette *is* a ring. What the rule
  // actually forbids is a ring in the shield's blue, so that is what is asserted:
  // `fx.shield` may appear on the band and nowhere else.
  const shielded = ENEMY_IDS.find((id) => ENEMIES[id].shield > 0);
  if (shielded !== undefined) {
    const svg = contactIcon(shielded, 26);
    check(
      /<rect[^>]*fill="var\(--shield\)"/.test(svg),
      `${shielded}: shield is drawn as a band`,
    );
    check(!/<circle[^>]*--shield/.test(svg), `${shielded}: shield is not a ring`);
    check(!/stroke="var\(--shield\)"/.test(svg), `${shielded}: and is not a stroke of any shape`);
  }

  const plain = ENEMY_IDS.find((id) => ENEMIES[id].shield === 0);
  if (plain !== undefined) {
    check(
      !contactIcon(plain, 26).includes('--shield'),
      `${plain}: a contact with no shield spends no shield ink`,
    );
  }
}

// ---------------------------------------------------------------------------
// CAN'T-AFFORD AND LOCKED MUST NOT LOOK ALIKE.
//
// SIX CONTACTS, SIX SILHOUETTES.
//
// The contact spec reversed a rule this renderer had held since the first bake:
// contacts stopped being baked neutral and GPU-tinted, because six distinct
// shapes already mean six bakes and the tint was costing the only two highlights
// in the roster that sit *above* their token.
//
// What can be gated headlessly is not whether they look right — that is the
// acceptance strip, and it needs eyes — but the properties that stop them
// looking wrong in ways nobody would notice until a screenshot: a shape that
// overflows the shared bake frame and is silently cropped, a value the ramp
// pushed cool, a lobe count that stopped matching what the contact splits into.
// ---------------------------------------------------------------------------
section('contacts · shape, ramp and the frame they share');
{
  // Every contact must fit the *one* square frame all six bake to. `worldView`
  // scales each sprite by `def.radius / CREEP_BAKE_RADIUS` against that assumed
  // frame, so a shape that reached further would not merely be cropped — every
  // contact of that type would sit at the wrong size. The Mote's tail is the
  // one that comes close, capped at 1.45R for exactly this reason.
  const frame = Math.max(1, THEME.shape.glowRatio);
  for (const id of ENEMY_IDS) {
    const reach = contactExtent(contactShape(id));
    check(
      reach <= frame,
      `${id}: the whole shape fits the bake frame`,
      `reaches ${reach.toFixed(2)}R, frame is ${frame.toFixed(2)}R`,
    );
  }

  // The deck and the board draw from one geometry, so the glyph has to spend an
  // element on every part — a silently dropped wedge would leave the Bulwark
  // five-plated in the legend and six-plated on the board, and nothing else
  // would ever say so.
  for (const id of ENEMY_IDS) {
    const spec = contactShape(id);
    const want = spec.parts.length + (spec.seam === undefined ? 0 : 1) + (ENEMIES[id].shield > 0 ? 1 : 0);
    const drawn = contactIcon(id, 26).match(/<(circle|path|rect)\b/g)?.length ?? 0;
    check(drawn === want, `${id}: the glyph draws every part the bake does`, `${drawn} of ${want}`);
  }

  // The two shapes that carry a number read it from content rather than
  // restating it, so a Cluster that split into four would draw four lobes.
  const lobes = ENEMIES.cluster.splitInto?.count ?? 0;
  const discs = contactShape('cluster').parts.filter((p) => p.kind === 'disc').length;
  check(discs === lobes * 2, 'cluster: one lobe and one nucleus per child', `${discs} discs, ${lobes} children`);

  for (const id of ENEMY_IDS) {
    const spec = contactShape(id);
    if (spec.seam === undefined) continue;
    check(ENEMIES[id].armor > 0, `${id}: a plate line means plates`);
    check(
      spec.seam.width >= 0.03 && spec.seam.width <= 0.1,
      `${id}: the seam stays a line at any armour`,
      `${spec.seam.width}`,
    );
  }

  // --- The ramp. Gated on its properties, not on the doc's literal hexes: the
  // spec quotes specimens that no single lightness multiplier can reproduce
  // (its brightened values are desaturated toward white, which multiplying
  // cannot do once a channel clips), so `step` is a two-sided ramp and the
  // agreement with those specimens is close rather than exact.
  const KS = [0.28, 0.47, 0.58, 0.62, 0.78, 1, 1.13, 1.22, 1.35];
  const chan = (c: number, shift: number): number => (c >> shift) & 255;

  for (const id of ENEMY_IDS) {
    const token = THEME.enemies[id];

    // Monotonic in k, per channel. A ramp that dipped anywhere would make a
    // "brighter" wedge darker than the one beside it.
    let rising = true;
    for (let i = 1; i < KS.length; i++) {
      const lo = step(token, KS[i - 1]!);
      const hi = step(token, KS[i]!);
      for (const s of [16, 8, 0]) if (chan(hi, s) < chan(lo, s)) rising = false;
    }
    check(rising, `${id}: the ramp never dips`, KS.map((k) => step(token, k).toString(16)).join(' '));

    // Hue survives. Not "R > G > B" — the Drifter's pink is R > B > G — but
    // that whatever order the token has, every value derived from it keeps.
    const order = (c: number): string =>
      [16, 8, 0]
        .map((s) => ({ s, v: chan(c, s) }))
        .sort((a, b) => b.v - a.v)
        .map((e) => e.s)
        .join(',');
    for (const k of KS) {
      const shaded = step(token, k);
      // Ties are allowed at the top: two channels both clipped to 255 have no
      // order left to preserve, and insisting on one would be insisting on a
      // rounding artefact.
      const same = order(shaded) === order(token) || chan(shaded, 16) === chan(shaded, 8);
      check(same, `${id}: x${k} keeps the token's hue`, `${token.toString(16)} → ${shaded.toString(16)}`);
    }

    // No contact value is cool at any point on its ramp. The board's only cool
    // tokens are `fx.shield` and `fx.slowRing`, both chrome, and a contact that
    // drifted blue would read as a status rather than as a thing.
    for (const k of KS) {
      const v = step(token, k);
      check(
        chan(v, 16) > chan(v, 0),
        `${id}: x${k} stays warm`,
        `#${v.toString(16).padStart(6, '0')}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CAN'T-AFFORD AND LOCKED MUST NOT LOOK ALIKE.
//
// They used to share one signal — a dimmed slot — for two unrelated facts, so
// the player had to read to find out which. The design's test is that the four
// states are distinguishable with the type hidden; what is checkable headlessly
// is the half that makes that possible: that each state emits its own markup,
// that short states the real arithmetic, and that locked stays silent about
// money because it is not a decision yet.
// ---------------------------------------------------------------------------
section('hud · build slot states');
{
  const ui = { deckOpen: true, selected: null, inspecting: null } as unknown as Parameters<
    typeof renderSlots
  >[1];
  const armedUi = { ...ui, selected: TOWER_IDS[0]! } as typeof ui;

  const rich = createWorld(map, 4242);
  rich.money = 100_000;
  const broke = createWorld(map, 4242);
  broke.money = 0;

  const affordable = renderSlots(rich, ui);
  const unaffordable = renderSlots(broke, ui);

  check(!affordable.includes('$'), 'slots carry no currency sigil');
  check(!affordable.includes('class="slot poor'), 'affordable slots are not marked short');
  check(unaffordable.includes('short '), 'unaffordable slots name the gap');
  check(renderSlots(rich, armedUi).includes('armed'), 'the armed slot is marked');

  // ---------------------------------------------------------------------------
  // THE DECK IS A FIXED COMPOSITION, SO SLOT COUNT IS A BUDGET.
  //
  // `pixiApp.ts` lays the HUD out at the board's *logical* size — 1040x600 — and
  // scales the whole thing rather than reflowing it, precisely so narrow widths
  // shrink the deck instead of clipping the send control. That has one
  // consequence worth pinning: a slot is a fixed 78px with an 8px gap
  // (`styles.css`), whatever the viewport, so adding a station never makes the
  // existing slots smaller — it spends room.
  //
  // **Which room, is what changed when the roster doubled.** This gate used to
  // read the budget as horizontal, and said so: six fitted in one row at
  // 6*78 + 5*8 = 508px against a 430px detail panel, seven wanted 594px and did
  // not fit, and therefore "a seventh station is a deck layout task first and a
  // balance task second". That was correct and it is what happened — twelve
  // stations in one row want 1024px, which is 414px over.
  //
  // The layout answer was a 6x2 grid, and the interesting part is that it costs
  // *nothing* horizontally: six columns is the same 508px one row of six was.
  // So the width assertion below is now permanently slack, and the constraint
  // that actually binds is height. Both are gated, because a budget nobody can
  // exceed stops being a budget and starts being decoration.
  //
  //   width  6 wide  -> 6*78 + 5*8 = 508px of the 1040, +430 detail = 938
  //   height 2 deep  -> 2*74 + 8 + 17.5 heading = 173.5px of DECK_PX's 200
  //   3 rows         -> 255.5px, which is what a thirteenth station would want
  //
  // So a thirteenth station is still a deck layout task first. It just fails on
  // the vertical gate now instead of the horizontal one.
  const SLOT_PX = 78;
  const SLOT_GAP = 8;
  const SLOT_H = 74;
  const SLOT_COLS = 6;
  const HEADING_PX = 17.5;
  const DETAIL_CAP = 430;
  const LOGICAL_W = 1040;
  const slotRows = Math.ceil(TOWER_IDS.length / SLOT_COLS);
  const perRow = Math.min(TOWER_IDS.length, SLOT_COLS);
  const slotsWidth = perRow * SLOT_PX + (perRow - 1) * SLOT_GAP;
  check(
    slotsWidth + DETAIL_CAP <= LOGICAL_W,
    'the deck grid fits the logical board width',
    `${perRow} wide = ${slotsWidth}px + ${DETAIL_CAP}px detail vs ${LOGICAL_W}px`,
  );

  const slotsHeight = slotRows * SLOT_H + (slotRows - 1) * SLOT_GAP + HEADING_PX;
  check(
    slotsHeight <= DECK_PX,
    'and the deck grid fits the height it reserves',
    `${slotRows} rows = ${slotsHeight}px vs ${DECK_PX}px`,
  );

  // The grid is declared `repeat(6, 78px)`, so a thirteenth station does not
  // widen the row — it silently starts a third one inside a deck with no room
  // for it. This is the assertion that makes that loud.
  check(
    TOWER_IDS.length <= SLOT_COLS * 2,
    'the roster still fits two rows of six',
    `${TOWER_IDS.length} stations`,
  );

  // TypeScript does not read CSS, and the whole width argument above rests on
  // the column count being fixed. If `.slots` ever goes back to a wrapping flex
  // container the arithmetic here keeps passing while the real layout rebreaks
  // at whatever width it is handed. Same technique, and same justification, as
  // the `pointer-events` gate further down.
  check(
    /\.slots\s*\{[^}]*grid-template-columns:\s*repeat\(6,/.test(
      readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8'),
    ),
    'and the stylesheet pins six columns rather than wrapping',
  );

  // ---------------------------------------------------------------------------
  // ...AND VERSUS SPENDS THE SAME BUDGET TWICE OVER.
  //
  // The check above counts the campaign's two flexible items and nothing else,
  // which is exactly how versus shipped broken: it renders two sections the
  // campaign never does — the sortie deck and its own Send button — and all
  // four together wanted ~1515px of the 1008 inside the panel's padding. Flex
  // does not report an over-subscribed row, it just pays for it out of whatever
  // can shrink, so the overrun landed on the inspector (68px — narrower than
  // ONE of its three upgrade buttons, so a versus player could select a tower
  // and not upgrade it) and on Send, which was pushed clean off the panel's
  // right edge. Neither is visible in a screenshot of a board with no tower
  // selected, which is why it survived.
  //
  // `renderDeck` wraps into two rows there. Both are budgeted here against the
  // same 1040, with the rigid items only — a build slot and a sortie card are
  // fixed px, whereas `.send`'s hint wraps, so only its button is reserved.
  const PANEL_PAD = 32; // .deck .panel { padding: 0 16px }
  const ROW_GAP = 16; //   .panel.rows .row { gap: 16px }
  const SEP_PX = 1;
  const SORTIE_PX = 52;
  const SORTIE_GAP = 6;
  const SEND_PX = 150;
  const sortiesWidth = SORTIE_IDS.length * SORTIE_PX + (SORTIE_IDS.length - 1) * SORTIE_GAP;

  // Defence on top: build | sep | detail. Offence below: sorties | sep | send.
  const defenceRow = PANEL_PAD + slotsWidth + SEP_PX + DETAIL_CAP + 2 * ROW_GAP;
  const offenceRow = PANEL_PAD + sortiesWidth + SEP_PX + SEND_PX + 2 * ROW_GAP;
  check(
    defenceRow <= LOGICAL_W,
    'versus deck: the defence row fits',
    `${slotsWidth}px slots + ${DETAIL_CAP}px detail = ${defenceRow}px vs ${LOGICAL_W}px`,
  );
  check(
    offenceRow <= LOGICAL_W,
    'versus deck: the offence row fits',
    `${SORTIE_IDS.length} sorties = ${sortiesWidth}px + ${SEND_PX}px send = ${offenceRow}px vs ${LOGICAL_W}px`,
  );

  // The wrap is load-bearing, not stylistic: state the overrun that forces it,
  // so nobody unwraps the rows to "simplify" and reintroduces a 68px inspector.
  const oneRow = defenceRow + sortiesWidth + SEP_PX + SEND_PX + 2 * ROW_GAP;
  check(
    oneRow > LOGICAL_W,
    'versus deck: one row could not have held it',
    `${oneRow}px vs ${LOGICAL_W}px — the wrap is required, not decorative`,
  );

  // ---------------------------------------------------------------------------
  // THE CAMPAIGN ROW HAS A THIRD SECTION, AND NOTHING WAS COUNTING IT.
  //
  // Every budget above models `build + detail`. The campaign row is
  // `build | sep | detail | sep | send`, and the send column was never in the
  // arithmetic — so `slotsWidth + DETAIL_CAP <= 1040` passed comfortably while
  // the real row handed the inspector 197px of its 430px cap.
  //
  // At 197 the upgrade buttons overlap their own labels: `.path` column one is
  // `minmax(0, 1fr)`, which shrinks below its content, and the text inside is
  // `nowrap`, so it spills sideways over the pips and the price rather than
  // wrapping. That shipped, and it was found in a README screenshot rather than
  // here — which is exactly the failure this file exists to prevent.
  //
  // The measured floor is what the widest station needs, and the widest is not
  // the obvious one: Salvage has the longest effect label *and* only two tracks,
  // and two buttons in a hardcoded three-column grid each got a third of the
  // width instead of a half. Sizing the columns to the actual button count took
  // its requirement from 340px to 240.
  //  The widest the campaign send column gets, measured across every wave of
  //  every arc: its Send button, not its hint. Four gaps, not two — the row is
  //  build | sep | detail | sep | send, which is five children.
  const CAMPAIGN_SEND_PX = 160;
  //  What the widest station's inspector needs, measured by shrinking the panel
  //  until the upgrade buttons stop clipping. Lance is the worst at 265: PIERCE
  //  is a long label and it is one of the ten stations carrying all three
  //  tracks. Salvage and Sentinel look worse and are not — two buttons share the
  //  width two ways now.
  const DETAIL_MIN = 265;
  const campaignRow = PANEL_PAD + slotsWidth + SEP_PX + SEP_PX + CAMPAIGN_SEND_PX + 4 * ROW_GAP;
  check(
    campaignRow + DETAIL_MIN <= LOGICAL_W,
    'campaign deck: the row leaves the inspector room to render',
    `${LOGICAL_W - campaignRow}px for detail, widest station needs ${DETAIL_MIN}px`,
  );

  // The cap the hint is held to is what keeps `send` at its button's width
  // rather than its sentence's. Read from the stylesheet for the same reason the
  // grid column count is: TypeScript does not read CSS, and this is a one-line
  // deletion away from silently costing the inspector 79px again.
  check(
    /\.send \.hint \{[^}]*max-width:/.test(
      readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8'),
    ),
    'and the send hint wraps rather than setting the column width',
  );

  // And that the markup answers the overrun somehow. It used to wrap into two
  // rows; it now docks into four panels around the board, which answers the
  // same arithmetic by spending width the letterbox was wasting rather than
  // height. The row budgets above are kept because they are the *reason* — they
  // state what a single row costs, and that is still what rules a single row
  // out. What is asserted here is the current answer, not the old one.
  const deckUi = { ...ui, sortieLane: 0 } as unknown as Parameters<typeof renderDeck>[1];
  const fight = versusWorld();
  fight.money = 100_000;
  const versusDeck = renderDeck(fight, deckUi, undefined);
  const campaignDeck = renderDeck(rich, deckUi, undefined);
  const docks = ['build', 'detail', 'sorties', 'era'];
  check(
    versusDeck.includes('class="panel docks"') &&
      docks.every((d) => versusDeck.includes(`class="${d}"`)),
    'versus deck: renders four docks',
    docks.filter((d) => versusDeck.includes(`class="${d}"`)).join(' · '),
  );
  // The whole point of docking, in one number: the column that held the
  // inspector was 68px when the row over-subscribed and 430 at its cap. It is
  // now wider than the cap, in its own reserved space, and cannot be squeezed
  // by a sibling — because it no longer has any.
  check(
    DOCK_DETAIL_PX > DETAIL_CAP,
    'versus deck: the detail column beats the flex cap it replaces',
    `${DOCK_DETAIL_PX}px docked vs ${DETAIL_CAP}px capped`,
  );
  // The docked stage has to actually contain its docks, or the columns render
  // off the letterbox edge at every scale.
  //
  // 1685 → 1768 when the build dock went two columns wide to hold twelve
  // stations. That is not free: a 1440-wide window scales the docked stage
  // 0.855 → 0.814, so the board loses 4.8%, and nothing changes at 1768px or
  // wider. It is the right trade only because the alternative was 42.5 CSS px
  // build slots — see `DOCK_BUILD_PX`, which carries the arithmetic.
  //
  // An exact equality rather than a bound, on purpose: this is the one number
  // that has to be re-derived by hand when any dock width moves, and a `<=`
  // would let a shrinking dock drift without saying so.
  const stageW =
    DOCK_MARGIN + DOCK_BUILD_PX + DOCK_GAP + LOGICAL_W + DOCK_GAP + DOCK_DETAIL_PX + DOCK_MARGIN;
  check(
    stageW === 1768,
    'versus deck: the docked stage closes on its own arithmetic',
    `${DOCK_BUILD_PX} + ${LOGICAL_W} + ${DOCK_DETAIL_PX} + gaps = ${stageW}px`,
  );

  // The docked build dock is the one place a slot's height is an *outcome*
  // rather than a constant — it is a grid filling a fixed column — so it is the
  // one place a wider roster can silently produce unhittable controls. It did:
  // twelve slots in one column is 49.8px, which is 42.5 CSS px once the stage is
  // scaled on a 1440-wide window.
  const DOCK_STAGE_H = 944;
  const DOCK_BUILD_H = DOCK_STAGE_H - 82 - (DOCK_MARGIN + DOCK_ERA_PX + DOCK_GAP);
  const dockSlotRows = Math.ceil(TOWER_IDS.length / 2);
  const dockSlotH = (DOCK_BUILD_H - DOCK_MARGIN - 20 - (dockSlotRows - 1) * 7) / dockSlotRows;
  check(
    dockSlotH >= TAP_PX,
    'versus deck: docked build slots clear the touch floor',
    `${dockSlotRows} rows = ${dockSlotH.toFixed(1)}px vs ${TAP_PX}px`,
  );
  check(
    campaignDeck.includes('class="panel"') && !campaignDeck.includes('class="row"'),
    'campaign deck: still one row',
  );

  // -------------------------------------------------------------------------
  // THE DOCKS DO NOT SWALLOW THE BOARD.
  //
  // `.deck .panel` takes pointer events, because a panel under the board is
  // always something you click. Docked, that same element is stretched over
  // the WHOLE stage with `inset: 0` — so inheriting the rule laid an invisible
  // click-eater across every buildable tile and no station could be placed at
  // all. Nothing threw, nothing logged, and every gate here still passed: the
  // markup was right and the geometry was right, and the game was unplayable.
  //
  // Checked by reading the stylesheet because that is where the bug lives.
  // Crude, and worth it for a failure this total and this quiet.
  // -------------------------------------------------------------------------
  const cssText = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const docksBlock = /\.panel\.docks\s*\{([^}]*)\}/.exec(cssText);
  check(
    docksBlock !== null && /pointer-events:\s*none/.test(docksBlock[1] ?? ''),
    'the docked panel is transparent to the pointer',
    docksBlock === null ? 'no .panel.docks rule found' : 'so the board underneath stays clickable',
  );
  check(
    /\.docks\s*>\s*section[^{]*\{[^}]*pointer-events:\s*auto|\.docks\s*>\s*section,[\s\S]{0,80}?pointer-events:\s*auto/.test(
      cssText,
    ),
    'and the docks themselves take it back',
    'panels are controls; the space between them is not',
  );

  // -------------------------------------------------------------------------
  // TWO ROWS OF KEYS, AND NO KEY IN BOTH.
  //
  // Build is 1-6 and send is Q-Y, one row above it. A collision would mean a
  // key that armed a station *and* spent money on a contact, which is the
  // worst possible way to find out.
  // -------------------------------------------------------------------------
  // Widened to string on purpose. As literal unions these two are provably
  // disjoint and `includes` will not even typecheck — which is a real
  // guarantee, but only while both tables stay `as const`. The gate is what
  // survives someone loosening either type.
  const sortieKeys: string[] = SORTIE_IDS.map((id) => SORTIES[id].hotkey);
  const towerKeys: string[] = TOWER_IDS.map((id) => TOWERS[id].hotkey);
  check(
    sortieKeys.every((k) => k.length === 1 && k === k.toLowerCase()),
    'every sortie has a single lower-case hotkey',
    sortieKeys.join(' '),
  );
  check(
    new Set(sortieKeys).size === sortieKeys.length,
    'no two sorties share a key',
    sortieKeys.join(' '),
  );
  // The same two assertions, mirrored onto the build deck. Only the sortie table
  // was checked before, which was reasonable when it was the one that had grown
  // — and then the build deck doubled and inherited two awkward keys (`-`, `=`)
  // with nothing watching them.
  check(
    towerKeys.every((k) => k.length === 1),
    'every station has a single-character hotkey',
    towerKeys.join(' '),
  );
  check(
    new Set(towerKeys).size === towerKeys.length,
    'no two stations share a key',
    towerKeys.join(' '),
  );
  const clash = sortieKeys.filter((k) => towerKeys.includes(k));
  check(
    clash.length === 0,
    'no key both arms a station and sends a contact',
    clash.length === 0 ? `build ${towerKeys.join('')} · send ${sortieKeys.join('')}` : clash.join(' '),
  );
  // Reserved by the input layer for things that are not a purchase.
  // Space is Send, Shift+Space arms auto-rush, Tab collapses the deck and Escape
  // clears the selection. None of the four is a purchase.
  const reserved = ['tab', ' ', 'escape'];
  check(
    [...sortieKeys, ...towerKeys].every((k) => !reserved.includes(k)),
    'and no purchase key is one the deck already owns',
    reserved.join(' '),
  );

  // The shortfall is arithmetic, not decoration: it has to be the real number.
  const first = TOWERS[TOWER_IDS[0]!];
  const partial = createWorld(map, 4242);
  partial.money = first.cost - 40;
  check(
    renderSlots(partial, ui).includes('short 40'),
    'the gap is the real difference',
    `cost ${first.cost} - money ${partial.money}`,
  );

  // Locked slots exist only if something is gated; all three boards gate two.
  const locked = TOWER_IDS.filter((id) => TOWERS[id].unlockWave > 0);
  check(locked.length > 0, 'something is gated behind a wave', `${locked.length} stations`);
  for (const id of locked) {
    const def = TOWERS[id];
    // A locked slot renders as a div, so it cannot be armed at all — the state
    // is enforced by the markup rather than by a guard someone can forget.
    check(
      affordable.includes(`Wave ${def.unlockWave + 1}`),
      `${id}: locked slot states its wave`,
      `wave ${def.unlockWave + 1}`,
    );
  }
  check(
    !/class="slot locked"[^]*?short /.test(affordable),
    'locked slots never show a shortfall',
  );
}

// ---------------------------------------------------------------------------
// A CLOSED DECK DOES NO DOM WORK.
//
// The closed deck is one static handle, so its key must not move — otherwise
// the whole region re-renders on every kill to redraw a chevron. That was the
// real cost of the status strip that used to live there, and deleting the strip
// only fixes it while the key stays constant.
//
// The early return in `deckKey` is a trapdoor: anything live added to the
// closed deck later will silently freeze instead of updating. This is the
// assertion that turns that into a failure rather than a mystery.
// ---------------------------------------------------------------------------
section('hud · closed deck is inert');
{
  const world = createWorld(map, 4242);
  const shut = { deckOpen: false, selected: null, inspecting: null } as unknown as Parameters<
    typeof deckKey
  >[1];
  const open = { deckOpen: true, selected: null, inspecting: null } as unknown as Parameters<
    typeof deckKey
  >[1];

  const keys = new Set<string>();
  const openKeys = new Set<string>();

  // A real run: money changes, waves advance, contacts die.
  const acc: Accumulator = { debt: 0 };
  world.commands.push({ type: 'startWave' });
  for (let i = 0; i < TICK_HZ * 40; i++) {
    advance(world, acc, 1000 / TICK_HZ, 1);
    world.events.length = 0;
    keys.add(deckKey(world, shut, undefined));
    openKeys.add(deckKey(world, open, undefined));
  }

  check(keys.size === 1, 'closed deck: key never changes', `${keys.size} distinct over 40s`);
  check(openKeys.size > 1, 'open deck: key still tracks the run', `${openKeys.size} distinct`);
}

// ---------------------------------------------------------------------------
// EVERY STATION HAS A MARK, AND EVERY MARK FITS WHERE IT IS ALLOWED TO.
//
// The deck's glyph and the board's bake read the same geometry so they cannot
// drift — but sharing it only helps if the geometry is complete and in bounds.
// A station with no mark comes out as a bare hexagon nobody can tell from its
// neighbour, and a mark that strays outside its annulus collides with the hub,
// the tier pips or the hull, each of which is already saying something else.
// ---------------------------------------------------------------------------
section('stations · mechanic marks');
{
  // Set by the hub below and the pip row above; see `stationShape.ts`.
  const INNER = 0.15;
  const OUTER = 0.34;
  const LOWEST = 0.72;

  check(
    Object.keys(STATION_MARKS).length === TOWER_IDS.length,
    'every station has a mark',
    `${Object.keys(STATION_MARKS).length} of ${TOWER_IDS.length}`,
  );

  for (const id of TOWER_IDS) {
    const mark = STATION_MARKS[id];
    const pts = [
      ...mark.lines.flat(),
      ...mark.discs.map((d) => ({ x: d.cx, y: d.cy })),
    ];

    check(
      pts.length > 0 || mark.arcs.length > 0,
      `${id}: mark is not empty`,
      `${mark.lines.length} lines · ${mark.discs.length} discs · ${mark.arcs.length} arcs`,
    );

    let worstOut = 0;
    let lowest = 0;
    for (const p of pts) {
      worstOut = Math.max(worstOut, Math.hypot(p.x - 0.5, p.y - 0.5));
      lowest = Math.max(lowest, p.y);
    }
    for (const a of mark.arcs) worstOut = Math.max(worstOut, a.r);

    check(worstOut <= OUTER, `${id}: mark stays inside the hull`, `reaches ${worstOut.toFixed(3)} of ${OUTER}`);
    check(lowest <= LOWEST, `${id}: mark clears the tier pips`, `lowest ${lowest.toFixed(2)} of ${LOWEST}`);

    // A mark entirely inside the hub would be hidden by the core, which grows
    // with tier — so it would vanish exactly as the station got interesting.
    const reaches = Math.max(worstOut, ...mark.arcs.map((a) => a.r));
    check(reaches >= INNER, `${id}: mark clears the core`, `reaches ${reaches.toFixed(3)}`);
  }
}

// ---------------------------------------------------------------------------
// THE CONTRAST ORDER, FOR THE LAYERS THAT ARE SOLID FILLS.
//
// The design's checklist says to desaturate a running frame and read the order
// brightest-last: field, nebula, grid, route, pulsar, station, projectile,
// contact, hit flash. Most of that needs a rendered frame and stays a human
// test — a station is a 2.2px stroke around a 0.2-alpha interior, so its *tint*
// luminance says almost nothing about how bright it lands on screen.
//
// But the structural layers are flat fills at known alphas over known
// backgrounds, so their order can be computed exactly. That half becomes a
// gate; the foreground half stays on the checklist where it belongs.
//
// This caught two real inversions when it was written: a nebula plate a hair
// brighter than the grid, and a centre line whose bright end out-glowed every
// station on the board.
// ---------------------------------------------------------------------------
section('board · contrast order');
{
  const chan = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (h: number): number =>
    0.2126 * chan((h >> 16) & 255) + 0.7152 * chan((h >> 8) & 255) + 0.0722 * chan(h & 255);
  const over = (fg: number, a: number, bg: number): number => {
    const m = (s: number): number =>
      Math.round((((fg >> s) & 255) * a + ((bg >> s) & 255) * (1 - a)) as number);
    return (m(16) << 16) | (m(8) << 8) | m(0);
  };

  for (const id of SECTOR_FIELD_IDS) {
    const f = SECTOR_FIELDS[id];
    const ground = over(f.ground, f.groundAlpha, f.bg);

    const layers: readonly (readonly [string, number])[] = [
      ['field', ground],
      ['nebula', over(f.blocked, f.blockedAlpha, f.bg)],
      ['grid', over(f.gridLine, f.gridAlpha, ground)],
      ['route', f.pathLit],
      ['line', over(f.lineFar, f.lineFarAlpha, f.pathLit)],
    ];

    let ok = true;
    const trail: string[] = [];
    for (let i = 0; i < layers.length; i++) {
      trail.push(`${layers[i]![0]} ${lum(layers[i]![1]).toFixed(4)}`);
      if (i > 0 && lum(layers[i]![1]) <= lum(layers[i - 1]![1])) ok = false;
    }
    check(ok, `${id}: structural layers get brighter in order`, trail.join(' < '));

    // The route may glow; it may never out-glow a station. The dimmest station
    // is the one that has to survive it.
    const dimmest = Math.min(...Object.values(THEME.towers).map(lum));
    const line = lum(over(f.lineFar, f.lineFarAlpha, f.pathLit));
    check(line < dimmest, `${id}: the centre line stays under the dimmest station`,
      `line ${line.toFixed(3)} < ${dimmest.toFixed(3)}`);

    // Warm belongs to the contacts. A warm field at any value takes the one
    // signal that says "this is something to shoot".
    for (const [name, v] of [['bg', f.bg], ['ground', f.ground], ['groundAlt', f.groundAlt],
      ['blocked', f.blocked], ['path', f.path], ['pathLit', f.pathLit]] as const) {
      check(((v >> 16) & 255) <= (v & 255), `${id}: ${name} is not warm`, `#${v.toString(16).padStart(6, '0')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// NO TWO STATIONS MAY WEAR THE SAME COLOUR.
//
// `theme.ts` states the requirement — "a fourth blue would be unreadable in a
// crowd; the damage numbers are tinted by station, so these have to separate at
// a glance and at 13px" — and nothing enforced it. The gate above checks each
// tint against the *board*, which is a different question: two stations can both
// clear the route and be indistinguishable from each other.
//
// It was not hypothetical. Overclock's first tint was a warm yellow picked to
// sit far from Singularity, and it landed 64.6 from Nova against a roster whose
// worst pair was 91.2 — the least legible colour in the game, shipped without
// anything noticing.
//
// Redmean rather than CIE Lab: it is four lines, it is the standard cheap
// approximation, and the failure being caught is "these two are obviously the
// same colour", which does not need a colorimeter. The floor is set just under
// the roster's tightest surviving pair, so it pins today's design and fails on
// a regression rather than encoding an aspiration.
// ---------------------------------------------------------------------------
section('board · stations are told apart by colour');
{
  const MIN_SEPARATION = 85;
  const chan = (h: number): [number, number, number] => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  const separation = (a: number, b: number): number => {
    const [r1, g1, b1] = chan(a);
    const [r2, g2, b2] = chan(b);
    const rm = (r1 + r2) / 2;
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  };

  let worst = Infinity;
  let worstPair = '';
  for (let i = 0; i < TOWER_IDS.length; i++) {
    for (let j = i + 1; j < TOWER_IDS.length; j++) {
      const a = TOWER_IDS[i]!;
      const b = TOWER_IDS[j]!;
      const sep = separation(THEME.towers[a], THEME.towers[b]);
      if (sep < worst) {
        worst = sep;
        worstPair = `${a} vs ${b}`;
      }
    }
  }

  check(
    worst >= MIN_SEPARATION,
    `every pair of station tints separates by at least ${MIN_SEPARATION}`,
    `worst ${worst.toFixed(1)} · ${worstPair}`,
  );
}

// ---------------------------------------------------------------------------
// THE ROUTE RAMP AGREES WITH THE MAP.
//
// The corridor's fill, its spill and its centre line all key off
// `routeDistance`, so a board where that is wrong is a board that lies about
// which way contacts travel — and it would lie quietly, since a plausible-
// looking gradient is exactly what a bug here produces.
//
// `route.ts` is pixi-free precisely so this can run headlessly.
// ---------------------------------------------------------------------------
section('board · route ramp');
{
  for (const src of CAMPAIGN.map((l) => l.map)) {
    const m = parseMap(src);
    const dist = routeDistance(m);

    let marked = 0;
    let onRoute = 0;
    let outOfRange = 0;
    for (let i = 0; i < dist.length; i++) {
      if (m.tiles[i] === 'path') onRoute++;
      if (dist[i] === OFF_ROUTE) continue;
      marked++;
      if (dist[i]! < 0 || dist[i]! > 1) outOfRange++;
    }

    check(marked === onRoute, `${m.name}: every route tile has a distance`, `${marked} of ${onRoute}`);
    check(outOfRange === 0, `${m.name}: distances stay in 0..1`, `${outOfRange} outside`);

    // The goal is the far end by construction; if it is not, the ramp runs
    // backwards and the board points contacts the wrong way.
    const goal = dist[Math.floor(m.goal.y) * m.cols + Math.floor(m.goal.x)]!;
    check(goal > 0.99, `${m.name}: the ramp peaks at the pulsar`, `goal t=${goal.toFixed(3)}`);

    // Spill must actually reach ground, or the road lights nothing.
    const spill = routeSpill(m, dist, SPILL_RINGS);
    let lit = 0;
    for (let i = 0; i < spill.length; i++) {
      if (spill[i]! >= 1 && spill[i]! <= SPILL_RINGS && m.tiles[i] === 'ground') lit++;
    }
    check(lit > 0, `${m.name}: the road lights the ground beside it`, `${lit} tiles`);
  }
}

// ---------------------------------------------------------------------------
// THE GRID MAY FADE AT THE EDGES; IT MAY NOT FADE WHERE A PLAYER BUILDS.
//
// The one line of the design's acceptance checklist that is pure geometry, so
// it can be a gate instead of a checkbox. `gridMaskAt` is deliberately
// pixi-free for exactly this reason — the invariant is only worth stating if
// something checks it.
//
// Every map, every buildable tile, all four of its edges. A fourth map with a
// different aspect ratio now fails here rather than shipping a corner the
// player cannot aim at.
// ---------------------------------------------------------------------------
section('board · grid legibility');
{
  const EDGE_OFFSETS: readonly (readonly [number, number])[] = [
    [0.5, 0],
    [0.5, 1],
    [0, 0.5],
    [1, 0.5],
  ];

  for (const src of CAMPAIGN.map((l) => l.map)) {
    const m = parseMap(src);
    const w = m.cols * TILE_PX;
    const h = m.rows * TILE_PX;

    let worst = Infinity;
    let worstAt = '';
    for (let row = 0; row < m.rows; row++) {
      for (let col = 0; col < m.cols; col++) {
        if (!isBuildableTile(m, col, row)) continue;
        for (const [dx, dy] of EDGE_OFFSETS) {
          const mask = gridMaskAt((col + dx) * TILE_PX, (row + dy) * TILE_PX, w, h);
          if (mask < worst) {
            worst = mask;
            worstAt = `${col},${row}`;
          }
        }
      }
    }

    check(
      worst >= GRID_MASK_FLOOR,
      `${m.name}: grid survives on every buildable tile`,
      `dimmest ${worst.toFixed(3)} at ${worstAt}, floor ${GRID_MASK_FLOOR}`,
    );
  }

  // The fade has to actually fade, or the mask is a no-op dressed as a feature
  // — which is precisely what the design's own numbers turned out to be.
  const m = parseMap(LEVEL01);
  const w = m.cols * TILE_PX;
  const h = m.rows * TILE_PX;
  const centre = gridMaskAt(w / 2, h / 2, w, h);
  const corner = gridMaskAt(0, 0, w, h);
  check(centre === 1 && corner < 0.6, 'the fade is visible', `centre ${centre.toFixed(2)} · corner ${corner.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// `title` does not exist on a touch screen. Anything a player has to read in
// order to choose has to be text, and the armed panel is where choosing
// happens. The counterpart budget — the inspector staying near-wordless — is
// gated above; these two pull in opposite directions on purpose, so both need
// to be held or one will quietly eat the other.
section('hud · the armed panel explains itself without hover');
{
  // Same stripper as the word budget: tags and their attributes go, so anything
  // still standing is genuinely on screen.
  const onScreen = (html: string): string => html.replace(/<[^>]*>/g, ' ');

  for (const id of TOWER_IDS) {
    const armed = onScreen(renderArmed(id));
    check(
      armed.includes(TOWERS[id].blurb),
      `${id}: the armed panel states its blurb as text`,
      'not as a title=',
    );
  }

  // The wave preview is where the glyph→name mapping is taught, now that the
  // inspector's armour line deliberately does not repeat it.
  const w = createWorld(map, 99);
  w.wave.index = 6;
  const preview = onScreen(renderNextContact(w));
  const named = ENEMY_IDS.filter((e) => preview.includes(ENEMIES[e].name));
  check(named.length > 0, 'the wave preview names its contacts', `${named.length} named`);
}

// ---------------------------------------------------------------------------
// The volume control is the one preference that persists, so it is the one that
// can be wrong across sessions rather than merely for a minute. Gated on the
// rendered markup rather than on the helper behind it, because what matters is
// which button is lit when the player opens the menu — a correct helper feeding
// a mis-rendered row is exactly the bug this is here to catch.
section('hud · the sound setting reads back what it is set to');
{
  const w = createWorld(map, 99);
  const lit = (volume: number, muted: boolean): string | null => {
    const ui = createUiState();
    ui.prefs.volume = volume;
    ui.prefs.muted = muted;
    const m = /data-act="pref-sound" data-v="([a-z]+)" class="on"/.exec(renderPaused(w, ui));
    return m?.[1] ?? null;
  };

  check(renderPaused(w, createUiState()).includes('pref-sound'), 'the pause menu has a sound row');

  for (const [volume, want] of [[0, 'off'], [0.3, 'low'], [0.6, 'mid'], [1, 'high']] as const) {
    check(lit(volume, false) === want, `volume ${volume} lights "${want}"`, `got ${lit(volume, false)}`);
  }

  // Mute wins over whatever the volume happens to be, and — the part worth
  // gating — muting does not destroy it. Turning the sound off and back on has
  // to return to the level it was at, or the control quietly resets itself
  // every time it is used.
  check(lit(0.85, true) === 'off', 'muting reads as off whatever the volume is', `got ${lit(0.85, true)}`);
  check(lit(0.85, false) === 'high', 'and unmuting returns to the level it was at', `got ${lit(0.85, false)}`);
}

// ---------------------------------------------------------------------------
// The touch placement machine. Gateable at all because gesture.ts is a pure
// reducer with no DOM, no Pixi and no sim — which is most of the reason it is
// written that way. The property under test is the one that costs real money if
// it breaks: nothing may buy a station except a gesture the player could have
// read the verdict from first.
section('input — touch placement');
{
  const TAP = 260;
  const t = (col: number, row: number): Tile => [col, row];
  const run = (evs: GestureInput[]): { g: Gesture; fx: Effect[] } => {
    let g = idleGesture();
    const fx: Effect[] = [];
    for (const ev of evs) {
      const out = reduce(g, ev, TAP);
      g = out.next;
      fx.push(...out.effects);
    }
    return { g, fx };
  };
  const placed = (fx: Effect[]): Effect[] => fx.filter((f) => f.k === 'place');
  const down = (at: number, tile: Tile | null): GestureInput =>
    ({ k: 'boardDown', id: 1, tile, armed: 'lance' as TowerId, at });
  const up = (at: number, tile: Tile | null): GestureInput => ({ k: 'up', id: 1, tile, at });

  // A press long enough to have shown the verdict commits on release.
  check(
    placed(run([down(0, t(3, 4)), up(TAP + 40, t(3, 4))]).fx).length === 1,
    'a deliberate press-and-hold places',
  );

  // A flick too brief to read only parks the preview. This is the whole guard:
  // a board tile is smaller than a fingertip, so a stray tap must not buy.
  const flick = run([down(0, t(3, 4)), up(80, t(3, 4))]);
  check(placed(flick.fx).length === 0, 'a quick tap does not place', 'it pins instead');
  check(
    flick.g.pinned !== null && flick.g.pinned[0] === 3 && flick.g.pinned[1] === 4,
    'a quick tap pins the previewed tile',
  );

  // ...and the second tap on that same tile is the confirmation.
  const confirmDown = reduce(flick.g, down(160, t(3, 4)), TAP);
  check(
    placed(reduce(confirmDown.next, up(200, t(3, 4)), TAP).effects).length === 1,
    'a second quick tap on the pinned tile places',
  );

  // A second tap somewhere else re-pins rather than placing — otherwise the
  // guard would only protect the first tile you touched.
  const elsewhere = run([down(0, t(3, 4)), up(80, t(3, 4)), down(160, t(9, 2)), up(200, t(9, 2))]);
  check(placed(elsewhere.fx).length === 0, 'a quick tap on a different tile re-pins, never places');

  // Sliding off the board and letting go must cost nothing. This is the abort.
  const off = run([down(0, t(3, 4)), { k: 'move', id: 1, tile: null, x: 0, y: 0 }, up(500, null)]);
  check(placed(off.fx).length === 0, 'releasing off the board buys nothing');

  // The system taking the pointer mid-press is not a purchase either.
  const cancelled = run([down(0, t(3, 4)), { k: 'cancel', id: 1 }]);
  check(placed(cancelled.fx).length === 0, 'a cancelled gesture buys nothing');

  // A drag that moved is deliberate however brief — the finger did the reading.
  const dragged = run([
    down(0, t(3, 4)),
    { k: 'move', id: 1, tile: t(5, 4), x: 0, y: 0 },
    up(60, t(5, 4)),
  ]);
  check(placed(dragged.fx).length === 1, 'a short but moving drag places', 'movement is intent');

  // A palm landing mid-gesture must not hijack or cancel the live one.
  const palm = run([
    down(0, t(3, 4)),
    { k: 'boardDown', id: 2, tile: t(1, 1), armed: 'lance' as TowerId, at: 10 },
    up(TAP + 40, t(3, 4)),
  ]);
  const palmPlaces = placed(palm.fx);
  check(
    palmPlaces.length === 1 && palmPlaces[0]!.k === 'place' && palmPlaces[0]!.tile[0] === 3,
    'a second finger is ignored, not obeyed',
  );

  // Nothing armed: a tap inspects, and only if it stayed on the tile it began
  // on. Deferring to lift is what stops a scrub opening the inspector.
  const inspect = run([
    { k: 'boardDown', id: 1, tile: t(2, 2), armed: null, at: 0 },
    up(50, t(2, 2)),
  ]);
  check(inspect.fx.some((f) => f.k === 'inspect'), 'an unarmed tap inspects');
  const scrub = run([
    { k: 'boardDown', id: 1, tile: t(2, 2), armed: null, at: 0 },
    { k: 'move', id: 1, tile: t(6, 6), x: 0, y: 0 },
    up(50, t(6, 6)),
  ]);
  check(!scrub.fx.some((f) => f.k === 'inspect'), 'an unarmed scrub does not inspect');

  // Dragging out of a slot arms, then aims. Releasing off-board keeps the arm
  // but buys nothing, and the synthesised click must be eaten either way or
  // the slot's own toggle disarms what the drag just armed.
  const slot = { left: 0, top: 0, right: 40, bottom: 40 };
  const deck = run([
    { k: 'deckDown', id: 1, towerId: 'lance' as TowerId, rect: slot },
    { k: 'move', id: 1, tile: t(7, 3), x: 300, y: 300 },
    up(90, t(7, 3)),
  ]);
  check(deck.fx.some((f) => f.k === 'arm'), 'dragging off a slot arms it');
  check(placed(deck.fx).length === 1, 'dragging from a slot onto the board places');
  check(deck.fx.some((f) => f.k === 'swallowClick'), 'the synthesised click is swallowed');

  const deckStay = run([
    { k: 'deckDown', id: 1, towerId: 'lance' as TowerId, rect: slot },
    { k: 'move', id: 1, tile: null, x: 20, y: 20 },
    up(90, null),
  ]);
  check(
    !deckStay.fx.some((f) => f.k === 'arm') && placed(deckStay.fx).length === 0,
    'a press that never leaves the slot defers to the DOM click',
  );
}

// ---------------------------------------------------------------------------
// SUPPORT THAT BUFFS TOWERS RATHER THAN DEBUFFING CONTACTS.
//
// Overclock is the first station whose target is a tower, and that makes it the
// first one whose effect nothing on the board can show. Every other station is
// checkable by watching a contact; this one is only checkable by watching
// another station's rate, which is exactly why it needs gates rather than a
// play-test.
//
// The buff is authored as `+shots per second`, additively, and the arithmetic
// below is what pins that: a multiplier on `fireInterval` would pass a "does it
// fire faster" check just as well, and would be a different — and much more
// dangerous — station. See `TowerDef.buffShotsPerSecond`.
// ---------------------------------------------------------------------------
section('combat · support feeds rate, additively');
{
  /** A board past every unlock with money to burn, and nothing spawning. */
  const rig = (): World => {
    const w = createWorld(map, 31337);
    w.wave.phase = 'done';
    w.wave.index = 10;
    w.money = 5000;
    return w;
  };

  const place = (w: World, defId: TowerId, col: number, row: number): Tower => {
    w.commands.push({ type: 'placeTower', defId, col, row });
    stepWorld(w, DT);
    return w.towers[w.towers.length - 1]!;
  };

  /**
   * Seconds between shots, measured from the sim rather than read off a stat.
   *
   * First-to-last over the gaps between them, so the partial interval at each
   * end does not bias the mean — the same reason the fire-rate drift gate above
   * measures the way it does. `towerFired` carries no id, but it carries the
   * position, and towers are tile-aligned so the position *is* an id here.
   */
  const measure = (w: World, t: Tower, seconds: number): number => {
    const fires: number[] = [];
    let clock = 0;
    for (let i = 0; i < seconds * 60; i++) {
      for (const c of w.creeps) {
        c.x = 9.5;
        c.y = 2.5;
      }
      stepWorld(w, DT);
      clock += DT;
      for (const e of w.events) {
        if (e.type === 'towerFired' && e.x === t.x && e.y === t.y) fires.push(clock);
      }
      w.events.length = 0;
    }
    if (fires.length < 2) return Infinity;
    return (fires[fires.length - 1]! - fires[0]!) / (fires.length - 1);
  };

  const held = (w: World): void => {
    spawnCreep(w, 'monolith', { hp: 1_000_000 });
  };

  // -- 1. A station with no interval never fires. -----------------------------
  {
    const w = rig();
    const o = place(w, 'overclock', 8, 3);
    held(w);
    const interval = measure(w, o, 10);
    check(interval === Infinity, 'an overclock never fires', 'no towerFired at its tile');
    check(o.damageDealt === 0 && o.kills === 0, 'and deals nothing');
    check(o.cooldown === 0, 'its cooldown never drifts', `cooldown ${o.cooldown}`);
  }

  // -- 2/3. The fed rate is exact, and it is additive. ------------------------
  //
  // The two are one gate on purpose. "Fires faster" is satisfied by a
  // multiplier; only the *figure* distinguishes `+0.35/s` from `−17.5% interval`
  // on a station that happens to sit at 2.0/s, and the whole design rests on
  // which of those two it is.
  {
    const base = rig();
    const lonely = place(base, 'lance', 9, 3);
    held(base);
    const alone = measure(base, lonely, 30);
    check(
      Math.abs(alone - TOWERS.lance.fireInterval) < DT,
      'an unfed lance fires at its own interval',
      `${alone.toFixed(4)}s vs ${TOWERS.lance.fireInterval}s`,
    );

    const w = rig();
    const lance = place(w, 'lance', 9, 3);
    place(w, 'overclock', 8, 3);
    held(w);
    const want = 1 / (1 / TOWERS.lance.fireInterval + TOWERS.overclock.buffShotsPerSecond);
    const got = measure(w, lance, 30);
    check(
      Math.abs(got - want) < DT,
      'a fed lance fires at base + the buff, in shots per second',
      `${got.toFixed(4)}s vs ${want.toFixed(4)}s`,
    );

    // The additive/multiplicative distinction is measured on a *Nova*, and it
    // has to be. At Lance's 2.0/s the two units are indistinguishable — +0.35/s
    // lands on 0.4255s and a −17.5% interval on 0.4125s, inside one tick of each
    // other, and the first draft of this gate failed for that reason rather than
    // because anything was wrong. That near-identity at a fast station and the
    // gulf below at a slow one *is* the design: the buff pays out to whatever
    // fires slowest, which is what stops it amplifying whatever is already best.
    const slow = rig();
    const nova = place(slow, 'nova', 9, 3);
    place(slow, 'overclock', 8, 3);
    held(slow);
    const novaWant = 1 / (1 / TOWERS.nova.fireInterval + TOWERS.overclock.buffShotsPerSecond);
    const novaGot = measure(slow, nova, 60);
    check(
      Math.abs(novaGot - novaWant) < DT,
      'a fed nova gains the same shots per second, not the same fraction',
      `${novaGot.toFixed(4)}s vs ${novaWant.toFixed(4)}s`,
    );
    // What the same buff would have been worth as a multiplier tuned to Lance.
    const asMultiplier = TOWERS.nova.fireInterval * (1 - 0.175);
    check(
      Math.abs(novaGot - asMultiplier) > DT * 4,
      'and the two units are far apart where it matters',
      `additive ${novaWant.toFixed(3)}s vs multiplicative ${asMultiplier.toFixed(3)}s`,
    );
  }

  // -- 4. Two sources stack by maximum, not by sum. ---------------------------
  //
  // The pathology this station most plausibly has is a lattice of support, and
  // summing is what would create it. Both overclocks sit exactly one tile from
  // the lance, so a sum would be unmistakable: 2.7/s against 2.35/s.
  {
    const w = rig();
    const lance = place(w, 'lance', 9, 3);
    place(w, 'overclock', 8, 3);
    held(w);
    const one = measure(w, lance, 30);

    place(w, 'overclock', 10, 3);
    const two = measure(w, lance, 30);
    check(
      Math.abs(one - two) < DT,
      'a second overclock on the same station adds nothing',
      `${one.toFixed(4)}s then ${two.toFixed(4)}s`,
    );
    check(lance.buffShots === TOWERS.overclock.buffShotsPerSecond, 'the buff is the max, not the sum');
  }

  // -- 5. Selling the support takes the buff with it. -------------------------
  //
  // The `refreshBuffs` invariant, and the one a future feature is most likely
  // to break by mutating `w.towers` somewhere new.
  {
    const w = rig();
    const lance = place(w, 'lance', 9, 3);
    const o = place(w, 'overclock', 8, 3);
    held(w);
    check(lance.buffShots > 0, 'the lance is fed while the overclock stands');

    w.commands.push({ type: 'sellTower', id: o.id });
    stepWorld(w, DT);
    check(lance.buffShots === 0, 'and unfed the moment it is sold');
    const after = measure(w, lance, 30);
    check(
      Math.abs(after - TOWERS.lance.fireInterval) < DT,
      'the rate returns to base, not to somewhere between',
      `${after.toFixed(4)}s vs ${TOWERS.lance.fireInterval}s`,
    );
  }

  // -- 6. Widening the reach feeds someone new. -------------------------------
  //
  // Two tiles apart: outside Mk I's 1.8 and inside Mk II's 2.07. That gap is
  // why the base reach is 1.8 and not 1.5 — at 1.5 the range path's first tier
  // would buy nothing at all, the next tile out sitting at exactly 2.0.
  {
    const w = rig();
    const lance = place(w, 'lance', 10, 3);
    const o = place(w, 'overclock', 8, 3);
    check(lance.buffShots === 0, 'a station two tiles out is beyond Mk I reach');

    w.commands.push({ type: 'upgradeTower', id: o.id, path: 'range' });
    stepWorld(w, DT);
    check(lance.buffShots > 0, 'and inside Mk II reach', `range ${o.stats.range.toFixed(2)}tl`);
  }

  // -- 7. A fed ramp still ramps in real seconds. -----------------------------
  //
  // `focusTime` advances by the interval as a stand-in for elapsed wall time.
  // Read the *unbuffed* interval there while firing on the buffed one and a fed
  // filament credits itself 0.25s of spin-up every 0.23s of real time — it hits
  // its ceiling early and the rate buff silently becomes a ramp accelerator on
  // top, which is two buffs bought with one purchase.
  {
    const ceiling = (fed: boolean): number => {
      const w = rig();
      const f = place(w, 'filament', 9, 3);
      if (fed) place(w, 'overclock', 8, 3);
      held(w);
      for (let i = 0; i < 60 * 8; i++) {
        for (const c of w.creeps) {
          c.x = 9.5;
          c.y = 2.5;
        }
        stepWorld(w, DT);
        if (rampFactor(f) >= f.stats.rampMax) return (i + 1) * DT;
      }
      return Infinity;
    };

    const cold = ceiling(false);
    const warm = ceiling(true);
    check(
      Math.abs(warm - cold) < 0.1,
      'a fed filament reaches its ceiling in the same wall-clock time',
      `${cold.toFixed(2)}s unfed vs ${warm.toFixed(2)}s fed`,
    );
  }

  // -- 8. A station with no damage has no damage path. ------------------------
  //
  // `damageAtTier` multiplies the def's damage, so on an Overclock every tier
  // of that track is a purchase that provably cannot move a number the sim
  // reads. Left priced, it is a money sink that looks like a decision.
  {
    const w = rig();
    const o = place(w, 'overclock', 8, 3);
    check(upgradeCost(o, 'damage') === null, 'the damage track is unavailable, not merely maxed');
    check(
      upgradeError(w, o, 'damage') === 'noSuchPath',
      'and says so in its own words',
      `got ${upgradeError(w, o, 'damage')}`,
    );

    const before = w.money;
    w.commands.push({ type: 'upgradeTower', id: o.id, path: 'damage' });
    stepWorld(w, DT);
    check(w.money === before, 'and buying it takes no money', `$${before} → $${w.money}`);
    check(o.tiers.damage === 1, 'and buys no tier');

    // The other two tracks are real, or the station has nothing to buy at all.
    check(upgradeCost(o, 'range') !== null, 'the range track is real');
    check(upgradeCost(o, 'effect') !== null, 'the effect track is real');
  }

  // -- 9. The inspector prices the buff, and prices it from the sim. ----------
  //
  // A station quietly firing faster than its own stat block says is the number
  // a player reads as a bug. The panel has to show both halves — what it does
  // alone and what it does fed — or an Overclock cannot be priced before it is
  // bought, which is the whole decision the station exists to pose.
  {
    const w = rig();
    const lance = place(w, 'lance', 9, 3);
    const before = renderInspector(w, lance);
    // `class="fed"`, not a bare `→`: the upgrade cards already use that arrow
    // for "what the next tier buys", so asserting on the glyph alone failed
    // against a panel that was perfectly correct.
    check(!before.includes('class="fed"'), 'an unfed station shows one rate, unmarked');

    place(w, 'overclock', 8, 3);
    const after = renderInspector(w, lance);
    const base = (1 / TOWERS.lance.fireInterval).toFixed(1);
    const fed = (1 / effectiveInterval(lance)).toFixed(1);
    check(
      after.includes(`${base}<i class="fed">→${fed}</i>`),
      'a fed station shows base and fed rate together',
      `${base}→${fed}/s`,
    );
    // The figure must be the sim's, not the panel's own arithmetic — the same
    // discipline `effectiveDamage` and `rampFactor` are held to.
    check(
      Math.abs(Number(fed) - (1 / TOWERS.lance.fireInterval + TOWERS.overclock.buffShotsPerSecond)) < 0.05,
      'and the fed figure is the one the sim fires at',
      `${fed}/s`,
    );

    // Both halves are numerals, so the inspector's ten-word budget is untouched
    // — but the budget gate never builds two stations, so it cannot see this
    // panel and the claim has to be checked here.
    const shown = after
      .replace(/<[^>]*>/g, ' ')
      .split(/[\s·—–|,]+/)
      .filter((t) => /[A-Za-z]/.test(t) && !/\d/.test(t) && !/^[IVX]+$/.test(t))
      .filter((t) => !['tl', 's', 'ehp', 'hp', 'kills'].includes(t.toLowerCase()));
    check(shown.length <= 10, 'and the fed panel still fits the word budget', `${shown.length} words`);
  }
}

// ---------------------------------------------------------------------------
// Throwing rather than setting process.exitCode: it exits non-zero all the same
// and avoids pulling @types/node into the project, which would put Node globals
// in scope for src/ and quietly weaken the purity boundary.
if (failures > 0) throw new Error(`${failures} gate failure(s)`);
console.log('\n\x1b[32mall gates pass\x1b[0m\n');
