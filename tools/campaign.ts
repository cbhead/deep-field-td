/**
 * Campaign arc probe. `npm run campaign`.
 *
 * The same greedy auto-builder the balance probe uses, pointed at every
 * (level × difficulty) pair instead of just Switchback at standard. It answers
 * one question the single-level sweep cannot: **is each new board winnable, and
 * does the campaign actually get harder in the order it claims to?**
 *
 * Read it as a shape, not as scores. What should be true:
 *
 * - Standard is winnable on every level with a mixed build, with fewer lives
 *   kept as the campaign goes on.
 * - Recon is comfortable everywhere — it is the tier for learning a board.
 * - Blackout is a real threat on level 3 and survivable on level 1.
 *
 * A level nobody can clear on Standard is a content bug; a level cleared at
 * full lives on Blackout is a level that is not pulling its weight.
 *
 * Deliberately not a gate, for the same reason `tools/sweep.ts` is not: this
 * reports numbers a human has to judge. The one thing it *does* assert is that
 * every campaign map parses, because a malformed board is unambiguously wrong.
 */
import { CAMPAIGN } from '../src/content/levels.ts';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../src/content/difficulty.ts';
import { TOWERS, type TowerId } from '../src/content/towers.ts';
import { parseMap } from '../src/sim/util/grid.ts';
import type { MapDef } from '../src/sim/types.ts';
import { buildOrder, spotFor, strategyName, STRATEGIES, type Strategy } from './buildOrder.ts';
import { createWorld } from '../src/sim/world.ts';
import { resolveRules } from '../src/sim/rules.ts';
import { stepWorld } from '../src/sim/step.ts';
import { waveCount } from '../src/sim/wavePlan.ts';

/**
 * The cycle this probe builds — five stations, representative rather than
 * exhaustive, and deliberately unchanged when the roster doubled.
 *
 * It was a hardcoded five that had already drifted once: Overclock shipped and
 * was never added. The obvious fix — derive it from the roster — was tried and
 * is wrong, which is worth recording because it looks right. Filtering to
 * `damage > 0` gives ten stations at twelve, and several of those do token
 * damage the way Singularity does; cycling them as if they were guns dilutes
 * the build and the probe then reports an arc that is unclearable when it is
 * not. Adding even *one* more (Ember, a real gun) cost Sluice five of five
 * wins and broke the continuous run at Standard.
 *
 * So this list is a **player archetype, not an inventory**: one of each way of
 * dealing damage — pierce, blast, slow, chain, ramp. Widening it does not make
 * the probe more representative, it makes it a worse player.
 *
 * The stations left out are not unmeasured. `sweep.ts`'s core-plus-candidate
 * block is the tool that asks whether an individual station is worth a slot,
 * and it covers all nine non-core stations by construction.
 */
const BUILD: TowerId[] = ['nova', 'lance', 'singularity', 'arc', 'filament'];
const SEEDS = [4242, 7, 999, 31337, 12345];

interface Result {
  won: boolean;
  cleared: number;
  lives: number;
  /** Cash on the board when the run settled — the bank carried to the next sector. */
  money: number;
}

/**
 * `stopBuyingAfter` models the one behaviour the carry rule is meant to create:
 * a player who stops spending near the end of a sector so they arrive at the
 * next one solvent. The default greedy builder never does this — it buys
 * whenever it can afford to — which makes it the worst possible reader of a
 * rule about saving.
 */
function run(
  map: MapDef,
  rules: ReturnType<typeof resolveRules>,
  seed: number,
  stopBuyingAfter = Infinity,
  strategy: Strategy = STRATEGIES[0]!,
): Result {
  // Attacking reach only — Overclock's radius buffs stations rather than
  // covering road, so ranking tiles by it would rank them for nothing.
  const reach = Math.max(...BUILD.filter((b) => TOWERS[b].buffShotsPerSecond === 0).map((b) => TOWERS[b].range));
  const spots = buildOrder(map, reach, strategy.how);
  const w = createWorld(map, seed, rules);
  const taken = new Set<number>();
  let next = 0;

  for (let i = 0; i < 600_000 && w.phase === 'playing'; i++) {
    // Step over locked stations rather than waiting on them, as a local offset
    // that does not burn cycle phase — see the same block in `sweep.ts` for both
    // what holding the cursor cost and what advancing it per tick cost.
    let skip = 0;
    while (skip < BUILD.length && w.wave.index < TOWERS[BUILD[(next + skip) % BUILD.length]!].unlockWave) {
      skip++;
    }
    if (skip === BUILD.length) {
      stepWorld(w, 1 / 60);
      w.events.length = 0;
      continue;
    }

    const want = BUILD[(next + skip) % BUILD.length]!;
    const def = TOWERS[want];
    // Support does not take tiles in rank order, and the best tiles are held
    // back for stations still locked. Shared with `sweep.ts` rather than
    // reimplemented, which is this module's whole reason for existing.
    const reserve = strategy.hold
      ? new Set(
          BUILD.filter(
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
    // Money still blocks rather than skipping: waiting to afford what the build
    // asked for is what a player does, where skipping to a cheaper station
    // would quietly rewrite the mix being measured.
    if (at >= 0 && w.money >= def.cost && w.wave.clearedThrough + 1 < stopBuyingAfter) {
      w.commands.push({ type: 'placeTower', defId: want, col: spots[at]![0], row: spots[at]![1] });
      taken.add(at);
      next += skip + 1;
    }
    stepWorld(w, 1 / 60);
    w.events.length = 0;
  }

  return {
    won: w.phase === 'won',
    cleared: w.wave.clearedThrough + 1,
    lives: w.lives,
    money: Math.floor(w.money),
  };
}

console.log('\n\x1b[1mcampaign arc\x1b[0m');
console.log('  \x1b[2mgreedy mixed build (all five stations) · real starting money · 5 seeds · no rushing\x1b[0m');
console.log(
  '  \x1b[2mfour strategies: "cluster" packs the busiest stretch, "spread" shuts the widest gap,\x1b[0m',
);
console.log(
  '  \x1b[2m"+hold" saves the best tiles for stations not yet unlocked. Best of the four is reported.\x1b[0m',
);

for (const level of CAMPAIGN) {
  // Parsing is the assertion: parseMap throws on a malformed board, and a
  // campaign that ships an unwalkable map is broken in a way no score shows.
  const map = parseMap(level.map);
  console.log(
    `\n  \x1b[1m${level.name}\x1b[0m \x1b[2m${map.cols}x${map.rows}, ` +
      `${map.routes.map((r) => `${r.id} ${r.length}t`).join(' / ')}, ${level.waves.length} waves\x1b[0m`,
  );

  for (const id of DIFFICULTY_ORDER) {
    const rules = resolveRules(level, id);
    const all = STRATEGIES.map((strategy) => {
      const rs = SEEDS.map((s) => run(map, rules, s, Infinity, strategy));
      return {
        strategy,
        wins: rs.filter((r) => r.won).length,
        lives: rs.reduce((a, r) => a + r.lives, 0) / rs.length,
        cleared: rs.reduce((a, r) => a + r.cleared, 0) / rs.length,
      };
    });
    // The board's difficulty is the *better* strategy, not the average of the
    // two — a player is allowed to pick the right one, and on a multi-lane
    // board picking it is most of the game.
    // Wins, then lives, then waves. The third key matters more than it looks:
    // when both strategies lose every seed the first two tie at zero, and
    // without it the report names whichever was tried first — on Sluice that
    // meant printing `cluster` reaching wave 8.8 while `spread`, the strategy
    // the board is built for, was reaching wave 11.
    const better = (x: { wins: number; lives: number; cleared: number }, y: typeof x): boolean =>
      x.wins !== y.wins ? x.wins > y.wins : x.lives !== y.lives ? x.lives > y.lives : x.cleared > y.cleared;
    const best = all.reduce((a, b) => (better(b, a) ? b : a));
    const { wins, lives, cleared } = best;
    // Name the runner-up too. "cluster+hold beats cluster by 6 lives" is the
    // fact about the board; "cluster+hold" alone is just a label.
    const rest = all.filter((x) => x !== best).reduce((a, b) => (better(b, a) ? b : a));

    console.log(
      `    ${DIFFICULTIES[id].name.padEnd(10)}` +
        ` won ${wins}/${SEEDS.length}` +
        `  waves ${cleared.toFixed(1).padStart(4)}/${waveCount(rules)}` +
        `  lives ${lives.toFixed(1).padStart(5)}/${rules.startingLives}` +
        `  \x1b[2m${strategyName(best.strategy)}` +
        `${best.lives === rest.lives && best.wins === rest.wins ? '' : ` beats ${strategyName(rest.strategy)}`}\x1b[0m`,
    );
  }
}

/**
 * The campaign as one continuous run, with cash carried between sectors.
 *
 * This is the harshest possible reading of the carry rule, and deliberately so:
 * the greedy builder buys whenever it can afford to, so it arrives at every
 * hand-off with close to nothing. A human who knows the bank exists will hold
 * some back — that is the decision the rule is for — so treat these numbers as
 * the floor, not the expectation.
 *
 * What matters here is whether a spend-everything player is *stranded*. Being
 * poorer is the intended cost; being unable to clear the next sector at all
 * would mean the rule needs a floor after all.
 */
const STOP_BUYING_AFTER = Number(process.env['STOP_AFTER'] ?? Infinity);

console.log('\n\x1b[1mcontinuous run — cash carried between sectors\x1b[0m');
console.log(
  `  \x1b[2mstops buying after wave ${STOP_BUYING_AFTER === Infinity ? '\u221e (never — spends to zero)' : STOP_BUYING_AFTER}\x1b[0m`,
);
console.log('  \x1b[2mgreedy builder spends to zero, so this is the worst case for banking\x1b[0m');

for (const id of DIFFICULTY_ORDER) {
  const parts: string[] = [];
  let broke = false;

  for (const seed of SEEDS.slice(0, 3)) {
    let bank: number | undefined;
    const legs: string[] = [];
    for (const level of CAMPAIGN) {
      const rules = resolveRules(level, id, bank);
      const map = parseMap(level.map);
      // Best of every strategy per leg, exactly as the per-level table above.
      // Running the whole campaign on `cluster` denied the player a choice the
      // report grants three lines earlier, and it showed: the run broke on
      // Sluice, which is a `spread+hold` board, while the same board reads 5/5
      // above. A continuous run should be the campaign a player could actually
      // have, not the campaign of someone who never changes tactics.
      const r = STRATEGIES
        .map((strategy) => run(map, rules, seed, STOP_BUYING_AFTER, strategy))
        .reduce((a, b) => (b.won !== a.won ? (b.won ? b : a) : b.money > a.money ? b : a));
      legs.push(`${r.won ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}${String(r.cleared).padStart(2)}w $${r.money}`);
      if (!r.won) { broke = true; break; }
      bank = r.money;
    }
    parts.push(legs.join('  →  '));
  }

  console.log(`  \x1b[1m${DIFFICULTIES[id].name}\x1b[0m${broke ? ' \x1b[31m(run broke)\x1b[0m' : ''}`);
  for (const line of parts) console.log(`    ${line}`);
}

console.log('');
