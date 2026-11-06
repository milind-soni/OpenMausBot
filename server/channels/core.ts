// A chat app as a way to talk to one MausBot bot, on the person's own account. The core is the same for every chat app:
// only chats the person linked with a one-time code are heard, each linked chat has one thread on the bot, and every
// finished turn in that thread is sent back. A transport (telegram.ts, sendblue.ts) carries the messages and knows nothing else.
// Tokens are sealed with a 0600 key file no backup carries, as webhooks.ts does for webhook secrets.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { redactSecretsInText } from "../../shared/redact.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { Message } from "../store.ts";

export const MAX_LINKED_CHATS = 3;
export const LINK_TTL_MS = 10 * 60_000;
/** Wrong codes allowed before the code is cancelled, so a 6-digit code can't be guessed while it is open. */
export const LINK_MAX_FAILURES = 5;
export const MAX_MESSAGES_PER_REPLY = 5;
const SEEN_MAX = 500;
export const WAITING_NOTE = "The bot is waiting for your OK in OpenMausBot. Open the app to answer it.";

export interface InboundMessage {
  /** Unique per bot: the transport's own id, so a redelivery is dropped. */
  id: string;
  chatId: string;
  /** What to call the chat's person when it links. */
  name?: string;
  text: string;
  /** A one-to-one chat with the bot: only such a chat may link. */
  private: boolean;
}

export type SendResult = { ok: true } | { ok: false; error: string };

export interface ChannelTransport {
  maxChars: number;
  /** The message that carries a link code, the code in group 1. A chat already linked that sends it is welcomed again. */
  linkCommand: RegExp;
  /** What a chat that is not linked is told, once. Absent: it is not answered at all. */
  strangerNote?: string;
  send(token: string, chatId: string, text: string): Promise<SendResult>;
}

const chatSchema = z.object({
  name: z.string().optional(),
  threadId: z.string().optional(),
  /** The newest bot message already sent to this chat; replies resume after it. */
  lastSentMessageId: z.string().optional(),
});

const botSchema = z.object({
  sealedToken: z.string().optional(),
  /** What the transport calls the account: Telegram's bot username, Sendblue's phone number. */
  username: z.string().optional(),
  allowed: z.array(z.string()).default([]),
  chats: z.record(z.string(), chatSchema).default({}),
  /** The transport's reading position, kept so a restart reads nothing twice. */
  cursor: z.number().optional(),
  seen: z.array(z.string()).default([]),
  link: z.object({ codeHash: z.string(), expiresAt: z.number(), failures: z.number().default(0) }).optional(),
  lastError: z.object({ at: z.number(), message: z.string() }).optional(),
});

const fileSchema = z.record(z.string(), botSchema);

export type BotChannelState = z.output<typeof botSchema>;
export type ChatState = z.output<typeof chatSchema>;

export function createChannelStore(dataDir: string, name: string) {
  const file = join(dataDir, `${name}.json`);
  const keyFile = join(dataDir, `${name}-key`);
  const hashCode = (code: string) => createHash("sha256").update(`${name}-link:${code}`).digest("hex");

  function load(): Record<string, BotChannelState> {
    try {
      return fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return {};
    }
  }

  function save(all: Record<string, BotChannelState>): void {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }

  function key(create: boolean): Buffer | null {
    try {
      const hex = readFileSync(keyFile, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    } catch {
    }
    if (!create) return null;
    const fresh = randomBytes(32);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(keyFile, `${fresh.toString("hex")}\n`, { mode: 0o600 });
    return fresh;
  }

  function seal(secret: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(true)!, nonce);
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
  }

  function open(sealed: string | undefined): string {
    const k = sealed ? key(false) : null;
    if (!k || !sealed) return "";
    try {
      const data = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", k, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      return "";
    }
  }

  const bot = (botId: string): BotChannelState => load()[botId] ?? botSchema.parse({});

  function update(botId: string, mutate: (state: BotChannelState) => void): BotChannelState {
    const all = load();
    const state = all[botId] ?? botSchema.parse({});
    mutate(state);
    all[botId] = state;
    save(all);
    return state;
  }

  function remove(botId: string): void {
    const all = load();
    if (!(botId in all)) return;
    delete all[botId];
    save(all);
  }

  const connected = (): string[] => Object.entries(load()).filter(([, state]) => state.sealedToken).map(([botId]) => botId);

  const token = (botId: string): string => open(bot(botId).sealedToken);

  function setToken(botId: string, secret: string, username: string): void {
    update(botId, (state) => {
      state.sealedToken = seal(secret);
      state.username = username;
      delete state.cursor;
      delete state.lastError;
    });
  }

  function firstSighting(botId: string, id: string): boolean {
    let fresh = false;
    update(botId, (state) => {
      fresh = !state.seen.includes(id);
      if (fresh) state.seen = [...state.seen, id].slice(-SEEN_MAX);
    });
    return fresh;
  }

  function startLink(botId: string, now: number): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now + LINK_TTL_MS;
    update(botId, (state) => { state.link = { codeHash: hashCode(code), expiresAt, failures: 0 }; });
    return { code, expiresAt };
  }

  const linkPending = (botId: string, now: number): boolean => {
    const { link } = bot(botId);
    return Boolean(link && link.expiresAt > now);
  };

  /** A live code from `chatId` makes that chat the bot's. Single use. */
  function claimLink(botId: string, code: string, chatId: string, name: string | undefined, now: number): boolean {
    let linked = false;
    update(botId, (state) => {
      if (!state.link || state.link.expiresAt <= now) return;
      const expected = Buffer.from(state.link.codeHash, "hex");
      const actual = Buffer.from(hashCode(code), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        state.link.failures += 1;
        if (state.link.failures >= LINK_MAX_FAILURES) delete state.link;
        return;
      }
      delete state.link;
      if (!state.allowed.includes(chatId)) state.allowed = [...state.allowed, chatId].slice(-MAX_LINKED_CHATS);
      state.chats[chatId] = { ...state.chats[chatId], ...(name ? { name } : {}) };
      delete state.lastError;
      linked = true;
    });
    return linked;
  }

  function patchChat(botId: string, chatId: string, patch: Partial<ChatState>): void {
    update(botId, (state) => { state.chats[chatId] = { ...state.chats[chatId], ...patch }; });
  }

  function chatForThread(threadId: string): { botId: string; chatId: string } | null {
    for (const [botId, state] of Object.entries(load())) {
      for (const [chatId, chat] of Object.entries(state.chats)) if (chat.threadId === threadId && state.allowed.includes(chatId)) return { botId, chatId };
    }
    return null;
  }

  function recordError(botId: string, message: string, at: number): void {
    update(botId, (state) => { state.lastError = { at, message: redactSecretsInText(message).slice(0, 300) }; });
  }

  return { load, bot, update, remove, connected, token, setToken, firstSighting, startLink, linkPending, claimLink, patchChat, chatForThread, recordError };
}

export type ChannelStore = ReturnType<typeof createChannelStore>;

export interface ChannelDeps {
  store: ChannelStore;
  transport: ChannelTransport;
  /** The thread's title and the prompt part that tells the bot where its replies go. */
  threadTitle: string;
  prompt: string;
  bot(botId: string): { id: string; name: string } | undefined;
  threadExists(botId: string, threadId: string): boolean;
  createThread(botId: string, title: string): string | null;
  /** A message from the person, as if they typed it: it starts, steers or queues like any other. */
  deliver(botId: string, threadId: string, text: string, sendId: string): Promise<void>;
  activePath(threadId: string): Message[];
  needsInput(message: Message): boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  for (let rest = text.trim(); rest;) {
    if (rest.length <= max) { out.push(rest); break; }
    const cut = Math.max(rest.lastIndexOf("\n\n", max), rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return out;
}

export function createChannel(deps: ChannelDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const log = (line: string) => deps.log?.(redactSecretsInText(line));
  // One send at a time per chat, so replies arrive in order.
  const lanes = new Map<string, Promise<void>>();
  const inLane = (lane: string, work: () => Promise<void>): Promise<void> => {
    const next = (lanes.get(lane) ?? Promise.resolve()).then(work).catch((error: unknown) => { log((error as Error).message); });
    lanes.set(lane, next);
    void next.finally(() => { if (lanes.get(lane) === next) lanes.delete(lane); });
    return next;
  };
  /** Chats told once that the bot is not theirs, so a stranger hears it once and not on every message. */
  const refused = new Set<string>();

  async function send(botId: string, chatId: string, text: string): Promise<boolean> {
    const token = deps.store.token(botId);
    if (!token) return false;
    const result = await deps.transport.send(token, chatId, text);
    if (!result.ok) {
      deps.store.recordError(botId, `A message could not be sent: ${result.error}`, now());
      log(`send failed: ${result.error}`);
    }
    return result.ok;
  }

  function threadFor(botId: string, chatId: string, fresh: boolean): string | null {
    const current = deps.store.bot(botId).chats[chatId]?.threadId;
    if (!fresh && current && deps.threadExists(botId, current)) return current;
    const threadId = deps.createThread(botId, deps.threadTitle);
    if (threadId) deps.store.patchChat(botId, chatId, { threadId, lastSentMessageId: undefined });
    return threadId;
  }

  async function receive(botId: string, message: InboundMessage): Promise<void> {
    const bot = deps.bot(botId);
    if (!bot) return;
    const { chatId, text } = message;
    if (deps.transport.linkCommand.test(text)) {
      await send(botId, chatId, `You're connected to ${bot.name}. Message me here any time.`);
      return;
    }
    if (/^\/new$/i.test(text)) {
      const threadId = threadFor(botId, chatId, true);
      await send(botId, chatId, threadId ? `Started a new conversation with ${bot.name}.` : "Couldn't start a new conversation.");
      return;
    }
    if (!text.trim()) {
      await send(botId, chatId, "I can only read text messages here for now. Send it as text, or open OpenMausBot.");
      return;
    }
    const threadId = threadFor(botId, chatId, false);
    if (!threadId) {
      await send(botId, chatId, `Couldn't open a conversation with ${bot.name}. Try again in OpenMausBot.`);
      return;
    }
    try {
      await deps.deliver(botId, threadId, text, `channel_${message.id}`);
    } catch (error) {
      const reason = (error as Error).message;
      deps.store.recordError(botId, `A message didn't reach ${bot.name}: ${reason}`, now());
      await send(botId, chatId, `That didn't reach ${bot.name}: ${redactSecretsInText(reason)}`);
    }
  }

  async function handleInbound(botId: string, message: InboundMessage): Promise<void> {
    if (!deps.store.firstSighting(botId, message.id)) return;
    const lane = `${botId}:${message.chatId}`;
    if (!deps.store.bot(botId).allowed.includes(message.chatId)) {
      const code = deps.transport.linkCommand.exec(message.text)?.[1];
      if (message.private && code && deps.store.claimLink(botId, code, message.chatId, message.name, now())) {
        const name = deps.bot(botId)?.name ?? "the bot";
        await inLane(lane, () => send(botId, message.chatId, `You're connected to ${name}. Message me here any time.`).then(() => undefined));
      } else if (message.private && !refused.has(lane)) {
        refused.add(lane);
        log("ignored a message from a chat that is not linked");
        const note = deps.transport.strangerNote;
        if (note) await inLane(lane, () => send(botId, message.chatId, note).then(() => undefined));
      }
      return;
    }
    await inLane(lane, () => receive(botId, message));
  }

  function noteTurnCompleted(threadId: string): Promise<void> {
    const found = deps.store.chatForThread(threadId);
    if (!found) return Promise.resolve();
    const { botId, chatId } = found;
    return inLane(`${botId}:${chatId}`, async () => {
      const chat = deps.store.bot(botId).chats[chatId] ?? {};
      const path = deps.activePath(threadId);
      const cursor = chat.lastSentMessageId ? path.findIndex((message) => message.id === chat.lastSentMessageId) : -1;
      const start = cursor >= 0 ? cursor + 1 : path.findLastIndex((message) => message.role === "user") + 1;
      const fresh = path.slice(start);
      const said = fresh.filter((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
      const waiting = fresh.some((message) => deps.needsInput(message));
      const last = fresh.at(-1);
      if (!last || (!said.length && !waiting)) return;
      let parts = chunks(redactSecretsInText(said.map((message) => message.text!.trim()).join("\n\n")), deps.transport.maxChars);
      if (waiting) parts.push(WAITING_NOTE);
      if (parts.length > MAX_MESSAGES_PER_REPLY) parts = [...parts.slice(0, MAX_MESSAGES_PER_REPLY - 1), "…the rest is in OpenMausBot."];
      for (const part of parts) if (!(await send(botId, chatId, part))) return;
      deps.store.patchChat(botId, chatId, { lastSentMessageId: last.id });
    });
  }

  const prompt = (threadId: string): string => (deps.store.chatForThread(threadId) ? deps.prompt : "");

  return {
    handleInbound, noteTurnCompleted, prompt,
    startLink: (botId: string) => deps.store.startLink(botId, now()),
    busy: () => lanes.size > 0,
    idle: () => Promise.allSettled(lanes.values()),
  };
}

export type Channel = ReturnType<typeof createChannel>;
