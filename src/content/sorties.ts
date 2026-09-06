import type { EnemyId } from './enemies.ts';

/**
 * What you can send at the other player, and what it costs.
 *
 * The offensive half of the era ladder. `TowerDef.era` says which stations a
 * rung opens; this says which contacts it lets you *send*, and the two together
 * are what makes an advance worth banking for — one purchase widens both what
 * you can hold with and what you can threaten with.
 *
 * ---
 *
 * **The roster is the threat, not a multiplier.** The plan had sorties scaling
 * on the sender's era as well as being gated by it, so that getting ahead made
 * every send hit harder. Built, that is two compounding curves to tune against
 * each other and one of them duplicates the other's job. Being two rungs up
 * already means sending Monoliths into a board that can only answer with Mk I
 * stations — that *is* the threat, and it needs no second dial. So a sortie
 * scales on the **receiver's current wave**, exactly like the neutral wave it
 * arrives beside, and the era decides only which line of this table you may buy.
 *
 * A useful consequence: a sortie is never stale. One bought at wave 3 and one
 * bought at wave 30 are both a real contact for the board they land on, and
 * neither the sender nor the receiver has to reason about whose clock applies.
 *
 * ---
 *
 * **Price is derived, never authored.** `sortieCost` is the scaled bounty times
 * `BALANCE.sortie.markup`, so what a contact costs to send is a fixed multiple
 * of what the defender earns for killing it. That is one rule doing three jobs:
 *
 *  - it self-scales with the wave, so no second cost curve needs sweeping
 *    against `bountyGrowth`;
 *  - it makes spam structurally self-defeating, because every send into a wall
 *    is a transfer to the person you are attacking;
 *  - it prices the roster automatically. A Monolith's bounty is 34 against a
 *    Drifter's 6, so it costs about six times as much and lands three lives
 *    rather than one — worse per life on paper, and better in practice exactly
 *    when their line is thin enough that it arrives. That trade is the deck.
 *
 * `weight` is the one authored number, and it is what stops the correct answer
 * always being the cheapest hull per dollar. See `EnemyDef.leakDamage`.
 */
export interface SortieDef {
  readonly enemy: EnemyId;
  /** Which era must be bought before this may be sent. Matches `TowerDef.era`. */
  readonly era: number;
  /**
   * Lives taken if it reaches their core, overriding the contact's own 1.
   *
   * Authored rather than derived from hp, because hp compounds per wave and a
   * leak cost that compounded with it would make one late Monolith lethal on
   * any board. Weight is a statement about what a *type* is worth landing, and
   * it has to stay true at wave 3 and at wave 30.
   */
  readonly weight: number;
  /**
   * The key that sends it, mirroring `TowerDef.hotkey`.
   *
   * QWERTY's top row, in table order — `q` through `y`, then `u i o` as the
   * roster grew. The build deck sits on the number row above it, so the two
   * decks are two rows of keys under the same hand and which row you are on is
   * which half of the mode you are playing.
   *
   * The two rows are no longer the same width: the build deck runs `1`-`0` plus
   * `-` and `=`, which reaches further right than `o` does. They start together
   * at the left, which is the part that has to line up.
   */
  readonly hotkey: string;
}

/**
 * Three per rung, and the pairing is the point: each era adds one contact that
 * asks about coverage and one that asks about damage, so the answer to a new
 * threat is never simply "more of what I have". The third on each rung is the
 * one that asks its rung's question *harder* than the pair already there.
 */
export const SORTIES = {
  /** Era I — the baseline, and the swarm. Chip damage, cheap, easily answered. */
  drifter: { enemy: 'drifter', era: 1, weight: 1, hotkey: 'q' },
  mote: { enemy: 'mote', era: 1, weight: 1, hotkey: 'w' },
  /**
   * The swarm that a slow cannot bunch. Era I because it is the rung's cheapest
   * lesson: it costs a defender nothing to build against and everything to have
   * built the wrong thing against.
   */
  skimmer: { enemy: 'skimmer', era: 1, weight: 1, hotkey: 'u' },

  /**
   * Era II — the two that punish a *thin* line rather than a weak one. A
   * Warden regenerates through a gap; a Cluster turns one kill into three
   * problems further back. Neither is stopped by raw damage in one place.
   */
  warden: { enemy: 'warden', era: 2, weight: 1, hotkey: 'e' },
  cluster: { enemy: 'cluster', era: 2, weight: 1, hotkey: 'r' },
  /** The same lesson as Warden, with no gap small enough to be safe. */
  aegis: { enemy: 'aegis', era: 2, weight: 1, hotkey: 'i' },

  /**
   * Era III — the two that land hard. A Monolith is 150 hull that takes three
   * lives; a Bulwark's armour means it survives precisely the many-small-hits
   * defence that answers everything on the rungs below.
   *
   * Weight 3 and 2 are the only numbers in this file that were chosen rather
   * than derived, and they are what make the top of the ladder worth buying.
   * At weight 1 a Monolith would cost six Drifters to do a Drifter's damage.
   */
  monolith: { enemy: 'monolith', era: 3, weight: 3, hotkey: 't' },
  bulwark: { enemy: 'bulwark', era: 3, weight: 2, hotkey: 'y' },
  /**
   * Armour as the only question, asked at more than twice a Bulwark's volume.
   * Weight 2 for the same reason Bulwark has it: it lands hard enough that
   * spending up for one has to beat sending two of something cheap.
   */
  ironclad: { enemy: 'ironclad', era: 3, weight: 2, hotkey: 'o' },
} as const satisfies Record<string, SortieDef>;

export type SortieId = keyof typeof SORTIES;

export const SORTIE_IDS = Object.keys(SORTIES) as SortieId[];
