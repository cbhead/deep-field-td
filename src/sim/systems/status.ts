import { BALANCE } from '../../content/balance.ts';
import { ENEMIES } from '../../content/enemies.ts';
import { damageCreep } from '../damage.ts';
import { towerById, type World } from '../world.ts';

/**
 * Per-contact state that decays or recovers on its own.
 *
 * Runs before movement so a shield that came back this tick is up before
 * anything shoots at it.
 *
 * The gravitational slow deliberately stays in `moveCreeps`, where it is read.
 * Moving it here would be tidier by one measure and would shift slow expiry by
 * a tick — and the slow duration is already pinned by gates. Tidiness is not
 * worth perturbing verified behaviour; this system owns only what is new.
 */
export function updateStatuses(w: World, dt: number): void {
  for (const c of w.creeps) {
    if (c.dead) continue;

    // Timers first, and unconditionally — the shield block below used to be the
    // only thing here and could `continue` past an unshielded contact, which is
    // exactly the shape that would have left burns on a Drifter running forever.
    if (c.knockTimer > 0) c.knockTimer = Math.max(0, c.knockTimer - dt);
    if (c.shieldLock > 0) c.shieldLock = Math.max(0, c.shieldLock - dt);
    if (c.shredTimer > 0) {
      c.shredTimer = Math.max(0, c.shredTimer - dt);
      // Plating comes back all at once when the strip lapses rather than
      // creeping back point by point. It matches how the strip went on — in
      // discrete bites — and it keeps `shred` a number the inspector can state
      // instead of a fraction mid-flight.
      if (c.shredTimer === 0) c.shred = 0;
    }

    // The burn. Ticks on its own cadence rather than per frame, for the reasons
    // `BALANCE.burnTick` records — at frame rate this would silently suppress
    // every shield's regen and stop armour applying to it in any meaningful way.
    if (c.burnTimer > 0) {
      c.burnTimer = Math.max(0, c.burnTimer - dt);
      c.burnTick -= dt;
      if (c.burnTick <= 0) {
        c.burnTick += BALANCE.burnTick;
        // Through the one funnel, so a burn kill pays bounty once, fires one
        // death event and queues its split exactly like any other kill. Running
        // before `moveCreeps` and `resolveSplits` in the tick order is what
        // makes a Cluster killed by fire split correctly.
        // `undefined` for a station that has been sold since it lit this, which
        // is the correct outcome rather than an error: attribution is never
        // load-bearing and the burn lands identically either way.
        damageCreep(w, c, c.burnDamage, c.burnSource === null ? undefined : towerById(w, c.burnSource));
      }
      if (c.burnTimer === 0) {
        c.burnDamage = 0;
        c.burnSource = null;
      }
      if (c.dead) continue;
    }

    if (c.maxShield <= 0 || c.shield >= c.maxShield) continue;

    // A broken shield stays broken for its own hold, ahead of and independent of
    // the per-hit delay below.
    if (c.shieldLock > 0) continue;

    // Counts down from the def's delay, reset by every hit in `damageCreep`.
    if (c.shieldTimer > 0) {
      c.shieldTimer = Math.max(0, c.shieldTimer - dt);
      continue;
    }

    c.shield = Math.min(c.maxShield, c.shield + ENEMIES[c.defId].shieldRegenRate * dt);
  }
}
