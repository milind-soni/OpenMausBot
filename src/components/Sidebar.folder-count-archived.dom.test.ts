// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";
import { forgetSidebarShowAllForTests } from "@/lib/sidebar-preferences";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));

const { BotThreadList, botRowProps } = await import("./Sidebar");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeBot = (tasks: NonNullable<Bot["tasks"]>, threadId = "open-main"): Bot => ({
  id: "maus", threadId, name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "taxes", name: "Taxes" }],
  tasks,
});

let host: HTMLElement;
let root: Root;
const mount = async (candidate: Bot) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(BotThreadList, { ...botRowProps(initialState, vi.fn(), candidate, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true }));
  });
};
const unmount = async () => {
  await act(async () => { root.unmount(); });
  host.remove();
};
const folderCount = () => host.querySelectorAll('[data-sidebar-folder-label="taxes"] > span')[1]?.textContent;

beforeEach(() => {
  localStorage.clear();
  forgetSidebarShowAllForTests();
});
afterEach(() => { document.body.innerHTML = ""; });

describe("folder header count with archived threads", () => {
  it("shows 0 when a folder holds only hidden archived threads, offers Show all, and shows 2 once Show all is enabled", async () => {
    await mount(makeBot([
      { threadId: "open-main", title: "Main chat", createdAt: 10 },
      { threadId: "arch-1", title: "Q1 filing", createdAt: 5, projectId: "taxes", archivedAt: 20 },
      { threadId: "arch-2", title: "Q2 filing", createdAt: 6, projectId: "taxes", archivedAt: 25 },
    ]));

    expect(folderCount()).toBe("0");
    expect(host.querySelector('[data-sidebar-project="taxes"] [data-sidebar-thread-row]')).toBeNull();
    expect(host.querySelector('[data-sidebar-project="taxes"]')?.textContent).not.toContain("No threads yet");
    const showAll = host.querySelector<HTMLButtonElement>('[data-sidebar-folder-show-all="taxes"]');
    expect(showAll).not.toBeNull();

    await act(async () => {
      showAll!.click();
    });
    expect(folderCount()).toBe("2");
    expect(host.querySelectorAll('[data-sidebar-project="taxes"] [data-sidebar-thread-row]')).toHaveLength(2);
    await unmount();
  });

  it("counts only open threads plus an open-in-chat archived thread while Show all is off", async () => {
    await mount(makeBot([
      { threadId: "open-main", title: "Main chat", createdAt: 10 },
      { threadId: "open-filed", title: "Current return", createdAt: 9, projectId: "taxes" },
      { threadId: "arch-1", title: "Old return", createdAt: 5, projectId: "taxes", archivedAt: 20 },
    ]));
    expect(folderCount()).toBe("1");
    await unmount();

    await mount(makeBot([
      { threadId: "open-main", title: "Main chat", createdAt: 10 },
      { threadId: "arch-active", title: "Viewing archived return", createdAt: 8, projectId: "taxes", archivedAt: 20 },
    ], "arch-active"));
    expect(folderCount()).toBe("1");
    expect(host.querySelectorAll('[data-sidebar-project="taxes"] [data-sidebar-thread-row]')).toHaveLength(1);
    await unmount();
  });
});
