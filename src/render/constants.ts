/**
 * Pixel-space constants. These live in the renderer on purpose — the simulation
 * works entirely in tile units (floats), so `speed: 1.8` reads as "1.8 tiles per
 * second" and changing the tile size never touches gameplay code.
 */
export const TILE_PX = 40;

/** Board dimensions come from the parsed map, not from here. */
export const tilesToPx = (tiles: number): number => tiles * TILE_PX;

/**
 * Height the open deck reserves beneath the board, in board-space px.
 *
 * The deck used to overlay the board and hid the goal plus seven of the route's
 * forty-three tiles — including the final approach, which is exactly where
 * leaks happen. Reserving the space instead costs board size but means the
 * player can always see what they are defending.
 *
 * Lives here rather than only in CSS because `fitCanvas` has to letterbox the
 * board and the deck as one unit; the stylesheet reads it back as `--deck-h`.
 */
export const DECK_PX = 150;

/**
 * Height the top bar reserves above the board, in board-space px.
 *
 * Same reasoning as `DECK_PX`, arrived at later. The bar overlaid the top two
 * rows and — worse than hiding them — it takes pointer events, so tiles up
 * there could be looked at but not built on. A control strip that silently
 * eats part of the play area is the same bug whichever edge it sits on.
 */
export const TOP_PX = 46;

/**
 * The touch target floor, in board-space px.
 *
 * The stage is scaled as one unit, so a control's *real* size is this times
 * `--board-scale`. 56 is the smallest value that clears the conventional 44 CSS
 * px at both iPad orientations — 56 x 0.789 = 44.2 in portrait, where the fit
 * is width-bound, and 56 x 0.850 = 47.6 in landscape under the chrome below.
 * Anything larger buys nothing and costs board.
 */
export const TAP_PX = 56;

/**
 * Chrome heights on a touch device, where every control has to grow.
 *
 * Growing the chrome shrinks the board: the stack is what gets letterboxed, so
 * 66 + 212 rather than 46 + 150 takes an iPad landscape from 0.937 to 0.850,
 * and a tile from 37.5 to 34 CSS px. That trade is worth making once — a tile
 * is aimed at with a preview and a confirm step, whereas a 24px pause button is
 * simply missed. iPad portrait is width-bound and pays nothing for this at all.
 */
export const TOP_PX_TOUCH = 66;
export const DECK_PX_TOUCH = 212;

/**
 * What a short viewport reserves for the deck: the collapsed strip only.
 *
 * On a landscape phone the fit is height-bound, so reserved chrome is the one
 * lever that changes the board size at all. Dropping the deck's reservation
 * from 150 to 48 takes an iPhone 15 Pro from 0.416 to 0.477 — a third more
 * board area. See the `.td-compact` rules in styles.css for what the open deck
 * does instead.
 */
export const STRIP_PX_TOUCH = 48;

/**
 * What a second deck row costs, in board-space px.
 *
 * Versus renders two sections the campaign never does — the sortie deck and its
 * own Send button — and the deck is a fixed composition laid out against 1040px
 * (see `fitCanvas`), so the five sections together overran the row by about
 * 500px. Flex spent the overrun on the two items that could give: the inspector
 * collapsed to 68px, narrower than one of its three upgrade buttons, and the
 * Send control was pushed clear off the panel's right edge. `renderDeck` wraps
 * into two rows there instead, and this is what the second row is paid for
 * with — one control row plus the gap above it.
 *
 * Additive rather than a second pair of constants so both chrome tiers derive
 * from the heights they already had; a taller deck shrinks the board on a
 * height-bound window, which is the same trade `DECK_PX_TOUCH` documents.
 */
export const DECK_ROW_PX = 124;

/**
 * Below this on either axis, a touch device is a phone rather than a tablet.
 *
 * The width bound is an iPad mini in portrait (744) staying on the roomy side;
 * the height bound is what the roomy chrome needs to keep the scale above
 * 44/56 = 0.786, which is what makes the touch targets clear 44 CSS px.
 *
 * Exported as one predicate because two callers depend on it — the chrome tier
 * in `fitCanvas` and the deck's initial state in `uiState` — and a disagreement
 * between them would open the deck into a layout sized for it being shut.
 */
export const COMPACT_MIN_W = 700;
export const COMPACT_MIN_H = 620;
export const isCompactViewport = (touch: boolean, vw: number, vh: number): boolean =>
  touch && (vw < COMPACT_MIN_W || vh < COMPACT_MIN_H);

/** Colours live in `theme.ts`, so that a reskin is one file rather than five. */

/**
 * How far the grid survives toward the board's edges.
 *
 * A uniform grid from corner to corner reads as graph paper: every tile looks
 * equally important, including the ones no route passes through. Fading it
 * outward gives the board a centre of gravity without deleting the one thing
 * the grid is *for*, which is making placement legible.
 *
 * `rx`/`ry` scale the **full** board dimensions, matching how a CSS radial
 * gradient's extent is written; `inner` is the normalised radius the fade
 * starts at and `outer` where it reaches zero.
 *
 * **The design's own numbers were a near-no-op and are deliberately not used.**
 * `radial-gradient(125% 120% …, #000 40%, transparent 92%)` works out, on a
 * 26x15 board, to a mask of 1.0 along the mid-edges and 0.659 in the corners —
 * a fade nobody would see. These land at ~0.82 mid-edge and ~0.42 corner, which
 * is a recession you can actually read. The spec says the checklist wins where
 * it and a mock disagree; this is that rule being used.
 */
export const GRID_MASK = { rx: 0.9, ry: 0.95, inner: 0.42, outer: 1.02 } as const;

/**
 * The floor the mask may never go below **on a tile a player can build on**.
 *
 * "The grid may fade at the far edges; it may not fade anywhere a player
 * builds" is the constraint, and a comment is not a constraint. All three maps
 * have buildable corners, so this is asserted in `tools/check.ts` across every
 * buildable tile of every map — which means a fourth map with a different
 * aspect ratio fails at check time rather than shipping a corner nobody can
 * aim at.
 */
export const GRID_MASK_FLOOR = 0.34;

/**
 * Grid strength at a point, 1 at the centre falling to 0 past `outer`.
 *
 * Pure and pixi-free so the gate can call it headlessly — the invariant above
 * is only worth stating if something checks it.
 */
export function gridMaskAt(x: number, y: number, boardW: number, boardH: number): number {
  const nx = (x - boardW / 2) / (GRID_MASK.rx * boardW);
  const ny = (y - boardH / 2) / (GRID_MASK.ry * boardH);
  const rho = Math.sqrt(nx * nx + ny * ny);

  if (rho <= GRID_MASK.inner) return 1;
  if (rho >= GRID_MASK.outer) return 0;
  return 1 - (rho - GRID_MASK.inner) / (GRID_MASK.outer - GRID_MASK.inner);
}

/**
 * Where each upgrade path sits on the collar drawn around an upgraded station.
 *
 * **Position is the encoding, not colour.** Three paths need three channels and
 * the palette has none to spare — every hue is already claimed by a station
 * (Arc green, Filament violet) or a status (shield blue, slow cyan), so a colour
 * code here would collide with something the player has already learned. Fixed
 * sectors never clash, and the collar is drawn in the station's own tint so it
 * reads as part of that station rather than as a fourth thing on the board.
 *
 * Clockwise from twelve in `UPGRADE_PATHS` order — damage, range, effect —
 * which is also left-to-right order in the inspector's path buttons.
 *
 * Lives here rather than in either consumer because BOTH have to agree: the
 * board draws these as Pixi arcs and the inspector's dial draws them as SVG
 * paths, and the dial is the only place the positional code is ever taught. If
 * the two drifted, the legend would quietly start lying about the board. This
 * file is pixi-free, so the DOM side can import it without pulling in a renderer.
 */
export const COLLAR_SECTORS = [
  { path: 'damage', from: -137 },
  { path: 'range', from: -17 },
  { path: 'effect', from: 103 },
] as const;

/** Degrees each sector spans. 94 of every 120, so the three read as separate. */
export const COLLAR_SPAN = 94;
