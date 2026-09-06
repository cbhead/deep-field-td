/**
 * Authoring formats for content.
 *
 * `src/content/` is data, never logic — it imports nothing and computes nothing
 * beyond arithmetic on its own constants. That's what lets a balance change be a
 * one-line diff in a file with no behaviour in it.
 */

/** A tile address. Integers, unlike the sim's float positions. */
export type TileCoord = readonly [col: number, row: number];

export interface EnemyDef {
  readonly id: string;
  readonly name: string;
  readonly hp: number;
  /** Tiles per second. Reads as a design value because the sim works in tiles. */
  readonly speed: number;
  /** Money awarded on kill. */
  readonly bounty: number;
  /** Draw and hit radius, in tiles. */
  readonly radius: number;

  /**
   * Lives taken when this reaches the goal. 1 for everything in the campaign.
   *
   * A dial rather than a constant because the versus board's sortie deck needs
   * one. When every contact costs exactly one life the correct sortie is always
   * the cheapest hull per dollar, and the expensive end of the roster is never
   * worth buying — a Monolith costs five Drifters and lands the same single
   * blow. Weight is what makes "spend up for one that lands hard" a decision
   * rather than a mistake.
   *
   * Deliberately *not* derived from hp or bounty. Both compound per wave, and a
   * leak cost that compounded with them would make a single late leak fatal on
   * a board whose whole reserve is fourteen lives at Blackout.
   */
  readonly leakDamage: number;

  /**
   * Flat damage subtracted from every individual hit. 0 for everything unarmoured.
   *
   * Flat, not a percentage, and that is the entire design. A percentage cut
   * scales every station equally and therefore counters none of them; a flat
   * cut discriminates by damage *per hit*, so a station landing one heavy shot
   * barely notices while one that chips is nearly stopped.
   *
   * It exists because pierce and slow turned out to multiply: a slow bunches
   * contacts into a file, and pierce is worth more the longer the file, so
   * Singularity manufactures exactly the condition that maximises Lance. The
   * sweep's marginal block showed that pair winning every seed without losing a
   * life while Nova's marginal contribution was *negative*. Armour is the axis
   * on which that pair is weak and Nova is strong, so it makes Nova the answer
   * to something rather than a more expensive way to do what Lance already did.
   *
   * Never total immunity — see `BALANCE.armorFloor`.
   */
  readonly armor: number;

  /**
   * Overshield absorbed before hull. 0 for everything that has none.
   *
   * Shields punish *thin* coverage rather than low damage: they regenerate
   * after a lull, so a contact that slips past a gap arrives whole. Scales with
   * the wave exactly as hp does.
   */
  readonly shield: number;
  /** Seconds without taking damage before the shield starts coming back. */
  readonly shieldRegenDelay: number;
  /** Shield points per second once regen has started. */
  readonly shieldRegenRate: number;

  /**
   * How much of an incoming slow this shrugs off. `0` feels it in full, `1` is
   * total immunity.
   *
   * The second axis on which the roster's original degenerate pair is weak, and
   * the cheaper of the two. A slow bunches contacts into a file and pierce is
   * worth more the longer the file, so a slowing station manufactures exactly
   * the condition that maximises a piercing one — see `armor` above, which is
   * the first axis. Armour cost a whole mechanic; this costs one multiplication
   * in `applySlow`.
   */
  readonly slowResist: number;

  /**
   * What this breaks into when killed, or null.
   *
   * The named type must itself have `splitInto: null`. That is what makes
   * runaway splitting structurally impossible rather than merely avoided by
   * choosing sensible content — a gate asserts it.
   */
  readonly splitInto: { readonly enemy: string; readonly count: number } | null;
}

export interface TowerDef {
  readonly id: string;
  readonly name: string;
  /** One-line pitch, shown in the build bar. */
  readonly blurb: string;
  readonly cost: number;
  /** Firing radius in tiles, measured from the tower's tile centre. */
  readonly range: number;
  readonly damage: number;
  /** Seconds between shots. */
  readonly fireInterval: number;
  /** Tiles per second. A high value simulates hitscan without a second system. */
  readonly projectileSpeed: number;

  /**
   * Behaviour, one field per mechanic. All five are required rather than
   * optional so that every station's full behaviour is readable in one place —
   * a `0` is a statement ("this one does not splash"), where an absent optional
   * field is a question.
   */

  /** Extra contacts a shot passes through. `0` expires on the first hit. */
  readonly pierce: number;
  /** Splash radius in tiles at the point of impact. `0` is single-target. */
  readonly splashRadius: number;
  /** Damage factor at the very edge of the splash. `1` is no falloff. */
  readonly splashFalloff: number;
  /** Speed multiplier applied to a contact on hit. `1` is no slow. */
  readonly slowFactor: number;
  /** Seconds the slow lasts. Refreshed on re-hit, never stacked. */
  readonly slowSeconds: number;

  /**
   * Extra contacts the hit jumps to, and how far a jump may reach.
   *
   * Distinct from `pierce`, which is the same idea constrained to a straight
   * line. Pierce wants contacts *lined up* and splash wants them *clumped*; a
   * loose scatter satisfies neither, and that was the hole in the roster. A
   * chain needs only proximity, so it is the answer to a spread-out swarm
   * without being an answer to anything tough.
   */
  readonly chainJumps: number;
  readonly chainRange: number;
  /** Damage multiplier applied per jump, compounding. `1` would not fall off. */
  readonly chainFalloff: number;

  /**
   * How fast damage ramps while the station holds one target, and the ceiling.
   *
   * `rampPerSecond: 0` is a station that does not ramp, which is most of them.
   *
   * Changing target *cools* the charge by half rather than clearing it; running
   * out of targets entirely clears it. That split is the design. Clearing on
   * every switch reads like the same rule and is not: it makes a ramping
   * station worth having only where contacts arrive in one unbroken file, and
   * the eight-board sweep priced that at minus eleven lives on the board whose
   * lanes cross at every rung. Cooling keeps the mechanic — hold a target and
   * you are rewarded, switch and you are not — without making a whole board
   * shape a trap. See `RAMP_CARRY` in `sim/systems/targeting.ts`.
   */
  readonly rampPerSecond: number;
  /** Ceiling as a multiple of base damage. `1` means no ramp is possible. */
  readonly rampMax: number;

  /**
   * Shots per second this station *adds* to every station within `range`.
   * `0` for the five that fight contacts directly.
   *
   * Additive rather than a multiplier on `fireInterval`, and that inversion is
   * the entire reason a rate buff is safe to add to this roster. A multiplier
   * pays out most to whatever station already has the highest damage per
   * second, which amplifies the roster instead of adding to it — the "strictly
   * correct, and the other two decorative" failure `towers.ts` records the
   * first roster hitting. A flat `+N/s` pays out most to the *slowest* gun:
   * +0.35 is +49% on a Nova and +9% on a Filament.
   *
   * It also cannot rescue chip damage, because armour is subtracted per hit —
   * so the buff's weakness is the roster's existing armour axis, at no new
   * balance cost. See `EnemyDef.armor`.
   *
   * Stacks by maximum, never by sum. See `refreshBuffs` in `sim/build.ts`.
   */
  readonly buffShotsPerSecond: number;

  /**
   * Armour stripped per hit, the ceiling it accumulates to, and how long the
   * strip lasts without a refresh. `0` for everything that does not strip.
   *
   * **Accumulates rather than refreshing to a maximum**, which is the opposite
   * of how slow works and is deliberate: the feel is a plate being worn away by
   * repeated hits, and a strip that jumped to its ceiling on the first hit would
   * be a different mechanic wearing the same name. The ceiling comes off the
   * *shot's* snapshot, so a station upgraded mid-stack does not retroactively
   * deepen a strip already on a contact.
   *
   * Consumed by `effectiveDamage`'s `armor` argument in `sim/damage.ts`, which
   * is why it adds no new path to `c.hp` — it changes an input to the one funnel
   * rather than becoming a second one.
   */
  readonly shredPerHit: number;
  readonly shredMax: number;
  readonly shredSeconds: number;

  /**
   * Damage multiplier applied to the *shield* portion of a hit, and how long
   * shield regeneration is held down afterwards. `1` and `0` for everything that
   * is not a shield-breaker.
   *
   * The multiplier applies only where the hit meets shield; overflow into hull
   * is divided back out, so a 3× breaker does not also triple the spillover once
   * the shield pops. Without that division a breaker would be a general-purpose
   * damage multiplier wearing a shield-shaped label.
   *
   * `shieldLockSeconds` is a second, longer hold on top of the `shieldRegenDelay`
   * every hit already resets — the difference between suppressing regen while
   * you keep firing and suppressing it because you *broke* something.
   */
  readonly shieldFactor: number;
  readonly shieldLockSeconds: number;

  /**
   * Damage per burn tick and how long the burn lasts. `0` for everything that
   * does not set fire to things.
   *
   * The only mechanic whose damage continues after the contact leaves reach,
   * which is the entire reason it is worth having next to five stations that
   * stop mattering the moment their target walks out of range.
   *
   * Ticks once a second (`BALANCE.burnTick`), not once a frame. The cadence is
   * load-bearing rather than an optimisation: a 60Hz burn would reset
   * `shieldTimer` every frame and so hold every Warden's shield at zero for
   * free, flood the highest-frequency event in the game, and shrink each tick to
   * a rounding error that `armorFloor` swallows. One honest bite a second keeps
   * armour meaningful against it and keeps the burn-holds-a-shield-open
   * interaction a decision rather than an accident.
   *
   * Refreshes and takes the higher damage, never stacks — the same rule the slow
   * states, for the same reason.
   */
  readonly burnDamage: number;
  readonly burnSeconds: number;

  /**
   * Tiles a hit shoves a contact back down its own lane, and the per-contact
   * immunity window afterwards. `0` for everything that does not shove.
   *
   * **The cooldown is not optional.** Without it two shoving stations covering
   * one corner is an infinite lock, which is the same class of failure the
   * slow's refresh-never-stack rule exists to prevent — and a hard stop is the
   * classic way a tower defense breaks.
   *
   * Shoving moves `progress`, which is what `first` targeting ranks by, so a
   * shoved contact is also demoted out of the front of the queue. That is a
   * consequence rather than a side effect and is half the reason to build one.
   */
  readonly knockbackTiles: number;
  readonly knockbackCooldown: number;

  /**
   * Extra fraction of the bounty paid for any contact that dies within `range`.
   * `0` for the eleven that do not deal in money.
   *
   * The first station whose output is cash rather than damage or a change to
   * another station's numbers. Like the rate buff it **stacks by maximum, never
   * by sum**: summing would make a lattice of them the dominant build, which is
   * the one shape this roster keeps having to design away from.
   *
   * Paid inside `damageCreep`'s kill block so it cannot double-pay, and
   * deliberately invisible to `sortieCost` — a defender's economy must not raise
   * what an attacker pays to send.
   */
  readonly bountyBonus: number;

  /**
   * How many distinct contacts one trigger pull fires at. `1` for everything
   * that shoots one thing.
   *
   * Distinct from `pierce`, `splashRadius` and `chainJumps`, all of which need
   * their extra targets to be near *each other*: a line, a clump, a loose
   * scatter. This one needs nothing at all — which is why it belongs to the
   * station that also has no reach, where "the three most dangerous contacts
   * anywhere" is a sentence the other eleven cannot say.
   */
  readonly volleyTargets: number;

  /**
   * Whether this station ignores `range` entirely and reaches the whole board.
   *
   * **The one station that is not a circle.** Every other entry in this file is
   * a radius around a tile, so the decision they all pose is the same one —
   * *where*. This one answers it in advance: placement is free, and what you buy
   * instead is that nothing can ever be out of reach.
   *
   * The exchange is deliberately steep. It fires slowly, hits one contact at a
   * time until its effect path says otherwise, and always picks the contact
   * closest to the core — so it is the answer to *the leak*, and no answer at
   * all to volume. A station that could not miss and also kept up would be the
   * end of placement as a decision.
   *
   * `range` is meaningless when this is set, and the range upgrade track is
   * withdrawn rather than sold as an inert purchase — see `hasRangePath`. That
   * is the same posture Overclock takes toward its damage track.
   */
  readonly boardWide: boolean;

  /**
   * The effect upgrade path: what this station's third upgrade track improves,
   * on top of the damage and range tracks every station shares.
   *
   * `perTier` is a set of additive deltas applied once per tier above Mk I, so
   * the effect a station is *for* is the thing its effect path deepens — a
   * Lance pierces further, a Singularity slows harder. Additive rather than
   * multiplicative because most of these stats are counts and factors where
   * "+1 jump" and "−6 points of slow factor" are the natural authoring units.
   *
   * The first key is the headline: the inspector's effect button previews it,
   * so put the stat a player is buying first and any supporting tweak after.
   */
  readonly effectUpgrade: {
    /** Short label on the effect-path button, e.g. 'Pierce'. */
    readonly name: string;
    readonly perTier: Readonly<Partial<TowerStats>>;
  };

  /** Number key that selects this tower. */
  readonly hotkey: string;
  /**
   * First wave index (0-based) at which this type may be built. 0 means
   * available from the start. The deck renders anything still locked as a
   * disabled slot naming the wave it opens on.
   */
  readonly unlockWave: number;

  /**
   * Which era must be bought before this may be built. 1 is available from the
   * start. Read only when `Rules.eras` is set — versus, and nothing else.
   *
   * The second half of the same statement `unlockWave` makes, on a different
   * clock. The campaign hands stations out on a schedule, which is a teaching
   * order: by the wave a type matters you have it, and being ready is not
   * something you can get wrong. Versus replaces the schedule with a purchase,
   * so the same ladder becomes a decision — bank for the next rung and build
   * nothing while you do, or spend now and stay a rung behind. That is the
   * mode's whole tension and it costs exactly this one extra field.
   *
   * The era also caps the *upgrade* ceiling: era N allows Mk N on every path.
   * One number gating both is deliberate. Two ladders would be two things to
   * read, and the interesting question is "how far up am I", not "how far up am
   * I in each of two systems".
   */
  readonly era: number;
}

/**
 * The combat numbers a station actually fights with — every stat an upgrade
 * can move, plus the ones that ride along unchanged.
 *
 * A `Pick` of the def rather than a new shape so the two can never disagree
 * field-by-field. The sim stores one of these per tower (recomputed from the
 * def and the tower's tiers on every upgrade) and snapshots it onto each
 * projectile at fire time, so a shot in flight lands with the stats it was
 * fired with even if the station is upgraded or sold before impact.
 */
export type TowerStats = Pick<
  TowerDef,
  | 'range'
  | 'damage'
  | 'fireInterval'
  | 'projectileSpeed'
  | 'pierce'
  | 'splashRadius'
  | 'splashFalloff'
  | 'slowFactor'
  | 'slowSeconds'
  | 'chainJumps'
  | 'chainRange'
  | 'chainFalloff'
  | 'rampPerSecond'
  | 'rampMax'
  // In `TowerStats` and not merely on the def, so the effect path can deepen it
  // through the existing `perTier` loop in `computeStats` with no new code.
  | 'buffShotsPerSecond'
  // Same reason, one line each: every mechanic a station is *for* has to be
  // reachable by that station's effect path, or its third upgrade track would
  // have nothing to buy.
  | 'shredPerHit'
  | 'shredMax'
  | 'shredSeconds'
  | 'shieldFactor'
  | 'shieldLockSeconds'
  | 'burnDamage'
  | 'burnSeconds'
  | 'knockbackTiles'
  | 'knockbackCooldown'
  | 'bountyBonus'
  | 'volleyTargets'
>;

/** One burst of identical enemies inside a wave. */
export interface WaveGroup {
  readonly enemy: string;
  readonly count: number;
  /** Seconds between spawns within the group. */
  readonly every: number;
  /** Seconds into the wave before this group starts. */
  readonly after: number;

  /**
   * Which lane this group walks. A `RouteSource.id` pins it to one; `'split'`
   * deals it round-robin across every route in index order.
   *
   * Optional, and absent means route 0 — which is what makes a one-route board
   * read exactly as it did before this field existed, and why the three shipped
   * wave tables needed no edit.
   *
   * Round-robin rather than random, and that is load-bearing rather than
   * merely simple: a race replays the same wave plan on two clients, so lane
   * assignment has to be reproducible from the seed alone. Dealing in index
   * order needs no RNG stream at all, which is one fewer thing that can drift
   * — and it means `'split'` on a count of 12 across two lanes is always 6 and
   * 6, which a designer can reason about.
   */
  readonly route?: string | 'split';
}

export interface WaveDef {
  readonly groups: readonly WaveGroup[];
}

/**
 * One lane. An id and a waypoint chain, and deliberately nothing else.
 *
 * No per-route speed, no weighting, no priority. Those would all be reasonable
 * and all be premature: on a multi-lane board the *geometry* is doing the work,
 * and a second knob on top of it would only hide which one mattered.
 */
export interface RouteSource {
  /** Unique within the map. The authoring handle, and what a wave group names. */
  readonly id: string;

  /**
   * The lane as corner tile coords, first = a spawn, last = the goal.
   *
   * Authored explicitly rather than traced out of the ASCII: a trace is ambiguous
   * wherever the path touches itself, and the order of travel isn't recoverable
   * from painted tiles at all. The cost of a second representation is drift, so
   * `parseMap()` cross-checks the two — every route tile must be painted path,
   * and every painted path tile must be on *some* route.
   */
  readonly waypoints: readonly TileCoord[];
}

export interface MapSource {
  readonly id: string;
  readonly name: string;

  /**
   * The board, one string per row. All rows must be the same length.
   *
   *   `.` buildable ground    `#` path
   *   `x` blocked scenery     `S` spawn (path)    `E` goal (path)
   *
   * More than one `S` is legal — a board may have several spawns. More than one
   * `E` is not: one goal keeps a board about coverage, where two goals with
   * different life costs would be a different game, about triage.
   */
  readonly rows: readonly string[];

  /**
   * The lanes contacts walk. At least one.
   *
   * A single-route map is the old shape and reads identically — which is the
   * whole reason this is a list rather than a `waypoints` field beside an
   * optional `extraLanes`. Lanes that share tiles are legal and expected: a
   * merge *is* two routes covering the same road.
   */
  readonly routes: readonly RouteSource[];
}
