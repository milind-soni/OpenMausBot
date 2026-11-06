// One iMessage line per MausBot bot, on the person's own Sendblue account. Inside: the routes that connect a key and
// number, start a link and disconnect, open to the owner or an admin only. Outside: one reader per connected bot, which
// asks Sendblue for new messages every few seconds, and stops on disconnect, on the bot's deletion, and for workspace
// maintenance. Off on a Team Cloud, whose conversations belong to several people.
import { z } from "zod";

import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { schemaIssue } from "../schema.ts";
import type { Message, Store } from "../store.ts";
import { createChannel, createChannelStore, type BotChannelState } from "./core.ts";
import { createPoller, type Poller } from "./poller.ts";
import {
  checkCredentialText, createSendblueApi, dateOf, inboundOf, normalizeNumber, packCredentials, SENDBLUE_LINK_COMMAND, SENDBLUE_MAX_CHARS,
  SENDBLUE_POLL_INTERVAL_MS, SENDBLUE_PROMPT, SENDBLUE_START_MARGIN_MS, sendblueLink, type SendblueMessage,
} from "./sendblue.ts";

export const SENDBLUE_STORE = "imessage";
export const SENDBLUE_THREAD_TITLE = "iMessage";
const APP_PATH = /^\/api\/bots\/([\w-]{1,128})\/imessage(?:\/(link))?$/;
const TEAM_REFUSAL = "iMessage isn't available on a team server yet.";
const connectSchema = z.object({ keyId: z.string().trim().min(1).max(200), secret: z.string().trim().min(1).max(200), number: z.string().trim().min(1).max(40) });

export interface SendblueView {
  available: boolean;
  connected: boolean;
  number?: string;
  chats: Array<{ id: string; name?: string }>;
  /** Until when a link code waits for the person's text; absent when none does. */
  linkExpiresAt?: number;
  lastError?: { at: number; message: string };
}

export interface SendblueHostDeps {
  dataDir: string;
  teamCloud: boolean;
  store: Pick<Store, "bot" | "taskByThread" | "createTask" | "activePath" | "onChange">;
  deliver(botId: string, threadId: string, text: string, sendId: string): Promise<void>;
  needsInput(message: Message): boolean;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests: the reader's waits. */
  delays?: { backoffMin?: number; backoffMax?: number; paused?: number };
  interval?: number;
}

export function createSendblueHost(deps: SendblueHostDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const log = (line: string) => deps.log?.(`imessage: ${line}`);
  const store = createChannelStore(deps.dataDir, SENDBLUE_STORE);
  const api = createSendblueApi({ base: deps.apiBase, fetchImpl: deps.fetchImpl });
  const channel = createChannel({
    store, transport: { maxChars: SENDBLUE_MAX_CHARS, linkCommand: SENDBLUE_LINK_COMMAND, send: api.sendMessage }, threadTitle: SENDBLUE_THREAD_TITLE, prompt: SENDBLUE_PROMPT,
    bot: (botId) => { const bot = deps.store.bot(botId); return bot ? { id: bot.id, name: bot.name } : undefined; },
    threadExists: (botId, threadId) => Boolean(deps.store.taskByThread(botId, threadId)),
    createThread: (botId, title) => deps.store.createTask(botId, title, false)?.threadId ?? null,
    deliver: deps.deliver, activePath: (threadId) => deps.store.activePath(threadId), needsInput: deps.needsInput, now, log,
  });
  const pollers = new Map<string, Poller<SendblueMessage>>();
  let running = false;
  let paused = false;

  function startPoller(botId: string): void {
    if (!running || deps.teamCloud || pollers.has(botId) || !deps.store.bot(botId)) return;
    const poller = createPoller<SendblueMessage>({
      source: "Sendblue", interval: deps.interval ?? SENDBLUE_POLL_INTERVAL_MS, token: () => store.token(botId), cursor: () => store.bot(botId).cursor, log, delays: deps.delays,
      read: (token, cursor, signal) => api.listInbound(token, cursor ?? now() - SENDBLUE_START_MARGIN_MS, signal),
      handle: async (message) => {
        const inbound = inboundOf(message);
        if (inbound) await channel.handleInbound(botId, inbound);
        const at = dateOf(message);
        if (at !== undefined) store.update(botId, (state) => { state.cursor = Math.max(state.cursor ?? 0, at); });
      },
      failed: (error) => store.recordError(botId, `Couldn't check Sendblue for new messages: ${error}`, now()),
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

  const view = (botId: string, state: BotChannelState = store.bot(botId)): SendblueView => ({
    available: !deps.teamCloud,
    connected: Boolean(state.sealedToken),
    ...(state.username ? { number: state.username } : {}),
    chats: state.allowed.map((id) => ({ id, ...(state.chats[id]?.name ? { name: state.chats[id]!.name } : {}) })),
    ...(state.link && state.link.expiresAt > now() ? { linkExpiresAt: state.link.expiresAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  });

  const routes: RouteHandler = async ({ req, res, path, method, auth, json, readBody }) => {
    const match = APP_PATH.exec(path);
    if (!match) return PASS;
    const botId = match[1]!;
    if (!ownerOrAdmin(auth as RequestAuth)) return json(res, 403, { error: "Only the owner or an admin can change a bot's iMessage." });
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
      const number = store.bot(botId).username;
      if (!store.bot(botId).sealedToken || !number) return json(res, 409, { error: "Connect a Sendblue key and number first." });
      const { code, expiresAt } = channel.startLink(botId);
      return json(res, 200, { code, expiresAt, command: `link ${code}`, url: sendblueLink(number, code), ...view(botId) });
    }
    const parsed = connectSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: schemaIssue(parsed.error, "Send {\"keyId\": \"…\", \"secret\": \"…\", \"number\": \"+1…\"}") });
    const { keyId, secret } = parsed.data;
    const number = normalizeNumber(parsed.data.number);
    const refused = !number.ok ? number.error : checkCredentialText(keyId, secret);
    if (refused || !number.ok) return json(res, 400, { error: refused, ...view(botId) });
    const taken = Object.entries(store.load()).some(([otherId, state]) => otherId !== botId && state.sealedToken && state.username === number.number);
    if (taken) return json(res, 400, { error: "Another bot already uses that number. Give each bot its own Sendblue line.", ...view(botId) });
    const credentials = { keyId, secret, number: number.number };
    const checked = await api.verify(credentials);
    if (!checked.ok) return json(res, 400, { error: checked.error, ...view(botId) });
    stopPoller(botId);
    store.setToken(botId, packCredentials(credentials), number.number);
    store.update(botId, (state) => { state.cursor = now() - SENDBLUE_START_MARGIN_MS; });
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
    /** Workspace maintenance: no reads, and a read already waiting on Sendblue delivers nothing. */
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

export type SendblueHost = ReturnType<typeof createSendblueHost>;
