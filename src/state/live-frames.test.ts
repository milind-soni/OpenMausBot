// @vitest-environment happy-dom
// The app opens one live stream. A computer's live screen and raw runtime
// events reach the panel that reads them straight from that stream; the app
// store neither keeps them nor re-renders for them. The one thing a screen
// frame still tells the store: a computer that was setting up is up.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { ServerFrame } from "../../shared/wire";
import type { AppState, BotAnnouncement } from "./store";

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

const { StoreProvider, useStore } = await import("./store");
const { listenLiveFrames } = await import("@/lib/live-events");

let renders = 0;
let seen!: AppState;
function Probe() {
  seen = useStore().state;
  renders++;
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const stream = () => FixtureEventSource.opened[0];
let cursor = 0;
const send = async (frame: ServerFrame) => {
  stream().send(frame, `run:${++cursor}`);
  await settle();
};

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => path.startsWith("/api/bots?") ? json({ bots: [bot], groups: [] }) : json(answers[path] ?? {}));
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
});

describe("live frames the store does not keep", () => {
  it("come from the app's one stream", () => {
    expect(seen.bots.map((candidate) => candidate.id)).toEqual(["bot"]);
    expect(FixtureEventSource.opened.map((source) => source.url)).toEqual(["/api/events"]);
  });

  it("hand a screen frame to its listener without touching app state", async () => {
    const heard: ServerFrame[] = [];
    const stop = listenLiveFrames({ onFrame: (frame) => heard.push(frame) });
    const before = seen;
    const rendered = renders;
    await send({ kind: "screen", botId: "bot", threadId: "thread", png: "AAAA", mime: "image/jpeg" });
    stop();
    expect(heard).toEqual([{ kind: "screen", botId: "bot", threadId: "thread", png: "AAAA", mime: "image/jpeg" }]);
    expect(renders).toBe(rendered);
    expect(seen).toBe(before);
    expect("screens" in seen).toBe(false);
  });

  it("clear a computer's setting-up state with the first screen frame", async () => {
    await send({ kind: "computer", botId: "bot", state: "provisioning" });
    expect(seen.provisioning.bot).toBe(true);
    const mascot = seen.mascotMotion;
    await send({ kind: "screen", botId: "bot", threadId: "thread", png: "BBBB" });
    expect(seen.provisioning.bot).toBe(false);
    expect(seen.mascotMotion).toBe(mascot);
    // and every later frame is news only to the panel
    const before = seen;
    await send({ kind: "screen", botId: "bot", threadId: "thread", png: "CCCC" });
    expect(seen).toBe(before);
  });

  it("hand runtime events to listeners as they arrive", async () => {
    const heard: ServerFrame[] = [];
    const stop = listenLiveFrames({ onFrame: (frame) => heard.push(frame) });
    const event: RuntimeEvent = { type: "item.started", eventId: "e1", provider: "codex", threadId: "thread", createdAt: "2026-10-04T00:00:00.000Z", itemId: "i1", itemType: "tool", title: "ls" };
    await send({ kind: "runtime", event });
    stop();
    expect(heard).toEqual([{ kind: "runtime", event }]);
  });

  it("tell listeners when the stream could not replay what it missed", async () => {
    const missed = vi.fn();
    const stop = listenLiveFrames({ onFrame: () => {}, onMissedFrames: missed });
    stream().send({ kind: "hello", resumed: false, cursor: "run:99" });
    await settle();
    stop();
    expect(missed).toHaveBeenCalledTimes(1);
    expect(FixtureEventSource.opened).toHaveLength(1);
  });
});
