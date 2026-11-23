import { describe, expect, it } from "vitest";

import { GB, storageReport } from "./storage-report-fixture";
import {
  settleSeen, storageBand, storageBots, storageFullness, storageNotice, storageSize, storageSummary, type StorageAnswer, type StorageReportWire,
} from "./storage-report";

const answer = (report: StorageReportWire | null, over: Partial<StorageAnswer> = {}): StorageAnswer => ({ storage: report, ...over });
const bytesOf = (summary: ReturnType<typeof storageSummary>) => Object.fromEntries(summary!.groups.map((group) => [group.key, group.bytes]));

describe("storage fullness", () => {
  it("is used of used plus free, as df counts it, from the live reading when there is one", () => {
    expect(storageFullness(answer(storageReport()))).toEqual({ usedBytes: 30 * GB, sizeBytes: 60 * GB, percent: 50 });
    expect(storageFullness(answer(storageReport(), { now: { totalBytes: 60 * GB, freeBytes: 6 * GB, usedBytes: 51 * GB } }))?.percent).toBe(89);
    expect(storageFullness(answer(storageReport({ volume: null })))).toBeNull();
    expect(storageFullness(null)).toBeNull();
  });

  it("bands at 80 and 90", () => {
    expect([79, 80, 89, 90, 100].map(storageBand)).toEqual(["ok", "near", "near", "full", "full"]);
  });
});

describe("the bar's groups", () => {
  it("groups by the class the server gives, takes `other` out by name, and names what the pass couldn't see", () => {
    expect(bytesOf(storageSummary(answer(storageReport())))).toEqual({ work: 13 * GB, precious: 6 * GB, rebuildable: 8 * GB, other: 2 * GB, unmeasured: 1 * GB });
  });

  it("puts a class this app doesn't know under Other, never under cache", () => {
    const report = storageReport({ categories: [{ name: "future_thing", class: "fresh-class", bytes: 4 * GB, files: 1 }] });
    expect(bytesOf(storageSummary(answer(report)))).toEqual({ other: 4 * GB, unmeasured: 26 * GB });
  });

  it("scales an over-count down to what is used and says by how much", () => {
    const report = storageReport({ categories: [{ name: "bot_files", class: "work", bytes: 30 * GB, files: 1 }, { name: "caches", class: "rebuildable", bytes: 10 * GB, files: 1 }] });
    const summary = storageSummary(answer(report))!;
    expect(summary.overcountBytes).toBe(10 * GB);
    expect(bytesOf(summary)).toEqual({ work: 22.5 * GB, rebuildable: 7.5 * GB });
  });

  it("counts what was written since the pass as unmeasured, and shrinks the groups when the volume shrank", () => {
    const grown = storageSummary(answer(storageReport(), { now: { totalBytes: 60 * GB, freeBytes: 20 * GB, usedBytes: 40 * GB } }))!;
    expect(bytesOf(grown).unmeasured).toBe(11 * GB);
    const shrunk = storageSummary(answer(storageReport(), { now: { totalBytes: 60 * GB, freeBytes: 45 * GB, usedBytes: 15 * GB } }))!;
    expect(shrunk.groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(15 * GB);
  });

  it("is nothing before the first pass", () => {
    expect(storageSummary(answer(storageReport({ at: null, ageS: null, categories: [] })))).toBeNull();
  });
});

describe("the sidebar's line", () => {
  it("shows once per crossing: seen at 80 stays away until 90, and seen at 90 stays away", () => {
    expect(storageNotice(79, null)).toBeNull();
    expect(storageNotice(80, null)).toBe("near");
    expect(storageNotice(86, "near")).toBeNull();
    expect(storageNotice(90, "near")).toBe("full");
    expect(storageNotice(95, "full")).toBeNull();
    expect(storageNotice(null, null)).toBeNull();
  });

  it("re-arms only after usage falls five points under a line, so a volume that grows itself near 80% says it once", () => {
    expect(settleSeen("near", 77)).toBe("near");
    expect(storageNotice(81, settleSeen("near", 77))).toBeNull();
    expect(settleSeen("near", 74)).toBeNull();
    expect(storageNotice(80, settleSeen("near", 74))).toBe("near");
    expect(settleSeen("full", 86)).toBe("full");
    expect(settleSeen("full", 84)).toBe("near");
    expect(storageNotice(91, settleSeen("full", 84))).toBe("full");
    expect(settleSeen("full", 10)).toBeNull();
  });
});

describe("the bots list", () => {
  it("names the largest bots by the app's own names, says Unnamed for a bot with none, and keeps deleted bots apart", () => {
    const names: Record<string, string> = { chief: "Chief", research: "  " };
    expect(storageBots(storageReport(), (id) => names[id])).toEqual([
      { key: "chief", name: "Chief", bytes: 7 * GB, kind: "bot" },
      { key: "research", name: null, bytes: 3 * GB, kind: "bot" },
      { key: "gone", name: null, bytes: 1.5 * GB, kind: "gone" },
      { key: "rest", name: null, bytes: 0.5 * GB, kind: "rest" },
    ]);
  });

  it("folds bots past the first few into Other bots, and an older server without the split into Other bots too", () => {
    const report = storageReport({ bots: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `b${n}`, bytes: n * GB, files: 1 })), botsGone: undefined });
    const rows = storageBots(report, () => "Bot");
    expect(rows.map((row) => row.kind)).toEqual(["bot", "bot", "bot", "bot", "bot", "rest"]);
    expect(rows.at(-1)!.bytes).toBe(2 * GB + 3 * GB);
  });
});

describe("sizes", () => {
  it("reads in the person's own number format", () => {
    expect(storageSize(12.34 * GB, "en")).toBe("12.3 GB");
    expect(storageSize(512 * GB, "en")).toBe("512 GB");
    expect(storageSize(3.5 * 1024 ** 2, "de")).toBe("3,5 MB");
    expect(storageSize(900, "en")).toBe("1 kB");
  });
});
