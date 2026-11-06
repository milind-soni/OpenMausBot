// One Telegram bot per MausBot bot, on the person's own BotFather token. Inside: the routes that connect a token, start a
// link and disconnect, open to the owner or an admin only. Outside: one long-polling reader per connected bot, which
// stops on disconnect, on the bot's deletion, and for workspace maintenance. Off on a Team Cloud, whose
// conversations belong to several people.
import { z } from "zod";

import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { schemaIssue } from "../schema.ts";
import type { Message, Store } from "../store.ts";
import { createChannel, createChannelStore, type BotChannelState } from "./core.ts";
import { type Poller, createPoller } from "./poller.ts";
import { createTelegramApi, inboundOf, TELEGRAM_LINK_COMMAND, TELEGRAM_MAX_CHARS, TELEGRAM_PROMPT, TELEGRAM_STRANGER_NOTE, telegramLink, type TelegramUpdate } from "./telegram.ts";

export const TELEGRAM_STORE = "telegram";
export const TELEGRAM_THREAD_TITLE = "Telegram";
const APP_PATH = /^\/api\/bots\/([\w-]{1,128})\/telegram(?:\/(link))?$/;
const TEAM_REFUSAL = "Telegram isn't available on a team server yet.";
const connectSchema = z.object({ token: z.string().trim().min(1).max(200) });

export interface TelegramView {
  available: boolean;
  connected: boolean;
  username?: string;
  chats: Array<{ id: string; name?: string }>;
  /** Until when a link code waits for the person's /start; absent when none does. */
  linkExpiresAt?: number;
  lastError?: { at: number; message: string };
}

export interface TelegramHostDeps {
  dataDir: string;
  teamCloud: boolean;
  store: Pick<Store, "bot" | "taskByThread" | "createTask" | "activePath" | "onChange">;
  deliver(botId: string, threadId: string, text: string, sendId: string): Promise<void>;
  needsInput(message: Message): boolean;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests: the poller's waits. */
  delays?: { backoffMin?: number; backoffMax?: number; paused?: number };
}

export function createTelegramHost(deps: TelegramHostDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const log = (line: string) => deps.log?.(`telegram: ${line}`);
  const store = createChannelStore(deps.dataDir, TELEGRAM_STORE);
  const api = createTelegramApi({ base: deps.apiBase, fetchImpl: deps.fetchImpl });
  const channel = createChannel({
    store, transport: { maxChars: TELEGRAM_MAX_CHARS, linkCommand: TELEGRAM_LINK_COMMAND, strangerNote: TELEGRAM_STRANGER_NOTE, send: api.sendMessage }, threadTitle: TELEGRAM_THREAD_TITLE, prompt: TELEGRAM_PROMPT,
    bot: (botId) => { const bot = deps.store.bot(botId); return bot ? { id: bot.id, name: bot.name } : undefined; },
    threadExists: (botId, threadId) => Boolean(deps.store.taskByThread(botId, threadId)),
    createThread: (botId, title) => deps.store.createTask(botId, title, false)?.threadId ?? null,
    deliver: deps.deliver, activePath: (threadId) => deps.store.activePath(threadId), needsInput: deps.needsInput, now, log,
  });
  const pollers = new Map<string, Poller<TelegramUpdate>>();
  let running = false;
  let paused = false;

  function startPoller(botId: string): void {
    if (!running || deps.teamCloud || pollers.has(botId) || !deps.store.bot(botId)) return;
    const poller = createPoller<TelegramUpdate>({
      source: "Telegram", read: api.getUpdates, token: () => store.token(botId), cursor: () => store.bot(botId).cursor, log, delays: deps.delays,
      handle: async (update) => {
        const message = inboundOf(update);
        if (message) await channel.handleInbound(botId, message);
        store.update(botId, (state) => { state.cursor = update.update_id + 1; });
      },
      failed: (error) => store.recordError(botId, `Couldn't check Telegram for new messages: ${error}`, now()),
    });
    pollers.set(botId, poller);
    if (paused) poller.pause();
    poller.start();
  }

  function stopPoller(botId: string): void {
    pollers.get(botId)?.stop();
    pollers.delete(botId);
  }

  deps.store.onChange((change) => { if (change.type === "bot.deleted") { stopPoller(change.botId); store.remove(change.botId); } });

  const view = (botId: string, state: BotChannelState = store.bot(botId)): TelegramView => ({
    available: !deps.teamCloud,
    connected: Boolean(state.sealedToken),
    ...(state.username ? { username: state.username } : {}),
    chats: state.allowed.map((id) => ({ id, ...(state.chats[id]?.name ? { name: state.chats[id]!.name } : {}) })),
    ...(state.link && state.link.expiresAt > now() ? { linkExpiresAt: state.link.expiresAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  });

  const routes: RouteHandler = async ({ req, res, path, method, auth, json, readBody }) => {
    const match = APP_PATH.exec(path);
    if (!match) return PASS;
    const botId = match[1]!;
    if (!ownerOrAdmin(auth as RequestAuth)) return json(res, 403, { error: "Only the owner or an admin can change a bot's Telegram." });
    if (!deps.store.bot(botId)) return json(res, 404, { error: "no such bot" });
    if (method === "GET" && !match[2]) return json(res, 200, view(botId));
    if (deps.teamCloud) return json(res, 409, { error: TEAM_REFUSAL });
    if (method === "DELETE" && !match[2]) {
      stopPoller(botId);
      store.remove(botId);
      return json(res, 200, view(botId));
    }
    if (method !== "POST") return PASS;
    if (match[2] === "link") {
      if (!store.bot(botId).sealedToken) return json(res, 409, { error: "Connect a bot token first." });
      const { code, expiresAt } = channel.startLink(botId);
      return json(res, 200, { code, expiresAt, url: telegramLink(store.bot(botId).username ?? "", code), ...view(botId) });
    }
    const parsed = connectSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: schemaIssue(parsed.error, "Send {\"token\": \"…\"}") });
    const checked = await api.getMe(parsed.data.token);
    if (!checked.ok) return json(res, 400, { error: checked.error, ...view(botId) });
    stopPoller(botId);
    store.setToken(botId, parsed.data.token, checked.username);
    startPoller(botId);
    return json(res, 200, view(botId));
  };

  return {
    routes,
    noteTurnCompleted: channel.noteTurnCompleted,
    prompt: channel.prompt,
    start() {
      if (running) return;
      running = true;
      for (const botId of store.connected()) startPoller(botId);
    },
    stop() {
      running = false;
      for (const poller of pollers.values()) poller.stop();
      pollers.clear();
    },
    /** Workspace maintenance: no reads, and a read already waiting on Telegram delivers nothing. */
    pause() {
      paused = true;
      for (const poller of pollers.values()) poller.pause();
    },
    resume() {
      paused = false;
      for (const poller of pollers.values()) poller.resume();
    },
    busy: () => channel.busy() || [...pollers.values()].some((poller) => poller.busy()),
    idle: channel.idle,
  };
}

export type TelegramHost = ReturnType<typeof createTelegramHost>;
