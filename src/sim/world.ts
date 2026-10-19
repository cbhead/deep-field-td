import { BALANCE } from '../content/balance.ts';
import { ENEMIES, type EnemyId } from '../content/enemies.ts';
import { DEFAULT_RULES, type Rules } from './rules.ts';
import type { PlannedSpawn } from './wavePlan.ts';
import type {
  Command,
  Creep,
  CreepOrigin,
  EntityId,
  MapDef,
  MatchPhase,
  Projectile,
  SimEvent,
  Tower,
  WavePhase,
} from './types.ts';

export interface WaveState {
  /** 0-based index into WAVES: the wave spawning now, or the next one due. */
  index: number;
  phase: WavePhase;
  /**
   * Counts *down* during intermission and *up* during spawning. One field
   * rather than two because the phases are mutually exclusive.
   */
  timer: number;
  plan: PlannedSpawn[];
  /** How far through `plan` the spawner has got. */
  spawned: number;

  /** Highest wave index fully spawned. -1 before the first wave. */
  dispatchedThrough: number;
  /**
   * Highest wave index with no creeps left alive. -1 before the first clear.
   *
   * Separate from `dispatchedThrough` because waves overlap — wave 4 can be
   * walking while wave 3's last straggler is still alive, so an empty board is
   * not what "cleared" means any more.
   */
  clearedThrough: number;

  /**
   * Send every wave the instant its intermission opens, without being asked.
   *
   * **Simulation state, not a preference**, which is why it lives here beside
   * the phase rather than in `UiPrefs` with the reach circles and the volume.
   * Everything in `UiPrefs` changes what is drawn; this changes what happens and
   * what money the player has, so it has to arrive through the command stream
   * like every other decision — see `Command.setAutoStart`.
   *
   * Note this is *not* "start waves automatically": waves already do that when
   * the intermission runs out. It is the rush, made standing. The bonus is paid
   * in full, so it is a real economic choice and not only a convenience — and it
   * costs the same thing a manual rush costs, which is fighting the next wave on
   * top of the one still walking.
   */
  autoStart: boolean;
}

/**
 * Counters, not rules.
 *
 * Nothing in the simulation reads these — they exist so the wave-clear, defeat
 * and victory screens can report what actually happened rather than shrugging.
 * Kept on the World rather than derived at the end because most of it is not
 * recoverable after the fact: a killed creep leaves no trace to count.
 */
export interface RunStats {
  kills: number;
  leaks: number;
  /** Cash from bounties only, excluding clear rewards and rush bonuses. */
  bounty: number;
  /** Cash spent on building and upgrading, before any sell refunds. */
  spent: number;

  /** Sorties bought and dispatched at the other player, and what they cost. */
  sortiesSent: number;
  sortieSpend: number;
  /** Kickbacks collected — sorties of yours that reached their core. */
  sortieEarned: number;
  /** Their sorties that reached yours. Counted apart from `leaks` on purpose:
   *  a wave you failed to hold and a blow somebody paid for are different
   *  failures, and a results screen that merged them would say neither. */
  sortiesTaken: number;
}

/** The same three figures, per wave, so a clear can be itemised. */
export interface WaveStats {
  kills: number;
  bounty: number;
  leaked: number;
}

/**
 * The entire game state. Plain mutable objects in flat arrays — deliberately
 * not an ECS. Three fixed archetypes and a few hundred entities do not justify
 * a component registry, query machinery, and entities that are unreadable in a
 * console.log.
 *
 * Note what is absent: no wall-clock time, no DOM handles, no render objects,
 * no notion of frame rate. `time` and `tick` advance by fixed DT only. That is
 * what lets this run headlessly in Node and produce identical results twice.
 */
export interface World {
  readonly seed: number;
  readonly map: MapDef;
  /**
   * Which arc this run is playing and how hard. Read by the spawner, the
   * splitter and every screen that reports progress — carried on the World so
   * none of them has to be told separately and then disagree.
   */
  readonly rules: Rules;

  /** Ticks elapsed. Integer, and the sim's only clock alongside `time`. */
  tick: number;
  /** Seconds of *simulated* time — `tick * DT`, never `performance.now()`. */
  time: number;

  phase: MatchPhase;
  lives: number;
  money: number;

  /**
   * How far up the era ladder this player has bought, 1..3.
   *
   * Always present, and always 1 outside versus. A field that only existed
   * when `rules.eras` was set would make every reader ask whether it is there
   * before asking what it says, and the sim has no notion of "which mode am I"
   * anywhere else. Era 1 with nothing able to advance it is exactly the
   * campaign's behaviour, so the campaign needs no branch at all.
   */
  era: number;
  /** Total sunk into advancing. Reported at the end; never read by a rule. */
  eraSpent: number;
  wave: WaveState;

  creeps: Creep[];
  towers: Tower[];
  projectiles: Projectile[];

  /**
   * Deaths that owe children, drained by `resolveSplits` once the systems that
   * iterate `w.creeps` have finished for the tick. See `damageCreep`.
   */
  pendingSplits: PendingSplit[];

  stats: RunStats;
  /** Indexed by wave. Grown lazily by `waveStats()`. */
  perWave: WaveStats[];

  /** Drained at the start of each tick. See the Command doc comment. */
  commands: Command[];
  /** Drained by the renderer once per frame. Unbounded if nobody drains it. */
  events: SimEvent[];

  nextId: EntityId;
}

export function createWorld(map: MapDef, seed: number, rules: Rules = DEFAULT_RULES): World {
  return {
    seed,
    map,
    rules,
    tick: 0,
    time: 0,
    phase: 'playing',
    lives: rules.startingLives,
    money: rules.startingMoney,
    era: 1,
    eraSpent: 0,
    wave: {
      index: 0,
      phase: 'intermission',
      timer: BALANCE.firstWaveDelay,
      plan: [],
      spawned: 0,
      dispatchedThrough: -1,
      clearedThrough: -1,
      // Off. A setting that changes the economy must be chosen, never inherited.
      autoStart: false,
    },
    creeps: [],
    towers: [],
    projectiles: [],
    pendingSplits: [],
    stats: {
      kills: 0,
      leaks: 0,
      bounty: 0,
      spent: 0,
      sortiesSent: 0,
      sortieSpend: 0,
      sortieEarned: 0,
      sortiesTaken: 0,
    },
    perWave: [],
    commands: [],
    events: [],
    nextId: 1,
  };
}

/** The stats bucket for a wave, created on first touch. */
export function waveStats(w: World, wave: number): WaveStats {
  let s = w.perWave[wave];
  if (s === undefined) {
    s = { kills: 0, bounty: 0, leaked: 0 };
    w.perWave[wave] = s;
  }
  return s;
}

export function towerById(w: World, id: EntityId): Tower | undefined {
  for (const t of w.towers) if (t.id === id) return t;
  return undefined;
}

export interface PendingSplit {
  readonly parent: Creep;
  readonly into: EnemyId;
  readonly count: number;
}

/**
 * Everything a spawn may override. An options bag rather than five positional
 * arguments, because `spawnCreep(w, 'mote', 7, 2, 3, 0, at)` is unreadable and
 * one transposed pair would be a silent balance bug.
 */
export interface SpawnOptions {
  hp?: number;
  bounty?: number;
  shield?: number;
  /**
   * Lives this costs if it lands. Defaults to the def's 1; the sortie table is
   * the only caller that overrides it.
   */
  leakDamage?: number;
  wave?: number;
  /**
   * Defaults to `'wave'`, which is what every caller that predates sorties
   * wants and is why none of them had to change.
   */
  origin?: CreepOrigin;
  /**
   * What this pays its sender if it lands. Defaults to 0, which is what every
   * wave contact is worth to nobody.
   */
  kickback?: number;
  /**
   * Which lane to walk, as an index into `map.routes`. Defaults to the first,
   * which on a one-route board is the only one.
   *
   * Ignored when `at` is given: a split inherits its parent's lane, and the
   * lane is part of where the parent was standing.
   */
  route?: number;
  /**
   * Start partway along a lane instead of at its entry.
   *
   * Used by splits: children appear where the parent died, not back at the
   * spawn. Without this a Cluster killed at the goal would hand the player
   * three fresh Motes with the whole route to walk, which is a reward.
   */
  at?: { x: number; y: number; route: number; leg: number; progress: number };
}

export function spawnCreep(w: World, defId: EnemyId, opts: SpawnOptions = {}): Creep {
  const def = ENEMIES[defId];
  const route = opts.at?.route ?? opts.route ?? 0;
  const lane = w.map.routes[route];
  if (lane === undefined) throw new Error(`spawn on route ${route}, which this map does not have`);

  const start = opts.at ?? { ...lane.waypoints[0]!, leg: 1, progress: 0 };
  const health = opts.hp ?? def.hp;
  const shield = opts.shield ?? def.shield;

  const creep: Creep = {
    id: w.nextId++,
    defId,
    x: start.x,
    y: start.y,
    route,
    // waypoints[0] is the off-board entry the creep is standing on, so the
    // first leg is walking toward waypoints[1].
    leg: start.leg,
    progress: start.progress,
    speed: def.speed,
    slowTimer: 0,
    slowFactor: 1,
    slowMax: 0,
    hp: health,
    maxHp: health,
    shield,
    maxShield: shield,
    shieldTimer: 0,
    shieldLock: 0,
    shred: 0,
    shredTimer: 0,
    burnTimer: 0,
    burnDamage: 0,
    burnTick: 0,
    burnSource: null,
    knockTimer: 0,
    bounty: opts.bounty ?? def.bounty,
    leakDamage: opts.leakDamage ?? def.leakDamage,
    wave: opts.wave ?? w.wave.index,
    origin: opts.origin ?? 'wave',
    kickback: opts.kickback ?? 0,
    dead: false,
  };
  w.creeps.push(creep);
  return creep;
}
