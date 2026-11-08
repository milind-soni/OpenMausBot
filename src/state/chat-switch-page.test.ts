// @vitest-environment happy-dom
// Opening a chat fetches a short tail so big chats switch quickly; older messages load on scroll.
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action, type Bot } from "./store";

const profile: Bot = {
  id: "B", name: "B", threadId: "B-old", title: "", description: "", color: "green", unread: false, notifications: true,
  messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [{ threadId: "B-old", title: "Existing", createdAt: 1 }, { threadId: "B-other", title: "Other", createdAt: 2 }],
};
class OfflineEvents {
  onopen = null;
  onerror = null;
  onmessage = null;
  close() {}
}

const original = { bots: initialState.bots, selectedId: initialState.selectedId };
let root: Root;
let host: HTMLDivElement;
let dispatch: Dispatch<Action>;
let requests: ReturnType<typeof vi.fn<typeof fetch>>;
function Probe() {
  dispatch = useStore().dispatch;
  return null;
}

beforeEach(() => {
  Object.assign(initialState, { bots: [profile], selectedId: "B" });
  requests = vi.fn<typeof fetch>(() => new Promise(() => {}));
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("EventSource", OfflineEvents);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  Object.assign(initialState, original);
  vi.unstubAllGlobals();
});

it("asks for the newest 80 messages when switching to a bot's chat", async () => {
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other" }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other?messages=80", expect.objectContaining({ method: "POST" })));
});

it("still asks for the whole chat when a jump needs it", async () => {
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other", whole: true }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other", expect.objectContaining({ method: "POST" })));
});
