import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return {
    advanced: false,
    threadsChosen: true,
    menus: [] as { ariaLabel: string; items: SidebarMenuItem[]; placement?: string; openOnHover?: boolean; trigger: string }[],
    dispatch: vi.fn(),
    inspectorOpen: false,
    find: vi.fn(),
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, inspectorOpen: fixture.inspectorOpen }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.advanced && fixture.threadsChosen }));
vi.mock("@/lib/chat-find", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/chat-find")>(),
  requestChatFind: fixture.find,
}));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { ariaLabel: string; items: SidebarMenuItem[]; placement?: string; openOnHover?: boolean; renderTrigger: (state: { open: boolean }) => React.ReactNode }) => {
    const trigger = props.renderTrigger({ open: false });
    fixture.menus.push({ ...props, trigger: renderToStaticMarkup(createElement("div", null, trigger)) });
    return trigger;
  },
}));

const { ChatMoreMenu, ChatHeaderMenu } = await import("./ChatMoreMenu");
afterAll(() => vi.unstubAllGlobals());

const task = (threadId: string, title: string, at: number, extra: Partial<Task> = {}): Task => ({
  threadId, title, createdAt: at, busy: false, activity: "idle", ...extra,
});
const bot: Bot = {
  id: "pepper", threadId: "side", mainThreadId: "main", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, activeLeafId: "hi",
  messages: [{ id: "hi", role: "bot", kind: "text", text: "Hello", at: 1 }],
  modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    task("main", "Our chat", 1),
    task("side", "Trip plan", 3),
    task("routine", "Morning digest", 5, { routineRunId: "run-1" }),
    task("old", "", 2),
  ],
};

function menuOf(element: ReturnType<typeof createElement>) {
  fixture.menus = [];
  renderToStaticMarkup(element);
  return fixture.menus.at(-1)!;
}
const keys = (items: SidebarMenuItem[]) => items.map((item) => item.key);

beforeEach(() => {
  fixture.advanced = false;
  fixture.threadsChosen = true;
  fixture.inspectorOpen = false;
  fixture.dispatch.mockClear();
  fixture.find.mockClear();
});

describe("ChatMoreMenu, the round ⋯ for the bot panel", () => {
  it("is a round 32px button labelled More", () => {
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    expect(menu.ariaLabel).toBe("More");
    expect(menu.placement).toBeUndefined();
    expect(menu.trigger).toContain('data-testid="chat-more"');
    expect(menu.trigger).toMatch(/class="[^"]*\bsize-8\b[^"]*\brounded-full\b[^"]*\bbg-raised\/50\b/);
  });

  it("offers threads in Simple mode, and Usage and the Inspector unlocked", () => {
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    expect(keys(menu.items)).toEqual(["find", "new-thread", "threads", "copy", "download", "activity", "inspector"]);
    for (const item of menu.items) {
      expect(item.disabled, item.key).toBeFalsy();
      expect(item.heading ?? "", item.key).not.toBe("In Advanced mode");
    }
    expect(menu.items.find((item) => item.key === "new-thread")).toMatchObject({ label: "New thread", heading: "Threads", separatorBefore: true });
    expect(menu.items.find((item) => item.key === "inspector")?.separatorBefore).toBe(false);
  });

  it("starts a new thread with the bot", () => {
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    menu.items.find((item) => item.key === "new-thread")!.onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newTask", botId: "pepper" });
  });

  it("lists the bot's threads newest first, without routine runs, marks the open one and opens another", () => {
    const threads = menuOf(createElement(ChatMoreMenu, { bot })).items.find((item) => item.key === "threads")!;
    expect(threads).toMatchObject({ label: "All threads", value: "3" });
    expect(threads.submenu!.map((item) => [item.label, Boolean(item.active)])).toEqual([
      ["Trip plan", true],
      ["New thread", false],
      ["Our chat", false],
    ]);
    threads.submenu![2].onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "pepper", threadId: "main" });
  });

  it("lists every thread, however many there are", () => {
    const many = { ...bot, tasks: Array.from({ length: 20 }, (_, i) => task(`t${i}`, `Thread ${i}`, i)) };
    const threads = menuOf(createElement(ChatMoreMenu, { bot: many })).items.find((item) => item.key === "threads")!;
    expect(threads.value).toBe("20");
    expect(threads.submenu!.map((item) => item.label)).toEqual(Array.from({ length: 20 }, (_, i) => `Thread ${19 - i}`));
  });

  it("leaves All threads out while the bot has one thread", () => {
    const single = { ...bot, threadId: "main", tasks: [task("main", "Our chat", 1), task("routine", "Morning digest", 5, { routineRunId: "run-1" })] };
    expect(keys(menuOf(createElement(ChatMoreMenu, { bot: single })).items)).toEqual(["find", "new-thread", "copy", "download", "activity", "inspector"]);
    expect(keys(menuOf(createElement(ChatMoreMenu, { bot: { ...bot, tasks: undefined } })).items)).not.toContain("threads");
  });

  it("opens the chat's find bar for the thread on screen", () => {
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    menu.items.find((item) => item.key === "find")!.onSelect();
    expect(fixture.find).toHaveBeenCalledWith("side");
  });

  it("shows Usage when the thread has some, and opens the inspector from Simple mode", () => {
    fixture.inspectorOpen = true;
    const withUsage: Bot = { ...bot, tasks: bot.tasks!.map((entry) => entry.threadId === "side"
      ? { ...entry, usage: { input: 1200, output: 300, costUsd: null, turns: 2 } }
      : entry) };
    const menu = menuOf(createElement(ChatMoreMenu, { bot: withUsage }));
    const usage = menu.items.find((item) => item.key === "usage");
    expect(usage?.disabled).toBeFalsy();
    expect(usage?.heading).toBeUndefined();
    const inspector = menu.items.find((item) => item.key === "inspector")!;
    expect(inspector.active).toBe(true);
    inspector.onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleInspector" });
    expect(menu.trigger).toContain("text-accent");
  });
});

describe("ChatHeaderMenu, Advanced mode's header ⋯", () => {
  it("keeps main's items, trigger and hover menu below the header", () => {
    fixture.advanced = true;
    const menu = menuOf(createElement(ChatHeaderMenu, { bot }));
    expect(keys(menu.items)).toEqual(["find", "copy", "download", "activity", "inspector"]);
    expect(menu.items.find((item) => item.key === "inspector")).toMatchObject({ separatorBefore: true });
    expect(menu.items.every((item) => !item.disabled && item.heading !== "In Advanced mode")).toBe(true);
    expect(menu).toMatchObject({ placement: "below", openOnHover: true });
    expect(menu.trigger).toMatch(/data-testid="chat-more" class="flex rounded-md p-1.5 hover:bg-raised/);
  });

  it("has no thread items even if rendered by ChatMoreMenu in Advanced mode", () => {
    fixture.advanced = true;
    expect(keys(menuOf(createElement(ChatMoreMenu, { bot })).items)).not.toContain("threads");
  });

  it("lists the threads when the Threads setting hides them from the sidebar", () => {
    fixture.advanced = true;
    fixture.threadsChosen = false;
    const items = menuOf(createElement(ChatHeaderMenu, { bot })).items;
    expect(keys(items)).toEqual(expect.arrayContaining(["new-thread", "threads"]));
    expect(items.find((item) => item.key === "threads")!.submenu).toHaveLength(3);
  });
});
