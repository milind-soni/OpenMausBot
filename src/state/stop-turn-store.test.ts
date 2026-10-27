// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import type { BotAnnouncement } from "./store";

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
const requests: Array<{ path: string; body: unknown }> = [];
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};

const { StoreProvider, useStore } = await import("./store");

let dispatch!: ReturnType<typeof useStore>["dispatch"];
function Probe() {
  dispatch = useStore().dispatch;
  return null;
}
let root: Root;
let now = 1_000_000;
let cursor = 0;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const stream = () => FixtureEventSource.opened.at(-1)!;
const send = async (frame: object) => {
  stream().send(frame, `run:${++cursor}`);
  await settle();
};
const stops = () => requests.filter((request) => request.path === "/api/bots/bot/interrupt").map((request) => request.body);

beforeAll(async () => {
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return path.startsWith("/api/bots?") ? json({ bots: [bot], groups: [] }) : json(answers[path] ?? { ok: true });
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Stop in the store", () => {
  it("names the turn the live frames say is running", async () => {
    await send({ kind: "runtime", event: { eventId: "e1", provider: "fake", threadId: "thread", turnId: "turn-1", createdAt: "", type: "turn.started" } } satisfies ServerFrame);
    dispatch({ type: "interrupt", botId: "bot", threadId: "thread" });
    await settle();
    expect(stops()).toEqual([{ threadId: "thread", turnId: "turn-1" }]);
  });

  it("forgets that turn when the stream restarts without the frames it missed", async () => {
    now += 5_000;
    stream().send({ kind: "hello", resumed: false, cursor: "run:50" });
    await settle();
    dispatch({ type: "interrupt", botId: "bot", threadId: "thread" });
    await settle();
    expect(stops().at(-1)).toEqual({ threadId: "thread" });
  });
});
