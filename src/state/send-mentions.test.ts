// @vitest-environment happy-dom
// A send asks with the ids of the bots picked from the @ list, in a room and in a one-to-one chat, and with none when
// nothing was picked. The desktop app and the web app share this store.
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Group } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const room = {
  id: "room", threadId: "room-thread", name: "Room", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "",
  unread: false, createdAt: 1, messages: [],
} as unknown as Group;
const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

const { StoreProvider, useStore } = await import("./store");

let dispatch!: Dispatch<Action>;
function Probe() {
  ({ dispatch } = useStore());
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const sent = async (action: Action) => {
  posted.length = 0;
  flushSync(() => dispatch(action));
  await settle();
  return posted.map(({ path, body }) => ({ path, mentions: body.mentions }));
};

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [], groups: [room] });
    if (init?.method === "POST" && path.endsWith("/messages")) {
      posted.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json({ ok: true, threadId: "elsewhere", queued: true, queueId: "q" });
    }
    return json({});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0].send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
beforeEach(() => { posted.length = 0; });
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("a send with bots picked from the @ list", () => {
  it("carries their ids into a room", async () => {
    expect(await sent({ type: "sendGroup", groupId: "room", text: "@Quill hi", sendId: "s1", mentions: ["quill-chief"] }))
      .toEqual([{ path: "/api/groups/room/messages", mentions: ["quill-chief"] }]);
  });

  it("carries them into a one-to-one chat", async () => {
    expect(await sent({ type: "send", botId: "scout", threadId: "scout-thread", text: "ask @Quill", sendId: "s2", mentions: ["quill-analyst"] }))
      .toEqual([{ path: "/api/bots/scout/messages", mentions: ["quill-analyst"] }]);
  });

  it("asks with no ids when none was picked", async () => {
    expect(await sent({ type: "sendGroup", groupId: "room", text: "@Quill hi", sendId: "s3", mentions: [] }))
      .toEqual([{ path: "/api/groups/room/messages", mentions: undefined }]);
    expect(await sent({ type: "send", botId: "scout", threadId: "scout-thread", text: "ask @Quill", sendId: "s4" }))
      .toEqual([{ path: "/api/bots/scout/messages", mentions: undefined }]);
  });
});
