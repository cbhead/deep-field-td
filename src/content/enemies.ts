import type { EnemyDef } from './types.ts';

/**
 * The things that come down the route. The HUD calls them *contacts*
 * collectively; each type has its own name.
 *
 * `as const satisfies` rather than a plain annotation: `satisfies` type-checks
 * each entry against EnemyDef while `as const` keeps the literal types, so
 * `EnemyId` is the union of these keys rather than `string`. Typos in a wave
 * table then fail to compile — which is also what polices the id/name match here.
 *
 * The six types exist to ask different questions of a defence, not to be six
 * flavours of the same one:
 *
 * - **Drifter** — the baseline everything else is read against.
 * - **Mote** — too fast and too numerous for single-target fire. Wants splash.
 * - **Monolith** — a wall of hull. Punishes chip damage, which is the first
 *   thing in this game a Singularity is genuinely bad at.
 * - **Warden** — regenerates its shield in any gap, so it punishes thin
 *   coverage rather than low damage. A defence with a hole arrives whole.
 * - **Cluster** — dies into three Motes, converting one kill into an overwhelm
 *   problem somewhere further back down the route.
 * - **Bulwark** — flat armour on every hit. Punishes *many small hits*, which
 *   is the one thing the rest of the roster never asked about, and the reason
 *   Lance-plus-Singularity could clear every seed without losing a life.
 *
 * **`leakDamage` is 1 on all six and is meant to stay that way.** The field
 * exists so a *sortie* can weigh more than the contact it is drawn from — see
 * `SORTIES` in `content/sorties.ts`, which bakes its own weight in at spawn the
 * way `scaledStats` bakes in hp. Making a Monolith cost three lives everywhere
 * would be a campaign balance change, and `hpGrowth` is a swept number with a
 * table of evidence behind it. The duel does not get to relitigate the arc.
 */
export const ENEMIES = {
  drifter: {
    id: 'drifter',
    name: 'Drifter',
    hp: 20,
    speed: 1.8,
    bounty: 6,
    radius: 0.3,
    leakDamage: 1,
    armor: 0,
    shield: 0,
    shieldRegenDelay: 0,
    shieldRegenRate: 0,
    slowResist: 0,
    splitInto: null,
  },

  mote: {
    id: 'mote',
    name: 'Mote',
    hp: 7,
    speed: 2.9,
    bounty: 2,
    radius: 0.17,
    leakDamage: 1,
    armor: 0,
    shield: 0,
    shieldRegenDelay: 0,
    shieldRegenRate: 0,
    slowResist: 0,
    // Must stay null: Cluster splits into Motes, and a Mote that split in turn
    // would never terminate.
    splitInto: null,
  },

  monolith: {
    id: 'monolith',
    name: 'Monolith',
    hp: 150,
    speed: 0.85,
    bounty: 34,
    radius: 0.46,
    leakDamage: 1,
    armor: 0,
    shield: 0,
    shieldRegenDelay: 0,
    shieldRegenRate: 0,
    slowResist: 0,
    splitInto: null,
  },

  warden: {
    id: 'warden',
    name: 'Warden',
    hp: 26,
    speed: 1.5,
    bounty: 14,
    radius: 0.33,
    leakDamage: 1,
    armor: 0,
    shield: 30,
    shieldRegenDelay: 2.2,
    shieldRegenRate: 14,
    slowResist: 0,
    splitInto: null,
  },

  cluster: {
    id: 'cluster',
    name: 'Cluster',
    hp: 44,
    speed: 1.3,
    bounty: 12,
    radius: 0.4,
    leakDamage: 1,
    armor: 0,
    shield: 0,
    shieldRegenDelay: 0,
    shieldRegenRate: 0,
    slowResist: 0,
    splitInto: { enemy: 'mote', count: 3 },
  },

  bulwark: {
    id: 'bulwark',
    name: 'Bulwark',
    // Deliberately not a second Monolith. Monolith is a wall of hull that any
    // sustained damage eventually grinds down; a Bulwark's hull is ordinary and
    // the plating is the whole problem, so the answer is a bigger hit rather
    // than more time on target. Moderate hp is what keeps those two distinct.
    // Low on purpose, and lower than it first shipped. Hull scales with the
    // wave and armour does not, so a beefy armoured contact compounds two
    // difficulties and by wave 9 is unkillable by anything but Nova — which is
    // just the old dominance with a different station on top. Keeping hull near
    // Drifter's leaves armour as the only question it asks.
    hp: 26,
    speed: 1.4,
    bounty: 18,
    radius: 0.38,
    leakDamage: 1,
    // Nova's 21 keeps 76% of its hit, Lance's 8 keeps 38%, and Singularity's 3
    // floors out. "Bad, not useless" is the target for Lance — it should be the
    // wrong tool here, not a wasted purchase.
    //
    // Nova was 22 and kept 77%. It is still the heavy-hit answer here, and no
    // longer the only one: Solvent strips the plating rather than out-hitting
    // it, which is what made trimming Nova affordable at all.
    //
    // Note what this does to upgrades. A Mk III Lance hits for 18 and keeps
    // 72%, so armour roughly doubles what upgrading is worth and makes it beat
    // adding another tower — the reverse of this game's usual pull toward
    // coverage. The sweep cannot see that: its builder only ever spreads.
    armor: 5,
    shield: 0,
    shieldRegenDelay: 0,
    shieldRegenRate: 0,
    slowResist: 0,
    splitInto: null,
  },
  ironclad: {
    id: 'ironclad',
    name: 'Ironclad',
    // **Hull deliberately near a Drifter's**, and the note on Bulwark above is
    // the reason: hull scales with the wave and armour does not, so a heavy
    // armoured contact compounds two difficulties and ends up unkillable by
    // anything but one station. Keeping the hull ordinary leaves the plating as
    // the only question it asks — it just asks it much louder than Bulwark.
    hp: 40,
    speed: 1.1,
    bounty: 26,
    radius: 0.42,
    leakDamage: 1,
    // At 11, Nova's shot keeps about half, Lance's floors, and a Filament may as
    // well not be firing. Solvent at Mk I leaves 7 and at Mk III leaves 3, which
    // is the point of it: the answer is not a bigger gun, it is turning the guns
    // you already have back on.
    armor: 11,
    shield: 0,
    shieldRegenDelay: 0,
    shieldRegenRate: 0,
    slowResist: 0,
    splitInto: null,
  },

  aegis: {
    id: 'aegis',
    name: 'Aegis',
    hp: 30,
    speed: 1.25,
    bounty: 22,
    radius: 0.36,
    leakDamage: 1,
    armor: 0,
    // Warden is 30 shield on a 2.2s delay at 14/s. This is half again as much
    // on a delay short enough that the gap which hands a Warden its shield back
    // hands this one *all* of it — Warden punishes thin coverage, Aegis punishes
    // any coverage that is not continuous.
    //
    // **Shield scales with hp per wave**, so 45 is roughly 339 effective by wave
    // 10. That compounding is why this is the number most likely to be wrong and
    // the first one to move if the arc gets ugly late.
    shield: 45,
    shieldRegenDelay: 1.4,
    shieldRegenRate: 26,
    slowResist: 0,
    splitInto: null,
  },

  skimmer: {
    id: 'skimmer',
    name: 'Skimmer',
    hp: 16,
    speed: 3.4,
    bounty: 8,
    radius: 0.2,
    leakDamage: 1,
    armor: 0,
    shield: 0,
    shieldRegenDelay: 0,
    shieldRegenRate: 0,
    // **The cheap half of a flyer.** What a flying contact is actually *for* is
    // being the one your slow-and-pierce line cannot hold; that is this field,
    // and it costs one multiplication in `applySlow`. Real flight would cost
    // `progress` its meaning, and `first` targeting ranks every contact by
    // `progress` — plus a painted lane on all eight boards, plus an air/ground
    // axis through four separate loops. It is a milestone, not a contact.
    //
    // It is also the second axis on which the roster's original degenerate pair
    // is weak. A slow bunches contacts into a file and pierce is worth more the
    // longer the file, so those two manufacture each other's best case. Armour
    // was the first answer to that; this is the second, for one line.
    slowResist: 1,
    splitInto: null,
  },
} as const satisfies Record<string, EnemyDef>;

export type EnemyId = keyof typeof ENEMIES;

export const ENEMY_IDS = Object.keys(ENEMIES) as EnemyId[];
