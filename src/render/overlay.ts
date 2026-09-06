import { Graphics, Sprite, Text } from 'pixi.js';
import { TOWERS, TOWER_IDS, type TowerId } from '../content/towers.ts';
import { placementError } from '../sim/build.ts';
import type { EntityId, PlacementError, Tower } from '../sim/types.ts';
import { towerById, type World } from '../sim/world.ts';
import { TILE_PX } from './constants.ts';
import { BAKE_NEUTRAL, THEME } from './theme.ts';
import { boardScale, type Layers } from './pixiApp.ts';
import type { Textures } from './textures.ts';

/**
 * The placement ghost and range circle.
 *
 * The plan calls this the highest-value UI work in the game, and it is: it is
 * the difference between placement feeling responsive and feeling broken. You
 * must be able to see, before committing, both *whether* a tile is legal and
 * *what the tower would cover*.
 *
 * It asks `placementError` — the same function `applyCommands` uses — so what
 * is shown and what will be accepted cannot drift apart.
 */
/**
 * What the ghost says at the cursor when a tile is refused.
 *
 * Naming the reason is the difference between feedback and a shrug: "you can't"
 * makes the player hunt for the rule, "on the route" tells them the rule. Keyed
 * off the same PlacementError the command path enforces, so a message can never
 * describe a verdict the sim won't reach.
 */
const REJECTION: Record<Exclude<PlacementError, 'offBoard'>, string> = {
  onRoute: 'On the route',
  blocked: 'Nebula · no build',
  occupied: 'Occupied',
  tooPoor: 'Not enough cash',
  locked: 'Locked',
};

/**
 * How much room to leave between the pressed tile and the callout plate, in CSS
 * pixels — roughly the pad of a finger. Converted into board space against the
 * live board scale, because that is the only place the two disagree.
 */
const FINGER_CLEARANCE_CSS = 46;

export class Overlay {
  private readonly ghost: Sprite;
  private readonly gfx = new Graphics();
  private readonly label: Text;

  /** The magnified repeat of the ghost and verdict, shown above a finger. */
  private readonly calloutGfx = new Graphics();
  private readonly calloutGhost: Sprite;
  private readonly calloutText: Text;

  /** Last drawn state, so a stationary pointer costs nothing. */
  private lastKey = '';

  constructor(
    layers: Layers,
    private readonly textures: Textures,
  ) {
    // Any station's Mk I will do as the initial texture — the ghost is hidden
    // until something is armed, and `sync` re-textures it before it is shown.
    this.ghost = new Sprite(textures.towers[TOWER_IDS[0]!]![0]!);
    this.ghost.visible = false;
    this.ghost.alpha = 0.55;

    // `fill` is load-bearing: Pixi defaults text to black and this label is
    // recoloured with `.tint`, which multiplies — so without a neutral fill the
    // label was black on a near-black board no matter what tint was set.
    this.label = new Text({
      text: '',
      style: {
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 12,
        fontWeight: '700',
        fill: BAKE_NEUTRAL,
        stroke: { color: THEME.fx.textOutline, width: 3, join: 'round' },
      },
    });
    this.label.visible = false;

    this.calloutGhost = new Sprite(textures.towers[TOWER_IDS[0]!]![0]!);
    this.calloutGhost.visible = false;
    this.calloutGhost.anchor.set(0.5);
    this.calloutGhost.scale.set(1.6);
    this.calloutText = new Text({
      text: '',
      style: {
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 22,
        fontWeight: '700',
        fill: BAKE_NEUTRAL,
        stroke: { color: THEME.fx.textOutline, width: 4, join: 'round' },
      },
    });
    this.calloutText.visible = false;
    this.calloutText.anchor.set(0.5);

    layers.overlay.addChild(
      this.gfx,
      this.ghost,
      this.label,
      this.calloutGfx,
      this.calloutGhost,
      this.calloutText,
    );
  }

  /**
   * The reach of a station, drawn as either a circle or the board edge.
   *
   * **A rangeless station cannot be drawn as a circle of radius 0.** That is a
   * degenerate shape that renders as nothing, and "nothing" is what a broken
   * control looks like — every other station answers "how far" with a ring, so
   * the one that answers "all of it" has to say so rather than stay silent.
   * Outlining the play area is the same sentence in the same visual language.
   */
  private drawReachOf(
    w: World,
    defId: TowerId,
    cx: number,
    cy: number,
    radius: number,
    color: number,
    fillAlpha: number,
    strokeAlpha: number,
  ): void {
    if (TOWERS[defId].boardWide) {
      this.gfx
        .rect(0, 0, w.map.cols * TILE_PX, w.map.rows * TILE_PX)
        .fill({ color, alpha: fillAlpha })
        .stroke({ width: THEME.shape.strokeWidth, color, alpha: strokeAlpha });
      return;
    }
    this.gfx
      .circle(cx, cy, radius)
      .fill({ color, alpha: fillAlpha })
      .stroke({ width: THEME.shape.strokeWidth, color, alpha: strokeAlpha });
  }

  /**
   * @param callout Show the magnified plate above the tile. Defaults off, so
   *   the mouse path through here is byte-identical to what it always was.
   */
  sync(
    w: World,
    selected: TowerId | null,
    hover: readonly [number, number] | null,
    inspecting: EntityId | null = null,
    callout = false,
  ): void {
    const reason =
      selected === null || hover === null
        ? 'offBoard'
        : placementError(w, selected, hover[0], hover[1]);

    // Re-tessellating the range circle every frame is wasteful when nothing
    // visible has changed, and a stationary pointer is the common case. Keyed
    // on the placement *verdict* rather than on money: once kills pay bounty
    // every few ticks, a money-keyed cache would never hit.
    const inspected = inspecting === null ? undefined : towerById(w, inspecting);
    // The callout's geometry depends on the board scale, so a resize has to be
    // able to invalidate this cache. Bucketed, because the scale is a float and
    // a raw value would miss the cache on every rounding wobble.
    const scaleBucket = Math.round(boardScale() * 20);
    const key =
      `${selected}:${hover === null ? '' : `${hover[0]},${hover[1]}`}:${reason}` +
      // Range is in the key so buying the range path redraws the circle live.
      `:${inspected ? `${inspected.id}.${inspected.stats.range}` : ''}` +
      // Feed links depend on what else is standing, so building or selling
      // anything has to invalidate them. `buffShots` alone is not enough: a
      // second station arriving inside an Overclock's reach adds a line without
      // changing any number already in this key.
      `:${inspected ? `${inspected.buffShots}.${w.towers.length}` : ''}` +
      `:${callout ? scaleBucket : ''}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Each station bakes its own silhouette now, so the ghost has to follow the
    // armed one — otherwise every placement preview would show the first
    // station's mark whatever you were actually holding. `selected` is already
    // in the key, so this costs one texture assignment per arming.
    if (selected !== null) this.ghost.texture = this.textures.towers[selected]![0]!;

    this.gfx.clear();

    // The inspected station shows its reach whether or not anything is armed —
    // that is the whole reason for clicking it.
    if (inspected !== undefined) {
      const ix = inspected.x * TILE_PX;
      const iy = inspected.y * TILE_PX;
      this.drawReachOf(
        w,
        inspected.defId,
        ix,
        iy,
        inspected.stats.range * TILE_PX,
        THEME.feedback.selected,
        THEME.feedback.rangeFillAlpha,
        THEME.feedback.rangeStrokeAlpha,
      );
      this.gfx
        .rect(inspected.col * TILE_PX, inspected.row * TILE_PX, TILE_PX, TILE_PX)
        .stroke({ width: 2, color: THEME.feedback.selected, alpha: 0.95 });

      this.drawFeedLinks(w, inspected);
    }

    if (selected === null || hover === null) {
      this.ghost.visible = false;
      this.label.visible = false;
      this.hideCallout();
      return;
    }

    const [col, row] = hover;
    if (reason === 'offBoard') {
      this.ghost.visible = false;
      this.label.visible = false;
      this.hideCallout();
      return;
    }

    const ok = reason === null;

    // The verdict, in words. A legal tile shows the price rather than a bare
    // "yes" — the number is the part worth confirming when cash is tight.
    // Computed once and read by both the inline label and the callout, so the
    // two can never describe the same tile differently.
    const verdict = ok ? `Deploy · −$${TOWERS[selected].cost}` : REJECTION[reason];
    const verdictTint = ok ? THEME.towers[selected] : THEME.feedback.invalid;

    // Under a finger the inline label is not merely occluded, it is illegible:
    // 12px of board space at phone scale is about 5 CSS px. The callout
    // replaces it rather than joining it.
    this.label.visible = !callout;
    this.label.text = verdict;
    this.label.tint = verdictTint;

    // Sit to the right of the tile normally, but flip to the left rather than
    // run off the board. Hovering the last few columns used to push the label
    // past the canvas edge, where it was clipped away entirely — so the tiles
    // whose verdict is least obvious were the ones that explained themselves
    // least. `width` is only valid once `text` is set, hence the ordering.
    const boardW = w.map.cols * TILE_PX;
    const right = (col + 1) * TILE_PX + 8;
    const flip = right + this.label.width > boardW;
    this.label.x = flip ? Math.max(2, col * TILE_PX - 8 - this.label.width) : right;
    this.label.y = Math.min(row * TILE_PX + 8, w.map.rows * TILE_PX - this.label.height - 2);
    // A legal ghost wears the tower's own colour, which answers "which tower"
    // as well as "yes"; only rejection needs a dedicated red.
    const tint = verdictTint;
    const cx = (col + 0.5) * TILE_PX;
    const cy = (row + 0.5) * TILE_PX;

    if (callout) this.drawCallout(w, selected, col, row, verdict, tint);
    else this.hideCallout();

    this.ghost.visible = true;
    this.ghost.tint = tint;
    this.ghost.position.set(col * TILE_PX, row * TILE_PX);

    // Range first, so the ghost sits on top of it.
    const { rangeFillAlpha, rangeStrokeAlpha, tileOutlineAlpha } = THEME.feedback;
    this.drawReachOf(
      w,
      selected,
      cx,
      cy,
      TOWERS[selected].range * TILE_PX,
      tint,
      rangeFillAlpha,
      rangeStrokeAlpha,
    );

    // A tile outline reads as "this exact square", which the soft range circle
    // alone does not communicate.
    this.gfx
      .rect(col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX)
      .stroke({ width: THEME.shape.strokeWidth, color: tint, alpha: tileOutlineAlpha });
  }

  /**
   * Lines between a support station and the stations it feeds.
   *
   * **Support is the only station whose effect is invisible on the board.** A
   * Lance's pierce, a Nova's blast and a Singularity's slow all happen where you
   * can see them; an Overclock changes a number on a station somewhere else and
   * shows nothing at all. The inspector's `2.0→2.4/s` says *that* a station is
   * being fed — this says *by which one*, which is the half the panel cannot.
   *
   * Drawn both ways round, because the player arrives at the question from both
   * ends: inspect the Overclock and see its clients, or inspect a station firing
   * faster than its own stat block and see the cause.
   *
   * Only the sources that actually matter are drawn. Buffs stack by *maximum*
   * (see `refreshBuffs`), so a second Overclock in reach contributes nothing,
   * and drawing a line from it would claim a contribution the sim does not
   * give it.
   */
  private drawFeedLinks(w: World, inspected: Tower): void {
    const partners: Tower[] = [];
    let tint = THEME.feedback.selected;

    if (inspected.stats.buffShotsPerSecond > 0) {
      // A support station: everything inside its reach that actually fires.
      const r2 = inspected.stats.range * inspected.stats.range;
      tint = THEME.towers[inspected.defId];
      for (const t of w.towers) {
        if (t === inspected || t.stats.fireInterval <= 0) continue;
        const dx = t.x - inspected.x;
        const dy = t.y - inspected.y;
        if (dx * dx + dy * dy <= r2) partners.push(t);
      }
    } else if (inspected.buffShots > 0) {
      // A fed station: whichever source is the one supplying its buff.
      for (const src of w.towers) {
        if (src === inspected) continue;
        if (src.stats.buffShotsPerSecond !== inspected.buffShots) continue;
        const dx = src.x - inspected.x;
        const dy = src.y - inspected.y;
        if (dx * dx + dy * dy <= src.stats.range * src.stats.range) {
          partners.push(src);
          tint = THEME.towers[src.defId];
        }
      }
    }

    for (const p of partners) {
      this.gfx
        .moveTo(inspected.x * TILE_PX, inspected.y * TILE_PX)
        .lineTo(p.x * TILE_PX, p.y * TILE_PX)
        .stroke({ width: THEME.shape.strokeWidth, color: tint, alpha: 0.55 });
      // A dot at the far end, so a line running under a station reads as
      // terminating there rather than passing through it.
      this.gfx.circle(p.x * TILE_PX, p.y * TILE_PX, 3).fill({ color: tint, alpha: 0.9 });
    }
  }

  private hideCallout(): void {
    this.calloutGfx.clear();
    this.calloutGhost.visible = false;
    this.calloutText.visible = false;
  }

  /**
   * Repeat the ghost and the verdict clear of the finger.
   *
   * The target stays 1:1 under the contact point — deliberately. An offset
   * target has to flip near the top edge or row 0 becomes unreachable, and a
   * flipping offset is unlearnable: the same finger position would mean two
   * different tiles with nothing on screen to say which regime you were in. So
   * the tile is where you put it, and what the finger hides is reprinted above
   * instead.
   *
   * Anchored to the tile rather than the raw contact point, so the plate does
   * not jitter as the finger rolls, and so it shares the caller's cache key.
   */
  private drawCallout(
    w: World,
    selected: TowerId,
    col: number,
    row: number,
    verdict: string,
    tint: number,
  ): void {
    this.calloutGhost.texture = this.textures.towers[selected]![0]!;
    this.calloutText.text = verdict;

    const padX = 14;
    const padY = 10;
    const iconW = TILE_PX * 1.6;
    const plateW = iconW + this.calloutText.width + padX * 3;
    const plateH = Math.max(iconW, this.calloutText.height) + padY * 2;

    // A fingertip is ~46 CSS px on every device, which is a wildly different
    // number of board pixels depending on how hard the board is letterboxed.
    // Clamped low, because dividing by a very small scale would push the plate
    // right off the board.
    const gap = FINGER_CLEARANCE_CSS / Math.max(0.4, Math.min(1, boardScale()));

    const boardW = w.map.cols * TILE_PX;
    const boardH = w.map.rows * TILE_PX;
    const cx = (col + 0.5) * TILE_PX;

    // Above the tile by default; below it when there is no room, which is the
    // top row or two rather than a routine case.
    let top = row * TILE_PX - gap - plateH;
    if (top < 2) top = Math.min((row + 1) * TILE_PX + gap, boardH - plateH - 2);

    const left = Math.max(2, Math.min(cx - plateW / 2, boardW - plateW - 2));

    this.calloutGfx
      .clear()
      .roundRect(left, top, plateW, plateH, 10)
      .fill({ color: THEME.fx.textOutline, alpha: 0.92 })
      .stroke({ width: 2, color: tint, alpha: 0.85 });

    this.calloutGhost.visible = true;
    this.calloutGhost.tint = tint;
    this.calloutGhost.position.set(left + padX + iconW / 2, top + plateH / 2);

    this.calloutText.visible = true;
    this.calloutText.tint = tint;
    this.calloutText.position.set(
      left + padX * 2 + iconW + this.calloutText.width / 2,
      top + plateH / 2,
    );
  }
}
