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
  fixture.open.mockClear();
  fixture.dispatch.mockClear();
  fixture.find.mockClear();
});

describe("ChatMoreMenu, the round ⋯ for the bot panel", () => {


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

  it("keeps background threads out of the conversation menu", () => {
    const items = keys(menuOf(createElement(ChatMoreMenu, { bot })).items);
    expect(items).not.toContain("threads");
    expect(items).not.toContain("new-thread");
  });

  it("opens the chat's find bar for the thread on screen", () => {
    const menu = menuOf(createElement(ChatMoreMenu, { bot }));
    menu.items.find((item) => item.key === "find")!.onSelect();
    expect(fixture.find).toHaveBeenCalledWith("side");
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
    expect(menu.items.map((item) => [item.key, item.label])).toEqual([["as-template", "Share as template"], ["copy", "Copy conversation"], ["download", "Download conversation"]]);
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
