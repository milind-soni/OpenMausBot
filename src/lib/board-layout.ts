// Where the board's columns sit, how big they are, and what they are called.
//
// All three are the viewer's own arrangement of their screen, so all three are
// kept in the browser rather than on the server — the same choice the Team map
// makes for its tiles, and for the same reason: two people looking at the same
// board are allowed to want different layouts, and clearing a cache should not
// change what the work is, only how it is drawn.
//
// The rules live here rather than in the canvas so the interesting cases —
// a corrupt entry, a size dragged to nothing, a drop that would land on top of
// another column — are testable without a DOM.
import { WORK_COLUMNS, type WorkColumn } from "./task-board";

/** A column's box on the canvas, in world coordinates. */
export interface ColumnBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything a viewer may change about how the board is laid out. */
export interface BoardLayout {
  /** Column order and identifiers, left to right. A saved layout keeps the
   * canonical set: these keys are the board's own, not free text. */
  names?: Partial<Record<WorkColumn, string>>;
  boxes?: Partial<Record<WorkColumn, ColumnBox>>;
  /** Pan/zoom, so reopening the board lands where it was left. */
  view?: { x: number; y: number; scale: number };
}

export const DEFAULT_COLUMN_WIDTH = 300;
export const DEFAULT_COLUMN_HEIGHT = 420;

/** Bounds a column may be dragged to. The minimum is the size below which a
 * card stops being readable — a title needs roughly this much — and the
 * maximum stops a stray drag from producing a column kilometres wide that the
 * viewer then has to hunt for. */
export const MIN_COLUMN_WIDTH = 220;
export const MIN_COLUMN_HEIGHT = 220;
export const MAX_COLUMN_WIDTH = 900;
export const MAX_COLUMN_HEIGHT = 2000;

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 1.5;

/** Gap between columns in the default arrangement, matching the grid's old
 * spacing so an existing board looks the same on first load. */
export const COLUMN_GAP = 16;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The arrangement a viewer who has never dragged anything sees: the board's
 * own left-to-right order, laid out in one row.
 *
 * This is deliberately the order the columns have always been in. A saved
 * layout is an opt-in — nothing about a person's first visit should depend on
 * the canvas existing. */
export function defaultBoxes(): Record<WorkColumn, ColumnBox> {
  const boxes = {} as Record<WorkColumn, ColumnBox>;
  WORK_COLUMNS.forEach((column, index) => {
    boxes[column] = {
      x: index * (DEFAULT_COLUMN_WIDTH + COLUMN_GAP),
      y: 0,
      width: DEFAULT_COLUMN_WIDTH,
      height: DEFAULT_COLUMN_HEIGHT,
    };
  });
  return boxes;
}

/** Whether two column boxes overlap. Touching edges do not count — a column
 * butted exactly against its neighbour is arranged, not colliding. */
export function boxesOverlap(a: ColumnBox, b: ColumnBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** The columns a moved box would land on, if any.
 *
 * Used by `settleInto` to decide which columns must slide out of the way. The
 * rule the board enforces is "no two columns overlap"; how it gets there is
 * displacement, not refusal, so this is a detector rather than a veto. */
export function collisions(
  moved: WorkColumn,
  box: ColumnBox,
  boxes: Record<WorkColumn, ColumnBox>,
): WorkColumn[] {
  return WORK_COLUMNS.filter(
    (column) => column !== moved && boxesOverlap(box, boxes[column]),
  );
}

/** Whether a box is a sane thing to draw: finite, positive, inside bounds. */
export function validBox(value: unknown): value is ColumnBox {
  if (!value || typeof value !== "object") return false;
  const box = value as Record<string, unknown>;
  const numbers = [box.x, box.y, box.width, box.height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  // A saved position is a place on an effectively infinite plane, but a
  // nonsensical one is dropped rather than trusted — the same guard the Team
  // map applies to its saved positions.
  if (Math.abs(box.x as number) > 100_000 || Math.abs(box.y as number) > 100_000) return false;
  return (box.width as number) > 0 && (box.height as number) > 0;
}

/** Read a saved layout. Anything unreadable is dropped rather than repaired:
 * a partly-corrupt layout should cost the viewer their arrangement, not the
 * board. */
export function parseLayout(raw: string | null): BoardLayout {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const source = parsed as Record<string, unknown>;
  const layout: BoardLayout = {};

  const names = source.names;
  if (names && typeof names === "object") {
    const kept: Partial<Record<WorkColumn, string>> = {};
    for (const column of WORK_COLUMNS) {
      const value = (names as Record<string, unknown>)[column];
      // A rename is a label, not a document: trimmed, bounded, and ignoring
      // anything that is not a string.
      if (typeof value === "string" && value.trim()) kept[column] = value.trim().slice(0, 40);
    }
    layout.names = kept;
  }

  const boxes = source.boxes;
  if (boxes && typeof boxes === "object") {
    const kept: Partial<Record<WorkColumn, ColumnBox>> = {};
    for (const column of WORK_COLUMNS) {
      const value = (boxes as Record<string, unknown>)[column];
      if (validBox(value)) {
        kept[column] = {
          x: value.x,
          y: value.y,
          width: clamp(value.width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH),
          height: clamp(value.height, MIN_COLUMN_HEIGHT, MAX_COLUMN_HEIGHT),
        };
      }
    }
    layout.boxes = kept;
  }

  const view = source.view;
  if (view && typeof view === "object") {
    const { x, y, scale } = view as Record<string, unknown>;
    if (
      typeof x === "number" && Number.isFinite(x) &&
      typeof y === "number" && Number.isFinite(y) &&
      typeof scale === "number" && Number.isFinite(scale)
    ) {
      layout.view = { x, y, scale: clamp(scale, MIN_ZOOM, MAX_ZOOM) };
    }
  }

  return layout;
}

/** Fill a saved layout out to a complete board: every column has a box, and
 * any the viewer never moved keeps its default place. */
export function resolveBoxes(saved: Partial<Record<WorkColumn, ColumnBox>> | undefined): Record<WorkColumn, ColumnBox> {
  // Spreading `undefined` adds nothing, so no fallback is needed.
  return { ...defaultBoxes(), ...saved };
}

/** A column's title: the viewer's own name for it if they set one, otherwise
 * the label the app supplies. This is the single place that decides, so the
 * canvas and anything else drawing a column cannot disagree. */
export function columnTitle(
  column: WorkColumn,
  names: Partial<Record<WorkColumn, string>> | undefined,
  fallback: (column: WorkColumn) => string,
): string {
  const custom = names?.[column]?.trim();
  return custom || fallback(column);
}

/** Where a column lands when its box is resized from a given corner.
 *
 * Resizing from the left or top edge has to move the origin as well as the
 * size, or the column would grow to the right while the handle is dragged to
 * the left. `edge` names the corner being pulled. */
export type ResizeEdge = "right" | "bottom" | "corner" | "left" | "top";

export function resizeBox(
  box: ColumnBox,
  edge: ResizeEdge,
  deltaX: number,
  deltaY: number,
): ColumnBox {
  let { x, y, width, height } = box;

  if (edge === "right" || edge === "corner") {
    width = clamp(width + deltaX, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
  }
  if (edge === "bottom" || edge === "corner") {
    height = clamp(height + deltaY, MIN_COLUMN_HEIGHT, MAX_COLUMN_HEIGHT);
  }
  if (edge === "left") {
    // Moving the left edge changes both the origin and the width; the right
    // edge stays put, which is what makes the gesture feel attached to the
    // handle rather than to the column.
    const right = box.x + box.width;
    width = clamp(box.width - deltaX, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
    x = right - width;
  }
  if (edge === "top") {
    const bottom = box.y + box.height;
    height = clamp(box.height - deltaY, MIN_COLUMN_HEIGHT, MAX_COLUMN_HEIGHT);
    y = bottom - height;
  }

  return { x, y, width, height };
}

/** Keep a column on screen.
 *
 * The canvas is unbounded, so without this a column can be dragged past the
 * edge and effectively lost: still on the board, but nowhere a person can see
 * or reach it. A small overhang is allowed so a column can sit flush against
 * the edge while being dragged, but the box may never leave the viewport
 * entirely. */
export function keepOnScreen(
  box: ColumnBox,
  viewport: { width: number; height: number },
  view: { x: number; y: number; scale: number },
): ColumnBox {
  // World coordinates → screen pixels, so the clamp is about what the person
  // can actually see rather than about world space.
  const screenLeft = box.x * view.scale + view.x;
  const screenTop = box.y * view.scale + view.y;
  const screenWidth = box.width * view.scale;
  const screenHeight = box.height * view.scale;

  // A column must keep at least this much of itself visible on every edge it
  // can be pushed against — enough to grab its header and drag it back.
  const keep = 80;

  let dx = 0;
  let dy = 0;
  if (screenLeft + screenWidth < keep) dx = keep - (screenLeft + screenWidth);
  if (screenLeft > viewport.width - keep) dx = viewport.width - keep - screenLeft;
  if (screenTop + screenHeight < keep) dy = keep - (screenTop + screenHeight);
  if (screenTop > viewport.height - keep) dy = viewport.height - keep - screenTop;

  if (dx === 0 && dy === 0) return box;
  return { ...box, x: box.x + dx / view.scale, y: box.y + dy / view.scale };
}

/** The bounding box of every column, for fitting the view. */
export function contentBounds(boxes: Record<WorkColumn, ColumnBox>) {
  const values = WORK_COLUMNS.map((column) => boxes[column]);
  const left = Math.min(...values.map((box) => box.x));
  const top = Math.min(...values.map((box) => box.y));
  const right = Math.max(...values.map((box) => box.x + box.width));
  const bottom = Math.max(...values.map((box) => box.y + box.height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** How much clear space is left around a column when the board tidies. */
const TIDY_GAP = 24;

/** Whether a box would overlap anything already placed. */
function stillOverlaps(box: ColumnBox, all: ColumnBox[]): boolean {
  return all.some((other) => boxesOverlap(box, other));
}

/** Resolve the board so nothing overlaps, with `front` keeping the spot it was
 * dropped on.
 *
 * The simpler rule, after two tries at the clever one. Neighbours are NOT
 * pushed around while a column is being dragged: the dragged column simply
 * floats above them (the canvas lifts it), and the tidying happens once, on
 * drop. Chasing a column around the canvas as it passes over others made the
 * board feel like it was fighting the person — and any "which way should this
 * one move" rule is a guess, because the board cannot know what they meant.
 *
 * So: the dropped column stays exactly where it was put, and every other
 * column that it landed on is re-seated at the nearest free spot on a grid
 * flowing from the dropped column outward. Only columns that actually collide
 * move, so dropping into clear space disturbs nothing. */
export function settleInto(
  moved: WorkColumn,
  box: ColumnBox,
  boxes: Record<WorkColumn, ColumnBox>,
): Record<WorkColumn, ColumnBox> {
  const next: Record<WorkColumn, ColumnBox> = { ...boxes, [moved]: box };

  // The dropped column holds its spot, then every other column is placed in
  // turn. A column that does not collide with anything ALREADY PLACED keeps
  // its position — which is most of them, most of the time — and one that
  // does is re-seated.
  //
  // Note "already placed" rather than "the dropped column": an earlier version
  // only checked against the dropped box, so a pair of columns that were
  // already overlapping (from a layout saved before this rule existed, or a
  // half-finished drag) were both left alone and the board kept its pile. The
  // rule the board promises is "no two columns overlap", so the pass has to
  // repair the board it was given, not just the part the drop touched.
  const placed: ColumnBox[] = [box];
  for (const column of WORK_COLUMNS) {
    if (column === moved) continue;
    const own = next[column];
    if (!stillOverlaps(own, placed)) {
      placed.push(own);
      continue;
    }
    // Search outward in rings for the nearest free seat, so a displaced column
    // lands beside the one that displaced it rather than across the board.
    const seat = nearestFreeSeat(own, box, placed);
    next[column] = seat;
    placed.push(seat);
  }

  return next;
}

/** The closest position to `own` that does not overlap anything in `placed`,
 * searched in rings outward from where the column already is.
 *
 * The search is anchored on the column's OWN position, not the dropped one:
 * a column that merely collided with another (rather than with the drop) moves
 * the shortest distance that clears the board, instead of being dragged over
 * to wherever the dropped column happens to sit. */
function nearestFreeSeat(own: ColumnBox, front: ColumnBox, placed: ColumnBox[]): ColumnBox {
  const stepX = front.width + TIDY_GAP;
  const stepY = front.height + TIDY_GAP;
  if (!stillOverlaps(own, placed)) return own;

  for (let ring = 1; ring <= 8; ring += 1) {
    // Candidate seats around the column's own place, nearest ring first,
    // ordered by distance so the closest free one wins.
    const offsets: Array<[number, number]> = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        offsets.push([dx, dy]);
      }
    }
    offsets.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));

    const seats = offsets.map(([dx, dy]) => ({
      ...own,
      x: own.x + dx * stepX,
      y: own.y + dy * stepY,
    }));
    const free = seats.find((seat) => !stillOverlaps(seat, placed));
    if (free) return free;
  }

  // Nowhere free within reach: the column stays where it was. The board is
  // crowded, and moving it further would be a bigger surprise than the
  // overlap it already had.
  return own;
}