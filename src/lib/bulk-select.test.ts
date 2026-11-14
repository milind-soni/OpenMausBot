import { describe, expect, it } from "vitest";
import {
  BULK_DELETE_CHUNK,
  chunkIds,
  clickRow,
  clearSelection,
  isTickable,
  olderThanIds,
  opensRowMenuFromKey,
  archivedIds,
  rangeSelect,
  selectAll,
  summarizeDelete,
  toggleId,
  type SelectableRow,
} from "./bulk-select";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const row = (threadId: string, extra: Partial<SelectableRow> = {}): SelectableRow => ({ threadId, ...extra });

describe("isTickable", () => {
  it("rejects working and busy rows, accepts idle, waiting and pinned ones", () => {
    expect(isTickable(row("a"))).toBe(true);
    expect(isTickable(row("a", { pinned: true }))).toBe(true);
    expect(isTickable(row("a", { activity: "waiting-on-you" }))).toBe(true);
    expect(isTickable(row("a", { busy: true }))).toBe(false);
    expect(isTickable(row("a", { activity: "working" }))).toBe(false);
  });
});

describe("toggleId", () => {
  it("adds and removes without mutating the input", () => {
    const start = new Set(["a"]);
    const added = toggleId(start, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect([...start]).toEqual(["a"]);
    expect([...toggleId(added, "a")]).toEqual(["b"]);
  });
});

describe("rangeSelect", () => {
  const rows = [row("a"), row("b"), row("c", { busy: true }), row("d"), row("e")];
  it("ticks every tickable row between anchor and target in either direction", () => {
    expect([...rangeSelect(new Set(), rows, "a", "e", true)].sort()).toEqual(["a", "b", "d", "e"]);
    expect([...rangeSelect(new Set(), rows, "e", "b", true)].sort()).toEqual(["b", "d", "e"]);
  });
  it("unticks a range when check is false and leaves others alone", () => {
    expect([...rangeSelect(new Set(["a", "b", "d", "e"]), rows, "b", "d", false)].sort()).toEqual(["a", "e"]);
  });
  it("falls back to the target alone when the anchor is not in the list", () => {
    expect([...rangeSelect(new Set(), rows, "zzz", "d", true)]).toEqual(["d"]);
    expect([...rangeSelect(new Set(), rows, null, "d", true)]).toEqual(["d"]);
  });
  it("does nothing for an unknown target", () => {
    expect([...rangeSelect(new Set(["a"]), rows, "a", "nope", true)]).toEqual(["a"]);
  });
});

describe("filters", () => {
  const rows = [
    row("fresh", { updatedAt: NOW - 2 * DAY }),
    row("old", { updatedAt: NOW - 40 * DAY }),
    row("oldPinned", { updatedAt: NOW - 60 * DAY, pinned: true }),
    row("oldBusy", { updatedAt: NOW - 50 * DAY, busy: true }),
    row("created", { createdAt: NOW - 45 * DAY }),
    row("unstamped"),
    row("arch", { updatedAt: NOW - 1 * DAY, archivedAt: NOW - DAY }),
    row("archZero", { updatedAt: NOW - 1 * DAY, archivedAt: 0 }),
    row("archPinned", { archivedAt: 5, pinned: true }),
  ];
  it("older than N days uses recency, skips pinned, running and unstamped rows", () => {
    expect(olderThanIds(rows, 30, NOW).sort()).toEqual(["created", "old"]);
  });
  it("archived means the field is present (0 counts), skipping pinned and running rows", () => {
    expect(archivedIds(rows).sort()).toEqual(["arch", "archZero"]);
  });
  it("select all takes every tickable row, pinned included", () => {
    expect(selectAll(rows).has("oldPinned")).toBe(true);
    expect(selectAll(rows).has("oldBusy")).toBe(false);
  });
  it("clear empties the selection", () => {
    expect(clearSelection().size).toBe(0);
  });
});

describe("chunkIds", () => {
  it("splits at the server-friendly chunk size and keeps order", () => {
    expect(BULK_DELETE_CHUNK).toBe(200);
    const ids = Array.from({ length: 450 }, (_, i) => `t${i}`);
    const parts = chunkIds(ids);
    expect(parts.map((p) => p.length)).toEqual([200, 200, 50]);
    expect(parts.flat()).toEqual(ids);
  });
  it("returns no chunks for no ids", () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe("summarizeDelete", () => {
  it("counts deleted and groups refused ids by reason", () => {
    const summary = summarizeDelete([
      { deleted: ["a", "b"], refused: [{ threadId: "c", reason: "busy" }] },
      { deleted: ["d"], refused: [{ threadId: "e", reason: "not-found" }, { threadId: "f", reason: "busy" }] },
    ]);
    expect(summary).toEqual({ deleted: 3, busy: 2, missing: 1 });
  });
});

describe("clickRow", () => {
  const rows = [row("a"), row("b"), row("c"), row("d")];
  it("a plain click flips one row", () => {
    expect([...clickRow(new Set(), rows, "a", "c", false)]).toEqual(["c"]);
  });
  it("shift-click ticks the range from the anchor to the clicked row", () => {
    expect([...clickRow(new Set(["a"]), rows, "a", "c", true)].sort()).toEqual(["a", "b", "c"]);
  });
  it("shift-click on a ticked row unticks the range", () => {
    expect([...clickRow(new Set(["a", "b", "c", "d"]), rows, "a", "c", true)]).toEqual(["d"]);
  });
  it("shift-click with no anchor acts like a plain click", () => {
    expect([...clickRow(new Set(), rows, null, "c", true)]).toEqual(["c"]);
  });
});

describe("opensRowMenuFromKey", () => {
  it("opens the row menu from ContextMenu and Shift+F10 outside select mode", () => {
    expect(opensRowMenuFromKey("ContextMenu", false, false)).toBe(true);
    expect(opensRowMenuFromKey("F10", true, false)).toBe(true);
    expect(opensRowMenuFromKey("F10", false, false)).toBe(false);
    expect(opensRowMenuFromKey("a", true, false)).toBe(false);
  });
  it("stays inert in select mode", () => {
    expect(opensRowMenuFromKey("ContextMenu", false, true)).toBe(false);
    expect(opensRowMenuFromKey("F10", true, true)).toBe(false);
  });
});
