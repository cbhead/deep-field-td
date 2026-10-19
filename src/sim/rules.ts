/**
 * What a run is playing: which arc, and how hard.
 *
 * The sim used to reach straight for the `WAVES` table and `BALANCE`'s starting
 * figures, which is fine while there is exactly one of each. A campaign makes
 * both a per-run choice, and this is the object that carries that choice from
 * the menu down to the spawner without any system in between needing to know a
 * campaign exists.
 *
 * Every function that takes a `Rules` defaults it to `DEFAULT_RULES`, and
 * `DEFAULT_RULES` is byte-for-byte the game as it was before the campaign: the
 * Switchback arc at the swept baseline. That default is why `tools/check.ts`
 * and `tools/sweep.ts` did not have to change, and why Race mode is still the
 * same game — Race passes nothing, so it gets the baseline, so the N2 fairness
 * gate keeps meaning what it meant.
 */

import { BALANCE } from '../content/balance.ts';
import { WAVES } from '../content/waves.ts';
import { BANK_FLOOR, DIFFICULTIES, DEFAULT_DIFFICULTY, type DifficultyId } from '../content/difficulty.ts';
import type { LevelDef } from '../content/levels.ts';
import type { WaveDef } from '../content/types.ts';

export interface Rules {
  readonly levelId: string;
  readonly difficultyId: DifficultyId;
  readonly waves: readonly WaveDef[];
  readonly startingLives: number;
  readonly startingMoney: number;
  /**
   * Applied to *scaled* hp and shield, after the seeded roll. Difficulty must
   * never touch composition or spawn timing — if it did, two players on the
   * same seed at different tiers would face different arrival patterns, and the
   * one property this game's determinism story rests on would be gone.
   */
  readonly hpFactor: number;
  readonly bountyFactor: number;

  /**
   * Whether the arc runs out, or runs forever.
   *
   * False everywhere except versus. A campaign sector is a fixed arc you
   * either finish or don't, and `waveCount` returning its table's length is
   * what makes "won" mean something.
   *
   * A versus match has no such ending. Two players who both hold would run the table
   * out and be settled by a ranking rather than by either of them doing
   * anything — an anticlimax, and one that would need a clock or a sudden-death
   * rule to fix. Endless is that rule, and it needs no UI: composition wraps
   * around the table while **scaling stays on the true index**, so
   * `hpGrowth ** waveIndex` compounds without bound and the neutral wave alone
   * eventually beats any defence. The match ends when a core does.
   *
   * See the horizon probe in `tools/check.ts` for where that actually lands.
   */
  readonly endless: boolean;

  /**
   * Whether stations are unlocked by a wave clock or by a bought era.
   *
   * False everywhere except versus, where `TowerDef.unlockWave` is replaced
   * by `TowerDef.era` and the player pays to advance. That purchase is the
   * whole tension of the mode: while you are banking for it you are building
   * nothing, and that is when the other side pushes.
   */
  readonly eras: boolean;

  /**
   * Whether this board has a sortie deck — whether contacts can be *sent*.
   *
   * A third flag rather than one `mode: 'versus'`, and deliberately: each of
   * these three names a mechanism the sim actually branches on, and a mode name
   * would make every branch a question about identity rather than about
   * behaviour. It also keeps them separable — an endless campaign board with no
   * ladder and no deck is a coherent thing to want, and it costs nothing to
   * leave possible.
   */
  readonly sorties: boolean;

  /**
   * Whether the player may arm auto-rush — sending every wave the instant its
   * intermission opens, and collecting the full bonus for it.
   *
   * True in the campaign and in Race, false in versus. Not a balance judgement
   * about the feature but a scoping one: versus wave timing is entangled with
   * the sortie economy, since contacts arriving from an opponent are on nobody's
   * intermission clock, and the interaction is unswept. A flag rather than a
   * check for `sorties` being on, because "has a send deck" and "may skip its
   * own intermission" are two different facts that happen to coincide today.
   */
  readonly autoStart: boolean;
}

/**
 * The baseline. Lives and money are **getters**, not captured values.
 *
 * `tools/sweep.ts` patches `BALANCE` in place between runs and relies on every
 * consumer reading it at call time — that is the documented trick that lets it
 * drive the real simulation rather than a copy. Snapshotting these two numbers
 * at module load would silently opt the default ruleset out of that, so a sweep
 * over starting money would report no effect. One stable object, values read
 * late: the sweep keeps working and nothing allocates per call.
 */
export const DEFAULT_RULES: Rules = {
  levelId: 'level01',
  difficultyId: DEFAULT_DIFFICULTY,
  waves: WAVES,
  get startingLives() {
    return BALANCE.startingLives;
  },
  get startingMoney() {
    return BALANCE.startingMoney;
  },
  hpFactor: 1,
  bountyFactor: 1,
  endless: false,
  eras: false,
  sorties: false,
  autoStart: true,
};

/**
 * Bind a campaign level and a difficulty tier into one run's rules.
 *
 * `bank` is money carried out of the previous sector, and it **replaces** the
 * tier's starting money rather than adding to it. That is the whole point: if
 * carried cash were a bonus on top, banking would be free and the decision it
 * is meant to create — spend now or keep it for the next sector — would not
 * exist. Replacing makes leftover cash genuinely yours and genuinely at risk.
 *
 * A sector entered poor is therefore possible and is meant to be, but it is
 * floored at `BANK_FLOOR` of the tier's own starting money. Unfloored, the rule
 * had a dead end rather than a hard mode: a normal run finished Switchback on
 * $44–$101 against a cheapest station of $75, so the next sector opened with no
 * towers, no way to buy one, and therefore no bounty ever. The floor sits below
 * every tier's normal start, so arriving poor still costs you — it just cannot
 * cost you the ability to play.
 *
 * **The height of that floor is load-bearing and was wrong.** A builder that
 * spends to zero lands on the floor every time, so the floor is not a safety
 * net for that player — it is their opening budget for every sector after the
 * first. At 0.6 that meant playing seven of the eight boards on $150 when they
 * are tuned at $250, and the campaign could not be finished on Standard at all.
 * See the note on `BANK_FLOOR` for why the fix was the floor rather than the
 * boards.
 *
 * Beyond that the bank is uncapped, so hoarding really does compound. That is a
 * deliberate choice rather than an oversight: the run is the player's to make
 * lopsided if they want to.
 */
/**
 * `floor` exists so `tools/bankfloor.ts` can sweep it. `BALANCE` is a mutable
 * object that the probes patch in place, but `BANK_FLOOR` is a primitive and
 * cannot be, so without a seam the sweep would have to re-implement the line
 * below — and a sweep of a *copy* of the rule is exactly the thing the header
 * of `tools/sweep.ts` warns against. Defaulting it keeps every production
 * caller on the real constant and unchanged.
 */
export function resolveRules(
  level: LevelDef,
  difficulty: DifficultyId,
  bank?: number,
  floor: number = BANK_FLOOR,
): Rules {
  const d = DIFFICULTIES[difficulty];
  return {
    levelId: level.id,
    difficultyId: d.id as DifficultyId,
    waves: level.waves,
    startingLives: d.startingLives,
    startingMoney:
      bank === undefined ? d.startingMoney : Math.max(bank, Math.round(d.startingMoney * floor)),
    hpFactor: d.hpFactor,
    bountyFactor: d.bountyFactor,
    // A campaign sector is a fixed arc unlocked by a wave clock. Only versus
    // opts out, and it builds its rules through `versusRules` rather than here.
    endless: false,
    eras: false,
    sorties: false,
    autoStart: true,
  };
}

/**
 * One versus match's rules: the same arc machinery, with no end and with the
 * era ladder in place of the wave clock.
 *
 * Separate from `resolveRules` rather than a flag on it, because every caller
 * of that function is a campaign or a Race and none of them should have to pass
 * two falses to say so. The difficulty tier still applies — a versus match on
 * Blackout is the same fourteen lives against the same tougher contacts.
 *
 * Named `versus` and not `duel`: `tools/check.ts` already uses "duel" for its
 * one-station-against-one-contact matrix, and two meanings of the word in the
 * file where both are asserted would be genuinely confusing.
 */
export function versusRules(level: LevelDef, difficulty: DifficultyId): Rules {
  return {
    ...resolveRules(level, difficulty),
    endless: true,
    eras: true,
    sorties: true,
    autoStart: false,
  };
}
