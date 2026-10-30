// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, type Action, type AppState, type Bot } from "@/state/store";

const store = vi.hoisted(() => ({ state: null as unknown as AppState, dispatch: (_action: unknown) => {} }));
vi.mock("@/state/store", async (original) => ({ ...(await original<typeof import("@/state/store")>()), useStore: () => store }));
const { useReadShownChatOnFocus } = await import("./use-read-shown-chat");

const bot = (unread: boolean): Bot => ({
  id: "reviewer", threadId: "shown", name: "Reviewer", title: "", description: "", notifications: true,
  color: "green", unread, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [{ threadId: "shown", title: "Shown", createdAt: 1, unread }],
});

function Shell() {
  useReadShownChatOnFocus();
  return null;
}

let root: Root | null = null;
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
});

it("reads the shown chat when the window gets focus back, and only while it is unread", () => {
  const dispatched: Action[] = [];
  store.dispatch = (action) => dispatched.push(action as Action);
  store.state = { ...initialState, activeView: "chat", selectedId: "reviewer", bots: [bot(true)] };
  root = createRoot(document.createElement("div"));
  flushSync(() => root!.render(createElement(Shell)));
  window.dispatchEvent(new Event("focus"));
  expect(dispatched).toEqual([{ type: "select", id: "reviewer" }]);

  store.state = { ...store.state, bots: [bot(false)] };
  flushSync(() => root!.render(createElement(Shell)));
  window.dispatchEvent(new Event("focus"));
  expect(dispatched).toHaveLength(1);
});
