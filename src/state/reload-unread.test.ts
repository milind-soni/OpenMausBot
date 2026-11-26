// @vitest-environment happy-dom
// A reloaded page puts the last conversation back on screen by itself. Unread replies in it stay unread until the person
// opens a conversation in that page.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import { LAST_CONVERSATION_KEY } from "@/lib/last-conversation";
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

const owner = (id: string, updatedAt: number): BotAnnouncement => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true, unread: true, color: "green",
  modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Thread", createdAt: 1, updatedAt, approvalMode: "ask", unread: true }],
});
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};
const reads: Array<{ path: string; body: unknown }> = [];

const { StoreProvider, useStore } = await import("./store");
const { shownChatHeldUnread } = await import("./read-visible");

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
const announce = (bot: BotAnnouncement) => {
  stream().send({ kind: "bot", bot } as ServerFrame, `run:${++cursor}`);
  flushSync(() => dispatch({ type: "connected", value: true }));
};
const taskOf = (id: string) => seen.bots.find((bot) => bot.id === id)?.tasks?.[0];

beforeAll(async () => {
  vi.spyOn(document, "hasFocus").mockImplementation(() => true);
  localStorage.setItem(LAST_CONVERSATION_KEY, "shown");
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    if (/^\/api\/bots\/[\w-]+\/read$/.test(path)) {
      reads.push({ path, body: JSON.parse(String(init?.body)) });
      return json({});
    }
    return path.startsWith("/api/bots?")
      ? json({ bots: [owner("other", 1_000), owner("shown", 2_000)], groups: [] })
      : json(answers[path.replace(/\?since=[^&]*$/, "")] ?? { ok: true });
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
  localStorage.removeItem(LAST_CONVERSATION_KEY);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unread conversations after the page is reloaded", () => {
  it("leave the conversation put back on screen unread while the person has not opened one", async () => {
    expect(seen.selectedId).toBe("shown");
    expect(seen.activeView).toBe("chat");

    announce(owner("shown", 2_000));
    announce(owner("shown", 3_000));
    await settle();
    expect(reads, "no read is sent for a conversation only put back on screen").toEqual([]);
    expect(taskOf("shown")?.unread).toBe(true);
    expect(taskOf("other")?.unread).toBe(true);
    expect(shownChatHeldUnread(seen), "the window getting focus does not read it either").toBe(true);
  });

  it("read it once the person opens it", async () => {
    flushSync(() => dispatch({ type: "select", id: "shown" }));
    await settle();
    expect(reads.map((read) => read.path)).toEqual(["/api/bots/shown/read"]);
    expect(taskOf("shown")?.unread).toBe(false);
    expect(taskOf("other")?.unread, "another bot is untouched").toBe(true);
    expect(shownChatHeldUnread(seen)).toBe(false);
  });

  it("read a reply that arrives while it is open after that, as before", async () => {
    const start = reads.length;
    announce(owner("shown", 4_000));
    await settle();
    expect(reads.slice(start)).toEqual([{ path: "/api/bots/shown/read", body: { threadId: "shown-thread", reason: "seen" } }]);
  });
});
