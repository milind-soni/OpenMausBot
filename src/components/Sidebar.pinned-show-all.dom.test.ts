// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";
import { forgetSidebarShowAllForTests, SIDEBAR_SHOW_ALL_KEY } from "@/lib/sidebar-preferences";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));

const { BotThreadList, botRowProps } = await import("./Sidebar");
const { SidebarBotActivity } = await import("./SidebarBotActivity");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Nine loose threads: the short list keeps six, so the oldest are hidden until "Show all".
const loose = Array.from({ length: 9 }, (_, index) => ({ threadId: `loose-${index}`, title: `Loose chat ${index}`, createdAt: 100 + index }));
const filed = [
  { threadId: "filed-pinned", title: "Filed pinned", createdAt: 1_000, projectId: "folder", pinned: true },
  { threadId: "filed-plain", title: "Filed plain", createdAt: 1_001, projectId: "folder" },
];
const bot: Bot = {
  id: "maus", threadId: "loose-8", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "folder", name: "Taxes" }],
  tasks: [...loose, ...filed],
};

let host: HTMLElement;
let root: Root;
const mount = async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(BotThreadList, { ...botRowProps(initialState, vi.fn(), bot, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true }));
  });
};
const unmount = async () => {
  await act(async () => { root.unmount(); });
  host.remove();
};
const button = (label: string) => [...host.querySelectorAll("button")]
  .find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
const click = async (label: string) => {
  const target = button(label);
  expect(target, label).toBeTruthy();
  await act(async () => { target!.click(); });
};
const saved = () => JSON.parse(localStorage.getItem(SIDEBAR_SHOW_ALL_KEY) ?? "[]");

beforeEach(() => {
  localStorage.clear();
  forgetSidebarShowAllForTests();
});
afterEach(() => { document.body.innerHTML = ""; });

describe("a bot's Show all threads", () => {
  it("stays on after the list unmounts (bot collapsed or app reloaded) until Show fewer", async () => {
    await mount();
    expect(host.textContent).not.toContain("Loose chat 0");
    await click("Show all 11 threads");
    expect(host.textContent).toContain("Loose chat 0");
    await unmount();

    forgetSidebarShowAllForTests(); // read it back from storage, as a reload would
    expect(saved()).toEqual(["maus"]);
    await mount();
    expect(host.textContent).toContain("Loose chat 0");
    expect(button("Show all 11 threads")).toBeUndefined();

    await click("Show fewer threads");
    expect(host.textContent).not.toContain("Loose chat 0");
    expect(button("Show all 11 threads")).toBeTruthy();
    expect(saved()).toEqual([]);
    await unmount();
  });

  it("reads a change another window saved while no list was showing", async () => {
    await mount();
    await click("Show all 11 threads");
    await unmount();

    localStorage.setItem(SIDEBAR_SHOW_ALL_KEY, "[]"); // another window picked Show fewer meanwhile
    await mount();
    expect(host.textContent).not.toContain("Loose chat 0");
    expect(button("Show all 11 threads")).toBeTruthy();
    await unmount();
  });
});

describe("a bot's main thread", () => {
  const marked = () => [...host.querySelectorAll("[data-main-thread-mark]")].map((mark) => mark.closest("[data-sidebar-thread-row]")?.getAttribute("data-sidebar-thread-row"));

  it("is marked in the thread list and stays listed when it is older than the short list", async () => {
    bot.mainThreadId = "loose-0";
    await mount();
    expect(marked()).toEqual(["loose-0"]);
    const mark = host.querySelector("[data-main-thread-mark]")!;
    expect([mark.getAttribute("role"), mark.getAttribute("aria-label"), mark.textContent]).toEqual(["img", "Main thread", "Main"]);
    expect(host.textContent).not.toContain("Loose chat 1");
    await unmount();
    delete bot.mainThreadId;
    await mount();
    expect(marked()).toEqual([]);
    await unmount();
  });

  it("leads the list, above folders and pinned threads, folded or showing all, and is listed once", async () => {
    const rows = () => [...host.querySelectorAll("[data-sidebar-thread-row]")].map((row) => row.getAttribute("data-sidebar-thread-row"));
    bot.mainThreadId = "loose-0";
    await mount();
    expect(rows().slice(0, 3)).toEqual(["loose-0", "filed-pinned", "filed-plain"]);
    await click("Show all 11 threads");
    expect(rows()[0]).toBe("loose-0");
    expect(rows().filter((id) => id === "loose-0")).toHaveLength(1);
    expect(rows()).toHaveLength(11);
    await unmount();
    forgetSidebarShowAllForTests();
    localStorage.clear();
    bot.mainThreadId = "filed-plain";
    await mount();
    expect(rows().slice(0, 2)).toEqual(["filed-plain", "filed-pinned"]);
    expect(rows().filter((id) => id === "filed-plain")).toHaveLength(1);
    await click("Collapse Taxes threads");
    expect(rows().slice(0, 2)).toEqual(["filed-plain", "filed-pinned"]);
    await unmount();
    delete bot.mainThreadId;
  });

  it("leaves its folder where the folder's other threads put it", async () => {
    const folders = () => [...host.querySelectorAll("[data-sidebar-folder-row]")].map((row) => row.getAttribute("data-sidebar-folder-row"));
    const before = { projects: bot.projects, tasks: bot.tasks };
    bot.projects = [...bot.projects!, { id: "later", name: "Later" }];
    bot.tasks = [...bot.tasks!, { threadId: "later-pinned", title: "Later pinned", createdAt: 2_000, projectId: "later", pinned: true }];
    bot.mainThreadId = "later-pinned";
    await mount();
    expect(folders()).toEqual(["folder", "later"]);
    await unmount();
    Object.assign(bot, before);
    delete bot.mainThreadId;
  });

  it("is marked on a collapsed bot's row for it", () => {
    const html = renderToStaticMarkup(createElement(SidebarBotActivity, {
      bot: { ...bot, mainThreadId: "filed-pinned" }, rowThreadId: bot.threadId, density: "comfortable", pendingQueued: {}, dispatch: vi.fn(),
    }));
    expect(html.match(/data-main-thread-mark/g)).toHaveLength(1);
  });
});

describe("a collapsed folder", () => {
  it("keeps showing its pinned threads and hides the rest", async () => {
    await mount();
    expect(host.textContent).toContain("Filed plain");
    await click("Collapse Taxes threads");
    expect(host.textContent).toContain("Filed pinned");
    expect(host.textContent).not.toContain("Filed plain");
    await unmount();
  });
});

describe("a collapsed bot's pinned thread", () => {
  it("is marked pinned, not unread, when nothing is going on in it", () => {
    const html = renderToStaticMarkup(createElement(SidebarBotActivity, {
      bot, rowThreadId: bot.threadId, density: "comfortable", pendingQueued: {}, dispatch: vi.fn(),
    }));
    expect(html).toContain('aria-label="Maus: Filed pinned · Pinned"');
    expect(html).not.toContain("Unread");
  });
});
