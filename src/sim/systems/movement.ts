import type { Creep } from '../types.ts';
import { waveStats, type World } from '../world.ts';

/**
 * Walk every creep along its own lane.
 *
 * The loop spends a per-tick distance *budget* rather than lerping by a time
 * fraction, so a creep can cross several short legs in one tick without
 * overshooting or losing the remainder at a corner. At 4x speed with a fast
 * enemy that is not hypothetical.
 *
 * A gravitational slow scales that budget and never `creep.speed` itself, which
 * stays the base it was spawned with — see `Creep.slowTimer`.
 */
/**
 * Put a contact at an absolute distance along its own lane.
 *
 * The inverse of what `moveCreeps` does incrementally, and the reason a shove
 * needs no cooperation from the walk at all: this writes `x`, `y`, `leg` and
 * `progress` together, so the next tick picks up four consistent fields and
 * carries on as if the contact had always been here.
 *
 * Walks from the start of the lane rather than stepping back leg by leg from
 * where the contact is. A shove can cross several corners, and reversing the
 * incremental walk would need its own end-of-leg handling in the opposite
 * direction — a second traversal with its own edge cases, to save a loop over at
 * most a few dozen waypoints, on an event that happens once every 1.2 seconds
 * per contact at the very most.
 *
 * `waypoints[0]` is the off-board entry the contact spawns on and corresponds to
 * `progress: 0` with `leg: 1`, so clamping at zero puts it back at the mouth of
 * the lane rather than somewhere undefined behind it. The lane itself is never
 * changed: a shove moves a contact along its route, never onto another one.
 */
export function placeAtProgress(w: World, c: Creep, progress: number): void {
  const route = w.map.routes[c.route]!.waypoints;
  const want = Math.max(0, progress);

  let travelled = 0;
  for (let leg = 1; leg < route.length; leg++) {
    const from = route[leg - 1]!;
    const to = route[leg]!;
    const legLength = Math.hypot(to.x - from.x, to.y - from.y);

    if (travelled + legLength >= want || leg === route.length - 1) {
      // Guard the zero-length leg: a lane may legitimately repeat a waypoint,
      // and dividing by it would put the contact at NaN — which reads as a
      // contact that has vanished rather than as a crash.
      const k = legLength > 0 ? Math.min(1, (want - travelled) / legLength) : 0;
      c.x = from.x + (to.x - from.x) * k;
      c.y = from.y + (to.y - from.y) * k;
      c.leg = leg;
      c.progress = want;
      return;
    }
    travelled += legLength;
  }
}

export function moveCreeps(w: World, dt: number): void {
  for (const c of w.creeps) {
    if (c.dead) continue;

    // Per creep, not once for the whole loop: contacts on a multi-lane board
    // are walking different chains.
    const route = w.map.routes[c.route]!.waypoints;

    // Sampled once per creep, not once per leg: the budget below can cross
    // several legs in a tick, and charging the timer inside that loop would
    // make a slow burn off faster on a corner-heavy stretch than on a straight.
    const speed = c.slowTimer > 0 ? c.speed * c.slowFactor : c.speed;
    if (c.slowTimer > 0) {
      c.slowTimer = Math.max(0, c.slowTimer - dt);
      // Retire the factor with the timer so the two can never disagree; a stale
      // 0.55 sitting behind an expired timer is the kind of thing that only
      // shows up as a desync.
      if (c.slowTimer === 0) c.slowFactor = 1;
    }

    let budget = speed * dt;
    while (budget > 0) {
      const target = route[c.leg];

      // Ran off the end of the route: the creep reached the goal.
      if (target === undefined) {
        c.dead = true;
        // Floored at zero rather than allowed negative, so a heavy contact
        // landing on a one-life reserve reads as a loss and not as a debt. The
        // phase change on the next tick is what ends the run either way.
        w.lives = Math.max(0, w.lives - c.leakDamage);
        w.stats.leaks++;
        // Only wave contacts are itemised per wave — a sortie belongs to no
        // wave, and tallying it against whichever one happened to be spawning
        // would print leaks in a clear summary the wave never caused.
        if (c.origin === 'wave') waveStats(w, c.wave).leaked++;
        w.events.push({
          type: 'creepLeaked',
          x: c.x,
          y: c.y,
          cost: c.leakDamage,
          bought: c.origin === 'sortie',
        });
        // A sortie that lands pays *its sender*, who is not this world. The
        // event is the only way that money can travel; crediting it here would
        // pay the person who just took the hit.
        if (c.origin === 'sortie' && c.kickback > 0) {
          w.stats.sortiesTaken++;
          w.events.push({ type: 'sortieLanded', kickback: c.kickback, cost: c.leakDamage });
        }
        break;
      }

      const dx = target.x - c.x;
      const dy = target.y - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= budget) {
        // Snap to the corner so float error cannot accumulate across legs, then
        // carry the leftover distance into the next one.
        c.x = target.x;
        c.y = target.y;
        c.progress += dist;
        budget -= dist;
        c.leg++;
      } else {
        const k = budget / dist;
        c.x += dx * k;
        c.y += dy * k;
        c.progress += budget;
        budget = 0;
      }
    }
  }
}
