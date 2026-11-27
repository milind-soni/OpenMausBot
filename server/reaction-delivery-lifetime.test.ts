import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { cancelledChatFollowup } from "./message-db.ts";
import { createPersonReplies } from "./person-replies.ts";
import { createReactions } from "./reactions.ts";
import type { RequestAuth } from "./request-auth.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { queueSteeredMessage, queuedSteeredMessage, restoreSteeredMessages } from "./steer-queue.ts";
import { Store } from "./store.ts";

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); restoreSteeredMessages(); });

function harness(queued = true, inbox = false) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Scout" });
  const asked = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Shall I send the email?" });
  const entered = deferred(), release = deferred(), sends: string[] = [];
  const replies = createPersonReplies({
    store, sendSequencer: new SendSequencer(),
    assertWithinBudget() {}, messageSender: () => undefined, usageTriggerFor: () => ({ kind: "user" }),
    groupThreadIsWorking: () => false, startGroupTurn: () => {},
    async startOrQueueDirectMessage(botId, threadId, text, target, sendId) {
      sends.push(sendId);
      if (sends.length === 1) { entered.resolve(); await release.promise; }
      if (!queued) { store.appendMessage(threadId, { role: "user", kind: "text", text, sendId }); return {}; }
      queueSteeredMessage(botId, threadId, text, { sendId, replyToId: target.id, reaction: target.reactedWith });
      return { queued: true };
    },
  });
  const deliver = (input: Parameters<typeof replies.deliver>[0]) => replies.deliver(input);
  const reactions = createReactions({
    store, reply: (input) => deliver({ ...input, about: "message" }), inboxAnswer: (input) => inbox ? deliver({ ...input, about: "message" }) : null,
    answerCard: async () => ({ ok: true }), withdraw: replies.withdraw,
  });
  const tap = (emoji: "👍" | "👎", by = "user") => reactions.react({ auth: OWNER, threadId: bot.threadId, messageId: asked.id, emoji, reactor: { by } });
  return { bot, store, tap, entered, release, sends };
}

it("withdraws a queued answer that finishes after its reaction was cleared", async () => {
  const h = harness();
  const first = h.tap("👍");
  await h.entered.promise;
  expect((await h.tap("👍")).delivery).toBe("none");
  h.release.resolve();
  const result = await first;
  expect(queuedSteeredMessage(h.bot.id, h.bot.threadId, h.sends[0]!)).toBeNull();
  expect(result.delivery).toBe("none");
  expect(cancelledChatFollowup("bot", h.bot.id, h.bot.threadId, h.sends[0]!)).toBe(true);
  restoreSteeredMessages();
  expect(queuedSteeredMessage(h.bot.id, h.bot.threadId, h.sends[0]!)).toBeNull();
});

it("retires an older 👍 still on its way when the person switches to a quiet 👎", async () => {
  const h = harness();
  const first = h.tap("👍");
  await h.entered.promise;
  expect((await h.tap("👎")).delivery).toBe("noted");
  h.release.resolve();
  expect((await first).delivery).toBe("none");
  expect(queuedSteeredMessage(h.bot.id, h.bot.threadId, h.sends[0]!)).toBeNull();
  expect(h.sends).toHaveLength(1);
});

it("does not let another person's quiet 👎 retire this person's 👍", async () => {
  const h = harness();
  const first = h.tap("👍", "alice");
  await h.entered.promise;
  expect((await h.tap("👎", "bob")).delivery).toBe("noted");
  h.release.resolve();
  expect((await first).delivery).toBe("queued");
  expect(h.sends.map((id) => queuedSteeredMessage(h.bot.id, h.bot.threadId, id)?.text)).toEqual(["👍"]);
});

it("on an inbox line, keeps a newer opposite answer when the older queued answer finishes last", async () => {
  const h = harness(true, true);
  const first = h.tap("👍");
  await h.entered.promise;
  expect((await h.tap("👎")).delivery).toBe("queued");
  h.release.resolve();
  const result = await first;
  expect(queuedSteeredMessage(h.bot.id, h.bot.threadId, h.sends[0]!)).toBeNull();
  expect(result.delivery).toBe("none");
  expect(queuedSteeredMessage(h.bot.id, h.bot.threadId, h.sends[1]!)?.text).toBe("👎");
});

it("on an inbox line, does not let another person's answer retire this person's answer", async () => {
  const h = harness(true, true);
  const first = h.tap("👍", "alice");
  await h.entered.promise;
  expect((await h.tap("👎", "bob")).delivery).toBe("queued");
  h.release.resolve();
  expect((await first).delivery).toBe("queued");
  expect(h.sends.map((id) => queuedSteeredMessage(h.bot.id, h.bot.threadId, id)?.text)).toEqual(["👍", "👎"]);
});

it("still reports an answer that already started as started", async () => {
  const h = harness(false);
  const first = h.tap("👍");
  await h.entered.promise;
  await h.tap("👍");
  h.release.resolve();
  expect((await first).delivery).toBe("started");
  expect(h.store.messagesFor(h.bot.threadId).at(-1)?.sendId).toBe(h.sends[0]);
});
