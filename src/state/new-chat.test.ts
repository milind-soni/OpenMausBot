// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type Action, type AppState, type Bot, type Message } from "./store";
import { newChatBot, newChatThreadId } from "./new-chat";

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
const bot = (threadId: string, threads: string[]): Bot => ({
  id: "bot", threadId, name: "Pepper", title: "", description: "", notifications: false,
  unread: false, color: "green", modelSelection: { instanceId: "fake", model: "fixture" },
  tasks: threads.map((id) => ({ threadId: id, title: id, createdAt: 1 })), messages: [line(`said-in-${threadId}`)], activeLeafId: `said-in-${threadId}`,
});
const other: Bot = { ...bot("x", ["x"]), id: "other", name: "Other" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const DRAFT = newChatThreadId("bot");

let state!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  ({ state, dispatch } = useStore());
  return null;
}
let root: Root;
let container: HTMLDivElement;
let creates: Array<{ projectId?: string }>;
let sends: Array<{ threadId?: string; text: string }>;
let taskPatches: string[];
let createAnswer: Promise<Response> | null;
let switchAnswer: Promise<Response> | null;
let patchAnswer: Promise<Response> | null;

const send = (text: string, extra: Partial<Extract<Action, { type: "send" }>> = {}) =>
  flushSync(() => dispatch({ type: "send", botId: "bot", threadId: DRAFT, text, sendId: `send-${text}`, ...extra }));
const openBlank = (projectId?: string) => flushSync(() => dispatch({ type: "newTask", botId: "bot", ...(projectId ? { projectId } : {}) }));

beforeEach(async () => {
  creates = [];
  sends = [];
  taskPatches = [];
  createAnswer = null;
  switchAnswer = null;
  patchAnswer = null;
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, String(value)); },
    removeItem: (key: string) => { stored.delete(key); }, clear: () => stored.clear(),
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [bot("a", ["a"]), other], groups: [] });
    if (path === "/api/bots/bot/tasks") {
      creates.push(JSON.parse(String(init?.body)));
      return createAnswer ?? json({ bot: { ...bot("made", ["a", "made"]), messages: [] } }, 201);
    }
    if (path === "/api/bots/bot/messages") {
      const body = JSON.parse(String(init?.body));
      sends.push(body);
      return json({ threadId: body.threadId, message: { ...line(body.sendId), sendId: body.sendId } });
    }
    if (/^\/api\/bots\/bot\/tasks\/[^/]+$/.test(path) && init?.method === "PATCH") {
      taskPatches.push(path);
      if (patchAnswer) return patchAnswer;
    }
    if (path === "/api/bots/bot/tasks/a") return json({ bot: bot("a", ["a"]) });
    if (path.startsWith("/api/bots/bot/tasks/b")) return switchAnswer ?? json({ bot: bot("b", ["a", "b"]) });
    if (path === "/api/instances") return json({ instances: [] });
    if (path.startsWith("/api/routines?since=")) return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    return json({});
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  FixtureEventSource.current.send({ kind: "hello", resumed: false, cursor: "fixture:0" });
  await vi.waitFor(() => expect(state.hydrated).toBe(true));
  flushSync(() => dispatch({ type: "select", id: "bot" }));
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const pepper = () => state.bots.find((candidate) => candidate.id === "bot")!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a new conversation opens blank and is made by its first send", () => {
  it("opens a blank chat for the bot and makes nothing", async () => {
    openBlank();
    await settle();

    expect(creates).toEqual([]);
    expect(pepper().tasks?.map((task) => task.threadId)).toEqual(["a"]);
    expect(state.selectedId).toBe("bot");
    const shown = newChatBot(pepper(), state.newChat);
    expect(shown.threadId).toBe(DRAFT);
    expect(shown.messages).toEqual([]);
  });

  it("makes exactly one conversation on the first send and sends the message into it", async () => {
    openBlank();
    send("Plan my week");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(creates).toHaveLength(1);
    expect(sends[0]).toMatchObject({ threadId: "made", text: "Plan my week" });
    expect(pepper().threadId).toBe("made");
    expect(pepper().tasks?.map((task) => task.threadId)).toEqual(["a", "made"]);
    expect(state.newChat).toBeNull();
    expect(newChatBot(pepper(), state.newChat).threadId).toBe("made");
  });

  it("never sends the first message into the conversation that was open before", async () => {
    openBlank();
    send("First");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(sends.map((body) => body.threadId)).not.toContain("a");
  });

  it("sends a message aimed at the bot's open conversation into the blank chat that covers it", async () => {
    openBlank();
    flushSync(() => dispatch({ type: "send", botId: "bot", text: "No thread named", sendId: "unnamed" }));
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(creates).toHaveLength(1);
    expect(sends[0]).toMatchObject({ threadId: "made", text: "No thread named" });
  });

  it("stays open when a conversation switch started before it answers afterwards", async () => {
    let answer!: () => void;
    switchAnswer = new Promise((resolve) => { answer = () => resolve(json({ bot: bot("b", ["a", "b"]) })); });
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "b" }));
    openBlank();
    answer();
    await settle();

    expect(state.newChat?.botId).toBe("bot");
    expect(newChatBot(pepper(), state.newChat).threadId).toBe(DRAFT);
  });

  it("makes one conversation for sends that arrive while it is being made", async () => {
    let answer!: () => void;
    createAnswer = new Promise((resolve) => { answer = () => resolve(json({ bot: { ...bot("made", ["a", "made"]), messages: [] } }, 201)); });
    openBlank();
    send("one");
    send("two");
    await settle();
    answer();
    await vi.waitFor(() => expect(sends).toHaveLength(2));

    expect(creates).toHaveLength(1);
    expect(sends.map((body) => [body.threadId, body.text])).toEqual([["made", "one"], ["made", "two"]]);
  });

  it("leaves nothing behind when the person goes elsewhere without sending", async () => {
    openBlank();
    flushSync(() => dispatch({ type: "select", id: "other" }));
    flushSync(() => dispatch({ type: "select", id: "bot" }));
    await settle();

    expect(creates).toEqual([]);
    expect(state.newChat).toBeNull();
    expect(pepper().threadId).toBe("a");
    expect(pepper().tasks?.map((task) => task.threadId)).toEqual(["a"]);
    expect(newChatBot(pepper(), state.newChat).messages.map((message) => message.id)).toEqual(["said-in-a"]);
  });

  it.each<[string, Action]>([
    ["opens another conversation", { type: "switchTask", botId: "bot", threadId: "a" }],
    ["opens Routines", { type: "showRoutines" }],
    ["opens Files", { type: "showFiles" }],
  ])("closes the blank chat when the person %s", async (_, leave) => {
    openBlank();
    flushSync(() => dispatch(leave));
    await settle();

    expect(state.newChat).toBeNull();
    expect(creates).toEqual([]);
  });

  it("reuses the open blank chat for the same bot instead of opening another", () => {
    openBlank();
    flushSync(() => dispatch({ type: "setModel", botId: "bot", threadId: DRAFT, selection: { instanceId: "fake", model: "picked" } }));
    const first = state.newChat;
    openBlank();

    expect(state.newChat).toBe(first);
    expect(state.newChat?.held).toHaveLength(1);
    expect(creates).toEqual([]);
  });

  it("keeps a model picked in the blank chat for the conversation the first send makes", async () => {
    openBlank();
    const picked = { instanceId: "fake", model: "picked" };
    flushSync(() => dispatch({ type: "setModel", botId: "bot", threadId: DRAFT, selection: picked }));
    await settle();

    expect(taskPatches).toEqual([]);
    expect(pepper().modelSelection.model).toBe("fixture");
    expect(newChatBot(pepper(), state.newChat).modelSelection).toEqual(picked);

    send("Go");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(pepper().tasks?.find((task) => task.threadId === "made")?.modelSelection).toEqual(picked);
    await vi.waitFor(() => expect(taskPatches).toEqual(["/api/bots/bot/tasks/made"]));
  });

  it("keeps the conversation the person moved to while the first send was making one, and still sends into the new one", async () => {
    let answer!: () => void;
    createAnswer = new Promise((resolve) => { answer = () => resolve(json({ bot: { ...bot("made", ["a", "made"]), messages: [] } }, 201)); });
    openBlank();
    send("First");
    await settle();
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await vi.waitFor(() => expect(pepper().switchingTo).toBeUndefined());
    answer();
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(pepper().threadId).toBe("a");
    expect(sends[0]).toMatchObject({ threadId: "made", text: "First" });
  });

  it("applies a model picked while the first send is making the conversation", async () => {
    let answer!: () => void;
    createAnswer = new Promise((resolve) => { answer = () => resolve(json({ bot: { ...bot("made", ["a", "made"]), messages: [] } }, 201)); });
    const picked = { instanceId: "fake", model: "late" };
    openBlank();
    send("First");
    await settle();
    flushSync(() => dispatch({ type: "setModel", botId: "bot", threadId: DRAFT, selection: picked }));
    answer();
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(pepper().tasks?.find((task) => task.threadId === "made")?.modelSelection).toEqual(picked);
  });

  it("applies a model picked during creation even when the person left before it was made", async () => {
    let answer!: () => void;
    createAnswer = new Promise((resolve) => { answer = () => resolve(json({ bot: { ...bot("made", ["a", "made"]), messages: [] } }, 201)); });
    openBlank();
    send("First");
    await settle();
    flushSync(() => dispatch({ type: "setModel", botId: "bot", threadId: DRAFT, selection: { instanceId: "fake", model: "late" } }));
    flushSync(() => dispatch({ type: "select", id: "other" }));
    answer();
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    await vi.waitFor(() => expect(taskPatches).toEqual(["/api/bots/bot/tasks/made"]));
  });

  it("makes a separate conversation for a blank chat opened again while the last one's was still being made", async () => {
    let answer!: () => void;
    createAnswer = new Promise((resolve) => { answer = () => resolve(json({ bot: { ...bot("made", ["a", "made"]), messages: [] } }, 201)); });
    openBlank("folder-1");
    send("In folder one");
    await settle();
    flushSync(() => dispatch({ type: "select", id: "other" }));
    createAnswer = null;
    openBlank("folder-2");
    send("In folder two");
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    answer();
    await vi.waitFor(() => expect(sends).toHaveLength(2));

    expect(creates).toEqual([{ projectId: "folder-1" }, { projectId: "folder-2" }]);
  });

  it("makes the conversation in the folder the blank chat was opened from", async () => {
    openBlank("folder-1");
    send("Hi");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(creates).toEqual([{ projectId: "folder-1" }]);
  });

  it("gives the message back when the conversation cannot be made, and makes nothing", async () => {
    createAnswer = Promise.resolve(json({ error: "no room for another" }, 409));
    const failed = vi.fn();
    openBlank();
    send("Hi", { onError: failed });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));

    expect(sends).toEqual([]);
    expect(pepper().threadId).toBe("a");
    expect(state.newChat?.botId).toBe("bot");
  });

  it("makes the conversation for a Live call started in the blank chat and answers with it", async () => {
    const made = vi.fn();
    openBlank();
    flushSync(() => dispatch({ type: "makeNewChat", botId: "bot", threadId: DRAFT, onMade: made }));
    await vi.waitFor(() => expect(made).toHaveBeenCalledExactlyOnceWith("made"));

    expect(creates).toHaveLength(1);
    expect(sends).toEqual([]);
    expect(pepper().threadId).toBe("made");
    expect(state.newChat).toBeNull();
  });

  it("answers a Live call only after the settings picked in the blank chat are saved", async () => {
    let saved!: (response: Response) => void;
    patchAnswer = new Promise((resolve) => { saved = resolve; });
    const made = vi.fn();
    openBlank();
    flushSync(() => dispatch({ type: "updateTask", botId: "bot", threadId: DRAFT, patch: { approvalMode: "ask" } }));
    flushSync(() => dispatch({ type: "makeNewChat", botId: "bot", threadId: DRAFT, onMade: made }));
    await vi.waitFor(() => expect(taskPatches).toEqual(["/api/bots/bot/tasks/made"]));
    await settle();
    expect(made).not.toHaveBeenCalled();

    saved(json({ bot: bot("made", ["a", "made"]) }));
    await vi.waitFor(() => expect(made).toHaveBeenCalledExactlyOnceWith("made"));
  });

  it("never answers a Live call when the settings picked in the blank chat cannot be saved", async () => {
    patchAnswer = Promise.resolve(json({ error: "not saved" }, 500));
    const made = vi.fn();
    const failed = vi.fn();
    openBlank();
    flushSync(() => dispatch({ type: "updateTask", botId: "bot", threadId: DRAFT, patch: { approvalMode: "ask" } }));
    flushSync(() => dispatch({ type: "makeNewChat", botId: "bot", threadId: DRAFT, onMade: made, onError: failed }));
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    await settle();
    expect(taskPatches).toEqual(["/api/bots/bot/tasks/made"]);
    expect(made).not.toHaveBeenCalled();
  });

  it("tells a Live call from a blank chat that is no longer open that no conversation is coming", () => {
    const made = vi.fn();
    const failed = vi.fn();
    flushSync(() => dispatch({ type: "makeNewChat", botId: "bot", threadId: DRAFT, onMade: made, onError: failed }));
    expect(failed).toHaveBeenCalledOnce();
    expect(made).not.toHaveBeenCalled();
    expect(creates).toEqual([]);
  });

  it("makes one conversation for a Live call and a send that start together", async () => {
    const made = vi.fn();
    openBlank();
    flushSync(() => dispatch({ type: "makeNewChat", botId: "bot", threadId: DRAFT, onMade: made }));
    send("Hello");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(creates).toHaveLength(1);
    expect(made).toHaveBeenCalledExactlyOnceWith("made");
    expect(sends[0]).toMatchObject({ threadId: "made", text: "Hello" });
  });
});
