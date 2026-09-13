import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { ArchivedBotRow, archivedDeleteAllCopy } from "./Sidebar";

const waffle = (): Bot => ({
  id: "waffle",
  threadId: "thread-waffle",
  name: "Waffle",
  title: "Archived baker",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  hidden: true,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
});

describe("ArchivedBotRow", () => {
  it("offers Restore and a permanent Delete next to each archived bot", () => {
    const markup = renderToStaticMarkup(createElement(ArchivedBotRow, {
      bot: waffle(),
      restoring: false,
      deleting: false,
      disabled: false,
      onRestore: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain(">Restore</button>");
    expect(markup).toContain('aria-label="Delete Waffle"');
    expect(markup).toContain(">Delete</button>");
    expect(markup).toContain("text-danger");
  });

  it("spells out that Delete all permanently removes every archived bot", () => {
    const copy = archivedDeleteAllCopy();
    expect(copy.title).toBe("Delete all archived bots?");
    expect(copy.body).toMatch(/permanently/i);
    expect(copy.confirmLabel).toBe("Delete all");
    expect(copy.tone).toBe("danger");
  });

  it("locks restore and delete while a deletion is in flight", () => {
    const markup = renderToStaticMarkup(createElement(ArchivedBotRow, {
      bot: waffle(),
      restoring: false,
      deleting: true,
      disabled: true,
      onRestore: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain("animate-spin");
    expect(markup).toContain(">Restore</button>");
    expect(markup).toContain(">Delete</button>");
  });
});
