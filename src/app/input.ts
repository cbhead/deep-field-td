import type { Application } from 'pixi.js';
import { SORTIES, SORTIE_IDS } from '../content/sorties.ts';
import { TOWERS, TOWER_IDS, type TowerId } from '../content/towers.ts';
import { TILE_PX } from '../render/constants.ts';
import { isUnlocked, towerAt } from '../sim/build.ts';
import type { World } from '../sim/world.ts';
import type { UiState } from './uiState.ts';
import {
  idleGesture,
  reduce,
  TAP_MS,
  type Effect,
  type Gesture,
  type Rect,
  type Tile,
} from './gesture.ts';

/**
 * Screen pixels → tile coordinate, or null if the pointer is off the board.
 *
 * Split from `pointerToTile` so a drag can measure the canvas once at the start
 * of the gesture instead of forcing a layout read on every pointermove — at up
 * to 120Hz on a phone whose frame budget is already thin, that is not free. The
 * board cannot move mid-gesture except on a rotate, which aborts the gesture.
 */
export function tileAtClient(
  rect: DOMRect,
  screen: { width: number; height: number },
  clientX: number,
  clientY: number,
  cols: number,
  rows: number,
): Tile | null {
  const x = ((clientX - rect.left) / rect.width) * screen.width;
  const y = ((clientY - rect.top) / rect.height) * screen.height;
  const col = Math.floor(x / TILE_PX);
  const row = Math.floor(y / TILE_PX);
  return col >= 0 && col < cols && row >= 0 && row < rows ? [col, row] : null;
}

/**
 * Screen pixels → tile coordinate, or null if the pointer is off the board.
 *
 * Goes through the canvas bounding rect rather than assuming a 1:1 mapping,
 * because `fitCanvas` letterboxes the board by CSS size — the element is
 * routinely smaller than the stage it draws.
 */
export function pointerToTile(
  app: Application,
  ev: PointerEvent,
  cols: number,
  rows: number,
): Tile | null {
  return tileAtClient(
    app.canvas.getBoundingClientRect(),
    app.screen,
    ev.clientX,
    ev.clientY,
    cols,
    rows,
  );
}

/** What `attachInput` hands back so the frame loop can keep UiState honest. */
export interface InputHandle {
  /**
   * Drop a parked touch preview when the player disarms by any other route —
   * Escape, a hotkey, the deck's own button. Called once a frame before the
   * overlay syncs, which is cheaper and far more robust than hooking all four
   * places `ui.selected` is written.
   */
  reconcile(): void;
  /** Press-to-commit threshold, in ms. Live-tunable from the dev handle. */
  tapMs: number;
}

/**
 * Input never mutates the world. It translates a gesture into a Command and
 * queues it; the sim applies it at the top of the next tick. Hover, by
 * contrast, is pure presentation and goes straight into UiState.
 *
 * Mouse and touch are dispatched per *event*, on `pointerType`, never on a
 * capability flag read at boot. `matchMedia('(pointer: coarse)')` is true for
 * an iPad with a trackpad attached and false for a touchscreen laptop — wrong
 * in both directions on exactly the hardware this has to work on. The mouse
 * path below is the original handler bodies, unchanged, behind an early
 * return: desktop behaviour is meant to be verifiable by reading the diff.
 */
export function attachInput(
  app: Application,
  world: World,
  ui: UiState,
  togglePause: () => void,
  hudRoot: HTMLElement,
): InputHandle {
  const { cols, rows } = world.map;
  const canvas = app.canvas;

  let gesture: Gesture = idleGesture();
  /** Canvas rect, cached for the duration of one gesture. */
  let rect: DOMRect | null = null;

  const tileAt = (ev: PointerEvent): Tile | null => {
    const r = rect ?? canvas.getBoundingClientRect();
    return tileAtClient(r, app.screen, ev.clientX, ev.clientY, cols, rows);
  };

  // ── The mouse path: exactly what it always was ────────────────────────────

  const mouseMove = (ev: PointerEvent): void => {
    ui.hover = pointerToTile(app, ev, cols, rows);
    // A mouse arriving reclaims the preview from any parked finger. Last device
    // wins, so a hybrid iPad needs no mode switch anywhere.
    if (gesture.pinned !== null) gesture = { ...gesture, pinned: null };
    ui.touchPreview = false;
  };

  const mouseDown = (ev: PointerEvent): void => {
    const tile = pointerToTile(app, ev, cols, rows);
    if (tile === null) return;
    ui.hover = tile;

    // Nothing armed: a click is an inspect gesture. Clicking empty ground
    // dismisses the inspector, which is the expected way out of it.
    if (ui.selected === null) {
      const hit = towerAt(world, tile[0], tile[1]);
      ui.inspecting = hit?.id ?? null;
      return;
    }
    world.commands.push({ type: 'placeTower', defId: ui.selected, col: tile[0], row: tile[1] });
  };

  // ── The touch path ────────────────────────────────────────────────────────

  /**
   * Eat the click the browser synthesises after a touch.
   *
   * Without this, dragging out of a deck slot, back over it, and releasing
   * fires `click` on the slot — and `act('arm')` is a toggle, so it disarms the
   * station the drag just armed. The 350ms sweep is because the synthesised
   * click may never arrive at all (it is engine- and gesture-dependent), and a
   * listener left armed would eat the player's next real click.
   */
  const swallowNextClick = (): void => {
    const eat = (e: Event): void => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => {
      window.removeEventListener('click', eat, { capture: true });
    }, 350);
  };

  const perform = (effects: readonly Effect[]): void => {
    for (const fx of effects) {
      switch (fx.k) {
        case 'hover':
          ui.hover = fx.tile;
          break;
        case 'preview':
          ui.touchPreview = fx.on;
          break;
        case 'arm':
          ui.selected = fx.towerId;
          ui.inspecting = null;
          break;
        case 'place':
          // Deliberately unguarded by any legality check. `applyCommands` is
          // the one authority on whether a placement lands, exactly as it is
          // for a desktop click — a second opinion here is a second thing that
          // can disagree with the ghost.
          if (ui.selected !== null) {
            world.commands.push({
              type: 'placeTower',
              defId: ui.selected,
              col: fx.tile[0],
              row: fx.tile[1],
            });
          }
          break;
        case 'inspect': {
          const hit = towerAt(world, fx.tile[0], fx.tile[1]);
          ui.inspecting = hit?.id ?? null;
          break;
        }
        case 'swallowClick':
          swallowNextClick();
          break;
      }
    }
  };

  let tapMs = TAP_MS;

  const send = (ev: Parameters<typeof reduce>[1]): void => {
    const { next, effects } = reduce(gesture, ev, tapMs);
    gesture = next;
    perform(effects);
    if (gesture.state.k === 'idle') rect = null;
  };

  const beginTouch = (ev: PointerEvent, target: Element): void => {
    rect = canvas.getBoundingClientRect();
    // Pen gets no implicit capture, and an explicit one also keeps a drag alive
    // when it wanders off the element it started on.
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      // Safari throws if the pointer is already gone. Window listeners still
      // deliver, so this is genuinely nothing to handle.
    }
  };

  canvas.addEventListener('pointermove', (raw) => {
    const ev = raw as PointerEvent;
    if (ev.pointerType === 'mouse') mouseMove(ev);
    // Touch moves during a gesture arrive on the window listener below, which
    // keeps delivering once the finger leaves the canvas. A touch pointermove
    // with no gesture in flight is a stylus hovering: nothing to do.
  });

  canvas.addEventListener('pointerleave', (raw) => {
    // Touch fires pointerleave on lift. Honouring it there would wipe the very
    // preview a quick tap just parked, one frame after parking it.
    if ((raw as PointerEvent).pointerType !== 'mouse') return;
    ui.hover = null;
  });

  canvas.addEventListener('pointerdown', (raw) => {
    const ev = raw as PointerEvent;
    if (ev.pointerType === 'mouse') {
      mouseDown(ev);
      return;
    }
    beginTouch(ev, canvas);
    send({
      k: 'boardDown',
      id: ev.pointerId,
      tile: tileAt(ev),
      armed: ui.selected,
      at: ev.timeStamp,
    });
  });

  // Pressing a build slot and dragging onto the board arms and aims in one
  // gesture. Bound on the HUD root rather than per-slot because the deck is
  // re-rendered constantly and per-slot listeners would not survive it.
  hudRoot.addEventListener('pointerdown', (raw) => {
    const ev = raw as PointerEvent;
    if (ev.pointerType === 'mouse') return;
    const slot = (ev.target as HTMLElement).closest<HTMLElement>('[data-act="arm"]');
    const id = slot?.dataset['id'] as TowerId | undefined;
    // Locked slots render without a data-act, so they are undraggable for free.
    if (slot === null || slot === undefined || id === undefined) return;
    if (!isUnlocked(world, id)) return;

    rect = canvas.getBoundingClientRect();
    beginTouch(ev, slot);
    const r = slot.getBoundingClientRect();
    send({
      k: 'deckDown',
      id: ev.pointerId,
      towerId: id,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } satisfies Rect,
    });
  });

  // On window, so a drag that leaves the canvas — or the slot it started on —
  // keeps being delivered. Filtered by pointerId inside the reducer.
  window.addEventListener('pointermove', (raw) => {
    const ev = raw as PointerEvent;
    if (ev.pointerType === 'mouse' || gesture.state.k === 'idle') return;
    send({ k: 'move', id: ev.pointerId, tile: tileAt(ev), x: ev.clientX, y: ev.clientY });
  });

  window.addEventListener('pointerup', (raw) => {
    const ev = raw as PointerEvent;
    if (ev.pointerType === 'mouse' || gesture.state.k === 'idle') return;
    send({ k: 'up', id: ev.pointerId, tile: tileAt(ev), at: ev.timeStamp });
  });

  window.addEventListener('pointercancel', (raw) => {
    const ev = raw as PointerEvent;
    if (gesture.state.k === 'idle') return;
    send({ k: 'cancel', id: ev.pointerId });
  });

  // A tab hidden mid-drag must not be able to resolve into a purchase. This
  // matters most in Race, where "I was charged for a station I never placed" is
  // a fairness complaint rather than a papercut.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && gesture.state.k !== 'idle') {
      send({ k: 'cancel', id: gesture.state.id });
    }
  });

  // The cached rect is stale the moment the board is re-letterboxed.
  window.addEventListener('resize', () => {
    if (gesture.state.k !== 'idle') send({ k: 'cancel', id: gesture.state.id });
  });

  // Right-click to disarm is the genre convention, and cheaper than moving the
  // pointer back to the build bar to click the same button again.
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    // iOS raises contextmenu from a long press at ~500ms, which is squarely
    // inside a deliberate press-and-hold — disarming there would cancel the
    // placement the player is in the middle of aiming.
    if (gesture.state.k !== 'idle') return;
    ui.selected = null;
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      // Escape unwinds one layer at a time: disarm, then close the inspector,
      // then pause. Jumping straight to the pause menu from an armed state
      // would make cancelling a placement feel like it opened a modal.
      if (ui.selected !== null) ui.selected = null;
      else if (ui.inspecting !== null) ui.inspecting = null;
      else togglePause();
      return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      ui.deckOpen = !ui.deckOpen;
      return;
    }
    if (ev.code === 'Space') {
      ev.preventDefault();
      world.commands.push({ type: 'startWave' });
      return;
    }

    const hit = TOWER_IDS.find((id) => TOWERS[id].hotkey === ev.key);
    if (hit !== undefined && isUnlocked(world, hit)) {
      ui.selected = ui.selected === hit ? null : hit;
      // Arming and inspecting are mutually exclusive: both want the detail
      // column, and both draw a reach circle.
      if (ui.selected !== null) ui.inspecting = null;
      return;
    }

    // The sortie row, Q–Y, directly above the build row's 1–6.
    //
    // Lower-cased because the key is a letter: `ev.key` is 'Q' with shift or
    // caps lock held, and a hotkey that stopped working because caps lock was
    // on would be indistinguishable from one that was never wired.
    //
    // Unlike arming, this SPENDS — so it goes through the same `sortie`
    // command the deck button pushes rather than setting UI state, and the sim
    // does the affordability and era checks in `sortieError`. A key that
    // bypassed those would be a second, laxer way to buy.
    const send = SORTIE_IDS.find((id) => SORTIES[id].hotkey === ev.key.toLowerCase());
    if (send !== undefined && world.rules.sorties) {
      world.commands.push({ type: 'sortie', sortie: send, lane: ui.sortieLane });
    }
  });

  return {
    get tapMs(): number {
      return tapMs;
    },
    set tapMs(v: number) {
      tapMs = v;
    },
    reconcile(): void {
      if (ui.selected !== null) return;
      // Disarmed by some other route, so the parked preview no longer has a
      // station to describe. Re-arming a *different* station deliberately keeps
      // the pin: aiming at the same tile with a new choice is coherent, and the
      // ghost simply re-tints.
      if (gesture.pinned !== null) gesture = { ...gesture, pinned: null };
      if (ui.touchPreview) ui.touchPreview = false;
    },
  };
}
