import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MemoryCapacity, MemoryFileInfo, MemoryJournalRow } from "@/lib/memory";

// DesktopCapabilities reads `window.ogb` at module scope for its context
// default; the src suite runs under vitest's "node" environment (no
// window), so it is stubbed the way AccessSection.test.ts does.
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined, platform: "other" } } }),
}));

const { ConflictNotice, MemoryFileRows, MemoryGauge, MemoryJournalList } = await import("./MemorySection");

// renderToStaticMarkup HTML-escapes quotes and apostrophes; decode before
// comparing against plain-text fixtures.
function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

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

describe("MemoryGauge", () => {
  it("always carries the plain sentence about what loads", () => {
    const markup = render(createElement(MemoryGauge, { index: index() }));
    expect(markup).toContain("only the first 200 lines load each turn");
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain("bg-accent");
    expect(markup).not.toContain("bg-danger");
  });

  it("turns red and says how many lines are not being loaded", () => {
    const markup = render(createElement(MemoryGauge, { index: index({ lines: 260, loadedLines: 200, truncated: true }) }));
    expect(markup).toContain("60 lines are not being loaded");
    expect(markup).toContain("only the first 200 lines load each turn");
    expect(markup).toContain("bg-danger");
    // the bar never overflows its track
    expect(markup).toContain('aria-valuenow="100"');
  });
});

describe("ConflictNotice", () => {
  it("names the bot, promises nothing was saved, and offers both ways out", () => {
    const markup = render(createElement(ConflictNotice, { botName: "Scout", busy: false, onReload: vi.fn(), onOverwrite: vi.fn() }));
    expect(markup).toContain("Scout changed this file while you were editing.");
    expect(markup).toContain("Nothing has been saved.");
    expect(markup).toContain(">Reload<");
    expect(markup).toContain(">Overwrite with mine<");
  });
});

describe("MemoryFileRows", () => {
  const files: MemoryFileInfo[] = [
    { path: "memory/clients.md", name: "clients.md", bytes: 120, modifiedAt: Date.now() - 3 * 60_000 },
  ];

  it("lists files with size and age, and a delete control per row", () => {
    const markup = render(createElement(MemoryFileRows, { title: "Topic files", hint: "hint", files, onOpen: vi.fn(), onDelete: vi.fn() }));
    expect(markup).toContain("clients.md");
    expect(markup).toContain("120 B");
    expect(markup).toContain("3 min ago");
    expect(markup).toContain('aria-label="Delete clients.md"');
  });

  it("says None yet for an empty list", () => {
    expect(render(createElement(MemoryFileRows, { title: "Daily logs", hint: "", files: [], onOpen: vi.fn(), onDelete: vi.fn() }))).toContain("None yet.");
  });
});

describe("MemoryJournalList", () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  const rows: MemoryJournalRow[] = [
    {
      id: "r1",
      at: now - 3 * 60_000,
      botId: "b1",
      path: "MEMORY.md",
      actor: "bot",
      via: "turn",
      threadId: "t1",
      threadTitle: "Follow-up",
      kind: "edited",
      beforeHash: "a",
      afterHash: "b",
      diff: "--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,0 +1,2 @@\n+one\n+two",
      added: 2,
      removed: 0,
      canRevert: true,
    },
    {
      id: "r2",
      at: now - 26 * 3_600_000,
      botId: "b1",
      path: "memory/keys.md",
      actor: "bot",
      via: "turn",
      kind: "edited",
      beforeHash: "c",
      afterHash: "d",
      diff: "",
      added: 1,
      removed: 1,
      canRevert: false,
      revertUnavailableReason: "The earlier version contained sensitive text that was hidden, so it cannot be restored exactly.",
    },
  ];

  it("shows Loading… and the empty state", () => {
    expect(render(createElement(MemoryJournalList, { rows: null, botName: "Scout", reverting: null, onRevert: vi.fn() }))).toContain("Loading…");
    expect(render(createElement(MemoryJournalList, { rows: [], botName: "Scout", reverting: null, onRevert: vi.fn() }))).toContain("No changes recorded yet.");
  });

  it("reads each row as a sentence with the chat it came from, and offers Undo", () => {
    const markup = render(createElement(MemoryJournalList, { rows, botName: "Scout", reverting: null, onRevert: vi.fn(), now }));
    expect(markup).toContain("Scout added 2 lines to MEMORY.md");
    expect(markup).toContain("3 min ago");
    expect(markup).toContain("from chat “Follow-up”");
    expect(markup).toContain("+2 −0 · show what changed");
    expect(markup).toContain("+one");
    expect(markup.match(/>Undo</g)).toHaveLength(1);
    // the redacted row explains itself instead of offering an Undo it cannot honour
    expect(markup).toContain("Can't undo");
    expect(markup).toContain("sensitive text that was hidden");
    expect(markup).toContain("Scout rewrote 1 line in the keys topic");
    expect(markup).toContain("yesterday");
  });

  it("marks the row being undone", () => {
    const markup = render(createElement(MemoryJournalList, { rows, botName: "Scout", reverting: "r1", onRevert: vi.fn(), now }));
    expect(markup).toContain("Undoing…");
  });
});
