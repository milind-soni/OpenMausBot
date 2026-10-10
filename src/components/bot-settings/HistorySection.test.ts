import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import type { HistoryRow } from "./HistorySection";
import { HistorySection } from "./HistorySection";

const bot: Bot = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Scout",
  title: "Scout",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "local", model: "test-model" },
  messages: [],
};

const soulRow: HistoryRow = {
  id: "soul-row",
  at: 1700000000000,
  actor: "user",
  via: "ui",
  field: "soul",
  summary: "soul: 120 → 340 bytes",
  canRestore: true,
};

const titleRow: HistoryRow = {
  id: "title-row",
  at: 1700000100000,
  actor: "bot",
  via: "api",
  field: "title",
  summary: "Title changed",
  canRestore: false,
};

function render(rows: HistoryRow[] | null, onRollback = vi.fn()) {
  return renderToStaticMarkup(createElement(HistorySection, { bot, rows, onRollback }));
}

describe("HistorySection", () => {
  it("shows Loading… before rows arrive", () => {
    const markup = render(null);
    expect(markup).toContain("Loading…");
  });

  it("shows the empty state when there are no rows", () => {
    const markup = render([]);
    expect(markup).toContain("No changes recorded yet.");
  });

  it("renders each row's actor, via, and summary", () => {
    const markup = render([soulRow, titleRow]);
    expect(markup).toContain("user");
    expect(markup).toContain("ui");
    expect(markup).toContain("soul: 120 → 340 bytes");
    expect(markup).toContain("bot");
    expect(markup).toContain("api");
    expect(markup).toContain("Title changed");
  });

  it("shows an Undo button only on soul rows", () => {
    const markup = render([soulRow, titleRow]);
    expect(markup).toContain("Undo this change");
    // Only one Undo button should appear — the soul row's.
    expect(markup.match(/Undo this change/g)?.length).toBe(1);
  });

  it("omits the Undo button entirely when no row is a soul row", () => {
    const markup = render([titleRow]);
    expect(markup).not.toContain("Undo this change");
  });

  it("explains why redacted instructions cannot be restored, without offering Undo", () => {
    const reason = "This version is missing exact text or contains redacted sensitive text and cannot be restored.";
    const markup = render([{ ...soulRow, canRestore: false, restoreUnavailableReason: reason }]);
    expect(markup).not.toContain("Undo this change");
    expect(markup).toContain(reason);
  });

  it("fails closed if an older server omits restoration eligibility", () => {
    const { canRestore: _canRestore, ...legacyRow } = soulRow;
    const markup = render([legacyRow]);
    expect(markup).not.toContain("Undo this change");
    expect(markup).toContain("The exact previous instructions are unavailable");
  });

  it("orders rows newest first regardless of input order", () => {
    const markup = render([soulRow, titleRow]);
    expect(markup.indexOf("Title changed")).toBeLessThan(markup.indexOf("soul: 120"));
  });

  it("disables undo while a rollback is in progress", () => {
    const markup = renderToStaticMarkup(createElement(HistorySection, {
      bot, rows: [soulRow], onRollback: vi.fn(), rollingBack: true,
    }));
    expect(markup).toContain('disabled=""');
  });
});
