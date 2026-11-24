// @vitest-environment happy-dom
// The real provider and its live stream: what the person does after "Mark as unread" on the open chat decides whether
// the next announcement of that chat is read.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Action, AppState, Bot } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const profile: Bot = {
  id: "B", name: "B", threadId: "main", title: "", description: "", color: "green", unread: false, notifications: true,
  messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [{ threadId: "main", title: "Main", createdAt: 1, updatedAt: 10 }],
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const { initialState, StoreProvider, useStore } = await import("./store");
const original = { bots: initialState.bots, selectedId: initialState.selectedId };

let seen!: AppState;
let dispatch!: (action: Action) => void;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  return null;
}
let root: Root;
let cursor = 0;
let reads: string[] = [];
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await task(); };
const paints: FrameRequestCallback[] = [];
const paint = async () => {
  for (const callback of paints.splice(0)) callback(performance.now());
  await settle();
};
const act = async (action: Action) => {
  flushSync(() => dispatch(action));
  await paint();
};
/** The server announcing the chat as unread, as it does after the mark and whenever the bot changes. */
const announceUnread = async (updatedAt = 10) => {
  const bot = { id: "B", unread: true, tasks: [{ threadId: "main", title: "Main", createdAt: 1, updatedAt, unread: true }] };
  FixtureEventSource.opened[0]!.send({ kind: "bot", bot, seq: ++cursor }, `run:${cursor}`);
  await paint();
};

beforeAll(async () => {
  Object.assign(initialState, { bots: [profile], selectedId: "B" });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const path = String(input).replace(/\?.*$/, "");
    if (path.endsWith("/read") && init?.method === "POST") reads.push(path);
    if (path === "/api/bots") return json({ bots: [profile], groups: [] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    return json({});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  await paint();
});
beforeEach(async () => {
  await act({ type: "showChat" });
  await act({ type: "select", id: "B" });
  await act({ type: "markUnread", botId: "B" });
  reads = [];
});
afterAll(() => {
  root.unmount();
  Object.assign(initialState, original);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the open chat unread while the server announces it", async () => {
  await announceUnread();
  await announceUnread();
  expect(reads).toEqual([]);
  expect(seen.bots[0]?.unread).toBe(true);
});

it("reads it again once a newer message arrives", async () => {
  await announceUnread(11);
  expect(reads).toEqual(["/api/bots/B/read"]);
});

it("stops holding it once the person opens a blank new chat", async () => {
  await act({ type: "newTask", botId: "B" });
  expect(seen.newChat?.botId).toBe("B");
  await announceUnread();
  expect(reads).toEqual(["/api/bots/B/read"]);
});

it("reads it again after the person went to Files and came back", async () => {
  await act({ type: "showFiles" });
  await announceUnread();
  expect(reads).toEqual([]);
  await act({ type: "showChat" });
  await announceUnread();
  expect(reads).toEqual(["/api/bots/B/read"]);
});
