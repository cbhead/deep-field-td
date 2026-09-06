/**
 * In-game race strip (N3): your progress vs theirs, ahead/behind, and a toast
 * when the opponent clears a wave. Pure presentation fed by status blobs —
 * nothing here touches the sim, and a lost blob costs a readout update, not
 * correctness.
 *
 * Deliberately separate from hud.ts: the game HUD renders world state, this
 * renders network state, and the two update on different clocks.
 *
 * ---
 *
 * **The opponent column reads what already arrives, and nothing more.** Their
 * lives, wave, era and tower pins are all in the 2Hz status blob; how many
 * contacts they have sent at you is a count of the `incoming` calls this file
 * already handles. The one place that principle bites is the exchange strip's
 * own half — see `sent`, which is a local mirror of a launch, not a message.
 * The rule is worth stating because the tempting fix for every gap below is a
 * new protocol field, and a versus mode whose HUD needs a wider wire is a
 * versus mode that gets less reliable every time the HUD gets richer.
 */
import type { EnemyId } from '../content/enemies.ts';
import { SORTIES } from '../content/sorties.ts';
import type { RaceStatus } from '../net/MatchController.ts';
import type { TowerPin } from '../net/protocol.ts';
import type { MapDef } from '../sim/types.ts';
import { tileAt } from '../sim/util/grid.ts';
import { boardScale } from '../render/pixiApp.ts';
import { THEME, css } from '../render/theme.ts';
import { contactIcon } from './icons.ts';

export interface RaceHud {
  /** Our own sampled status — called by the same pump that reports upstream. */
  own(status: RaceStatus): void;
  /** The opponent's latest blob. */
  peer(status: RaceStatus): void;
  /**
   * A contact they bought is walking at us. Versus only.
   *
   * The one thing in this mode that a player cannot see coming any other way:
   * their board is hidden, so without a cue here a sortie simply appears at
   * midfield with no explanation. It names the lane, because which lane is the
   * entire read and a warning that omitted it would be an alarm without an
   * answer.
   */
  incoming(sortie: string, lane: number): void;
  /**
   * One of ours has just launched at them. Versus only.
   *
   * The mirror of `incoming`, and deliberately a local call rather than an
   * echo off the relay: the launch is already known on this machine the
   * instant it happens, so asking the server to tell us what we just did would
   * add a round trip, a failure mode and a protocol field to learn nothing
   * new. The exchange strip is a client-side record of two events that both
   * already exist here — one from the socket, one from our own deck.
   */
  sent(sortie: string, lane: number): void;
  /** Opponent's socket state: false shows the offline/forfeit badge. */
  peerConn(connected: boolean): void;
  /** Our socket state: false shows the reconnecting badge. */
  selfConn(connected: boolean): void;
  remove(): void;
}

const TOAST_MS = 3000;

/** Matches the HUD's era rail, so the two never disagree about what II means. */
const ERA_NUMERAL: Readonly<Record<number, string>> = { 1: 'I', 2: 'II', 3: 'III' };

/**
 * Minimap pixels per tile — and, through the map's own column count, the width
 * of the whole opponent column.
 *
 * The panel is sized from the board rather than the board scaled into a panel
 * width picked by eye. A sector with a different aspect then produces a column
 * that still fits its own map instead of a letterboxed one, and the stats grid
 * below inherits whatever width that comes to.
 */
const TILE_PX = 8;

/**
 * How many contacts each row of the exchange strip remembers.
 *
 * The bound is a reading decision before it is a memory one. The strip is a
 * single line inside a fixed-width column, so past roughly eight glyphs the
 * choice is between shrinking them below the size at which the roster is
 * distinguishable — the whole point of using `contactIcon` here rather than
 * text — and wrapping the row, at which point it stops reading as a timeline.
 * Eight also covers about the last two intermissions of traffic at the rate
 * sorties are actually affordable, which is the window in which "what have
 * they been sending" is still a live question rather than history.
 *
 * The per-row totals are counted separately and never capped, so dropping the
 * ninth-oldest glyph costs the picture, not the score.
 */
const EXCHANGE_DEPTH = 8;

/** Contact glyph size in the exchange strip, in px. */
const GLYPH_PX = 13;

/**
 * Pin colours come from the theme's station palette, so a tower added to the
 * roster is automatically legible here — hardcoding these is how the minimap
 * would quietly stop matching the build deck the first time the roster grew.
 */
const pinColor = (kind: string): string =>
  css((THEME.towers as Record<string, number | undefined>)[kind] ?? 0xe9e9ed);

/**
 * Sortie id to the contact it actually sends.
 *
 * Widened to `string` on purpose: the id arrives off the socket as one, and a
 * peer running a build with a roster entry this one has never heard of should
 * cost a glyph, not a crash.
 */
const SORTIE_CONTACT = SORTIES as Record<string, { readonly enemy: EnemyId } | undefined>;

/** One end of the exchange: what it was, which lane it walked, and when. */
interface Exchange {
  readonly id: string;
  readonly lane: number;
  readonly at: number;
}

/** Panel chrome, kept in one place so the two panels cannot drift apart. */
const PANEL =
  'box-sizing:border-box;padding:9px 12px 10px;border-radius:8px;' +
  // The spec's near-opaque ground. A translucent panel over the star field the
  // match now paints lets background stars read as content in a readout whose
  // whole job is being glanced at rather than looked at.
  'background:rgba(10,11,20,0.93);display:flex;flex-direction:column;gap:8px';
const FONT = 'Inter,system-ui,sans-serif';
const LABEL = `font:600 8px/1 ${FONT};letter-spacing:0.1em;text-transform:uppercase;color:#75798c`;
const NOTE = `font:400 9px/1.35 ${FONT};color:#75798c`;
const VALUE = `font:500 14px/1 ${FONT};color:#e9e9ed;font-variant-numeric:tabular-nums`;

function make(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * Seconds only below a minute: the useful question about the newest glyph is
 * "was that this wave", and a stopwatch reading in a peripheral panel invites
 * the player to watch it.
 */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 3) return 'now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/** Plural that reads as prose, since these land mid-sentence in the standing. */
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The two opponent moments worth hearing.
 *
 * Optional, and kept as a callback rather than an engine reference so this file
 * stays what its header says it is — pure presentation fed by status blobs.
 * Both cues are deliberately quiet and heavily lowpassed at the palette end: the
 * race strip is peripheral, and an opponent cue that could be mistaken for one
 * of your own stations has cost the player attention on the board, which is the
 * only place it is worth spending.
 */
export interface RaceCues {
  opponentWave(): void;
  leadChange(): void;
  /**
   * Something they bought is on your board. Versus only.
   *
   * Its own cue rather than reusing `opponentWave`, because the two mean
   * opposite things: one is news about a board you cannot see, the other is
   * something that has already entered yours and is walking. Sharing a sound
   * would teach the player to ignore the more urgent of the two.
   */
  sortieInbound?(): void;
}

export function createRaceHud(
  parent: HTMLElement,
  opponentName: string,
  room: string,
  map: MapDef,
  cues?: RaceCues,
  chrome?: HTMLElement,
): RaceHud {
  const el = document.createElement('div');
  el.id = 'race-hud';
  el.style.cssText =
    'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:5;' +
    'padding:6px 14px;border-radius:6px;background:rgba(4,6,12,0.8);' +
    'border:1px solid rgba(255,255,255,0.2);color:var(--hud-fg,#dde4f0);' +
    'font:13px/1.5 var(--hud-font,ui-monospace,monospace);text-align:center;pointer-events:none';
  parent.style.position = 'relative';
  parent.appendChild(el);

  const toastEl = document.createElement('div');
  toastEl.id = 'race-toast';
  toastEl.style.cssText =
    'position:absolute;top:44px;left:50%;transform:translateX(-50%);z-index:5;' +
    'padding:4px 12px;border-radius:6px;background:rgba(20,40,80,0.9);' +
    'border:1px solid rgba(120,170,255,0.5);color:var(--hud-fg,#dde4f0);' +
    'font:13px/1.5 var(--hud-font,ui-monospace,monospace);opacity:0;transition:opacity 0.3s;pointer-events:none';
  parent.appendChild(toastEl);

  /** Which way the standing last resolved: 1 ahead, -1 behind, 0 not yet known. */
  let lead = 0;
  let mine: RaceStatus | null = null;
  let theirs: RaceStatus | null = null;
  let lastPeerWave = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let peerOnline = true;
  let selfOnline = true;

  /**
   * The lane's initial, as the board itself names it.
   *
   * Derived rather than a C/T table, because the tag is only worth anything if
   * it matches the label the player reads off the map. Re-author the sector
   * and the strip relabels itself; hardcode it and the strip is confidently
   * wrong on the first map that is not this one.
   */
  const laneTag = (lane: number): string =>
    (map.routes[lane]?.id ?? '').charAt(0).toUpperCase() || String(lane + 1);

  // ---------------------------------------------------------------------------
  // The opponent column: their board, what it adds up to, and the exchange.
  //
  // One absolutely-positioned stack rather than two floating panels, so the two
  // halves stay a column when the board is letterboxed at any aspect.
  //
  // **It mounts on the chrome layer, not the board.** Pinned inside `#game-root`
  // it sat on the top-right of the play area — over buildable tiles, in the one
  // mode where the other side is actively sending things down them. Docked
  // versus makes that indefensible rather than merely unfortunate: the whole
  // argument for four docks is that nothing overlaps the board at any size, and
  // a panel floating over it is that rule broken by the mode the rule is for.
  // On `#hud` the column is in stage coordinates, so `styles.css` can put it in
  // the detail dock's column above the inspector, which is where the design
  // draws it. Race on a campaign board has no docks and keeps the float.
  // ---------------------------------------------------------------------------
  // Position and width live in `styles.css`, not here. They differ between the
  // docked and undocked layouts, and an inline style would win over both — the
  // bug that had the docked column right-aligned to the stage at its own width
  // instead of filling the detail dock. The only thing this element knows that
  // CSS cannot is how wide its own minimap wants to be, so that crosses as a
  // custom property and the stylesheet decides whether to honour it.
  const column = make(
    'div',
    'position:absolute;z-index:5;display:flex;flex-direction:column;gap:8px;pointer-events:none',
  );
  column.id = 'race-col';
  column.style.setProperty('--race-col-w', `${map.cols * TILE_PX + 24}px`);

  // The opponent's board, in miniature: local map data draws the road (both
  // players are on the same sector, so nothing about the board itself needs
  // to cross the wire), TowerPins draw what they've built on it. Static by
  // design — "what is he building?" is the question, not "where are his
  // creeps" — and a lost frame costs staleness, not correctness.
  //
  // Which is exactly why the panel says so in words. A board that never moves
  // is indistinguishable from a board whose owner has stopped playing, and a
  // player who reads it the second way spends the match defending against
  // nothing. The label is not decoration; it is the difference between a
  // static readout and a broken one.
  const mini = make('div', `${PANEL};border:1px solid rgba(244,114,182,0.2)`);
  mini.id = 'race-minimap';

  const miniHead = make('div', 'display:flex;align-items:center;gap:7px');
  const miniName = make(
    'span',
    `font:600 9.5px/1 ${FONT};letter-spacing:0.1em;text-transform:uppercase;color:#e9e9ed;` +
      // The name is the only variable-length thing in the header, so it is the
      // only thing allowed to shrink: a long handle must not push the live
      // badge off the panel.
      'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
    opponentName,
  );
  const miniWhat = make('span', `${NOTE};flex:none`, "what they've built");
  // Not "2Hz". The blob's cadence is the status pump's business and this file
  // has never been told it — printing a rate here would be a number copied from
  // a design document that goes stale the moment the pump is retuned. What the
  // panel actually knows is whether their socket is up and whether their tab is
  // in front, and that is the fact a stale-looking board needs anyway.
  const liveDot = make('span', 'width:5px;height:5px;border-radius:50%;flex:none;display:block');
  const liveText = make('span', `${NOTE};flex:none`);
  const live = make('span', 'margin-left:auto;display:flex;align-items:center;gap:5px;flex:none');
  live.append(liveDot, liveText);
  miniHead.append(miniName, miniWhat, live);

  const miniNote = make(
    'span',
    NOTE,
    'Their contacts are not shared — only the stations they have placed.',
  );

  const miniCanvas = document.createElement('canvas');
  miniCanvas.width = map.cols * TILE_PX;
  miniCanvas.height = map.rows * TILE_PX;
  miniCanvas.style.cssText =
    'display:block;width:100%;height:auto;border-radius:5px;background:rgba(6,7,13,0.55)';

  // Four cells, because these are the four numbers that decide what to do next:
  // lives says how close they are to losing, wave says who is ahead on the first
  // ranking key, era says what they can build and send, and sent-you says how
  // much of their bank has gone into attacking rather than holding.
  const stats = make('div', 'display:grid;grid-template-columns:repeat(4,1fr);gap:5px');
  function statCell(name: string, colour: string): HTMLElement {
    const cell = make(
      'span',
      'display:flex;flex-direction:column;gap:4px;padding:6px 7px;border-radius:6px;' +
        'background:rgba(233,233,237,0.05);overflow:hidden',
    );
    const value = make('span', `${VALUE};color:${colour}`, '—');
    cell.append(make('span', LABEL, name), value);
    stats.append(cell);
    return value;
  }
  const statLives = statCell('Lives', '#e9e9ed');
  const statWave = statCell('Wave', '#e9e9ed');
  const statEra = statCell('Era', '#d2cefd');
  const statSent = statCell('Sent you', '#f472b6');

  // The standing the strip already computes, given room to say *why*. "Behind"
  // alone does not tell you whether to build or to attack; "behind — same wave,
  // 2 lives down" does.
  const standPill = make(
    'span',
    'display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:6px',
  );
  const standWord = make(
    'span',
    `font:600 9px/1 ${FONT};letter-spacing:0.12em;text-transform:uppercase;flex:none`,
  );
  const standWhy = make('span', `font:400 9.5px/1.3 ${FONT};color:#9397ab`);
  standPill.append(standWord, standWhy);

  mini.append(miniHead, miniNote, miniCanvas, stats, standPill);

  // ---------------------------------------------------------------------------
  // The exchange: two rows of glyphs, oldest to newest.
  //
  // Toasts are an alarm and behave like one — they fire once and are gone, which
  // is right for "something is walking at you now" and useless for "what has
  // this match actually been". Three Drifters and one Monolith is a different
  // opponent from four Monoliths, and until now the only record of which you
  // faced was whether you happened to be looking three seconds ago.
  // ---------------------------------------------------------------------------
  const exch = make('div', `${PANEL};border:1px solid rgba(233,233,237,0.08);display:none`);
  exch.id = 'race-exchange';
  const exchHead = make('div', 'display:flex;align-items:baseline;gap:8px');
  exchHead.append(
    make(
      'span',
      `font:600 9px/1 ${FONT};letter-spacing:0.18em;text-transform:uppercase;color:#75798c`,
      'Exchange',
    ),
    make(
      'span',
      `${NOTE};margin-left:auto`,
      `lane ${map.routes.map((_, i) => laneTag(i)).join(' / ')} · oldest → newest`,
    ),
  );

  function exchangeRow(colour: string): { tag: HTMLElement; strip: HTMLElement; age: HTMLElement } {
    const row = make('div', 'display:flex;align-items:center;gap:8px');
    const tag = make(
      'span',
      `font:600 8.5px/1 ${FONT};letter-spacing:0.1em;text-transform:uppercase;color:${colour};` +
        'width:46px;flex:none;font-variant-numeric:tabular-nums',
    );
    const strip = make('span', 'flex:1;display:flex;align-items:center;gap:6px;overflow:hidden');
    const age = make('span', `${NOTE};margin-left:auto;flex:none`);
    row.append(tag, strip, age);
    exch.append(row);
    return { tag, strip, age };
  }
  exch.append(exchHead);
  const youRow = exchangeRow('#b5abfc');
  exch.append(
    make(
      'div',
      'height:1px;background:linear-gradient(to right,rgba(233,233,237,0.14),rgba(233,233,237,0))',
    ),
  );
  const themRow = exchangeRow('#d59ac0');

  column.append(mini, exch);
  (chrome ?? parent).appendChild(column);

  // How tall the column ended up, published so the detail dock can start below
  // it. It is not a constant: the exchange panel is hidden until the first
  // sortie crosses, so the column grows once, mid-match.
  //
  // Safe against the write-measure loop `fitCanvas` documents, and for the
  // reason that one is dangerous only at the top: this writes a property read
  // by a rule inside `#stage`, and #stage cannot resize documentElement — body
  // is `overflow:hidden` and #app is a fixed 100dvh. Nothing here can feed back
  // into the viewport measurement.
  const publishHeight = (): void => {
    const h = column.getBoundingClientRect().height / (boardScale() || 1);
    document.documentElement.style.setProperty('--race-col-h', `${Math.round(h)}px`);
  };
  const sizer = new ResizeObserver(publishHeight);
  sizer.observe(column);

  let pins: TowerPin[] = [];

  // The ring buffers, and the totals they are not allowed to speak for. Both
  // are fed from events that already land in this file — nothing here asks the
  // relay for anything it was not already sending.
  const youSent: Exchange[] = [];
  const theySent: Exchange[] = [];
  let youSentTotal = 0;
  let theySentTotal = 0;

  function record(buf: Exchange[], id: string, lane: number): void {
    buf.push({ id, lane, at: Date.now() });
    if (buf.length > EXCHANGE_DEPTH) buf.splice(0, buf.length - EXCHANGE_DEPTH);
  }

  /**
   * One contact in the strip: the roster glyph, its lane, and an age fade.
   *
   * The glyph is `contactIcon`'s, the same drawing the build deck and the wave
   * preview use, so a Cluster in the exchange is recognisably the Cluster the
   * player has already learned to read. Opacity carries recency because the row
   * has no room for timestamps and the order alone is ambiguous the moment a
   * player glances at it mid-row.
   */
  function glyphHtml(e: Exchange, i: number, n: number): string {
    const enemy = SORTIE_CONTACT[e.id]?.enemy;
    const fade = n < 2 ? 1 : 0.42 + (0.58 * i) / (n - 1);
    const art = enemy
      ? contactIcon(enemy, GLYPH_PX)
      : `<span style="display:block;width:${GLYPH_PX}px;height:${GLYPH_PX}px;border-radius:3px;` +
        `background:rgba(233,233,237,0.2)"></span>`;
    return (
      '<span style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:none;' +
      `opacity:${fade.toFixed(2)}">${art}` +
      `<span style="font:600 7.5px/1 ${FONT};color:#75798c">${laneTag(e.lane)}</span></span>`
    );
  }

  const exchangeRows = [
    [youSent, youRow],
    [theySent, themRow],
  ] as const;

  function paintExchange(): void {
    // Race mode has no sorties at all, so the panel would sit permanently empty
    // there. It appears the first time either side actually sends something.
    if (youSentTotal + theySentTotal === 0) return;
    exch.style.display = 'flex';
    youRow.tag.textContent = `You ${youSentTotal}`;
    themRow.tag.textContent = `Them ${theySentTotal}`;
    for (const [buf, row] of exchangeRows) {
      row.strip.innerHTML = buf.map((e, i) => glyphHtml(e, i, buf.length)).join('');
    }
    paintAges();
  }

  /**
   * The two age labels alone. Split from the strip rebuild because `render`
   * runs on every status blob, and re-parsing sixteen inline SVGs twice a
   * second to turn "now" into "4s ago" is a lot of work to change two words.
   */
  function paintAges(): void {
    for (const [buf, row] of exchangeRows) {
      const newest = buf[buf.length - 1];
      row.age.textContent = newest ? ago(newest.at) : 'nothing yet';
    }
  }

  function drawMini(): void {
    const g = miniCanvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        if (tileAt(map, c, r) === 'path') {
          g.fillStyle = 'rgba(233,233,237,0.14)';
          g.fillRect(c * TILE_PX, r * TILE_PX, TILE_PX, TILE_PX);
        }
      }
    }
    for (const p of pins) {
      g.fillStyle = pinColor(p.k);
      // Tier reads as size: Mk I is a dot, upgrades grow toward the full tile.
      // Kept as a fraction of the tile rather than a pixel count, so the ramp
      // survives the panel being drawn at a different TILE_PX than the one it
      // was tuned at.
      const px = Math.round(TILE_PX * Math.min(1, (2 + p.tier) / 5));
      const off = Math.round((TILE_PX - px) / 2);
      g.fillRect(p.c * TILE_PX + off, p.r * TILE_PX + off, px, px);
    }
  }
  drawMini();

  // Reconnect banner, from the Race Lobby design's mid-race variant. One copy
  // correction vs the spec: the local sim keeps running through a drop — only
  // the reporting stops — so it says "your run continues", not "paused".
  const bannerEl = document.createElement('div');
  bannerEl.id = 'race-reconnect';
  bannerEl.style.cssText =
    'position:absolute;left:50%;bottom:96px;transform:translateX(-50%);z-index:6;display:none;' +
    'align-items:center;gap:16px;height:64px;padding:0 20px;border-radius:10px;' +
    'background:rgba(35,37,50,0.9);box-shadow:inset 0 0 0 1px rgba(252,192,138,0.35);' +
    'color:#e9e9ed;font:13px/1.4 Inter,system-ui,sans-serif;pointer-events:none;white-space:nowrap';
  bannerEl.innerHTML =
    `<span style="display:flex;flex-direction:column;gap:3px">` +
    `<span style="font-weight:600;font-size:14px">Reclaiming your seat in ${room}…</span>` +
    `<span style="font-size:11.5px;color:#9397ab">Your run continues — reporting resumes the moment the relay is back. ` +
    `${opponentName} sees you offline until then.</span></span>`;
  parent.appendChild(bannerEl);

  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0';
    }, TOAST_MS);
  }

  /**
   * The opponent column's readouts.
   *
   * Every figure is the one the strip above is already printing from the same
   * blob, so the two can never disagree — the panel is a second *view*, not a
   * second source. `side` is passed in rather than recomputed for exactly that
   * reason: the ranking rule lives in one place, and the pill says whatever
   * that rule decided.
   */
  function paintPanel(side: number): void {
    statLives.textContent = theirs ? String(theirs.lives) : '—';
    statWave.textContent = theirs ? String(theirs.wave) : '—';
    // Race has no eras, so an em dash rather than a fabricated I.
    statEra.textContent =
      theirs?.era === undefined ? '—' : (ERA_NUMERAL[theirs.era] ?? String(theirs.era));
    statSent.textContent = String(theySentTotal);

    const state = !peerOnline
      ? { c: '#e06d6d', t: 'offline' }
      : theirs?.hidden
        ? { c: '#fcc08a', t: 'tab hidden' }
        : { c: '#86e0a8', t: 'live' };
    liveDot.style.background = state.c;
    liveDot.style.boxShadow = `0 0 7px ${state.c}`;
    liveText.textContent = state.t;

    let word = 'Standing';
    let why = 'waiting for their first report';
    let hue = '145,132,217';
    let ink = '#d2cefd';
    if (mine && theirs) {
      word = side > 0 ? 'Ahead' : side < 0 ? 'Behind' : 'Level';
      hue = side > 0 ? '134,224,168' : side < 0 ? '224,109,109' : '145,132,217';
      ink = side > 0 ? '#86e0a8' : side < 0 ? '#e06d6d' : '#d2cefd';
      // Spelled out in the same order the ranking rule reads them, so the
      // clause is a decomposition of the verdict rather than a second opinion
      // about it. Digits, not words: these sit beside a tabular grid and the
      // player is comparing them, not reading them.
      const dw = mine.wave - theirs.wave;
      const dl = mine.lives - theirs.lives;
      const waves =
        dw === 0 ? 'same wave' : `${count(Math.abs(dw), 'wave', 'waves')} ${dw > 0 ? 'up' : 'down'}`;
      const lives =
        dl === 0 ? 'lives level' : `${count(Math.abs(dl), 'life', 'lives')} ${dl > 0 ? 'up' : 'down'}`;
      why = `${waves}, ${lives}`;
    }
    standWord.textContent = word;
    standWord.style.color = ink;
    standWhy.textContent = why;
    standPill.style.background = `rgba(${hue},0.12)`;
    standPill.style.border = `1px solid rgba(${hue},0.24)`;
  }

  function render(): void {
    const my = (mine ? `you · wave ${mine.wave} · ${mine.lives} lives` : 'you · —') +
      (selfOnline ? '' : ' · reconnecting…');
    let their = theirs ? `${opponentName} · wave ${theirs.wave} · ${theirs.lives} lives` : `${opponentName} · —`;
    // The rung, when there is one. In versus this is the single most useful
    // fact about an opponent whose board you cannot see — it says what they
    // can build, what they can send, and how much they have just spent not
    // defending. Absent in Race, where nothing carries an era.
    if (theirs?.era !== undefined) their += ` · era ${ERA_NUMERAL[theirs.era] ?? theirs.era}`;
    if (!peerOnline) their += ' · OFFLINE — forfeits in 90s';
    else if (theirs?.hidden) their += ' · tab hidden';
    // Ranking order: waves cleared, then lives. Time is the third tiebreak and
    // deliberately not shown as a live comparison — clocks are never compared.
    let standing = '';
    let side = 0;
    if (mine && theirs) {
      const cmp = mine.wave - theirs.wave || mine.lives - theirs.lives;
      standing = cmp > 0 ? ' — ahead' : cmp < 0 ? ' — behind' : ' — level';
      // Only the *change* is worth a sound, and only between ahead and behind:
      // passing through level on the way is not news, and cueing it would fire
      // twice for every overtake.
      side = cmp > 0 ? 1 : cmp < 0 ? -1 : 0;
      if (side !== 0 && lead !== 0 && side !== lead) cues?.leadChange();
      if (side !== 0) lead = side;
    }
    el.textContent = `${my}   |   ${their}${standing}`;
    paintPanel(side);
    paintAges();
  }

  // Paint once before the first blob, so the column opens as an empty readout
  // waiting on its opponent rather than as an unstyled gap that fills in half a
  // second later.
  render();

  return {
    own(status) {
      mine = status;
      render();
    },
    incoming(sortie, lane) {
      const lane_ = map.routes[lane]?.id ?? `lane ${lane + 1}`;
      // The toast is unchanged and stays the alarm: it fires once, loudly, for
      // the thing that is walking at you right now. The strip below is the
      // record of everything that has walked, which is a different question and
      // was previously answerable only by having been watching.
      toast(`${opponentName} sent a ${sortie} up the ${lane_}`);
      cues?.sortieInbound?.();
      theySentTotal++;
      record(theySent, sortie, lane);
      paintExchange();
      // The sent-you cell is on the other panel and is the one stat that does
      // not come off a status blob, so it needs the nudge the pump would give.
      render();
    },
    sent(sortie, lane) {
      youSentTotal++;
      record(youSent, sortie, lane);
      paintExchange();
    },
    peer(status) {
      if (status.wave > lastPeerWave) {
        lastPeerWave = status.wave;
        toast(`${opponentName} cleared wave ${status.wave}`);
        cues?.opponentWave();
      }
      if (status.towers !== undefined) {
        pins = status.towers;
        drawMini();
      }
      theirs = status;
      render();
    },
    peerConn(connected) {
      peerOnline = connected;
      toast(connected ? `${opponentName} reconnected` : `${opponentName} lost connection`);
      render();
    },
    selfConn(connected) {
      selfOnline = connected;
      bannerEl.style.display = connected ? 'none' : 'flex';
      render();
    },
    remove() {
      if (toastTimer !== null) clearTimeout(toastTimer);
      el.remove();
      toastEl.remove();
      bannerEl.remove();
      sizer.disconnect();
      document.documentElement.style.removeProperty('--race-col-h');
      column.remove();
    },
  };
}
