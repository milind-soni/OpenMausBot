// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_LEAD } from "../../shared/failed-turn";
import { ChatV2 } from "@/components/chat-v2/ChatV2";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { endCall } from "@/lib/call";
import { clearReplyDraft } from "@/lib/drafts";
import { initialDesktopCapabilities } from "@/lib/desktop";
import { StoreProvider, useStore, type Action, type AppState, type Bot, type Group, type Message } from "./store";

class FixtureEventSource {
  static current: FixtureEventSource;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { FixtureEventSource.current = this; }
  close() {}
  send(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const line = (id: string): Message => ({ id, at: 1, role: "user", kind: "text", text: id, parentId: null });
const tasks = ["a", "b"].map(threadId => ({ threadId, title: threadId, createdAt: 1 }));
const bot = (threadId: string, id = threadId): Bot => ({
  id: "bot", threadId, name: "Fixture", title: "", description: "", notifications: false,
  unread: false, color: "green", modelSelection: { instanceId: "fake", model: "fixture" },
  tasks, messages: [line(id)], activeLeafId: id,
});
const room = (threadId: string, id = threadId): Group => ({
  id: "room", threadId: `room-${threadId}`, name: "Fixture room", memberIds: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
  tasks: tasks.map(task => ({ ...task, threadId: `room-${task.threadId}` })), messages: [line(id)],
});
const json = (body: unknown) => new Response(JSON.stringify(body));
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
};

let state!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  ({ state, dispatch } = useStore());
  const active = state.bots.find(bot => bot.id === state.selectedId);
  return state.chatV2 && active ? createElement(ChatV2, { key: active.threadId, profile: active, onClose: () => {} }) : null;
}
let root: Root;
let container: HTMLDivElement;
let snapshot: ReturnType<typeof deferred>;
let switchResponse: ReturnType<typeof deferred> | undefined;
let reconnectHistory: ReturnType<typeof deferred> | undefined;
let newTaskResponse: ReturnType<typeof deferred> | undefined;
let snapshots: number;
let sends: unknown[];
let chatPage: Message[];
let chatReads: number;
let retries: unknown[];
const shown = () => state.bots[0]!;
const resync = async () => {
  FixtureEventSource.current.send({ kind: "hello", resumed: false, cursor: "fixture:0" });
  await vi.waitFor(() => expect(snapshots).toBe(2));
};
const applySnapshot = async (threadId = "a", taskIds = ["a", "b"]) => {
  const incomingBot = bot(threadId, "snapshot"), incomingRoom = room(threadId, "snapshot");
  incomingBot.tasks = incomingBot.tasks?.filter(task => taskIds.includes(task.threadId));
  incomingRoom.tasks = incomingRoom.tasks?.filter(task => taskIds.includes(task.threadId.slice(5)));
  snapshot.resolve(json({ bots: [incomingBot], groups: [incomingRoom], sections: ["resynced"] }));
  await vi.waitFor(() => expect(state.sections).toEqual(["resynced"]));
};
const switchBot = async (threadId: string) => {
  flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId }));
  await vi.waitFor(() => expect(shown().messages[0]?.id).toBe(`fresh-${threadId}`));
};

async function mount(v2: boolean, speech?: Partial<Window["ogb"]>, fixture?: {
  pages: Record<string, { messages: Message[]; hasMore: boolean }>;
  setupRequests?: unknown[];
  quote?: { message: Message; onActivePath: boolean };
  lastReadMessageId?: string;
}) {
  snapshots = 0;
  sends = [];
  retries = [];
  chatReads = 0;
  chatPage = [line("a")];
  snapshot = deferred();
  switchResponse = undefined;
  newTaskResponse = undefined;
  reconnectHistory = undefined;
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, String(value)); },
    removeItem: (key: string) => { stored.delete(key); }, clear: () => stored.clear(),
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  if (speech) vi.stubGlobal("ogb", speech);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) {
      snapshots++;
      const initial = fixture ? { ...bot("a"), activeLeafId: fixture.pages[""]?.messages.at(-1)?.id, messages: [] } : bot("a");
      if (fixture?.lastReadMessageId) {
        initial.unread = true;
        initial.tasks = initial.tasks?.map(task => task.threadId === "a"
          ? { ...task, unread: true, lastReadMessageId: fixture.lastReadMessageId } : task);
      }
      return snapshots === 1 ? json({ bots: [initial], groups: [room("a")] }) : snapshot.promise;
    }
    const task = path.match(/^\/api\/bots\/bot\/tasks\/([ab])/);
    if (task) return switchResponse?.promise ?? json({ bot: bot(task[1]!, `fresh-${task[1]}`) });
    if (path === "/api/bots/bot/tasks?main=1" || path === "/api/groups/room/tasks") return newTaskResponse?.promise ?? json({});
    if (path.startsWith("/api/groups/room/tasks/room-b")) return json({ group: room("b", "fresh-room-b") });
    if (path === "/api/bots/bot/messages" || path === "/api/groups/room/messages") sends.push(JSON.parse(String(init?.body)));
    if (path === "/api/bots/bot/setup-request" && init?.method === "POST" && fixture?.setupRequests) {
      const body = JSON.parse(String(init.body));
      fixture.setupRequests.push(body);
      return json({ message: { ...line("setup-choice"), text: body.text, parentId: "greeting", setupRequest: true } });
    }
    if (path.startsWith("/api/threads/a/messages?view=quote&around=")) {
      return fixture?.quote ? json(fixture.quote) : new Response(null, { status: 404 });
    }
    if (path.startsWith("/api/threads/a/messages?view=chat&limit=200")) {
      const cursor = new URL(path, "http://localhost").searchParams.get("before") ?? "";
      if (fixture?.pages[cursor]) return json(fixture.pages[cursor]);
      chatReads++;
      return json({ messages: chatPage, hasMore: false, activeLeafId: chatPage.at(-1)?.id });
    }
    if (path === "/api/bots/bot/messages/a/edit") retries.push(JSON.parse(String(init?.body)));
    if (path === "/api/threads/a/messages?limit=200") {
      if (snapshots === 1) return json({ messages: [line("a")], activeLeafId: "a", hasMore: false });
      return reconnectHistory?.promise ?? new Promise<Response>(() => {});
    }
    if (path === "/api/config" && speech) return json({ tts: { configured: true, ready: true } });
    if (path === "/api/instances") return json({ instances: fixture?.setupRequests
      ? [{
          instanceId: "fake", displayName: "Fixture", driverKind: "claude",
          capabilities: { agentsMcp: true }, snapshot: { state: "available" },
          models: { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] },
        }] : [] });
    if (path.startsWith("/api/routines?since=")) return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    return json({});
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const app = createElement(StoreProvider, null, createElement(Probe));
  flushSync(() => root.render(speech ? createElement(DesktopCapabilitiesProvider, null, app) : app));
  if (!v2) flushSync(() => dispatch({ type: "chatView", v2: false }));
  FixtureEventSource.current.send({ kind: "hello", resumed: false, cursor: "fixture:0" });
  await vi.waitFor(() => {
    expect(state.hydrated).toBe(true);
    if (!v2) expect(shown().needsHistory).toBe(false);
  });
}
afterEach(() => {
  flushSync(() => { endCall(); root.unmount(); });
  container.remove();
  clearReplyDraft("a");
  vi.unstubAllGlobals();
});

describe("navigation while a reconnect snapshot is in flight", () => {
  beforeEach(() => mount(false));
  it.each(["bot", "group"])("keeps a new %s task entry without restoring tasks omitted by the server", async owner => {
    await resync();
    newTaskResponse = deferred();
    flushSync(() => dispatch(owner === "bot"
      ? { type: "newTask", botId: "bot" }
      : { type: "newGroupTask", groupId: "room" }));
    const createdBot = bot("c", "created"), createdRoom = room("c", "created");
    createdBot.tasks = [...tasks, { threadId: "c", title: "Created", createdAt: 2 }];
    createdRoom.tasks = [...createdRoom.tasks!, { threadId: "room-c", title: "Created", createdAt: 2 }];
    newTaskResponse.resolve(json(owner === "bot" ? { bot: createdBot } : { group: createdRoom }));
    const current = () => owner === "bot" ? shown() : state.groups[0]!;
    await vi.waitFor(() => expect(current().messages[0]?.id).toBe("created"));
    await applySnapshot("a", ["a"]);

    expect(current().threadId).toBe(owner === "bot" ? "c" : "room-c");
    expect(current().messages.map(message => message.id)).toEqual(["created"]);
    expect(current().tasks?.map(task => task.threadId)).toEqual(owner === "bot" ? ["a", "c"] : ["room-a", "room-c"]);
  });

  it.each(["b", "a"])("keeps the newer %s transcript and sends to that thread", async target => {
    await resync();
    await switchBot("b");
    if (target === "a") await switchBot("a");
    await applySnapshot();

    expect(shown().threadId).toBe(target);
    expect(shown().messages.map(message => message.id)).toEqual([`fresh-${target}`]);
    expect(shown().activeLeafId).toBe(`fresh-${target}`);
    FixtureEventSource.current.send({ kind: "bot", bot: bot("a", "stale-frame") });
    flushSync(() => dispatch({ type: "send", botId: "bot", text: "Next", sendId: "next" }));
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ threadId: target, text: "Next" });
  });

  it("keeps a pending switch until its own response arrives", async () => {
    await resync();
    switchResponse = deferred();
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "b" }));
    await applySnapshot();

    expect(shown().switchingTo).toBe("b");
    switchResponse.resolve(json({ bot: bot("b", "fresh-b") }));
    await vi.waitFor(() => expect(shown().threadId).toBe("b"));
    expect(shown().messages.map(message => message.id)).toEqual(["fresh-b"]);
  });

  it("ends a pending switch whose response carries no bot", async () => {
    await resync();
    switchResponse = deferred();
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "b" }));
    await applySnapshot();
    expect(shown().switchingTo).toBe("b");
    switchResponse.resolve(json({}));
    await vi.waitFor(() => expect(shown().switchingTo).toBeUndefined());
    expect(shown().threadId).toBe("a");
  });

  it("keeps the room thread opened after the request started", async () => {
    await resync();
    flushSync(() => dispatch({ type: "switchGroupTask", groupId: "room", threadId: "room-b" }));
    await vi.waitFor(() => expect(state.groups[0]?.threadId).toBe("room-b"));
    await applySnapshot();

    expect(state.groups[0]?.threadId).toBe("room-b");
    expect(state.groups[0]?.messages.map(message => message.id)).toEqual(["fresh-room-b"]);
    flushSync(() => dispatch({ type: "sendGroup", groupId: "room", text: "Next", sendId: "next" }));
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ threadId: "room-b", text: "Next" });
  });

  it("accepts the server's thread when navigation did not change", async () => {
    await resync();
    await applySnapshot("b");
    expect(shown().threadId).toBe("b");
    expect(shown().messages.map(message => message.id)).toEqual(["snapshot"]);
    expect(state.groups[0]?.threadId).toBe("room-b");
  });

  it("refreshes an unchanged conversation while another owner switches threads", async () => {
    await resync();
    flushSync(() => dispatch({ type: "switchGroupTask", groupId: "room", threadId: "room-b" }));
    await vi.waitFor(() => expect(state.groups[0]?.threadId).toBe("room-b"));
    reconnectHistory = deferred();
    await applySnapshot();
    reconnectHistory.resolve(json({ messages: [line("snapshot")], activeLeafId: "snapshot", hasMore: false }));
    await vi.waitFor(() => expect(shown().messages.map(message => message.id)).toEqual(["snapshot"]));
    expect(state.groups[0]?.messages.map(message => message.id)).toEqual(["fresh-room-b"]);
  });
});

describe("the default Chat V2", () => {
  it("reloads the open conversation after a reconnect with the same active leaf", async () => {
    await mount(true);
    await vi.waitFor(() => expect(container.querySelector('[data-mid="a"]')?.textContent).toContain("a"));
    expect(chatReads).toBe(1);
    await resync();
    chatPage = [{ ...line("a"), text: "Changed while offline" }];
    const incoming = { ...bot("a"), messages: [] };
    snapshot.resolve(json({ bots: [incoming], groups: [room("a")], sections: ["resynced"] }));
    await vi.waitFor(() => expect(container.querySelector('[data-mid="a"]')?.textContent).toContain("Changed while offline"));
    expect(chatReads).toBe(2);
  });

  it("keeps the failed turn visible after the bot goes idle and retries the original request", async () => {
    await mount(true);
    await vi.waitFor(() => expect(container.querySelector('[data-mid="a"]')).not.toBeNull());
    const automaticRetry = { ...line("auto-retry"), parentId: "a", text: `${RETRY_LEAD}OpenMausBot, automatically]` };
    const failed: Message = {
      id: "failure", parentId: automaticRetry.id, at: 2, role: "bot", kind: "activity",
      tool: { name: "error: Engine unavailable", ok: false },
    };
    FixtureEventSource.current.send({ kind: "bot", bot: { ...bot("a"), busy: true } });
    FixtureEventSource.current.send({ kind: "message", threadId: "a", message: automaticRetry });
    FixtureEventSource.current.send({ kind: "message", threadId: "a", message: failed });
    FixtureEventSource.current.send({ kind: "bot", bot: { ...bot("a"), busy: false } });
    await vi.waitFor(() => expect(container.querySelector('[data-mid="failure"]')?.textContent).toContain("Engine unavailable"));
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry");
    expect(retry).toBeDefined();
    retry!.click();
    await vi.waitFor(() => expect(retries).toEqual([expect.objectContaining({ text: "a", threadId: "a" })]));
  });

  it("starts listening from the default chat's call button, sends speech and can hang up", async () => {
    const speechStart = vi.fn(async () => {});
    let transcript: Parameters<NonNullable<Window["ogb"]>["onSpeechTranscript"]>[0] | undefined;
    await mount(true, {
      platform: "darwin",
      getCapabilities: async () => initialDesktopCapabilities(),
      speechStart,
      speechStop: vi.fn(async () => {}),
      onSpeechTranscript: handler => { transcript = handler; return () => { transcript = undefined; }; },
      onSpeechEnd: () => () => {},
    });
    const call = () => container.querySelector<HTMLButtonElement>('[data-chat-v2] button[aria-label="Call Fixture"]');
    await vi.waitFor(() => expect(call()).not.toBeNull());
    flushSync(() => call()!.click());
    const overlay = () => container.querySelector("[data-chat-v2] .backdrop-blur-sm");
    expect(overlay()?.textContent).toContain("Listening");
    expect(speechStart).toHaveBeenCalledWith(expect.objectContaining({ endpointMs: 1700 }));
    flushSync(() => transcript?.({ text: "Spoken request", partial: false }));
    await vi.waitFor(() => expect(sends).toEqual([expect.objectContaining({ text: "Spoken request", threadId: "a" })]));
    flushSync(() => overlay()!.querySelector<HTMLButtonElement>('[aria-label="Hang up"]')!.click());
    expect(overlay()).toBeNull();
  });

  it("renders a blank bot's setup card and submits its selected choice", async () => {
    const greeting: Message = {
      ...line("greeting"), role: "bot", text: "What would you like me to do?",
      setupOffer: true, setupChoices: ["Summarize my inbox"],
    };
    const setupRequests: unknown[] = [];
    await mount(true, undefined, { pages: { "": { messages: [greeting], hasMore: false } }, setupRequests });
    const choice = () => container.querySelector<HTMLButtonElement>('[data-setup-card="greeting"] [data-ask-choice]');
    await vi.waitFor(() => expect(choice()?.textContent).toContain("Summarize my inbox"));
    flushSync(() => choice()!.click());
    await vi.waitFor(() => expect(setupRequests).toEqual([{ threadId: "a", text: "Summarize my inbox" }]));
    await vi.waitFor(() => expect(container.querySelector('[data-setup-answer]')?.textContent).toContain("Summarize my inbox"));
  });

  it.each([false, true])("shows the sent reply quote and jumps to its original (older page: %s)", async older => {
    const original: Message = { ...line("original"), role: "bot", text: "Original **answer**" };
    const reply: Message = { ...line("reply"), at: 3, parentId: original.id, replyToId: original.id, text: "My reply" };
    const middle = { ...line("middle"), at: 2, parentId: original.id };
    await mount(true, undefined, { pages: {
      "": { messages: older ? [reply] : [original, reply], hasMore: older },
      reply: { messages: [middle], hasMore: true },
      middle: { messages: [original], hasMore: false },
    }, quote: { message: original, onActivePath: true } });
    const jump = () => [...container.querySelectorAll<HTMLButtonElement>('[data-mid="reply"] button')]
      .find(button => button.title === "Jump to original message" || button.textContent === "Jump to original message");
    const quote = () => container.querySelector('[data-mid="reply"] [data-reply-quote]');
    await vi.waitFor(() => expect(quote()?.textContent).toContain("Original answer"));
    expect(jump()).toBeDefined();
    flushSync(() => jump()!.click());
    await vi.waitFor(() => expect(state.focusMessage).toMatchObject({ threadId: "a", messageId: "original", consumed: true }));
    expect(quote()?.textContent).toContain("Original answer");
  });

  it("opens the quoted message from another branch without changing the active transcript", async () => {
    const original: Message = { ...line("abandoned"), role: "bot", text: "Answer on the earlier branch" };
    const reply: Message = { ...line("reply"), at: 3, replyToId: original.id, text: "Current reply" };
    await mount(true, undefined, { pages: { "": { messages: [reply], hasMore: false } },
      quote: { message: original, onActivePath: false } });

    const quote = () => container.querySelector<HTMLButtonElement>('[data-mid="reply"] [data-reply-quote] button');
    await vi.waitFor(() => expect(quote()?.textContent).toContain("Answer on the earlier branch"));
    flushSync(() => quote()!.click());

    const originalDialog = container.querySelector<HTMLDialogElement>("dialog[open]");
    expect(originalDialog?.textContent).toContain("Answer on the earlier branch");
    expect(shown().activeLeafId).toBe("reply");
    expect(container.querySelector('[data-mid="abandoned"]')).toBeNull();
    expect(state.focusMessage).toBeFalsy();
  });

  it.each(["bot", "user"] as const)("opens the %s bubble context menu and replies from it", async role => {
    const answer: Message = { ...line("answer"), role, text: "A message" };
    await mount(true, undefined, { pages: { "": { messages: [answer], hasMore: false } } });
    await vi.waitFor(() => {
      const bubble = container.querySelector('[data-mid="answer"] [data-chat-bubble]');
      expect(bubble).not.toBeNull();
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
      flushSync(() => bubble!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    });
    const reply = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(item => item.textContent === "Reply");
    expect(reply).toBeDefined();
    flushSync(() => reply!.click());
    expect(container.querySelector("[data-composer-reply]")?.textContent).toContain(answer.text);
  });

  it("restores a reply to a paged message after switching away and back", async () => {
    const original: Message = { ...line("original"), role: "bot" };
    const latest = { ...line("latest"), at: 2, parentId: original.id, replyToId: original.id };
    await mount(true, undefined, { pages: {
      "": { messages: [latest], hasMore: true },
      latest: { messages: [original], hasMore: false },
    }, quote: { message: original, onActivePath: true } });
    const jump = () => container.querySelector<HTMLButtonElement>('[data-mid="latest"] button[title="Jump to original message"]');
    await vi.waitFor(() => expect(jump()).not.toBeNull());
    flushSync(() => jump()!.click());
    const reply = () => container.querySelector<HTMLButtonElement>('[data-mid="original"] button[aria-label="Reply to message"]');
    await vi.waitFor(() => expect(reply()).not.toBeNull());
    flushSync(() => reply()!.click());
    const clear = () => container.querySelector('button[aria-label="Cancel reply"]');
    expect(clear()).not.toBeNull();
    flushSync(() => dispatch({ type: "select", id: "room" }));
    flushSync(() => dispatch({ type: "select", id: "bot" }));
    await vi.waitFor(() => expect(clear()).not.toBeNull());
  });

  it.each([false, true])("places the unread divider when the read marker loads (older page: %s)", async older => {
    const read: Message = { ...line("read"), role: "bot" };
    const unread: Message = { ...line("unread"), parentId: read.id, at: 2, role: "bot", replyToId: read.id };
    await mount(true, undefined, {
      pages: {
        "": { messages: older ? [unread] : [read, unread], hasMore: older },
        unread: { messages: [read], hasMore: false },
      },
      quote: { message: read, onActivePath: true },
      lastReadMessageId: read.id,
    });
    expect(shown().messages).toEqual([]);
    flushSync(() => dispatch({ type: "select", id: "room" }));
    flushSync(() => dispatch({ type: "select", id: "bot" }));
    if (older) {
      const quote = () => container.querySelector<HTMLButtonElement>('[data-mid="unread"] button[title="Jump to original message"]');
      await vi.waitFor(() => expect(quote()).not.toBeNull());
      expect(container.querySelector("[data-unread-divider]")).toBeNull();
      flushSync(() => quote()!.click());
    }
    await vi.waitFor(() => expect(container.querySelector('[data-mid="unread"] [data-unread-divider]')?.getAttribute("aria-label")).toBe("New messages"));
    expect(container.querySelector('[data-mid="read"] [data-unread-divider]')).toBeNull();
  });

});
