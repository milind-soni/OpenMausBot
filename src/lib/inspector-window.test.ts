import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { InspectorEntry, InspectorPage } from "../../shared/inspector";
import { appendInspectorRuntime, boundInspectorEntries, mergeInspectorSnapshot } from "./inspector-window";

const event = (i: number): RuntimeEvent => ({
  eventId: `e${i}`, provider: "fixture", threadId: "t", createdAt: String(i), type: "turn.started",
});
const entry = (i: number): InspectorEntry => ({ kind: "runtime", at: String(i), data: event(i) });

describe("Inspector's recent event window", () => {
  it("preserves distinct equal-time records without an overlap and counts the union once", () => {
    const first = { ...event(1), createdAt: "same" };
    const second = { ...event(2), createdAt: "same" };
    const previous: InspectorPage = { entries: [{ kind: "runtime", at: "same", data: second }], total: { runtime: 1, native: 0 } };
    const snapshot: InspectorPage = { entries: [{ kind: "runtime", at: "same", data: first }], total: { runtime: 1, native: 0 } };
    const merged = mergeInspectorSnapshot(previous, snapshot);
    expect(merged.entries).toEqual([...snapshot.entries, ...previous.entries]);
    expect(merged.total.runtime).toBe(2);
    expect(mergeInspectorSnapshot(merged, snapshot)).toEqual(merged);
    expect(mergeInspectorSnapshot(merged, merged)).toEqual(merged);
  });

  it("retains a live tail across stale snapshots and counts it once when disk catches up", () => {
    const previous: InspectorPage = { entries: [entry(1), entry(2), entry(3)], total: { runtime: 53, native: 12 } };
    const snapshot: InspectorPage = { entries: [entry(1), entry(2)], total: { runtime: 52, native: 10 } };
    const merged = mergeInspectorSnapshot(previous, snapshot);
    expect(merged).toEqual({ entries: previous.entries, total: { runtime: 53, native: 10 } });
    expect(mergeInspectorSnapshot(merged, snapshot)).toEqual(merged);
    expect(mergeInspectorSnapshot(merged, { ...snapshot, entries: previous.entries, total: { runtime: 53, native: 10 } })).toEqual(merged);
    expect(snapshot.entries).toEqual([entry(1), entry(2)]);
    expect(previous.total.native).toBe(12);
  });

  it("preserves publication order for equal-time events using the overlap anchor", () => {
    const entries: InspectorEntry[] = [1, 2, 3].map((i) => ({ kind: "runtime", at: "same", data: { ...event(i), createdAt: "same" } }));
    const previous: InspectorPage = { entries, total: { runtime: 3, native: 0 } };
    const snapshot: InspectorPage = { entries: entries.slice(0, 2), total: { runtime: 2, native: 0 } };
    expect(mergeInspectorSnapshot(previous, snapshot)).toEqual(previous);
  });

  it("does not reintroduce old rows when the snapshot has advanced past the retained window", () => {
    const previous: InspectorPage = { entries: [entry(1), entry(2)], total: { runtime: 2, native: 0 } };
    const snapshot: InspectorPage = { entries: [entry(3), entry(4)], total: { runtime: 4, native: 0 } };
    expect(mergeInspectorSnapshot(previous, snapshot)).toEqual(snapshot);
    expect(mergeInspectorSnapshot(null, snapshot)).toEqual(snapshot);
  });

  it("bounds the merged runtime window while keeping fresh native records and cumulative totals", () => {
    const entries = Array.from({ length: 401 }, (_, i) => {
      const data = { ...event(i), createdAt: String(i).padStart(4, "0") };
      return { kind: "runtime" as const, at: data.createdAt, data };
    });
    const native: InspectorEntry = { kind: "native", at: "0001", data: { at: "0001", dir: "out", source: "fixture", msg: "fresh" } };
    const merged = mergeInspectorSnapshot(
      { entries: entries.slice(1), total: { runtime: 501, native: 100 } },
      { entries: [...entries.slice(0, 400), native], total: { runtime: 500, native: 101 } },
    );
    expect(merged.entries.filter((item) => item.kind === "runtime")).toEqual(entries.slice(1));
    expect(merged.entries).toContainEqual(native);
    expect(merged.total).toEqual({ runtime: 501, native: 101 });
  });

  it("bounds each log separately while keeping the original interleaving and totals", () => {
    const entries: InspectorEntry[] = [];
    for (let i = 0; i < 500; i++) {
      entries.push(entry(i), { kind: "native", at: String(i), data: { at: String(i), dir: "out", source: "fixture", msg: i } });
    }
    const kept = boundInspectorEntries(entries);
    expect(kept).toEqual(entries.slice(200));
    expect(entries).toHaveLength(1_000);
    expect(boundInspectorEntries(kept)).toBe(kept);
  });

  it("keeps its last 400 events over 10,000 arrivals without resetting the total", () => {
    let page: InspectorPage | null = null;
    for (let start = 0; start < 10_000; start += 200) {
      page = appendInspectorRuntime(page, Array.from({ length: 200 }, (_, i) => event(start + i)));
      expect(page!.entries.length).toBeLessThanOrEqual(400);
    }
    expect(page!.total).toEqual({ runtime: 10_000, native: 0 });
    expect(page!.entries).toEqual(Array.from({ length: 400 }, (_, i) => entry(9_600 + i)));
  });

  it("deduplicates the snapshot and the current batch without mutating published pages", () => {
    const page: InspectorPage = { entries: [entry(1)], total: { runtime: 40, native: 12 } };
    expect(appendInspectorRuntime(page, [event(1)])).toBe(page);
    const next = appendInspectorRuntime(page, [event(1), event(2), event(2)])!;
    expect(next.entries).toEqual([entry(1), entry(2)]);
    expect(next.total).toEqual({ runtime: 41, native: 12 });
    expect(page).toEqual({ entries: [entry(1)], total: { runtime: 40, native: 12 } });
    expect(appendInspectorRuntime(null, [])).toBeNull();
  });
});
