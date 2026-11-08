// Telegram's Bot API (core.telegram.org/bots/api) as a channel transport: getMe checks a token, getUpdates long polling
// reads messages with no public address, sendMessage answers in plain text. The token rides in the URL, so no URL is
// ever logged or returned.
import { z } from "zod";

import type { InboundMessage, SendResult } from "./core.ts";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
/** Telegram's own limits: 4096 characters a message, and a token shaped "<bot id>:<secret>". */
export const TELEGRAM_MAX_CHARS = 4096;
export const TELEGRAM_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
export const POLL_TIMEOUT_S = 25;
export const POLL_BACKOFF_MIN_MS = 5_000;
export const POLL_BACKOFF_MAX_MS = 60_000;
export const PAUSED_CHECK_MS = 1_000;

export const TELEGRAM_PROMPT = [
  "This conversation is the person's Telegram chat with you. Your replies go to their phone as plain-text Telegram messages: keep them short, in plain sentences, with no Markdown, tables or headings. They cannot see cards, forms, buttons or files here, so ask questions in text with numbered options.",
  "Anything that needs the person's approval waits for them in OpenMausBot: say so in one line and tell them what to approve.",
].join(" ");

/** A test's loopback stand-in only: anything else keeps Telegram's real address. */
export function telegramApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OMB_TELEGRAM_API_BASE?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(raw) ? raw : TELEGRAM_API_BASE;
}

const answerSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

const meSchema = z.object({ id: z.number(), username: z.string().min(1) });

const updateSchema = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number(),
    text: z.string().optional(),
    chat: z.object({ id: z.number(), type: z.string() }),
    from: z.object({ first_name: z.string().optional() }).optional(),
  }).optional(),
});

export type TelegramUpdate = z.output<typeof updateSchema>;
export type ApiAnswer = { ok: true; result: unknown } | { ok: false; error: string; code?: number; retryAfterMs?: number };

export interface TelegramApiOptions {
  base?: string;
  fetchImpl?: typeof fetch;
}

export function createTelegramApi(options: TelegramApiOptions = {}) {
  const base = options.base ?? TELEGRAM_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ApiAnswer> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (error) {
      return { ok: false, error: signal?.aborted ? "stopped" : `Telegram could not be reached (${(error as Error).name})` };
    }
    const parsed = answerSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { ok: false, error: `Telegram answered with something unexpected (HTTP ${response.status})`, code: response.status };
    if (!parsed.data.ok) {
      const retry = parsed.data.parameters?.retry_after;
      return { ok: false, error: parsed.data.description ?? `Telegram refused (HTTP ${response.status})`, code: parsed.data.error_code ?? response.status, ...(retry ? { retryAfterMs: retry * 1000 } : {}) };
    }
    return { ok: true, result: parsed.data.result };
  }

  async function getMe(token: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
    if (!TELEGRAM_TOKEN.test(token)) return { ok: false, error: "That doesn't look like a bot token. Copy the whole token BotFather gave you." };
    const answer = await call(token, "getMe", {});
    if (!answer.ok) return { ok: false, error: answer.code === 401 ? "Telegram doesn't know that token. Copy it again from BotFather." : answer.error };
    const me = meSchema.safeParse(answer.result);
    return me.success ? { ok: true, username: me.data.username } : { ok: false, error: "Telegram answered without a bot username." };
  }

  async function getUpdates(token: string, offset: number | undefined, signal?: AbortSignal): Promise<{ ok: true; updates: TelegramUpdate[] } | Exclude<ApiAnswer, { ok: true }>> {
    const answer = await call(token, "getUpdates", { ...(offset === undefined ? {} : { offset }), timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] }, signal);
    if (!answer.ok) return answer;
    const updates = z.array(z.unknown()).safeParse(answer.result);
    if (!updates.success) return { ok: false, error: "Telegram answered without an update list." };
    return { ok: true, updates: updates.data.map((raw) => updateSchema.safeParse(raw)).filter((parsed) => parsed.success).map((parsed) => parsed.data!) };
  }

  async function sendMessage(token: string, chatId: string, text: string): Promise<SendResult> {
    const answer = await call(token, "sendMessage", { chat_id: chatId, text });
    return answer.ok ? { ok: true } : { ok: false, error: answer.error };
  }

  return { getMe, getUpdates, sendMessage };
}

export type TelegramApi = ReturnType<typeof createTelegramApi>;

/** The message in an update, or nothing for an update that carries none (an edit, a join, a sticker). */
export function inboundOf(update: TelegramUpdate): InboundMessage | null {
  const message = update.message;
  if (!message) return null;
  return {
    id: `tg_${update.update_id}`,
    chatId: String(message.chat.id),
    ...(message.from?.first_name ? { name: message.from.first_name.slice(0, 80) } : {}),
    text: message.text ?? "",
    private: message.chat.type === "private",
  };
}

export const telegramLink = (username: string, code: string): string => `https://t.me/${username}?start=${code}`;

export interface TelegramPollerDeps {
  api: Pick<TelegramApi, "getUpdates">;
  token(): string;
  cursor(): number | undefined;
  /** One update, in order; the poller moves on only once it returns. */
  handle(update: TelegramUpdate): Promise<void>;
  failed(error: string): void;
  log?(line: string): void;
  /** Tests: how long to wait, by reason. */
  delays?: { backoffMin?: number; backoffMax?: number; paused?: number };
}

/** One bot's long-polling loop. Stop ends it; pause lets a check in flight finish but delivers nothing from it. */
export function createTelegramPoller(deps: TelegramPollerDeps) {
  const backoffMin = deps.delays?.backoffMin ?? POLL_BACKOFF_MIN_MS;
  const backoffMax = deps.delays?.backoffMax ?? POLL_BACKOFF_MAX_MS;
  const pausedMs = deps.delays?.paused ?? PAUSED_CHECK_MS;
  let stopped = true;
  let paused = false;
  let backoff = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let checking = false;

  async function check(): Promise<number> {
    const token = deps.token();
    if (!token) return backoffMax;
    inflight = new AbortController();
    const controller = inflight;
    try {
      const result = await deps.api.getUpdates(token, deps.cursor(), controller.signal);
      if (controller.signal.aborted || stopped || paused) return 0;
      if (!result.ok) {
        backoff = Math.min(backoff ? backoff * 2 : backoffMin, backoffMax);
        deps.failed(result.error);
        deps.log?.(`checking Telegram failed: ${result.error}`);
        return result.retryAfterMs ?? backoff;
      }
      backoff = 0;
      for (const update of result.updates) {
        if (stopped || paused) return 0;
        await deps.handle(update);
      }
      return 0;
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  function schedule(delay: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      if (paused) return schedule(pausedMs);
      checking = true;
      void check()
        .catch((error: unknown) => { deps.log?.(`checking Telegram failed: ${(error as Error).message}`); return backoffMin; })
        .then((next) => { checking = false; schedule(paused ? pausedMs : next); });
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      inflight?.abort();
    },
    pause() {
      paused = true;
      inflight?.abort();
    },
    resume() {
      paused = false;
    },
    busy: () => checking,
  };
}

export type TelegramPoller = ReturnType<typeof createTelegramPoller>;
