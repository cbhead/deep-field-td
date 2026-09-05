import { Application, Container } from 'pixi.js';
import {
  DECK_PX,
  DECK_PX_TOUCH,
  DECK_ROW_PX,
  isCompactViewport,
  STRIP_PX_TOUCH,
  TOP_PX,
  TOP_PX_TOUCH,
} from './constants.ts';
import type { SectorField } from './theme.ts';

/**
 * Draw layers, back to front. Keeping these as named containers means z-order is
 * structural rather than something we re-sort every frame.
 */
export interface Layers {
  map: Container;        // static board, drawn once
  towers: Container;
  creeps: Container;
  projectiles: Container;
  effects: Container;    // transient VFX
  overlay: Container;    // placement ghost, range circles, selection
}

export interface Renderer {
  app: Application;
  layers: Layers;
}

/**
 * Canvas size is dictated by the map, so it is passed in rather than assumed.
 *
 * `deckRows` is how many control rows the open deck lays out — one in the
 * campaign, two in versus, decided by `renderDeck` from the same rule flag. It
 * is reserved height rather than a render concern, which is why it has to
 * arrive here: the board and the deck letterbox as one stack.
 */
export async function createRenderer(
  mount: HTMLElement,
  width: number,
  height: number,
  field: SectorField,
  deckRows = 1,
): Promise<Renderer> {
  const app = new Application();

  // v8: init() is ASYNC. (v7's `new Application({...})` is gone — most tutorials
  // online are still v7 and will not work.)
  await app.init({
    width,
    height,
    background: field.bg,

    // Crisp on retina without changing our logical coordinate space.
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,

    antialias: true,

    // We drive rendering from our own fixed-timestep loop, so Pixi must not
    // start its own ticker. See src/app/loop.ts.
    autoStart: false,

    // WebGL rather than WebGPU: fewer driver edge cases, and nothing here needs
    // compute. Revisit only if profiling ever says to.
    preference: 'webgl',
  });

  // v8: `app.canvas`, not `app.view`.
  mount.appendChild(app.canvas);

  fitCanvas(app, deckRows);
  watchViewport(() => {
    fitCanvas(app, deckRows);
  });

  const layers: Layers = {
    map: new Container(),
    towers: new Container(),
    creeps: new Container(),
    projectiles: new Container(),
    effects: new Container(),
    overlay: new Container(),
  };

  app.stage.addChild(
    layers.map,
    layers.towers,
    layers.creeps,
    layers.projectiles,
    layers.effects,
    layers.overlay,
  );

  return { app, layers };
}

/**
 * Letterbox the board into whatever space the window gives us, by CSS size only.
 *
 * The drawing buffer and the stage coordinate system stay fixed at the map's
 * true pixel size, so nothing downstream — placement ghosts, range circles,
 * pointer→tile mapping in M4 — has to know a scale factor exists. Pixi's event
 * system derives pointer coords from the canvas bounding rect, so it follows the
 * CSS size for free.
 *
 * Clamped to 1: past that we'd be upscaling a fixed-resolution buffer and the
 * whole board would go soft.
 *
 * **Measure the viewport, never the mount.** `#game-root` is sized from
 * `--board-w`/`--board-h`, which this function writes at the bottom — so
 * measuring it means measuring this function's own last output. The first call
 * read the viewport, because the variables did not exist yet, and was correct;
 * every call after it read 1040x600 and pinned the scale at `600/796 = 0.754`
 * however much room the window actually had. The feedback loop could only ever
 * shrink the board, and nothing could grow it back.
 *
 * `body` is `overflow:hidden` and `#app` fills the viewport exactly, so the
 * document element is the honest box — and it is the one box on the page this
 * function cannot accidentally resize.
 */
/**
 * The last scale `fitCanvas` applied.
 *
 * The overlay's finger callout needs it: a fingertip is ~46 CSS px whatever the
 * device, which is 54 board px at 0.85 and 112 at 0.41, so the gap it has to
 * clear cannot be a constant in board space. Renderer-internal — nothing about
 * layout or CSS reads this.
 */
let lastScale = 1;
export const boardScale = (): number => lastScale;

type ChromeTier = 'desktop' | 'roomy' | 'compact';

/**
 * How much chrome to reserve, from the raw viewport ALONE.
 *
 * Not from `--board-scale`: the chrome height feeds the scale, so reading the
 * scale back here is the same feedback loop `fitCanvas` documents below, one
 * level up. And not from `ui.deckOpen` either — that would be loop-free, but it
 * would rescale the whole board every time the player pressed Tab, moving every
 * tile out from under a placement gesture already in flight.
 */
function chromeFor(
  touch: boolean,
  vw: number,
  vh: number,
  deckRows: number,
): { top: number; deck: number; tier: ChromeTier } {
  // Versus's second row, added to whichever tier's height would otherwise apply.
  const extra = (deckRows - 1) * DECK_ROW_PX;

  if (!touch) return { top: TOP_PX, deck: DECK_PX + extra, tier: 'desktop' };
  // A phone is best-effort, and there the board size wins over the button size,
  // because at that scale no amount of reserved chrome makes the buttons big
  // enough anyway — so reserve the collapsed strip and give the rest to board.
  // Compact reserves the *closed* strip and overlays when opened, so a second
  // row costs it nothing here; `.td-compact .deck .panel.rows` gives it the
  // height at the point it is actually shown.
  return isCompactViewport(touch, vw, vh)
    ? { top: TOP_PX, deck: STRIP_PX_TOUCH, tier: 'compact' }
    : { top: TOP_PX_TOUCH, deck: DECK_PX_TOUCH + extra, tier: 'roomy' };
}

/**
 * Every way the viewport can change, coalesced into one refit per frame.
 *
 * `resize` alone is not enough on iOS Safari: it does not fire when the toolbar
 * collapses on scroll, and on `orientationchange` it fires *before* the new
 * dimensions are readable — measuring there yields the pre-rotation box, which
 * leaves the board sized for the orientation you just left.
 *
 * - ResizeObserver on <html> is the honest primary: it fires whenever the
 *   initial containing block changes, whatever the cause. Safe to observe
 *   because nothing `fitCanvas` writes can alter documentElement's own box —
 *   body is overflow:hidden and #app is 100%/100dvh of it.
 * - visualViewport catches Safari's toolbar transitions, which do not always
 *   move the layout viewport in step.
 * - orientationchange, plus a deferred second pass, covers the stale read.
 */
function watchViewport(refit: () => void): void {
  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refit();
    });
  };

  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  new ResizeObserver(schedule).observe(document.documentElement);

  // The dimensions are not settled when this fires. Measuring now *and* after
  // the rotation animation is cheaper and more reliable than guessing which of
  // the two is the correct moment.
  window.addEventListener('orientationchange', () => {
    schedule();
    setTimeout(schedule, 300);
  });
}

/** Last (viewport, tier) actually fitted, so repeat triggers cost nothing. */
let lastFit = '';

function fitCanvas(app: Application, deckRows: number): void {
  const viewport = document.documentElement;
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  const touch = matchMedia('(pointer: coarse)').matches;
  const chrome = chromeFor(touch, vw, vh, deckRows);

  // ResizeObserver fires on every pixel of Safari's toolbar sliding away, so
  // this has to be cheap when nothing meaningful changed. It is also the
  // backstop that turns any accidental write-measure loop into a no-op rather
  // than a spin.
  const sig = `${vw}x${vh}|${chrome.tier}`;
  if (sig === lastFit) return;
  lastFit = sig;

  // The deck's height is reserved beneath the board, so the two letterbox as a
  // single stack. Fitting the board alone would put the deck back on top of the
  // final approach, which is the one stretch that must stay visible.
  const stackHeight = chrome.top + app.screen.height + chrome.deck;
  const scale = Math.min(1, vw / app.screen.width, vh / stackHeight);

  // The canvas keeps its logical CSS size; #stage applies the scale to board
  // and chrome together. Pixi derives pointer coordinates from the canvas
  // bounding rect, which reflects the transform, so tile picking is unaffected.
  app.canvas.style.width = `${app.screen.width}px`;
  app.canvas.style.height = `${app.screen.height}px`;

  // These classes only ever change layout *inside* #stage, which sits in a
  // 100%-sized #app inside an overflow:hidden body — so nothing they do can
  // resize documentElement and re-enter the ResizeObserver above.
  // IF A RULE UNDER .td-touch EVER TOUCHES html/body SIZING OR OVERFLOW, THAT
  // IS A REAL LOOP. The `sig` check is the only thing standing behind it.
  viewport.classList.toggle('td-touch', touch);
  viewport.classList.toggle('td-compact', chrome.tier === 'compact');
  // Set once a board exists, so the portrait wall in styles.css lands on the
  // game and never on the home screen, picker or lobby.
  viewport.classList.add('td-ingame');

  // The HUD is laid out at the board's *logical* size and then scaled as a
  // whole, rather than reflowing: the deck is a fixed composition designed
  // against 1040x600, and letting it reflow at narrow widths would clip the
  // send control rather than shrink it.
  const root = viewport.style;
  root.setProperty('--board-w', `${app.screen.width}px`);
  root.setProperty('--board-h', `${app.screen.height}px`);
  root.setProperty('--top-h', `${chrome.top}px`);
  root.setProperty('--deck-h', `${chrome.deck}px`);
  root.setProperty('--board-scale', String(scale));
  lastScale = scale;
}
