import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { chunks, createChannel, createChannelStore, LINK_MAX_FAILURES, LINK_TTL_MS, MAX_LINKED_CHATS, WAITING_NOTE, type ChannelStore, type InboundMessage } from "./core.ts";

const TOKEN_A = "111:aaaa-secret";
const TOKEN_B = "222:bbbb-secret";
const A = "bot-a";
const B = "bot-b";
const CHAT = "9001";

let dir: string;
let store: ChannelStore;
let clock: number;
let delivered: Array<{ botId: string; threadId: string; text: string; sendId: string }>;
let sent: Array<{ token: string; chatId: string; text: string }>;
let paths: Map<string, Message[]>;
let threads: string[];
let sendFails: boolean;
let channel: ReturnType<typeof createChannel>;

const msg = (id: string, role: "user" | "bot", text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role, kind: "text", text, at: 0, ...extra }) as Message;
const inbound = (id: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({ id, chatId: CHAT, text, private: true, name: "Ada", ...extra });

async function link(botId = A, chatId = CHAT): Promise<string> {
  const { code } = channel.startLink(botId);
  await channel.handleInbound(botId, inbound(`link-${botId}-${chatId}`, `/start ${code}`, { chatId }));
  await channel.idle();
  return code;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-channel-"));
  store = createChannelStore(dir, "telegram");
  store.setToken(A, TOKEN_A, "bot_a_bot");
  store.setToken(B, TOKEN_B, "bot_b_bot");
  clock = 1_700_000_000_000;
  delivered = [];
  sent = [];
  paths = new Map();
  threads = [];
  sendFails = false;
  channel = createChannel({
    store,
    transport: { maxChars: 40, linkCommand: /^\/start(?:\s+(\S{1,64}))?$/i, strangerNote: "This bot only talks to its owner.", send: async (token, chatId, text) => { if (sendFails) return { ok: false, error: "refused" }; sent.push({ token, chatId, text }); return { ok: true }; } },
    threadTitle: "Telegram",
    prompt: "You are on Telegram.",
    bot: (botId) => (botId === A ? { id: A, name: "Scout" } : botId === B ? { id: B, name: "Mira" } : undefined),
    threadExists: (_botId, threadId) => threads.includes(threadId),
    createThread: (botId) => { const id = `${botId}-thread-${threads.length + 1}`; threads.push(id); paths.set(id, []); return id; },
    deliver: async (botId, threadId, text, sendId) => { delivered.push({ botId, threadId, text, sendId }); paths.get(threadId)!.push(msg(`u-${sendId}`, "user", text)); },
    activePath: (threadId) => paths.get(threadId) ?? [],
    needsInput: (message) => message.kind === "options",
    now: () => clock,
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the sealed store", () => {
  it("keeps each bot's token out of the file and readable only with the key", () => {
    const raw = readFileSync(join(dir, "telegram.json"), "utf8");
    expect(raw).not.toContain("secret");
    expect(store.token(A)).toBe(TOKEN_A);
    expect(store.token(B)).toBe(TOKEN_B);
    expect(store.connected().sort()).toEqual([A, B]);
    rmSync(join(dir, "telegram-key"));
    expect(store.token(A)).toBe("");
  });

  it("forgets a bot on remove", () => {
    store.remove(A);
    expect(store.connected()).toEqual([B]);
    expect(store.bot(A).sealedToken).toBeUndefined();
  });
});

describe("linking", () => {
  it("links a private chat with a live code, then hears it", async () => {
    await link();
    expect(sent).toEqual([{ token: TOKEN_A, chatId: CHAT, text: "You're connected to Scout. Message me here any time." }]);
    expect(store.bot(A).allowed).toEqual([CHAT]);
    expect(store.bot(A).chats[CHAT]?.name).toBe("Ada");
    expect(store.bot(A).link).toBeUndefined();
    await channel.handleInbound(A, inbound("m1", "hello"));
    expect(delivered).toEqual([{ botId: A, threadId: "bot-a-thread-1", text: "hello", sendId: "channel_m1" }]);
  });

  it("ignores a stranger, telling them once, and never a group", async () => {
    channel.startLink(A);
    await channel.handleInbound(A, inbound("s1", "hello", { chatId: "777" }));
    await channel.handleInbound(A, inbound("s2", "hello again", { chatId: "777" }));
    await channel.handleInbound(A, inbound("g1", "/start 123456", { chatId: "-100", private: false }));
    await channel.idle();
    expect(sent).toEqual([{ token: TOKEN_A, chatId: "777", text: "This bot only talks to its owner." }]);
    expect(delivered).toEqual([]);
    expect(store.bot(A).allowed).toEqual([]);
  });

  it("cancels the code after too many wrong tries, and refuses an expired one", async () => {
    const { code } = channel.startLink(A);
    for (let i = 0; i < LINK_MAX_FAILURES; i++) await channel.handleInbound(A, inbound(`w${i}`, "/start 000000"));
    await channel.handleInbound(A, inbound("right", `/start ${code}`));
    expect(store.bot(A).allowed).toEqual([]);
    const second = channel.startLink(A).code;
    clock += LINK_TTL_MS + 1;
    await channel.handleInbound(A, inbound("late", `/start ${second}`));
    expect(store.bot(A).allowed).toEqual([]);
    expect(store.linkPending(A, clock)).toBe(false);
  });

  it("keeps at most the newest linked chats", async () => {
    for (let i = 0; i <= MAX_LINKED_CHATS; i++) await link(A, `chat-${i}`);
    expect(store.bot(A).allowed).toEqual(["chat-1", "chat-2", "chat-3"]);
  });

  it("keeps bots apart: a chat linked to one bot is a stranger to the other, and each sends with its own token", async () => {
    await link(A);
    await channel.handleInbound(B, inbound("b1", "hello"));
    await channel.idle();
    expect(delivered).toEqual([]);
    expect(sent.at(-1)).toEqual({ token: TOKEN_B, chatId: CHAT, text: "This bot only talks to its owner." });
    await link(B);
    await channel.handleInbound(A, inbound("a1", "for scout"));
    await channel.handleInbound(B, inbound("b2", "for mira"));
    expect(delivered.map((entry) => [entry.botId, entry.threadId, entry.text])).toEqual([[A, "bot-a-thread-1", "for scout"], [B, "bot-b-thread-2", "for mira"]]);
  });
});

describe("a transport's own link command", () => {
  let texts: Array<{ chatId: string; text: string }>;
  let own: ReturnType<typeof createChannel>;
  beforeEach(() => {
    texts = [];
    own = createChannel({
      store, transport: { maxChars: 40, linkCommand: /^link\s+(\d{6})$/i, send: async (_token, chatId, text) => { texts.push({ chatId, text }); return { ok: true }; } },
      threadTitle: "iMessage", prompt: "", bot: (botId) => (botId === A ? { id: A, name: "Scout" } : undefined), threadExists: () => true,
      createThread: () => "t", deliver: async (_botId, _threadId, text) => { delivered.push({ botId: A, threadId: "t", text, sendId: "" }); }, activePath: () => [], needsInput: () => false, now: () => clock,
    });
  });

  it("links on the transport's words and not on Telegram's", async () => {
    const { code } = own.startLink(A);
    await own.handleInbound(A, inbound("w1", `/start ${code}`, { chatId: "+15550100" }));
    expect(store.bot(A).allowed).toEqual([]);
    await own.handleInbound(A, inbound("w2", `Link ${code}`, { chatId: "+15550100" }));
    await own.idle();
    expect(store.bot(A).allowed).toEqual(["+15550100"]);
    expect(texts).toEqual([{ chatId: "+15550100", text: "You're connected to Scout. Message me here any time." }]);
  });

  it("welcomes a linked chat that sends the command again instead of passing it to the bot", async () => {
    await link(A, "+15550100");
    await own.handleInbound(A, inbound("w3", "link 123456", { chatId: "+15550100" }));
    await own.idle();
    expect(delivered).toEqual([]);
    expect(texts.at(-1)?.text).toBe("You're connected to Scout. Message me here any time.");
  });

  it("stays silent to a stranger when the transport has no note for one, and still never hears them", async () => {
    await own.handleInbound(A, inbound("s1", "hello", { chatId: "+15550199" }));
    await own.handleInbound(A, inbound("s2", "hello?", { chatId: "+15550199" }));
    await own.idle();
    expect(texts).toEqual([]);
    expect(delivered).toEqual([]);
  });
});

describe("messages", () => {
  beforeEach(() => link());

  it("drops a redelivered message", async () => {
    await channel.handleInbound(A, inbound("m1", "hello"));
    await channel.handleInbound(A, inbound("m1", "hello"));
    expect(delivered).toHaveLength(1);
  });

  it("keeps one thread per chat, and /new starts another", async () => {
    await channel.handleInbound(A, inbound("m1", "one"));
    await channel.handleInbound(A, inbound("m2", "two"));
    await channel.handleInbound(A, inbound("n", "/new"));
    await channel.handleInbound(A, inbound("m3", "three"));
    await channel.idle();
    expect(delivered.map((entry) => entry.threadId)).toEqual(["bot-a-thread-1", "bot-a-thread-1", "bot-a-thread-2"]);
    expect(sent.at(-1)?.text).toBe("Started a new conversation with Scout.");
  });

  it("tells the chat when the bot could not take the message", async () => {
    const failing = createChannel({
      store, transport: { maxChars: 40, linkCommand: /^\/start$/i, send: async (token, chatId, text) => { sent.push({ token, chatId, text }); return { ok: true }; } },
      threadTitle: "Telegram", prompt: "", bot: () => ({ id: A, name: "Scout" }), threadExists: () => true,
      createThread: () => "t", deliver: async () => { throw new Error("the bot is busy"); }, activePath: () => [], needsInput: () => false, now: () => clock,
    });
    await failing.handleInbound(A, inbound("m9", "hello"));
    await failing.idle();
    expect(sent.at(-1)?.text).toBe("That didn't reach Scout: the bot is busy");
    expect(store.bot(A).lastError?.message).toContain("the bot is busy");
  });
});

describe("replies", () => {
  beforeEach(async () => {
    await link();
    await channel.handleInbound(A, inbound("m1", "hello"));
    sent = [];
  });

  it("sends what the bot said after the person's message, in order, and only once", async () => {
    const path = paths.get("bot-a-thread-1")!;
    path.push(msg("b1", "bot", "First."), msg("b2", "bot", "Second."));
    await channel.noteTurnCompleted("bot-a-thread-1");
    expect(sent.map((entry) => entry.text)).toEqual(["First.\n\nSecond."]);
    await channel.noteTurnCompleted("bot-a-thread-1");
    expect(sent).toHaveLength(1);
    path.push(msg("b3", "bot", "Third."));
    await channel.noteTurnCompleted("bot-a-thread-1");
    expect(sent.map((entry) => entry.text)).toEqual(["First.\n\nSecond.", "Third."]);
    expect(store.bot(A).chats[CHAT]?.lastSentMessageId).toBe("b3");
  });

  it("splits a long reply, caps the count and says where the rest is", async () => {
    const path = paths.get("bot-a-thread-1")!;
    path.push(msg("b1", "bot", Array.from({ length: 12 }, (_, i) => `Paragraph number ${i} of the reply.`).join("\n\n")));
    await channel.noteTurnCompleted("bot-a-thread-1");
    expect(sent).toHaveLength(5);
    expect(sent.every((entry) => entry.text.length <= 40)).toBe(true);
    expect(sent.at(-1)?.text).toBe("…the rest is in OpenMausBot.");
  });

  it("says when the bot waits for an approval in the app", async () => {
    paths.get("bot-a-thread-1")!.push(msg("c1", "bot", "", { kind: "options" }));
    await channel.noteTurnCompleted("bot-a-thread-1");
    expect(sent.map((entry) => entry.text)).toEqual([WAITING_NOTE]);
  });

  it("keeps the cursor when a send fails, so the reply goes out next time", async () => {
    paths.get("bot-a-thread-1")!.push(msg("b1", "bot", "First."));
    sendFails = true;
    await channel.noteTurnCompleted("bot-a-thread-1");
    expect(store.bot(A).chats[CHAT]?.lastSentMessageId).toBeUndefined();
    expect(store.bot(A).lastError?.message).toContain("refused");
    sendFails = false;
    await channel.noteTurnCompleted("bot-a-thread-1");
    expect(sent.map((entry) => entry.text)).toEqual(["First."]);
  });

  it("ignores any other thread, and the prompt part names only linked threads", async () => {
    paths.set("other", [msg("x", "bot", "Nope.")]);
    await channel.noteTurnCompleted("other");
    expect(sent).toEqual([]);
    expect(channel.prompt("bot-a-thread-1")).toBe("You are on Telegram.");
    expect(channel.prompt("other")).toBe("");
  });
});

describe("chunks", () => {
  it("cuts at paragraph, line or space ends and never above the limit", () => {
    const parts = chunks("aaaa bbbb\n\ncccc dddd eeee ffff\ngggg", 12);
    expect(parts).toEqual(["aaaa bbbb", "cccc dddd", "eeee ffff", "gggg"]);
    expect(chunks("x".repeat(30), 12)).toEqual(["x".repeat(12), "x".repeat(12), "x".repeat(6)]);
    expect(chunks("   ", 12)).toEqual([]);
  });
});
