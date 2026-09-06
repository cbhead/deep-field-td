import type { EnemyId } from '../content/enemies.ts';
import type { SectorFieldId } from '../content/sectors.ts';
import type { TowerId } from '../content/towers.ts';
import type { SoundSpec } from './engine.ts';

/**
 * Every sound in the game, in one file.
 *
 * The audio sibling of `theme.ts`, and it exists for the same stated reason:
 * retuning how the game sounds should be a one-file diff rather than a hunt
 * through the code that decides when things happen. `soundscape.ts` chooses
 * *when*; this file is only ever *what*.
 *
 * ---
 *
 * **The rule that shapes every number below: each station owns a frequency
 * band.**
 *
 * `theme.ts` says of the tower colours — "a fourth blue would be unreadable in
 * a crowd; these have to separate at a glance and at 13px". That is the same
 * sentence this file obeys with the nouns swapped. Five stations that all
 * sounded like a mid-range click would be one indistinguishable noise at
 * twenty-five of them, however nice each was alone. So the bands are assigned
 * apart first and the character is designed inside the band it was given:
 *
 * | Station     | Band          | Why that band                            |
 * |-------------|---------------|------------------------------------------|
 * | Nova        | 80–150 Hz     | The only low end in the game. It fires    |
 * |             |               | every 1.4s, so it is the one station      |
 * |             |               | that can afford weight without mudding.   |
 * | Filament    | 140 Hz–1.1 kHz| Sustained burn. Opens; never rises in pitch. |
 * | Singularity | 150–400 Hz    | Sustained, below the shots, above Nova.   |
 * | Lance       | 2–3 kHz       | Tight, dry, the workhorse transient.      |
 * | Arc         | 4–8 kHz       | Bright crackle, clear of everything else. |
 *
 * **Nothing sustained may sit in 2–5 kHz.** That is where the ear is most
 * sensitive, which makes it the band transients are cheap in and drones are
 * ruinous in: a one-shot there is a crisp tick, and a continuous voice there is
 * the only thing anyone can hear. Filament was originally written into it and
 * had to be moved out — the full account is on `syncStations` in
 * `soundscape.ts`, and it is the mistake most worth not repeating.
 *
 * **Judge every one of these at twenty-five stations, never solo.** A sound
 * tuned alone is invariably too long and too loud, and it is not discoverable
 * until the board fills.
 *
 * **Decays are short, and that is load-bearing.** Anything firing above about
 * once a second dies inside 150ms. Tails are what turn density into wash: two
 * long sounds overlap into a third sound nobody designed, and twenty of them
 * are a wall. The one long decay in the combat set belongs to Nova, which
 * earns it by being rare.
 */

/** Priority bands. A shot must never interrupt a payoff. */
const P = {
  shot: 1,
  hit: 2,
  kill: 5,
  bigKill: 6,
  blast: 5,
  ui: 7,
  /** Leaks, defeat, victory. Nothing outranks the run ending. */
  alarm: 9,
} as const;

// ---------------------------------------------------------------------------
// Stations — firing
//
// Only three stations appear here. Singularity and Filament are *sustained*
// voices driven from world state in `soundscape.ts`, not one-shots: both fire
// faster than the ear resolves separate events (0.28s and 0.25s), so playing
// them per-shot would spend the entire voice budget producing a buzz. Making
// them continuous is what buys the headroom the other three spend.
//
// Nova is also absent as a *launch* sound. Its payoff is the detonation, which
// already arrives as a `blast` event carrying its true radius; a launch thump
// on top would double the low end of the one station allowed to have any.
// ---------------------------------------------------------------------------

export const FIRE: Partial<Record<TowerId, SoundSpec>> = {
  /**
   * A dry tick with a fast downward sweep. The sweep is the pierce: a shot that
   * passes through things should sound like it is going somewhere, and a flat
   * blip sounds like it stopped at the muzzle.
   */
  lance: {
    layers: [
      {
        kind: 'noise',
        freq: 2600,
        gain: 0.22,
        attack: 0.001,
        decay: 0.035,
        filter: { type: 'bandpass', freq: 2600, q: 2.2, freqEnd: 1700 },
      },
      {
        kind: 'tone',
        wave: 'triangle',
        freq: 2400,
        freqEnd: 1500,
        gain: 0.1,
        attack: 0.001,
        decay: 0.045,
      },
    ],
    priority: P.shot,
    bus: 'shots',
    pitchJitter: 0.045,
    gainJitter: 0.15,
  },

  /**
   * Bright crackle, high and thin.
   *
   * Landed chain damage replays this quieter on top of the report (see
   * `CHAIN_FALLOFF`), so a chain that is actually finding contacts sounds
   * busier than one firing into an empty stretch. That is texture proportional
   * to hops, not an exact count of them — the honest claim, and enough to make
   * "are my Arcs reaching anything" audible.
   */
  arc: {
    layers: [
      {
        kind: 'noise',
        freq: 6000,
        gain: 0.18,
        attack: 0.001,
        decay: 0.05,
        filter: { type: 'bandpass', freq: 6000, q: 1.4, freqEnd: 4200 },
      },
      {
        kind: 'tone',
        wave: 'square',
        freq: 5200,
        freqEnd: 3600,
        gain: 0.05,
        attack: 0.001,
        decay: 0.03,
      },
    ],
    priority: P.shot,
    bus: 'shots',
    pitchJitter: 0.07,
    gainJitter: 0.2,
  },

  // --------------------------------------------------------------------------
  // The five new stations that shoot. Salvage is absent because it never fires,
  // the same reason Singularity and Filament are absent above — except they are
  // continuous voices and this one is genuinely silent.
  //
  // Every decay here is under 60ms. That is not caution, it is the table's rule:
  // twelve stations is exactly the density the "tuned alone, invariably too long"
  // warning at the top of this file is about.

  /**
   * A hiss with the pitch falling away — something being eaten rather than
   * struck. It fires every 0.35s, which is close to the rate at which one-shots
   * stop resolving as separate events, so it is the shortest and quietest thing
   * in the combat set.
   */
  solvent: {
    layers: [
      {
        kind: 'noise',
        freq: 9000,
        gain: 0.09,
        attack: 0.001,
        decay: 0.022,
        filter: { type: 'bandpass', freq: 9000, q: 1.1, freqEnd: 6000 },
      },
    ],
    priority: P.shot,
    bus: 'shots',
    pitchJitter: 0.08,
    gainJitter: 0.22,
  },

  /** A hard crack, sharp on the front. Glass, not metal — it breaks shields. */
  breaker: {
    layers: [
      {
        kind: 'noise',
        freq: 950,
        gain: 0.2,
        attack: 0.001,
        decay: 0.04,
        filter: { type: 'bandpass', freq: 950, q: 2.6, freqEnd: 700 },
      },
      {
        kind: 'tone',
        wave: 'sine',
        freq: 905,
        freqEnd: 620,
        gain: 0.11,
        attack: 0.001,
        decay: 0.05,
      },
    ],
    priority: P.shot,
    bus: 'shots',
    pitchJitter: 0.05,
    gainJitter: 0.16,
  },

  /** An ignition: a short breath of noise over a tone that opens upward. */
  ember: {
    layers: [
      {
        kind: 'noise',
        freq: 1900,
        gain: 0.13,
        attack: 0.004,
        decay: 0.055,
        filter: { type: 'bandpass', freq: 1900, q: 1.3, freqEnd: 2600 },
      },
      {
        kind: 'tone',
        wave: 'square',
        freq: 1700,
        freqEnd: 2100,
        gain: 0.07,
        attack: 0.003,
        decay: 0.045,
      },
    ],
    priority: P.shot,
    bus: 'shots',
    pitchJitter: 0.06,
    gainJitter: 0.18,
  },

  /**
   * A low shove. The one new station allowed any weight at all, and it earns it
   * the way Nova earns its low end — by firing every 1.6s, the slowest gun here.
   */
  repulsor: {
    layers: [
      {
        kind: 'tone',
        wave: 'sine',
        freq: 452,
        freqEnd: 300,
        gain: 0.2,
        attack: 0.002,
        decay: 0.075,
      },
      {
        kind: 'noise',
        freq: 520,
        gain: 0.1,
        attack: 0.001,
        decay: 0.035,
        filter: { type: 'lowpass', freq: 700, q: 0.9 },
      },
    ],
    priority: P.shot,
    bus: 'shots',
    pitchJitter: 0.04,
    gainJitter: 0.14,
  },

  /**
   * One report for the trigger, not one per shot — `towerFired` is emitted once
   * per pull however many contacts a Mk III Sentinel picked up. A sound per
   * target would make it loudest exactly when the board is worst, which is
   * backwards, and this is the station a player listens for.
   */
  sentinel: {
    layers: [
      {
        kind: 'noise',
        freq: 3600,
        gain: 0.16,
        attack: 0.001,
        decay: 0.038,
        filter: { type: 'bandpass', freq: 3600, q: 1.8, freqEnd: 2600 },
      },
    ],
    priority: P.shot,
    bus: 'shots',
    pitchJitter: 0.065,
    gainJitter: 0.2,
  },
};

/** How much quieter landed chain damage is than the report that started it. */
export const CHAIN_FALLOFF = 0.6;

/**
 * The bed's root note per sector, in Hz.
 *
 * Low enough to sit under everything — these are the fundamentals of a drone,
 * not a melody. Sectors differ by a small interval rather than a dramatic one:
 * the bed should make a board feel like a *place*, and eight obviously
 * different keys would make switching sectors feel like switching games.
 *
 * The five multi-lane sectors sit a step under the board they share a palette
 * with, so the campaign descends as it goes rather than wandering. Deliberately
 * *not* a new key each: eight roots inside one octave would stop being a place
 * and start being a scale.
 */
export const BED_ROOT: Record<SectorFieldId, number> = {
  switchback: 55,
  /** A fourth up — the long board, and the brightest of the first three fields. */
  cascade: 73.4,
  /** A minor third below Cascade, for the sector that closes from both sides. */
  pincer: 61.7,

  /** A tone under Switchback, whose violet Fork steps down from. */
  fork: 49,
  /** A tone under Cascade, matching the same step in the field. */
  delta: 65.4,
  /** A tone under Pincer, for the tightest board in the campaign. */
  braid: 55,
  /** Lower again: the darkest cyan field gets the darkest cyan root. */
  sluice: 58.3,
  /** The floor. The finale sits deepest, under everything before it. */
  crown: 43.7,

  /**
   * A tone *above* Pincer, whose teal Front Line steps up from.
   *
   * The one root that rises, for the same reason its field does: the campaign
   * is a descent and versus is not part of it. A board that opened on Crown's
   * floor would sound like the end of something at the moment two people are
   * starting.
   */
  frontline: 65.4,
};

/**
 * The detonation. The game's low-end anchor and the sound that does most of the
 * "significant firepower" work — it ducks the shot bus hard so it lands in a
 * hole rather than fighting the fire it arrives on top of.
 */
export const BLAST: SoundSpec = {
  layers: [
    {
      kind: 'noise',
      freq: 320,
      gain: 0.5,
      attack: 0.002,
      decay: 0.22,
      filter: { type: 'lowpass', freq: 900, q: 0.8, freqEnd: 160 },
    },
    {
      kind: 'tone',
      wave: 'sine',
      freq: 130,
      freqEnd: 52,
      gain: 0.55,
      attack: 0.002,
      decay: 0.2,
    },
  ],
  priority: P.blast,
  bus: 'impacts',
  pitchJitter: 0.07,
  gainJitter: 0.1,
  duck: 0.55,
};

// ---------------------------------------------------------------------------
// Contacts — deaths
//
// Deliberately unequal. A Cascade wave can put 54 Motes on the board and a
// Switchback run sees three Monoliths, so giving both the same prominence would
// bury the rare, expensive kill under the constant cheap one. Prominence tracks
// how much the kill *means*, not how much hit points it removed.
// ---------------------------------------------------------------------------

export const DEATH: Record<EnemyId, SoundSpec> = {
  /** Baseline. Everything else is defined as a departure from this. */
  drifter: {
    layers: [
      {
        kind: 'noise',
        freq: 1100,
        gain: 0.3,
        attack: 0.002,
        decay: 0.13,
        filter: { type: 'bandpass', freq: 1100, q: 1, freqEnd: 420 },
      },
      { kind: 'tone', wave: 'triangle', freq: 420, freqEnd: 150, gain: 0.16, attack: 0.002, decay: 0.11 },
    ],
    priority: P.kill,
    bus: 'impacts',
    pitchJitter: 0.08,
    gainJitter: 0.15,
    duck: 0.2,
  },

  /**
   * Near-silent, and coalesced harder than anything else in the game. Motes die
   * dozens at a time; the swarm should read as spray clearing, which is one
   * texture, not fifty events. `theme.ts` calls the Mote "spray, not
   * individuals" about its colour — this is that sentence about its sound.
   */
  mote: {
    layers: [
      {
        kind: 'noise',
        freq: 3400,
        gain: 0.12,
        attack: 0.001,
        decay: 0.045,
        filter: { type: 'bandpass', freq: 3400, q: 1.8, freqEnd: 2200 },
      },
    ],
    priority: P.hit,
    bus: 'impacts',
    pitchJitter: 0.12,
    gainJitter: 0.25,
  },

  /**
   * The most satisfying kill in the game, and it should be. 150 hp, worth 34,
   * and you see maybe three in a run — this is the one place a long decay and
   * real low end are unambiguously earned.
   */
  monolith: {
    layers: [
      {
        kind: 'noise',
        freq: 400,
        gain: 0.45,
        attack: 0.004,
        decay: 0.42,
        filter: { type: 'lowpass', freq: 700, q: 0.9, freqEnd: 110 },
      },
      { kind: 'tone', wave: 'sine', freq: 150, freqEnd: 42, gain: 0.5, attack: 0.004, decay: 0.4 },
      { kind: 'tone', wave: 'triangle', freq: 300, freqEnd: 90, gain: 0.2, attack: 0.004, decay: 0.3 },
    ],
    priority: P.bigKill,
    bus: 'impacts',
    pitchJitter: 0.05,
    gainJitter: 0.08,
    duck: 0.7,
  },

  /** Cool and glassy, matching the shield family it belongs to. */
  warden: {
    layers: [
      {
        kind: 'noise',
        freq: 2400,
        gain: 0.28,
        attack: 0.002,
        decay: 0.16,
        filter: { type: 'bandpass', freq: 2400, q: 1.6, freqEnd: 900 },
      },
      { kind: 'tone', wave: 'sine', freq: 900, freqEnd: 300, gain: 0.16, attack: 0.002, decay: 0.14 },
    ],
    priority: P.kill,
    bus: 'impacts',
    pitchJitter: 0.07,
    gainJitter: 0.15,
    duck: 0.25,
  },

  /**
   * **Rises, and does not resolve.** The one death in the game that makes things
   * worse, so it must not sound like a reward.
   *
   * `effects.ts` had to solve exactly this problem visually — a Cluster killed
   * at the front of the route looked identical to any other kill, so the player
   * found out three Motes later. It fixed it with counted pips. This is the same
   * fix in the same place: an upward, unresolved sweep reads as a question, and
   * every other kill in this table falls.
   */
  cluster: {
    layers: [
      { kind: 'tone', wave: 'triangle', freq: 300, freqEnd: 760, gain: 0.3, attack: 0.004, decay: 0.2 },
      {
        kind: 'noise',
        freq: 1600,
        gain: 0.16,
        attack: 0.002,
        decay: 0.14,
        filter: { type: 'bandpass', freq: 1200, q: 1.2, freqEnd: 2600 },
      },
    ],
    priority: P.bigKill,
    bus: 'impacts',
    pitchJitter: 0.04,
    gainJitter: 0.1,
    duck: 0.4,
  },

  /** Metallic and hard-edged, to match plating that subtracts from every hit. */
  bulwark: {
    layers: [
      {
        kind: 'noise',
        freq: 1800,
        gain: 0.32,
        attack: 0.001,
        decay: 0.12,
        filter: { type: 'bandpass', freq: 1800, q: 3.2, freqEnd: 800 },
      },
      { kind: 'tone', wave: 'square', freq: 520, freqEnd: 190, gain: 0.12, attack: 0.001, decay: 0.1 },
    ],
    priority: P.kill,
    bus: 'impacts',
    pitchJitter: 0.06,
    gainJitter: 0.15,
    duck: 0.3,
  },

  // The three below are each written as a *departure from* the contact they
  // share a question with, so the roster still sorts into families by ear the
  // way it does by eye — plated, protected, swarm.

  /** Bulwark's crack, lower and longer. More plate to get through. */
  ironclad: {
    layers: [
      {
        kind: 'noise',
        freq: 1300,
        gain: 0.36,
        attack: 0.001,
        decay: 0.18,
        filter: { type: 'bandpass', freq: 1300, q: 3.4, freqEnd: 520 },
      },
      { kind: 'tone', wave: 'square', freq: 380, freqEnd: 130, gain: 0.15, attack: 0.001, decay: 0.15 },
    ],
    priority: P.kill,
    bus: 'impacts',
    pitchJitter: 0.05,
    gainJitter: 0.14,
    duck: 0.35,
  },

  /** Warden's glassy end, brighter and with more of it to break. */
  aegis: {
    layers: [
      {
        kind: 'noise',
        freq: 2600,
        gain: 0.28,
        attack: 0.001,
        decay: 0.14,
        filter: { type: 'bandpass', freq: 2600, q: 2.4, freqEnd: 1100 },
      },
      { kind: 'tone', wave: 'triangle', freq: 780, freqEnd: 260, gain: 0.13, attack: 0.002, decay: 0.12 },
    ],
    priority: P.kill,
    bus: 'impacts',
    pitchJitter: 0.07,
    gainJitter: 0.16,
    duck: 0.25,
  },

  /**
   * A Mote's tick, higher and shorter still. These arrive in numbers and at
   * speed, so this is the one death in the game that has to be nearly nothing —
   * see the density warning at the top of this file.
   */
  skimmer: {
    layers: [
      {
        kind: 'noise',
        freq: 4600,
        gain: 0.1,
        attack: 0.001,
        decay: 0.03,
        filter: { type: 'bandpass', freq: 4600, q: 2, freqEnd: 3000 },
      },
    ],
    priority: P.hit,
    bus: 'impacts',
    pitchJitter: 0.14,
    gainJitter: 0.25,
  },
};

/** The overshield giving way. Glassy, and clearly *not* a kill. */
export const SHIELD_BROKE: SoundSpec = {
  layers: [
    {
      kind: 'noise',
      freq: 5200,
      gain: 0.22,
      attack: 0.001,
      decay: 0.17,
      filter: { type: 'bandpass', freq: 5200, q: 2.4, freqEnd: 3000 },
    },
    { kind: 'tone', wave: 'sine', freq: 1900, freqEnd: 1200, gain: 0.12, attack: 0.001, decay: 0.15 },
  ],
  priority: P.kill,
  bus: 'impacts',
  pitchJitter: 0.05,
  gainJitter: 0.12,
};

/**
 * A contact reached the end. Low, wrong, and unmissable — this is the audio
 * counterpart of the screen-edge rim flare, and it exists for the same reason:
 * it is the signal you need to catch while looking somewhere else.
 */
export const LEAK: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sawtooth', freq: 190, freqEnd: 70, gain: 0.4, attack: 0.005, decay: 0.5 },
    {
      kind: 'noise',
      freq: 300,
      gain: 0.2,
      attack: 0.005,
      decay: 0.45,
      filter: { type: 'lowpass', freq: 500, q: 1.4, freqEnd: 160 },
    },
  ],
  priority: P.alarm,
  bus: 'impacts',
  pitchJitter: 0.02,
  duck: 0.85,
};

/** A Cluster breaking apart. Short, and pitched to the children that follow. */
export const SPLIT: SoundSpec = {
  layers: [
    {
      kind: 'noise',
      freq: 2800,
      gain: 0.2,
      attack: 0.001,
      decay: 0.09,
      filter: { type: 'bandpass', freq: 2200, q: 1.4, freqEnd: 3600 },
    },
  ],
  priority: P.hit,
  bus: 'impacts',
  pitchJitter: 0.08,
  gainJitter: 0.15,
};

// ---------------------------------------------------------------------------
// Interface
//
// All on the `ui` bus, which is never ducked. A click that goes quiet because
// a wave happens to be dying is a click the player reads as a dropped input.
// ---------------------------------------------------------------------------

/**
 * Arming a station in the deck, pitched into that station's own band — so
 * selecting one previews the voice it will have on the board, and the twelve are
 * told apart by ear before anything is built.
 */
export const SELECT: Record<TowerId, SoundSpec> = {
  lance: uiBlip(2400, 'triangle'),
  nova: uiBlip(160, 'sine'),
  singularity: uiBlip(320, 'sine'),
  arc: uiBlip(5000, 'square'),
  filament: uiBlip(1200, 'triangle'),
  // 640, and the first guess of 220 was wrong in exactly the way its tint was.
  // It was placed low to stay clear of Singularity and landed *inside*
  // Singularity's own 150–400 Hz band, wedged between Nova at 160 and
  // Singularity at 320 — the most crowded stretch of this table.
  //
  // Overclock never fires, so it is the one station with no combat band to be
  // pitched into, and the only constraint left is that arming it is
  // distinguishable by ear from arming the other five. 320 → 1200 is the widest
  // gap in this table and 640 is its midpoint; square rather than sine keeps it
  // off the two neighbours below it, which are both sine.
  overclock: uiBlip(640, 'square'),

  // --------------------------------------------------------------------------
  // THE SIX ABOVE WERE, UNREMARKED, ALMOST AN OCTAVE LADDER: 160, 320, 640,
  // 1200, 2400, 5000. Doubling the roster is therefore not a hunt for six free
  // frequencies — it is halving the existing step. These are the ×√2 rungs
  // between them, and every one of the original six stays exactly where it was.
  //
  //   160  226  320  452  640  905  1200  1810  2400  3620  5000  7240
  //
  // The tightest neighbouring ratio in the merged table is 1.33 (905→1200 and
  // 1810→2400); everything else is 1.38–1.51. That is the whole reason twelve
  // rungs still separate by ear where six ad-hoc additions would not have.
  //
  // Waveforms alternate so no two adjacent rungs share one, which is what
  // carries the distinction where the pitch gap is narrowest. That is why
  // several of these are sine rather than the shape they would have had alone:
  // 452 and 905 each sit beside Overclock's square, and 3620 sits between
  // Lance's triangle and Arc's square.
  //
  // Salvage takes 226 and has no combat band at all — the same structural
  // position Overclock is in at 640. A station that never fires has no voice to
  // preview, so the only thing left to get right is that arming it is
  // distinguishable from arming anything else.
  salvage: uiBlip(226, 'triangle'),
  repulsor: uiBlip(452, 'sine'),
  breaker: uiBlip(905, 'sine'),
  ember: uiBlip(1810, 'square'),
  sentinel: uiBlip(3620, 'sine'),
  solvent: uiBlip(7240, 'triangle'),
};

function uiBlip(freq: number, wave: OscillatorType): SoundSpec {
  return {
    layers: [
      { kind: 'tone', wave, freq, freqEnd: freq * 1.18, gain: 0.16, attack: 0.002, decay: 0.06 },
    ],
    priority: P.ui,
    bus: 'ui',
    pitchJitter: 0.01,
  };
}

/** A station lands on the board. Two-note, downward: settled, placed, done. */
export const PLACED: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 620, freqEnd: 420, gain: 0.2, attack: 0.003, decay: 0.11 },
    {
      kind: 'noise',
      freq: 900,
      gain: 0.14,
      attack: 0.002,
      decay: 0.08,
      filter: { type: 'lowpass', freq: 1400, q: 1, freqEnd: 500 },
    },
  ],
  priority: P.ui,
  bus: 'ui',
  pitchJitter: 0.02,
};

/** A purchase that made something stronger. The one rising UI sound. */
export const UPGRADED: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'triangle', freq: 480, freqEnd: 960, gain: 0.2, attack: 0.004, decay: 0.16 },
    { kind: 'tone', wave: 'sine', freq: 960, freqEnd: 1440, gain: 0.1, attack: 0.02, decay: 0.14 },
  ],
  priority: P.ui,
  bus: 'ui',
  pitchJitter: 0.01,
};

/** Money back. Falling, and duller than the placement it undoes. */
export const SOLD: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 560, freqEnd: 260, gain: 0.17, attack: 0.003, decay: 0.14 },
  ],
  priority: P.ui,
  bus: 'ui',
  pitchJitter: 0.02,
};

/**
 * Refused — bad tile, no money, not unlocked yet. Deliberately soft and low
 * rather than a buzzer: this fires on stray clicks all the time, and a harsh
 * rejection sound is the single fastest way to make a game tiring to play.
 */
export const REJECTED: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 220, freqEnd: 165, gain: 0.14, attack: 0.004, decay: 0.09 },
  ],
  priority: P.ui,
  bus: 'ui',
};

/** A wave is inbound. Low, two-part, and not a fanfare — this happens 10 times a run. */
export const WAVE_STARTED: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 220, freqEnd: 330, gain: 0.24, attack: 0.01, decay: 0.3 },
    { kind: 'tone', wave: 'triangle', freq: 110, gain: 0.16, attack: 0.01, decay: 0.35 },
  ],
  priority: P.ui,
  bus: 'ui',
  pitchJitter: 0.01,
};

/** A wave settled. The small exhale between waves. */
export const WAVE_CLEARED: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 520, freqEnd: 780, gain: 0.2, attack: 0.01, decay: 0.28 },
    { kind: 'tone', wave: 'sine', freq: 780, freqEnd: 1040, gain: 0.1, attack: 0.06, decay: 0.26 },
  ],
  priority: P.ui,
  bus: 'ui',
};

/** Calling a wave in early. Brighter than a wave start: this one was a choice. */
export const WAVE_RUSHED: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'triangle', freq: 640, freqEnd: 1280, gain: 0.18, attack: 0.004, decay: 0.14 },
  ],
  priority: P.ui,
  bus: 'ui',
};

export const VICTORY: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 392, freqEnd: 587, gain: 0.26, attack: 0.02, decay: 0.9 },
    { kind: 'tone', wave: 'sine', freq: 587, freqEnd: 784, gain: 0.18, attack: 0.14, decay: 0.8 },
    { kind: 'tone', wave: 'triangle', freq: 196, gain: 0.14, attack: 0.02, decay: 1 },
  ],
  priority: P.alarm,
  bus: 'ui',
  duck: 0.9,
};

export const DEFEAT: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 330, freqEnd: 110, gain: 0.28, attack: 0.02, decay: 1.1 },
    { kind: 'tone', wave: 'sawtooth', freq: 165, freqEnd: 55, gain: 0.14, attack: 0.05, decay: 1 },
  ],
  priority: P.alarm,
  bus: 'ui',
  duck: 0.9,
};

// ---------------------------------------------------------------------------
// Race
//
// **Every cue here is quieter and lower than anything on your own board, and
// heavily filtered — as if heard through a wall.**
//
// The opponent strip is peripheral information. If an opponent cue can be
// mistaken for one of your own stations, it has actively cost the player
// something, because the board is where their attention needs to be. Nothing
// here reveals anything the race strip is not already showing.
// ---------------------------------------------------------------------------

export const RACE_START: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sine', freq: 294, freqEnd: 440, gain: 0.26, attack: 0.01, decay: 0.5 },
    { kind: 'tone', wave: 'triangle', freq: 147, gain: 0.16, attack: 0.01, decay: 0.6 },
  ],
  priority: P.ui,
  bus: 'ui',
};

/** The opponent cleared a wave. Distant, dull, and easy to ignore. */
export const RACE_OPPONENT_WAVE: SoundSpec = {
  layers: [
    {
      kind: 'tone',
      wave: 'sine',
      freq: 260,
      freqEnd: 340,
      gain: 0.075,
      attack: 0.02,
      decay: 0.24,
      filter: { type: 'lowpass', freq: 700, q: 0.7 },
    },
  ],
  priority: P.ui,
  bus: 'ui',
};

/**
 * You bought a contact and sent it. Versus only.
 *
 * Rising, where every other cue in this file that means "something is coming"
 * falls. That inversion is the whole design: a rise is the sound of something
 * *leaving*, and this is the one event in the game the player causes at the
 * far end of the board rather than on it. It has to be distinguishable from
 * `SORTIE_INBOUND` at a glance while the two can overlap — you can be sending
 * while one of theirs is arriving — and pitch direction separates them more
 * reliably at speed than timbre does.
 *
 * Quiet, and on the ui bus: sending is a purchase, and a purchase that shouted
 * would be exhausting at the rate this deck is pressed.
 */
export const SORTIE_SENT: SoundSpec = {
  layers: [
    {
      kind: 'tone',
      wave: 'triangle',
      freq: 262,
      freqEnd: 392,
      gain: 0.13,
      attack: 0.008,
      decay: 0.22,
      filter: { type: 'lowpass', freq: 1600, q: 0.9 },
    },
  ],
  priority: P.ui,
  bus: 'ui',
  pitchJitter: 0.03,
};

/**
 * One of theirs has entered your midfield.
 *
 * Falling, and pitched under the send so the pair reads as a question and an
 * answer. Louder than `SORTIE_SENT` because it is the only warning the mode
 * gives: their board is hidden, so without this a contact simply appears with
 * no account of where it came from.
 *
 * Deliberately *not* on the alarm band. It is news, not a breach — the breach
 * sound is `SORTIE_LANDED`, and spending the alarm here would leave nothing in
 * reserve for the moment it actually lands.
 */
export const SORTIE_INBOUND: SoundSpec = {
  layers: [
    {
      kind: 'tone',
      wave: 'triangle',
      freq: 349,
      freqEnd: 233,
      gain: 0.17,
      attack: 0.006,
      decay: 0.3,
      filter: { type: 'lowpass', freq: 1400, q: 0.9 },
    },
    {
      kind: 'noise',
      freq: 900,
      gain: 0.06,
      attack: 0.004,
      decay: 0.2,
      filter: { type: 'bandpass', freq: 900, q: 1.6, freqEnd: 500 },
    },
  ],
  priority: P.ui,
  bus: 'ui',
  pitchJitter: 0.04,
};

/**
 * A contact somebody *paid for* reached your core.
 *
 * `LEAK` with the bottom dropped further and a longer tail. It has to be the
 * same family — this is still a breach and the player has already learned what
 * a breach sounds like — while being unmistakably worse, because it is the one
 * kind of damage that had an author. It also lands for two or three lives at
 * once where an ordinary leak costs one, so a cue of the same weight would be
 * under-reporting.
 */
export const SORTIE_LANDED: SoundSpec = {
  layers: [
    { kind: 'tone', wave: 'sawtooth', freq: 165, freqEnd: 52, gain: 0.44, attack: 0.005, decay: 0.72 },
    {
      kind: 'noise',
      freq: 260,
      gain: 0.24,
      attack: 0.005,
      decay: 0.6,
      filter: { type: 'lowpass', freq: 420, q: 1.4, freqEnd: 120 },
    },
  ],
  priority: P.alarm,
  bus: 'impacts',
  pitchJitter: 0.02,
  duck: 0.9,
};

/** The lead changed hands. The one race cue allowed to actually interrupt you. */
export const RACE_LEAD_CHANGE: SoundSpec = {
  layers: [
    {
      kind: 'tone',
      wave: 'triangle',
      freq: 330,
      freqEnd: 494,
      gain: 0.15,
      attack: 0.01,
      decay: 0.34,
      filter: { type: 'lowpass', freq: 1200, q: 0.8 },
    },
  ],
  priority: P.ui,
  bus: 'ui',
};
