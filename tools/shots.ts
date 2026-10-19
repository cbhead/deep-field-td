/**
 * README screenshots, scripted. `npm run shots`.
 *
 * The captures in `docs/media/` went stale the moment the board was rebuilt,
 * and nothing caught it — a screenshot has no typechecker. Taking them by hand
 * means they are re-taken only when someone remembers, which is never. This
 * makes re-shooting one command, so the pictures can be refreshed as part of
 * landing a visual change rather than as an act of discipline afterwards.
 *
 * **No new dependency.** It drives a real Chrome over the DevTools protocol
 * using `ws`, which the relay server already needs. Chrome runs
 * `requestAnimationFrame` normally, which matters: the sim only advances on
 * animation frames, so a capture tool that cannot produce them can only ever
 * photograph an empty board.
 *
 * Scenes are set up through the dev-only `td` handle — the same one used from
 * devtools — so the shots show the real simulation rather than a mock.
 *
 * The two Race captures are deliberately not scripted: they need two clients in
 * a room with a relay between them, and faking that would produce a picture of
 * something the game does not do.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;
const BASE = process.env['SHOTS_BASE'] ?? 'http://localhost:5173';
const OUT = 'docs/media';

/** Retina, because the README is read on retina displays. */
const SCALE = 2;
const WIDTH = 1280;
const HEIGHT = 800;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Shot {
  readonly file: string;
  readonly url: string;
  /**
   * Runs on the origin *before* the real navigation — for seeding
   * localStorage, which has to exist before the screen reads it.
   *
   * Separate from `setup` because doing it with a `location.reload()` inside an
   * awaited evaluate tears the page out from under the call, and what gets
   * photographed is whatever happens to be on screen afterwards. That produced
   * a blank capture the first time, which is precisely the failure `expect`
   * below exists to catch.
   */
  readonly prep?: string;
  /** Runs in the page once loaded. Return a promise to hold the shot back. */
  readonly setup?: string;
  /**
   * A selector that must be present, and non-trivial, at capture time.
   *
   * A screenshot tool that quietly photographs a blank page is worse than no
   * tool: it replaces a stale picture with an empty one and reports success.
   */
  readonly expect: string;
  readonly settleMs?: number;
}

/**
 * `td.world.commands` is the same queue the UI pushes to, so these place
 * stations exactly as a click would — no back door into the sim.
 */
const PLACE = (defId: string, col: number, row: number): string =>
  `td.world.commands.push({ type: 'placeTower', defId: '${defId}', col: ${col}, row: ${row} });`;

/**
 * Hold the shot until the board is actually worth photographing.
 *
 * A fixed sleep used to do this and it drifted: six stations kill wave one in
 * under four seconds, so a 5.2s settle landed in the gap *between* waves and
 * photographed an empty board — the exact failure the `expect` selector exists
 * to catch, except `expect` was watching the HUD, which was fine. Waiting on
 * the thing the picture is of cannot drift when the balance moves.
 *
 * `leg >= 3` puts the leaders past the first corners, so the contacts are
 * distributed along the road rather than bunched at the spawn.
 */
const AWAIT_CONTACTS = `
  await new Promise((done) => {
    const give_up = Date.now() + 40000;
    const poll = setInterval(() => {
      const live = td.world.creeps.filter((c) => !c.dead);
      const ready = live.length >= 6 && live.some((c) => c.leg >= 3);
      if (!ready && Date.now() < give_up) return;
      clearInterval(poll);
      done();
    }, 120);
  });
`;

const SHOTS: readonly Shot[] = [
  {
    file: 'home.png',
    url: `${BASE}/`,
    prep: `
      localStorage.setItem('td-campaign', JSON.stringify({ version: 1, lastDifficulty: 'standard',
        lastLevel: 'level02',
        levels: { level01: { cleared: true, best: { standard: { grade: 'A', lives: 14,
          startingLives: 20, seconds: 278, waves: 10 } } } } }));
      localStorage.setItem('race-series', JSON.stringify({
        Vela: { w: 3, l: 2, t: 1, last: { outcome: 'w', sector: 'Pincer' } } }));
    `,
    expect: '#home-screen .hm-continue',
    settleMs: 900,
  },
  {
    file: 'sectors.png',
    url: `${BASE}/?sectors`,
    expect: '#menu-screen .mn-card .thumb',
    settleMs: 700,
  },
  {
    file: 'gameplay.png',
    url: `${BASE}/?level=level01&difficulty=standard&seed=deepfield`,
    setup: `
      // Funded first, or the last placements silently fail for want of cash and
      // the board is photographed two stations deep. The money is a prop for the
      // photograph; the placements still go through the same command queue a
      // click would.
      td.world.money = 8000;
      // ...and so is the wave index. Half the roster is gated behind a wave, so
      // a capture taken at wave 1 can only ever show the four stations the game
      // opens with — which is a photograph of a six-station game the roster
      // stopped being. Advancing the clock is the same kind of prop the money
      // is: it buys the picture access to what the deck actually holds, and
      // placementError still refuses anything genuinely illegal.
      td.world.wave.index = 7;
      // Settled as well as advanced. Moving the index alone leaves waves 1-7
      // dispatched-but-never-cleared, so the settlement pass fires seven clear
      // events the instant the shot starts and photographs a "+$0 · 0 kills"
      // toast over the board — a picture of a defence that killed nothing.
      td.world.wave.dispatchedThrough = 6;
      td.world.wave.clearedThrough = 6;
      td.loop.speed = 2;
      ${PLACE('lance', 6, 4)}${PLACE('nova', 14, 9)}${PLACE('singularity', 12, 4)}
      ${PLACE('solvent', 9, 8)}${PLACE('ember', 20, 6)}${PLACE('sentinel', 21, 11)}
      td.world.commands.push({ type: 'startWave' });
      ${AWAIT_CONTACTS}
    `,
    expect: '#hud .slot',
    settleMs: 900,
  },
  {
    file: 'inspector.png',
    url: `${BASE}/?level=level01&difficulty=standard&seed=deepfield`,
    setup: `
      td.world.money = 8000;
      // Staged at the wave Ember actually opens on, not at the gameplay shot's
      // wave 8. The station has to be *doing* something in an inspector shot,
      // and three towers against wave-8 hulls kill nothing in the time the
      // capture can wait — that read as "0 kills" on the panel being sold.
      td.world.wave.index = 4;
      td.world.wave.dispatchedThrough = 3;
      td.world.wave.clearedThrough = 3;
      // Ember rather than Singularity: it carries all three upgrade tracks, so
      // the panel still shows the full ladder, and its burn is a mechanic line
      // the old captures had no way to illustrate.
      ${PLACE('ember', 12, 4)}
      await new Promise((r) => requestAnimationFrame(r));
      const t = td.world.towers.at(-1);
      td.world.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
      td.world.commands.push({ type: 'upgradeTower', id: t.id, path: 'damage' });
      td.world.commands.push({ type: 'upgradeTower', id: t.id, path: 'effect' });
      ${PLACE('nova', 14, 9)}${PLACE('lance', 9, 8)}${PLACE('arc', 20, 6)}
      td.world.commands.push({ type: 'startWave' });
      // Held until the wave is *spawning*, not for a fixed number of seconds.
      //
      // The phase is load-bearing for this particular picture and it took a bad
      // capture to notice: during an intermission the send block carries the
      // long "sending early pays..." hint, which is 237px wide and squeezes the
      // detail column from its 430px cap down to 197 — narrow enough that the
      // three upgrade buttons overlap their own labels. Mid-spawn the hint is
      // "Wait for it to finish spawning" and the panel has room. A fixed sleep
      // lands on whichever side of that the balance happens to put it, which is
      // exactly the drift AWAIT_CONTACTS exists to avoid.
      await new Promise((done) => {
        const give_up = Date.now() + 20000;
        const poll = setInterval(() => {
          const spawning = td.world.wave.phase === 'spawning';
          const live = td.world.creeps.filter((c) => !c.dead).length >= 4;
          if (!(spawning && live) && Date.now() < give_up) return;
          clearInterval(poll);
          done();
        }, 100);
      });
      // Select it, so the panel under inspection is the one being photographed.
      td.ui.inspecting = t.id;
    `,
    expect: '#hud .inspector',
    settleMs: 1200,
  },
];

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
}

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly ws: WebSocket;

  // Longhand rather than a parameter property: Node's type-stripping loader
  // rejects those, and the whole harness runs under it.
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as {
        id?: number;
        error?: { message: string };
        result?: Record<string, unknown>;
      };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
    });
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Killed in the `finally` below, so a failure cannot leak the debug port. */
const processes: ReturnType<typeof spawn>[] = [];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--user-data-dir=/tmp/td-shots-profile',
    // Software rendering would produce a board with no glow at all; the whole
    // point of these captures is the rendering.
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ]);
  processes.push(chrome);
  chrome.on('error', (e) => {
    console.error('could not start Chrome:', e.message);
  });

  // Chrome takes a moment to open the debug port.
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 40 && target === undefined; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = (await res.json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === 'page');
    } catch {
      // not up yet
    }
  }
  if (target === undefined) throw new Error('Chrome debug port never opened');

  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  for (const shot of SHOTS) {
    process.stdout.write(`  ${shot.file} … `);

    if (shot.prep !== undefined) {
      await cdp.send('Page.navigate', { url: shot.url });
      await sleep(900);
      await cdp.send('Runtime.evaluate', { expression: `(() => { ${shot.prep} })()` });
    }

    await cdp.send('Page.navigate', { url: shot.url });
    await sleep(1600);

    if (shot.setup !== undefined) {
      const res = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { ${shot.setup} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const ex = res['exceptionDetails'] as { text?: string } | undefined;
      if (ex !== undefined) throw new Error(`${shot.file}: ${ex.text ?? 'setup failed'}`);
      // A reload in setup drops the page out from under us.
      await sleep(1200);
    }

    await sleep(shot.settleMs ?? 500);

    // Assert the screen is actually on screen. Without this the tool will
    // happily replace a stale picture with an empty one and report success,
    // which is a worse outcome than leaving the stale one alone.
    const seen = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(shot.expect)});
        return el === null ? 0 : el.getBoundingClientRect().width; })()`,
      returnByValue: true,
    });
    const width = (seen['result'] as { value?: number } | undefined)?.value ?? 0;
    if (width < 8) {
      throw new Error(`${shot.file}: expected "${shot.expect}" to be visible, got width ${width}`);
    }

    const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = res['data'];
    if (typeof data !== 'string') throw new Error(`${shot.file}: no image returned`);
    const bytes = Buffer.from(data, 'base64');
    writeFileSync(`${OUT}/${shot.file}`, bytes);
    console.log(`${(bytes.length / 1024).toFixed(0)} kB`);
  }

  cdp.close();
  console.log('\nshots written to docs/media/');
  console.log('Race captures are not scripted — they need two clients and a relay.');
}

/**
 * Chrome is killed on the way out **whatever happened**.
 *
 * Without this a failed assertion leaves a headless Chrome holding the debug
 * port, so the next run hangs waiting for a port that is already taken — the
 * failure compounds into a timeout that looks like a different bug entirely.
 */
const started = Date.now();
main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of processes) p.kill();
    console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  });
