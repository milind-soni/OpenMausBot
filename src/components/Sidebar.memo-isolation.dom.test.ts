// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreProvider, type AppState, type Bot } from "@/state/store";

const spies = vi.hoisted(() => ({
  titleCalls: [] as string[],
  unreadCalls: [] as string[],
}));

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/task-title", async (original) => {
  const mod = await original<typeof import("@/lib/task-title")>();
  return {
    ...mod,
    localizedTaskTitle: (title: string) => {
      spies.titleCalls.push(title);
      return mod.localizedTaskTitle(title);
    },
  };
});
vi.mock("./unread-notice", async (original) => {
  const mod = await original<typeof import("./unread-notice")>();
  return {
    ...mod,
    useBotUnread: (bot: Bot) => {
      spies.unreadCalls.push(bot.id);
      return mod.useBotUnread(bot);
    },
  };
});
vi.mock("@/state/api", async (original) => {
  const mod = await original<typeof import("@/state/api")>();
  return {
    ...mod,
    api: vi.fn(async (url: string) => {
      if (url.startsWith("/api/threads/")) {
        return { messages: [{ id: "m-prev", role: "bot", kind: "text", text: "Saved line", at: 500 }] };
      }
      return {};
    }),
  };
});

const { BotConversations, forgetConversationLines, showAllConversations } = await import("./bot-panel/Conversations");
const { BotListItem, botRowProps } = await import("./Sidebar");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  forgetConversationLines();
  spies.titleCalls.length = 0;
  spies.unreadCalls.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  document.body.innerHTML = "";
});

const flushMicrotasks = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("row memoization in BotConversations and BotListItem", () => {
  it("re-renders only the open conversation row in BotConversations when the active chat streams a new token", async () => {
    const tasks = [
      { threadId: "open", title: "Open chat", createdAt: 1_000, updatedAt: 1_000 },
      ...Array.from({ length: 14 }, (_, index) => ({
        threadId: `peer-${index}`,
        title: `Peer ${index}`,
        createdAt: 900 - index,
        updatedAt: 900 - index,
      })),
    ];
    const bot: Bot = {
      id: "maus", threadId: "open", name: "Maus", title: "", description: "", notifications: true,
      color: "green", unread: false, messages: [{ id: "m-1", role: "bot", kind: "text", text: "Hello", at: 1_000 }],
      modelSelection: { instanceId: "fake", model: "test" },
      tasks,
    };

    showAllConversations("maus");
    await act(async () => {
      root.render(createElement(StoreProvider, null, createElement(BotConversations, { bot })));
      await flushMicrotasks();
    });
    expect(host.querySelectorAll("[data-conversation]")).toHaveLength(15);

    spies.titleCalls.length = 0;
    const nextBot: Bot = {
      ...bot,
      messages: [{ id: "m-1", role: "bot", kind: "text", text: "Hello world", at: 1_000 }],
    };
    await act(async () => {
      root.render(createElement(StoreProvider, null, createElement(BotConversations, { bot: nextBot })));
    });

    expect(spies.titleCalls).toEqual(["Open chat"]);
  });

  it("re-renders only the affected BotListItem out of 40 when pendingQueued or routineRuns changes for one bot", async () => {
    const bots: Bot[] = Array.from({ length: 40 }, (_, index) => ({
      id: `bot-${index}`,
      threadId: `main-${index}`,
      name: `Bot ${index}`,
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      messages: [],
      modelSelection: { instanceId: "fake", model: "test" },
      tasks: [
        { threadId: `main-${index}`, title: `Main ${index}`, createdAt: 10 },
        { threadId: `sub-${index}`, title: `Sub ${index}`, createdAt: 9 },
      ],
    }));
    const dispatch = vi.fn();
    const onMenu = vi.fn();
    const renderFleet = (state: AppState) => createElement(
      StoreProvider,
      null,
      bots.map((candidate) => createElement(BotListItem, {
        key: candidate.id,
        ...botRowProps(state, dispatch, candidate, { density: "comfortable", query: "", onMenu }),
      })),
    );

    const state0: AppState = { ...initialState, bots };
    await act(async () => { root.render(renderFleet(state0)); });
    expect(spies.unreadCalls).toHaveLength(40);

    spies.unreadCalls.length = 0;
    const queuedForZero = [{ id: "q-0", text: "Wait for turn", createdAt: 1 }] as unknown as AppState["pendingQueued"][string];
    const state1: AppState = { ...state0, pendingQueued: { "main-0": queuedForZero } };
    await act(async () => { root.render(renderFleet(state1)); });
    expect(spies.unreadCalls).toEqual(["bot-0"]);

    spies.unreadCalls.length = 0;
    const state2: AppState = {
      ...state1,
      pendingQueued: { "main-0": queuedForZero },
      routineRuns: [{
        id: "run-1", routineId: "rt-1", routineName: "Digest", target: "bot",
        botId: "bot-1", runOn: "maus", scheduledFor: 20, status: "running",
        manual: false, threadId: "sub-1", createdAt: 20,
      }],
    };
    await act(async () => { root.render(renderFleet(state2)); });
    expect(spies.unreadCalls).toEqual(["bot-1"]);
  });
});
