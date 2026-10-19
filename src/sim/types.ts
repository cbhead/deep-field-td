/**
 * Runtime simulation types.
 *
 * Everything positional here is in TILES as floats — `creep.x = 12.37` means
 * "just past the middle of column 12". The renderer is the only thing that
 * knows about pixels, so `speed: 1.8` reads as 1.8 tiles/sec and changing the
 * tile size never touches gameplay or balance.
 */

import type { EnemyId } from '../content/enemies.ts';
import type { SortieId } from '../content/sorties.ts';
import type { TowerId } from '../content/towers.ts';
import type { TowerStats } from '../content/types.ts';

export interface Vec2 {
  x: number;
  y: number;
}

export type TileKind =
  /** Buildable. The only kind a tower may occupy. */
  | 'ground'
  /** Creeps walk here. Not buildable. */
  | 'path'
  /** Scenery. Not buildable, not walkable. */
  | 'blocked';

/** A parsed, validated map. Produced by `parseMap()`; never authored by hand. */
export interface MapDef {
  readonly id: string;
  readonly name: string;
  readonly cols: number;
  readonly rows: number;

  /** Row-major, length `cols * rows`. Index with `tileIndex()`. */
  readonly tiles: readonly TileKind[];

  /**
   * The lanes, in authoring order. `Creep.route` indexes this.
   *
   * At least one. Lanes may share tiles — that is what a merge is — so the
   * union of them is the road, and no single one of them is.
   */
  readonly routes: readonly MapRoute[];

  /** Centre of the goal tile. A creep reaching it costs a life. */
  readonly goal: Vec2;
}

/** One parsed lane. */
export interface MapRoute {
  /** The authoring id, carried through so errors and tools can name a lane. */
  readonly id: string;

  /**
   * The lane in sim space — tile *centres*, so tile (0,2) is (0.5, 2.5).
   * Creeps interpolate between consecutive entries.
   *
   * `waypoints[0]` is the off-board entry, one tile outside the board, so
   * contacts walk on-screen rather than popping into existence on the edge
   * tile. Every lane carries its own, because lanes may enter from different
   * spawns.
   */
  readonly waypoints: readonly Vec2[];

  /** Length in tiles, entry included. Used for progress and for pacing waves. */
  readonly length: number;
}

export type EntityId = number;

export interface Creep {
  readonly id: EntityId;
  readonly defId: EnemyId;

  /** Position in tiles. */
  x: number;
  y: number;

  /**
   * Which lane this contact walks — an index into `MapDef.routes`, never an id.
   *
   * An index because the sim is on the hot path and should not be hashing
   * strings once per creep per tick. The id lives on `MapRoute` for anything
   * that has to *name* a lane, which is authoring and tooling, not movement.
   */
  readonly route: number;

  /** Index of the waypoint currently being walked *toward*, within its lane. */
  leg: number;

  /**
   * Tiles travelled along its own lane. Targeting compares this, and comparing
   * it is exact where comparing positions is not.
   *
   * Only comparable *across* lanes once it is turned into distance remaining —
   * see `score()` in `systems/targeting.ts`. Two lanes of different lengths
   * make raw progress mean different things, and Sluice makes them differ by
   * 2.5 : 1 on purpose.
   */
  progress: number;

  /** Base speed in tiles/sec. Never mutated — see `slowTimer`. */
  speed: number;
  /**
   * Seconds of gravitational slow remaining, and the multiplier while it lasts.
   *
   * Kept separate from `speed` rather than scaling it in place: a slow that
   * mutated the base could never expire cleanly, and two overlapping wells
   * would compound into a permanent crawl. Movement reads an *effective* speed
   * from these; the strongest active slow wins and a re-hit refreshes the timer
   * rather than stacking.
   */
  slowTimer: number;
  slowFactor: number;
  /**
   * What `slowTimer` started at, so the renderer can show how much of the slow
   * is *left* rather than merely that there is one.
   *
   * Carried on the contact rather than looked up from the station that applied
   * it, because that station can be sold, upgraded or outranged before the slow
   * expires — and the ring has to keep counting down truthfully regardless.
   */
  slowMax: number;
  hp: number;
  maxHp: number;

  /**
   * Overshield, absorbed before hull, and the countdown until it regenerates.
   *
   * `shieldTimer` counts *down* from the def's delay and is reset by any hit,
   * so sustained fire holds a shield at zero while a lull hands it back. That
   * is what makes a Warden a test of coverage rather than of raw damage.
   */
  shield: number;
  maxShield: number;
  shieldTimer: number;

  /**
   * A second, longer hold on shield regeneration, set by a shield-breaker.
   *
   * Distinct from `shieldTimer`, which every hit resets: that one suppresses
   * regen *while you keep firing*, this one suppresses it because something
   * broke. Checked ahead of `shieldTimer` in `updateStatuses`.
   */
  shieldLock: number;

  /**
   * Armour currently stripped off this contact, and the countdown until it
   * grows back.
   *
   * Accumulates across hits up to the stripping shot's own ceiling, unlike the
   * slow, which refreshes to a fixed strength. Read by `damageCreep` as a
   * subtraction from the def's `armor` — it is an input to the one damage
   * funnel, never a second one.
   */
  shred: number;
  shredTimer: number;

  /**
   * An active burn: seconds left, damage per tick, and the countdown to the next
   * tick.
   *
   * `burnTick` exists because the burn deliberately does *not* run at frame
   * rate — see `TowerDef.burnDamage`. Refreshed and upgraded to the higher
   * damage on a re-hit, never stacked.
   */
  burnTimer: number;
  burnDamage: number;
  burnTick: number;

  /**
   * Which station lit this, for the inspector's per-tower attribution.
   *
   * An id rather than a reference, the same choice `Tower.focusId` makes: the
   * station can be sold before the burn expires, and a held reference would keep
   * a dead tower alive and credit damage to something no longer on the board.
   * `null` when the source is gone or was never known — attribution is never
   * load-bearing, so nothing about the outcome changes.
   */
  burnSource: EntityId | null;

  /**
   * Seconds until this contact can be shoved again.
   *
   * Not optional and not a nicety: without a per-contact immunity window, two
   * shoving stations covering one corner hold a contact in place forever.
   */
  knockTimer: number;

  /** Money paid on kill. Baked in at spawn, since it scales per wave. */
  bounty: number;

  /**
   * Lives taken if this reaches the goal. Baked in at spawn exactly like
   * `bounty`, and for the same reason: it is a property of *this* contact, not
   * of its type. Every wave contact carries its def's 1; a sortie carries what
   * the sortie table charged for it, so the same silhouette can be scenery the
   * arc handed you or a purchase someone made against you.
   */
  readonly leakDamage: number;

  /**
   * Which wave this creep belongs to. Because waves overlap, "wave 3 is
   * cleared" cannot be inferred from an empty board — creeps from wave 4 may
   * already be walking. This tag is what keeps clear-rewards and victory exact.
   *
   * Meaningless on a `'sortie'`, which belongs to no wave. Read `origin` first.
   */
  readonly wave: number;

  /**
   * Where this contact came from, and the reason wave settlement is still
   * correct once a second source starts putting contacts on the board.
   *
   * `settleClearedWaves` works from the lowest wave still alive, so anything it
   * counts can hold a wave open. A sortie tagged with the current wave — which
   * is what `spawnCreep` would default it to — would do exactly that: one slow
   * Monolith sent by an opponent would stall the clear reward and freeze
   * `clearedThrough` for as long as it walked, and `clearedThrough` is what the
   * Race status pump reports. Settlement, the per-wave tally and the victory
   * check therefore all skip `'sortie'`, and this flag is how they know.
   */
  readonly origin: CreepOrigin;

  /**
   * What reaching the core pays back to whoever *sent* this. 0 on everything
   * the wave machine dispatched.
   *
   * Carried on the contact rather than recomputed when it lands, because the
   * kickback is a fraction of what the sender actually paid and a Monolith
   * walks for the better part of a minute — re-deriving it on arrival would
   * price it against a board two waves further on than the one it was bought
   * for. Baked at spawn, exactly like `bounty` and for the same reason.
   *
   * This world never credits it to itself. It rides out on a `sortieLanded`
   * event for the sender's client to collect; see `Command.creditSortie`.
   */
  readonly kickback: number;

  /** Set during the tick; the cleanup phase removes it from the array. */
  dead: boolean;
}

/**
 * Whether a contact was dispatched by the wave machine or sent by an opponent.
 *
 * Two values rather than a boolean because the third case — a neutral contact
 * that belongs to neither side — is a real possibility for the versus board's
 * midfield spawn, and `origin === 'wave'` reads correctly whichever way that
 * goes while `!isSortie` would not.
 */
export type CreepOrigin = 'wave' | 'sortie';

/**
 * Which creep a tower shoots when several are in reach.
 *
 * `first` is the default and the only one that is right by default: the creep
 * furthest along the route is the one closest to costing a life. The others
 * exist because the right answer changes with what a tower is *for* — a Nova
 * covering a corner wants `strong`, a Singularity trimming stragglers wants
 * `last`.
 */
export type TargetMode = 'first' | 'last' | 'strong' | 'close';

export const TARGET_MODES: readonly TargetMode[] = ['first', 'last', 'strong', 'close'];

/**
 * The three upgrade tracks every station carries, each tiered independently.
 *
 * `damage` and `range` are shared dials (`BALANCE.upgrade`); `effect` deepens
 * whatever the station's identity is, per `TowerDef.effectUpgrade`. Three
 * separate tracks rather than one ladder because "hit harder", "reach further"
 * and "do the thing more" answer different problems, and a single ladder
 * collapses them into one spend button.
 */
export type UpgradePath = 'damage' | 'range' | 'effect';

export const UPGRADE_PATHS: readonly UpgradePath[] = ['damage', 'range', 'effect'];

/** Per-path tier, all 1-based like the old single tier. Mk I is 1 everywhere. */
export type TowerTiers = Record<UpgradePath, number>;

export interface Tower {
  readonly id: EntityId;
  readonly defId: TowerId;

  /** Towers are tile-aligned, so the tile is the identity and x/y is derived. */
  readonly col: number;
  readonly row: number;
  /** Tile centre, cached because targeting reads it every tick. */
  readonly x: number;
  readonly y: number;

  /** Tier per upgrade path; `BALANCE.upgrade.maxTier` caps each independently. */
  tiers: TowerTiers;

  /**
   * Effective combat numbers for the current tiers.
   *
   * Recomputed and **replaced wholesale** by `upgradeTower` — never mutated in
   * place. Projectiles hold a reference to the object they were fired with, so
   * replacement is what makes that reference a true snapshot: a shot in flight
   * lands with the stats of the station that fired it, even if the station is
   * upgraded or sold before impact.
   */
  stats: TowerStats;

  /**
   * Shots per second added by support stations in reach. `0` for a station
   * nothing is feeding, which is most of them.
   *
   * Separate from `stats` rather than folded into it, and that separation is
   * load-bearing: `stats` is the object projectiles hold as their snapshot, so
   * writing a buff into it would retroactively change shots already in the air.
   *
   * Cached rather than derived per tick, because the only things that can move
   * it are building, selling and upgrading — all three of which live in
   * `sim/build.ts` and all three of which call `refreshBuffs`. Deriving it in
   * the fire loop would be an O(towers²) scan every tick to answer a question
   * whose answer changes a handful of times a match.
   */
  buffShots: number;

  targeting: TargetMode;

  /** Seconds until this tower may fire again. */
  cooldown: number;

  /**
   * Which contact this station is currently spun up on, and for how long.
   *
   * Only a ramping station reads these, but every station carries them so the
   * shape of a Tower does not depend on which one it is — the alternative is a
   * union, and a union here would spread `defId` checks through targeting,
   * build and the inspector alike.
   *
   * `focusId` is an id rather than a reference on purpose: it is compared, never
   * dereferenced, and holding a dead contact alive to answer "is this still the
   * same target" would be a leak with no upside.
   */
  focusId: EntityId | null;
  focusTime: number;

  /** Total money sunk in, including upgrades. The sell refund is a cut of this. */
  spent: number;

  /** Lifetime attribution, for the inspector. Presentation only — no rule reads them. */
  kills: number;
  damageDealt: number;
}

export interface Projectile {
  readonly id: EntityId;
  readonly defId: TowerId;
  /**
   * Who fired it. An id rather than a reference because the tower can be sold
   * mid-flight, and attribution to a tower that no longer exists should simply
   * find nothing rather than resurrect it.
   */
  readonly towerId: EntityId;

  /**
   * The firing station's stats at the moment of firing. Impact behaviour
   * (splash, chain, slow, pierce budget) reads these rather than the static
   * def, which is what lets upgrades change a station's effects — and because
   * `upgradeTower` replaces the station's stats object instead of mutating it,
   * this reference is a snapshot that survives the station being sold.
   */
  readonly stats: TowerStats;

  x: number;
  y: number;

  /**
   * Contacts this shot may still pass through, and the ids it has already
   * damaged so it cannot hit the same one twice.
   *
   * A piercing shot flies *straight* — see `stepProjectiles`. One that homed
   * would curve back into a contact it had just passed, which is why the
   * branch is on flight behaviour rather than on damage.
   */
  pierce: number;
  readonly hits: EntityId[];

  /**
   * Where this shot was fired from. Only meaningful for a piercing shot, which
   * is drawn as the whole line it has crossed rather than as a dot with a stub
   * of tail — pierce is a mechanic you pay a premium for and could not
   * previously see working.
   */
  readonly ox: number;
  readonly oy: number;

  /**
   * A direct reference, not an id.
   *
   * An id would mean an O(creeps) lookup per projectile per tick, which is
   * worse than the targeting scan it was meant to avoid. Holding the object is
   * safe: `cleanup` removes it from the array but the reference keeps it alive,
   * and `dead` is what we actually check.
   */
  readonly target: Creep;

  /** Last known target position, so a shot at a creep that dies still lands. */
  tx: number;
  ty: number;

  speed: number;
  damage: number;
  /** Seconds in flight, for the runaway guard. */
  age: number;
  dead: boolean;
}

/**
 * Player intent. Nothing outside the sim mutates the world directly — a click
 * pushes a Command, and `applyCommands` drains the queue as the first phase of
 * the tick. Actions therefore land on exact tick boundaries, validation lives in
 * one place, and this is precisely the seam a replay or a netcode layer needs.
 */
export type Command =
  /** Send the next wave now, forfeiting the rest of the intermission. */
  | { type: 'startWave' }
  /**
   * Arm or disarm sending every wave the moment its intermission opens.
   *
   * A command rather than a UI preference because it changes the simulation and
   * the player's money, not the picture. Routing it here is what keeps the world
   * a pure function of (seed, commands) — a replay that did not know the setting
   * had been armed would diverge on the very first intermission.
   */
  | { type: 'setAutoStart'; on: boolean }
  | { type: 'placeTower'; defId: TowerId; col: number; row: number }
  | { type: 'upgradeTower'; id: EntityId; path: UpgradePath }
  | { type: 'sellTower'; id: EntityId }
  | { type: 'setTargeting'; id: EntityId; mode: TargetMode }
  /** Debug scaffolding: drop a single creep on the path. */
  | { type: 'spawnDebugCreep' }
  /**
   * Buy the next era. Versus only — `advanceEraError` refuses it outright when
   * `Rules.eras` is unset, rather than the command silently doing nothing.
   *
   * A command like any other, so it drains through `applyCommands` as phase one
   * of the tick and is re-validated there: the money may be gone between the
   * click and the tick, which on this purchase is not a hypothetical — it is
   * the largest single spend in the mode and the wave spawning underneath it
   * is what makes it expensive.
   */
  | { type: 'advanceEra' }
  /**
   * Send a contact at the other player, down a lane of your choosing.
   *
   * Charges *this* world and produces a `sortieLaunched` event. It puts nothing
   * on this board — what crosses to the opponent is the caller's business, and
   * in a local loopback the caller feeds the event straight back as `inbound`.
   */
  | { type: 'sortie'; sortie: SortieId; lane: number }
  /**
   * A sortie arriving from the other player. Spawns at midfield on their lane.
   *
   * Deliberately a separate command from `sortie` rather than a flag on it.
   * One charges and one spawns, they run in different worlds, and collapsing
   * them would give the sim a notion of which side of the wire it is on.
   */
  | { type: 'inbound'; sortie: SortieId; lane: number; kickback: number }
  /** Your sortie reached their core. Pays the kickback it carried out. */
  | { type: 'creditSortie'; amount: number };

/**
 * Why a tower may not go on a tile. `null` means it may.
 *
 * A reason rather than a boolean, because the placement ghost is the highest
 * value UI in the game and "you can't" is much worse feedback than "not on the
 * road" or "you can't afford that".
 */
export type PlacementError =
  | 'offBoard'
  /**
   * Split from a single `notBuildable` because the ghost names the reason at
   * the cursor, and "on the route" and "that's scenery" are different pieces of
   * advice — one says move off the road, the other says this tile never works.
   */
  | 'onRoute'
  | 'blocked'
  | 'occupied'
  | 'tooPoor'
  /** The type exists but has not been unlocked at this wave yet. */
  | 'locked';

/** Why an upgrade or sell was refused. `null` means it went through. */
/**
 * `noSuchPath` is distinct from `maxTier` on purpose. A station with no damage
 * has no damage track at all, which is a different sentence from "you have
 * bought all of it" — and the inspector acts on the difference, omitting the
 * button rather than showing it spent.
 */
export type TowerActionError = 'noSuchTower' | 'maxTier' | 'noSuchPath' | 'tooPoor';

/**
 * Why an era advance was refused.
 *
 * `noEras` is not dead code and not defensive padding: it is what a campaign or
 * Race world answers, and having it means the command is *refused out loud* on
 * a board that has no ladder rather than being quietly dropped. Same posture as
 * `waveRejected` — a control that does nothing and says nothing reads as broken.
 */
export type EraError = 'tooPoor' | 'maxEra' | 'noEras';

/**
 * Why a sortie was refused.
 *
 * `noSorties` is the campaign and Race answering, for the same reason
 * `EraError` has `noEras`: a board with no sortie deck refuses out loud rather
 * than dropping the command on the floor.
 */
export type SortieError = 'tooPoor' | 'locked' | 'noSuchLane' | 'noSorties';

/**
 * Discrete instants, pushed by the sim and drained by the renderer once per
 * frame. Continuous state (positions, hp fractions) is *pulled* instead — it is
 * idempotent, so a dropped frame costs nothing. An event is a thing that
 * happened at a moment, and if the renderer misses it the effect never plays.
 */
export type SimEvent =
  /**
   * `cost` is lives actually taken — see `Creep.leakDamage`. Usually 1.
   *
   * `bought` marks a leak somebody *paid for*. Carried here rather than
   * inferred from the `sortieLanded` that follows in the same tick, because a
   * consumer that had to correlate two events would be depending on the order
   * they are pushed in — and the renderer and the mixer both drain forward,
   * once, with no lookahead.
   */
  | { type: 'creepLeaked'; x: number; y: number; cost: number; bought: boolean }
  | { type: 'waveStarted'; wave: number; count: number }
  /**
   * Every landed hit, not just fatal ones — this is what floating damage
   * numbers and hit flashes are drawn from. It is the highest-frequency event
   * in the game (~50/sec at full board), so the renderer caps how many it will
   * turn into effects rather than the sim deciding for it.
   */
  | {
      type: 'creepDamaged';
      /**
       * Which contact was hit. Carried so the renderer can flash exactly the
       * right sprite — without it the only option is matching by proximity,
       * which lights the wrong contact when two overlap and drops the effect
       * entirely after a hitch moves them further than the match radius.
       */
      id: EntityId;
      x: number;
      y: number;
      amount: number;
      /**
       * How much of `amount` the overshield ate.
       *
       * Split out because "my stations are firing and it will not die" has two
       * completely different causes — no damage, or all of it landing on a
       * shield that regenerates — and the floating numbers could not tell them
       * apart. A Warden soaking a volley now reads as a wall of shield-coloured
       * numbers instead of looking like stations doing nothing.
       */
      toShield: number;
      defId: TowerId | null;
    }
  /**
   * A station took a shot.
   *
   * Added for audio, and it is the one combat event with no visual counterpart:
   * tracers are *pulled* from `w.projectiles` every frame, which works for a
   * thing that persists but not for a thing that happens. A muzzle report is an
   * instant, and an instant the renderer misses is a sound that never plays.
   *
   * Carries no target and no damage on purpose. Everything downstream of a shot
   * already has its own event — `blast` for the detonation, `creepDamaged` for
   * the landing — so this one stays the cheapest possible record of the trigger
   * being pulled. It is also the highest-frequency event the sim emits after
   * `creepDamaged`, so consumers are expected to coalesce it rather than treat
   * each one as worth a response.
   */
  | { type: 'towerFired'; defId: TowerId; x: number; y: number }
  /**
   * A detonation, emitted whether or not it caught anything.
   *
   * Carries the radius so the ring drawn is the blast that actually happened —
   * the alternative is the renderer looking the station's splash up itself,
   * which would quietly start lying the moment splash varies by tier.
   */
  | { type: 'blast'; x: number; y: number; radius: number; defId: TowerId }
  | { type: 'creepKilled'; x: number; y: number; bounty: number; defId: EnemyId }
  /** A contact broke apart. Carries the children's type so the burst matches. */
  | { type: 'creepSplit'; x: number; y: number; into: EnemyId; count: number }
  | { type: 'shieldBroke'; x: number; y: number }
  | { type: 'waveRushed'; wave: number; bonus: number; secondsSaved: number }
  /** A startWave that could not be honoured. Silence would read as a bug. */
  | { type: 'waveRejected'; reason: 'spawning' | 'done' }
  /**
   * Auto-rush was armed or disarmed. Emitted even though the sim reads the flag
   * directly, for the same reason `waveRejected` exists: a control that changes
   * something and says nothing reads as a control that did not work.
   */
  | { type: 'autoStartSet'; on: boolean }
  /**
   * Itemised rather than a single number, because "where did my money come
   * from" is the question a player asks while deciding what to build next.
   */
  | { type: 'waveCleared'; wave: number; kills: number; bounty: number; leaked: number; reward: number }
  | { type: 'towerPlaced'; id: EntityId; col: number; row: number }
  | { type: 'buildRejected'; reason: PlacementError }
  /** `tier` is the new tier of the path that was bought. */
  | { type: 'towerUpgraded'; id: EntityId; path: UpgradePath; tier: number; cost: number }
  | { type: 'towerSold'; id: EntityId; col: number; row: number; refund: number }
  | { type: 'towerActionRejected'; reason: TowerActionError }
  | { type: 'eraAdvanced'; era: number; cost: number }
  | { type: 'eraRejected'; reason: EraError }
  /** Bought and dispatched. The wire turns this into the opponent's `inbound`. */
  | { type: 'sortieLaunched'; sortie: SortieId; lane: number; cost: number; kickback: number }
  | { type: 'sortieRejected'; reason: SortieError }
  /**
   * One of *their* sorties reached this core. The wire turns this into the
   * sender's `creditSortie`; `cost` is what it takes off this player, and is
   * already spent by the time the event is read.
   */
  | { type: 'sortieLanded'; kickback: number; cost: number }
  | { type: 'gameOver'; won: boolean };

/** Whole-match state. The sim stops stepping once this leaves 'playing'. */
export type MatchPhase = 'playing' | 'lost' | 'won';

/**
 * Wave *dispatch* state — where the spawner is, not what is on the board.
 *
 * There is deliberately no 'clearing' phase. Dispatch and board-clearing are
 * separate concerns now that waves overlap: the next intermission begins the
 * moment a wave finishes spawning, while its creeps are still walking. Whether
 * a given wave has been cleared is answered by `clearedThrough`, computed from
 * the creeps actually alive.
 */
export type WavePhase =
  /** Counting down to the next wave. Sending early skips the remainder. */
  | 'intermission'
  /** Working through the spawn plan. */
  | 'spawning'
  /** Every wave has been dispatched. */
  | 'done';
