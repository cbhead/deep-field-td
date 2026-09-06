import { BALANCE } from '../content/balance.ts';
import { TOWERS, TOWER_IDS, type TowerId } from '../content/towers.ts';
import type { TowerStats } from '../content/types.ts';
import { ENEMIES, type EnemyId } from '../content/enemies.ts';
import { saveAudioPrefs, type UiPrefs, type UiState } from '../app/uiState.ts';
import {
  describeGaps,
  coverage,
  formatClock,
  grade,
  nextGradeHint,
  toughestArmour,
  formatDamage,
} from '../sim/analysis.ts';
import {
  sellValue,
  upgradeCost,
  isUnlocked,
  nextStats,
  visualTier,
  hasDamagePath,
  effectiveInterval,
  tierCeiling,
  advanceEraCost,
} from '../sim/build.ts';
import { planWave, scaledStats, waveCount } from '../sim/wavePlan.ts';
import { SORTIES, SORTIE_IDS, type SortieId } from '../content/sorties.ts';
import { sortieCost, sortieKickback, sortieUnlocked } from '../sim/sortie.ts';
import {
  TARGET_MODES,
  UPGRADE_PATHS,
  type Command,
  type SimEvent,
  type TargetMode,
  type Tower,
  type UpgradePath,
} from '../sim/types.ts';
import { effectiveDamage } from '../sim/damage.ts';
import { towerById, type World } from '../sim/world.ts';
import { collarDial, contactIcon, pathDial, stationIcon, tierPips } from './icons.ts';

/**
 * DOM, not Pixi.
 *
 * A tower defense HUD is 90% text. In Pixi that means bitmap fonts and
 * hand-computed layout; in DOM it is flexbox and it is done. The boundary is
 * world-anchored visuals (ghosts, reach circles, health bars) in Pixi,
 * screen-anchored chrome here.
 *
 * **Rendering strategy.** The HUD updates at 10Hz, and at this size guarding
 * every individual text node by hand stops being maintainable. Instead each
 * region computes a short *key* describing everything it displays; when the key
 * is unchanged the region is skipped entirely, and when it changes the new
 * markup is *morphed* onto the live DOM — only the nodes that actually differ
 * are touched, and everything else keeps its identity. That last part is a
 * playability requirement, not an optimisation: the deck's key changes on
 * every kill and every timer second, and a wholesale `innerHTML` rebuild that
 * lands between a player's mouse-down and mouse-up destroys the button they
 * are pressing — the browser then fires no click at all, and the control feels
 * dead until they mash it. Morphing keeps the pressed element alive through
 * the update, along with its `:hover`/`:active` states.
 *
 * Because regions render from strings, nothing binds listeners to their
 * contents. One delegated click handler on the root reads `data-act`, so
 * controls need no re-binding no matter how the DOM is patched.
 */
export interface HudPorts {
  world: World;
  ui: UiState;
  dispatch(cmd: Command): void;
  /** Live view of the loop's speed and pause flag; the HUD writes both. */
  speed: { get(): number; set(v: number): void };
  togglePause(): void;
  restart(): void;

  /**
   * Campaign navigation, absent in Race mode.
   *
   * Optional because the end-of-run cards are shared: Race reaches the same
   * defeat and victory screens, and there is no campaign to go back to from
   * one. When this is absent the cards render exactly as they always did.
   */
  campaign?: CampaignPorts;

  /**
   * The mixer, so the volume row takes effect while the menu is still open.
   *
   * Optional and behind `?.` at the call site: the HUD is rendered by the
   * headless screenshot tool too, and a settings row that hard-required an
   * AudioContext would take that tool down with it.
   */
  audio?: AudioPorts;
}

export interface AudioPorts {
  apply(prefs: UiPrefs): void;
}

export interface CampaignPorts {
  /** Back to the level select. */
  menu(): void;
  /** The following level's name, or null when this one ends the campaign. */
  nextName: string | null;
  /** Start the following level at the same difficulty. */
  next(): void;
}

export interface Hud {
  /** Call at ~10Hz, not 60. Regions with an unchanged key do no work. */
  update(): void;
  /** Fed from the single event drain in main.ts. */
  onEvent(ev: SimEvent): void;
}

const SPEEDS = [1, 2, 4];
const TARGET_LABEL: Record<TargetMode, string> = {
  first: 'First',
  last: 'Last',
  strong: 'Strong',
  close: 'Close',
};

/** Direction of travel for first/last, mass for strong, proximity for close. */
const TARGET_GLYPH: Record<TargetMode, string> = {
  first: '▶',
  last: '◀',
  strong: '▲',
  close: '◎',
};

/** How long the wave-cleared summary stays up, in ms of wall clock. */
const CLEAR_TOAST_MS = 3200;
/**
 * The breach banner is deliberately shorter-lived than the clear summary: it is
 * an alarm, not a report, and one that outstayed the moment would still be on
 * screen during the next leak.
 */
const BREACH_TOAST_MS = 1600;

export function createHud(root: HTMLElement, ports: HudPorts): Hud {
  const { world: w, ui } = ports;

  root.innerHTML =
    '<div class="top"></div><div class="deck"></div><div class="overlay"></div>';
  const topEl = root.querySelector<HTMLElement>('.top')!;
  const deckEl = root.querySelector<HTMLElement>('.deck')!;
  const overlayEl = root.querySelector<HTMLElement>('.overlay')!;

  const top = region(topEl);
  const deck = region(deckEl);
  const overlay = region(overlayEl);

  /** Latest wave-cleared summary, and when it expires. */
  let clearToast: Extract<SimEvent, { type: 'waveCleared' }> | null = null;
  let clearToastUntil = 0;
  /** Lives remaining at the moment of the most recent leak, and its expiry. */
  let breachLives = 0;
  let breachUntil = 0;

  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (el === null) return;
    act(el.dataset['act']!, el.dataset);
    // Reflect the press now, not at the next 10Hz tick: a button whose state
    // change shows up 100ms later reads as a button that didn't take.
    update();
  });

  function act(action: string, data: DOMStringMap): void {
    switch (action) {
      case 'arm': {
        const id = data['id'] as TowerId;
        ui.selected = ui.selected === id ? null : id;
        if (ui.selected !== null) ui.inspecting = null;
        break;
      }
      case 'send':
        ports.dispatch({ type: 'startWave' });
        break;
      case 'era':
        ports.dispatch({ type: 'advanceEra' });
        break;
      case 'lane':
        ui.sortieLane = Number(data['v']);
        break;
      case 'sortie':
        ports.dispatch({
          type: 'sortie',
          sortie: data['id'] as SortieId,
          lane: ui.sortieLane,
        });
        break;
      case 'deck':
        ui.deckOpen = !ui.deckOpen;
        break;
      case 'speed':
        ports.speed.set(Number(data['v']));
        break;
      case 'pause':
        ports.togglePause();
        break;
      case 'restart':
        ports.restart();
        break;
      case 'menu':
        ports.campaign?.menu();
        break;
      case 'next':
        ports.campaign?.next();
        break;
      case 'upgrade':
        if (ui.inspecting !== null) {
          ports.dispatch({
            type: 'upgradeTower',
            id: ui.inspecting,
            path: data['path'] as UpgradePath,
          });
        }
        break;
      case 'sell':
        if (ui.inspecting !== null) {
          ports.dispatch({ type: 'sellTower', id: ui.inspecting });
          ui.inspecting = null;
        }
        break;
      case 'target':
        if (ui.inspecting !== null) {
          ports.dispatch({
            type: 'setTargeting',
            id: ui.inspecting,
            mode: data['mode'] as TargetMode,
          });
        }
        break;
      case 'pref-reach':
        ui.prefs.reachCircles = data['v'] === 'always' ? 'always' : 'hover';
        break;
      case 'pref-damage':
        ui.prefs.damageNumbers = data['v'] === 'on';
        break;
      case 'pref-stream':
        ui.prefs.stream = data['v'] === 'on';
        break;
      case 'pref-sound': {
        // Four steps, not a slider. A slider is a drag target the size of a
        // fingertip on the compact layout, and "off / quiet / normal / loud" is
        // the whole range anyone actually wants from a game's master volume.
        const v = data['v'];
        ui.prefs.muted = v === 'off';
        if (v === 'low') ui.prefs.volume = 0.3;
        else if (v === 'mid') ui.prefs.volume = 0.6;
        else if (v === 'high') ui.prefs.volume = 1;
        saveAudioPrefs(ui.prefs);
        ports.audio?.apply(ui.prefs);
        break;
      }
    }
  }

  function update(): void {
    const inspected = ui.inspecting === null ? undefined : towerById(w, ui.inspecting);
    if (inspected === undefined && ui.inspecting !== null) ui.inspecting = null;

    const now = performance.now();
    const toastLive = clearToast !== null && now < clearToastUntil;
    const breachLive = now < breachUntil;

    top(topKey(w, ports.speed.get(), ui.paused), () => renderTop(w, ports.speed.get(), ui.paused));

    deck(deckKey(w, ui, inspected), () => renderDeck(w, ui, inspected));

    overlay(
      `${w.phase}|${ui.paused ? 'p' : ''}|${toastLive ? clearToast!.wave : ''}|${
        breachLive ? `b${breachLives}` : ''
      }`,
      () =>
        renderOverlay(w, ui, toastLive ? clearToast : null, breachLive ? breachLives : null, ports.campaign),
    );
  }

  return {
    onEvent(ev) {
      // On a landscape phone the open deck overlays the bottom of the board
      // (see .td-compact in styles.css), so it must not still be open when
      // something is walking the route. Compact only — everywhere else the deck
      // reserves its own space and covers nothing.
      if (
        ev.type === 'waveStarted' &&
        ui.deckOpen &&
        document.documentElement.classList.contains('td-compact')
      ) {
        ui.deckOpen = false;
      }
      if (ev.type === 'waveCleared') {
        clearToast = ev;
        clearToastUntil = performance.now() + CLEAR_TOAST_MS;
      }
      if (ev.type === 'creepLeaked') {
        // Read lives here, not at render time: several can leak inside one
        // frame and the banner should name the count at the moment it fired.
        breachLives = w.lives;
        breachUntil = performance.now() + BREACH_TOAST_MS;
      }
      // A sold or destroyed station must not leave the inspector showing a
      // ghost. Cheaper and more reliable than having the inspector re-check.
      if (ev.type === 'towerSold' && ui.inspecting === ev.id) ui.inspecting = null;
    },

    update,
  };
}

/** A region that re-renders only when its key changes. */
function region(el: HTMLElement): (key: string, html: () => string) => void {
  let last: string | null = null;
  const tpl = document.createElement('template');
  return (key, html) => {
    if (key === last) return;
    last = key;
    tpl.innerHTML = html();
    morphChildren(el, tpl.content);
  };
}

/**
 * Make `el`'s children match `want`'s in place. Nodes are matched by position
 * and tag: a match is patched (attributes, text, then its own children), a
 * mismatch is replaced, and the tail is appended or trimmed. Positional
 * matching is deliberate — every region renders a fixed structure per key, so
 * an insertion cascade costs a few extra attribute writes, never correctness.
 */
function morphChildren(el: Node, want: Node): void {
  const have = el.childNodes;
  const wish = want.childNodes;
  for (let i = 0; i < wish.length; i++) {
    const w = wish[i]!;
    const h = have[i];
    if (h === undefined) {
      el.appendChild(w.cloneNode(true));
      continue;
    }
    const sameKind =
      h.nodeType === w.nodeType &&
      (h.nodeType !== Node.ELEMENT_NODE ||
        (h as Element).tagName === (w as Element).tagName);
    if (!sameKind) {
      el.replaceChild(w.cloneNode(true), h);
      continue;
    }
    if (w.nodeType === Node.ELEMENT_NODE) {
      morphAttrs(h as Element, w as Element);
      morphChildren(h, w);
    } else if (h.nodeValue !== w.nodeValue) {
      h.nodeValue = w.nodeValue;
    }
  }
  while (have.length > wish.length) el.removeChild(el.lastChild!);
}

function morphAttrs(h: Element, w: Element): void {
  for (const name of h.getAttributeNames()) {
    if (!w.hasAttribute(name)) h.removeAttribute(name);
  }
  for (const name of w.getAttributeNames()) {
    const v = w.getAttribute(name)!;
    if (h.getAttribute(name) !== v) h.setAttribute(name, v);
  }
}

// ---------------------------------------------------------------- top bar

function topKey(w: World, speed: number, paused: boolean): string {
  const s = w.wave;
  return [
    w.money,
    w.lives,
    s.clearedThrough,
    s.index,
    s.phase,
    Math.ceil(s.timer),
    aliveInWave(w, s.index),
    // The rail draws the rung and the price of the next one. Advancing always
    // spends, so `w.money` would in practice cover this — but the rule for a
    // region key is that it describes everything the region displays, not
    // everything that happens to change alongside it.
    w.era,
    speed,
    paused,
  ].join('|');
}

function renderTop(w: World, speed: number, paused: boolean): string {
  const s = w.wave;
  // An endless arc has no denominator — see `heldLabel`. On Front Line, waves
  // held is a score rather than progress toward anything, because there is
  // nothing to be partway through.
  const held = heldLabel(w);

  let label: string;
  let fill: number;
  if (s.phase === 'intermission') {
    label = `wave ${s.index + 1} · in ${Math.ceil(s.timer)}s`;
    fill = 1 - Math.max(0, s.timer) / BALANCE.intermission;
  } else if (s.phase === 'spawning') {
    // A contact glyph rather than the word "alive": the deck is teaching this
    // vocabulary two rows down, and one dot the player already recognises beats
    // a noun. Not three anonymous dots, which invite reading "3 alive".
    label =
      `wave ${s.index + 1} · <i class="dot contact"></i>${aliveInWave(w, s.index)}` +
      ` of ${s.plan.length}`;
    fill = s.plan.length === 0 ? 0 : s.spawned / s.plan.length;
  } else {
    label = 'last wave out';
    fill = 1;
  }

  // The alarm is the width of the screen rather than one red digit, because a
  // player at four lives is looking at the board, not at the stat cells — and
  // the collapsed deck's status strip, which used to carry this, is gone.
  //
  // The fill's *geometry* is untouched: `--ribbon` recolours it, so it still
  // reads as a progress value rather than as a second quantity. If it ever
  // starts reading as "42% doomed", drop `.crit` to a rim and border only and
  // leave the fill on the accent.
  const crit = w.lives <= BALANCE.critLives;

  const speeds = SPEEDS.map(
    (v) =>
      `<button data-act="speed" data-v="${v}" class="${v === speed ? 'on' : ''}">${v}×</button>`,
  ).join('');

  // Versus puts the send control against the ribbon and the wave overview beside
  // it. Both are moves rather than additions — see `renderWaveOverview` for why
  // the overview cannot stay in the detail slot, and `renderDeck` for why the
  // send button no longer has a section of its own to sit in. The era rail left
  // the row entirely; it is a dock now.
  const versus = w.rules.sorties;

  return (
    // No sigil. Costs lost theirs in the deck, and a currency mark repeated on
    // every price is a character the player has already agreed to.
    `<div class="stat"><label>Cash</label><b>${w.money}</b></div>` +
    `<div class="stat"><label>Lives</label><b class="${crit ? 'crit' : ''}">${w.lives}</b></div>` +
    `<div class="stat"><label>Waves held</label><b>${held}</b></div>` +
    (versus ? '' : renderEraRail(w)) +
    `<div class="ribbon-row">` +
    `<div class="ribbon${crit ? ' crit' : ''}"><span>${label}</span>` +
    `<i style="width:${(clamp01(fill) * 100).toFixed(1)}%"></i></div>` +
    (versus ? renderTopSend(w) : '') +
    `</div>` +
    (versus ? renderWaveOverview(w) : '') +
    `<div class="seg speeds">${speeds}</div>` +
    // aria-label rather than title: the glyph is universal, Esc means nothing
    // on a touch device, and a tooltip that never fires there is dead weight.
    `<button class="icon" data-act="pause" aria-label="${paused ? 'Resume' : 'Pause'}">` +
    `${paused ? '▶' : '❚❚'}</button>`
  );
}

/** Era numerals, so the rail reads I · II · III rather than 1 · 2 · 3. */
const ROMAN: Readonly<Record<number, string>> = { 1: 'I', 2: 'II', 3: 'III' };

/**
 * The era ladder, in the status row and nowhere else.
 *
 * Empty markup outside versus, which is what keeps the campaign's top row
 * byte-identical rather than gaining a disabled control it can never use.
 *
 * The rung and the price sit *together*, deliberately. The decision this
 * control exists to pose is "is the next rung worth what it costs right now",
 * and splitting those across two places would make the player do the join. It
 * sits beside Cash for the same reason — the shortfall should be readable
 * without moving your eyes, because the moment it matters is the moment a wave
 * is walking.
 *
 * At the top of the ladder the button becomes a plain readout: there is nothing
 * left to buy, and a permanently disabled button is a worse way to say so than
 * not drawing one.
 */
function renderEraRail(w: World): string {
  if (!w.rules.eras) return '';
  const numeral = ROMAN[w.era] ?? String(w.era);
  const cost = advanceEraCost(w);
  if (cost === null) {
    return `<div class="stat era"><label>Era</label><b>${numeral}</b></div>`;
  }
  const poor = w.money < cost;
  return (
    `<div class="stat era"><label>Era</label><b>${numeral}</b></div>` +
    `<button class="icon era-up${poor ? ' poor' : ''}" data-act="era"` +
    ` aria-label="Advance to era ${ROMAN[w.era + 1] ?? w.era + 1} for ${cost}"` +
    `>▲<span>${cost}</span></button>`
  );
}

/**
 * The same ladder as `renderEraRail`, as a square of its own under the build
 * column.
 *
 * It leaves the top bar because the bar is now carrying the wave — the overview
 * and the send control both moved up there, and something had to give. This is
 * the right thing to move: era is the only control in that row that was a
 * *purchase* rather than a readout, and it belongs with the other purchases.
 *
 * Under the build column rather than beside it, because what advancing buys is
 * the greyed-out slots directly above: the rung and the thing it unlocks are
 * now adjacent, which they never were while the rail sat next to Cash. The
 * shortfall still prints, for the reason it always did — "not yet, and by this
 * much" is a plan where a dead button is only a no.
 */
function renderEraDock(w: World): string {
  if (!w.rules.eras) return '';
  const numeral = ROMAN[w.era] ?? String(w.era);
  const cost = advanceEraCost(w);

  // At the top of the ladder there is nothing left to buy, and a permanently
  // disabled button is a worse way to say so than not drawing one.
  if (cost === null) {
    return `<section class="era"><h6>Era</h6><b>${numeral}</b><span class="hint">Top rung</span></section>`;
  }

  const short = cost - w.money;
  return (
    `<section class="era"><h6>Era</h6><b>${numeral}</b>` +
    `<button class="era-buy${short > 0 ? ' poor' : ''}" data-act="era"` +
    ` aria-label="Advance to era ${ROMAN[w.era + 1] ?? w.era + 1} for ${cost}">▲<span>${cost}</span></button>` +
    (short > 0 ? `<span class="hint">short ${short}</span>` : '') +
    `</section>`
  );
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Thousands as `2.0k`, so a long-lived station's damage stays one short token.
 *
 * A maxed Lance on a held board runs to five digits, and the inspector prices
 * its line in words rather than pixels — see the budget `tools/check.ts`
 * enforces on the head row.
 */
const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

function aliveInWave(w: World, wave: number): number {
  let n = 0;
  for (const c of w.creeps) if (!c.dead && c.wave === wave) n++;
  return n;
}

// ------------------------------------------------------------------- deck

/**
 * A **constant** while the deck is closed, and that is the point.
 *
 * The closed deck is one static handle. It used to carry a live status strip
 * repeating the Incoming ribbon forty pixels above it, in the same words, in
 * space that belongs to the board — so the key folded in the alive count and
 * the whole region rebuilt on every kill to redraw text that had not changed
 * meaning. Two live readouts of one fact is one readout and one distraction,
 * and the duplicate was the one sitting on the play area.
 *
 * The early return is therefore load-bearing rather than an optimisation, and
 * it is a trapdoor: anything live added to the closed deck later will silently
 * freeze. `tools/check.ts` asserts the invariance.
 */
export function deckKey(w: World, ui: UiState, inspected: Tower | undefined): string {
  if (!ui.deckOpen) return 'c';

  const s = w.wave;
  return [
    'o',
    ui.selected ?? '-',
    inspected
      ? `${inspected.id}:${inspected.tiers.damage}${inspected.tiers.range}${inspected.tiers.effect}:${inspected.targeting}:${inspected.kills}`
      : '-',
    // Affordability of every slot, plus the two buttons the inspector prices.
    w.money,
    // Which slots are locked, and the ceiling the upgrade buttons price against.
    // Also which sortie cards are open, and — via `s.index` below — what they
    // cost, since a sortie is priced off the wave it would be sent into.
    w.era,
    ui.sortieLane,
    s.index,
    s.phase,
    Math.ceil(s.timer),
    // The inspector prices the armed station against this, and while the deck
    // is open nothing else in this key changes when the last Bulwark dies.
    inspected ? (toughestArmour(w)?.defId ?? '-') : '',
  ].join('|');
}

/** Exported for the deck-width budget in tools/check.ts, like its neighbours. */
export function renderDeck(w: World, ui: UiState, inspected: Tower | undefined): string {
  const handle =
    `<button class="handle" data-act="deck">Deck <span>${ui.deckOpen ? '▼' : '▲'}</span>` +
    `<kbd>Tab</kbd></button>`;

  if (!ui.deckOpen) {
    // The handle alone. Everything the strip used to say, the ribbon says
    // better and higher up; its one non-duplicate — the lives alarm — moved
    // there in `renderTop`.
    return `<div class="strip">${handle}</div>`;
  }

  const build =
    `<section class="build"><h6>Build${ui.selected ? ' · armed' : ''}</h6>` +
    `<div class="slots">${renderSlots(w, ui)}</div></section>`;
  const detail = `<section class="detail">${renderDetail(w, ui, inspected)}</section>`;
  const send = `<section class="send">${handle}${renderSend(w)}</section>`;

  // ── Versus docks, because five sections never did fit one row ─────────────
  //
  // The two-row wrap this replaces was the previous answer to the same
  // problem: the deck is a fixed composition laid out against 1040px and
  // scaled as a whole (`fitCanvas`), so horizontal room is a hard budget, and
  // versus adds two sections the campaign never had. All five came to ~1515px
  // of 1008; flex spent the overrun on whatever could give, and the inspector
  // collapsed to 68px — narrower than ONE of its three upgrade buttons.
  //
  // Wrapping fixed the overflow by spending height, and left the inspector
  // still the narrowest thing on screen. Docking spends *width the letterbox
  // was wasting* instead: the board is 1040 of a 1685-wide stage, and the
  // difference is two columns that were previously black. The detail column
  // goes from 68px to 468.
  //
  // The sections are the same sections — this emits `build`, `detail`,
  // `sorties` and the era square, and `styles.css` puts them where they go.
  // The one addition is the era dock, which is a *move* out of the top bar
  // rather than a new control. The send button does not appear here at all
  // any more: it rides with the ribbon in `renderTop`, which is why `handle`
  // is emitted on its own below.
  if (w.rules.sorties) {
    return (
      `<div class="panel docks">` +
      build +
      detail +
      renderSortieDeck(w, ui) +
      renderEraDock(w) +
      // Docked, the deck never covers the board, so collapsing it buys nothing
      // — but Tab still collapses it, and a player who pressed Tab needs the
      // handle to be somewhere. It rides in the sortie dock's header.
      handle +
      `</div>`
    );
  }

  // The campaign's single row, unchanged — `renderSortieDeck` is empty here, so
  // this stays byte-identical to what it has always emitted.
  return (
    `<div class="panel">` +
    build +
    `<span class="sep"></span>` +
    renderSortieDeck(w, ui) +
    detail +
    `<span class="sep"></span>` +
    send +
    `</div>`
  );
}

/**
 * The sortie deck: what you can send, and which lane it goes down.
 *
 * Empty markup outside versus, so the campaign's deck is byte-identical.
 *
 * **The lane picker is a mode, not a per-send argument.** Two rows of six
 * buttons would put the whole table on screen at once and read as twelve
 * choices; one row plus a lane toggle reads as the two decisions it actually
 * is — *what* to send, and *where*. The lane persists between sends because
 * pressure down one lane is the strategy, and re-picking it every time would
 * tax the thing the board was built to reward.
 *
 * Locked rungs stay visible and name the era that opens them, exactly as build
 * slots do. A deck that hid what it was hiding would make the era ladder's
 * offensive half invisible until it was already bought, which is the wrong
 * order — the reason to save is supposed to be legible before you save.
 */
function renderSortieDeck(w: World, ui: UiState): string {
  if (!w.rules.sorties) return '';

  const lanes = w.map.routes
    .map((r, i) => {
      const on = ui.sortieLane === i ? ' class="on"' : '';
      return `<button data-act="lane" data-v="${i}"${on}>${r.id}</button>`;
    })
    .join('');

  const cards = SORTIE_IDS.map((id) => {
    const def = SORTIES[id];
    if (!sortieUnlocked(w, id)) {
      const gate = `Era ${ROMAN[def.era] ?? def.era}`;
      return (
        `<div class="sortie locked" tabindex="0" aria-label="${ENEMIES[def.enemy].name}, opens at ${gate}">` +
        `${contactIcon(def.enemy, 22)}<span class="wave">${gate}</span>` +
        // A locked rung gets its flyout too. What era III buys is exactly the
        // thing a player weighs while deciding whether to save for it.
        sortieFlyout(id, w, sortieCost(id, w.wave.index, w)) +
        `</div>`
      );
    }
    const cost = sortieCost(id, w.wave.index, w);
    const poor = w.money < cost;
    // Weight is printed only when it is not 1. A "×1" on four of six cards is
    // noise that makes the two that matter harder to find.
    const weight = def.weight > 1 ? `<i class="w">${def.weight}</i>` : '';
    // Hull at the *receiver's* wave, on the same standing convention
    // `sortieCost` documents: both boards run one seeded metronome, so this
    // world's index stands in for theirs, and the price and the hull are then
    // quoted against the same wave rather than against two different ones.
    // This is the number the send is judged on — what their defence has to
    // chew through — and the card charged for it without ever printing it.
    const { hp } = scaledStats(def.enemy, w.wave.index, w.rules);
    return (
      `<button class="sortie${poor ? ' poor' : ''}" data-act="sortie" data-id="${id}"` +
      ` aria-label="Send ${ENEMIES[def.enemy].name} down ${w.map.routes[ui.sortieLane]?.id ?? 'lane'} for ${cost}">` +
      `${contactIcon(def.enemy, 22)}${weight}` +
      `<i class="sname">${ENEMIES[def.enemy].name}</i>` +
      `<b>${cost}</b><i class="shull">${hp} hull</i>` +
      sortieFlyout(id, w, cost) +
      `</button>`
    );
  }).join('');

  // One header row, not a stack. The label, the lane and the two standing rules
  // are all about the same question — what goes down which lane and what it
  // costs — and stacking them let the lane toggle stretch to the full width of
  // the dock, which made a two-way choice look like a progress bar.
  return (
    `<section class="sorties">` +
    `<div class="sortie-head"><h6>Send</h6>` +
    `<div class="seg lanes">${lanes}</div>` +
    `<span class="hint">lane persists between sends · arrives at their midfield</span>` +
    `<span class="hint far">priced off their wave · ` +
    `${Math.round(BALANCE.sortie.kickback * 100)}% back if it reaches their core</span>` +
    `</div>` +
    `<div class="sortie-row">${cards}</div></section>`
  );
}

/**
 * What a sortie is, for the card that only had room for a price.
 *
 * The build column got a flyout because `title` never fires on touch; the
 * sortie roster has exactly the same problem and is the half of the deck a
 * player understands least, because these six only ever arrive on someone
 * else's board. The mock wires hover handlers onto these cards and then never
 * reads the state — `t0`–`t5` are computed and unused — so this is the
 * unfinished half of a decision it had already taken for the build slots.
 *
 * Figures are the receiver's, on the same convention as the price beside them.
 */
function sortieFlyout(id: SortieId, w: World, cost: number): string {
  const def = SORTIES[id];
  const e = ENEMIES[def.enemy];
  const { hp, shield } = scaledStats(def.enemy, w.wave.index, w.rules);

  const chip = (k: string, v: string): string =>
    `<span class="fc"><i>${k}</i><b>${v}</b></span>`;

  return (
    `<span class="fly" role="tooltip">` +
    `<span class="fly-head"><b>${e.name}</b><em>${cost}</em></span>` +
    `<span class="fly-chips">` +
    chip('hull', String(hp)) +
    (shield > 0 ? chip('shield', String(shield)) : '') +
    (e.armor > 0 ? chip('armour', String(e.armor)) : '') +
    chip('speed', `${e.speed.toFixed(1)}tl/s`) +
    (def.weight > 1 ? chip('sends', `${def.weight}×`) : '') +
    `</span>` +
    `<span class="fly-blurb">Costs them ${e.leakDamage} ` +
    `${e.leakDamage === 1 ? 'life' : 'lives'} if it reaches their core, and pays you ` +
    `${sortieKickback(cost)} back.</span>` +
    `</span>`
  );
}

/**
 * The five build slots, in five states.
 *
 * The state that mattered most was the one that did not exist: **"can't afford"
 * and "locked" used to share one signal** — a dimmed slot — for two unrelated
 * facts, so the player had to read to find out which. Now short states the gap
 * as a number and locked states the wave and nothing else. They can no longer
 * be confused because they no longer look alike.
 *
 * Cost is a corner numeral with no sigil, and the glyph carries the mechanic
 * (see `stationShape.ts`) so the roster is learnable at a glance rather than by
 * reading five names.
 *
 * **The slot is the glyph now.** Name, blurb and figures moved out into a
 * flyout, which is what the build column's 103px can hold — but the width is
 * the smaller reason. The blurb used to live in `title`, and `title` never
 * fires on touch, so on the devices where the roster is hardest to learn it was
 * simply not there. A flyout on hover *and* on focus is the same information on
 * both, and it can carry the derived figures too, which a tooltip could not.
 *
 * Those figures stay derived. `mechanics()` reads them off the def, so a tuned
 * `pierce` updates the flyout, where prose saying "pierces three" would quietly
 * start lying.
 */
export function renderSlots(w: World, ui: UiState): string {
  return TOWER_IDS.map((id) => {
    const def = TOWERS[id];

    // Locked says one thing: when. No cost, no shortfall, nothing to weigh —
    // it is not a decision yet.
    //
    // Under eras "when" is a *purchase* rather than a moment, so the slot names
    // the rung instead of the wave. Both are the same sentence — this is what
    // you do not have yet, and here is the thing that will give it to you.
    if (!isUnlocked(w, id)) {
      const gate = w.rules.eras ? `Era ${ROMAN[def.era] ?? def.era}` : `Wave ${def.unlockWave + 1}`;
      return (
        `<div class="slot locked" tabindex="0" aria-label="${def.name}, unlocks at ${gate}">` +
        `${stationIcon(id, 40)}<span class="wave">${gate}</span>${flyout(id, gate)}</div>`
      );
    }

    const short = def.cost - w.money;
    const poor = short > 0;
    const cls = ['slot', `t-${id}`, ui.selected === id ? 'armed' : '', poor ? 'poor' : '']
      .filter(Boolean)
      .join(' ');

    return (
      `<button class="${cls}" data-act="arm" data-id="${id}">` +
      `<kbd>${def.hotkey}</kbd>` +
      `<span class="corner">${def.cost}</span>` +
      stationIcon(id, 40) +
      // Naming the gap turns "no" into "not yet, and by this much" — which is
      // the difference between a dead control and a plan. It stays on the slot
      // rather than moving into the flyout: it is the one fact that changes
      // while you are looking at the column deciding what to afford.
      (poor ? `<span class="short">short ${short}</span>` : '') +
      flyout(id) +
      `</button>`
    );
  }).join('');
}

// --------------------------------------------------------------- detail

function renderDetail(w: World, ui: UiState, inspected: Tower | undefined): string {
  if (inspected !== undefined) return renderInspector(w, inspected);
  if (ui.selected !== null) return renderArmed(ui.selected);
  return renderNextContact(w);
}

/**
 * `stat()` and `mechanics()` lived here and are gone.
 *
 * Both rendered a *label* beside a value — "Dmg 8", "Slows to 74% for 1.2s" —
 * and labels were most of the word count that made the inspector the densest
 * surface in the game to read while under attack. `mechanicChips` and
 * `axisChips` replace them with bare numerals carrying units, and move the
 * sentence into `title` where it costs nothing on screen.
 *
 * The one piece of `mechanics()` worth restating: upgraded values are sums of
 * floats, so every figure is `toFixed`. `1.2000000000002s` is not a stat, it is
 * a bug report.
 */

/**
 * What this station does that the others don't, in numbers.
 *
 * Derived from the def rather than written into the blurb: a blurb saying
 * "pierces three" becomes a lie the moment `pierce` is tuned, and this game's
 * balance dials move. The blurb carries the identity, this carries the figures,
 * and only one of them can go stale.
 *
 * The stat cells deliberately do not cover these — Dmg/Rate/Rng are the axes
 * every station shares and are worth comparing side by side, where the special
 * is exactly the thing that has no counterpart to compare against.
 */
/**
 * The station's own numbers as numeral chips, in its tint.
 *
 * Wordless by construction, which is what lets the inspector hit its budget:
 * `↓74%` and `1.2s` say what "Slows to 74% for 1.2s" said, in a form the eye
 * takes in without reading. The full sentence survives in `title`, which costs
 * nothing on screen.
 *
 * Station-specific first and in tint, shared axes after and in neutral — so the
 * thing that distinguishes this station from the other four leads.
 */
/**
 * The glyph and its meaning, together, so the two renderings below cannot
 * describe the same mechanic differently.
 */
function mechanics(d: TowerStats): { glyph: string; words: string }[] {
  const out: { glyph: string; words: string }[] = [];

  if (d.pierce > 0) out.push({ glyph: `↷${d.pierce}`, words: `Passes through ${d.pierce} more` });
  if (d.splashRadius > 0) {
    out.push({ glyph: `◎${d.splashRadius.toFixed(1)}`, words: `Blast ${d.splashRadius.toFixed(1)} tiles` });
  }
  if (d.slowFactor < 1) {
    out.push({ glyph: `↓${Math.round(d.slowFactor * 100)}%`, words: `Slows to ${Math.round(d.slowFactor * 100)}%` });
    out.push({ glyph: `${d.slowSeconds.toFixed(1)}s`, words: `for ${d.slowSeconds.toFixed(1)} seconds` });
  }
  if (d.chainJumps > 0) {
    out.push({ glyph: `⤳${d.chainJumps}`, words: `Jumps to ${d.chainJumps} more` });
    out.push({ glyph: `${d.chainRange.toFixed(1)}tl`, words: `within ${d.chainRange.toFixed(1)} tiles` });
  }
  if (d.rampPerSecond > 0) {
    const seconds = (d.rampMax - 1) / d.rampPerSecond;
    out.push({ glyph: `×${Number(d.rampMax.toFixed(2))}`, words: `Ramps to x${d.rampMax} on one target` });
    out.push({ glyph: `${seconds.toFixed(1)}s`, words: `over ${seconds.toFixed(1)} seconds` });
  }
  return out;
}

/**
 * The name, blurb and figures a build slot no longer has room to print.
 *
 * This is the payload that used to be a `title` attribute plus a caps footer.
 * As markup it can carry `axisChips` and `mechanicWords` — the same derived
 * figures the armed panel shows — where a tooltip could only hold one string,
 * and it opens on `:focus-within` as well as `:hover`, so keyboard and touch
 * reach it. `styles.css` opens it to the right of the column and never over the
 * board.
 *
 * Locked slots get one too, naming the gate. A player deciding whether to save
 * for era III should be able to read what era III actually buys.
 */
function flyout(id: TowerId, gate?: string): string {
  const def = TOWERS[id];
  const price = gate ?? String(def.cost);
  return (
    `<span class="fly" role="tooltip">` +
    `<span class="fly-head"><b>${def.name}</b><em>${price}</em></span>` +
    `<span class="fly-blurb">${def.blurb}</span>` +
    axisChips(def) +
    mechanicWords(def) +
    `</span>`
  );
}

function mechanicChips(d: TowerStats): string {
  const chips = mechanics(d).map((m) => `<b class="mc" title="${m.words}">${m.glyph}</b>`);
  return `<span class="mech">${chips.join('')}</span>`;
}

/**
 * The same mechanics as a sentence, for the armed panel.
 *
 * `title` never fires on touch, so on a tablet the glyph row above is a line of
 * unexplained symbols. The armed panel is where a station is being *chosen*, so
 * it is where the words are worth their space; the inspector, consulted
 * mid-wave, keeps the terse form.
 */
function mechanicWords(d: TowerStats): string {
  const m = mechanics(d);
  if (m.length === 0) return '';
  return `<span class="mech-words">${m.map((x) => x.words).join(' · ')}</span>`;
}

/**
 * Damage, rate and range — the three every station has, so always neutral.
 *
 * `fed` is the station's *actual* interval once support is counted, and is
 * passed only by the inspector, which is the only panel looking at a station
 * that exists on a board. It must come from `effectiveInterval`, never from a
 * local recomputation: this is the figure a player prices an Overclock against,
 * and a HUD that derived its own copy would drift from the simulation at exactly
 * the moment money is being spent. Same discipline as `effectiveDamage` and
 * `rampFactor`.
 */
function axisChips(d: TowerStats, verbose = false, fed?: number): string {
  // Named in the armed panel, bare in the inspector. A lone "8" is ambiguous
  // the first time you meet it and obvious the twentieth, and only one of those
  // two audiences is looking at this panel.
  const chip = (hint: string, label: string, v: string): string =>
    verbose ? `<b><i class="ax">${label}</i>${v}</b>` : `<b title="${hint}">${v}</b>`;
  // A station that does not shoot has neither a damage nor a rate to compare,
  // and `1 / 0` printed `Infinity/s` on the panel until the word-budget gate
  // caught it. Its `+0.35/s` mechanic chip is the number that matters and is
  // already rendered beside these; reach still is one, because reach is what
  // decides who it feeds.
  const shoots = d.fireInterval > 0;
  const rate = (interval: number): string => (1 / interval).toFixed(1);

  // `2.0→2.4/s` rather than a bare `2.4/s`. A station silently firing faster
  // than its own stat block says is the kind of number a player reads as a bug;
  // showing the base it came from is what makes the Overclock beside it legible
  // as the cause. Both halves are numerals, so the word budget is untouched.
  const boosted = shoots && fed !== undefined && fed < d.fireInterval;
  const rateChip = boosted
    ? chip(
        `Shots per second — ${rate(d.fireInterval)} on its own, ${rate(fed!)} with support`,
        'rate',
        `${rate(d.fireInterval)}<i class="fed">→${rate(fed!)}</i>/s`,
      )
    : chip('Shots per second', 'rate', `${rate(d.fireInterval)}/s`);

  return (
    `<span class="axes">` +
    (shoots ? chip('Damage per shot', 'dmg', formatDamage(d.damage)) : '') +
    (shoots ? rateChip : '') +
    chip('Reach in tiles', 'reach', `${d.range.toFixed(1)}tl`) +
    `</span>`
  );
}


/**
 * The armed state — the moment the player is choosing *where*.
 *
 * It used to spend thirty-one words re-explaining *what*, including a hint the
 * player has read every time they have ever armed a tower. The identity is a
 * picture now: the station at 48px wearing its own mark, its numbers first and
 * in tint, the shared axes after and in neutral.
 *
 * Cost stays visible, because it is the number the decision turns on. The
 * cancel hint shrinks to a keycap. The board ghost's legal/illegal colouring
 * remains the primary yes/no — this panel never becomes where placement
 * validity is read.
 */
export function renderArmed(id: TowerId): string {
  const d = TOWERS[id];
  return (
    `<div class="head t-${id}">${stationIcon(id, 48)}` +
    `<div class="lede"><b>${d.name}</b>` +
    `<span class="blurb">placing · ${d.cost}</span></div>` +
    // A real button, not the bare keycap this used to be. Touch has neither
    // right-click nor Escape, so cancelling a placement had no affordance at
    // all there. `arm` is already a toggle and this station is already armed,
    // so pressing it disarms — no new action, no new listener, no new port —
    // and the keycap survives inside it as the desktop hint.
    `<button class="armed-cancel" data-act="arm" data-id="${id}" ` +
    `aria-label="Cancel placement">Cancel <kbd>Esc</kbd></button></div>` +
    // The blurb was a `title` on the line above, i.e. invisible on every touch
    // device — and this is the one screen whose entire job is explaining the
    // station you just picked. It is now text.
    `<span class="armed-blurb">${d.blurb}</span>` +
    `<div class="t-${id}">${mechanicChips(d)}</div>` +
    mechanicWords(d) +
    axisChips(d, true)
  );
}

export function renderInspector(w: World, t: Tower): string {
  const d = TOWERS[t.defId];
  const s = t.stats;
  const nextDamage = nextStats(t, 'damage', tierCeiling(w))?.damage ?? null;

  // Iconic, with **the active mode labelled** — not labels-on-hover.
  //
  // Four unlabelled glyphs would be unguessable (Strong and Close especially),
  // `title` never fires on touch, and this control mutates game state so a
  // mis-click has a cost. Naming only the selected one costs exactly one word,
  // is self-teaching — the player sees "First" beside its glyph and learns the
  // glyph — and works without a pointer. `aria-label` on all four regardless.
  const modes = TARGET_MODES.map((m) => {
    const on = t.targeting === m;
    return (
      `<button data-act="target" data-mode="${m}" class="${on ? 'on' : ''}"` +
      // No `title`: it duplicates the aria-label, and the active mode is
      // already spelled out beside its glyph — which is the affordance that
      // works without a pointer.
      ` aria-label="${TARGET_LABEL[m]}">${TARGET_GLYPH[m]}` +
      (on ? `<span>${TARGET_LABEL[m]}</span>` : '') +
      `</button>`
    );
  }).join('');

  return (
    `<div class="inspector">` +
    // Portrait column: the station wearing its real collar at full size, so the
    // board's positional upgrade code is taught here rather than by a 13px
    // afterthought on a button. The board only has to jog this memory.
    `<div class="portrait t-${t.defId}">${stationIcon(t.defId, 40)}` +
    `${collarDial(t.tiers, BALANCE.upgrade.maxTier, 56)}` +
    `<span class="mk">Mk ${'I'.repeat(visualTier(t))}</span></div>` +
    `<div class="body">` +
    `<div class="head t-${t.defId}"><b>${d.name}</b>` +
    // Tile coordinates dropped — the one fact here nobody has ever needed.
    //
    // Damage dealt used to be a `title` on this line, which meant it did not
    // exist on touch and was a hover away everywhere else. It is the figure
    // that answers "is this emplacement earning its tile" — the question the
    // Sell button below poses — so where there is room it is text.
    //
    // Where there is room is versus, and only versus. The docked detail column
    // is 468px and runs the full height of the stage; the campaign's inspector
    // is still a section of a 150px deck, and the ten-word budget
    // tools/check.ts enforces on this row is calibrated for that. Spending two
    // of those ten words here would be spending the campaign's budget to buy
    // versus a line it has the room for and the campaign does not.
    `<span class="blurb"${w.rules.sorties ? '' : ` title="${Math.round(t.damageDealt)} damage dealt"`}>` +
    `${t.kills} ${t.kills === 1 ? 'kill' : 'kills'}` +
    (w.rules.sorties ? ` · ${compact(t.damageDealt)} damage dealt` : '') +
    `</span></div>` +
    // Live stats, not the def: this is where an effect purchase becomes visible
    // in numbers, including the secondary dial the upgrade card omits. One row
    // for both chip groups — the inspector's height budget has no room for two.
    `<div class="chipline t-${t.defId}">${mechanicChips(s)}${axisChips(s, false, effectiveInterval(t))}</div>` +
    renderArmourLine(w, t, nextDamage) +
    `</div>` +
    `<div class="upgrades">${renderPathButtons(w, t)}</div>` +
    `<div class="actions"><div class="seg targeting">${modes}</div>` +
    `<button class="btn" data-act="sell">Sell ${sellValue(t)}</button></div>` +
    `</div>`
  );
}

/**
 * The three upgrade tracks, one button each: damage and range are shared
 * axes, the third is whatever `effectUpgrade` says this station deepens.
 * Every preview is computed by `nextStats` — the same function the purchase
 * runs — so the button can never promise a number the sim won't deliver.
 */
function renderPathButtons(w: World, t: Tower): string {
  return UPGRADE_PATHS.filter((path) => path !== 'damage' || hasDamagePath(t.defId)).map((path) => {
    const ceiling = tierCeiling(w);
    const cost = upgradeCost(t, path, ceiling);
    const next = nextStats(t, path, ceiling);
    const { label, value } = pathPreview(t, path, next);
    // Pips always show the full ladder, never the era's slice of it: a track
    // capped at Mk II by the era is *held back*, and drawing two pips would say
    // it was finished. The disabled button says why.
    const pips = tierPips(t.tiers[path], BALANCE.upgrade.maxTier);

    // The dial shows where this path sits on the station's collar, so the
    // board's positional code is taught at the moment the player buys into it.
    const dial = pathDial(path);

    // Label+pips over value+price, two columns — not four stacked rows. The
    // deck is 150px tall and three of these sit under the portrait band; a
    // stacked button was the difference between fitting and spilling out of
    // the panel at both ends.
    if (cost === null) {
      return `<span class="path maxed"><label>${dial}${label}</label>${pips}<b>${value}</b><em>Max</em></span>`;
    }
    return (
      `<button class="path${w.money < cost ? ' poor' : ''}" data-act="upgrade" data-path="${path}">` +
      `<label>${dial}${label}</label>${pips}<b>${value}</b><em>$${cost}</em></button>`
    );
  }).join('');
}

function pathPreview(
  t: Tower,
  path: UpgradePath,
  next: TowerStats | null,
): { label: string; value: string } {
  // Destination only, not `now → next`: the current figure is already on
  // screen in the chip line directly above, and the button's row has to hold
  // the price too. Repeating the "now" was three numbers the panel already
  // shows, at a width that cannot afford them.
  const s = t.stats;
  if (path === 'damage') {
    return {
      label: 'Dmg',
      value: next === null ? String(s.damage) : `→ ${next.damage}`,
    };
  }
  if (path === 'range') {
    return {
      label: 'Rng',
      value: next === null ? s.range.toFixed(1) : `→ ${next.range.toFixed(1)}`,
    };
  }

  // The effect button previews the *headline* stat — the first key in
  // `perTier`. A secondary dial (Singularity's duration, Filament's spin-up)
  // shows up in the mechanics line instead; two arrows on one small button
  // read as noise.
  const d = TOWERS[t.defId];
  const key = Object.keys(d.effectUpgrade.perTier)[0] as keyof TowerStats;
  return {
    label: d.effectUpgrade.name,
    value:
      next === null
        ? effectValue(key, s[key])
        : `→ ${effectValue(key, next[key])}`,
  };
}

/** Compact display for an effect path's headline stat. */
function effectValue(key: keyof TowerStats, v: number): string {
  switch (key) {
    case 'slowFactor':
      return `${Math.round(v * 100)}%`;
    case 'splashRadius':
    case 'chainRange':
      return v.toFixed(1);
    case 'rampMax':
      return `×${Number(v.toFixed(2))}`;
    default:
      // Counts (pierce, chain jumps): sums of integers, safe to print raw.
      return String(v);
  }
}

/**
 * What this station actually lands on the toughest armour in play.
 *
 * Only rendered when something armoured is in play, because for the first six
 * waves it would be noise — and the whole reason it exists is that the Dmg cell
 * is *misleading* against armour, not merely incomplete. A Singularity Mk I
 * reads "Dmg 3" and lands 0.45 on a Bulwark; a player upgrading it to fight
 * Bulwarks is being misled by the panel.
 *
 * A `.line` beneath the cells rather than a fifth cell: `.cells` is a fixed
 * four-column grid that already holds exactly four, so a fifth would wrap to a
 * lone orphan on a second row.
 */
function renderArmourLine(w: World, t: Tower, next: number | null): string {
  const ref = toughestArmour(w);
  if (ref === null) return '';

  const now = effectiveDamage(t.stats.damage, ref.armor);
  const after = next === null ? null : effectiveDamage(next, ref.armor);
  const kept = now / t.stats.damage;

  // Flagged past half, so "this is the wrong tool for that" reads without the
  // player doing the division.
  const cls = kept <= 0.5 ? ' class="bad"' : '';
  const name = ENEMIES[ref.defId].name;

  // A proportional bar rather than a percentage: the sliver *is* the 16%, so
  // the player reads how much of every hit survives instead of doing the
  // subtraction. The contact glyph names which one, so the line costs no words
  // — the sentence it replaced survives in `title`.
  const label =
    `${ref.inbound ? 'Inbound' : 'On the board'}: ${name} · ` +
    `${formatDamage(now)} of ${formatDamage(t.stats.damage)} per hit · ` +
    `armour eats ${Math.round((1 - kept) * 100)}%`;

  // The contact stays a glyph here, deliberately. Naming it would read better
  // in isolation but this is the inspector, under a ten-word budget, and the
  // glyph→name mapping is taught one panel over: renderNextContact now labels
  // every mark in the wave preview, which is the surface you read *before* the
  // wave rather than during it. aria-label carries the full sentence for screen
  // readers and costs nothing on screen.
  return (
    `<div class="line armour" title="${label}" aria-label="${label}">` +
    `${contactIcon(ref.defId, 18)}` +
    `<span class="bar"><i style="width:${(kept * 100).toFixed(1)}%"></i></span>` +
    `<b${cls}>${formatDamage(now)}${after === null ? '' : ` → ${formatDamage(after)}`}</b>` +
    `</div>`
  );
}



interface WaveGroup {
  readonly enemy: EnemyId;
  n: number;
  readonly hp: number;
  readonly shield: number;
}

/**
 * The coming wave, grouped by type in order of first arrival.
 *
 * This used to read `plan[0]`'s name and hp and apply them to `plan.length`,
 * which was true only while there was one contact type. With six it announced
 * wave 10 as "40 × Drifter" when barely a quarter of it was Drifters — a
 * confident lie, in the one panel whose entire job is telling the player what to
 * prepare for.
 *
 * Shared now, because versus draws this twice: the detail slot still shows it
 * when nothing is selected, and the top bar shows it *always*. Two copies of the
 * grouping would be two chances to disagree about what is inbound.
 */
function waveGroups(w: World): WaveGroup[] {
  const plan = planWave(w.seed, w.wave.index, w.rules, w.map.routes);
  const groups: WaveGroup[] = [];
  for (const p of plan) {
    const hit = groups.find((g) => g.enemy === p.enemy);
    if (hit === undefined) groups.push({ enemy: p.enemy, n: 1, hp: p.hp, shield: p.shield });
    else hit.n++;
  }
  return groups;
}

/**
 * Effective health, so a Warden's overshield counts toward "toughest" — it is
 * health the player has to chew through whichever pool it sits in.
 */
function toughestOf(groups: readonly WaveGroup[]): WaveGroup {
  return groups.reduce((a, b) => (b.hp + b.shield > a.hp + a.shield ? b : a));
}

/**
 * The wave overview, in the top bar, in versus only.
 *
 * **It is here because the detail slot cannot hold it.** `renderDetail` shows
 * the wave preview only when nothing is selected — and in versus that slot is
 * never empty for long, because clicking a station to upgrade it replaces the
 * preview with the inspector. So the one readout telling you what is walking at
 * you disappeared at exactly the moment you were spending money to stop it.
 *
 * Compressed rather than reproduced: glyph and count per type, then one
 * effective-health figure. The full panel with names still lives in the detail
 * slot, so this is a reminder of something already taught rather than the only
 * place it is said.
 */
function renderWaveOverview(w: World): string {
  const s = w.wave;
  if (s.phase === 'done' && w.creeps.length === 0) return '';

  const groups = waveGroups(w);
  if (groups.length === 0) return '';

  const chips = groups
    .map((g) => `<span class="wo-chip">${contactIcon(g.enemy, 17)}<b>${g.n}</b></span>`)
    .join('');
  const toughest = toughestOf(groups);
  const inbound = groups.reduce((n, g) => n + g.n, 0);

  return (
    `<div class="wave-over">` +
    `<span class="wo-lab">Inbound<i>${inbound} contacts</i></span>` +
    `<span class="wo-chips">${chips}</span>` +
    `<span class="wo-lab">Toughest<i>${toughest.hp + toughest.shield} ehp</i></span>` +
    `</div>`
  );
}

/**
 * What is coming, drawn from `planWave` — the same pure function the spawner
 * uses, so the preview cannot promise a wave the sim won't deliver.
 */
export function renderNextContact(w: World): string {
  const s = w.wave;
  if (s.phase === 'done' && w.creeps.length === 0) {
    return `<div class="head"><b>Route clear</b></div><div class="hint">Nothing else is coming.</div>`;
  }

  const groups = waveGroups(w);
  if (groups.length === 0) {
    return `<div class="head"><b>Wave ${s.index + 1}</b></div>`;
  }

  const inbound = groups.reduce((n, g) => n + g.n, 0);
  const toughest = toughestOf(groups);

  // The real glyph at the real tint, not the name. The panel's whole job is
  // "prepare for this", and it was describing the wave in a language the board
  // does not use — the player had to translate "4 Warden" into the ringed pink
  // circle they were about to see. Armour and shield are visible *before* the
  // wave rather than only during it, which is the point at which they are still
  // actionable.
  // The name rides along under the glyph rather than living in a `title` that
  // never fires on touch. Learning which mark is a Warden is exactly what this
  // panel is for, and the glyph alone cannot teach it.
  const chips = groups
    .map(
      (g) =>
        `<span class="chip">` +
        `${contactIcon(g.enemy, 26)}<b>${g.n}</b>` +
        `<i class="cname">${ENEMIES[g.enemy].name}</i></span>`,
    )
    .join('');

  return (
    `<div class="head"><i class="dot contact"></i><b>Wave ${s.index + 1}</b>` +
    `<span class="blurb">${inbound} inbound</span></div>` +
    `<div class="chips">${chips}</div>` +
    // One effective-health figure, because the biggest glyph above already
    // named which contact it belongs to. Shield counts: it is health the player
    // has to chew through whichever pool it sits in.
    `<div class="hint">Toughest <b>${toughest.hp + toughest.shield}</b> ehp</div>`
  );
}

// ----------------------------------------------------------------- send

/**
 * The send control, beside the ribbon it is about.
 *
 * The same decision `renderSend` poses, in a fifth of the width, because in
 * versus it is riding in the top bar rather than owning a deck section. The
 * hint goes: "sending early pays the remaining timer as cash" is a rule you
 * learn once, and the `+13` on the button is that rule every time after.
 *
 * Spawning and done stay flat readouts. There is nothing to press, and a
 * disabled button says that worse than a sentence does.
 */
function renderTopSend(w: World): string {
  const s = w.wave;
  if (s.phase === 'spawning') return `<span class="top-send flat">Wave ${s.index + 1} running</span>`;
  if (s.phase === 'done') return `<span class="top-send flat">No waves left</span>`;

  const bonus = Math.round(Math.max(0, s.timer) * BALANCE.rushBonusPerSecond);
  return (
    `<button class="top-send" data-act="send"` +
    ` aria-label="Send wave ${s.index + 1} now${bonus > 0 ? `, paying ${bonus}` : ''}">` +
    `Send wave ${s.index + 1}${bonus > 0 ? `<em>+${bonus}</em>` : ''}</button>`
  );
}

function renderSend(w: World): string {
  const s = w.wave;

  if (s.phase === 'spawning') {
    return (
      `<span class="btn send-btn flat">Wave ${s.index + 1} running</span>` +
      `<span class="hint">Wait for it to finish spawning</span>`
    );
  }
  if (s.phase === 'done') {
    return (
      `<span class="btn send-btn flat">No waves left</span>` +
      `<span class="hint">Clear the board to finish</span>`
    );
  }

  const bonus = Math.round(Math.max(0, s.timer) * BALANCE.rushBonusPerSecond);
  return (
    `<button class="btn send-btn primary" data-act="send">Send wave ${s.index + 1}` +
    (bonus > 0 ? ` <em>+$${bonus}</em>` : '') +
    `</button>` +
    `<span class="hint">Sending early pays the remaining timer as cash</span>`
  );
}

// -------------------------------------------------------------- overlays

function renderOverlay(
  w: World,
  ui: UiState,
  toast: Extract<SimEvent, { type: 'waveCleared' }> | null,
  breachLives: number | null,
  campaign: CampaignPorts | undefined,
): string {
  if (w.phase === 'lost') return renderDefeat(w, campaign);
  if (w.phase === 'won') return renderVictory(w, campaign);
  if (ui.paused) return renderPaused(w, ui);
  // A breach outranks a clear: they can overlap when the last creep of a wave
  // is the one that got through, and the bad news is the news.
  if (breachLives !== null) return renderBreach(breachLives);
  if (toast !== null) return renderClearToast(toast);
  return '';
}

/**
 * The leak banner. Three signals fire together — this, the goal flare, and the
 * screen-edge rim in `effects.ts` — so a leak is legible whether the player was
 * watching the core or the deck.
 */
function renderBreach(lives: number): string {
  return (
    `<div class="breach">` +
    `<i class="dot crit"></i>` +
    `<b>CORE BREACHED</b>` +
    `<span>${lives} ${lives === 1 ? 'life' : 'lives'} remaining</span>` +
    `</div>`
  );
}

/**
 * Which of the four sound buttons is lit.
 *
 * Mute is checked before volume, so turning the sound off and back on returns
 * to the level it was at rather than silently resetting it — the volume is kept
 * across a mute, and this is the readout that has to agree with that.
 */
function soundStep(prefs: UiPrefs): string {
  if (prefs.muted || prefs.volume <= 0.001) return 'off';
  if (prefs.volume < 0.45) return 'low';
  return prefs.volume < 0.8 ? 'mid' : 'high';
}

function renderClearToast(ev: Extract<SimEvent, { type: 'waveCleared' }>): string {
  const item = (v: string, label: string, cls = ''): string =>
    `<span class="item"><b class="${cls}">${v}</b><label>${label}</label></span>`;
  return (
    `<div class="card toast">` +
    `<span class="eyebrow">Wave ${ev.wave + 1} cleared</span>` +
    `<div class="items">` +
    item(`+$${ev.bounty}`, `bounty · ${ev.kills} kills`) +
    item(`+$${ev.reward}`, 'clear bonus', 'accent') +
    (ev.leaked > 0 ? item(`−${ev.leaked}`, 'leaked', 'danger') : '') +
    `</div></div>`
  );
}

export function renderPaused(w: World, ui: UiState): string {
  const toggle = (
    act: string,
    opts: readonly [string, string][],
    active: string,
  ): string =>
    `<div class="seg">` +
    opts
      .map(
        ([v, label]) =>
          `<button data-act="${act}" data-v="${v}" class="${v === active ? 'on' : ''}">${label}</button>`,
      )
      .join('') +
    `</div>`;

  return (
    `<div class="scrim"></div><div class="card">` +
    `<span class="eyebrow">${w.map.name}</span><h2>Paused</h2>` +
    `<div class="rows">` +
    `<div class="row"><span>Reach circles</span>${toggle(
      'pref-reach',
      [
        ['hover', 'Hover'],
        ['always', 'Always'],
      ],
      ui.prefs.reachCircles,
    )}</div>` +
    `<div class="row"><span>Damage numbers</span>${toggle(
      'pref-damage',
      [
        ['on', 'On'],
        ['off', 'Off'],
      ],
      ui.prefs.damageNumbers ? 'on' : 'off',
    )}</div>` +
    // Defaults *off* for anyone whose system asks for reduced motion, so this
    // row is where they would turn it on rather than where they discover it has
    // been running all along.
    `<div class="row"><span>Route current</span>${toggle(
      'pref-stream',
      [
        ['on', 'On'],
        ['off', 'Off'],
      ],
      ui.prefs.stream ? 'on' : 'off',
    )}</div>` +
    `<div class="row"><span>Sound</span>${toggle(
      'pref-sound',
      [
        ['off', 'Off'],
        ['low', 'Low'],
        ['mid', 'Mid'],
        ['high', 'High'],
      ],
      soundStep(ui.prefs),
    )}</div>` +
    `</div>` +
    `<div class="hr"></div>` +
    `<button class="btn primary wide" data-act="pause">Resume <em>Esc</em></button>` +
    `<button class="btn wide" data-act="restart">Restart sector</button>` +
    `</div>`
  );
}

/**
 * "3 / 12" on a finite arc, plain "3" on an endless one.
 *
 * Shared by the status strip and the defeat card so the two cannot disagree,
 * and so neither of them ever prints the literal string "Infinity" — which is
 * what `waveCount` honestly returns for a versus match and what a player would
 * reasonably read as a bug.
 */
function heldLabel(w: World): string {
  const total = waveCount(w.rules);
  const cleared = Math.max(0, w.wave.clearedThrough + 1);
  return Number.isFinite(total) ? `${cleared} / ${total}` : String(cleared);
}

function renderDefeat(w: World, campaign: CampaignPorts | undefined): string {
  const cov = coverage(w);
  const versus = w.rules.sorties;

  // Versus is not a sector, cannot be cleared, and has nothing to advance to,
  // so every noun on this card changes. It is also the only board where some
  // of the damage was *bought* by somebody — a run that merged those into one
  // "leaks" figure would hide the thing the player most wants explained.
  const taken = w.stats.sortiesTaken;
  const third = versus
    ? bigStat('Sorties taken', String(taken), taken > 0 ? 'danger' : '')
    : bigStat('Leaks', String(w.stats.leaks), 'danger');

  return (
    `<div class="scrim lost"></div><div class="card lost">` +
    `<span class="eyebrow danger">${versus ? 'Core lost' : 'Sector lost'}</span>` +
    `<h2>The core went dark on wave ${w.wave.index + 1}</h2>` +
    `<div class="grid3">` +
    `${bigStat('Waves held', heldLabel(w))}` +
    `${bigStat('Contacts killed', String(w.stats.kills))}` +
    `${third}` +
    `</div>` +
    `<div class="note danger"><span class="eyebrow danger">What broke</span>` +
    `<p>${describeGaps(cov)}</p></div>` +
    (versus
      ? `<button class="btn primary wide" data-act="restart">Play it again</button>`
      : `<button class="btn primary wide" data-act="restart">Retry sector</button>` +
        (campaign === undefined ? '' : `<button class="btn wide" data-act="menu">Choose another sector</button>`))
  );
}

function renderVictory(w: World, campaign: CampaignPorts | undefined): string {
  const g = grade(w);
  const hint = nextGradeHint(w);
  return (
    `<div class="scrim won"></div><div class="card won">` +
    `<div class="head-row"><div><span class="eyebrow accent">Sector held</span>` +
    `<h2>All ${waveCount(w.rules)} waves turned back</h2></div>` +
    `<span class="grade">${g}</span></div>` +
    `<div class="grid3">` +
    `${bigStat('Lives kept', `${w.lives} / ${w.rules.startingLives}`)}` +
    `${bigStat('Contacts killed', String(w.stats.kills))}` +
    `${bigStat('Time', formatClock(w.time))}` +
    `</div>` +
    (hint === null
      ? ''
      : `<div class="note accent"><span class="eyebrow accent">Next grade up</span><p>${hint}</p></div>`) +
    victoryActions(campaign, Math.floor(w.money))
  );
}

/**
 * The buttons under a win.
 *
 * Whatever the player is most likely to want next is the primary, and that
 * differs by where they are: mid-campaign it is the level they just unlocked,
 * at the end of the campaign there is nothing to unlock and replaying for a
 * better grade is the only thing left, and in Race mode none of this exists.
 */
function victoryActions(campaign: CampaignPorts | undefined, bank: number): string {
  if (campaign === undefined) {
    return `<button class="btn primary wide" data-act="restart">Play again</button>`;
  }
  if (campaign.nextName === null) {
    return (
      `<div class="note accent"><span class="eyebrow accent">Campaign complete</span>` +
      `<p>Every sector held. The grades are still there to beat — and Blackout is still waiting.</p></div>` +
      `<button class="btn primary wide" data-act="menu">Choose a sector</button>` +
      `<button class="btn wide" data-act="restart">Play again</button>`
    );
  }
  // The bank is stated here, on the button, and in the note — because a rule the
  // player only discovers *after* it has already cost them is not a rule they
  // can play around. Naming the amount and what it replaces is the whole reason
  // saving becomes a decision rather than a surprise.
  return (
    `<div class="note accent"><span class="eyebrow accent">Banked</span>` +
    `<p><b>$${bank}</b> left over becomes your entire starting budget on ` +
    `${campaign.nextName} — it replaces the usual amount rather than adding to ` +
    `it. Coming back to this sector from the menu always starts fresh.</p></div>` +
    `<button class="btn primary wide" data-act="next">` +
    `Next sector: ${campaign.nextName} <em>with $${bank}</em></button>` +
    `<button class="btn wide" data-act="restart">Play again</button>` +
    `<button class="btn wide" data-act="menu">Choose another sector</button>`
  );
}

function bigStat(label: string, value: string, cls = ''): string {
  return `<span class="big"><label>${label}</label><b class="${cls}">${value}</b></span>`;
}
