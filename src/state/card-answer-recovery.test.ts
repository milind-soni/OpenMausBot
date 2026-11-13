// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, BotAnnouncement, Group, Message } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const question = (id: string): Message => ({
  id, role: "bot", kind: "options", at: 1,
  card: { title: "Which one?", subtitle: "", options: ["Left", "Right"], requestId: `request-${id}`, requestType: "question" },
});
const choice = (id: string): Message => ({
  id, role: "bot", kind: "options", at: 1,
  card: { title: "Choose", subtitle: "", options: ["Left", "Right"] },
});
const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1 }],
  messages: [question("ask"), question("again"), choice("choice")],
};
const room = {
  id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"], defaultResponder: { kind: "mentions" }, bulletin: "",
  unread: false, createdAt: 1, messages: [question("room-ask")],
} as unknown as Group;

const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};
let respond: () => Promise<Response>;
const requests: string[] = [];
const cardWrites: Array<{ path: string; body: Record<string, unknown> }> = [];
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

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
const card = (owner: { messages: Message[] } | undefined, id: string) => owner?.messages.find((message) => message.id === id)?.card;
const botCard = (id: string) => card(seen.bots.find((candidate) => candidate.id === "bot"), id);
const roomCard = (id: string) => card(seen.groups.find((candidate) => candidate.id === "room"), id);

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, options?: RequestInit) => {
    requests.push(path);
    if (path.includes("/cards/") && options?.body) cardWrites.push({ path, body: JSON.parse(String(options.body)) });
    if (path.startsWith("/api/bots?")) return json({ bots: [bot], groups: [room] });
    if (path.startsWith("/api/threads/bot-fork/messages?")) return json({ messages: [question("ask")], activeLeafId: "ask", hasMore: false });
    if (path.startsWith("/api/threads/room-fork/messages?")) return json({ messages: [question("room-ask")], activeLeafId: "room-ask", hasMore: false });
    if (path.startsWith("/api/threads/choice-fork/messages?")) return json({ messages: [choice("choice")], activeLeafId: "choice", hasMore: false });
    if (path.endsWith("/respond")) return respond();
    return json(answers[path.replace(/\?since=[^&]*$/, "")] ?? {});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0].send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
beforeEach(() => {
  respond = () => json({ error: "the bot is busy" }, 500);
  requests.length = 0;
  cardWrites.length = 0;
  flushSync(() => dispatch({ type: "closeForkPanel" }));
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("answering a waiting card", () => {
  it("brings the choices back when the answer could not be sent", async () => {
    expect(botCard("ask")?.answered).toBeUndefined();
    flushSync(() => dispatch({ type: "answerCard", botId: "bot", threadId: "thread", messageId: "ask", answer: "Left" }));
    expect(botCard("ask")?.answered).toBe("Left");
    await settle();
    expect(botCard("ask")?.answered).toBeUndefined();
  });

  it("does the same for a card in a room", async () => {
    flushSync(() => dispatch({ type: "answerCard", botId: "bot", groupId: "room", threadId: "room-thread", messageId: "room-ask", answer: "Right" }));
    expect(roomCard("room-ask")?.answered).toBe("Right");
    await settle();
    expect(roomCard("room-ask")?.answered).toBeUndefined();
  });

  it.each([
    { kind: "bot" as const, ownerId: "bot", threadId: "bot-fork", messageId: "ask", groupId: undefined },
    { kind: "group" as const, ownerId: "room", threadId: "room-fork", messageId: "room-ask", groupId: "room" },
  ])("answers and reopens a failed card in the $kind fork without changing the main conversation", async ({ kind, ownerId, threadId, messageId, groupId }) => {
    flushSync(() => dispatch({ type: "openForkPanel", kind, ownerId, threadId }));
    await settle();
    expect(seen.forkPanel?.messages[0]?.id).toBe(messageId);
    flushSync(() => dispatch({ type: "answerCard", botId: "bot", groupId, threadId, messageId, answer: "Left" }));
    expect(card(seen.forkPanel ?? undefined, messageId)?.answered).toBe("Left");
    expect(botCard("ask")?.answered).toBeUndefined();
    expect(roomCard("room-ask")?.answered).toBeUndefined();
    expect(requests).not.toContain(`/api/threads/${threadId}/respond`);
    await settle();
    expect(requests).toContain(`/api/threads/${threadId}/respond`);
    expect(card(seen.forkPanel ?? undefined, messageId)?.answered).toBeUndefined();
    expect(botCard("ask")?.answered).toBeUndefined();
    expect(roomCard("room-ask")?.answered).toBeUndefined();
  });

  it("settles a choice in the bot fork without settling the copied card in the main chat", async () => {
    flushSync(() => dispatch({ type: "openForkPanel", kind: "bot", ownerId: "bot", threadId: "choice-fork" }));
    await settle();
    flushSync(() => dispatch({ type: "answerCard", botId: "bot", threadId: "choice-fork", messageId: "choice", answer: "Right" }));
    expect(card(seen.forkPanel ?? undefined, "choice")).toMatchObject({ answered: "Right", dismissed: true });
    expect(botCard("choice")?.answered).toBeUndefined();
    await settle();
    expect(cardWrites).toContainEqual({ path: "/api/bots/bot/cards/choice",
      body: { answered: "Right", dismissed: true, threadId: "choice-fork" } });
    expect(requests).toContain("/api/bots/bot/messages");
  });

  it("keeps a card the server settled while the failed request was out", async () => {
    let fail!: () => void;
    respond = () => new Promise((resolve) => { fail = () => resolve(new Response(JSON.stringify({ error: "gone" }), { status: 409 })); });
    flushSync(() => dispatch({ type: "answerCard", botId: "bot", threadId: "thread", messageId: "again", answer: "Left" }));
    await settle();
    await send({ kind: "message.patch", threadId: "thread", message: { ...question("again"), card: { ...question("again").card, answered: "answer", answeredText: "Right" } } });
    fail();
    await settle();
    expect(botCard("again")).toMatchObject({ answered: "answer", answeredText: "Right" });
  });
});
