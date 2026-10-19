/**
 * Bank floor sweep. `npm run bankfloor`.
 *
 * `BANK_FLOOR` was chosen while it was also, by accident, the opening budget of
 * every fresh run — an absent `?bank` parsed as `0`, so the floor set the money
 * on the first board of every campaign. It was picked at 0.6 because that was a
 * playable *start*, which is not the question it is actually meant to answer.
 * With the parse fixed the floor does one job and only one: decide what a
 * player who arrives at a sector poor gets handed.
 *
 * That job has a failure mode at each end, and a single number has to sit
 * between them:
 *
 * - **Too low is a dead end.** Below the cheapest station the player owns
 *   nothing, can buy nothing, and therefore earns no bounty. The sector cannot
 *   be played rather than being hard. This is the failure the floor was added
 *   for and it is the easy half to see.
 * - **Too high is a subsidy.** If arriving broke gets you most of a normal
 *   opening anyway, then spending to zero costs nothing and the decision the
 *   carry rule exists to create — hold cash back, or convert it to towers now —
 *   is not a decision. The mechanic is still in the code and no longer in the
 *   game.
 *
 * So it measures two things at each candidate floor.
 *
 * **Does it strand?** The whole arc played continuously by a greedy builder
 * that buys whenever it can afford to, and so arrives at every hand-off with
 * close to nothing. This is the worst realistic reader of a rule about saving
 * and it is what finds the dead end.
 *
 * **Does arriving poor still cost you?** The same sector played twice — once
 * opening on the floor, once opening on a healthy carry — and the difference
 * between them. This is the sentence the `BANK_FLOOR` comment already claims
 * ("arriving poor still costs you") stated as a number instead of a hope. If
 * the two columns converge, the floor has stopped being a floor and become the
 * opening budget again, which is the bug this file was written after.
 *
 * An earlier draft tried to model the other half as a *saver* — a builder that
 * stopped buying two waves out and banked the difference. It was discarded and
 * is worth recording as a dead end: stopping early does not model holding cash
 * back, it models not defending the hardest waves, and the saver lost sector
 * one on Standard at every floor including 1.0. It measured the handicap, not
 * the saving. Comparing a poor opening against a rich one needs no builder
 * policy at all, which is why this version does that instead.
 *
 * Two blind spots, both of which change how far the output can be pushed.
 *
 * The builder only spreads. It never upgrades and never holds cash back, so
 * every absolute figure here is a floor rather than a forecast — a human who
 * upgrades will clear boards this says are unwinnable. Read the *gaps* between
 * rows, which is the part the builder's weakness does not move.
 *
 * And the arc column is blank for Blackout, in the sense that it reads 0/15 at
 * every floor. That tier cannot clear sector one under this builder at any
 * money — `tools/campaign.ts` shows the same thing — so the run never reaches a
 * hand-off and the floor is never exercised. Blackout's rows therefore rest
 * entirely on the synthetic poor-vs-rich comparison, which injects a bank into
 * sectors two and three directly. That is a weaker form of evidence than the
 * other two tiers get and any Blackout conclusion should be hedged accordingly.
 *
 * Deliberately not a gate, like `sweep.ts` and `campaign.ts`: it reports
 * numbers a human has to judge.
 */
import { CAMPAIGN } from '../src/content/levels.ts';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../src/content/difficulty.ts';
import { TOWERS, type TowerId } from '../src/content/towers.ts';
import { parseMap } from '../src/sim/util/grid.ts';
import type { MapDef } from '../src/sim/types.ts';
import { createWorld } from '../src/sim/world.ts';
import { resolveRules, type Rules } from '../src/sim/rules.ts';
import { stepWorld } from '../src/sim/step.ts';

/** Same tile ranking as the other two probes, so all three rate a board alike. */
function rankedSpots(map: MapDef, range: number): [number, number][] {
  const scored: { col: number; row: number; covered: number }[] = [];
  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      if (map.tiles[row * map.cols + col] !== 'ground') continue;
      let covered = 0;
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          if (map.tiles[r * map.cols + c] !== 'path') continue;
          const dx = c - col;
          const dy = r - row;
          if (dx * dx + dy * dy <= range * range) covered++;
        }
      }
      scored.push({ col, row, covered });
    }
  }
  scored.sort((a, b) => b.covered - a.covered || a.col - b.col || a.row - b.row);
  return scored.map((s) => [s.col, s.row] as [number, number]);
}

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

/**
 * The other probes use five seeds. This one needs more, and the reason is worth
 * writing down: a floor is an *opening* change, and an opening change moves
 * every placement and every bounty after it, so the arc column is chaotic in a
 * way a per-wave tweak is not. At five seeds a flat $180 scored *worse* than
 * $170 on Standard — more money cannot actually be worse, so that was one seed
 * flipping and nothing else. `SEEDS=N` sets the count; the pool is fixed so a
 * given N is always the same N.
 */
const SEED_POOL = [
  4242, 7, 999, 31337, 12345, 88, 60613, 1, 2718, 31415, 5150, 90210, 8675309, 424242, 13, 777,
];
const SEEDS = SEED_POOL.slice(0, Number(process.env['SEEDS'] ?? 5));

/** The cheapest thing a player can own. Below this a sector cannot be started. */
const CHEAPEST = Math.min(...BUILD.map((b) => TOWERS[b].cost));

interface Result {
  won: boolean;
  cleared: number;
  lives: number;
  money: number;
  towers: number;
}

function run(map: MapDef, rules: Rules, seed: number, stopBuyingAfter = Infinity): Result {
  const spots = rankedSpots(map, Math.max(...BUILD.map((b) => TOWERS[b].range)));
  const w = createWorld(map, seed, rules);
  let next = 0;

  for (let i = 0; i < 600_000 && w.phase === 'playing'; i++) {
    const want = BUILD[next % BUILD.length]!;
    if (
      next < spots.length &&
      w.money >= TOWERS[want].cost &&
      w.wave.index >= TOWERS[want].unlockWave &&
      w.wave.clearedThrough + 1 < stopBuyingAfter
    ) {
      w.commands.push({ type: 'placeTower', defId: want, col: spots[next]![0], row: spots[next]![1] });
      next++;
    }
    stepWorld(w, 1 / 60);
    w.events.length = 0;
  }

  return {
    won: w.phase === 'won',
    cleared: w.wave.clearedThrough + 1,
    lives: w.lives,
    money: Math.floor(w.money),
    towers: w.towers.length,
  };
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

interface ArcResult {
  /** Sectors cleared, summed over seeds. Max is `SEEDS.length * CAMPAIGN.length`. */
  sectors: number;
  /** Hand-offs where the arriving bank was below the floor, so the floor paid. */
  engaged: number;
  /** Hand-offs that happened at all — the denominator for `engaged`. */
  handoffs: number;
  /** Hand-offs arriving under the cheapest station. Stranded, with no floor. */
  destitute: number;
}

/**
 * The whole campaign, continuously, by a builder that spends to zero.
 *
 * The first leg never touches the floor — nothing has been carried into it yet
 * — so every floor shares an identical opening sector. That is the control:
 * any divergence between rows is the floor and nothing else.
 */
function arc(id: DifficultyId, floor: number): ArcResult {
  let sectors = 0;
  let engaged = 0;
  let handoffs = 0;
  let destitute = 0;

  for (const seed of SEEDS) {
    let bank: number | undefined;
    for (const level of CAMPAIGN) {
      const rules = resolveRules(level, id, bank, floor);

      if (bank !== undefined) {
        handoffs++;
        if (bank < Math.round(DIFFICULTIES[id].startingMoney * floor)) engaged++;
        if (bank < CHEAPEST) destitute++;
      }

      const r = run(parseMap(level.map), rules, seed);
      if (!r.won) break;

      sectors++;
      bank = r.money;
    }
  }

  return { sectors, engaged, handoffs, destitute };
}

/**
 * What a given opening is worth on the sectors a bank can actually arrive at.
 *
 * Sector one is excluded because nothing is ever carried into it — including it
 * would dilute every row with a board the floor cannot touch. `money` is passed
 * as an already-decided opening rather than as a bank, so the floor does not
 * get a second chance to raise it.
 */
function openingWorth(id: DifficultyId, money: number): { wins: number; runs: number; lives: number } {
  const lives: number[] = [];
  let wins = 0;
  let runs = 0;

  for (const level of CAMPAIGN.slice(1)) {
    for (const seed of SEEDS) {
      // Floor 0 means `Math.max(money, 0)` — the opening passes through exactly.
      const rules = resolveRules(level, id, money, 0);
      const r = run(parseMap(level.map), rules, seed);
      runs++;
      if (r.won) wins++;
      lives.push(r.lives);
    }
  }

  return { wins, runs, lives: mean(lives) };
}

/**
 * Candidates. 0 is the no-floor control — the state the rule was in before the
 * floor was added, kept in the table so the dead end stays visible rather than
 * being a claim in a comment.
 */
const FLOORS = (process.env['FLOORS'] ?? '0,0.3,0.45,0.6,0.75,1.0')
  .split(',')
  .map((s) => Number(s.trim()));

/**
 * `ABS=155,170,185` sweeps flat dollar floors instead of fractions.
 *
 * Worth having as a mode rather than a separate script because the fraction is
 * itself one of the things under test. A fraction ties the safety net to the
 * tier's own generosity, and there is no reason to assume those move together —
 * if they move *opposite*, no single fraction can serve every tier and the
 * shape of the constant is the finding, not its value.
 */
const ABSOLUTE = process.env['ABS']?.split(',').map((s) => Number(s.trim()));

interface Candidate {
  label: (tierMoney: number) => string;
  floorFor: (tierMoney: number) => number;
}

const CANDIDATES: Candidate[] =
  ABSOLUTE !== undefined
    ? ABSOLUTE.map((amount) => ({
        label: (m: number) => `$${String(amount).padStart(3)} =${(amount / m).toFixed(2)}`,
        floorFor: (m: number) => amount / m,
      }))
    : FLOORS.map((f) => ({
        label: (m: number) => `${f.toFixed(2)} $${String(Math.round(m * f)).padStart(3)}`,
        floorFor: () => f,
      }));

const MAX_SECTORS = SEEDS.length * CAMPAIGN.length;

console.log('\n\x1b[1mbank floor sweep\x1b[0m');
console.log(
  `  \x1b[2m${CAMPAIGN.length} sectors x ${SEEDS.length} seeds, cash carried between them\x1b[0m`,
);
console.log(`  \x1b[2mcheapest station is $${CHEAPEST}; a bank below that cannot open a sector\x1b[0m`);

for (const id of DIFFICULTY_ORDER) {
  const tierMoney = DIFFICULTIES[id].startingMoney;

  // The reference: a player who arrives having neither gained nor lost ground.
  // Independent of the floor, so it is computed once and every row is read
  // against it.
  const rich = openingWorth(id, tierMoney);

  console.log(`\n  \x1b[1m${DIFFICULTIES[id].name}\x1b[0m \x1b[2m(tier start $${tierMoney})\x1b[0m`);
  console.log(
    `    \x1b[2marriving with a full $${tierMoney}: won ${rich.wins}/${rich.runs}, ` +
      `${rich.lives.toFixed(1)} lives kept\x1b[0m`,
  );
  console.log(
    `    \x1b[2mfloor          arc          arriving on the floor    poverty costs\x1b[0m`,
  );

  for (const candidate of CANDIDATES) {
    const floor = candidate.floorFor(tierMoney);
    const amount = Math.round(tierMoney * floor);
    const a = arc(id, floor);
    const poor = openingWorth(id, amount);

    // Two independent readings, and the floor has to satisfy both. A floor that
    // strands is a dead end; a floor whose poor column has caught up with the
    // rich one has quietly become the opening budget.
    //
    // The threshold is deliberately not `< MAX_SECTORS`. An opening change
    // moves every placement after it, so the arc count is chaotic: at sixteen
    // seeds a flat $180 scored 44/48 while both $170 and $188 scored 48/48, and
    // more money cannot really be worse. That is a noise band of roughly ±4,
    // and a verdict that fired on a single lost sector would report it as a
    // finding. Only a clear drop counts, which the genuinely bad floors show —
    // 0.60 on Standard lands at 38/48, well outside the band.
    const strands = a.destitute > 0 && a.sectors < MAX_SECTORS * 0.9;
    const livesCost = rich.lives - poor.lives;
    const winCost = rich.wins - poor.wins;

    const verdict = strands
      ? '\x1b[31mstrands the arc\x1b[0m'
      : winCost === 0 && livesCost < 1
        ? '\x1b[33mnothing — floor is the opening\x1b[0m'
        : `\x1b[32m-${winCost} wins, -${livesCost.toFixed(1)} lives\x1b[0m`;

    const caught = a.handoffs === 0 ? ' n/a' : `${a.engaged}/${a.handoffs}`;

    console.log(
      `    ${candidate.label(tierMoney)}` +
        `   ${String(a.sectors).padStart(2)}/${MAX_SECTORS}` +
        `      won ${String(poor.wins).padStart(2)}/${poor.runs} ${poor.lives.toFixed(1).padStart(4)}l` +
        `       ${verdict}` +
        `  \x1b[2mfloor caught ${caught}\x1b[0m`,
    );
  }
}

console.log('');
