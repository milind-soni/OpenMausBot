import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { InspectorEntry, InspectorPage } from "../../shared/inspector";
import { appendInspectorRuntime, boundInspectorEntries } from "./inspector-window";

const event = (i: number): RuntimeEvent => ({
  eventId: `e${i}`, provider: "fixture", threadId: "t", createdAt: String(i), type: "turn.started",
});
const entry = (i: number): InspectorEntry => ({ kind: "runtime", at: String(i), data: event(i) });

describe("Inspector's recent event window", () => {
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
