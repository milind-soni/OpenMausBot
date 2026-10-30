import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));

const { BotThreadList, botRowProps } = await import("./Sidebar");

// The short thread list keeps the six newest open threads, across folders and loose ones.
const loose = Array.from({ length: 7 }, (_, index) => ({ threadId: `loose-${index}`, title: `Loose chat ${index}`, createdAt: 100 + index }));
const bot = (filed: NonNullable<Bot["tasks"]>): Bot => ({
  id: "maus", threadId: "loose-6", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "folder", name: "Taxes" }],
  tasks: [...loose, ...filed],
});
const render = (value: Bot, query = "") => renderToStaticMarkup(createElement(BotThreadList, {
  ...botRowProps(initialState, vi.fn(), value, { density: "comfortable", quiet: false, query, onMenu: vi.fn() }), selected: true,
}));

describe("an open folder whose threads are older than the short list", () => {
  const older = [
    { threadId: "filed-1", title: "Filed chat 1", createdAt: 1, projectId: "folder" },
    { threadId: "filed-2", title: "Filed chat 2", createdAt: 2, projectId: "folder" },
  ];

  it("offers Show all inside the folder instead of showing nothing", () => {
    const html = render(bot(older));
    expect(html).not.toContain("Filed chat");
    expect(html).toContain('data-sidebar-folder-show-all="folder"');
  });

  it("does not offer it when every thread in the folder is already listed", () => {
    const html = render(bot([{ threadId: "filed-new", title: "Filed new", createdAt: 1_000, projectId: "folder" }]));
    expect(html).toContain("Filed new");
    expect(html).not.toContain("data-sidebar-folder-show-all");
  });

  it("does not offer it while searching, which already lists every match", () => {
    expect(render(bot(older), "Filed")).not.toContain("data-sidebar-folder-show-all");
  });
});
