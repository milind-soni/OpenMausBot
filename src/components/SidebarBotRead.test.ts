// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, reducer, type Action, type AppState, type Bot } from "@/state/store";
import { BotContextMenu } from "./Sidebar";
import { setLocale } from "@/lib/i18n";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useShowThreads: () => false,
}));

const bot: Bot = { id: "reviewer", threadId: "selected", name: "Reviewer", title: "", description: "", color: "green",
  notifications: true, unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "selected", title: "Selected", createdAt: 1, unread: false },
    { threadId: "background", title: "Report", createdAt: 2, unread: true },
    { threadId: "next", title: "Another report", createdAt: 3, unread: true },
  ],
};
let root: Root, container: HTMLDivElement, state: AppState;
let menu: { botId: string; x: number; y: number } | null;
const onClose = vi.fn();
const dispatch = (action: Action) => { state = reducer(state, action); draw(); };
const draw = () => flushSync(() => root.render(createElement(BotEditorStore, {
  value: { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(BotContextMenu, { menu, onClose, onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn() }),
})));
const button = (label = "Mark all conversations as read") => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === label)!;
const response = (threadId: string) => {
  const current = state.bots[0]!;
  return new Response(JSON.stringify({ bot: { ...current, tasks: current.tasks!.map((task) => task.threadId === threadId ? { ...task, unread: false } : task) } }), { headers: { "content-type": "application/json" } });
};

beforeEach(() => {
  setLocale("en"); document.documentElement.dataset.reducedMotion = "true";
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state = { ...initialState, bots: [structuredClone(bot)], selectedId: "another-bot" };
  menu = { botId: bot.id, x: 50, y: 50 }; onClose.mockReset();
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); delete window.ogb; setLocale("en"); });

describe("bot menu bulk reads", () => {
  it("remains available with the full thread tree hidden, including Portuguese copy", () => {
    setLocale("pt-br"); draw();
    expect(button("Marcar todas as conversas como lidas").disabled).toBe(false);
  });

  it("disables the action when there is no unread conversation", () => {
    state.bots[0]!.tasks!.forEach((task) => { task.unread = false; }); draw();
    expect(button().disabled).toBe(true);
  });

  it("guards repeat clicks, shows progress and closes only after the last read is confirmed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { threadId } = JSON.parse(String(init?.body));
      await gate; return response(threadId);
    });
    vi.stubGlobal("fetch", fetch); draw();
    const trigger = button(); flushSync(() => { trigger.click(); trigger.click(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(button("Marking conversations as read…").disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    release();
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.selectedId).toBe("another-bot");
    expect(state.bots[0]!.threadId).toBe("selected");
    expect(state.bots[0]!.tasks!.every((task) => !task.unread)).toBe(true);
  });

  it("shows a recoverable failure, retains confirmed reads, and retries only the unread remainder", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => response(JSON.parse(String(init?.body)).threadId));
    fetch.mockImplementationOnce(async () => response("background"));
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Fixture read failed" }), { status: 500 }));
    vi.stubGlobal("fetch", fetch); draw(); flushSync(() => button().click());
    await expect.poll(() => document.querySelector('[role="alert"]')?.textContent).toContain("Completed reads were kept");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Fixture read failed");
    expect(onClose).not.toHaveBeenCalled();
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "background")?.unread).toBe(false);
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "next")?.unread).toBe(true);
    flushSync(() => button().click()); await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body)).threadId).toBe("next");
  });

  it("does not close a different menu opened while a read is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => { await gate; return response(JSON.parse(String(init?.body)).threadId); });
    vi.stubGlobal("fetch", fetch); draw(); flushSync(() => button().click());
    menu = { botId: bot.id, x: 60, y: 60 }; draw(); release();
    await expect.poll(() => state.bots[0]!.tasks!.every((task) => !task.unread)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not expose bulk sibling reads to thread-pinned remote clients", () => {
    window.ogb = { remoteClient: { active: true } } as typeof window.ogb;
    draw(); expect(button()).toBeUndefined();
  });
});
