// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action, type Bot, type Message } from "./store";
import { useChatHistory } from "./use-chat-history";

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
function History({ bot }: { bot: Bot }) {
  const { history, load } = useChatHistory(bot);
  return createElement("button", { onClick: load }, history.map(message => message.text).join(","));
}
function Probe() {
  const store = useStore();
  dispatch = store.dispatch;
  return store.state.chatV2 ? createElement(History, { bot: store.state.bots[0]! }) : null;
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

it("asks for the newest 80 raw messages after toggling back to V1", async () => {
  flushSync(() => dispatch({ type: "chatView", v2: false }));
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other" }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other?messages=80", expect.objectContaining({ method: "POST" })));
});

it("still asks for the whole chat when a jump needs it", async () => {
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other", whole: true }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other", expect.objectContaining({ method: "POST" })));
});

it("reuses the current thread and requests a compact cold V2 switch", async () => {
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-old" }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-old?messages=0", expect.anything()));
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other" }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other?messages=80&view=chat", expect.anything()));
});

const line = (id: string, text = id, parentId: string | null = null): Message => ({
  id, text, parentId, role: "bot", kind: "text", at: 1,
});

function showCompact(messages: Message[], hasMore = false) {
  flushSync(() => dispatch({ type: "taskSwitched", bot: {
    ...profile, needsHistory: true, activeLeafId: messages.at(-1)?.id,
    chatPage: { threadId: profile.threadId, messages, hasMore },
  } }));
  flushSync(() => dispatch({ type: "chatView", v2: true }));
}

it("replaces the compact page on branch changes and ignores an old page still in flight", async () => {
  const url = "/api/threads/B-old/messages?view=chat&limit=200";
  let answerOld!: (response: Response) => void;
  requests.mockImplementation(input => {
    if (input === url + "&before=old") return new Promise(resolve => { answerOld = resolve; });
    if (input === url) return Promise.resolve(Response.json({ messages: [line("new")], hasMore: false }));
    return new Promise(() => {});
  });
  showCompact([line("old")], true);
  expect(host.textContent).toBe("old");
  flushSync(() => host.querySelector("button")!.click());
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith(url + "&before=old", expect.anything()));
  flushSync(() => dispatch({ type: "threadActive", threadId: "B-old", activeLeafId: "new" }));
  expect(host.textContent).not.toContain("old");
  await vi.waitFor(() => expect(host.textContent).toBe("new"));
  answerOld(Response.json({ messages: [line("old ancestor")], hasMore: false }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(host.textContent).toBe("new");
});

it("updates a card loaded only in a compact page when its server patch arrives", () => {
  const card: Message = { ...line("card", "Waiting for answer"), kind: "options" };
  showCompact([card]);
  expect(host.textContent).toBe("Waiting for answer");
  flushSync(() => dispatch({ type: "messagePatched", threadId: "B-old", message: { ...card, text: "Answered" } }));
  expect(host.textContent).toBe("Answered");
});
