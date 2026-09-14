// The layout's rules, without a DOM.
//
// These exist because the expensive failures here are the quiet ones: a saved
// layout that half-loads and scatters the board, a resize that shrinks a
// column until its cards are unreadable, or a drop that lands on top of
// another column — which is the one thing the canvas must not allow, and the
// exact behaviour the Team map has that this is meant to avoid.
import { describe, expect, it } from "vitest";

import {
  COLUMN_GAP,
  DEFAULT_COLUMN_HEIGHT,
  DEFAULT_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MAX_ZOOM,
  MIN_COLUMN_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ZOOM,
  boxesOverlap,
  clamp,
  collisions,
  columnTitle,
  contentBounds,
  defaultBoxes,
  keepOnScreen,
  parseLayout,
  resizeBox,
  resolveBoxes,
  settleInto,
  validBox,
  type ColumnBox,
} from "./board-layout";
import { WORK_COLUMNS, type WorkColumn } from "./task-board";

const label = (column: WorkColumn) => column.toUpperCase();

describe("defaultBoxes", () => {
  it("lays the columns out in the board's own order, left to right", () => {
    const boxes = defaultBoxes();
    // A viewer who has never dragged anything must see the arrangement the
    // board has always had, not something the canvas invented.
    const xs = WORK_COLUMNS.map((column) => boxes[column].x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(boxes.backlog.x).toBe(0);
    expect(boxes.todo.x).toBe(DEFAULT_COLUMN_WIDTH + COLUMN_GAP);
  });

  it("gives every column the same starting size", () => {
    const boxes = defaultBoxes();
    for (const column of WORK_COLUMNS) {
      expect(boxes[column].width).toBe(DEFAULT_COLUMN_WIDTH);
      expect(boxes[column].height).toBe(DEFAULT_COLUMN_HEIGHT);
    }
  });

  it("never overlaps itself", () => {
    const boxes = defaultBoxes();
    for (const a of WORK_COLUMNS) {
      for (const b of WORK_COLUMNS) {
        if (a === b) continue;
        expect(boxesOverlap(boxes[a], boxes[b])).toBe(false);
      }
    }
  });
});

describe("boxesOverlap", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };

  it("detects a real overlap", () => {
    expect(boxesOverlap(box, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
  });

  it("treats touching edges as arranged, not colliding", () => {
    // A column butted exactly against its neighbour is laid out on purpose.
    expect(boxesOverlap(box, { x: 100, y: 0, width: 100, height: 100 })).toBe(false);
    expect(boxesOverlap(box, { x: 0, y: 100, width: 100, height: 100 })).toBe(false);
  });

  it("does not consider a diagonal neighbour an overlap", () => {
    expect(boxesOverlap(box, { x: 100, y: 100, width: 100, height: 100 })).toBe(false);
  });
});

describe("collisions", () => {
  it("names the column a drop would land on", () => {
    const boxes = defaultBoxes();
    const moved = { ...boxes.todo, x: boxes.backlog.x + 10, y: boxes.backlog.y };
    expect(collisions("todo", moved, boxes)).toEqual(["backlog"]);
  });

  it("reports every column hit, not just the first", () => {
    const boxes = defaultBoxes();
    // A wide box straddling the whole row genuinely overlaps more than one.
    const moved = { x: -10, y: 0, width: 5000, height: DEFAULT_COLUMN_HEIGHT };
    const hit = collisions("done", moved, boxes);
    expect(hit).toContain("backlog");
    expect(hit).toContain("todo");
    expect(hit).not.toContain("done");
  });

  it("finds nothing when a column is dropped in clear space", () => {
    const boxes = defaultBoxes();
    const moved = { ...boxes.blocked, y: boxes.blocked.y + DEFAULT_COLUMN_HEIGHT + COLUMN_GAP };
    expect(collisions("blocked", moved, boxes)).toEqual([]);
  });
});

describe("settleInto", () => {
  const noOverlaps = (boxes: Record<WorkColumn, ColumnBox>) => {
    for (const a of WORK_COLUMNS) {
      for (const b of WORK_COLUMNS) {
        if (a === b) continue;
        if (boxesOverlap(boxes[a], boxes[b])) return false;
      }
    }
    return true;
  };

  it("puts the moved column exactly where it was dropped", () => {
    // The gesture must be honest: the column lands where the person aimed,
    // not near it.
    const boxes = defaultBoxes();
    const dropped = { ...boxes.backlog, x: 0, y: 900 };
    const settled = settleInto("backlog", dropped, boxes);
    expect(settled.backlog).toEqual(dropped);
  });

  it("slides whatever it landed on out of the way", () => {
    const boxes = defaultBoxes();
    // Drop Backlog right on top of To do.
    const dropped = { ...boxes.backlog, x: boxes.todo.x + 20 };
    const settled = settleInto("backlog", dropped, boxes);
    expect(settled.backlog).toEqual(dropped);
    expect(boxesOverlap(settled.backlog, settled.todo)).toBe(false);
  });

  it("leaves no overlapping pair at all, whatever was hit", () => {
    const boxes = defaultBoxes();
    const settled = settleInto("done", { ...boxes.done, x: 0, y: 0 }, boxes);
    expect(noOverlaps(settled)).toBe(true);
  });

  it("does not disturb columns the drop never touched", () => {
    const boxes = defaultBoxes();
    const settled = settleInto("blocked", { ...boxes.blocked, x: boxes.blocked.x + 900, y: 0 }, boxes);
    // Far to the right, into empty space: nothing else should have moved.
    expect(settled.backlog).toEqual(boxes.backlog);
    expect(settled.todo).toEqual(boxes.todo);
    expect(settled.done).toEqual(boxes.done);
  });

  it("pushes a neighbour the way the drag was going, not backwards", () => {
    // The board tidies by re-seating a collided column at the nearest FREE
    // seat, so it lands beside the dropped one rather than being flung across
    // the board — the failure that made a leftwards drag look like the
    // neighbour teleported right.
    const boxes = defaultBoxes();
    const dropped = { ...boxes.done, x: boxes.cancelled.x + 10 };
    const settled = settleInto("done", dropped, boxes);
    expect(boxesOverlap(settled.done, settled.cancelled)).toBe(false);
    // It moved, but stayed within a column's reach of where it was.
    expect(Math.abs(settled.cancelled.x - boxes.cancelled.x)).toBeLessThanOrEqual(
      boxes.done.width + 40,
    );
  });

  it("repairs a board that already had two columns on the same spot", () => {
    // The bug this pins: the pass only checked collisions against the DROPPED
    // column, so two columns that were already overlapping were both left
    // alone and the pile survived. A layout saved before the rule existed, or
    // a drag that never committed, can produce exactly that.
    const boxes = defaultBoxes();
    const stacked: Record<WorkColumn, ColumnBox> = {
      ...boxes,
      blocked: { ...boxes.blocked, x: 964 },
      done: { ...boxes.done, x: 964 },
    };
    // A drop somewhere else entirely still tidies the board it was given.
    const settled = settleInto("backlog", { ...boxes.backlog, x: 0, y: 900 }, stacked);
    expect(noOverlaps(settled)).toBe(true);
  });

  it("keeps every column a real box after a pile-up", () => {
    // Four columns dropped in the same place in turn. Each lands where it was
    // put — no refusal — and the ones it covered are re-seated rather than
    // lost, so the board never holds two columns in the same spot.
    let boxes = defaultBoxes();
    for (const column of ["backlog", "todo", "in_progress", "blocked"] as WorkColumn[]) {
      boxes = settleInto(column, { ...boxes[column], x: 0, y: 0 }, boxes);
    }
    expect(noOverlaps(boxes)).toBe(true);
    expect(boxes.blocked.x).toBe(0);
    expect(boxes.blocked.y).toBe(0);
    for (const column of WORK_COLUMNS) {
      expect(Number.isFinite(boxes[column].x)).toBe(true);
      expect(Number.isFinite(boxes[column].y)).toBe(true);
    }
  });
});

describe("resizeBox", () => {
  const box = { x: 100, y: 100, width: 300, height: 400 };

  it("grows from the right and bottom edges without moving the origin", () => {
    expect(resizeBox(box, "right", 40, 0)).toEqual({ x: 100, y: 100, width: 340, height: 400 });
    expect(resizeBox(box, "bottom", 0, 60)).toEqual({ x: 100, y: 100, width: 300, height: 460 });
  });

  it("keeps the opposite edge fixed when dragged from the left or top", () => {
    // The right edge must not move, or the column slides away from the handle
    // the person is holding.
    const left = resizeBox(box, "left", -50, 0);
    expect(left.width).toBe(350);
    expect(left.x + left.width).toBe(box.x + box.width);

    const top = resizeBox(box, "top", 0, -30);
    expect(top.height).toBe(430);
    expect(top.y + top.height).toBe(box.y + box.height);
  });

  it("moves both axes from the corner", () => {
    const corner = resizeBox(box, "corner", 20, 30);
    expect(corner).toEqual({ x: 100, y: 100, width: 320, height: 430 });
  });

  it("refuses to shrink a column until its cards stop being readable", () => {
    const tiny = resizeBox(box, "corner", -10_000, -10_000);
    expect(tiny.width).toBe(MIN_COLUMN_WIDTH);
    expect(tiny.height).toBe(MIN_COLUMN_HEIGHT);
  });

  it("refuses to grow a column without limit", () => {
    const huge = resizeBox(box, "corner", 100_000, 100_000);
    expect(huge.width).toBe(MAX_COLUMN_WIDTH);
  });
});

describe("validBox", () => {
  it("accepts a plain box", () => {
    expect(validBox({ x: 0, y: 0, width: 300, height: 400 })).toBe(true);
  });

  it("rejects anything a corrupt save could contain", () => {
    expect(validBox(null)).toBe(false);
    expect(validBox({ x: 0, y: 0, width: 300 })).toBe(false);
    expect(validBox({ x: 0, y: 0, width: "300", height: 400 })).toBe(false);
    expect(validBox({ x: Number.NaN, y: 0, width: 300, height: 400 })).toBe(false);
    expect(validBox({ x: 0, y: 0, width: 0, height: 400 })).toBe(false);
    // A position so far out it cannot be a real arrangement.
    expect(validBox({ x: 999_999, y: 0, width: 300, height: 400 })).toBe(false);
  });
});

describe("parseLayout", () => {
  it("returns nothing for a missing or unreadable layout", () => {
    expect(parseLayout(null)).toEqual({});
    expect(parseLayout("not json")).toEqual({});
    expect(parseLayout("[]")).toEqual({});
  });

  it("keeps a valid arrangement", () => {
    const saved = JSON.stringify({
      names: { blocked: "Needs help" },
      boxes: { todo: { x: 10, y: 20, width: 320, height: 380 } },
      view: { x: 5, y: 6, scale: 0.8 },
    });
    const layout = parseLayout(saved);
    expect(layout.names?.blocked).toBe("Needs help");
    expect(layout.boxes?.todo).toEqual({ x: 10, y: 20, width: 320, height: 380 });
    expect(layout.view).toEqual({ x: 5, y: 6, scale: 0.8 });
  });

  it("drops a corrupt column without losing the rest", () => {
    // The failure worth designing for: one bad entry costing the whole board.
    const saved = JSON.stringify({
      names: { backlog: "Ideas" },
      boxes: {
        todo: { x: 10, y: 20, width: 320, height: 380 },
        done: { x: "nope", y: 0, width: 300, height: 400 },
      },
    });
    const layout = parseLayout(saved);
    expect(layout.names?.backlog).toBe("Ideas");
    expect(Object.keys(layout.boxes ?? {})).toEqual(["todo"]);
  });

  it("ignores names for columns that are not the board's own", () => {
    const saved = JSON.stringify({ names: { backlog: "Ideas", "drop-table": "evil" } });
    const layout = parseLayout(saved);
    expect(Object.keys(layout.names ?? {})).toEqual(["backlog"]);
  });

  it("bounds a rename rather than storing a paragraph", () => {
    const long = "x".repeat(500);
    const layout = parseLayout(JSON.stringify({ names: { backlog: long } }));
    expect(layout.names?.backlog).toHaveLength(40);
  });

  it("drops a blank rename instead of hiding the column's real label", () => {
    const layout = parseLayout(JSON.stringify({ names: { backlog: "   " } }));
    expect(layout.names?.backlog).toBeUndefined();
  });

  it("clamps a saved size into range rather than trusting it", () => {
    const saved = JSON.stringify({ boxes: { todo: { x: 0, y: 0, width: 9999, height: 5 } } });
    const layout = parseLayout(saved);
    expect(layout.boxes?.todo?.width).toBe(MAX_COLUMN_WIDTH);
    expect(layout.boxes?.todo?.height).toBe(MIN_COLUMN_HEIGHT);
  });

  it("clamps a saved zoom into range", () => {
    expect(parseLayout(JSON.stringify({ view: { x: 0, y: 0, scale: 99 } })).view?.scale).toBe(MAX_ZOOM);
    expect(parseLayout(JSON.stringify({ view: { x: 0, y: 0, scale: 0.001 } })).view?.scale).toBe(MIN_ZOOM);
  });

  it("drops a view with a missing or unreadable part", () => {
    expect(parseLayout(JSON.stringify({ view: { x: 0, y: 0 } })).view).toBeUndefined();
    expect(parseLayout(JSON.stringify({ view: { x: "a", y: 0, scale: 1 } })).view).toBeUndefined();
  });
});

describe("resolveBoxes", () => {
  it("fills the columns the viewer never moved with their default place", () => {
    const resolved = resolveBoxes({ todo: { x: 500, y: 0, width: 260, height: 300 } });
    expect(resolved.todo.x).toBe(500);
    expect(resolved.backlog).toEqual(defaultBoxes().backlog);
    expect(Object.keys(resolved).sort()).toEqual([...WORK_COLUMNS].sort());
  });

  it("gives the default arrangement when nothing was saved", () => {
    expect(resolveBoxes(undefined)).toEqual(defaultBoxes());
  });
});

describe("columnTitle", () => {
  it("prefers the viewer's own name", () => {
    expect(columnTitle("blocked", { blocked: "Needs help" }, label)).toBe("Needs help");
  });

  it("falls back to the app's label when nothing was renamed", () => {
    expect(columnTitle("blocked", {}, label)).toBe("BLOCKED");
    expect(columnTitle("blocked", undefined, label)).toBe("BLOCKED");
  });

  it("ignores a rename that is only whitespace", () => {
    expect(columnTitle("blocked", { blocked: "   " }, label)).toBe("BLOCKED");
  });
});

describe("keepOnScreen", () => {
  const viewport = { width: 1000, height: 800 };
  const view = { x: 0, y: 0, scale: 1 };

  it("leaves a column alone when it is already visible", () => {
    const box = { x: 100, y: 100, width: 300, height: 400 };
    expect(keepOnScreen(box, viewport, view)).toEqual(box);
  });

  it("pulls a column back from beyond the left edge", () => {
    // The failure this prevents: a column dragged past the edge is still on
    // the board but nowhere a person can see or grab it.
    const box = { x: -5000, y: 100, width: 300, height: 400 };
    const kept = keepOnScreen(box, viewport, view);
    expect(kept.x).toBeGreaterThan(box.x);
    expect(kept.x * view.scale + view.x + box.width * view.scale).toBeGreaterThanOrEqual(80);
  });

  it("pulls a column back from beyond the right edge", () => {
    const box = { x: 5000, y: 100, width: 300, height: 400 };
    const kept = keepOnScreen(box, viewport, view);
    expect(kept.x).toBeLessThan(box.x);
    expect(kept.x * view.scale + view.x).toBeLessThanOrEqual(viewport.width - 80);
  });

  it("pulls a column back from above and below", () => {
    const above = keepOnScreen({ x: 0, y: -5000, width: 300, height: 400 }, viewport, view);
    expect(above.y).toBeGreaterThan(-5000);
    const below = keepOnScreen({ x: 0, y: 5000, width: 300, height: 400 }, viewport, view);
    expect(below.y).toBeLessThan(5000);
  });

  it("accounts for pan and zoom", () => {
    // The clamp is about screen pixels; the same world position can be off
    // screen or on it depending on the view.
    const box = { x: 0, y: 0, width: 300, height: 400 };
    const panned = { x: -2000, y: -2000, scale: 1 };
    const kept = keepOnScreen(box, viewport, panned);
    expect(kept.x).toBeGreaterThan(box.x);
    expect(kept.y).toBeGreaterThan(box.y);
  });
});

describe("contentBounds", () => {
  it("spans every column", () => {
    const bounds = contentBounds(defaultBoxes());
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
    expect(bounds.right).toBe(WORK_COLUMNS.length * DEFAULT_COLUMN_WIDTH + (WORK_COLUMNS.length - 1) * COLUMN_GAP);
    expect(bounds.height).toBe(DEFAULT_COLUMN_HEIGHT);
  });
});

describe("clamp", () => {
  it("holds a value inside its range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});