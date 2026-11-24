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
  return createElement(History, { bot: store.state.bots[0]! });
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

it("still asks for the whole chat when a jump needs it", async () => {
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other", whole: true }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other", expect.objectContaining({ method: "POST" })));
});

it("reuses the current thread and leaves cold V2 history to the page reader", async () => {
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-old" }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-old?messages=0", expect.anything()));
  flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other" }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other?messages=0", expect.anything()));
});

const line = (id: string, text = id, parentId: string | null = null): Message => ({
  id, text, parentId, role: "bot", kind: "text", at: 1,
});

function showMessages(messages: Message[], hasMore = false) {
  flushSync(() => dispatch({ type: "taskSwitched", bot: {
    ...profile, needsHistory: true, activeLeafId: messages.at(-1)?.id, messages, hasMore,
  } }));
}

it("replaces the compact page on branch changes and ignores an old page still in flight", async () => {
  const url = "/api/threads/B-old/messages?view=chat&limit=200";
  let nextPage = { messages: [line("old")], hasMore: true };
  let answerOld!: (response: Response) => void;
  requests.mockImplementation(input => {
    if (input === url + "&before=old") return new Promise(resolve => { answerOld = resolve; });
    if (input === url) return Promise.resolve(Response.json(nextPage));
    return new Promise(() => {});
  });
  showMessages([line("old")], true);
  await vi.waitFor(() => expect(host.textContent).toBe("old"));
  await new Promise(resolve => setTimeout(resolve, 10));
  flushSync(() => host.querySelector("button")!.click());
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith(url + "&before=old", expect.anything()));
  nextPage = { messages: [line("new")], hasMore: false };
  flushSync(() => dispatch({ type: "threadActive", threadId: "B-old", activeLeafId: "new" }));
  expect(host.textContent).not.toContain("old");
  await vi.waitFor(() => expect(host.textContent).toBe("new"));
  answerOld(Response.json({ messages: [line("old ancestor")], hasMore: false }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(host.textContent).toBe("new");
});

it("updates a visible card when its server patch arrives", () => {
  const card: Message = { ...line("card", "Waiting for answer"), kind: "options" };
  showMessages([card]);
  expect(host.textContent).toBe("Waiting for answer");
  flushSync(() => dispatch({ type: "messagePatched", threadId: "B-old", message: { ...card, text: "Answered" } }));
  expect(host.textContent).toBe("Answered");
});

it("uses compact history on both sides of the phone breakpoint", async () => {
  const media = window.matchMedia("(max-width: 767.98px)");
  const originalMatchMedia = window.matchMedia.bind(window);
  let narrow = false;
  Object.defineProperty(media, "matches", { get: () => narrow });
  const spy = vi.spyOn(window, "matchMedia").mockImplementation(query =>
    query === media.media ? media : originalMatchMedia(query),
  );
  try {
    narrow = true;
    flushSync(() => media.dispatchEvent(new Event("change")));
    flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other" }));
    await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other?messages=0", expect.anything()));
    narrow = false;
    flushSync(() => media.dispatchEvent(new Event("change")));
    flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other" }));
    await vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks/B-other?messages=0", expect.anything()));
  } finally {
    spy.mockRestore();
  }
});

it("shows persisted messages while refreshing, then applies edits and deletions silently", async () => {
  const cache = await import("../lib/chat-cache");
  const local = { messages: [line("a", "cached"), line("b", "removed")], hasMore: false };
  const fresh = { messages: [line("a", "edited")], hasMore: false };
  const read = vi.spyOn(cache, "readChatCache").mockResolvedValue(local);
  const write = vi.spyOn(cache, "writeChatCache").mockResolvedValue();
  const response = Promise.withResolvers<Response>();
  requests.mockImplementation(() => response.promise);
  try {
    flushSync(() => root.render(createElement(cache.ChatCacheScope.Provider, { value: "test" },
      createElement(StoreProvider, null, createElement(Probe)))));
    await vi.waitFor(() => expect(host.textContent).toBe("cached,removed"));
    expect(requests).toHaveBeenCalledWith("/api/threads/B-old/messages?view=chat&limit=200", expect.anything());
    response.resolve(Response.json(fresh));
    await vi.waitFor(() => expect(host.textContent).toBe("edited"));
    expect(write).toHaveBeenCalledWith("pages", "test", expect.any(String), fresh);
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});

it("keeps a global search hit from a switched thread visible after its compact page loads and focus is consumed", async () => {
  const url = "/api/threads/B-other/messages?view=chat&limit=200";
  const activity: Message = { ...line("tool", "historical tool command"), kind: "activity", tool: { name: "git status" } };
  const reply = { ...line("reply", "latest reply", activity.id), at: 2 };
  requests.mockImplementation(input => input === url
    ? Promise.resolve(Response.json({ messages: [reply], hasMore: false }))
    : new Promise(() => {}));
  flushSync(() => dispatch({ type: "taskSwitched", bot: { ...profile, threadId: "B-other", activeLeafId: reply.id, messages: [activity, reply] } }));
  await vi.waitFor(() => expect(requests).toHaveBeenCalledWith(url, expect.anything()));
  await vi.waitFor(() => expect(host.textContent).toBe("latest reply"));
  flushSync(() => dispatch({ type: "focusMessage", threadId: "B-other", messageId: activity.id, matchText: "git status" }));
  expect(host.textContent).toBe("historical tool command,latest reply");
  flushSync(() => dispatch({ type: "focusMessageConsumed", nonce: 1 }));
  await vi.waitFor(() => expect(host.textContent).toBe("historical tool command,latest reply"));
});
