// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, StoreContext, type Action, type AppState, type Bot, type Task } from "@/state/store";
import { WorkspaceChatContext } from "@/state/workspace-chat-context";
import { MAIN_PANE } from "@/state/pane-layout";
import { useThreadCycleKeys } from "./thread-cycle";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const thread = (threadId: string, at: number, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: at, lastThreadOrderAt: at, ...extra });
const bot = (threadId: string) => ({ id: "scout", name: "Scout", threadId, messages: [], tasks: [thread("a", 3), thread("b", 2), thread("c", 1)] }) as unknown as Bot;

function Host() {
  useThreadCycleKeys();
  return createElement("div", null,
    createElement("textarea", { "data-composer": "", onKeyDown: (event: KeyboardEvent) => { if (event.key === "Tab") event.preventDefault(); } }),
    createElement("div", { role: "dialog" }, createElement("button", { "data-in-dialog": "" })));
}

async function show(threadId: string, state: Partial<AppState> = {}) {
  const dispatch = vi.fn<(action: Action) => void>();
  const value = { state: { ...initialState, bots: [bot(threadId)], selectedId: "scout", activeView: "chat" as const, ...state }, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(StoreContext.Provider, { value }, createElement(WorkspaceChatContext.Provider, { value: threadId }, createElement(Host)))));
  return dispatch;
}

const press = (target: EventTarget, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

it("Ctrl+Tab opens the next thread and Ctrl+Shift+Tab the previous, wrapping", async () => {
  let dispatch = await show("c");
  const forward = press(document.body, {});
  expect(forward.defaultPrevented).toBe(true);
  expect(dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: "scout", threadId: "a" });
  dispatch = await show("a");
  press(document.body, { shiftKey: true });
  expect(dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: "scout", threadId: "c" });
});

it("cycles in the focused split and focuses a thread that is already visible", async () => {
  const dispatch = await show("a", { workspacePanes: {
    layout: { direction: "beside", ratio: 0.5, first: MAIN_PANE, second: "b" }, focused: "b",
    panels: { b: { kind: "bot", ownerId: "scout", threadId: "b", messages: [], activeLeafId: null, loading: false, loadId: "b", loadFailed: false } },
  } });
  const primary = document.createElement("section");
  primary.dataset.workspaceThread = "a";
  primary.tabIndex = -1;
  container.append(primary);
  press(document.body, {});
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "openForkPanel", kind: "bot", ownerId: "scout", threadId: "c", split: "replace" });
  dispatch.mockClear();
  press(document.body, { shiftKey: true });
  expect(document.activeElement).toBe(primary);
  expect(dispatch).not.toHaveBeenCalled();
});

it("leaves the key to a composing input method, a field that took it and a dialog, and skips a held key's repeats", async () => {
  const dispatch = await show("a");
  press(document.body, { isComposing: true });
  press(container.querySelector("[data-composer]")!, {});
  press(container.querySelector("[data-in-dialog]")!, {});
  press(document.body, { repeat: true });
  expect(dispatch).not.toHaveBeenCalled();
});

it("does nothing away from a bot's chat", async () => {
  const dispatch = await show("a", { activeView: "routines" });
  press(document.body, {});
  expect(dispatch).not.toHaveBeenCalled();
});
