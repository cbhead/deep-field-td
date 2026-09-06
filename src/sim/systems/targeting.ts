import { TOWERS } from '../../content/towers.ts';
import type { TowerStats } from '../../content/types.ts';
// `effectiveInterval` lives in `build.ts`, not here beside the loop that uses
// it: the inspector prints the same figure and presentation may not import
// `sim/systems/**`. See its comment there.
import { effectiveInterval } from '../build.ts';
import type { Creep, EntityId, TargetMode, Tower } from '../types.ts';
import type { World } from '../world.ts';

/**
 * Pick a target for every ready tower and fire.
 *
 * Naive O(towers × creeps). At the ceiling this game will ever reach — 25
 * towers, 250 creeps, 60Hz — that is 375k squared-distance checks a second,
 * around 0.3% of a frame. Spatial partitioning would be pure cost.
 *
 * Two details that are easy to get wrong:
 *
 * - **Squared distances, never `Math.sqrt`.** This is the one loop in the game
 *   that runs often enough for it to matter.
 * - **Re-target every tick, no caching.** Caching produces the classic bad
 *   behaviour where a tower keeps tracking a creep that something else is about
 *   to kill, while a fresh one walks past it.
 */
export function fireTowers(w: World, dt: number): void {
  for (const t of w.towers) {
    // A station with no interval does not shoot. That is Overclock's whole
    // behaviour on this side — what it does happened in `refreshBuffs`, to
    // everyone else's `buffShots`. Checked before the decrement below so a
    // support station's cooldown never drifts negative across a whole match.
    if (t.stats.fireInterval <= 0) continue;

    t.cooldown -= dt;
    if (t.cooldown > 0) continue;

    const best = pickTarget(w, t);

    if (best === undefined) {
      // Nothing in range. Clamp rather than letting cooldown run negative, or
      // a tower that idled through an intermission would fire a burst the
      // instant the next wave walked in.
      t.cooldown = 0;
      // Losing the target loses the spin-up with it. Without this a station
      // would hold its charge across a whole intermission and open the next
      // wave at full power, which is the one reward a ramp must not give.
      t.focusId = null;
      t.focusTime = 0;
      continue;
    }

    const s = t.stats;
    // Support included, and used for *both* the cooldown and the focus advance
    // below. See the note on `focusTime` there.
    const interval = effectiveInterval(t);

    // Focus advances here rather than every tick, and that is deliberate.
    // Re-targeting every tick is affordable; doing it for every station
    // *regardless of cooldown* is a different bill and buys nothing, because
    // between two shots the ramp cannot be observed — only its effect on the
    // next one. Adding the interval that just elapsed gives the same answer
    // sampling continuously would, for a fraction of the work.
    if (t.focusId === best.id) {
      // `interval`, not `s.fireInterval`, and the difference is a real bug
      // rather than a tidiness point. `focusTime` advances by the interval as a
      // stand-in for elapsed wall time; reading the *unbuffed* interval while
      // firing on the buffed one credits a fed Filament 0.25s of spin-up every
      // 0.23s of real time, so it reaches its ceiling sooner than the clock
      // allows and a rate buff silently becomes a ramp accelerator too.
      t.focusTime = Math.min(t.focusTime + interval, rampSeconds(s));
    } else {
      // Switching targets *cools* the beam, it does not extinguish it. Losing
      // the charge entirely is still the rule for losing the target list — see
      // the reset above — and that is the rule that stops a station opening a
      // wave at full power.
      //
      // The two are different situations and used to be treated as one. A
      // station that has just killed something and moved to the contact behind
      // it never stopped firing; snapping it to zero made a ramp worth having
      // only where contacts arrive in a single unbroken file, which is one
      // board. On Braid the lanes cross every rung, so the file breaks roughly
      // twice a second and the charge never left the floor — and a Filament
      // there measured at *minus eleven lives*, not merely weak but a station
      // you were better off never building. A specialist should be the wrong
      // answer on some boards; it should not be a trap on them.
      t.focusId = best.id;
      t.focusTime *= RAMP_CARRY;
    }

    // One trigger pull, one or more shots. A station with `volleyTargets: 1` —
    // eleven of the twelve — runs this loop exactly once and produces byte-for-
    // byte what it did before the loop existed.
    //
    // Each pass excludes the contacts already taken this pull, so a volley
    // spreads across distinct targets rather than putting three shots into the
    // one thing at the front. Running out of targets ends the pull: the shots
    // are not refunded and the scan is not repeated, which is the same rule
    // `chain` follows when a jump finds nobody.
    const volley = Math.max(1, s.volleyTargets);
    const taken: EntityId[] = [best.id];

    for (let shot = 0; shot < volley; shot++) {
      const at = shot === 0 ? best : pickTarget(w, t, taken);
      if (at === undefined) break;
      if (shot > 0) taken.push(at.id);

      const aim = aimPoint(t, at, s.pierce > 0);

      w.projectiles.push({
        id: w.nextId++,
        defId: t.defId,
        towerId: t.id,
        // The station's current stats, carried whole: impact behaviour reads the
        // shot's snapshot, not the def, which is what lets the effect path change
        // what a station *does* rather than only how hard it hits.
        stats: s,
        x: t.x,
        y: t.y,
        ox: t.x,
        oy: t.y,
        target: at,
        tx: aim.x,
        ty: aim.y,
        speed: s.projectileSpeed,
        // The ramp multiplies the tier's damage rather than replacing it, so an
        // upgraded Filament ramps from a higher floor to a higher ceiling and the
        // two systems stay independent.
        //
        // Safe to read once per pull: no station has both a ramp and a volley,
        // and the ramp is keyed off the *first* target anyway.
        damage: s.damage * rampFactor(t),
        pierce: s.pierce,
        hits: [],
        age: 0,
        dead: false,
      });
    }

    // Presentation only — nothing in the sim reads it, and it draws no random
    // numbers, so the seed still fixes the match completely.
    //
    // Once per *trigger*, not once per shot. A volley that fired three times
    // would otherwise be the loudest station on a full board and the quietest on
    // an empty one, which is backwards — and `towerFired` is documented as the
    // cheapest possible record of the trigger being pulled.
    w.events.push({ type: 'towerFired', defId: t.defId, x: t.x, y: t.y });

    // `+=`, not `=`. Assigning would round every tower's fire rate up to a
    // multiple of the tick, so a 0.5s interval would silently become 0.5167s
    // and every balance number would be quietly wrong.
    t.cooldown += interval;
  }
}

/**
 * Seconds of held focus needed to reach the ceiling. `0` for a station that
 * does not ramp, which is what keeps `focusTime` from drifting upward forever
 * on the four stations that never read it. Takes stats, not the def, because
 * the effect path moves both ramp dials.
 */
export const rampSeconds = (s: TowerStats): number =>
  s.rampPerSecond > 0 ? (s.rampMax - 1) / s.rampPerSecond : 0;

/**
 * How much of the spin-up survives a change of target.
 *
 * Half, and the halving is the whole design: a beam that kept everything would
 * make target switching free and turn Filament into a station with no downside,
 * which is the outcome `towers.ts` records the sweep rejecting once already. A
 * beam that keeps nothing is what shipped, and it made the ramp worth having on
 * exactly one board shape.
 *
 * Half means a station working a steady stream settles at a real fraction of
 * its ceiling rather than at the floor, and a station that switches constantly
 * still ends up well under one that holds — the mechanic still says "hold a
 * target", it just no longer says "hold a target or you have wasted your
 * money".
 */
const RAMP_CARRY = 0.5;

/**
 * Damage multiplier from held focus, `1` for everything that does not ramp.
 *
 * Exported because the inspector prints it: a player deciding whether a
 * Filament is worth its price needs to see what it is *currently* doing, and a
 * HUD computing its own copy of this would drift from the simulation at exactly
 * the moment money is being spent. Same discipline as `effectiveDamage`.
 */
export const rampFactor = (t: Tower): number =>
  t.stats.rampPerSecond > 0
    ? Math.min(t.stats.rampMax, 1 + t.focusTime * t.stats.rampPerSecond)
    : 1;

/**
 * Where the shot is headed.
 *
 * A homing shot aims at the contact and re-aims every tick. A piercing one aims
 * at the edge of the station's reach *along the same bearing*, so it crosses the
 * whole covered stretch instead of stopping wherever the first contact happened
 * to be standing — which is what makes lining contacts up worth doing.
 *
 * Reusing `tx`/`ty` as "aim point" rather than adding a velocity vector keeps
 * `Projectile` one field lighter and means both flight modes share the same
 * move-toward-a-point maths.
 */
function aimPoint(t: Tower, target: Creep, piercing: boolean): { x: number; y: number } {
  if (!piercing) return { x: target.x, y: target.y };

  const dx = target.x - t.x;
  const dy = target.y - t.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  // A contact standing exactly on the station has no bearing to extend along.
  if (d === 0) return { x: target.x, y: target.y };

  return { x: t.x + (dx / d) * t.stats.range, y: t.y + (dy / d) * t.stats.range };
}

/**
 * The score a candidate is ranked by, highest wins. One scan whatever the mode,
 * so switching targeting costs nothing at runtime.
 *
 * `close` negates the squared distance rather than taking a root — ordering is
 * all that matters and the root would be pure cost in the hot loop.
 *
 * **`first` means closest to the goal, not furthest travelled.** Those are the
 * same ordering only while every lane is the same length. The moment they are
 * not — Sluice runs a 20-tile chute against a 50-tile coil on purpose — raw
 * progress ranks a contact two tiles from the pulsar *below* one thirty tiles
 * out, and the station shoots the wrong one at exactly the moment it matters.
 * Distance remaining is the quantity a player means, and it is comparable
 * across lanes because every lane ends at the same goal.
 */
function score(w: World, mode: TargetMode, c: Creep, d2: number): number {
  switch (mode) {
    case 'first':
      return -remaining(w, c);
    case 'last':
      return remaining(w, c);
    case 'strong':
      return c.hp;
    case 'close':
      return -d2;
  }
}

/** Tiles left between a contact and the goal, along its own lane. */
const remaining = (w: World, c: Creep): number => w.map.routes[c.route]!.length - c.progress;

/**
 * `exclude` is the contacts a multi-target pull has already taken.
 *
 * Empty for every station that fires once, so the scan below is unchanged for
 * eleven of the twelve. `includes` over an array rather than a Set because the
 * list is at most three long and never escapes the pull — building a Set per
 * shot would cost more than the scan it saves.
 */
function pickTarget(w: World, t: Tower, exclude: readonly EntityId[] = []): Creep | undefined {
  // **The one station that is not a circle.** `boardWide` reads from the def
  // rather than from `stats` because it is not a number and nothing upgrades it
  // — there is no "slightly less rangeless".
  //
  // The range test below is the only thing it changes. Scoring is untouched, and
  // that matters: a station with no reach would be incoherent on any mode other
  // than `first`, and `first` is already the default. It ends up preferring the
  // contact closest to the core for the same reason every other station does.
  const boardWide = TOWERS[t.defId].boardWide;
  const r2 = t.stats.range * t.stats.range;

  /**
   * A ramping station holds its target while that target is alive and in reach.
   *
   * This is the one deliberate exception to the no-caching rule above, and it
   * exists because without it the mechanic cannot function. `first` re-picks the
   * contact furthest along every single tick, and in a moving stream that is a
   * different contact constantly — so a Filament reset its ramp perpetually and
   * measured *weaker* than pure Singularity, a station with no damage at all.
   *
   * The rule's usual objection — a tower fixated on something about to die
   * elsewhere — is precisely the trade a beam is supposed to make. It is also
   * scoped: only stations that actually ramp are sticky, so the default
   * behaviour of the other four is untouched.
   */
  if (t.stats.rampPerSecond > 0 && t.focusId !== null) {
    for (const c of w.creeps) {
      if (c.dead || c.id !== t.focusId) continue;
      const dx = c.x - t.x;
      const dy = c.y - t.y;
      if (boardWide || dx * dx + dy * dy <= r2) return c;
      break;
    }
  }

  let best: Creep | undefined;
  let bestScore = -Infinity;

  for (const c of w.creeps) {
    if (c.dead || exclude.includes(c.id)) continue;
    const dx = c.x - t.x;
    const dy = c.y - t.y;
    const d2 = dx * dx + dy * dy;
    if (!boardWide && d2 > r2) continue;

    const s = score(w, t.targeting, c, d2);
    // Strictly greater, so ties go to the creep found first. That keeps the
    // choice deterministic given a deterministic creep array, which is what
    // Race-mode fairness rests on.
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  return best;
}
