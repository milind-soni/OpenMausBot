/** Pure geometry for the Spaces canvas.
 *
 * Two arrangements, both expressed as explicit cell boxes:
 *
 *   tile(n)  one row of cards, each 1/n of the width. This is real split
 *            screen: the cards get NARROWER, so their text stays full size.
 *            Always drawn at scale 1.
 *   grid     the same full-size cards wrapped into rows and shrunk to fit,
 *            the way Mission Control shrinks real windows.
 *
 * Within one arrangement, moving between cards is a single transform on the
 * stage, so sliding and panning cost the same whatever the card count. Only
 * changing arrangement reflows the cells, and that is a deliberate, occasional
 * action rather than something that happens while you navigate.
 *
 * Nothing here touches the DOM, which is what lets the suite cover it under
 * `environment: "node"`.
 */

export interface Viewport {
  width: number;
  height: number;
}

export interface CellBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TileCount = 1 | 2 | 3;
export const TILE_COUNTS: readonly TileCount[] = [1, 2, 3];

export type CanvasView = { kind: "tile"; per: TileCount } | { kind: "grid" };

export interface Layout {
  cells: CellBox[];
  stage: { width: number; height: number };
  view: CanvasView;
  /** Columns in the arrangement — grid navigation needs it. */
  columns: number;
}

export interface StageTransform {
  scale: number;
  x: number;
  y: number;
  /** The grid hit the legibility floor: it no longer fits, so it scrolls. */
  scrollable: boolean;
}

/** Breathing room around the canvas, in viewport pixels. */
const PAD = 24;
/** Reserved at the bottom for the floating composer. */
const COMPOSER_RESERVE = 104;
/** Gap between cards. */
const GAP = 16;
/** Margin around the shrunk grid. */
const GRID_MARGIN = 40;
/** Past this, cards stop being readable; the grid scrolls rather than shrink. */
export const MIN_GRID_SCALE = 0.22;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The box one full-size card occupies: the whole canvas minus its chrome. */
function fullCard(viewport: Viewport): { width: number; height: number } {
  return {
    width: Math.max(1, viewport.width - PAD * 2),
    height: Math.max(1, viewport.height - PAD - COMPOSER_RESERVE),
  };
}

export function gridColumns(count: number, viewport: Viewport): number {
  if (count <= 0) return 0;
  // Wider windows earn another column; never more columns than cards.
  const byWidth = viewport.width >= 1400 ? 4 : viewport.width >= 1100 ? 3 : 2;
  return Math.min(count, byWidth);
}

export function layoutFor(count: number, viewport: Viewport, view: CanvasView): Layout {
  if (count <= 0) {
    return { cells: [], stage: { width: 0, height: 0 }, view, columns: 0 };
  }
  const full = fullCard(viewport);

  if (view.kind === "tile") {
    const width = (full.width - GAP * (view.per - 1)) / view.per;
    const cells = Array.from({ length: count }, (_, index) => ({
      x: index * (width + GAP),
      y: 0,
      width,
      height: full.height,
    }));
    return {
      cells,
      stage: { width: count * width + (count - 1) * GAP, height: full.height },
      view,
      columns: count,
    };
  }

  const columns = gridColumns(count, viewport);
  const rows = Math.ceil(count / columns);
  const cells = Array.from({ length: count }, (_, index) => ({
    x: (index % columns) * (full.width + GAP),
    y: Math.floor(index / columns) * (full.height + GAP),
    width: full.width,
    height: full.height,
  }));
  return {
    cells,
    stage: {
      width: columns * full.width + (columns - 1) * GAP,
      height: rows * full.height + (rows - 1) * GAP,
    },
    view,
    columns,
  };
}

/**
 * The transform to put on the stage, with `transform-origin: 0 0`. A stage
 * point p lands on screen at `scale * p + (x, y)`.
 */
export function transformForLayout(layout: Layout, index: number, viewport: Viewport): StageTransform {
  if (layout.cells.length === 0) return { scale: 1, x: 0, y: 0, scrollable: false };

  if (layout.view.kind === "tile") {
    const focused = layout.cells[clamp(index, 0, layout.cells.length - 1)];
    // Put the focused card at the left of the visible run, but never scroll
    // past the end — a trailing void looks broken.
    const maxOffset = Math.max(0, layout.stage.width - (viewport.width - PAD * 2));
    const offset = Math.min(focused.x, maxOffset);
    return { scale: 1, x: PAD - offset, y: PAD, scrollable: false };
  }

  const available = {
    width: viewport.width - GRID_MARGIN * 2,
    height: viewport.height - GRID_MARGIN - COMPOSER_RESERVE,
  };
  const fitted = Math.min(available.width / layout.stage.width, available.height / layout.stage.height);
  const scale = clamp(fitted, MIN_GRID_SCALE, 1);
  const scrollable = fitted < MIN_GRID_SCALE;
  return {
    scale,
    x: viewport.width / 2 - (layout.stage.width * scale) / 2,
    y: scrollable ? GRID_MARGIN : GRID_MARGIN + (available.height - layout.stage.height * scale) / 2,
    scrollable,
  };
}
