import type { EffectCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type Action, type AppState, type Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], link: null as string | null, showThreads: true, aside: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: () => [fixture.link, (next: string | null) => { fixture.link = next; }],
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/lib/cloud-welcome", () => ({ stepAsideWelcome: fixture.aside }));

import { useExternalChatLinks } from "./use-external-chat-links";

const scout: Bot = {
  id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [{ threadId: "scout-main", title: "Main", createdAt: 1 }],
};
const loading: AppState = { ...initialState, bots: [], selectedId: "" };
const loaded: AppState = { ...initialState, bots: [scout], selectedId: "scout", hydrated: true };

/** One render: run its effects in order, as React would after commit. */
function render(state: AppState, dispatch: (action: Action) => void) {
  fixture.effects = [];
  useExternalChatLinks(state, dispatch);
  return fixture.effects.map((effect) => effect());
}

afterEach(() => { vi.unstubAllGlobals(); fixture.effects = []; fixture.link = null; fixture.showThreads = true; fixture.aside.mockClear(); });

describe("useExternalChatLinks", () => {
  it("holds a link that arrives at launch until the bots have loaded, then opens it once", () => {
    // A notification or a chat link is not the other side's hand-over: My Cloud's welcome keeps its place.
    let deliver: ((link: string) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", { ogb: { onChatLink: (cb: (link: string) => void) => { deliver = cb; return unsubscribe; } } });
    const dispatch = vi.fn();

    const [cleanup] = render(loading, dispatch);
    expect(cleanup).toBe(unsubscribe);
    deliver!("openmausbot://bot/scout");
    render(loading, dispatch);
    expect(dispatch).not.toHaveBeenCalled();

    render(loaded, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
    expect(fixture.link).toBeNull();

    dispatch.mockClear();
    render(loaded, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.aside).not.toHaveBeenCalled();
  });

  it("closes Settings and the shortcuts list so the linked chat is not left behind them", () => {
    vi.stubGlobal("window", {});
    fixture.link = "openmausbot://bot/scout";
    const dispatch = vi.fn();
    render({ ...loaded, appSettingsOpen: true, shortcutsOpen: true, newBotOpen: true }, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "toggleAppSettings", open: false },
      { type: "toggleShortcuts", open: false },
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });

  it("opens a bot's link as its row would: at its main thread while threads are hidden", () => {
    vi.stubGlobal("window", {});
    fixture.link = "openmausbot://bot/scout";
    fixture.showThreads = false;
    const dispatch = vi.fn();
    const left = { ...scout, threadId: "scout-report", mainThreadId: "scout-main",
      tasks: [...scout.tasks!, { threadId: "scout-report", title: "Report", createdAt: 2, unread: true }] };
    render({ ...loaded, bots: [left] }, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "scout-main" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });

  it("does nothing without the desktop bridge", () => {
    vi.stubGlobal("window", {});
    const dispatch = vi.fn();
    expect(render(loaded, dispatch)).toEqual([undefined, undefined, undefined]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.aside).not.toHaveBeenCalled();
  });

  it("opens the chat main hands over once the window moved here from the other side of the one workspace", async () => {
    const take = vi.fn(async () => "openmausbot://bot/scout");
    vi.stubGlobal("window", { ogb: { oneWorkspace: { take } } });
    const dispatch = vi.fn();
    render(loading, dispatch);
    await Promise.resolve();
    expect(take).toHaveBeenCalledTimes(1);
    expect(fixture.link).toBe("openmausbot://bot/scout");
    expect(fixture.aside, "My Cloud's welcome steps aside for the bot the person opened from the other side").toHaveBeenCalledTimes(1);
    render(loaded, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });
});
