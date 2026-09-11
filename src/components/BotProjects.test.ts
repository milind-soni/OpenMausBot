import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, type Bot } from "@/state/store";
import { BotProjectDialog, FolderActions, FolderIcon, NewThreadButton } from "./BotProjects";

vi.mock("react-dom", async (original) => ({ ...await original<object>(), createPortal: (children: unknown) => children }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (original) => ({
  ...await original<object>(),
  useStore: () => ({ dispatch }),
}));

const bot: Bot = {
  id: "maus", threadId: "current", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "mail", name: "Email", emoji: "📬" }],
  tasks: [{ threadId: "current", title: "Inbox", projectId: "mail", createdAt: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
});
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
  it("keeps New thread as one plain button without a folder dropdown", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(NewThreadButton, { bot })));
    expect(markup).toContain('title="New thread in Email"');
    expect(markup).not.toContain("aria-haspopup");
    expect(markup).not.toContain("Choose folder");
    expect(markup.match(/<button /g)).toHaveLength(1);
  });
  it.each([
    { projectId: "mail", expected: { type: "newTask", botId: "maus", projectId: "mail" } },
    { projectId: undefined, expected: { type: "newTask", botId: "maus" } },
    { projectId: "deleted", expected: { type: "newTask", botId: "maus" } },
  ])("creates one thread in the current valid folder ($projectId), then closes its picker", ({ projectId, expected }) => {
    const onCreated = vi.fn();
    const button = NewThreadButton({
      bot: { ...bot, tasks: [{ ...bot.tasks![0]!, projectId }] },
      compact: true,
      onCreated,
    });

    button.props.onClick();

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expected);
    expect(onCreated).toHaveBeenCalledOnce();
    expect(button.props["aria-label"]).toBe("New thread");
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(onCreated.mock.invocationCallOrder[0]!);
  });
  it("provides a keyboard-reachable actions menu without a hidden double-click gesture", () => {
    const markup = renderToStaticMarkup(createElement(FolderActions, {
      project: bot.projects![0]!, canMoveUp: false, canMoveDown: true, canMarkRead: true, saving: false,
      menu: null, onMenuChange: vi.fn(), onEdit: vi.fn(), onMove: vi.fn(), onMarkRead: vi.fn(),
    }));
    expect(markup).toContain('aria-label="Actions for Email folder"');
    expect(markup).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(markup).toContain("focus-visible:opacity-100");
  });
  it.each([
    { canMarkRead: true, saving: false, disabled: false },
    { canMarkRead: false, saving: false, disabled: true },
    { canMarkRead: true, saving: true, disabled: true },
  ])("offers a read-only folder action with canMarkRead=$canMarkRead and saving=$saving", ({ canMarkRead, saving, disabled }) => {
    const markup = renderToStaticMarkup(createElement(FolderActions, {
      project: { id: "archive", name: "Archived" }, canMoveUp: false, canMoveDown: false, canMarkRead, saving,
      menu: { left: 990, top: 790 }, onMenuChange: vi.fn(), onEdit: vi.fn(), onMove: vi.fn(), onMarkRead: vi.fn(),
    }));
    expect(markup).toContain('role="menu" aria-label="Actions for Archived folder"');
    expect(markup).toContain("left:772px;top:620px");
    const readButton = markup.match(/<button[^>]*>[^]*?Mark folder as read<\/button>/)?.[0]?.split("<button").at(-1);
    expect(readButton).toBeDefined();
    expect(readButton?.includes('disabled=""')).toBe(disabled);
    expect(readButton).toContain('role="menuitem"');
    expect(markup).not.toContain("Approve");
    expect(markup).not.toContain("Dismiss");
  });
});
