// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDraft, setDraftAttachments } from "@/lib/drafts";
import { StoreProvider, useStore, type Action, type AppState, type Bot, type Message } from "./store";

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
const taskList = (...ids: string[]) => ids.map(threadId => ({ threadId, title: threadId, createdAt: 1 }));
const bot = (threadId: string, messages: Message[], overrides: Partial<Bot> = {}): Bot => ({
  id: "bot", threadId, name: "Fixture", title: "", description: "", notifications: false,
  unread: false, color: "green", modelSelection: { instanceId: "fake", model: "fixture" },
  tasks: taskList("a", "b", "c"), messages, activeLeafId: messages.at(-1)?.id ?? null, ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let state!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  ({ state, dispatch } = useStore());
  return null;
}
let root: Root;
let container: HTMLDivElement;
let deletes: string[];
let deleteStatus: number;
let created: Response[];
let stored: Map<string, string>;
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const shown = () => state.bots[0]!;
const open = async (threadId = "c") => {
  created.push(json({ bot: bot(threadId, []) }, 201));
  flushSync(() => dispatch({ type: "newTask", botId: "bot" }));
  await vi.waitFor(() => expect(shown().threadId).toBe(threadId));
};

beforeEach(async () => {
  deletes = [];
  deleteStatus = 200;
  created = [];
  stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, String(value)); },
    removeItem: (key: string) => { stored.delete(key); }, clear: () => stored.clear(),
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [bot("a", [line("a")], { tasks: taskList("a", "b") })], groups: [] });
    if (init?.method === "DELETE") { deletes.push(path); return json(deleteStatus === 200 ? {} : { error: "busy" }, deleteStatus); }
    if (path === "/api/bots/bot/tasks") return created.shift() ?? json({});
    const task = path.match(/^\/api\/bots\/bot\/tasks\/(\w)/);
    if (task) return json({ bot: bot(task[1]!, task[1] === "b" ? [] : [line(task[1]!)]) });
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
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("a new thread the person leaves without writing anything", () => {
  const leaving: [string, Action][] = [
    ["selecting another thread", { type: "switchTask", botId: "bot", threadId: "a" }],
    ["opening the routines view", { type: "showRoutines" }],
    ["starting another new thread", { type: "newTask", botId: "bot" }],
  ];

  it.each(leaving)("is deleted after %s", async (_name, action) => {
    await open();
    flushSync(() => dispatch(action));
    await vi.waitFor(() => expect(deletes).toEqual(["/api/bots/bot/tasks/c"]));
  });

  it("is deleted once, and a refused delete shows no error", async () => {
    deleteStatus = 409;
    await open();
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await vi.waitFor(() => expect(deletes).toHaveLength(1));
    await tick();
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "b" }));
    await tick();
    expect(deletes).toEqual(["/api/bots/bot/tasks/c"]);
    expect(state.error).toBeFalsy();
  });

  it("is kept when it was created with a working folder", async () => {
    created.push(json({ bot: bot("c", []) }, 201));
    flushSync(() => dispatch({ type: "newTask", botId: "bot", cwd: "/tmp/work" }));
    await vi.waitFor(() => expect(shown().threadId).toBe("c"));
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await vi.waitFor(() => expect(shown().threadId).toBe("a"));
    await tick();
    expect(deletes).toEqual([]);
  });

  it("is kept while it is still the selected thread", async () => {
    await open();
    flushSync(() => dispatch({ type: "showChat" }));
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "c" }));
    await tick();
    expect(deletes).toEqual([]);
  });

  it("is kept once a message has arrived", async () => {
    await open();
    FixtureEventSource.current.send({ kind: "message", threadId: "c", message: line("hello") });
    await vi.waitFor(() => expect(shown().messages).toHaveLength(1));
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await tick();
    expect(deletes).toEqual([]);
  });

  it("is kept while its composer holds a draft", async () => {
    await open();
    setDraft(localStorage, "bot:bot:c", "half a thought");
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await tick();
    expect(deletes).toEqual([]);
  });

  it("is kept while its composer holds an attachment", async () => {
    await open();
    setDraftAttachments(localStorage, "bot:bot:c", [{ kind: "file", id: "f", path: "/tmp/a.txt", name: "a.txt", size: 1 }]);
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await tick();
    expect(deletes).toEqual([]);
  });

  it("is kept while a turn is running", async () => {
    await open();
    FixtureEventSource.current.send({ kind: "bot", bot: bot("c", [], { busy: true }) });
    await vi.waitFor(() => expect(shown().busy).toBe(true));
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await tick();
    expect(deletes).toEqual([]);
  });

  it("is not deleted when it existed before this session, even if empty", async () => {
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "b" }));
    await vi.waitFor(() => expect(shown().threadId).toBe("b"));
    expect(shown().messages).toEqual([]);
    flushSync(() => dispatch({ type: "switchTask", botId: "bot", threadId: "a" }));
    await vi.waitFor(() => expect(shown().threadId).toBe("a"));
    await tick();
    expect(deletes).toEqual([]);
  });
});
