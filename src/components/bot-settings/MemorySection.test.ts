import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MemoryCapacity, MemoryFileInfo, MemoryJournalRow } from "@/lib/memory";

// DesktopCapabilities reads window.ogb at module scope, and this suite runs in the node environment.
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined, platform: "other" } } }),
}));

const { ConflictNotice, LendingReviewNotice, MemoryFileRows, MemoryGauge, MemoryJournalList, MemoryUpkeepCard } = await import("./MemorySection");

// renderToStaticMarkup HTML-escapes quotes and apostrophes; decode before comparing against plain-text fixtures.
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
    expect(markup).toContain("Only the first 200 lines load each turn");
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain("bg-accent");
    expect(markup).not.toContain("bg-danger");
  });

  it("turns red and says how many lines are not being loaded", () => {
    const markup = render(createElement(MemoryGauge, { index: index({ lines: 260, loadedLines: 200, truncated: true }) }));
    expect(markup).toContain("60 lines are not being loaded");
    expect(markup).toContain("Only the first 200 lines load each turn");
    expect(markup).toContain("bg-danger");
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
    expect(markup).toContain("3 minutes ago");
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
    expect(markup).toContain("3 minutes ago");
    expect(markup).toContain("from chat “Follow-up”");
    expect(markup).toContain("+2 −0 · show what changed");
    expect(markup).toContain("+one");
    expect(markup.match(/>Undo</g)).toHaveLength(1);
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

describe("MemoryUpkeepCard", () => {
  const noop = () => undefined;
  it("explains the switch and hides the tidy button while off", () => {
    const markup = render(createElement(MemoryUpkeepCard, { enabled: false, status: null, tidying: false, onToggle: noop, onTidy: noop }));
    expect(markup).toContain("Memory upkeep");
    expect(markup).toContain("you can remove any");
    expect(markup).not.toContain("Tidy up now");
  });

  it("shows the last tidy-up and says when the engine cannot run the model steps", () => {
    const markup = render(createElement(MemoryUpkeepCard, {
      enabled: true,
      status: { enabled: true, modelSteps: false, lastTidy: { at: Date.now() - 60_000, expired: 1, duplicates: 2, superseded: 0, deferred: 0, contradictionsChecked: false } },
      tidying: false,
      onToggle: noop,
      onTidy: noop,
    }));
    expect(markup).toContain("Tidy up now");
    expect(markup).toContain("archived 1 expired note, merged 2 duplicates");
    expect(markup).toContain("can't make the quick background model call");
    const noticed = render(createElement(MemoryUpkeepCard, { enabled: true, status: { enabled: true, modelSteps: true, lastCapture: { at: Date.now() - 60_000, added: 1, topics: 2, aboutMe: 1 } }, tidying: false, onToggle: noop, onTidy: noop }));
    expect(noticed).toContain("Last noticed 3 facts");
  });

  it("shows Learn from group chats beside upkeep, only while upkeep is on", () => {
    const rooms = { enabled: false, saving: false, error: "", onToggle: noop };
    const on = render(createElement(MemoryUpkeepCard, { enabled: true, status: null, tidying: false, onToggle: noop, onTidy: noop, rooms }));
    expect(on).toContain("Learn from group chats");
    expect(on).toContain("fewer people can see than the bot never feeds its memory");
    expect(on).toContain('aria-label="Learn from group chats"');
    const failed = render(createElement(MemoryUpkeepCard, { enabled: true, status: null, tidying: false, onToggle: noop, onTidy: noop, rooms: { ...rooms, error: "Could not save the group chat setting." } }));
    expect(failed).toContain('role="alert"');
    const off = render(createElement(MemoryUpkeepCard, { enabled: false, status: null, tidying: false, onToggle: noop, onTidy: noop, rooms }));
    expect(off).not.toContain("Learn from group chats");
  });

  it("says under Learn from group chats when this bot's engine can't make the background call, and only then", () => {
    const rooms = { enabled: true, saving: false, error: "", onToggle: noop };
    const line = "can't make the background model call this needs, so it won't learn anything from group chats";
    const cannot = render(createElement(MemoryUpkeepCard, { enabled: true, status: { enabled: true, modelSteps: false }, tidying: false, onToggle: noop, onTidy: noop, rooms }));
    expect(cannot).toContain(line);
    expect(cannot.indexOf(line)).toBeLessThan(cannot.indexOf("can't make the quick background model call upkeep uses"));
    expect(cannot).not.toContain("Claude and chat-model engines");
    const can = render(createElement(MemoryUpkeepCard, { enabled: true, status: { enabled: true, modelSteps: true }, tidying: false, onToggle: noop, onTidy: noop, rooms }));
    expect(can).toContain("Learn from group chats");
    expect(can).not.toContain(line);
    expect(can).not.toContain("can't make the quick background model call");
    const off = render(createElement(MemoryUpkeepCard, { enabled: true, status: { enabled: true, modelSteps: false }, tidying: false, onToggle: noop, onTidy: noop, rooms: { ...rooms, enabled: false } }));
    expect(off).toContain(line);
  });
});

describe("LendingReviewNotice", () => {
  const changed = ["MEMORY.md", "/srv/projects/site/CLAUDE.md"];
  it("says plainly why the bot cannot use the Mac, names what changed, and marks it reviewed in one click", () => {
    const onReviewed = vi.fn();
    const markup = render(createElement(LendingReviewNotice, { changed, stale: false, busy: false, onReviewed }));
    expect(markup).toContain("This bot's memory was changed in a conversation you didn't write, so it can't use your computer.");
    expect(markup).toContain("Changed:");
    for (const file of changed) expect(markup).toContain(`>${file}<`);
    expect(markup).toContain(">Mark reviewed<");
    const tree = LendingReviewNotice({ changed, stale: false, busy: false, onReviewed }) as { props: { children: Array<{ type: string; props: { onClick?: () => void } }> } };
    tree.props.children.find((child) => child.type === "button")!.props.onClick!();
    expect(onReviewed).toHaveBeenCalledOnce();
  });
  it("says so when the memory changed again after the owner looked", () => {
    const markup = render(createElement(LendingReviewNotice, { changed, stale: true, busy: false, onReviewed: vi.fn() }));
    expect(markup).toContain("The memory changed again after you looked");
  });
});
