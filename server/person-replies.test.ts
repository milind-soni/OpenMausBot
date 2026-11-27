import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { queuedChannelMessage, queueChannelMessage } from "./channel-queue.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { createPersonReplies, type PersonReplyDeps } from "./person-replies.ts";
import type { RequestAuth } from "./request-auth.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { drainSteeredMessages, queuedSteeredMessage, queueSteeredMessage } from "./steer-queue.ts";
import { Store, type Message } from "./store.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function fixture(options: { busy?: boolean; roomWorking?: boolean } = {}) {
  const store = new Store(() => sonnet);
  const scout = store.createBot({ name: "Scout" });
  const otter = store.createBot({ name: "Otter" });
  const room = store.createGroup("Launch", [scout.id, otter.id]);
  const calls = { direct: [] as unknown[][], room: [] as unknown[][] };
  const deps: PersonReplyDeps = {
    store,
    sendSequencer: new SendSequencer(),
    assertWithinBudget: () => {},
    messageSender: () => undefined,
    usageTriggerFor: () => ({ kind: "user" }),
    groupThreadIsWorking: () => options.roomWorking === true,
    startGroupTurn: (...args) => {
      calls.room.push(args);
      return store.appendMessage(args[6].threadId, { role: "user", kind: "text", text: args[1], replyToId: args[2].id, reaction: args[2].reactedWith, sendId: args[3] });
    },
    startOrQueueDirectMessage: async (...args) => {
      calls.direct.push(args);
      const [botId, threadId, text, replyTo, sendId] = args;
      if (options.busy) {
        queueSteeredMessage(botId, threadId, text, { replyToId: replyTo.id, sendId, reaction: replyTo.reactedWith });
        return { queued: true };
      }
      store.appendMessage(threadId, { role: "user", kind: "text", text, replyToId: replyTo.id, reaction: replyTo.reactedWith, sendId });
      return {};
    },
  };
  const replies = createPersonReplies(deps);
  const asked = (threadId: string, from?: Message["from"]) =>
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "Shall I send it?", ...(from ? { from } : {}) });
  return { store, scout, otter, room, calls, replies, asked };
}

describe("a person's one-tap reply", () => {
  it("starts the bot's turn in its own conversation with the reaction as the reply, once per sendId", async () => {
    const { store, scout, calls, replies, asked } = fixture();
    const target = { ...asked(scout.threadId), reactedWith: "👍" };
    const reply = { auth: OWNER, threadId: scout.threadId, owner: scout, target, answer: "👍", sendId: "reaction-0123456789abcdef", about: "message" as const };
    expect(await replies.deliver(reply)).toEqual({ queued: false });
    expect(await replies.deliver(reply)).toEqual({ queued: false, repeated: true });
    expect(calls.direct).toHaveLength(1);
    expect(calls.direct[0]!.slice(0, 5)).toEqual([scout.id, scout.threadId, "👍", target, "reaction-0123456789abcdef"]);
    expect(store.messagesFor(scout.threadId).at(-1)).toMatchObject({ role: "user", text: "👍", replyToId: target.id, reaction: "👍" });
  });

  it("addresses the writer by name in a room, and waits in the room's queue while it works", async () => {
    const { otter, room, calls, replies, asked } = fixture({ roomWorking: true });
    const target = { ...asked(room.threadId, { botId: otter.id, name: otter.name, color: otter.color }), reactedWith: "👎" };
    const sendId = "reaction-fedcba9876543210";
    expect(await replies.deliver({ auth: OWNER, threadId: room.threadId, owner: otter, target, answer: "👎", sendId, about: "message" })).toEqual({ queued: true });
    expect(queuedChannelMessage(room.id, room.threadId, sendId)).toMatchObject({ text: "@Otter: 👎", replyToId: target.id, mode: "chat", reaction: "👎" });
    expect(calls.room).toEqual([]);
  });

  it("starts a room turn addressed to the writer when the room is free", async () => {
    const { store, otter, room, calls, replies, asked } = fixture();
    const target = { ...asked(room.threadId, { botId: otter.id, name: otter.name, color: otter.color }), reactedWith: "👍" };
    await replies.deliver({ auth: OWNER, threadId: room.threadId, owner: otter, target, answer: "👍", sendId: "reaction-00112233445566778899", about: "message" });
    expect(calls.room[0]!.slice(1, 5)).toEqual(["@Otter: 👍", target, "reaction-00112233445566778899", "chat"]);
    expect(store.messagesFor(room.threadId).at(-1)).toMatchObject({ text: "@Otter: 👍", reaction: "👍" });
  });

  it("refuses a reply to a bot that left the room", async () => {
    const { store, room, replies, asked } = fixture();
    const loner = store.createBot({ name: "Loner" });
    const target = asked(room.threadId, { botId: loner.id, name: loner.name, color: loner.color });
    await expect(replies.deliver({ auth: OWNER, threadId: room.threadId, owner: loner, target, answer: "👍", sendId: "reaction-aabbccddeeff0011", about: "message" }))
      .rejects.toMatchObject({ status: 409, message: "the bot that wrote this message is no longer in this conversation" });
  });

  it("takes back a reply that still waits in a queue, in a conversation and in a room", async () => {
    const { scout, otter, room, replies, asked } = fixture();
    queueSteeredMessage(scout.id, scout.threadId, "👍", { replyToId: asked(scout.threadId).id, sendId: "reaction-direct-0123456789" });
    queueChannelMessage(room.id, room.threadId, "@Otter: 👍", { sendId: "reaction-room-0123456789", mode: "chat" });
    replies.withdraw(scout.threadId, scout, "reaction-direct-0123456789");
    replies.withdraw(room.threadId, otter, "reaction-room-0123456789");
    expect(queuedSteeredMessage(scout.id, scout.threadId, "reaction-direct-0123456789")).toBeNull();
    expect(queuedChannelMessage(room.id, room.threadId, "reaction-room-0123456789")).toBeNull();
    replies.withdraw(scout.threadId, scout, "reaction-never-queued-01");
  });

  it("keeps a late question answer's own refusal when the card was answered meanwhile", async () => {
    const { store, scout, replies } = fixture();
    const card = store.appendMessage(scout.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Send it?", options: ["Yes", "No"], requestId: "q1", requestType: "question", answered: "Yes" } });
    await expect(replies.deliverLateQuestionAnswer(OWNER, scout.threadId, "q1", "Yes", card, scout))
      .rejects.toMatchObject({ status: 409, message: "this question has already been answered" });
  });
});

describe("a queued reaction line", () => {
  it("keeps its reaction when the queue hands it to the next turn", () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" });
    queueSteeredMessage(bot.id, bot.threadId, "👍", { replyToId: "m1", sendId: "reaction-queued-0123456789", reaction: "👍" });
    const drained: Message[] = [];
    drainSteeredMessages(store, (_botId, _threadId, _prompt, userMessage) => { drained.push(userMessage); });
    expect(drained).toEqual([expect.objectContaining({ text: "👍", replyToId: "m1", reaction: "👍" })]);
  });
});
