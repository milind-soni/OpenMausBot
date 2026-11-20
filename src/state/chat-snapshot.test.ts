// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { readChatSnapshot, SNAPSHOT_TAIL } from "./chat-snapshot";
import type { Action, AppState, BotAnnouncement, Message } from "./store";

const row = (thread: string, index: number): Message => ({ id: `${thread}-${index}`, at: index, role: index % 10 ? "bot" : "user", kind: "text", text: `${thread} ${index}`, parentId: index ? `${thread}-${index - 1}` : null } as Message);
const thread = (id: string, count: number) => Array.from({ length: count }, (_, index) => row(id, index));
const bot = (id: string, messages: Message[], hasMore: boolean): BotAnnouncement => ({
  id, threadId: `${id}-t`, name: id, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" }, tasks: [{ threadId: `${id}-t`, title: "Thread", createdAt: 1 }],
  messages, hasMore, activeLeafId: messages.at(-1)?.id ?? null,
} as BotAnnouncement);
const full = { a: thread("a-t", 400), b: thread("b-t", 400), c: thread("c-t", 400) };
const tailOf = (id: keyof typeof full) => bot(id, full[id].slice(-SNAPSHOT_TAIL), true);
const pageOf = (id: keyof typeof full) => bot(id, full[id].slice(-200), true);

describe("reading the first snapshot", () => {
  it("asks for one page of the conversation that may open and a tail of the rest", async () => {
    const read = vi.fn(async (path: string) => path.startsWith("/api/bots?") ? { bots: [tailOf("a"), pageOf("b")], groups: [] } : {});
    const snapshot = await readChatSnapshot(() => ({ selectedId: "" }), "b", read as never);
    expect(read.mock.calls.map(([path]) => path)).toEqual([`/api/bots?messages=200&tail=${SNAPSHOT_TAIL}&open=b`]);
    expect(snapshot.bots.map((sent) => sent.messages?.length)).toEqual([SNAPSHOT_TAIL, 200]);
  });

  it("fills the conversation it will open on before it is applied, whatever the server sent", async () => {
    const read = vi.fn(async (path: string) => path.startsWith("/api/bots?") ? { bots: [tailOf("a"), tailOf("b")], groups: [] }
      : { messages: full.a.slice(-200), hasMore: true, activeLeafId: "a-t-399" });
    const snapshot = await readChatSnapshot(() => ({ selectedId: "" }), "gone", read as never);
    expect(read.mock.calls.map(([path]) => path)).toEqual([`/api/bots?messages=200&tail=${SNAPSHOT_TAIL}&open=gone`, "/api/threads/a-t/messages?limit=200"]);
    expect(snapshot.bots[0]!.messages).toEqual(full.a.slice(-200));
    expect(snapshot.bots[1]!.messages).toHaveLength(SNAPSHOT_TAIL);
  });

  it("fills the conversation the person opened while the snapshot was on its way", async () => {
    let selectedId = "a";
    const read = vi.fn(async (path: string) => {
      if (path.startsWith("/api/bots?")) { selectedId = "c"; return { bots: [pageOf("a"), tailOf("b"), tailOf("c")], groups: [] }; }
      return { messages: full.c.slice(-200), hasMore: true, activeLeafId: "c-t-399" };
    });
    const snapshot = await readChatSnapshot(() => ({ selectedId }), undefined, read as never);
    expect(read.mock.calls.at(-1)![0]).toBe("/api/threads/c-t/messages?limit=200");
    expect(snapshot.bots[2]!.messages).toHaveLength(200);
  });

  it("asks once of a server that ignores tail", async () => {
    const old = vi.fn(async () => ({ bots: [pageOf("a"), pageOf("b")], groups: [] }));
    expect((await readChatSnapshot(() => ({ selectedId: "a" }), undefined, old as never)).bots[1]!.messages).toHaveLength(200);
    expect(old).toHaveBeenCalledTimes(1);
  });

  it("applies the tail when the page cannot be read, to be paged back once the snapshot lands", async () => {
    for (const error of [new ApiError("no such conversation", 404), new ApiError("unavailable", 503), new TypeError("offline")]) {
      const failing = vi.fn(async (path: string) => {
        if (path.startsWith("/api/bots?")) return { bots: [tailOf("a")], groups: [] };
        throw error;
      });
      expect((await readChatSnapshot(() => ({ selectedId: "a" }), undefined, failing as never)).bots[0]!.messages).toHaveLength(SNAPSHOT_TAIL);
    }
  });
});

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

describe("the store with a tailed snapshot", () => {
  const requests: string[] = [];
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  let seen!: AppState;
  let dispatch!: Dispatch<Action>;
  let root: Root;
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

  beforeAll(async () => {
    vi.stubGlobal("EventSource", FixtureEventSource);
    vi.stubGlobal("fetch", (path: string) => {
      requests.push(path);
      if (path.startsWith("/api/bots?")) return json({ bots: [pageOf("a"), tailOf("b")], groups: [] });
      const older = /^\/api\/threads\/b-t\/messages\?limit=200&before=(.+)$/.exec(path);
      if (older) {
        const at = full.b.findIndex((message) => message.id === decodeURIComponent(older[1]!));
        return json({ messages: full.b.slice(Math.max(0, at - 200), at), hasMore: at > 200 });
      }
      return json({});
    });
    const { StoreProvider, useStore } = await import("./store");
    function Probe() {
      ({ state: seen, dispatch } = useStore());
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
    await settle();
    FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" });
    await settle();
  });
  afterAll(() => {
    root.unmount();
    vi.unstubAllGlobals();
  });

  it("opens on a whole page, and pages a tailed conversation back in as soon as it opens", async () => {
    expect(requests.find((path) => path.startsWith("/api/bots?"))).toContain(`tail=${SNAPSHOT_TAIL}`);
    expect(seen.selectedId).toBe("a");
    expect(seen.bots.find((held) => held.id === "a")!.messages).toHaveLength(200);
    const before = seen.bots.find((held) => held.id === "b")!;
    expect(before.messages).toHaveLength(SNAPSHOT_TAIL);

    flushSync(() => dispatch({ type: "select", id: "b" }));
    await vi.waitFor(() => expect(seen.bots.find((held) => held.id === "b")!.messages).toHaveLength(200 + SNAPSHOT_TAIL));
    const after = seen.bots.find((held) => held.id === "b")!;
    expect(after.messages).toEqual(full.b.slice(-(200 + SNAPSHOT_TAIL)));
    expect(after.hasMore).toBe(true);
    expect(requests.filter((path) => path.startsWith("/api/threads/b-t/messages"))).toHaveLength(1);

    flushSync(() => dispatch({ type: "select", id: "a" }));
    flushSync(() => dispatch({ type: "select", id: "b" }));
    await settle();
    expect(requests.filter((path) => path.startsWith("/api/threads/b-t/messages"))).toHaveLength(1);
  });
});
