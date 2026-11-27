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
    run: vi.fn(),
    inspectorOpen: false,
    find: vi.fn(),
    team: false,
    open: vi.fn(),
    ownerOrAdmin: null as boolean | null,
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, inspectorOpen: fixture.inspectorOpen, ...(fixture.team ? { config: { ...original.initialState.config, team: { id: "acme", name: "Acme" } } } : {}) }, dispatch: fixture.dispatch }) };
});
vi.mock("./conversation-share/conversation-share", async (importOriginal) => ({
  ...await importOriginal<typeof import("./conversation-share/conversation-share")>(),
  openConversationDialog: fixture.open,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.advanced && fixture.threadsChosen }));
vi.mock("@/lib/chat-find", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/chat-find")>(),
  requestChatFind: fixture.find,
}));
vi.mock("./ContextWarning", () => ({ useContextAction: () => ({ pending: false, run: fixture.run }) }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { ariaLabel: string; items: SidebarMenuItem[]; placement?: string; openOnHover?: boolean; renderTrigger: (state: { open: boolean }) => React.ReactNode }) => {
    const trigger = props.renderTrigger({ open: false });
    fixture.menus.push({ ...props, trigger: renderToStaticMarkup(createElement("div", null, trigger)) });
    return trigger;
  },
}));

const { ChatMoreMenu, ChatHeaderMenu, ChatShareMenu } = await import("./ChatMoreMenu");
const { rememberLimits } = await import("@/lib/limit-resets");
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
  fixture.team = false;
  fixture.ownerOrAdmin = null;
  fixture.open.mockClear();
  fixture.dispatch.mockClear();
  fixture.find.mockClear();
});

describe("ChatMoreMenu, the round ⋯ for the bot panel", () => {
  it("is a round 36px button labelled More, on the raised surface in Simple mode", () => {
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    expect(menu.ariaLabel).toBe("More");
    expect(menu.placement).toBeUndefined();
    expect(menu.trigger).toContain('data-testid="chat-more"');
    expect(menu.trigger).toMatch(/class="[^"]*\bsize-9\b[^"]*\brounded-full\b[^"]*\bbg-composer\b[^"]*\bring-inset\b/);
    fixture.advanced = true;
    expect(menuOf(createElement(ChatMoreMenu, { bot })).trigger).toMatch(/class="[^"]*\bsize-9\b[^"]*\brounded-full\b[^"]*\bbg-raised\/50\b/);
  });

  it("offers threads in Simple mode, and Usage and the Inspector unlocked", () => {
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    expect(keys(menu.items)).toEqual(["find", "new-thread", "threads", "start-fresh", "publish", "copy", "download", "activity", "inspector"]);
    for (const item of menu.items) {
      expect(item.disabled, item.key).toBeFalsy();
      expect(item.heading ?? "", item.key).not.toBe("In Advanced mode");
    }
    expect(menu.items.find((item) => item.key === "new-thread")).toMatchObject({ label: "New thread", heading: "Threads", separatorBefore: true });
    expect(menu.items.find((item) => item.key === "inspector")?.separatorBefore).toBe(false);
  });

  it("starts the open conversation fresh with one press, and not while it is working or already fresh", () => {
    const item = menuOf(createElement(ChatMoreMenu, { bot })).items.find((one) => one.key === "start-fresh")!;
    expect(item.disabled).toBe(false);
    item.onSelect();
    expect(fixture.run).toHaveBeenCalledWith("/api/bots/pepper/start-fresh", { threadId: "side" });

    const busy = menuOf(createElement(ChatMoreMenu, { bot: { ...bot, tasks: bot.tasks!.map((one) => one.threadId === "side" ? { ...one, busy: true } : one) } })).items.find((one) => one.key === "start-fresh")!;
    expect(busy).toMatchObject({ disabled: true, title: "Stop this bot's turn first" });

    const fresh = { ...bot, messages: [...bot.messages!, { id: "d", role: "bot" as const, kind: "compaction" as const, at: 2, parentId: "hi",
      compaction: { summary: "", firstKeptId: "", foldedThroughId: "hi", tokensBefore: 0, by: "person" as const, fresh: true as const } }], activeLeafId: "d" };
    expect(menuOf(createElement(ChatMoreMenu, { bot: fresh })).items.find((one) => one.key === "start-fresh")!.disabled).toBe(true);
  });

  it("starts a new thread with the bot and displays the platform shortcut hint", () => {
    const win = globalThis.window as { ogb?: { platform?: string } };
    try {
      for (const [platform, expected] of [["darwin", "⌘ ⇧ N"], ["win32", "Ctrl Shift N"], ["linux", "Ctrl Shift N"]] as const) {
        win.ogb = { platform };
        const menu = menuOf(createElement(ChatMoreMenu, { bot }));
        const newThread = menu.items.find((item) => item.key === "new-thread")!;
        expect(renderToStaticMarkup(createElement("div", null, newThread.trailing))).toContain(expected);
      }
    } finally {
      delete win.ogb;
    }
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    menu.items.find((item) => item.key === "new-thread")!.onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newTask", botId: "pepper" });
  });

  it("lists the bot's main thread first, then newest first, without routine runs, marks the open one and opens another", () => {
    const threads = menuOf(createElement(ChatMoreMenu, { bot })).items.find((item) => item.key === "threads")!;
    expect(threads).toMatchObject({ label: "All threads", value: "3" });
    expect(threads.submenu!.map((item) => [item.label, Boolean(item.active)])).toEqual([
      ["Our chat", false],
      ["Trip plan", true],
      ["Untitled chat", false],
    ]);
    expect(threads.submenu!.map((item) => renderToStaticMarkup(createElement("div", null, item.trailing)).includes('aria-label="Main thread"'))).toEqual([true, false, false]);
    threads.submenu![0].onSelect();
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
    expect(keys(menuOf(createElement(ChatMoreMenu, { bot: single })).items)).toEqual(["find", "new-thread", "start-fresh", "publish", "copy", "download", "activity", "inspector"]);
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

describe("the phone header's ⋯", () => {
  const modelRow = () => menuOf(createElement(ChatMoreMenu, { bot, phoneHeader: true })).items.find((item) => item.key === "model")!;
  const trailing = () => renderToStaticMarkup(createElement("div", null, modelRow().trailing));
  for (const advanced of [false, true]) {
    it(`shows the model's usage bars on its Model row (${advanced ? "Advanced" : "Simple"})`, () => {
      fixture.advanced = advanced;
      rememberLimits({ checkedAt: 1, engines: [
        { engine: "test", name: "Test", driver: "codex", window: "5-hour", usedPercent: 92, resetsAt: null, blocked: false },
        { engine: "other", name: "Other", driver: "claude", window: "5-hour", usedPercent: 10, resetsAt: null, blocked: false },
      ] });
      expect(trailing()).toContain('data-usage-bars="near"');
      expect(trailing()).toContain("Test: 92% used");
    });
  }

  it("leaves the Model row bare for an engine that reports no usage", () => {
    rememberLimits({ checkedAt: 1, engines: [{ engine: "other", name: "Other", driver: "claude", window: "5-hour", usedPercent: 10, resetsAt: null, blocked: false }] });
    expect(trailing()).not.toContain("data-usage-bars");
  });
});

describe("ChatShareMenu, the bot panel's Share", () => {
  it("shares the bot as a template, or copies or downloads the conversation, in those words", () => {
    const menu = menuOf(createElement(ChatShareMenu, { bot, className: "" }));
    expect(menu.items.map((item) => [item.key, item.label])).toEqual([["publish", "Publish"], ["copy", "Copy conversation"], ["download", "Download conversation"]]);
  });
});

describe("ChatHeaderMenu, Advanced mode's header ⋯", () => {
  it("keeps main's items, trigger and hover menu below the header", () => {
    fixture.advanced = true;
    const menu = menuOf(createElement(ChatHeaderMenu, { bot }));
    expect(keys(menu.items)).toEqual(["find", "start-fresh", "publish", "copy", "download", "activity", "inspector"]);
    expect(menu.items.find((item) => item.key === "inspector")).toMatchObject({ separatorBefore: true });
    expect(menu.items.every((item) => !item.disabled && item.heading !== "In Advanced mode")).toBe(true);
    expect(menu).toMatchObject({ placement: "below", openOnHover: true });
    expect(menu.trigger).toMatch(/data-testid="chat-more" class="flex size-9 items-center justify-center rounded-full /);
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

describe("Set as main thread, for the conversation on screen", () => {
  const withSide = (extra: Partial<Task>): Bot => ({ ...bot, tasks: bot.tasks!.map((each) => (each.threadId === "side" ? { ...each, ...extra } : each)) });
  const setMain = (item: Bot, menu: typeof ChatMoreMenu | typeof ChatHeaderMenu = ChatHeaderMenu) =>
    menuOf(createElement(menu, { bot: item })).items.find((one) => one.key === "set-main");

  it("makes the open conversation the bot's main thread, in Simple and Advanced", () => {
    fixture.ownerOrAdmin = true;
    for (const advanced of [false, true]) {
      fixture.advanced = advanced;
      fixture.dispatch.mockClear();
      const item = setMain(bot, ChatMoreMenu)!;
      expect(item).toMatchObject({ label: "Set as main thread", disabled: false });
      item.onSelect();
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "pepper", patch: { mainThreadChoice: "side" } });
    }
  });

  it("stays shown but off on the main thread, saying why", () => {
    fixture.ownerOrAdmin = true;
    expect(setMain({ ...bot, mainThreadId: "side" })).toMatchObject({ disabled: true, title: "This is already the main thread" });
  });

  it("is left out for automation runs, private, archived and bot-opened threads, and for a blank new chat", () => {
    fixture.ownerOrAdmin = true;
    expect(setMain(withSide({ routineRunId: "run-2" }))).toBeUndefined();
    expect(setMain(withSide({ private: true }))).toBeUndefined();
    expect(setMain(withSide({ archivedAt: 1 }))).toBeUndefined();
    expect(setMain(withSide({ openedBy: { botId: "scout", name: "Scout", at: 1 } }))).toBeUndefined();
    expect(setMain({ ...bot, threadId: "not-saved-yet" })).toBeUndefined();
  });

  it("is only for the owner or an admin, as the sidebar's item is", () => {
    for (const allowed of [false, null]) {
      fixture.ownerOrAdmin = allowed;
      expect(setMain(bot)).toBeUndefined();
    }
  });
});

describe("sharing the conversation on screen, on a team", () => {
  const withSide = (extra: Partial<Task>): Bot => ({ ...bot, tasks: bot.tasks!.map((each) => (each.threadId === "side" ? { ...each, ...extra } : each)) });
  const shareKeys = (item: Bot) => keys(menuOf(createElement(ChatHeaderMenu, { bot: item })).items).filter((key) => key.startsWith("share-"));

  it("offers its own person both shares of a private conversation, each opening its confirm step", () => {
    fixture.team = true;
    const items = menuOf(createElement(ChatHeaderMenu, { bot: withSide({ private: true }) })).items;
    expect(items.filter((item) => item.key.startsWith("share-")).map((item) => item.label)).toEqual(["Share with the team", "Share with…"]);
    items.find((item) => item.key === "share-team")!.onSelect();
    expect(fixture.open).toHaveBeenLastCalledWith({ kind: "team", botId: "pepper", threadId: "side" });
    items.find((item) => item.key === "share-person")!.onSelect();
    expect(fixture.open).toHaveBeenLastCalledWith({ kind: "person", botId: "pepper", threadId: "side" });
  });

  it("only widens to the team what its person shared with one person, and offers nothing to the person it was shared with", () => {
    fixture.team = true;
    expect(shareKeys(withSide({ shared: true, sharedWith: { name: "Marta", byYou: true } }))).toEqual(["share-team"]);
    expect(shareKeys(withSide({ shared: true, sharedWith: { name: "Rui" } }))).toEqual([]);
    expect(shareKeys(withSide({ shared: true }))).toEqual([]);
    expect(shareKeys(withSide({}))).toEqual([]);
    expect(shareKeys({ ...withSide({ private: true }), defaultBot: { person: "rui@acme.test" } } as Bot), "a chat with their own MausBot").toEqual([]);
  });

  it("is not offered off a team", () => {
    expect(shareKeys(withSide({ private: true }))).toEqual([]);
  });
});

describe("Publish's choices", () => {
  const choices = () => menuOf(createElement(ChatMoreMenu, { bot })).items.find((item) => item.key === "publish")!.submenu!.map((item) => item.key);
  afterAll(() => { (window as { ogb?: unknown }).ogb = undefined; });

  it("offers the team's templates to its admins only, and the repository to no member", () => {
    fixture.team = true;
    fixture.ownerOrAdmin = true;
    expect(choices()).toEqual(["publish:community", "publish:repo", "publish:team", "publish:download"]);
    fixture.ownerOrAdmin = false;
    expect(choices()).toEqual(["publish:community", "publish:download"]);
  });

  it("offers Save folder… on the desktop, not to a remote client", () => {
    (window as { ogb?: unknown }).ogb = { pickFolder: vi.fn() };
    expect(choices()).toEqual(["publish:community", "publish:repo", "publish:save", "publish:download"]);
    (window as { ogb?: unknown }).ogb = { pickFolder: vi.fn(), remoteClient: { active: true } };
    expect(choices()).toEqual(["publish:community", "publish:repo", "publish:download"]);
  });
});
