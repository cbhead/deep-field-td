import { BALANCE } from '../../content/balance.ts';
import { planWave, waveCount } from '../wavePlan.ts';
import { spawnCreep, waveStats, type World } from '../world.ts';

/**
 * Send the next wave now, forfeiting the rest of the intermission.
 *
 * Refused only while a wave is mid-spawn — sending two waves through the same
 * spawn plan at once has no sensible meaning. Every other moment is fair game,
 * including while the previous wave is still walking the board. That overlap is
 * the point: rushing buys tempo and cash at the cost of fighting two waves at
 * once, and in Race mode it is how a player pulls ahead.
 *
 * A refusal emits an event rather than returning silently. A control that does
 * nothing and says nothing reads as broken, which is exactly how this behaved
 * before.
 */
export function beginWave(w: World): void {
  const s = w.wave;

  if (s.phase === 'spawning') {
    w.events.push({ type: 'waveRejected', reason: 'spawning' });
    return;
  }
  if (s.phase === 'done') {
    w.events.push({ type: 'waveRejected', reason: 'done' });
    return;
  }

  // Captured before the timer is reset.
  //
  // **This used to say the bonus was payment for time the player *chose* to
  // give up, and that the timer expiring earns nothing.** The second half is
  // still true and the first is not: `wave.autoStart` sends every wave the
  // instant its intermission opens and is paid in full, so the same bonus is now
  // claimed by a choice made once rather than every wave.
  //
  // The rule that replaces it: **the bonus is payment for the overlap risk
  // taken.** That is what the money was ever really buying — a rushed wave lands
  // on top of one still walking — and it is a thing an armed auto-rush takes
  // every bit as much as a player hitting the key. What the timer running out
  // earns nothing for is that it takes no risk at all.
  const secondsSaved = Math.max(0, s.timer);

  s.plan = planWave(w.seed, s.index, w.rules, w.map.routes);
  s.spawned = 0;
  s.timer = 0;
  s.phase = 'spawning';
  w.events.push({ type: 'waveStarted', wave: s.index, count: s.plan.length });

  if (secondsSaved > 0) {
    const bonus = Math.round(secondsSaved * BALANCE.rushBonusPerSecond);
    w.money += bonus;
    w.events.push({ type: 'waveRushed', wave: s.index, bonus, secondsSaved });
  }
}

export function updateWaves(w: World, dt: number): void {
  const s = w.wave;

  switch (s.phase) {
    case 'intermission':
      s.timer -= dt;
      // Armed auto-rush sends on the first tick of the intermission, with the
      // timer still at its full value — so it collects the whole bonus, which is
      // the entire point of it being a decision rather than a convenience.
      //
      // Routed through the same `beginWave` the key press uses, on the tick
      // *after* the phase opens rather than inline where spawning ends. One code
      // path, and `beginWave` moves the phase to 'spawning' immediately, so a
      // per-tick test can only fire once however long the branch is live.
      if (s.autoStart || s.timer <= 0) beginWave(w);
      break;

    case 'spawning': {
      s.timer += dt;
      // A `while`, not an `if`: at 4x speed, or with a tight rush wave, more
      // than one spawn can come due in a single 16ms tick.
      while (s.spawned < s.plan.length && s.plan[s.spawned]!.at <= s.timer) {
        const next = s.plan[s.spawned]!;
        spawnCreep(w, next.enemy, {
          hp: next.hp,
          bounty: next.bounty,
          shield: next.shield,
          wave: s.index,
          route: next.route,
        });
        s.spawned++;
      }

      if (s.spawned >= s.plan.length) {
        s.dispatchedThrough = s.index;
        // The intermission starts now, not when the board empties. This is what
        // makes waves overlap.
        if (s.index + 1 >= waveCount(w.rules)) {
          s.phase = 'done';
        } else {
          s.index++;
          s.phase = 'intermission';
          s.timer = BALANCE.intermission;
        }
      }
      break;
    }

    case 'done':
      break;
  }

  settleClearedWaves(w);
}

/**
 * Pay out for waves whose creeps have all left the board.
 *
 * Works from the lowest wave still alive, so it stays correct when waves
 * overlap and can settle several at once — a rush that stacks three waves and
 * then wipes them clears all three on the same tick.
 *
 * Leaks count as cleared: the life is already spent, and stalling the payout
 * because one creep got through would punish the player twice.
 */
function settleClearedWaves(w: World): void {
  const s = w.wave;

  let lowestLive = Infinity;
  for (const c of w.creeps) {
    // Sorties belong to no wave and must never hold one open. Without this a
    // single slow contact sent by an opponent would freeze `clearedThrough`
    // for as long as it walked — no clear reward, and a Race status pump stuck
    // reporting the same wave. See `Creep.origin`.
    if (c.origin === 'sortie') continue;
    if (!c.dead && c.wave < lowestLive) lowestLive = c.wave;
  }

  // A queued split is a promise of live contacts in the parent's wave, so it
  // counts as one. Today's phase order drains the queue in the same tick it is
  // filled, so this window never opens in play — but settlement would then be
  // relying on `resolveSplits` happening to sit between the systems that fill
  // the queue and the next `updateWaves`. Reading the queue directly makes the
  // rule true regardless of order, and the alternative failure is the worst
  // kind: a wave paying out, or a run declaring victory, with contacts about
  // to appear on the board.
  for (const s of w.pendingSplits) {
    if (s.parent.origin === 'sortie') continue;
    if (s.parent.wave < lowestLive) lowestLive = s.parent.wave;
  }

  // Only waves that are both fully spawned and entirely gone from the board.
  const clearable = Math.min(s.dispatchedThrough, lowestLive - 1);
  while (s.clearedThrough < clearable) {
    s.clearedThrough++;
    w.money += BALANCE.waveClearReward;

    const tally = waveStats(w, s.clearedThrough);
    w.events.push({
      type: 'waveCleared',
      wave: s.clearedThrough,
      kills: tally.kills,
      bounty: tally.bounty,
      leaked: tally.leaked,
      reward: BALANCE.waveClearReward,
    });
  }

  if (s.clearedThrough >= waveCount(w.rules) - 1 && w.phase === 'playing') {
    w.phase = 'won';
    w.events.push({ type: 'gameOver', won: true });
  }
}
