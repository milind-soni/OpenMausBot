import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, type Bot } from "@/state/store";
import { BotProjectDialog, FolderActions, FolderIcon, NewThreadButton } from "./BotProjects";

vi.mock("react-dom", async (original) => ({ ...await original<object>(), createPortal: (children: unknown) => children }));

const bot: Bot = {
  id: "maus", threadId: "current", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "mail", name: "Email", emoji: "📬" }],
  tasks: [{ threadId: "current", title: "Inbox", projectId: "mail", createdAt: 1 }],
};

beforeEach(() => vi.stubGlobal("document", { body: {} }));
afterEach(() => vi.unstubAllGlobals());

describe("folder controls", () => {
  it("uses an optional decorative emoji with the generic folder as its default", () => {
    const generic = renderToStaticMarkup(createElement(FolderIcon, {}));
    expect(generic).toContain("lucide-folder");
    const emoji = renderToStaticMarkup(createElement(FolderIcon, { emoji: "📬" }));
    expect(emoji).toContain("📬");
    expect(emoji).toContain('aria-hidden="true"');
    expect(emoji).not.toContain("lucide-folder");
  });
  it("offers a labelled single-click icon chooser in both create and edit dialogs", () => {
    for (const project of [undefined, bot.projects![0]]) {
      const markup = renderToStaticMarkup(createElement(StoreProvider, null,
        createElement(BotProjectDialog, { bot, project, onClose: vi.fn() })));
      expect(markup).toContain('role="dialog" tabindex="-1" aria-modal="true"');
      expect(markup).toContain('aria-label="Choose folder icon"');
      expect(markup).toContain("Folder name");
      if (project) {
        expect(markup).toContain("📬");
        expect(markup).toContain("Save folder");
      } else expect(markup).toContain("Create folder");
    }
  });
  it("keeps quick New thread and the folder submenu as separately labelled controls", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(NewThreadButton, { bot })));
    expect(markup).toContain('title="New thread in Email"');
    expect(markup).toContain('aria-label="Choose folder for new thread" aria-haspopup="menu"');
    expect(markup.match(/<button /g)).toHaveLength(2);
  });
  it("provides a keyboard-reachable actions menu without a hidden double-click gesture", () => {
    const markup = renderToStaticMarkup(createElement(FolderActions, {
      project: bot.projects![0]!, canMoveUp: false, canMoveDown: true, saving: false, onEdit: vi.fn(), onMove: vi.fn(),
    }));
    expect(markup).toContain('aria-label="Actions for Email folder"');
    expect(markup).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(markup).toContain("focus-visible:opacity-100");
  });
});
