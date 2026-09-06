import { BALANCE } from '../content/balance.ts';
import { TOWERS, type TowerId } from '../content/towers.ts';
import type { TowerStats } from '../content/types.ts';
import type {
  EraError,
  PlacementError,
  TargetMode,
  Tower,
  TowerActionError,
  TowerTiers,
  UpgradePath,
} from './types.ts';
import { isBuildableTile, tileAt, tileCentre } from './util/grid.ts';
import type { World } from './world.ts';

/**
 * Placement and tower-lifecycle rules, in one place.
 *
 * Deliberately NOT under `sim/systems/` — the renderer needs these to colour the
 * placement ghost and to price the inspector's buttons, and the eslint boundary
 * (rightly) stops presentation code importing simulation systems. These are pure
 * queries over world state, which is exactly the kind of thing both sides may
 * share.
 *
 * The ghost and the command handler call the same functions, so what the player
 * is shown and what the sim will accept cannot drift apart.
 */
export function placementError(
  w: World,
  defId: TowerId,
  col: number,
  row: number,
): PlacementError | null {
  // Bounds first: `offBoard` is what tells the renderer to hide the ghost
  // entirely, so it has to win over reasons that would draw a red one.
  if (!Number.isInteger(col) || !Number.isInteger(row)) return 'offBoard';
  if (col < 0 || col >= w.map.cols || row < 0 || row >= w.map.rows) return 'offBoard';
  if (!isUnlocked(w, defId)) return 'locked';
  if (!isBuildableTile(w.map, col, row)) {
    return tileAt(w.map, col, row) === 'path' ? 'onRoute' : 'blocked';
  }
  if (towerAt(w, col, row) !== undefined) return 'occupied';
  if (w.money < TOWERS[defId].cost) return 'tooPoor';
  return null;
}

export const canPlace = (w: World, defId: TowerId, col: number, row: number): boolean =>
  placementError(w, defId, col, row) === null;

/**
 * Unlocks are keyed to the wave *reached*, not the wave cleared, so a type
 * announced as "wave 5" is buildable during the build phase before wave 5 —
 * which is the only moment the unlock is useful.
 */
export const isUnlocked = (w: World, defId: TowerId): boolean =>
  w.rules.eras ? w.era >= TOWERS[defId].era : w.wave.index >= TOWERS[defId].unlockWave;

/**
 * The highest tier any path may be bought to right now.
 *
 * One function rather than a literal at each site, because three of the four
 * callers are presentation — the inspector prices its buttons, previews the
 * next stats, and decides whether to render the row at all — and a HUD
 * computing its own ceiling would drift from what the purchase allows. Same
 * discipline as `hasDamagePath` and `placementError` being shared.
 *
 * Under eras the ceiling *is* the era: era II allows Mk II on every path. That
 * makes one purchase do two things — it opens a station and it raises the roof
 * on every station already standing — which is what stops the ladder being a
 * shop and makes it a tempo decision. Outside versus this is the constant it
 * always was.
 */
export const tierCeiling = (w: World): number =>
  w.rules.eras ? Math.min(w.era, BALANCE.upgrade.maxTier) : BALANCE.upgrade.maxTier;

/** Price of the next era, or null at the top of the ladder. */
export function advanceEraCost(w: World): number | null {
  if (!w.rules.eras) return null;
  return BALANCE.eras.advanceCost[w.era - 1] ?? null;
}

export function advanceEraError(w: World): EraError | null {
  const cost = advanceEraCost(w);
  if (cost === null) return w.rules.eras ? 'maxEra' : 'noEras';
  if (w.money < cost) return 'tooPoor';
  return null;
}

/** Assumes `advanceEraError` already returned null. */
export function advanceEra(w: World): number {
  const cost = advanceEraCost(w)!;
  w.money -= cost;
  w.eraSpent += cost;
  w.era++;
  return cost;
}

/**
 * Linear scan. With a couple of dozen towers this is faster than maintaining a
 * parallel occupancy index, and it cannot fall out of sync with the array.
 */
export function towerAt(w: World, col: number, row: number): Tower | undefined {
  for (const t of w.towers) if (t.col === col && t.row === row) return t;
  return undefined;
}

/** Damage a tower of this type has at a given damage-path tier. */
export const damageAtTier = (defId: TowerId, tier: number): number =>
  Math.round(TOWERS[defId].damage * BALANCE.upgrade.damageFactor ** (tier - 1));

/** Range a tower of this type has at a given range-path tier. */
export const rangeAtTier = (defId: TowerId, tier: number): number =>
  TOWERS[defId].range * BALANCE.upgrade.rangeFactor ** (tier - 1);

/**
 * The effective combat numbers at a given set of path tiers.
 *
 * The single place tiers become stats — `buildTower`, `upgradeTower` and the
 * inspector's previews all come through here, so what a purchase is shown to
 * buy and what it actually buys cannot drift apart.
 */
export function computeStats(defId: TowerId, tiers: TowerTiers): TowerStats {
  const def = TOWERS[defId];
  // Annotated mutable: inferred, the fields would be unions of the five defs'
  // literal values, and the += below could not write to them.
  const stats: { -readonly [K in keyof TowerStats]: number } = {
    range: rangeAtTier(defId, tiers.range),
    damage: damageAtTier(defId, tiers.damage),
    fireInterval: def.fireInterval,
    projectileSpeed: def.projectileSpeed,
    pierce: def.pierce,
    splashRadius: def.splashRadius,
    splashFalloff: def.splashFalloff,
    slowFactor: def.slowFactor,
    slowSeconds: def.slowSeconds,
    chainJumps: def.chainJumps,
    chainRange: def.chainRange,
    chainFalloff: def.chainFalloff,
    rampPerSecond: def.rampPerSecond,
    rampMax: def.rampMax,
    buffShotsPerSecond: def.buffShotsPerSecond,
    shredPerHit: def.shredPerHit,
    shredMax: def.shredMax,
    shredSeconds: def.shredSeconds,
    shieldFactor: def.shieldFactor,
    shieldLockSeconds: def.shieldLockSeconds,
    burnDamage: def.burnDamage,
    burnSeconds: def.burnSeconds,
    knockbackTiles: def.knockbackTiles,
    knockbackCooldown: def.knockbackCooldown,
    bountyBonus: def.bountyBonus,
    volleyTargets: def.volleyTargets,
  };

  // Widened from the def's literal type: each station's `perTier` is a narrow
  // `as const` shape, and the loop needs the general one.
  const perTier: Readonly<Partial<TowerStats>> = def.effectUpgrade.perTier;
  const steps = tiers.effect - 1;
  if (steps > 0) {
    for (const key of Object.keys(perTier) as (keyof TowerStats)[]) {
      stats[key] += perTier[key]! * steps;
    }
  }
  return stats;
}

/**
 * Recompute every station's incoming support.
 *
 * **The invariant: any mutation of `w.towers`, or of any tower's `stats`, must
 * be followed by this.** All three such mutations are in this file —
 * `buildTower`, `sellTower`, `upgradeTower` — which is the reason the function
 * lives here rather than under `systems/`. A fourth mutation site added
 * elsewhere without a call to this would show up as stations quietly keeping a
 * buff from a tower that is no longer there.
 *
 * **Maximum, never sum.** Two Overclocks covering the same Lance give it one
 * Overclock's worth. Summing would make a lattice of support the dominant
 * build, which is the pathology this station most plausibly has; taking the max
 * makes a second one on the same tiles *wasted*, which pushes them apart and
 * turns support placement into the same coverage puzzle the rest of the game
 * already is. It also makes upgrading an Overclock beat adding one wherever
 * coverage overlaps, which is the intended pressure.
 *
 * Order-independent by construction, because a maximum over a set does not care
 * about the order of the set. That is load-bearing for Race: two clients
 * replaying the same commands cannot diverge on tower array order here.
 *
 * A support station inside another's radius is buffed like anything else, and
 * the buff is inert because it never fires. One rule, no special case.
 *
 * O(towers²), which at this game's ceiling of ~25 towers is 625 squared-distance
 * checks a handful of times a match.
 */
function refreshBuffs(w: World): void {
  for (const t of w.towers) t.buffShots = 0;
  for (const src of w.towers) {
    const add = src.stats.buffShotsPerSecond;
    if (add <= 0) continue;
    const r2 = src.stats.range * src.stats.range;
    for (const t of w.towers) {
      if (t === src) continue;
      const dx = t.x - src.x;
      const dy = t.y - src.y;
      if (dx * dx + dy * dy <= r2) t.buffShots = Math.max(t.buffShots, add);
    }
  }
}

/**
 * The extra fraction of bounty paid for a contact dying at `(x, y)`.
 *
 * **Maximum, never sum** — the same rule `refreshBuffs` follows, for the same
 * reason and with a sharper edge. Summing would make overlapping salvage the
 * dominant build on every board: a lattice of them costs nothing to arrange, and
 * the payout would compound with the wave scaling that already grows bounty.
 * Taking the maximum means a second one only ever widens the area it applies to.
 *
 * A pure query rather than cached state on the creep, because a station can be
 * built, sold or upgraded between a contact spawning and dying — and the right
 * answer is what is standing at the moment of the kill.
 *
 * O(towers) per kill, which is the same order `chain` and `detonate` already pay
 * at impact and against far fewer entities.
 */
export function salvageBonus(w: World, x: number, y: number): number {
  let best = 0;
  for (const t of w.towers) {
    const add = t.stats.bountyBonus;
    if (add <= best) continue;
    const dx = t.x - x;
    const dy = t.y - y;
    if (dx * dx + dy * dy <= t.stats.range * t.stats.range) best = add;
  }
  return best;
}

/**
 * What the stats would be after buying the next tier of `path`, or null at the
 * ceiling. The inspector prices its three buttons off this, so the preview is
 * computed by the same function the purchase will run.
 */
export function nextStats(
  t: Tower,
  path: UpgradePath,
  ceiling: number = BALANCE.upgrade.maxTier,
): TowerStats | null {
  if (t.tiers[path] >= ceiling) return null;
  return computeStats(t.defId, { ...t.tiers, [path]: t.tiers[path] + 1 });
}

/**
 * The tier the *art* shows, 1..maxTier. There is one baked texture per tier,
 * not one per combination of paths, so the sprite tracks total investment:
 * the first purchases each visibly harden the station, then the art tops out
 * while the per-path pips in the inspector carry the detail.
 */
export const visualTier = (t: Tower): number =>
  Math.min(BALANCE.upgrade.maxTier, t.tiers.damage + t.tiers.range + t.tiers.effect - 2);

/**
 * Price of the next tier *in this path*, or null when the path is maxed.
 * Escalates with the path's current tier so deepening one track never strictly
 * dominates broadening — see `BALANCE.upgrade.costFactor`.
 */
export function upgradeCost(
  t: Tower,
  path: UpgradePath,
  ceiling: number = BALANCE.upgrade.maxTier,
): number | null {
  // A station with no damage has no damage path. `damageAtTier` multiplies the
  // def's damage, so on an Overclock every tier of this track is a purchase
  // that provably cannot move a number the sim reads — a money sink, not a
  // decision. Priced as unavailable rather than left to sell nothing.
  if (path === 'damage' && !hasDamagePath(t.defId)) return null;
  if (path === 'range' && !hasRangePath(t.defId)) return null;
  const tier = t.tiers[path];
  // The ceiling defaults to the global maximum, which is what the campaign and
  // Race always pass. Versus passes `tierCeiling(w)` so the era caps it.
  if (tier >= ceiling) return null;
  return Math.round(TOWERS[t.defId].cost * BALANCE.upgrade.costFactor * tier);
}

/**
 * Whether this station's damage track buys anything. Exported because the
 * inspector omits the button entirely rather than rendering it disabled, and a
 * HUD deciding that for itself would drift from what `upgradeCost` allows.
 */
export const hasDamagePath = (defId: TowerId): boolean => TOWERS[defId].damage > 0;

/**
 * Whether this station's range track buys anything.
 *
 * False for the one station that has no radius: selling a reach upgrade to a
 * station defined by having no reach is exactly the inert purchase `towers.ts`
 * refuses to ship. Same shape and same reason as `hasDamagePath` above, which
 * is what withdraws Overclock's damage button.
 */
export const hasRangePath = (defId: TowerId): boolean => !TOWERS[defId].boardWide;

/**
 * Seconds between a station's shots, support included.
 *
 * Here rather than in `systems/targeting.ts` beside the loop that uses it,
 * because the inspector prints this figure and the eslint boundary (rightly)
 * stops presentation importing simulation systems. This file is the stated home
 * for exactly that case — a pure query over world state that both sides need —
 * and a HUD computing its own copy would drift from the simulation at the very
 * moment money is being spent. Same discipline as `effectiveDamage` and
 * `placementError` being shared.
 *
 * Converts to shots per second, adds, and converts back, because that is the
 * unit the buff is authored in and the unit the panel reads. Subtracting from
 * the interval instead would make one `+0.35` mean wildly different things to a
 * 1.4s Nova and a 0.25s Filament — and that it does *not* is the whole reason
 * the buff is safe to add. See `TowerDef.buffShotsPerSecond`.
 */
export const effectiveInterval = (t: Tower): number =>
  t.buffShots > 0 ? 1 / (1 / t.stats.fireInterval + t.buffShots) : t.stats.fireInterval;

/** What selling returns right now — a cut of everything sunk in, upgrades included. */
export const sellValue = (t: Tower): number => Math.floor(t.spent * BALANCE.sellRefund);

export function upgradeError(
  w: World,
  t: Tower | undefined,
  path: UpgradePath,
): TowerActionError | null {
  if (t === undefined) return 'noSuchTower';
  // Checked before `upgradeCost` returns its null, because the two nulls mean
  // different things and only this one can tell them apart.
  if (path === 'damage' && !hasDamagePath(t.defId)) return 'noSuchPath';
  if (path === 'range' && !hasRangePath(t.defId)) return 'noSuchPath';
  const cost = upgradeCost(t, path, tierCeiling(w));
  if (cost === null) return 'maxTier';
  if (w.money < cost) return 'tooPoor';
  return null;
}

/**
 * Build a tower. Assumes placement has already been validated — the caller is
 * `applyCommands`, which re-checks rather than trusting the click that produced
 * the command.
 */
export function buildTower(w: World, defId: TowerId, col: number, row: number): Tower {
  const def = TOWERS[defId];
  const centre = tileCentre(col, row);

  const tiers: TowerTiers = { damage: 1, range: 1, effect: 1 };
  const tower: Tower = {
    id: w.nextId++,
    defId,
    col,
    row,
    x: centre.x,
    y: centre.y,
    tiers,
    stats: computeStats(defId, tiers),
    // Filled in by the `refreshBuffs` below, which also covers this station
    // being placed *into* an existing Overclock's reach.
    buffShots: 0,
    targeting: 'first',
    // Ready to fire the moment it lands, so a last-second build still helps.
    cooldown: 0,
    focusId: null,
    focusTime: 0,
    spent: def.cost,
    kills: 0,
    damageDealt: 0,
  };

  w.money -= def.cost;
  w.stats.spent += def.cost;
  w.towers.push(tower);
  refreshBuffs(w);
  return tower;
}

/** Assumes `upgradeError` already returned null. */
export function upgradeTower(w: World, t: Tower, path: UpgradePath): number {
  const cost = upgradeCost(t, path)!;
  t.tiers[path]++;
  // A fresh object, never a mutation — in-flight projectiles hold the old one
  // as their snapshot. See the field's comment in `types.ts`.
  t.stats = computeStats(t.defId, t.tiers);
  t.spent += cost;
  w.money -= cost;
  w.stats.spent += cost;
  // Both an Overclock's range and its effect path change who it feeds and by
  // how much, so an upgrade is a buff-graph change like a build or a sell.
  refreshBuffs(w);
  return cost;
}

/**
 * Sell a tower. Removes it immediately rather than flagging it dead: towers are
 * not swept by `cleanup` (nothing else needs them to survive the tick), and a
 * tower that keeps firing after you sold it reads as a bug.
 *
 * Projectiles already in flight hold a `towerId`, not a reference, so their
 * attribution simply finds nothing — the damage still lands, which is right.
 */
export function sellTower(w: World, t: Tower): number {
  const refund = sellValue(t);
  const i = w.towers.indexOf(t);
  if (i >= 0) {
    w.towers[i] = w.towers[w.towers.length - 1]!;
    w.towers.pop();
  }
  w.money += refund;
  // Selling the support is what takes the buff away again, and a station that
  // kept firing fast after the Overclock feeding it was sold reads as a bug in
  // exactly the way a tower that keeps firing after you sold it does.
  refreshBuffs(w);
  return refund;
}

export function setTargeting(t: Tower, mode: TargetMode): void {
  t.targeting = mode;
}
