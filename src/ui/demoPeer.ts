/**
 * A fake opponent, so the versus column can be looked at without a second
 * player.
 *
 * **Development only.** `main.ts` reaches this behind `import.meta.env.DEV`
 * and a dynamic import, so the module is not in a production bundle at all —
 * not dead-stripped, not shipped and gated, simply absent. That is the whole
 * safety argument, and it is why this file may invent numbers when nothing
 * else in the codebase may: there is no path from a real match to this code.
 *
 * It exists because the opponent panel and the exchange strip are the two
 * surfaces of the versus HUD that cannot be reviewed alone. Everything else in
 * the mode renders from the local world; these two render from a peer's status
 * blob, so solo versus shows an empty column and there is nothing to critique.
 * Getting to them otherwise means running the relay and driving two browsers,
 * which is a lot of ceremony for looking at a panel.
 *
 * **Everything here is a lie and says so.** The opponent is named so it cannot
 * be mistaken for a person, and the panel carries a badge. The one thing that
 * is not invented is the *shape* of the data: this drives `RaceHud` through
 * exactly the interface `MatchController` drives it through, so a panel that
 * looks right here is a panel that will look right on a real blob.
 */
import { SORTIE_IDS } from '../content/sorties.ts';
import { TOWER_IDS } from '../content/towers.ts';
import type { RaceStatus } from '../net/MatchController.ts';
import type { TowerPin } from '../net/protocol.ts';
import type { MapDef } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { createRaceHud, type RaceHud } from './raceHud.ts';

/** Seeded, so a reload shows the same fake match rather than a new one. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Every tile a station could stand on, which is where the pins go.
 *
 * Pinning at random would put half the opponent's board on their own road, and
 * the minimap would then be teaching a layout that is not legal — the one thing
 * a panel about "what they've built" must not do.
 */
function buildable(map: MapDef): { c: number; r: number }[] {
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      if (map.tiles[r * map.cols + c] === 'ground') out.push({ c, r });
    }
  }
  return out;
}

export interface DemoPeer {
  stop(): void;
}

export function startDemoPeer(mount: HTMLElement, hudRoot: HTMLElement, world: World): DemoPeer {
  const map = world.map;
  const rand = rng(world.seed ^ 0x5eed);
  const spots = buildable(map);

  const hud: RaceHud = createRaceHud(
    mount,
    // Named so nobody reads it as a real seat. The panel is a mock-up and the
    // label is the disclosure.
    'DEMO PEER',
    'DEMO',
    map,
    undefined,
    hudRoot,
  );

  const pins: TowerPin[] = [];
  let sinceBuild = 0;
  let sinceIncoming = 0;
  let sinceSent = 0;
  const startedAt = performance.now();

  // 2Hz, matching the cadence a real status blob arrives at — so the panel is
  // reviewed at the refresh rate it will actually live at, including how stale
  // a static minimap looks between frames.
  const tick = setInterval(() => {
    sinceBuild++;
    sinceIncoming++;
    sinceSent++;

    // They build roughly every four seconds, and occasionally upgrade instead.
    if (sinceBuild >= 8 && spots.length > 0) {
      sinceBuild = 0;
      const grow = pins.length > 3 && rand() < 0.4;
      if (grow) {
        const hit = pins[Math.floor(rand() * pins.length)];
        if (hit !== undefined && hit.tier < 3) hit.tier++;
      } else {
        const at = spots[Math.floor(rand() * spots.length)];
        const k = TOWER_IDS[Math.floor(rand() * TOWER_IDS.length)];
        if (at !== undefined && k !== undefined && !pins.some((p) => p.c === at.c && p.r === at.r)) {
          pins.push({ c: at.c, r: at.r, k, tier: 1 });
        }
      }
    }

    // Their standing is derived from ours with a drift, so the pill has
    // something true-shaped to say and moves between ahead / level / behind
    // while you watch it rather than sitting on one word.
    const drift = Math.sin((performance.now() - startedAt) / 24_000);
    const status: RaceStatus = {
      wave: Math.max(0, world.wave.clearedThrough + Math.round(drift * 1.6)),
      lives: Math.max(0, Math.min(20, world.lives + Math.round(drift * 3))),
      elapsedMs: performance.now() - startedAt,
      era: world.era,
      towers: pins.slice(),
    };
    hud.peer(status);
    hud.own({
      wave: world.wave.clearedThrough,
      lives: world.lives,
      elapsedMs: performance.now() - startedAt,
      era: world.era,
    });

    // Traffic both ways, so both rows of the exchange fill and the recency
    // ramp is visible. Offset from each other so the two rows never march in
    // step, which would read as one event drawn twice.
    if (sinceIncoming >= 11) {
      sinceIncoming = 0;
      const id = SORTIE_IDS[Math.floor(rand() * Math.min(3, SORTIE_IDS.length))];
      if (id !== undefined) hud.incoming(id, Math.floor(rand() * map.routes.length));
    }
    if (sinceSent >= 17) {
      sinceSent = 0;
      const id = SORTIE_IDS[Math.floor(rand() * Math.min(3, SORTIE_IDS.length))];
      if (id !== undefined) hud.sent(id, Math.floor(rand() * map.routes.length));
    }
  }, 500);

  hud.peerConn(true);

  return {
    stop() {
      clearInterval(tick);
      hud.remove();
    },
  };
}
