// @vitest-environment happy-dom
// The real provider and its live stream; animation frames run only when a test paints.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveCallState, ServerFrame } from "../../shared/wire";
import type { Action, AppState, BotAnnouncement, Message } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};

const paints: FrameRequestCallback[] = [];
let painting = false;
const { StoreProvider, useStore } = await import("./store");

let renders = 0;
let seen!: AppState;
let dispatch!: (action: Action) => void;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  renders++;
  return null;
}
let root: Root;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await task(); };
const paint = async () => {
  painting = true;
  for (const callback of paints.splice(0)) callback(performance.now());
  painting = false;
  await settle();
};
const stream = () => FixtureEventSource.opened[0]!;
let cursor = 0;
const message = (id: string): Message => ({ id, at: cursor, role: "bot", kind: "text", text: id } as Message);
const frame = (id: string): ServerFrame => ({ kind: "message", threadId: "thread", message: message(id) } as ServerFrame);
const ids = () => seen.bots.find((candidate) => candidate.id === "bot")!.messages.map((one) => one.id);

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { if (!painting) paints.splice(id - 1, 1, () => {}); });
  vi.stubGlobal("fetch", (path: string) => path.startsWith("/api/bots?") ? json({ bots: [bot], groups: [] }) : json(answers[path.replace(/\?since=[^&]*$/, "")] ?? {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  await paint();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await paint();
});

describe("live frames reach the screen once per paint", () => {
  it("draws a burst of frames that arrived in separate tasks in one render, in arrival order", async () => {
    const before = renders;
    const start = ids().length;
    for (let i = 0; i < 10; i++) {
      stream().send(frame(`burst-${i}`), `run:${++cursor}`);
      await task();
    }
    expect(renders, "nothing renders before the paint").toBe(before);
    await paint();
    expect(renders).toBe(before + 1);
    expect(ids().slice(start)).toEqual(Array.from({ length: 10 }, (_, i) => `burst-${i}`));
  });

  it("applies frames that arrived before an action ahead of it", async () => {
    const start = ids().length;
    stream().send(frame("from-stream"), `run:${++cursor}`);
    await task();
    flushSync(() => dispatch({ type: "messageAdded", threadId: "thread", message: message("from-action") }));
    expect(ids().slice(start)).toEqual(["from-stream", "from-action"]);
  });

  it("draws a live call at once, with every frame queued before it", () => {
    const start = ids().length;
    const call = { callId: "c1", botId: "bot", threadId: "thread", client: "desktop", voice: "vo", startedAt: 1, status: "live" } as LiveCallState;
    stream().send(frame("before-call"), `run:${++cursor}`);
    stream().send({ kind: "live.call", botId: "bot", threadId: "thread", call }, `run:${++cursor}`);
    expect(seen.liveCall).toEqual(call);
    expect(ids().slice(start)).toEqual(["before-call"]);
  });
});
