// Sendblue's API (docs.sendblue.com) as a channel transport, on the person's own account: GET /api/v2/lines/state checks
// the key and the number, GET /api/v2/messages is asked for new inbound messages (no public address, no webhook), and
// POST /api/send-message answers. The key rides in headers only, and no request, header or key is ever logged or returned.
import { z } from "zod";

import type { InboundMessage, SendResult } from "./core.ts";
import type { ReadResult } from "./poller.ts";

export const SENDBLUE_API_BASE = "https://api.sendblue.com";
/** Sendblue accepts 18,996 characters; a reply of that size is not one anybody reads in a message bubble. */
export const SENDBLUE_MAX_CHARS = 2000;
export const SENDBLUE_POLL_INTERVAL_MS = 4_000;
export const SENDBLUE_PAGE = 100;
/** A new connection reads from this far before it, so a slightly fast clock here does not hide the person's first text. */
export const SENDBLUE_START_MARGIN_MS = 2 * 60_000;
export const SENDBLUE_LINK_COMMAND = /^link\s+(\d{6})$/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,200}$/;

export const SENDBLUE_PROMPT = [
  "This conversation is the person's iMessage thread with you, through their own Sendblue number. Your replies go to their phone as plain-text messages: keep them short, in plain sentences, with no Markdown, tables or headings. They cannot see cards, forms, buttons or files here, so ask questions in text with numbered options.",
  "Anything that needs the person's approval waits for them in OpenMausBot: say so in one line and tell them what to approve.",
].join(" ");

/** A test's loopback stand-in only: anything else keeps Sendblue's real address. */
export function sendblueApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OMB_SENDBLUE_API_BASE?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(raw) ? raw : SENDBLUE_API_BASE;
}

export interface SendblueCredentials { keyId: string; secret: string; number: string }

/** What the store seals for a bot: the key, its secret and the Sendblue number the replies leave from. */
export const packCredentials = (credentials: SendblueCredentials): string => JSON.stringify(credentials);

const credentialsSchema = z.object({ keyId: z.string().min(1), secret: z.string().min(1), number: z.string().min(1) });

export function unpackCredentials(packed: string): SendblueCredentials | null {
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(packed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A phone number as Sendblue wants it, or why not: spaces, dashes and brackets are dropped, the country code is the person's to give. */
export function normalizeNumber(raw: string): { ok: true; number: string } | { ok: false; error: string } {
  const number = raw.replace(/[\s().-]/g, "");
  return E164.test(number) ? { ok: true, number } : { ok: false, error: "Enter the Sendblue number with its country code, like +14155550123." };
}

export function checkCredentialText(keyId: string, secret: string): string | null {
  return CREDENTIAL.test(keyId) && CREDENTIAL.test(secret) ? null : "That doesn't look like a Sendblue API key ID and secret. Copy both from the Sendblue dashboard.";
}

const messageSchema = z.object({
  message_handle: z.string().min(1),
  content: z.string().nullish(),
  /** The person's number whichever way the message went; from_number is the sender on an inbound one. */
  number: z.string().nullish(),
  from_number: z.string().nullish(),
  is_outbound: z.boolean(),
  date_sent: z.string().optional(),
  group_id: z.string().nullish(),
});

const listSchema = z.object({ data: z.array(z.unknown()) });
const linesSchema = z.object({ data: z.array(z.object({ sendblue_number: z.string() })) });
const failureSchema = z.object({ status: z.string().optional(), error_reason: z.string().nullish(), error_message: z.string().nullish(), message: z.string().nullish() });

export type SendblueMessage = z.output<typeof messageSchema>;

export interface SendblueApiOptions {
  base?: string;
  fetchImpl?: typeof fetch;
}

export function createSendblueApi(options: SendblueApiOptions = {}) {
  const base = options.base ?? SENDBLUE_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call(credentials: Pick<SendblueCredentials, "keyId" | "secret">, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<{ ok: true; body: unknown } | { ok: false; error: string; code?: number; retryAfterMs?: number }> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, signal,
        headers: { "sb-api-key-id": credentials.keyId, "sb-api-secret-key": credentials.secret, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return { ok: false, error: signal?.aborted ? "stopped" : `Sendblue could not be reached (${(error as Error).name})` };
    }
    const answer: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, body: answer };
    const failure = failureSchema.safeParse(answer);
    const reason = failure.success ? failure.data.error_reason ?? failure.data.error_message ?? failure.data.message : null;
    const retry = Number(response.headers.get("retry-after"));
    return { ok: false, error: reason?.slice(0, 200) || `Sendblue refused (HTTP ${response.status})`, code: response.status, ...(retry > 0 ? { retryAfterMs: retry * 1000 } : {}) };
  }

  async function verify(credentials: SendblueCredentials): Promise<{ ok: true } | { ok: false; error: string }> {
    const answer = await call(credentials, "GET", "/api/v2/lines/state");
    if (!answer.ok) return { ok: false, error: answer.code === 401 || answer.code === 403 ? "Sendblue doesn't know that API key ID and secret. Copy both again from the Sendblue dashboard." : answer.error };
    const lines = linesSchema.safeParse(answer.body);
    if (!lines.success) return { ok: false, error: "Sendblue answered without a list of numbers." };
    const mine = lines.data.data.map((line) => line.sendblue_number.replace(/[\s().-]/g, ""));
    return mine.length && !mine.includes(credentials.number) ? { ok: false, error: "That number isn't on this Sendblue account." } : { ok: true };
  }

  /** Inbound messages created at or after `since`, oldest first. A full page says to ask again at once. */
  async function listInbound(packed: string, since: number, signal?: AbortSignal): Promise<ReadResult<SendblueMessage>> {
    const credentials = unpackCredentials(packed);
    if (!credentials) return { ok: false, error: "The saved Sendblue key could not be read. Connect it again." };
    // shortcut: a full page of received messages sharing one timestamp would be read again forever; page with offset if a line ever gets that busy.
    const query = new URLSearchParams({
      is_outbound: "false", sendblue_number: credentials.number, order_by: "createdAt", order_direction: "asc",
      limit: String(SENDBLUE_PAGE), created_at_gte: new Date(since).toISOString(),
    });
    const answer = await call(credentials, "GET", `/api/v2/messages?${query}`, undefined, signal);
    if (!answer.ok) return answer;
    const list = listSchema.safeParse(answer.body);
    if (!list.success) return { ok: false, error: "Sendblue answered without a message list." };
    const items = list.data.data.map((raw) => messageSchema.safeParse(raw)).filter((parsed) => parsed.success).map((parsed) => parsed.data!);
    const newest = items.reduce((latest, message) => Math.max(latest, dateOf(message) ?? 0), 0);
    return { ok: true, items, more: list.data.data.length >= SENDBLUE_PAGE && newest > since };
  }

  async function sendMessage(packed: string, chatId: string, text: string): Promise<SendResult> {
    const credentials = unpackCredentials(packed);
    if (!credentials) return { ok: false, error: "The saved Sendblue key could not be read. Connect it again." };
    const answer = await call(credentials, "POST", "/api/send-message", { number: chatId, from_number: credentials.number, content: text });
    if (!answer.ok) return { ok: false, error: answer.error };
    const status = failureSchema.safeParse(answer.body);
    if (status.success && (status.data.status === "ERROR" || status.data.status === "DECLINED")) return { ok: false, error: status.data.error_reason ?? status.data.error_message ?? "Sendblue declined the message." };
    return { ok: true };
  }

  return { verify, listInbound, sendMessage };
}

export type SendblueApi = ReturnType<typeof createSendblueApi>;

/** When Sendblue made the message, in epoch milliseconds. */
export const dateOf = (message: SendblueMessage): number | undefined => {
  const at = message.date_sent ? Date.parse(message.date_sent) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

/** The message the bot should hear: one-to-one and from the person, not an echo of ours or a group's. */
export function inboundOf(message: SendblueMessage): InboundMessage | null {
  const chatId = message.number || message.from_number;
  if (message.is_outbound || message.group_id || !chatId) return null;
  return { id: `sb_${message.message_handle}`, chatId, text: (message.content ?? "").trim(), private: true };
}

/** The link that opens the person's Messages with the command ready to send. */
export const sendblueLink = (number: string, code: string): string => `sms:${number}&body=${encodeURIComponent(`link ${code}`)}`;
