import { createRenderer } from './render/pixiApp.ts';
import { createTextures } from './render/textures.ts';
import { buildMapLayer } from './render/mapLayer.ts';
import { WorldView } from './render/worldView.ts';
import { Overlay } from './render/overlay.ts';
import { Effects } from './render/effects.ts';
import { TowerChrome } from './render/towerChrome.ts';
import { CreepChrome } from './render/creepChrome.ts';
import { tilesToPx } from './render/constants.ts';
import { applyHudTheme, fieldFor, DEFAULT_FIELD } from './render/theme.ts';
import { AudioEngine } from './audio/engine.ts';
import { Soundscape } from './audio/soundscape.ts';
import {
  RACE_LEAD_CHANGE,
  RACE_OPPONENT_WAVE,
  RACE_START,
  SORTIE_INBOUND,
} from './audio/palette.ts';
import { LEVEL01 } from './content/maps/level01.ts';
import { CAMPAIGN, VERSUS_LEVEL, levelById, levelIndex, type LevelDef } from './content/levels.ts';
import type { SortieId } from './content/sorties.ts';
import { DIFFICULTIES, DEFAULT_DIFFICULTY, type DifficultyId } from './content/difficulty.ts';
import { parseMap } from './sim/util/grid.ts';
import { hashSeed, formatSeed } from './sim/util/rng.ts';
import { DEFAULT_RULES, resolveRules, versusRules, type Rules } from './sim/rules.ts';
import { createWorld, type World } from './sim/world.ts';
import type { SimEvent } from './sim/types.ts';
import { grade } from './sim/analysis.ts';
import { visualTier } from './sim/build.ts';
import { recordRun } from './app/progress.ts';
import { createMenuScreen } from './ui/menuScreen.ts';
import { createHomeScreen } from './ui/homeScreen.ts';
import { trackKeyboardInset } from './ui/viewport.ts';
import { createLoop } from './app/loop.ts';
import { attachInput } from './app/input.ts';
import { createUiState } from './app/uiState.ts';
import { createHud, type CampaignPorts } from './ui/hud.ts';
import { planWave } from './sim/wavePlan.ts';
import { serverUrl } from './net/NetClient.ts';
import { relayHost } from './net/relay.ts';
import { MatchController } from './net/MatchController.ts';
import { createLobbyScreen } from './ui/lobbyScreen.ts';
import { createRaceHud, type RaceCues, type RaceHud } from './ui/raceHud.ts';
import { showResults } from './ui/resultsScreen.ts';
import { getWebhook, matchReport, postToDiscord } from './ui/discord.ts';
import { recordSeries, formatSeries } from './app/raceSeries.ts';

/**
 * The match seed comes from the URL so any run is reproducible: `?seed=hunter2`
 * turns "reproduce that bug" and "race the same board again" into free features.
 * In Race mode (phase 2) the server supplies this instead.
 */
function resolveSeed(): number {
  const raw = new URLSearchParams(location.search).get('seed');
  if (raw === null || raw === '') {
    // Presentation-layer randomness, so Math.random is correct here.
    return Math.floor(Math.random() * 0xffffffff) >>> 0;
  }
  const asInt = Number(raw);
  return Number.isInteger(asInt) && asInt >= 0 ? asInt >>> 0 : hashSeed(raw);
}

/**
 * Solo versus: your own sorties come straight back at you.
 *
 * The sim is deliberately blind to who is on the other end — `sortie` charges
 * a world and `inbound` spawns on one, and nothing in `sim/` knows whether
 * those are the same world. That is what makes this three lines: feed the
 * launch event back in as an arrival, and feed the landing back as a credit.
 *
 * It is a **balance harness, not a stub**. Playing both sides is how the sortie
 * economy gets tuned before any of the wire exists: every figure that matters —
 * what a send costs, what the defender earns for killing it, what it pays back
 * when it lands — is exercised exactly as it will be in a real match. The one
 * thing it cannot show is the tension of not knowing what is coming, and no
 * amount of local wiring would.
 *
 * V7 replaces this function with the relay and deletes nothing else.
 */
function localSortieRelay(world: World): (ev: SimEvent) => void {
  return (ev) => {
    if (ev.type === 'sortieLaunched') {
      world.commands.push({
        type: 'inbound',
        sortie: ev.sortie,
        lane: ev.lane,
        kickback: ev.kickback,
      });
    } else if (ev.type === 'sortieLanded') {
      world.commands.push({ type: 'creditSortie', amount: ev.kickback });
    }
  };
}

/** The HUD is text; 10Hz is indistinguishable from 60 and does a sixth the work. */
const HUD_INTERVAL_MS = 100;

// Before main(), not inside it: main is async and the stylesheet resolves every
// colour through these properties, so deferring them to the first await would
// paint an unstyled HUD.
applyHudTheme();

// Publishes --kb so a screen can pad itself clear of the on-screen keyboard.
// Cheap, idempotent, and needed before the first screen paints.
trackKeyboardInset();

async function main(): Promise<void> {
  const mount = document.getElementById('game-root');
  const hudRoot = document.getElementById('hud');
  // Full-viewport screens mount here, not on `mount`: #game-root is the board's
  // scaled box. See the comment on #screens in index.html.
  const screens = document.getElementById('screens');
  if (!mount || !hudRoot || !screens) {
    throw new Error('#game-root, #hud or #screens missing from index.html');
  }

  const params = new URLSearchParams(location.search);
  // `?versus` is `?race` with the mode flipped, and deliberately shares every
  // line below it: the lobby, room codes, the invite link, resume and forfeit
  // are all the same problem and were solved once. What differs is three
  // things — the rules the world boots with, where sorties go, and how the
  // server settles — and each is a branch on this one flag.
  const versusParam = params.get('versus');
  const isVersus = versusParam !== null;
  const race = isVersus ? versusParam : params.get('race');
  if (race === null) {
    await startSinglePlayer(mount, hudRoot, screens, params);
    return;
  }

  // `?race` opens the lobby, `?race=CODE` deep-links into a room. The host is
  // derived in one place — `net/relay.ts` — because the front door probes the
  // same relay this dials, and a probe aimed at a different port than the socket
  // is worse than no probe at all.
  const host = relayHost();

  let controller: MatchController;
  let raceHud: RaceHud | null = null;
  let opponentName = 'opponent';
  let currentRoom = '';
  let playerName = '';
  let matchSeed = 0;
  let matchSector = CAMPAIGN[0]!.name;
  // Serialized last-sent tower layout; '' forces a resend (fresh boot, or a
  // reconnect where the opponent may have missed frames).
  let sentPins = '';
  // The booted world, once there is one. Inbound sorties arrive on the socket
  // and have to reach it, and the socket is wired before the world exists.
  let liveWorld: World | null = null;

  // A rematch reloads the page with {name, room} stashed, then rejoins and
  // readies up without touching the form. Cleared immediately so a plain
  // reload never accidentally re-enters a room.
  const rejoinRaw = sessionStorage.getItem('race-rejoin');
  sessionStorage.removeItem('race-rejoin');
  const rejoin = rejoinRaw !== null ? (JSON.parse(rejoinRaw) as { name: string; room: string }) : null;

  const lobby = createLobbyScreen(screens, {
    ...(rejoin !== null ? { autoJoin: rejoin } : race === '' ? {} : { prefillRoom: race }),
    relayHost: host,
    ...(isVersus ? { mode: 'versus' as const } : {}),
    onReady: (ready) => controller.ready(ready),
    onSubmit: (name, room, choice) => {
      playerName = name;
      controller = new MatchController({
        url: serverUrl(host, location.protocol === 'https:'),
        name,
        ...(room === undefined ? {} : { room }),
        ...(choice === undefined ? {} : { choice }),
        ...(isVersus ? { mode: 'versus' as const } : {}),
        autoReady: rejoin !== null,
        hooks: {
          onLobby: (roomCode, players, level, diff) => {
            currentRoom = roomCode;
            opponentName = players.find((p) => p.playerId !== controller.playerId)?.name ?? 'opponent';
            lobby.showRoster(roomCode, players, controller.playerId, level, diff);
          },
          onCountdown: (ms, seed) => lobby.showCountdown(ms, seed),
          onError: (reason) => lobby.showError(reason),
          onPeer: (status) => raceHud?.peer(status),
          // The two hooks that make a match a match. Both push a command
          // rather than touching world state directly, so an arrival lands on
          // a tick boundary exactly like a click does — and re-validates the
          // same way, which matters because a credit can arrive after the run
          // it belongs to has already ended.
          onInbound: (sortie, lane, kickback) => {
            liveWorld?.commands.push({
              type: 'inbound',
              sortie: sortie as SortieId,
              lane,
              kickback,
            });
            raceHud?.incoming(sortie, lane);
          },
          onCredit: (amount) => {
            liveWorld?.commands.push({ type: 'creditSortie', amount });
          },
          onPeerConn: (connected) => raceHud?.peerConn(connected),
          onSelfConn: (connected) => {
            if (connected) sentPins = '';
            raceHud?.selfConn(connected);
          },
          onResult: (winnerId, standings, reason) => {
            const outcome = winnerId === null ? 't' : winnerId === controller.playerId ? 'w' : 'l';
            // The sector goes in too, so the front door can say what happened
            // rather than only how the rivalry stands.
            const series = formatSeries(
              opponentName,
              recordSeries(opponentName, outcome, matchSector),
            );
            showResults(screens, {
              myId: controller.playerId,
              winnerId,
              standings,
              ...(reason !== undefined ? { reason } : {}),
              sector: matchSector,
              room: currentRoom,
              seed: matchSeed,
              series,
              ...(isVersus ? { versus: true } : {}),
              onRematch: () => {
                sessionStorage.setItem('race-rejoin', JSON.stringify({ name: playerName, room: currentRoom }));
                location.reload();
              },
            });
            // Log the match to the shared channel — the webhook doubles as
            // the match ledger. Only browsers with a webhook configured post
            // (normally just the host's), so results arrive once.
            if (getWebhook() !== null) {
              void postToDiscord(
                matchReport(matchSector, currentRoom, matchSeed, winnerId, standings, reason === 'forfeit') +
                  `\n${series}`,
              ).then((ok) => {
                const log = document.getElementById('results-log');
                if (log) log.textContent = ok ? 'match logged to Discord ✓' : "couldn't log to Discord — check the webhook";
              });
            }
          },
          boot: (seed, levelId, diffId) => {
            matchSeed = seed;
            // The room's pick arrives unvalidated; unknown values fall back to
            // the baseline on BOTH clients, so a version-skewed pair still
            // plays the same board. Versus ignores the pick entirely — there
            // is one board, and letting a stale lobby choice send two players
            // to different maps is a failure with no upside.
            const level = isVersus ? VERSUS_LEVEL : (levelById(levelId) ?? CAMPAIGN[0]!);
            const difficulty: DifficultyId =
              Object.hasOwn(DIFFICULTIES, diffId) ? (diffId as DifficultyId) : DEFAULT_DIFFICULTY;
            matchSector = `${level.name} · ${DIFFICULTIES[difficulty].name}`;
            lobby.remove();
            void startGame(mount, hudRoot, seed, {
              level,
              rules: isVersus ? versusRules(level, difficulty) : resolveRules(level, difficulty),
              ...(isVersus
                ? {
                    // The relay stands in for the loopback: a launch goes out
                    // over the socket instead of straight back at us, and a
                    // landing is reported so the server can pay whoever sent it.
                    sortieRelay: (ev: SimEvent) => {
                      if (ev.type === 'sortieLaunched') {
                        controller.sendSortie(ev.sortie, ev.lane, ev.kickback);
                        // The exchange strip's "you" row. Mirrored locally
                        // rather than waiting for the relay to echo it back:
                        // nothing on the wire carries our own sends, and a
                        // record of what you did should not depend on the
                        // other end being reachable.
                        raceHud?.sent(ev.sortie, ev.lane);
                      } else if (ev.type === 'sortieLanded') {
                        controller.reportLanded(ev.kickback);
                      }
                    },
                  }
                : {}),
            }).then(({ world, raceCues, startRaceTone }) => {
              liveWorld = world;
              // `hudRoot` for the opponent column: it spans the whole stage, so
              // the column can dock beside the board instead of floating on it.
              raceHud = createRaceHud(
                mount,
                opponentName,
                currentRoom,
                world.map,
                raceCues,
                hudRoot,
              );
              startRaceTone();
              const bootAt = performance.now();
              sentPins = '';
              const sample = (): Parameters<typeof controller.finish>[0] => {
                const status: Parameters<typeof controller.finish>[0] = {
                  wave: world.wave.clearedThrough + 1,
                  lives: world.lives,
                  elapsedMs: Math.round(performance.now() - bootAt),
                  ...(document.hidden ? { hidden: true } : {}),
                  ...(isVersus ? { era: world.era } : {}),
                };
                // The layout rides along only when it changed — most frames
                // carry three numbers, a build frame carries the board.
                const pins = world.towers.map((t) => ({ c: t.col, r: t.row, k: t.defId, tier: visualTier(t) }));
                const enc = JSON.stringify(pins);
                if (enc !== sentPins) {
                  sentPins = enc;
                  status.towers = pins;
                }
                return status;
              };
              controller.startStatusPump(() => {
                const status = sample();
                raceHud?.own(status);
                // Defeat or full clear alike: report final figures once and
                // let the server settle the match when both runs are over.
                if (world.phase !== 'playing') controller.finish(status);
                return status;
              });
              // The pump is throttled in hidden tabs, so tell the opponent
              // immediately that our sim froze (and when it thawed).
              document.addEventListener('visibilitychange', () =>
                controller.client.send({ t: 'status', ...sample() }),
              );
            });
          },
        },
      });
      void controller.run();
    },
  });
}

/**
 * The single-player front door.
 *
 * Three entries, and the order matters. `?level=` plays a named campaign level;
 * `?seed=` alone still means "level 1 on this seed", which is what the plan
 * documented and what the fairness gate and every bug report already use — a
 * front door is not a reason to break a URL that works. Anything else opens the
 * menu.
 *
 * Navigation between levels goes through the URL rather than tearing the game
 * down in place, for the reason `restart` already reloads: a reload rebuilds the
 * world and every renderer pool with no chance of a stale reference surviving,
 * and it makes each run linkable for free.
 */
async function startSinglePlayer(
  mount: HTMLElement,
  hudRoot: HTMLElement,
  screens: HTMLElement,
  params: URLSearchParams,
): Promise<void> {
  const named = params.get('level');
  const level = named !== null ? levelById(named) : params.has('seed') ? CAMPAIGN[0] : undefined;

  if (level === undefined) {
    const menu = (): void => {
      createMenuScreen(screens, {
        onLaunch: (chosen, difficulty, seed) => {
          location.search = runQuery(chosen, difficulty, seed);
        },
        onRace: () => {
          location.search = '?race';
        },
      });
    };

    // The home screen sits ahead of the picker, so booting no longer lands on
    // a file dialog. `?sectors` skips it — the picker is still a place you can
    // link to, and Continue is a shortcut rather than a gate.
    if (params.has('sectors')) {
      menu();
      return;
    }

    const home = createHomeScreen(screens, {
      onPlay: (chosen, difficulty) => {
        location.search = runQuery(chosen, difficulty, '');
      },
      onCampaign: () => {
        home.destroy();
        menu();
      },
      onRace: () => {
        location.search = '?race';
      },
    });
    return;
  }

  const raw = params.get('difficulty');
  const difficulty: DifficultyId =
    raw !== null && Object.hasOwn(DIFFICULTIES, raw) ? (raw as DifficultyId) : DEFAULT_DIFFICULTY;

  // Front Line is not a sector: it has no place in the unlock chain, cannot be
  // cleared, and must not write campaign progress. `?level=versus` reaches it
  // because `levelById` resolves it, and this is where that stops being a
  // campaign run — without it `levelIndex` returns -1, `CAMPAIGN[0]` becomes
  // the "next sector", and a board that can only be lost would be offering to
  // advance to Switchback.
  const isVersus = level.id === VERSUS_LEVEL.id;

  const index = levelIndex(level.id);
  const nextLevel = isVersus ? undefined : CAMPAIGN[index + 1];

  /**
   * Money carried into this sector, and out of it.
   *
   * It rides in the URL alongside the level and difficulty, which gives the
   * retry path its behaviour for free: `restart` reloads the same URL, so
   * retrying a sector re-enters it with the bank it was *entered* with rather
   * than whatever was left when the run collapsed. Banking cannot be farmed by
   * dying repeatedly.
   */
  /*
   * Absent must parse as `undefined`, not `0`. `Number(null)` is `0`, and `0` is
   * finite and non-negative, so the obvious one-liner turned every fresh run
   * into a carried bank of nothing and handed it `BANK_FLOOR` instead of the
   * tier's opening money — 150 rather than 250 on Standard. See the evidence
   * table by `BANK_FLOOR` in `content/difficulty.ts` for what that cost.
   */
  const rawBank = params.get('bank');
  const carried = rawBank === null || rawBank === '' ? Number.NaN : Number(rawBank);
  const bank = Number.isFinite(carried) && carried >= 0 ? Math.floor(carried) : undefined;

  // Set when the run settles, read by `next`. The victory card is the only way
  // to reach `next`, and it cannot be shown before `onEnd` has fired, so this
  // is always populated by the time it is used.
  let finalMoney = 0;

  const { world: soloWorld } = await startGame(mount, hudRoot, resolveSeed(), {
    level,
    rules: isVersus ? versusRules(level, difficulty) : resolveRules(level, difficulty, bank),
    campaign: {
      nextName: nextLevel?.name ?? null,
      menu: () => {
        location.search = '';
      },
      next: () => {
        // Carrying the difficulty and dropping the seed is the useful default:
        // the next sector should be as hard as the last one, on a fresh board.
        // The bank travels with it — that is what makes the campaign a run.
        if (nextLevel !== undefined) {
          location.search = runQuery(nextLevel, difficulty, '', finalMoney);
        }
      },
    },
    onEnd: (w) => {
      finalMoney = Math.floor(w.money);
      // A versus run is not a sector result. Recording it would put a board
      // with no win state into the progress store, where Continue reads from.
      if (isVersus) return;
      recordRun(
        level.id,
        difficulty,
        {
          grade: grade(w),
          lives: w.lives,
          startingLives: w.rules.startingLives,
          seconds: w.time,
          waves: w.wave.clearedThrough + 1,
        },
        w.phase === 'won',
      );
    },
  });

  // `?peer=demo` on a solo versus board, in a dev server only.
  //
  // The opponent panel and the exchange strip are the two parts of the versus
  // HUD that render from a peer's status blob rather than from the local
  // world, so solo versus shows an empty column and they cannot be reviewed
  // without running the relay and driving two browsers. This mounts them with
  // invented data instead.
  //
  // Both halves of the guard matter. `import.meta.env.DEV` is a literal Vite
  // replaces at build time, so in a production build this collapses to `false`
  // and the dynamic import below is never reachable — `demoPeer.ts` is not in
  // the bundle at all, which is the only acceptable place for a module that
  // fabricates opponent state. The query flag is then just a convenience on
  // top of that, not the thing keeping it out of a real match.
  if (import.meta.env.DEV && isVersus && params.get('peer') === 'demo') {
    const { startDemoPeer } = await import('./ui/demoPeer.ts');
    startDemoPeer(mount, hudRoot, soloWorld);
  }
}

function runQuery(
  level: LevelDef,
  difficulty: DifficultyId,
  seed: string,
  bank?: number,
): string {
  const q = new URLSearchParams({ level: level.id, difficulty });
  if (seed !== '') q.set('seed', seed);
  if (bank !== undefined) q.set('bank', String(bank));
  return `?${q.toString()}`;
}

interface StartOptions {
  level?: LevelDef;
  rules?: Rules;
  campaign?: CampaignPorts;
  /**
   * Where a launched sortie goes, and where a landing is reported.
   *
   * Absent means the local loopback — you play both sides, which is how the
   * economy gets tuned. A real match supplies the relay instead. Neither the
   * sim nor this function knows which it got, and that is the point.
   */
  sortieRelay?: (ev: SimEvent) => void;
  /** Fired once, the first frame the run is no longer playing. */
  onEnd?: (w: World) => void;
}

async function startGame(
  mount: HTMLElement,
  hudRoot: HTMLElement,
  seed: number,
  opts: StartOptions = {},
): Promise<{ world: World; raceCues: RaceCues; startRaceTone: () => void }> {
  // Race mode passes neither, and gets the baseline game it has always played.
  const map = parseMap(opts.level?.map ?? LEVEL01);
  const rules = opts.rules ?? DEFAULT_RULES;
  const world = createWorld(map, seed, rules);
  const ui = createUiState();

  // A real match passes the relay; solo versus falls back to playing both
  // sides. Everything else is blind to which of the two it got.
  const sortieRelay = opts.sortieRelay ?? (rules.sorties ? localSortieRelay(world) : null);

  const boardW = tilesToPx(map.cols);
  const boardH = tilesToPx(map.rows);

  // Race passes no level, so it plays the baseline ground — the same one on both
  // clients, which is what keeps two screens comparable at a glance.
  const field = fieldFor(opts.level?.field);
  // The same flag `renderDeck` wraps on, so the height reserved and the rows
  // actually laid out cannot disagree — a deck that wrapped without being paid
  // for would put its second row back over the final approach.
  const { app, layers } = await createRenderer(mount, boardW, boardH, field, rules.sorties);

  const textures = createTextures(app.renderer);
  const mapLayer = buildMapLayer(map, textures, field);
  layers.map.addChild(mapLayer.view);

  const view = new WorldView(layers, textures);
  const overlay = new Overlay(layers, textures);
  const effects = new Effects(layers, boardW, boardH);
  const audio = new AudioEngine();
  // The id, not the resolved `field` — the bed is keyed by which sector this is,
  // and `SectorField` is a palette of colours with no identity of its own.
  const soundscape = new Soundscape(audio, opts.level?.field ?? DEFAULT_FIELD);
  const towerChrome = new TowerChrome(layers, field);
  const creepChrome = new CreepChrome(layers, textures);

  function togglePause(): void {
    ui.paused = !ui.paused;
    loop.paused = ui.paused;
  }

  const hud = createHud(hudRoot, {
    world,
    ui,
    dispatch: (cmd) => world.commands.push(cmd),
    speed: {
      get: () => loop.speed,
      set: (v) => {
        loop.speed = v;
      },
    },
    togglePause,
    audio: {
      apply: (prefs) => {
        audio.setVolume(prefs.volume);
        audio.setMuted(prefs.muted);
      },
    },
    // A full reload is the honest restart: it re-runs seed resolution, rebuilds
    // the world and resets every renderer pool, with no chance of a stale
    // reference surviving into the new run. Cheap, and impossible to get wrong.
    restart: () => {
      location.reload();
    },
    ...(opts.campaign === undefined ? {} : { campaign: opts.campaign }),
  });

  // main.ts is the only place that knows about both halves. The sim has no
  // reference to the view; the view only ever reads the world.
  let hudDue = 0;
  let lastRenderMs = performance.now();
  let ended = false;

  const loop = createLoop(world, () => {
    const now = performance.now();
    // Wall-clock delta, clamped: effects decay at the same rate at 1x and 4x,
    // and a backgrounded tab must not fast-forward them on return.
    const dt = Math.min(0.1, (now - lastRenderMs) / 1000);
    lastRenderMs = now;

    // One drain, three consumers. Whichever ran first would otherwise starve
    // the others, which is exactly the bug that made the HUD miss wave clears.
    effects.beginFrame();
    soundscape.beginFrame();
    for (const ev of world.events) {
      creepChrome.onEvent(ev);
      effects.onEvent(ev, ui.prefs);
      soundscape.onEvent(ev);
      hud.onEvent(ev);
      sortieRelay?.(ev);
    }
    world.events.length = 0;

    // Real seconds, not `dt` scaled by the speed multiplier: the current is a
    // property of the road, not of how fast the game is being run.
    if (ui.prefs.stream) mapLayer.step(1 / 60);

    view.sync(world);
    // Before the overlay reads it: if the player disarmed by any route, the
    // parked touch preview has nothing left to describe.
    input.reconcile();
    overlay.sync(world, ui.selected, ui.hover, ui.inspecting, ui.touchPreview);
    effects.update(world, dt);
    soundscape.update(world, ui.selected, dt);
    creepChrome.sync(world, dt);
    towerChrome.sync(world, ui.prefs);

    if (now >= hudDue) {
      hud.update();
      hudDue = now + HUD_INTERVAL_MS;
    }

    // Once, on the frame the run settles. Reading it here rather than polling
    // means the record is written from the same world state the victory card is
    // about to describe, so the two can never disagree.
    if (!ended && world.phase !== 'playing') {
      ended = true;
      opts.onEnd?.(world);
    }

    app.render();
  });

  const input = attachInput(app, world, ui, togglePause, hudRoot);

  // Any gesture voids the 10Hz throttle: a hotkey arming a station or a click
  // opening the inspector shows on the next frame, not up to 100ms later. The
  // HUD's own buttons update synchronously in hud.ts; this covers the rest.
  //
  // It is also where the mixer comes to life. A browser refuses to start an
  // AudioContext outside a user gesture, so the game is genuinely silent until
  // the first click or keypress — correct behaviour, not a bug to route around.
  // `unlock` returns immediately once the graph exists, so this stays cheap.
  const wake = (): void => {
    hudDue = 0;
    audio.unlock();
    audio.setVolume(ui.prefs.volume);
    audio.setMuted(ui.prefs.muted);
  };
  window.addEventListener('keydown', wake);
  window.addEventListener('pointerdown', wake);

  loop.start();

  console.info(
    `[td] "${map.name}" ${map.cols}x${map.rows}, ` +
      `${map.routes.length} route(s) — ${map.routes.map((r) => `${r.id} ${r.length}t`).join(', ')} — ` +
      `seed ${formatSeed(seed)} (${seed})`,
  );

  // Dev-only console handle. Stripped from production builds by the constant
  // folding on import.meta.env.DEV. Being able to poke at `td.world` and
  // `td.loop.speed` from devtools is worth far more here than in a typical app,
  // because the interesting bugs are all "what is the sim actually doing".
  if (import.meta.env.DEV) {
    (globalThis as Record<string, unknown>)['td'] = {
      world, loop, view, overlay, effects, ui, map, app, layers,
      // `td.input.tapMs = 200` on the device itself: how long a press must last
      // before releasing it buys the station. The one number here that can only
      // really be judged with a thumb.
      input,
      // The N2 fairness gate: run this in two tabs of the same room and diff.
      // Byte-identical or the race is not fair.
      dumpWaves: (n = 20) =>
        JSON.stringify(
          Array.from({ length: n }, (_, i) => planWave(world.seed, i, world.rules, world.map.routes)),
        ),
      // Auditioning the mix without playing a match out. `td.soundscape.audition
      // ('lance')` for one sound, and `td.soundscape.stress('lance', 120)` for
      // the question that actually matters — what happens at a rate no board can
      // reach — which is the one thing a real playthrough cannot be made to show
      // on demand.
      audio,
      soundscape,
    };
  }

  // Race mode reads the world for the status pump; single player ignores this.
  // The cues ride along rather than being rebuilt at the call site, so the one
  // place that owns the mixer is still the one place that reaches into it.
  return {
    world,
    raceCues: {
      opponentWave: () => void audio.play(RACE_OPPONENT_WAVE),
      leadChange: () => void audio.play(RACE_LEAD_CHANGE),
      sortieInbound: () => void audio.play(SORTIE_INBOUND),
    },
    startRaceTone: () => void audio.play(RACE_START),
  };
}

main().catch((err: unknown) => {
  console.error('[td] failed to start', err);
});
