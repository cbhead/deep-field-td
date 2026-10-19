/**
 * Balance sweep. `npm run sweep`.
 *
 * Runs whole matches headlessly under different numbers and reports how each
 * strategy fared. It exists because balance is the part of this game that is
 * actually hard, and eyeballing a table of stats does not answer it.
 *
 * **Read the marginal block, not the mono-build rows.** "Can a defence built
 * entirely around one station win?" was the original question and it is the
 * wrong one: it is only answerable by a station that kills things, so asking it
 * of a slow guarantees a false failure. Singularity wins 0/5 alone and is worth
 * more to a real build than either of the others — tuning it until it wins alone
 * means handing it damage, which collapses three stations back into three ways
 * to do the same thing. The mono rows are still printed, but as a check for a
 * *dominant* station; a weak one there means nothing on its own.
 *
 * It mutates BALANCE / TOWERS / ENEMIES between runs. `as const` is compile-time
 * only and every consumer reads these objects at call time, so this drives the
 * real simulation with different values rather than a copy of it.
 *
 * Deliberately not a gate. `tools/check.ts` asserts things that must be true;
 * this reports things a human has to judge.
 */
import { LEVEL01 } from '../src/content/maps/level01.ts';
import { CAMPAIGN } from '../src/content/levels.ts';
import { BALANCE } from '../src/content/balance.ts';
import { TOWERS, TOWER_IDS, type TowerId } from '../src/content/towers.ts';
import { ENEMIES, type EnemyId } from '../src/content/enemies.ts';
import { parseMap } from '../src/sim/util/grid.ts';
import type { MapDef } from '../src/sim/types.ts';
// Aliased: this file's own `STRATEGIES` is a list of build *compositions*,
// where these are placement strategies. Two different axes, one good name.
import { buildOrder, spotFor, strategyName, STRATEGIES as PLACEMENTS, type Strategy } from './buildOrder.ts';
import { DEFAULT_RULES, resolveRules, type Rules } from '../src/sim/rules.ts';
import type { DifficultyId } from '../src/content/difficulty.ts';
import { createWorld } from '../src/sim/world.ts';
import { stepWorld } from '../src/sim/step.ts';
import { waveCount } from '../src/sim/wavePlan.ts';

const map = parseMap(LEVEL01);

interface Result {
  won: boolean;
  cleared: number;
  lives: number;
  towers: number;
}

/**
 * Play one match with a repeating build order, buying the next tile whenever it
 * becomes affordable. Starting money is the real one — handing the sweep an
 * unlimited budget measures tower damage and says nothing about whether bounty
 * income can fund a defence, which is usually the actual constraint.
 */
function run(
  build: TowerId[],
  rush: boolean,
  seed: number,
  board: MapDef = map,
  rules: Rules = DEFAULT_RULES,
  strategy: Strategy = PLACEMENTS[0]!,
): Result {
  // Ranked by the widest reach in the build, so every strategy shares one
  // notion of a good tile and none is flattered by its own ordering — and by
  // the widest *attacking* reach specifically. Overclock's 1.8 is a buff radius,
  // not a coverage radius, so letting it into the max would rank tiles for a
  // reach no station in the build actually shoots at.
  const guns = build.filter((b) => TOWERS[b].buffShotsPerSecond === 0);
  const spots = buildOrder(board, Math.max(...(guns.length > 0 ? guns : build).map((b) => TOWERS[b].range)), strategy.how);
  const w = createWorld(board, seed, rules);
  // `next` cycles the build order; `taken` tracks tiles. They were one counter
  // until support arrived, which does not take tiles in rank order — see
  // `spotFor`.
  const taken = new Set<number>();
  let next = 0;

  for (let i = 0; i < 300_000 && w.phase === 'playing'; i++) {
    // **Locked stations are stepped over, not waited on**, and the difference is
    // not cosmetic. This used to hold the cursor on a locked slot, so the whole
    // build stalled until that station unlocked — a five-station cycle bought
    // three towers and then idled from wave 0 to wave 2 with money piling up,
    // and Overclock at wave 6 turned the stall into a total loss: `nova+overclock`
    // measured 0/5 having built exactly one tower. Every figure this harness
    // produced for a build containing Arc or Filament carried a smaller version
    // of the same distortion.
    //
    // **The skip is a local offset and must not advance `next`.** Advancing it
    // per tick rotates the cycle thousands of times while a station is locked,
    // so which station lands on which ranked tile once it unlocks is arbitrary —
    // and on a board with unequal lanes that assignment is most of the result.
    // The first draft did exactly that and moved Sluice from 5/5 to 1/5 at
    // Standard, which looked like a content bug and was an artefact.
    //
    // `next` therefore moves only when something is actually bought, so the
    // build keeps its proportions among whatever is currently available and the
    // locked station is simply next in line the moment it opens.
    //
    // Bounded by the cycle length: a build whose stations are all still locked
    // buys nothing this tick rather than spinning.
    let skip = 0;
    while (skip < build.length && w.wave.index < TOWERS[build[(next + skip) % build.length]!].unlockWave) {
      skip++;
    }
    if (skip === build.length) {
      if (rush) w.commands.push({ type: 'startWave' });
      stepWorld(w, 1 / 60);
      w.events.length = 0;
      continue;
    }

    const want = build[(next + skip) % build.length]!;
    const def = TOWERS[want];
    // One held tile per *distinct* gun still locked. Deduped because a build
    // like `nova+2lance` names a station twice and would otherwise reserve
    // twice for it; guns only, because support is not placed by rank.
    const reserve = strategy.hold
      ? new Set(
          build.filter(
            (b) => TOWERS[b].buffShotsPerSecond === 0 && w.wave.index < TOWERS[b].unlockWave,
          ),
        ).size
      : 0;
    const at = spotFor(
      spots,
      taken,
      def.buffShotsPerSecond > 0 ? { range: def.range, towers: w.towers } : null,
      reserve,
    );
    // Money still blocks rather than skipping: waiting to afford the station the
    // build asked for is what a player does, where skipping to a cheaper one
    // would quietly rewrite the mix being measured.
    if (at >= 0 && w.money >= def.cost) {
      w.commands.push({ type: 'placeTower', defId: want, col: spots[at]![0], row: spots[at]![1] });
      taken.add(at);
      next += skip + 1;
    }
    if (rush) w.commands.push({ type: 'startWave' });
    stepWorld(w, 1 / 60);
    w.events.length = 0;
  }

  return {
    won: w.phase === 'won',
    cleared: w.wave.clearedThrough + 1,
    lives: w.lives,
    towers: w.towers.length,
  };
}

const STRATEGIES: [string, TowerId[]][] = [
  ['lance', ['lance']],
  ['nova', ['nova']],
  ['singularity', ['singularity']],
  // Must be 0/5, for the same structural reason `singularity` is: a station
  // with no damage cannot answer "can a defence built entirely around this
  // clear the arc". Here as a dominance check only.
  ['overclock', ['overclock']],
  ['nova+2lance', ['nova', 'lance', 'lance']],
  // **The row to watch.** Nova is the +49% case — the slowest gun in the roster
  // and therefore the one an additive rate buff is worth most to. If this wins
  // every seed with lives to spare, Overclock is underpriced, and this pair is
  // where that will show first.
  ['nova+overclock', ['nova', 'overclock']],
  ['all three', ['nova', 'lance', 'singularity']],
];

/**
 * `SEEDS=N` trims the count for a fast pass while tuning; the pool is fixed so a
 * short run is a prefix of the long one and the two are comparable. Five is the
 * real answer — `bankfloor.ts` has taken this seam for a while and it is worth
 * having here too, now that a run costs closer to two minutes than one.
 */
const SEED_POOL = [4242, 7, 999, 31337, 12345];
const SEEDS = SEED_POOL.slice(0, Number(process.env['SEEDS'] ?? SEED_POOL.length));

function sweep(label: string, apply: () => void): void {
  apply();
  console.log(`\n\x1b[1m${label}\x1b[0m`);
  for (const rush of [false, true]) {
    for (const [name, build] of STRATEGIES) {
      const rs = SEEDS.map((s) => run(build, rush, s));
      const wins = rs.filter((r) => r.won).length;
      const lives = rs.reduce((a, r) => a + r.lives, 0) / rs.length;
      const cleared = rs.reduce((a, r) => a + r.cleared, 0) / rs.length;
      const towers = rs.reduce((a, r) => a + r.towers, 0) / rs.length;
      // A win on 3 lives and a win on 19 are different games; the lives column
      // is the one that says whether the arc has any tension in it.
      console.log(
        `  ${rush ? 'rush' : 'wait'} ${name.padEnd(12)}` +
          ` won ${wins}/${SEEDS.length}` +
          `  waves ${cleared.toFixed(1).padStart(4)}/${waveCount()}` +
          `  lives ${lives.toFixed(1).padStart(5)}/${BALANCE.startingLives}` +
          `  towers ${towers.toFixed(0).padStart(3)}`,
      );
    }
  }
}

/** Patch helpers. The casts are the point of this file — see the header. */
const patch = (o: object, values: Record<string, number>): void => {
  for (const [k, v] of Object.entries(values)) (o as Record<string, number>)[k] = v;
};
export const tower = (id: TowerId, values: Record<string, number>): void => patch(TOWERS[id], values);
export const enemy = (id: EnemyId, values: Record<string, number>): void => patch(ENEMIES[id], values);
export const balance = (values: Record<string, number>): void => patch(BALANCE, values);


/**
 * A candidate set of numbers.
 *
 * Absolute, not cumulative. An earlier pass chained deltas — each set applied
 * on top of the last — which made a promising row impossible to reproduce on
 * its own and quietly turned "B plus a tweak" into "A plus B plus a tweak".
 *
 * To tune: declare a Candidate, call `sweep('label', apply(c))`, run
 * `npm run sweep`, then delete the candidates once the winner is applied to
 * `content/`. They are scaffolding, not a record — the numbers in `content/`
 * are the record.
 */
interface Candidate {
  lance: { cost: number; damage: number };
  nova: { cost: number; splashRadius: number };
  singularity: { cost: number; damage: number; slowFactor: number; slowSeconds: number };
  hpGrowth: number;
  monolithHp: number;
}

const apply = (c: Candidate) => () => {
  tower('lance', { cost: c.lance.cost, damage: c.lance.damage, range: 2.8, fireInterval: 0.5 });
  tower('nova', {
    cost: c.nova.cost,
    splashRadius: c.nova.splashRadius,
    damage: 22,
    range: 2.5,
    fireInterval: 1.4,
  });
  tower('singularity', {
    cost: c.singularity.cost,
    damage: c.singularity.damage,
    slowFactor: c.singularity.slowFactor,
    slowSeconds: c.singularity.slowSeconds,
    range: 3.3,
    fireInterval: 0.28,
  });
  balance({ hpGrowth: c.hpGrowth });
  enemy('monolith', { hp: c.monolithHp });
};

/**
 * What each station is worth *to a build that already has the others*.
 *
 * This is the question S4 actually wants answered. Dropping one station from
 * the full build leaves the survivors in the proportion they had before — a
 * 1:1:1 cycle minus one slot is still 1:1 — so the delta is the station's
 * contribution and not an artefact of a changed build order.
 *
 * A station earning near zero here is the real "non-viable", and a station
 * whose absence barely registers is the real "decorative". Neither shows up in
 * the mono-build rows, which is why those rows kept saying Singularity was
 * broken while it was quietly carrying the strongest build in the game.
 *
 * **The tier is probed, not assumed**, for the reason `boardMarginal` spells
 * out at length: a lives delta only has resolution inside a band. This block ran
 * at Standard for its whole life and was fine there while the reference build
 * was three stations. At four it finishes on 19.6 of 20 — six tenths of a life
 * from the ceiling — and every column collapses toward zero or toward the whole
 * reserve, which reads like data and is not. Overclock measured `+0.2` there and
 * the number meant nothing at all.
 *
 * `wait` only. Rushing is a separate axis and mixing it in here would fold two
 * questions into one number.
 */
const REFERENCE: TowerId[] = ['nova', 'lance', 'singularity', 'overclock'];

function marginal(): void {
  const score = (build: TowerId[], rules: Rules) => {
    const rs = SEEDS.map((s) => run(build, false, s, map, rules));
    return {
      wins: rs.filter((r) => r.won).length,
      lives: rs.reduce((a, r) => a + r.lives, 0) / rs.length,
    };
  };

  // Hardest first, and the same band as `boardMarginal`: the reference build
  // must still win most seeds and must still bleed. Falling back to whichever
  // tier won most keeps a row printing rather than vanishing.
  const level = CAMPAIGN[0]!;
  type Probe = { tier: DifficultyId; rules: Rules; base: ReturnType<typeof score> };
  let picked: Probe | null = null;
  let fallback: Probe | null = null;

  for (const tier of ['blackout', 'standard', 'recon'] as const) {
    const rules = resolveRules(level, tier);
    const base = score(REFERENCE, rules);
    const here = { tier, rules, base };
    if (fallback === null || base.wins > fallback.base.wins) fallback = here;
    if (base.wins >= 3 && base.lives < rules.startingLives) {
      picked = here;
      break;
    }
  }

  const { tier, rules, base } = picked ?? fallback!;

  console.log(`\n\x1b[1mmarginal contribution\x1b[0m`);
  console.log(
    `  \x1b[2mwhat each station adds to a build that already has the other three ·` +
      ` ${tier}${picked === null ? ' (no tier gave resolution — read nothing here)' : ''}\x1b[0m`,
  );

  console.log(
    `  all four${' '.repeat(12)}won ${base.wins}/${SEEDS.length}` +
      `  lives ${base.lives.toFixed(1).padStart(5)}/${rules.startingLives}`,
  );

  for (const drop of REFERENCE) {
    const s = score(REFERENCE.filter((t) => t !== drop), rules);
    const delta = base.lives - s.lives;
    console.log(
      `  without ${drop.padEnd(12)}` +
        ` won ${s.wins}/${SEEDS.length}` +
        `  lives ${s.lives.toFixed(1).padStart(5)}/${rules.startingLives}` +
        `  \x1b[1m${drop} is worth ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}\x1b[0m`,
    );
  }
}

/**
 * What each of the six stations is worth, board by board.
 *
 * The map spec's §4 made five predictions about what routes do to the roster,
 * and said plainly that none of it needs a number changed — that the geometry
 * does the work on its own. This is the block that checks that, because the
 * claim is falsifiable and was never tested:
 *
 *   Lance (pierce)      down, sharply — pierce pays by file length and a split
 *                       halves every file. Braid should be its floor.
 *   Nova (splash)       roughly flat — a lane still clumps, there are just two.
 *   Arc (chain)         up — chain needs proximity, not alignment, and it is
 *                       the only thing that reads a merge well.
 *   Singularity (slow)  down as a force multiplier — it no longer manufactures
 *                       the file Lance wants.
 *   Filament (ramp)     up on Delta, down elsewhere — a ramp wants one target
 *                       held, and only Delta's trunk gives that.
 *
 * Method: drop one station from the full build and read the lives delta.
 * Dropping one slot from an even cycle leaves the survivors in the proportion
 * they had, so the delta is the station's contribution rather than an artefact
 * of a changed build order.
 *
 * **Core-plus-candidate was tried here when the roster doubled, and rejected.**
 * The reasoning for it was sound — at twelve stations a drop removes 8% of the
 * composition where at six it removed 17%, so the instrument loses resolution —
 * and scoring a three-gun core against core-plus-one restores that resolution.
 * What it also does is confound contribution with *dilution*: adding a fourth
 * station to a three-station cycle cuts every existing gun's share by a quarter,
 * so a station that is genuinely useful still reads negative if it is worth less
 * than the quarter of a Nova it displaced. The resulting table was negative
 * almost everywhere, which says more about cycle arithmetic than about the
 * roster. The same effect, measured independently: adding one gun to
 * `campaign.ts`'s five-station probe cost Sluice five of five wins.
 *
 * Leave-one-out has the opposite failure and it is the more honest one — it goes
 * quiet rather than lying. Rows that read `never bled — ceiling` are the
 * instrument saying so out loud.
 *
 * **Difficulty is chosen per board, and that is the measurement, not a
 * convenience.** A lives delta only has resolution in a band. Below it the base
 * build already finishes on zero, the drop finishes on zero too, and every
 * station reads `+0.0`; above it the base finishes untouched on full lives and
 * every station reads `+0.0` again. Both look like data and neither is: the
 * first says the instrument is on its floor, the second that it is on its
 * ceiling.
 *
 * Run at Standard, the five new boards floor. Run at Recon, the first four
 * saturate at 30/30. There is no single tier that puts all eight inside the
 * band — so each board is measured at the hardest tier its reference build
 * still clears while actually losing something, and the tier is printed in the
 * row. A row that could not find one is marked, because "no tier works" is a
 * fact about the board worth seeing rather than a gap to fill with zeroes.
 *
 * The ranking is chosen per board by running the full build both ways and
 * keeping the better — a player is allowed to pick the right strategy, and on
 * these boards picking it is most of the game.
 */
/**
 * The three guns every run opens with, and everything measured against them.
 *
 * Wave 0 and damage-dealing: the build a player actually has in front of them
 * when the first decision gets made. Salvage also opens at wave 0 and is
 * deliberately not here — a core with no damage in one of its three slots would
 * measure every candidate against a weaker baseline than anyone plays.
 */
const ALL: TowerId[] = [...TOWER_IDS];

function boardMarginal(): void {
  console.log(`\n\x1b[1mmarginal contribution across eight boards\x1b[0m`);
  console.log(`  \x1b[2mlives each station adds to a build that already has the other eleven\x1b[0m`);
  console.log(
    `  \x1b[2mmeasured at the hardest tier whose reference build still wins and still bleeds —` +
      ` on the floor or the ceiling every column reads zero\x1b[0m`,
  );
  console.log(
    `  \x1b[2m${'board'.padEnd(11)}${'tier'.padEnd(10)}${'build'.padEnd(8)}` +
      ALL.map((t) => t.slice(0, 5).padStart(7)).join('') +
      `\x1b[0m`,
  );

  for (const level of CAMPAIGN) {
    const board = parseMap(level.map);
    const lanes = board.routes.length;

    const score = (build: TowerId[], rules: Rules, how: Strategy) => {
      const rs = SEEDS.map((s) => run(build, false, s, board, rules, how));
      return {
        wins: rs.filter((r) => r.won).length,
        lives: rs.reduce((a, r) => a + r.lives, 0) / rs.length,
        cleared: rs.reduce((a, r) => a + r.cleared, 0) / rs.length,
      };
    };

    // Hardest first. The band is "wins most seeds" and "does not finish
    // untouched" — the second half is what rejects Recon on the older boards,
    // where the reference build never loses a life and the drops cannot either.
    type Probe = { tier: DifficultyId; rules: Rules; how: Strategy; base: ReturnType<typeof score> };
    let picked: Probe | null = null;
    let fallback: Probe | null = null;

    for (const tier of ['blackout', 'standard', 'recon'] as const) {
      const rules = resolveRules(level, tier);
      // Best of all four, same as `campaign.ts` — a player picks their strategy
      // and the two tools must not disagree about which ones exist.
      const scored = PLACEMENTS.map((s) => ({ how: s, base: score(ALL, rules, s) }));
      const pick = scored.reduce((a, b) =>
        b.base.wins > a.base.wins || (b.base.wins === a.base.wins && b.base.lives > a.base.lives) ? b : a,
      );
      const { how, base } = pick;
      const here = { tier, rules, how, base };

      if (fallback === null || base.wins > fallback.base.wins) fallback = here;
      if (base.wins >= 3 && base.lives < rules.startingLives) {
        picked = here;
        break;
      }
    }

    const chosen = picked ?? fallback!;
    const { rules, how, base } = chosen;
    const worth = ALL.map((drop) => base.lives - score(ALL.filter((t) => t !== drop), rules, how).lives);

    const note =
      picked === null
        ? base.lives >= rules.startingLives
          ? 'never bled — ceiling'
          : 'never cleared — floor'
        : `${lanes} lane${lanes > 1 ? 's' : ''}`;

    console.log(
      `  ${level.name.padEnd(11)}${chosen.tier.padEnd(10)}${strategyName(how).padEnd(15)}` +
        worth.map((d) => `${d >= 0 ? '+' : ''}${d.toFixed(1)}`.padStart(7)).join('') +
        `   \x1b[2m${note} · base ${base.wins}/${SEEDS.length} won,` +
        ` ${base.cleared.toFixed(1)}/${waveCount(rules)} waves, ${base.lives.toFixed(1)}/${rules.startingLives} lives\x1b[0m`,
    );
  }
}

sweep('as shipped', () => {});
marginal();
boardMarginal();

export { sweep, run, apply, marginal, boardMarginal };
export type { Candidate };
