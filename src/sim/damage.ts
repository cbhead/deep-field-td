import { BALANCE } from '../content/balance.ts';
import { ENEMIES, type EnemyId } from '../content/enemies.ts';
import { salvageBonus } from './build.ts';
import type { Creep, Tower } from './types.ts';
import { waveStats, type World } from './world.ts';

/**
 * The single place a creep can lose health.
 *
 * The guard is the whole point. Two projectiles landing on the same tick will
 * both find a creep whose hp is about to go negative, and without this the
 * bounty is paid twice and the death event fires twice. Funnelling every damage
 * source through one function is what makes that impossible rather than merely
 * unlikely — M7's splash will land here too.
 *
 * `source` is the firing tower when there is one, for the inspector's per-tower
 * attribution. It is optional because splash and any future hazard damage have
 * no single owner, and because attribution must never be load-bearing: nothing
 * about the outcome changes when it is absent.
 */
/**
 * What one hit of `amount` actually lands against `armor`.
 *
 * Extracted rather than left inline because the inspector prints this figure,
 * and a HUD computing its own copy would drift from what the simulation does —
 * lying at exactly the moment the player is trusting it to spend money. Same
 * discipline as `placementError` being shared by the placement ghost and the
 * command handler, and gated the same way.
 *
 * Flat subtraction, floored so armour is never immunity. Applied per hit rather
 * than to a total is the whole mechanic: it is what makes one heavy shot worth
 * more than the same damage delivered as chip.
 */
export const effectiveDamage = (amount: number, armor: number): number =>
  armor > 0 ? Math.max(amount * BALANCE.armorFloor, amount - armor) : amount;

/**
 * `shieldFactor` multiplies the hit where it meets *shield* only.
 *
 * A defaulted parameter of the one funnel rather than a second entry point, so
 * every existing call site is byte-identical at 1 and nothing new reaches
 * `c.hp`. That distinction is the whole reason a shield-breaker was safe to add:
 * it changes how `effective` is divided, not how much of it there is.
 */
export function damageCreep(
  w: World,
  c: Creep,
  amount: number,
  source?: Tower,
  shieldFactor = 1,
): void {
  if (c.dead || c.hp <= 0) return;

  const def = ENEMIES[c.defId];

  // Any hit restarts the regen countdown, whether or not a shield is up. That
  // is what makes sustained fire hold a Warden's shield at zero while a gap in
  // coverage hands it back.
  c.shieldTimer = def.shieldRegenDelay;

  // Armour comes off the individual hit, before anything else can absorb it.
  // Splash arrives here too, which is deliberate — the falloff edge of a
  // detonation is a small hit and armour treats it like one.
  //
  // `shred` is subtracted from the plating rather than added to the shot: a
  // stripped Bulwark is easier for *everything* on the board, which is what
  // makes stripping a support mechanic instead of a damage one.
  const effective = effectiveDamage(amount, Math.max(0, def.armor - c.shred));

  // Shield absorbs next, and the overflow carries into the hull — so a single
  // heavy shot is not wasted on a thin shield the way it would be if the shield
  // simply ate the whole hit.
  //
  // Note the division on the way out. A 3× breaker removes three shield per
  // point of `effective`, so the *effective* it has spent doing that is
  // `toShield / shieldFactor` — dividing it back out is what stops the
  // multiplier from also tripling what spills into hull once the shield pops.
  // Without that, a shield-breaker would quietly be a general damage multiplier.
  let toHull = effective;
  let toShield = 0;
  if (c.shield > 0) {
    toShield = Math.min(c.shield, toHull * shieldFactor);
    c.shield -= toShield;
    toHull -= toShield / shieldFactor;
    if (c.shield === 0) w.events.push({ type: 'shieldBroke', x: c.x, y: c.y });
  }

  // Credit shield and hull alike, but never more than was actually there, so
  // overkill on a 2hp creep doesn't inflate a tower's damage figure.
  //
  // Written as the two parts summed rather than derived from `effective`, which
  // is the same number at `shieldFactor: 1` and the honest one above it: a
  // breaker that removed 30 points of shield did remove 30 points of shield.
  const landed = toShield + Math.min(toHull, c.hp);
  c.hp -= toHull;

  if (source !== undefined) source.damageDealt += landed;
  w.events.push({
    type: 'creepDamaged',
    id: c.id,
    x: c.x,
    y: c.y,
    amount: landed,
    toShield,
    defId: source?.defId ?? null,
  });

  if (c.hp > 0) return;

  c.dead = true;

  // What a salvage station overhead is worth, applied once and then used
  // everywhere the bounty is — the wallet, the run total, the per-wave
  // itemisation and the event. Computing it once is what stops the HUD's
  // summary and the player's actual money disagreeing.
  //
  // Deliberately *not* visible to `sortieCost`, which prices a send off the
  // def's scaled bounty: a defender's economy must not raise what an attacker
  // pays to send at them.
  const paid = Math.round(c.bounty * (1 + salvageBonus(w, c.x, c.y)));

  // Paid to whoever's board this is, which for a sortie means the *defender*
  // collects. That is the whole anti-spam valve of the duel economy and it
  // needs no code of its own: bounty has always been credited to the world the
  // contact died in, and a sortie dies in the world it was sent to.
  w.money += paid;
  w.stats.kills++;
  w.stats.bounty += paid;

  // Run totals count every kill; the per-wave itemisation counts only what the
  // wave machine dispatched. A sortie has no wave to be itemised against, and
  // charging it to whichever wave happened to be spawning would put kills in a
  // clear summary that the wave never contained.
  if (c.origin === 'wave') {
    const wave = waveStats(w, c.wave);
    wave.kills++;
    wave.bounty += paid;
  }

  if (source !== undefined) source.kills++;
  w.events.push({ type: 'creepKilled', x: c.x, y: c.y, bounty: paid, defId: c.defId });

  // Queued, never spawned here. `stepProjectiles` is iterating `w.creeps` when
  // this runs, and a push mid-iteration would let the very shot that made the
  // kill also strike a child that did not exist when it was fired.
  const split = ENEMIES[c.defId].splitInto;
  if (split !== null) {
    w.pendingSplits.push({ parent: c, into: split.enemy as EnemyId, count: split.count });
  }
}
