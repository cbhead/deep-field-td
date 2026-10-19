import type { TowerDef } from './types.ts';

/**
 * The twelve stations.
 *
 * **Ids match the names on purpose.** They were once `arrow`/`cannon`/`frost`
 * and the display names moved on without them; that mismatch is the kind that
 * compounds with every station added, so the key, the `id` and the `name` are
 * now one word. Renaming later costs a typed find/replace the compiler polices
 * completely, plus the `.t-<id>` classes in styles.css that it does not.
 *
 * **Every station is the answer to something, and no station is the answer to
 * everything.** That is the property the roster is tuned for, and the matchup
 * matrix in `tools/check.ts` is what reports on it.
 *
 * This rule used to end "and to only one thing", and it is worth recording why
 * it does not any more. That version was written for six stations and was never
 * actually enforced: the matrix section prints its table and contains no
 * `check()` call at all, so nothing failed when Nova and Filament grew into rows
 * of zeros — stations that beat everything, which the rule named as a failure.
 * Doubling the roster did not spend the property. Reading the matrix honestly is
 * what found it already spent, and twelve stations cannot hold single-purpose
 * purity anyway. What survives is the half the matrix can actually see: no row
 * of zeros, and no column nothing clears.
 *
 * The twelve, and the question each answers:
 *
 * - **Lance** pierces — contacts *lined up* along a straight.
 * - **Nova** detonates — contacts *clumped* together.
 * - **Arc** chains — contacts merely *near* each other, which is the case
 *   neither of the other two covers and was the hole in the roster.
 * - **Filament** ramps on a held target — one wall of hull, and nothing else.
 * - **Singularity** slows — support. It wins 0/5 alone in the mono-build rows
 *   and that number means nothing: a station with no damage cannot answer a
 *   "can it clear the arc by itself" question. Read its marginal contribution
 *   instead, where it is worth more than either of the ones that do damage.
 * - **Overclock** feeds the stations around it — the answer to a defence whose
 *   guns are heavy and slow. Support, and the first station whose target is a
 *   tower rather than a contact, so it wins 0/5 alone for the same structural
 *   reason Singularity does and must be read the same way.
 * - **Solvent** strips plating — the answer to armour for a line that already
 *   has damage and cannot land it. It does not out-hit a Bulwark, it turns
 *   everything else back on.
 * - **Breaker** tears overshields and holds them down. Deliberately a poor gun
 *   into bare hull; that asymmetry is the whole station.
 * - **Ember** burns, and the burn walks out of reach with the target — the only
 *   damage on the board that keeps working past the edge of a range circle.
 * - **Repulsor** shoves contacts back down the lane. Buys road rather than
 *   damage, which is what the last line of a defence actually needs.
 * - **Salvage** pays a cut on every wreck in reach. Never shoots; the third
 *   support, and the first whose output is money.
 * - **Sentinel** has no reach at all and therefore no blind spot — the answer to
 *   the leak, and the only station whose placement is not a decision.
 *
 * Eleven of those twelve are a circle around a tile, which means eleven of them
 * pose the same question: *where*. Sentinel is the one that does not, and it is
 * priced as insurance rather than as damage.
 *
 * Costs are set against range, not against raw damage, because range buys time
 * on target: a short-reach station needs more damage per dollar just to break
 * even. Tuned by sweep, never by feel — the first guess had Lance at the best
 * damage per dollar *and* the longest reach, which made it strictly correct and
 * the other two decorative.
 */
export const TOWERS = {
  lance: {
    id: 'lance',
    name: 'Lance',
    blurb: 'Shots pass through. Wants contacts lined up.',
    cost: 75,
    range: 2.8,
    damage: 8,
    fireInterval: 0.5,
    projectileSpeed: 14,
    pierce: 2,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // 2 → 3 → 4 contacts passed through. Pierce is the identity, so the effect
    // path buys more of it — each tier makes a well-placed straight pay more.
    effectUpgrade: { name: 'Pierce', perTier: { pierce: 1 } },
    hotkey: '1',
    unlockWave: 0,
    era: 1,
  },
  nova: {
    id: 'nova',
    name: 'Nova',
    blurb: 'Blast damage. The answer to a swarm.',
    // **Brought down, and the matchup matrix is why.** Nova was printing a row
    // of zeros — losing no waves against any contact — which the header of this
    // file names outright as a failure. It never fired as a test because the
    // matrix section prints its table and contains no assertion at all.
    //
    // 115 → 122 and 22 → 21, and **the smallness of that is the finding.** The
    // first attempt was 130/18, which read as a modest 13%/18% trim and took
    // Standard from clearing all eight sectors to failing from sector 4 on.
    // Even 125/21 broke two boards. The campaign is tuned far more tightly
    // around this one station than its numbers suggest — which is the same fact
    // the row of zeros was reporting, priced in lives instead of duels.
    //
    // Two reasons it lands harder than the sticker:
    //
    //  - **Cost compounds through the upgrade ladder.** `upgrade.costFactor`
    //    prices every tier off the base, so +7 here raises Mk II and Mk III on
    //    all three paths.
    //  - **The damage cut is amplified by armour, because armour is flat.** A
    //    direct hit on a Bulwark goes from keeping 77% to 76%, but the splash
    //    *rim* goes from 7.7 − 5 = 2.7 to 7.35 − 5 = 2.35 — the rim is where a
    //    blast station actually loses ground to plating.
    //
    // **Swept against the campaign, not guessed**, and `hpGrowth` deliberately
    // did *not* move to pay for it: dropping it to 1.22 also clears the arc, and
    // it does so by making the whole game easier, which is the one outcome that
    // would undo the point of the change. Verified at 5/5 on every sector at
    // Standard and 3/3 on the continuous run.
    //
    // **It is only safe because Solvent ships alongside it.** Nova was the
    // roster's designated answer to armour and `enemies.ts` sizes Bulwark around
    // that; cutting it without a second answer would leave plating
    // under-answered. If a sweep ever shows armour becoming unanswerable, the
    // next lever is `fireInterval` rather than more damage — that cuts dps
    // without touching per-hit weight, so the anti-armour identity survives.
    cost: 122,
    range: 2.5,
    damage: 21,
    fireInterval: 1.4,
    projectileSpeed: 9,
    pierce: 0,
    splashRadius: 0.8,
    splashFalloff: 0.35,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // 0.8 → 1.05 → 1.3 tile blast. Radius rather than falloff because a wider
    // ring is legible on the board — the blast event carries the real radius,
    // so the drawn circle grows with the purchase.
    effectUpgrade: { name: 'Blast', perTier: { splashRadius: 0.25 } },
    hotkey: '2',
    unlockWave: 0,
    era: 1,
  },
  singularity: {
    id: 'singularity',
    name: 'Singularity',
    blurb: 'Slows everything it touches. Support, not damage.',
    cost: 80,
    range: 3.3,
    damage: 3,
    fireInterval: 0.28,
    // Fast enough to land the same tick it is fired, in practice. Hitscan
    // without a second damage path and a second set of bugs.
    projectileSpeed: 40,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 0.8,
    slowSeconds: 0.9,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // 80% → 74% → 68% speed, held 0.9s → 1.2s → 1.5s. Both dials move a little
    // rather than one a lot: a much lower factor alone approaches a stop (the
    // classic way a slow breaks a tower defense), and duration alone is
    // invisible under constant re-hits. slowFactor leads because it is the
    // number the inspector previews.
    effectUpgrade: { name: 'Slow', perTier: { slowFactor: -0.06, slowSeconds: 0.3 } },
    hotkey: '3',
    unlockWave: 0,
    era: 1,
  },

  arc: {
    id: 'arc',
    name: 'Arc',
    blurb: 'Jumps between contacts. Wants them near each other, not lined up.',
    cost: 105,
    range: 2.6,
    damage: 10,
    fireInterval: 0.75,
    // Near-hitscan, like Singularity: an arc that visibly travelled would read
    // as a slow projectile rather than as electricity finding a path.
    projectileSpeed: 30,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    // 10 into the first, then 5.5, 3.0, 1.7 — about 20 spread over four
    // contacts. Deliberately worse than Lance into a single target and better
    // than either into a scatter, which is the only thing it should win at.
    // The falloff started at 0.65 and the probe had Arc winning 5/5 at 17.4
    // lives alone, ahead of every other single station — proximity is a far
    // easier condition to satisfy than Lance's alignment, so equal falloff made
    // it the strictly easier buy rather than a different one.
    chainJumps: 3,
    chainRange: 1.6,
    chainFalloff: 0.55,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // 3 → 4 → 5 jumps. Jumps, not falloff: extra hops keep the "worse than
    // Lance into a line, better into a scatter" identity, where softer falloff
    // would creep toward beating Lance at its own condition.
    effectUpgrade: { name: 'Chain', perTier: { chainJumps: 1 } },
    hotkey: '4',
    // Opens on the wave Motes first arrive. Every station unlocks alongside the
    // problem it answers, so the deck teaches the roster instead of the player
    // having to infer it.
    unlockWave: 2,
    era: 2,
  },

  filament: {
    id: 'filament',
    name: 'Filament',
    blurb: 'Burns hotter the longer it holds one target. Cools if it switches.',
    cost: 105,
    range: 2.4,
    // Low per-hit damage on purpose: armour is subtracted per hit, so a
    // Filament is deliberately terrible into a Bulwark however long it burns.
    // It answers hull, not plating — that is what keeps it from being a
    // strictly better Nova.
    damage: 4,
    fireInterval: 0.25,
    projectileSpeed: 40,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    // 16 dps cold, 48 dps at the ceiling, reached after 2.5s on one target.
    // Swept between two failures rather than guessed: 12/42 over 4s could not
    // carry a run even with its unlock removed (wave 8 of 10, level with pure
    // Singularity, which has no damage at all), while 20/70 over 2.5s won alone
    // at 19.8 lives and made nova+filament a flawless 20/20 — dominant, which
    // is the one outcome the roster must not have.
    rampPerSecond: 0.8,
    rampMax: 3,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // Ceiling ×3 → ×3.75 → ×4.5, spin-up 0.8 → 1.0 → 1.2/s. Both rise so time
    // to the ceiling stays near 2.5s — a higher ceiling alone would mean a burn
    // that never finishes charging against anything that dies. rampMax leads
    // because the ceiling is the number the inspector previews.
    effectUpgrade: { name: 'Ramp', perTier: { rampMax: 0.75, rampPerSecond: 0.2 } },
    hotkey: '5',
    /** Opens on the wave the first Monolith walks in. */
    unlockWave: 4,
    era: 3,
  },

  overclock: {
    id: 'overclock',
    name: 'Overclock',
    blurb: 'Feeds the stations around it. Buys shots, never damage.',
    cost: 110,
    // **Swept, not guessed** — and the two dials had to be swept together,
    // because cost and buff strength trade directly against each other.
    // Measured at Blackout on Switchback, where the four-station reference
    // still bleeds; at Standard it finishes on 19.6 of 20 and every delta
    // collapses into the ceiling.
    //
    // Marginal lives added to `nova+lance` (10.2 without any support), against
    // Singularity in the same slot at +1.8:
    //
    //            +0.25/s   +0.35/s   +0.50/s
    //   $80        -0.4      +1.8      +2.6
    //   $110       -1.0      +1.8      +3.0      <- shipped
    //   $150       -7.2      -1.0      +2.6
    //
    // +0.35 at $110 lands on +1.8, which is *exactly* Singularity's. That is
    // the target: a peer of the support already in the roster, neither the new
    // correct answer nor decorative.
    //
    // **0.35 rather than 0.50 because price has to keep mattering.** At 0.50 the
    // station scores 12.8 / 13.2 / 12.8 across all three costs — price stops
    // being an input at all, and a station whose price does not change whether
    // you want it is a must-buy with a number written on it rather than a
    // decision. At 0.35 the same row runs 12.0 / 12.0 / 9.2 and $150 kills it.
    //
    // **$110 rather than $80 because two supports must stay a mistake.** A
    // four-cycle carrying both Singularity and Overclock scores 8.4 at $110
    // against 12.0 for either alone — over-investment in stations that do no
    // damage, correctly punished. At $80 the same build scores 13.0 and *beats*
    // either support alone, which makes stacking support strictly correct and
    // is the one outcome this roster must not have.
    //
    // `hpGrowth` re-swept afterwards per `balance.ts`: unmoved at 1.26. The two
    // mono-build columns that define the boundary reproduce byte-for-byte at
    // every rung, which is what a station that changes no existing number and
    // only ever helps a mix should do.
    //
    // `range` is the buff radius. Reusing the field rather than adding an
    // adjacency flag is deliberate: the placement ghost already draws a reach
    // circle from it, the range path already widens it, and `rangeAtTier`
    // already computes it — a flag would be three new pieces of machinery to
    // say what this one already says.
    //
    // 1.8 takes in the eight surrounding tiles (orthogonal at 1.0, diagonal at
    // 1.41) and stops short of 2.0. Tiers are ×1.15 — 1.8 / 2.07 / 2.38 — and
    // each buys a real ring: 2.07 the four tiles at exactly 2, 2.38 the eight
    // at √5. Chosen so no range purchase is inert, which 1.5 would have been at
    // Mk II, the next tile out sitting at exactly 2.0.
    range: 1.8,
    // Zero damage and zero interval together are the statement "this station
    // does not shoot" — the same `0`-is-a-statement idiom as the fields above.
    // One guard in `fireTowers` reads the interval; nothing reads the rest.
    //
    // Zero rather than Singularity's token 3, because a support station that
    // also shoots would have its own damage ride the rate buff of a second
    // Overclock, and "what does this station do" stops having one answer.
    damage: 0,
    fireInterval: 0,
    projectileSpeed: 0,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0.35,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // 0.35 → 0.45 → 0.55/s. At Mk III a fed Nova runs at 1.26/s, +77% damage
    // per second — large, but priced by the per-path escalation at $495 on top
    // of the build, where a second Overclock buying the same rate somewhere
    // else costs $110.
    effectUpgrade: { name: 'Feed', perTier: { buffShotsPerSecond: 0.1 } },
    hotkey: '6',
    // The first Bulwark wave, holding the convention that every station unlocks
    // alongside the problem it answers: armour is what makes a heavier shot
    // worth more than a faster one, so it is the wave that makes rate a
    // question worth asking.
    unlockWave: 6,
    era: 2,
  },
  solvent: {
    id: 'solvent',
    name: 'Solvent',
    blurb: 'Strips plating. Everything else in reach hits harder.',
    cost: 95,
    range: 2.6,
    // A token 2, the same statement Singularity's 3 makes: this station is not
    // here to kill anything. It is not zero, because a support that also reads
    // as inert on the board is a control nobody trusts.
    damage: 2,
    fireInterval: 0.35,
    // Near-hitscan, like Singularity and Arc. A visible shell would read as a
    // slow gun rather than as something dissolving armour on contact.
    projectileSpeed: 40,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    // Four hits to the ceiling, about 1.4s on one target. Against Bulwark's 5
    // that is "mostly gone"; against Ironclad's 11 it is "you have to invest",
    // which is the arc the two armoured contacts are meant to describe.
    shredPerHit: 1,
    shredMax: 4,
    shredSeconds: 3,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // Ceiling 4 → 6 → 8, bite 1 → 1.5 → 2. The ceiling leads because it is the
    // number the inspector previews, the same convention Filament's `rampMax`
    // sets; the bite follows so time-to-ceiling stays near a second and a half
    // rather than stretching out as the ceiling rises.
    effectUpgrade: { name: 'Strip', perTier: { shredMax: 2, shredPerHit: 0.5 } },
    hotkey: '7',
    unlockWave: 6,
    era: 2,
  },

  breaker: {
    id: 'breaker',
    name: 'Breaker',
    blurb: 'Tears overshields open and holds them down.',
    cost: 90,
    range: 2.7,
    damage: 9,
    fireInterval: 0.9,
    projectileSpeed: 16,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    // 10 dps into hull, 30 into shield. Below average against anything bare, and
    // that asymmetry is the identity rather than a cost paid for it — a breaker
    // that was also a decent gun would just be a better gun.
    shieldFactor: 3,
    // On top of the regen delay every hit already resets. The distinction is the
    // point: `shieldTimer` says "someone is still shooting", this says "it was
    // broken", and only the second one survives you switching targets.
    shieldLockSeconds: 2.5,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // ×3 → ×4 → ×5 into shield, held 2.5 → 3.0 → 3.5s. The multiplier leads: it
    // is what the inspector previews and what the player is actually buying.
    effectUpgrade: { name: 'Break', perTier: { shieldFactor: 1, shieldLockSeconds: 0.5 } },
    hotkey: '8',
    unlockWave: 6,
    era: 2,
  },

  ember: {
    id: 'ember',
    name: 'Ember',
    blurb: 'Sets contacts alight. The burn walks out of reach with them.',
    cost: 100,
    range: 2.5,
    damage: 6,
    fireInterval: 0.8,
    projectileSpeed: 12,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    // 5 a tick for 4 ticks — 20 free damage that does not care whether the
    // contact is still in reach. Armour is deliberately its weakness: 5 against
    // Ironclad's 11 floors out, the same axis Filament is weak on, which is what
    // keeps neither of them a general answer to "something tough".
    burnDamage: 5,
    burnSeconds: 4,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // 5 → 8 → 11 a tick, over 4 → 5 → 6s. Damage leads; duration follows so the
    // burn keeps outliving the walk out of range rather than only hitting harder
    // inside it.
    effectUpgrade: { name: 'Burn', perTier: { burnDamage: 3, burnSeconds: 1 } },
    hotkey: '9',
    /** Opens with the first Monolith — the first hull worth burning down. */
    unlockWave: 4,
    era: 3,
  },

  repulsor: {
    id: 'repulsor',
    name: 'Repulsor',
    blurb: 'Shoves contacts back down the lane. Buys road, not damage.',
    cost: 120,
    // Short on purpose. This is a last line, and a long-reach shove would push
    // contacts backward through the part of the board that was already working.
    range: 2.2,
    damage: 5,
    // Slow on purpose, and the slowest gun in the roster. A fast shove is a
    // stun-lock, which is the classic way a tower defense breaks.
    fireInterval: 1.6,
    projectileSpeed: 20,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    // Just under a tile, so a shove is legible without teleporting anything.
    // The cooldown is longer than the fire interval, which means a second
    // Repulsor on the same corner adds coverage and not a lock — see
    // `TowerDef.knockbackCooldown`.
    knockbackTiles: 0.9,
    knockbackCooldown: 1.2,
    bountyBonus: 0,
    volleyTargets: 1,
    boardWide: false,
    // 0.9 → 1.25 → 1.6 tiles. Distance only: a shorter cooldown is the dial that
    // turns this back into a lock, so the effect path is not allowed to touch it.
    effectUpgrade: { name: 'Shove', perTier: { knockbackTiles: 0.35 } },
    hotkey: '0',
    unlockWave: 7,
    era: 3,
  },

  salvage: {
    id: 'salvage',
    name: 'Salvage',
    blurb: 'Pays a cut on every wreck inside its reach. Never shoots.',
    // Priced above every gun because it pays itself back — the only station on
    // the board where cost is recovered rather than merely spent.
    cost: 130,
    // The salvage radius, reusing `range` exactly as Overclock reuses it: the
    // placement ghost already draws a reach circle from this field and
    // `rangeAtTier` already computes it, so a second radius would be new
    // machinery saying what this one already says.
    range: 2.4,
    // Zero damage and zero interval together are the "this station does not
    // shoot" idiom Overclock establishes. One guard in `fireTowers` reads the
    // interval; nothing reads the rest.
    damage: 0,
    fireInterval: 0,
    projectileSpeed: 0,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    // **The number to watch, and the one most likely to be wrong.** The roster
    // already records that two supports must stay a mistake: at $80 Overclock,
    // `singularity + overclock` beat either alone, which makes stacking support
    // strictly correct and is the one outcome this roster must not have. Salvage
    // is the third support and the same trap is one price change away.
    bountyBonus: 0.35,
    volleyTargets: 1,
    boardWide: false,
    // 35% → 47% → 59%. Sized so a maxed Salvage over a killing field is worth
    // about a station, not about a second board.
    effectUpgrade: { name: 'Salvage', perTier: { bountyBonus: 0.12 } },
    hotkey: '-',
    unlockWave: 0,
    era: 1,
  },

  sentinel: {
    id: 'sentinel',
    name: 'Sentinel',
    blurb: 'No reach and no blind spot. Shoots whatever is closest to the core.',
    // The most expensive station on the board, and the price is not for its
    // damage — 13 dps is a Lance at nearly twice the cost. What it buys is that
    // there is no wrong tile to put it on.
    cost: 140,
    // **Unused. See `boardWide`.** Left at 0 rather than at some large number
    // because a big radius would be a lie the placement ghost would then draw:
    // this station does not have a huge circle, it has no circle.
    range: 0,
    boardWide: true,
    // Heavy and slow, and both halves are the constraint. Per-hit weight means
    // armour barely troubles it, which it should not — a station that cannot be
    // out-positioned must not also be out-ranged by plating. The 2s interval is
    // what stops "never misses coverage" becoming "answers everything": it
    // fires thirty times a wave, so volume walks straight past it.
    damage: 26,
    fireInterval: 2,
    projectileSpeed: 22,
    pierce: 0,
    splashRadius: 0,
    splashFalloff: 1,
    slowFactor: 1,
    slowSeconds: 0,
    chainJumps: 0,
    chainRange: 0,
    chainFalloff: 1,
    rampPerSecond: 0,
    rampMax: 1,
    buffShotsPerSecond: 0,
    shredPerHit: 0,
    shredMax: 0,
    shredSeconds: 0,
    shieldFactor: 1,
    shieldLockSeconds: 0,
    burnDamage: 0,
    burnSeconds: 0,
    knockbackTiles: 0,
    knockbackCooldown: 0,
    bountyBonus: 0,
    // One at a time at Mk I. Targeting is not a choice here and the inspector
    // says so: it always takes the contact closest to the core, because "the one
    // about to cost you a life" is the only target a station with no reach has
    // any business preferring.
    volleyTargets: 1,
    // 1 → 2 → 3 of the most dangerous contacts on the board, wherever they are.
    // The one upgrade in the roster that widens *coverage* rather than a radius,
    // which is the only way this station can be deepened without giving it the
    // reach it is defined by not having.
    effectUpgrade: { name: 'Watch', perTier: { volleyTargets: 1 } },
    hotkey: '=',
    /**
     * Opens on the wave after the first Monolith, when contacts start surviving
     * the run down the board and a leak stops being a mistake and starts being
     * arithmetic. Its own wave, so the roster's one rangeless station is not
     * taught in a crowd.
     */
    unlockWave: 5,
    era: 2,
  },
} as const satisfies Record<string, TowerDef>;

export type TowerId = keyof typeof TOWERS;

export const TOWER_IDS = Object.keys(TOWERS) as TowerId[];
