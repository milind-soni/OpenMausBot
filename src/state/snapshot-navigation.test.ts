// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return null;
}
let root: Root;
let container: HTMLDivElement;
let snapshot: ReturnType<typeof deferred>;
let switchResponse: ReturnType<typeof deferred> | undefined;
let newTaskResponse: ReturnType<typeof deferred> | undefined;
let snapshots: number;
let sends: unknown[];
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

beforeEach(async () => {
  snapshots = 0;
  sends = [];
  snapshot = deferred();
  switchResponse = undefined;
  newTaskResponse = undefined;
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, String(value)); },
    removeItem: (key: string) => { stored.delete(key); }, clear: () => stored.clear(),
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) {
      snapshots++;
      return snapshots === 1 ? json({ bots: [bot("a")], groups: [room("a")] }) : snapshot.promise;
    }
    const task = path.match(/^\/api\/bots\/bot\/tasks\/([ab])/);
    if (task) return switchResponse?.promise ?? json({ bot: bot(task[1]!, `fresh-${task[1]}`) });
    if (path === "/api/bots/bot/tasks" || path === "/api/groups/room/tasks") return newTaskResponse?.promise ?? json({});
    if (path.startsWith("/api/groups/room/tasks/room-b")) return json({ group: room("b", "fresh-room-b") });
    if (path === "/api/bots/bot/messages" || path === "/api/groups/room/messages") sends.push(JSON.parse(String(init?.body)));
    if (path === "/api/instances") return json({ instances: [] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    return json({});
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  FixtureEventSource.current.send({ kind: "hello", resumed: false, cursor: "fixture:0" });
  await vi.waitFor(() => expect(state.hydrated).toBe(true));
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("navigation while a reconnect snapshot is in flight", () => {
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
    await applySnapshot();
    expect(shown().messages.map(message => message.id)).toEqual(["snapshot"]);
    expect(state.groups[0]?.messages.map(message => message.id)).toEqual(["fresh-room-b"]);
  });
});
