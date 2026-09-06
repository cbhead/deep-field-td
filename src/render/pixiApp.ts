import { Application, Container } from 'pixi.js';
import {
  DECK_PX,
  DECK_PX_TOUCH,
  DECK_ROW_PX,
  DOCK_BUILD_PX,
  DOCK_DETAIL_PX,
  DOCK_ERA_PX,
  DOCK_GAP,
  DOCK_MARGIN,
  DOCK_SORTIE_PX,
  isCompactViewport,
  STRIP_PX_TOUCH,
  TOP_PX,
  TOP_PX_TOUCH,
  TOP_PX_VERSUS,
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
 * `versus` decides the whole shape of the chrome, not just its height: the
 * campaign reserves strips above and below the board, versus docks four panels
 * around it. It is reserved space rather than a render concern, which is why it
 * has to arrive here — board and chrome letterbox as one stack, and the stack is
 * a different size in the two modes.
 */
export async function createRenderer(
  mount: HTMLElement,
  width: number,
  height: number,
  field: SectorField,
  versus = false,
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

  fitCanvas(app, versus);
  watchViewport(() => {
    fitCanvas(app, versus);
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

interface Chrome {
  readonly top: number;
  readonly deck: number;
  /** Board-space px reserved left and right of the canvas. Zero unless docked. */
  readonly left: number;
  readonly right: number;
  readonly tier: ChromeTier;
  /** Four docks around the board rather than one panel beneath it. */
  readonly docked: boolean;
}

/**
 * How much chrome to reserve, from the raw viewport ALONE.
 *
 * Not from `--board-scale`: the chrome height feeds the scale, so reading the
 * scale back here is the same feedback loop `fitCanvas` documents below, one
 * level up. And not from `ui.deckOpen` either — that would be loop-free, but it
 * would rescale the whole board every time the player pressed Tab, moving every
 * tile out from under a placement gesture already in flight.
 *
 * **Versus on a pointer device docks; everywhere else strips.** The four-dock
 * layout spends 973px of width it does not have on a phone — the detail column
 * alone is 468 — and the design says so itself: compact and touch are the one
 * part of it left open, with the build column and era square named as the
 * natural bottom sheet and the sortie deck explicitly undecided at phone height.
 * Until that is decided, a touch versus board keeps the two-row deck it already
 * had, which fits and works.
 */
function chromeFor(touch: boolean, vw: number, vh: number, versus: boolean): Chrome {
  const strip = { left: 0, right: 0, docked: false };
  // Versus's second row, added to whichever tier's height would otherwise apply.
  const extra = versus ? DECK_ROW_PX : 0;

  if (!touch) {
    if (!versus) return { ...strip, top: TOP_PX, deck: DECK_PX, tier: 'desktop' };
    return {
      top: TOP_PX_VERSUS,
      // Under the board: the gap, the sortie deck, and the margin below it.
      deck: DOCK_GAP + DOCK_SORTIE_PX + DOCK_MARGIN,
      left: DOCK_MARGIN + DOCK_BUILD_PX + DOCK_GAP,
      right: DOCK_GAP + DOCK_DETAIL_PX + DOCK_MARGIN,
      tier: 'desktop',
      docked: true,
    };
  }
  // A phone is best-effort, and there the board size wins over the button size,
  // because at that scale no amount of reserved chrome makes the buttons big
  // enough anyway — so reserve the collapsed strip and give the rest to board.
  // Compact reserves the *closed* strip and overlays when opened, so a second
  // row costs it nothing here; `.td-compact .deck .panel.rows` gives it the
  // height at the point it is actually shown.
  return isCompactViewport(touch, vw, vh)
    ? { ...strip, top: TOP_PX, deck: STRIP_PX_TOUCH, tier: 'compact' }
    : { ...strip, top: TOP_PX_TOUCH, deck: DECK_PX_TOUCH + extra, tier: 'roomy' };
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

function fitCanvas(app: Application, versus: boolean): void {
  const viewport = document.documentElement;
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  const touch = matchMedia('(pointer: coarse)').matches;
  const chrome = chromeFor(touch, vw, vh, versus);

  // ResizeObserver fires on every pixel of Safari's toolbar sliding away, so
  // this has to be cheap when nothing meaningful changed. It is also the
  // backstop that turns any accidental write-measure loop into a no-op rather
  // than a spin.
  const sig = `${vw}x${vh}|${chrome.tier}`;
  if (sig === lastFit) return;
  lastFit = sig;

  // Chrome is reserved around the board, so board and chrome letterbox as a
  // single stack. Fitting the board alone would put the deck back on top of the
  // final approach, which is the one stretch that must stay visible — and, once
  // there are side columns, would push those off screen entirely.
  //
  // Docked adds a gap under the top bar, because the side columns start at the
  // board's top edge and butting them against the bar would read as one surface.
  const head = chrome.docked ? DOCK_GAP : 0;
  const boardY = chrome.top + head;
  const stageWidth = chrome.left + app.screen.width + chrome.right;
  const stageHeight = boardY + app.screen.height + chrome.deck;
  const scale = Math.min(1, vw / stageWidth, vh / stageHeight);

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
  viewport.classList.toggle('td-docked', chrome.docked);
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
  // Where the canvas sits inside the stage, and how big the stage is. Both are
  // the board's own box everywhere except versus, so every existing rule that
  // assumed "stage == board" keeps holding without knowing these exist.
  root.setProperty('--board-x', `${chrome.left}px`);
  root.setProperty('--board-y', `${boardY}px`);
  root.setProperty('--stage-w', `${stageWidth}px`);
  root.setProperty('--stage-h', `${stageHeight}px`);
  // The dock sizes themselves, so the four panels are placed from the same
  // constants that reserved the room for them. A CSS rule holding its own copy
  // of 468 is a layout that can disagree with its own letterbox.
  root.setProperty('--dock-gap', `${DOCK_GAP}px`);
  root.setProperty('--dock-margin', `${DOCK_MARGIN}px`);
  root.setProperty('--dock-build', `${DOCK_BUILD_PX}px`);
  root.setProperty('--dock-detail', `${DOCK_DETAIL_PX}px`);
  root.setProperty('--dock-era', `${DOCK_ERA_PX}px`);
  root.setProperty('--board-scale', String(scale));
  lastScale = scale;
}
