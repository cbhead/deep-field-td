/**
 * Every balance-affecting number in the game.
 *
 * Hard rule: no balance-affecting numeric literal appears anywhere in `src/sim/`.
 * The sim is mechanism; this file is the design. That split is what makes the
 * headless balance harness (M9) able to sweep values without touching logic.
 */
export const BALANCE = {
  startingLives: 20,
  startingMoney: 250,

  /** Fraction of spend returned when a tower is sold. Includes upgrade spend. */
  sellRefund: 0.7,

  upgrade: {
    /**
     * Per-path ceiling: every station has three independent tracks — damage,
     * range, and its own effect (`TowerDef.effectUpgrade`) — and each runs
     * Mk I → Mk III on its own. Fully specialising one track is two purchases;
     * maxing a station outright is six.
     */
    maxTier: 3,
    /**
     * Cost of the next tier *in a path* is `baseCost * costFactor * pathTier`,
     * so the second tier of any path costs twice the first. Escalation is
     * per-path rather than per-tower on purpose: deepening one track gets
     * expensive, while the first tier of a different track stays cheap — which
     * makes "broaden this station or specialise it" a real decision on top of
     * the existing "stack this tile or spread coverage" one.
     */
    costFactor: 1.5,
    /** Damage multiplier per damage-path tier: ×1, ×1.5, ×2.25. */
    damageFactor: 1.5,
    /**
     * Range multiplier per range-path tier: ×1, ×1.15, ×1.32.
     *
     * Deliberately gentler than damage. Range used to be excluded from
     * upgrades entirely because growing reach silently redraws the coverage
     * map — now that it is buyable, the reach circle preview is what keeps it
     * honest, and the factor is kept small because range compounds: it buys
     * time on target *and* new route tiles at once. Sweep before raising it.
     */
    rangeFactor: 1.15,
  },

  /**
   * Grade thresholds, best first. The first entry whose predicate holds wins.
   * Leaks are weighted above speed — holding the line is the game.
   */
  grade: {
    perfectSeconds: 240,
  },

  /** Seconds of build time before wave 1. */
  firstWaveDelay: 12,
  /**
   * Seconds between one wave finishing *spawning* and the next starting — not
   * between one wave clearing and the next. Waves overlap: stragglers from the
   * previous wave are still walking when the next arrives, which is both the
   * genre norm and what makes sending early a real decision.
   */
  intermission: 8,
  /** Paid when every creep of a wave is off the board, on top of per-kill bounty. */
  waveClearReward: 20,

  /**
   * At or below this many lives the HUD goes to its alarm state.
   *
   * A presentation threshold, but it lives here rather than in the HUD for the
   * same reason every other figure does: it is derived from `startingLives`,
   * and a hard-coded 5 in two places would quietly stop meaning "nearly dead"
   * the moment the reserve changed. The HUD reads it; it never restates it.
   */
  critLives: 5,

  /**
   * Cash per second of intermission forfeited by sending a wave early.
   *
   * This is the risk/reward lever: rushing buys tempo and money but stacks the
   * next wave on top of one you have not finished killing. In Race mode it is
   * the main way to pull ahead, since ranking is waves cleared first.
   */
  rushBonusPerSecond: 2.5,

  /**
   * Seconds between burn ticks. One, and the number is load-bearing.
   *
   * A burn that ticked at frame rate would be a different mechanic: it would
   * reset `shieldTimer` sixty times a second and so hold every Warden's shield
   * at zero for free, flood `creepDamaged` — the highest-frequency event in the
   * game — and cut each tick small enough that `armorFloor` swallows it, which
   * would quietly make burn ignore armour. Ticking once a second gives armour
   * one honest bite per tick and leaves the shield interaction a readable
   * decision rather than an accident.
   *
   * Here rather than in `sim/` because a cadence that changes how much damage
   * lands is a balance number, and `content/` is where balance numbers live.
   */
  burnTick: 1,

  /**
   * The era ladder. Versus only — the campaign hands stations out on
   * `TowerDef.unlockWave` and never reads any of this.
   *
   * `advanceCost[0]` buys era II, `advanceCost[1]` buys era III. There is no
   * entry for era I because you start there.
   *
   * **These are unswept and are the mode's main open dial.** The starting
   * figures are reasoned rather than measured: era II is priced near two
   * stations' worth of the tier's opening money, so the first advance is
   * genuinely instead of a defence rather than alongside one, and era III at
   * double that, so the second is a commitment you visibly stop building for.
   * That gap is the Age of War evolution window and the entire point — while
   * you are banking, you are not defending, and that is when the other side
   * pushes.
   *
   * The property to sweep for is *not* a win rate. It is that **rushing
   * straight to era III is survivable but not correct** — the same shape as
   * `hpGrowth`'s rule that mixing beats mono-building without making any
   * single-station build unplayable. If a rush to III wins, lower the gap; if
   * it loses every time, the ladder is decoration and the mode is just Race
   * with a grief button.
   */
  eras: {
    advanceCost: [200, 400],
  },

  /**
   * The sortie economy. Versus only.
   *
   * Two numbers, and between them they are the entire aggression dial.
   *
   * **`markup`** — a sortie costs this multiple of the bounty the defender will
   * collect for killing it. Above 1 by definition: every send into a line that
   * holds is a net transfer to the person you are attacking, which is what
   * makes spam structurally self-defeating rather than merely discouraged. It
   * also means the cost curve is `bountyGrowth`'s curve, so there is no second
   * scaling to keep in step.
   *
   * **`kickback`** — the fraction of the price returned when a sortie reaches
   * their core. Below 1, so aggression is never free; high enough that a send
   * which lands is clearly worth having made. At 0.6 against a markup of 2.2,
   * a sortie that lands costs you 1.3 bounties and takes at least one life,
   * and one that dies costs you 2.2 and hands them 1. Those are the two swings
   * the mode is made of, and the gap between them is the whole design.
   *
   * **Unswept**, like the era costs. The property to sweep for is that
   * *neither* pure strategy wins: a player who never sends should lose to one
   * who sends well, and a player who sends constantly should lose to one who
   * builds. If sending always wins, raise `markup`; if it never does, raise
   * `kickback` before touching the markup — the markup is what keeps spam
   * self-punishing and is the more load-bearing of the two.
   */
  sortie: {
    markup: 2.2,
    kickback: 0.6,
  },

  /**
   * Per-wave multipliers, compounding: wave N enemies have
   * `base * growth ** N`. Computed rather than tabulated is the whole reason
   * content is TypeScript and not JSON — this is the dial difficulty is
   * actually tuned with, and it isn't expressible in a data file.
   *
   * **`hpGrowth` is swept, not guessed**, and it is sharper than it looks. The
   * entire arc turns over inside nine hundredths, measured as
   * (best mixed build / pure Nova / pure Lance), wins out of five:
   *
   *   1.21   5/5 · 5/5 · 5/5    every build wins untouched at 20/20 lives
   *   1.25   5/5 · 5/5 · 5/5    mixed comfortable, pure easy
   *   1.26   5/5 · 5/5 · 5/5    mixed 19.4 · Nova 13.2 · Lance 10.6 lives
   *   1.27   5/5 · 5/5 · 2/5    mixed 16.0, but pure Lance nearly written off
   *   1.28   3/5 · 5/5 · 0/5    only Nova survives
   *   1.30   0/5 · 1/5 · 0/5    nothing survives
   *
   * 1.26 is the point where mixing beats mono-building without making any
   * single-station build unplayable — three stations should be three decisions,
   * not one correct answer. 1.27 is the deliberate alternative if the game
   * should bite harder: it costs the player four more lives on a winning run,
   * at the price of pure Lance becoming a 2/5 gamble.
   *
   * Re-sweep after any change to station damage, station cost, or the contact
   * roster. Do not nudge it by feel — the last re-sweep, run after Lance went
   * 6 to 8 damage and two stations were repriced, reproduced these numbers
   * byte-for-byte, which is the only reason to trust them.
   *
   * Re-swept again when Overclock joined the roster, and unmoved. Both
   * mono-build columns — which are what "without making any single-station
   * build unplayable" actually means — reproduced exactly: 13.2 and 10.6 lives
   * at 1.26, pure Lance falling to 2/5 at 1.27 and 0/5 at 1.28, pure Nova to
   * 1/5 at 1.30. A station that changes no existing number and only ever helps
   * a mix cannot move that boundary, and now it is measured rather than assumed.
   */
  hpGrowth: 1.26,
  bountyGrowth: 1.14,

  /**
   * Fraction of a raw hit that lands no matter how much armour is in the way.
   *
   * Armour must never be immunity. A station that literally cannot scratch a
   * contact reads as a bug rather than as a counter, and it would make a build
   * unrecoverable instead of merely wrong — the player could not chip their way
   * out while saving for the station they actually need. At 0.15 a Singularity
   * still contributes against a Bulwark, just badly enough that its slow is the
   * reason to keep it there.
   */
  armorFloor: 0.15,

  /**
   * Spawn timing is jittered by ±this fraction of the group interval, drawn
   * from the seeded WAVE stream. Metronomic spawns look mechanical; jitter that
   * is *seeded* keeps both players in a Race facing the same arrival pattern.
   */
  spawnJitter: 0.18,
} as const;
