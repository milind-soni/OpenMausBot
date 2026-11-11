// @vitest-environment happy-dom
// A chat watched to the end ends read on the server too: unread frames that arrive while a read is in flight ask for
// exactly one more read once it finishes.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import type { Action, AppState, BotAnnouncement } from "./store";

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
const reads: Array<{ body: unknown; answer: () => void; fail: () => void }> = [];

const { StoreProvider, useStore } = await import("./store");

let seen!: AppState;
let dispatch!: (action: Action) => void;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  return null;
}
let root: Root;
let cursor = 0;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const stream = () => FixtureEventSource.opened.at(-1)!;
const unreadFrame = (): ServerFrame => ({
  kind: "bot",
  bot: { ...bot, unread: true, tasks: [{ ...bot.tasks![0]!, unread: true }] },
} as ServerFrame);
// Each frame is applied before the next arrives, as when they come in separate paints.
const sendUnread = () => {
  stream().send(unreadFrame(), `run:${++cursor}`);
  flushSync(() => dispatch({ type: "connected", value: true }));
};

beforeAll(async () => {
  vi.spyOn(document, "hasFocus").mockImplementation(() => true);
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    if (path === "/api/bots/bot/read") {
      return new Promise<Response>((resolve, reject) => {
        reads.push({ body: JSON.parse(String(init?.body)), answer: () => resolve(new Response("{}")), fail: () => reject(new Error("offline")) });
      });
    }
    return path.startsWith("/api/bots?") ? json({ bots: [bot], groups: [] }) : json(answers[path.replace(/\?since=[^&]*$/, "")] ?? { ok: true });
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "select", id: "bot" }));
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("marking the shown chat read while a read is in flight", () => {
  it("sends one more read after the first finishes, however many unread frames came meanwhile", async () => {
    expect(seen.selectedId).toBe("bot");
    expect(seen.activeView).toBe("chat");

    sendUnread();
    expect(reads.map((read) => read.body)).toEqual([{ threadId: "thread" }]);

    sendUnread();
    sendUnread();
    await settle();
    expect(reads, "nothing more is sent while the first read is open").toHaveLength(1);
    expect(seen.bots[0]!.tasks![0]!.unread, "the screen shows the chat read").toBeFalsy();

    reads[0]!.answer();
    await settle();
    expect(reads.map((read) => read.body)).toEqual([{ threadId: "thread" }, { threadId: "thread" }]);

    reads[1]!.answer();
    await settle();
    expect(reads, "one follow-up, not one per frame").toHaveLength(2);
  });

  it("sends the follow-up after a read that failed, too", async () => {
    const start = reads.length;
    sendUnread();
    sendUnread();
    expect(reads).toHaveLength(start + 1);
    reads[start]!.fail();
    await settle();
    expect(reads).toHaveLength(start + 2);
    reads[start + 1]!.answer();
    await settle();
    expect(reads).toHaveLength(start + 2);
  });

  it("sends no follow-up when no unread frame came while the read was open", async () => {
    const start = reads.length;
    sendUnread();
    expect(reads).toHaveLength(start + 1);
    reads[start]!.answer();
    await settle();
    expect(reads).toHaveLength(start + 1);
  });
});
