// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Group, Message } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const line = (id: string, threadId: string): Message => ({ id, role: "bot", kind: "text", text: `${threadId} ${id}`, at: 1 });
const tasks = ["one", "two", "three"].map((threadId, index) => ({ threadId, title: threadId, createdAt: index }));
const room = (threadId: string, messages?: Message[]) => ({
  id: "room", threadId, name: "Room", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "",
  unread: false, createdAt: 1, tasks, ...(messages ? { messages } : {}),
}) as unknown as Group;

const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};
const held = new Map<string, (body: unknown) => void>();
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answer = async (path: string, body: unknown) => {
  held.get(path)!(body);
  held.delete(path);
  await settle();
};

const { StoreProvider, useStore } = await import("./store");

let seen!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
let cursor = 0;
const send = async (frame: object) => {
  FixtureEventSource.opened[0].send(frame, `run:${++cursor}`);
  await settle();
};
const shown = () => seen.groups.find((group) => group.id === "room")!;
const switchTo = async (threadId: string) => {
  flushSync(() => dispatch({ type: "switchGroupTask", groupId: "room", threadId }));
  await settle();
};
const switchPath = (threadId: string) => `/api/groups/room/tasks/${threadId}?messages=200`;

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [], groups: [room("one", [line("o1", "one")])] });
    if (path.startsWith("/api/groups/")) {
      return new Promise<Response>((resolve) => { held.set(path, (body) => resolve(new Response(JSON.stringify(body)))); });
    }
    return json(answers[path] ?? {});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0].send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("switching a room's thread", () => {
  it("stays on the latest thread asked for when an earlier switch answers last", async () => {
    await switchTo("two");
    await switchTo("three");
    await answer(switchPath("three"), { group: room("three", [line("t1", "three")]) });
    await answer(switchPath("two"), { group: room("two", [line("w1", "two")]) });
    expect(shown().threadId).toBe("three");
    expect(shown().messages.map((message) => message.id)).toEqual(["t1"]);
  });

  it("keeps the shown thread when a status frame names another one without its transcript", async () => {
    await send({ kind: "group", group: { ...room("two"), working: true } });
    expect(shown().threadId).toBe("three");
    expect(shown().working).toBe(true);
    expect(shown().messages.map((message) => message.id)).toEqual(["t1"]);
  });

  it("keeps a message streamed after the live switch when the earlier HTTP snapshot lands", async () => {
    await switchTo("one");
    await send({ kind: "group", group: room("one", [line("o1", "one")]) });
    await send({ kind: "message", threadId: "one", message: line("o2", "one") });
    await answer(switchPath("one"), { group: room("one", [line("o1", "one"), line("gone", "one")]) });
    expect(shown().threadId).toBe("one");
    expect(shown().messages.map((message) => message.id)).toEqual(["o1", "o2"]);
  });

  it("keeps a message streamed while reopening the thread already shown", async () => {
    await switchTo("one");
    await send({ kind: "message", threadId: "one", message: line("o3", "one") });
    await answer(switchPath("one"), { group: room("one", [line("o1", "one"), line("o2", "one")]) });
    expect(shown().messages.map((message) => message.id)).toEqual(["o1", "o2", "o3"]);
  });

  it("keeps an edit streamed while the snapshot was out", async () => {
    await switchTo("one");
    await send({ kind: "message.patch", threadId: "one", message: { ...line("o2", "one"), text: "edited" } });
    await answer(switchPath("one"), { group: room("one", [line("o1", "one"), line("o2", "one"), line("o3", "one")]) });
    expect(shown().messages.map((message) => message.text)).toEqual(["one o1", "edited", "one o3"]);
  });

  it("keeps the first reply streamed into an empty thread while its snapshot was out", async () => {
    await switchTo("three");
    await answer(switchPath("three"), { group: room("three", []) });
    await switchTo("three");
    await send({ kind: "message", threadId: "three", message: line("t2", "three") });
    await answer(switchPath("three"), { group: room("three", []) });
    expect(shown().messages.map((message) => message.id)).toEqual(["t2"]);
  });

  it("shows a send once when the snapshot already confirms it", async () => {
    await switchTo("three");
    flushSync(() => dispatch({ type: "sendGroup", groupId: "room", text: "hello", sendId: "s1" }));
    await settle();
    expect(shown().messages.map((message) => message.id)).toEqual(["t2", "optimistic-s1"]);
    await answer(switchPath("three"), { group: room("three", [line("t2", "three"), { ...line("sent", "three"), role: "user", sendId: "s1" }]) });
    expect(shown().messages.map((message) => message.id)).toEqual(["t2", "sent"]);
  });

  it("still opens another thread's transcript whole", async () => {
    await switchTo("two");
    await answer(switchPath("two"), { group: room("two", [line("w1", "two")]) });
    expect(shown().threadId).toBe("two");
    expect(shown().messages.map((message) => message.id)).toEqual(["w1"]);
  });

  it("keeps an unconfirmed send that sits before every row the snapshot carries", async () => {
    await switchTo("one");
    await answer(switchPath("one"), { group: room("one", []) });
    await switchTo("one");
    flushSync(() => dispatch({ type: "sendGroup", groupId: "room", text: "hello", sendId: "s2" }));
    await settle();
    await send({ kind: "message", threadId: "one", message: line("r1", "one") });
    expect(shown().messages.map((message) => message.id)).toEqual(["optimistic-s2", "r1"]);
    await answer(switchPath("one"), { group: room("one", [line("r1", "one")]) });
    expect(shown().messages.map((message) => message.id)).toEqual(["r1", "optimistic-s2"]);
  });
});
