import { describe, expect, it } from "vitest";

import {
  capacityStatus,
  fileManagerLabel,
  formatBytes,
  journalSource,
  journalSummary,
  relativeTime,
  topicFileName,
  type MemoryCapacity,
  type MemoryJournalRow,
} from "./memory";

const index = (overrides: Partial<MemoryCapacity> = {}): MemoryCapacity => ({
  lines: 40,
  bytes: 2_000,
  maxLines: 200,
  maxBytes: 24_000,
  loadedLines: 40,
  loadedBytes: 2_000,
  truncated: false,
  hash: "h",
  ...overrides,
});

const row = (overrides: Partial<MemoryJournalRow> = {}): MemoryJournalRow => ({
  id: "r1",
  at: 0,
  botId: "b1",
  path: "MEMORY.md",
  actor: "bot",
  via: "turn",
  kind: "edited",
  beforeHash: "a",
  afterHash: "b",
  diff: "",
  added: 2,
  removed: 0,
  canRevert: true,
  ...overrides,
});

describe("capacityStatus", () => {
  it("always says the plain sentence about what loads", () => {
    const status = capacityStatus(index());
    expect(status.level).toBe("ok");
    expect(status.sentence).toBe("40 of 200 lines · 2 KB of 23.4 KB — only the first 200 lines load each turn.");
    expect(status.warning).toBeNull();
    expect(status.lineShare).toBeCloseTo(0.2);
  });

  it("turns amber at 80% of either budget", () => {
    expect(capacityStatus(index({ lines: 160 })).level).toBe("near");
    expect(capacityStatus(index({ bytes: 20_000 })).level).toBe("near");
    expect(capacityStatus(index({ lines: 159, bytes: 19_000 })).level).toBe("ok");
  });

  it("goes red when truncated and says exactly how much is not loading", () => {
    const status = capacityStatus(index({ lines: 260, loadedLines: 200, truncated: true }));
    expect(status.level).toBe("over");
    expect(status.warning).toBe(
      "260 lines saved, 200 load into every conversation — 60 lines are not being loaded. Trim this file or move notes into a topic file.",
    );
    expect(capacityStatus(index({ lines: 201, loadedLines: 200, truncated: true })).warning).toContain("1 line is not being loaded");
  });

  it("explains a byte cut when the line count fits", () => {
    const status = capacityStatus(index({ lines: 10, bytes: 30_000, loadedBytes: 24_000, truncated: true }));
    expect(status.level).toBe("over");
    expect(status.warning).toContain("29.3 KB saved, 23.4 KB load into every conversation — the rest is not being loaded");
  });

  it("does not divide by a zero budget", () => {
    expect(capacityStatus(index({ maxLines: 0, maxBytes: 0 })).lineShare).toBe(0);
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  it.each([
    [10_000, "just now"],
    [3 * 60_000, "3 min ago"],
    [59 * 60_000, "59 min ago"],
    [2 * 3_600_000, "2 hr ago"],
    [26 * 3_600_000, "yesterday"],
    [3 * 86_400_000, "3 days ago"],
  ])("%d ms ago reads %s", (ago, label) => {
    expect(relativeTime(now - ago, now)).toBe(label);
  });

  it("falls back to a date past a week and never goes negative", () => {
    expect(relativeTime(now - 10 * 86_400_000, now)).toMatch(/Aug|Sep/);
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("journalSummary", () => {
  it("reads as a sentence about who did what to which file", () => {
    expect(journalSummary(row(), "Scout")).toBe("Scout added 2 lines to MEMORY.md");
    expect(journalSummary(row({ added: 1 }), "Scout")).toBe("Scout added 1 line to MEMORY.md");
    expect(journalSummary(row({ added: 0, removed: 3, actor: "person", via: "ui" }), "Scout")).toBe("You removed 3 lines from MEMORY.md");
    expect(journalSummary(row({ added: 2, removed: 1 }), "Scout")).toBe("Scout rewrote 2 lines in MEMORY.md");
    expect(journalSummary(row({ path: "memory/clients.md", kind: "created", added: 4, beforeHash: null }), "Scout")).toBe(
      "Scout created the clients topic with 4 lines",
    );
    expect(journalSummary(row({ path: "memory/clients.md", kind: "deleted", afterHash: null, actor: "person", via: "ui" }), "Scout")).toBe(
      "You deleted the clients topic",
    );
    expect(journalSummary(row({ path: "memory/log/2026-09-10.md", kind: "created", added: 1 }), "Scout")).toBe(
      "Scout created the 2026-09-10 log with 1 line",
    );
    expect(journalSummary(row({ actor: "import" }), "Scout")).toBe("An import added 2 lines to MEMORY.md");
  });
});

describe("journalSource", () => {
  it("names where the change came from", () => {
    expect(journalSource(row({ threadTitle: "Follow-up" }))).toBe("from chat “Follow-up”");
    expect(journalSource(row())).toBe("during a task");
    expect(journalSource(row({ actor: "person", via: "ui" }))).toBe("in Settings");
    expect(journalSource(row({ actor: "person", via: "api" }))).toBe("through the API");
    expect(journalSource(row({ actor: "person", via: "disk" }))).toBe("changed outside the app");
    expect(journalSource(row({ actor: "person", via: "revert" }))).toBe("undo");
    expect(journalSource(row({ actor: "import", via: "import" }))).toBeNull();
  });
});

describe("small helpers", () => {
  it("labels the file manager by platform", () => {
    expect(fileManagerLabel("darwin")).toBe("Show in Finder");
    expect(fileManagerLabel("win32")).toBe("Show in Explorer");
    expect(fileManagerLabel("linux")).toBe("Show in file manager");
    expect(fileManagerLabel(undefined)).toBe("Show in file manager");
  });

  it("formats bytes the way the rest of settings does", () => {
    expect(formatBytes(120)).toBe("120 B");
    expect(formatBytes(2_048)).toBe("2 KB");
  });

  it("turns a typed topic name into a file name the server accepts", () => {
    expect(topicFileName("clients")).toBe("clients.md");
    expect(topicFileName("  Big Clients  ")).toBe("Big Clients.md");
    expect(topicFileName("notes.md")).toBe("notes.md");
    expect(topicFileName("a/b\\c")).toBe("a-b-c.md");
    expect(topicFileName("../evil")).toBe("evil.md");
    expect(topicFileName("   ")).toBeNull();
    expect(topicFileName("..")).toBeNull();
  });
});
