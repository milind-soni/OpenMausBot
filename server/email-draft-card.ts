// The draft card: after a bot's Gmail draft call succeeds, the server shows that draft in chat as a card the person can
// edit and save, or open in Gmail to send. Save runs from here through the bot's connected apps, under the same Rules and
// app permissions as the bot's own calls; no model sees or runs it.
//   POST /api/email-draft  {threadId, messageId, action: "save", base, draft}  →  {ok: true}
import { z } from "zod";

import { EMAIL_DRAFT_LIMITS, EMAIL_DRAFT_PATH, type EmailDraftCardData, type EmailDraftEdit } from "../shared/email-draft.ts";
import type { ConnectorCall } from "../shared/outbound.ts";
import { toolData } from "./connected-reads.ts";
import { parseMcpResponse } from "./connector-tools-list.ts";
import type { RequestAuth } from "./request-auth.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { serverLine } from "./server-lines.ts";
import type { Message } from "./store.ts";
import { userError, userErrorFields, userErrorThrown, type UserError } from "./user-errors.ts";

export const GMAIL_CREATE_DRAFT = "GMAIL_CREATE_EMAIL_DRAFT";
export const GMAIL_UPDATE_DRAFT = "GMAIL_UPDATE_DRAFT";
export const GMAIL_SEND_DRAFT = "GMAIL_SEND_DRAFT";
export const GMAIL_GET_DRAFT = "GMAIL_GET_DRAFT";
const DRAFT_TOOLS = [GMAIL_CREATE_DRAFT, GMAIL_UPDATE_DRAFT];
export const isDraftTool = (slug: string): boolean => DRAFT_TOOLS.includes(slug);
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CALL_ID = "omb-email-draft";
const CALL_TIMEOUT_MS = 60_000;

type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const list = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
  .map(text).filter((one): one is string => one !== undefined);
const httpsUrl = (value: unknown): string | undefined => {
  const url = text(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

/** A Composio tool answer, unwrapped from `response_data` when it is wrapped. */
const answerOf = (data: unknown) => record(record(data)?.response_data) ?? record(data);

/** The card for the one draft call in `calls` the answer says succeeded, or null (none, several, or it failed). An update
 *  leaves in Gmail what it omits, so each omitted field keeps its value from `shown` (the card already showing that draft);
 *  with no such card an update that omits a field shows none, rather than a draft Gmail doesn't have. */
export function draftCardFrom(calls: readonly ConnectorCall[], frame: Row | null, botId: string, shown?: (draftId: string) => EmailDraftCardData | undefined): EmailDraftCardData | null {
  const drafts = calls.filter((call) => isDraftTool(call.slug));
  if (drafts.length !== 1) return null;
  const [call] = drafts;
  let data: Row | undefined;
  try {
    data = record(toolData(call.slug, frame));
  } catch {
    return null;
  }
  const args = record(call.arguments) ?? {};
  const body = answerOf(data);
  const draftId = text(body?.id) ?? (call.slug === GMAIL_UPDATE_DRAFT ? text(args.draft_id) : undefined);
  if (!draftId) return null;
  const update = call.slug === GMAIL_UPDATE_DRAFT;
  const before = update ? shown?.(draftId) : undefined;
  const given = (...keys: string[]) => !update || keys.some((key) => args[key] !== undefined);
  const fields = [given("recipient_email"), given("extra_recipients"), given("cc"), given("bcc"), given("subject"), given("body", "message_body"), given("is_html")];
  if (!before && fields.includes(false)) return null;
  const [first, rest, cc, bcc, subject, message, html] = fields;
  const threadId = text(record(body?.message)?.threadId) ?? text(args.thread_id) ?? before?.threadId;
  const url = httpsUrl(body?.display_url) ?? httpsUrl(record(body?.message)?.display_url) ?? before?.url;
  const account = call.account ?? before?.account;
  // The card's first address is the draft's recipient_email, the rest its extra_recipients (as draftCall saves them), so a
  // draft with others but no recipient_email gets no card: a later update naming only one of the two couldn't be placed.
  const recipient = first ? list(args.recipient_email) : before!.to.slice(0, 1);
  const others = rest ? list(args.extra_recipients) : before!.to.slice(1);
  if (!recipient.length && others.length) return null;
  return {
    app: "gmail", draftId, botId,
    to: [...recipient, ...others],
    cc: cc ? list(args.cc) : before!.cc,
    bcc: bcc ? list(args.bcc) : before!.bcc,
    subject: !subject ? before!.subject : typeof args.subject === "string" ? args.subject : "",
    body: !message ? before!.body : typeof args.body === "string" ? args.body : typeof args.message_body === "string" ? args.message_body : "",
    ...((html ? args.is_html === true : before!.html) ? { html: true as const } : {}),
    ...(threadId ? { threadId } : {}),
    ...(account ? { account } : {}),
    ...(url ? { url } : {}),
  };
}

/** The draft id of the one send call in `calls` the answer says succeeded, or null. */
export function sentDraftFrom(calls: readonly ConnectorCall[], frame: Row | null): string | null {
  const sends = calls.filter((call) => call.slug === GMAIL_SEND_DRAFT);
  if (sends.length !== 1) return null;
  try {
    toolData(GMAIL_SEND_DRAFT, frame);
  } catch {
    return null;
  }
  return text(record(sends[0].arguments)?.draft_id) ?? null;
}

/** The line every client without the card shows, and the bot reads back as a record. */
export function draftCardText(card: EmailDraftCardData, language?: string): string {
  const to = card.to.length ? card.to.join(", ") : serverLine(language, "server.emailDraft.noRecipient");
  const subject = card.subject.trim() || serverLine(language, "server.emailDraft.noSubject");
  return serverLine(language, card.sentAt ? "server.emailDraft.sent" : "server.emailDraft.saved", { subject, to });
}

export interface DraftCardStore {
  messagesFor(threadId: string): Message[];
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

const cardOf = (store: DraftCardStore, threadId: string, draftId: string, botId: string) =>
  store.messagesFor(threadId).find((message) => message.emailDraft?.draftId === draftId && message.emailDraft.botId === botId);

/** Shows `card` in the thread: a draft already on a card there gets that card updated (and live again), else a new one. */
export function showDraftCard(store: DraftCardStore, threadId: string, card: EmailDraftCardData, language?: string): Message | null {
  const shown = cardOf(store, threadId, card.draftId, card.botId);
  const fields = { text: draftCardText(card, language), emailDraft: card };
  if (shown) return store.patchMessage(threadId, shown.id, fields);
  return store.appendMessage(threadId, { role: "bot", kind: "text", serverCard: true, ...fields });
}

/** The existing drafts `calls` change or send in Gmail. */
export const draftIdsIn = (calls: readonly ConnectorCall[]): string[] =>
  calls.filter((call) => call.slug === GMAIL_UPDATE_DRAFT || call.slug === GMAIL_SEND_DRAFT)
    .map((call) => text(record(call.arguments)?.draft_id)).filter((one): one is string => one !== undefined);

/** One Gmail call per draft at a time, shared by the card's Save and the bot's own draft calls, so their changes reach
 *  Gmail and the card in the same order. */
export interface DraftGuard {
  run<T>(draftIds: readonly string[], work: () => Promise<T>): Promise<T>;
}

export function createDraftGuard(): DraftGuard {
  const tails = new Map<string, Promise<unknown>>();
  const one = <T>(draftId: string, work: () => Promise<T>): Promise<T> => {
    const ran = (tails.get(draftId) ?? Promise.resolve()).then(work);
    const tail = ran.catch(() => undefined);
    tails.set(draftId, tail);
    void tail.then(() => { if (tails.get(draftId) === tail) tails.delete(draftId); });
    return ran;
  };
  return {
    // Several drafts are taken in sorted order, so two callers never each hold one the other waits for.
    run: <T>(draftIds: readonly string[], work: () => Promise<T>) =>
      [...new Set(draftIds)].sort().reduceRight((next: () => Promise<T>, draftId) => () => one(draftId, next), work)(),
  };
}

/** After the bot's relayed Gmail call succeeds (raw JSON or event-stream bytes): a saved draft shows or updates its card,
 *  a draft the bot sent turns its card into what was sent. Never throws: the card only shows the call, which already ran. */
export function showDraftAnswer(store: DraftCardStore, threadId: string, botId: string, calls: readonly ConnectorCall[], bytes: Uint8Array, id: unknown, language?: string): void {
  if (!calls.some((call) => isDraftTool(call.slug) || call.slug === GMAIL_SEND_DRAFT)) return;
  let frame: Row | null;
  try {
    frame = parseMcpResponse(new TextDecoder().decode(bytes), id);
  } catch {
    return;
  }
  try {
    const card = draftCardFrom(calls, frame, botId, (draftId) => cardOf(store, threadId, draftId, botId)?.emailDraft);
    if (card) showDraftCard(store, threadId, card, language);
    const sent = sentDraftFrom(calls, frame);
    const shown = sent ? cardOf(store, threadId, sent, botId) : undefined;
    if (shown?.emailDraft && !shown.emailDraft.sentAt) {
      const next = { ...shown.emailDraft, sentAt: Date.now() };
      store.patchMessage(threadId, shown.id, { text: draftCardText(next, language), emailDraft: next });
    }
  } catch (error) {
    console.warn("email draft card: could not show the bot's Gmail draft", error);
  }
}

type Refusal = UserError | { error: string };

/** Thrown by a relay that checks the Rules, the bot's app permissions and the person's access again right before it
 *  sends, and finds a refusal. */
export class DraftRefused extends Error {
  readonly refusal: Refusal;
  readonly status: number;
  constructor(refusal: Refusal, status = 403) {
    super(refusal.error);
    this.refusal = refusal;
    this.status = status;
  }
}

/** The relay to the connected-apps service a press runs through, or why it can't run. Right before it sends (after any
 *  setup it awaits) it runs `beforeSend` and its own checks; either throws DraftRefused to stop the call. */
export type DraftConnection =
  | { ok: true; relay(payload: unknown, transportSessionId: string | undefined, signal: AbortSignal, beforeSend?: () => void): Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }> }
  | { ok: false; refusal: Refusal };

export interface EmailDraftRouteDeps {
  sees(auth: RequestAuth, threadId: string): boolean;
  /** A room's conversation: its draft cards are view-only. */
  inRoom(threadId: string): boolean;
  /** The person may write to this bot. */
  mayChat(auth: RequestAuth, botId: string): boolean;
  store: DraftCardStore;
  /** Shared with the bot's own draft calls. */
  guard: DraftGuard;
  /** The bot's connection for `calls`, as the person pressing: checked against the Rules and the bot's app permissions. */
  connection(auth: RequestAuth, botId: string, calls: ConnectorCall[]): Promise<DraftConnection>;
  /** The conversation's language for the card's line. */
  language?(threadId: string): string | undefined;
}

const address = z.string().trim().min(1).max(EMAIL_DRAFT_LIMITS.address);
const addresses = z.array(address).max(EMAIL_DRAFT_LIMITS.recipients);
const edit = z.object({
  to: addresses, cc: addresses, bcc: addresses,
  subject: z.string().max(EMAIL_DRAFT_LIMITS.subject), body: z.string().max(EMAIL_DRAFT_LIMITS.body),
}).strict();
/** The addresses in To/Cc/Bcc values ("Ana <ana@x.com>, ben@x.com"), split on commas outside quotes. */
const entriesIn = (values: readonly string[]): string[] =>
  values.flatMap((value) => value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((one) => one.trim()).filter(Boolean);
/** The address in an entry, without its display name ("Ana <ana@x.com>" is "ana@x.com"). */
const addressOf = (entry: string) => (/<([^<>]*)>\s*$/.exec(entry)?.[1] ?? entry).trim();
const bare = (entry: string) => addressOf(entry).toLowerCase();
const sameAddresses = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(entriesIn(a).map(bare).sort()) === JSON.stringify(entriesIn(b).map(bare).sort());
const words = (value: string) => value.replace(/\s+/g, " ").trim();

/** The draft as Gmail holds it now, from GMAIL_GET_DRAFT's answer (addresses without display names; the body only when
 *  Gmail gives its text), or undefined when the answer doesn't carry the message's headers. */
export function gmailDraftOf(data: unknown): (Omit<EmailDraftEdit, "body"> & { body?: string }) | undefined {
  const message = record(answerOf(data)?.message);
  const headers = record(message?.payload)?.headers;
  if (!message || !Array.isArray(headers)) return undefined;
  const values = (name: string) => headers.map(record).filter((one) => typeof one?.name === "string" && one.name.toLowerCase() === name)
    .map((one) => (typeof one!.value === "string" ? one!.value : ""));
  const addresses = (name: string) => entriesIn(values(name)).map(addressOf).filter(Boolean);
  return {
    to: addresses("to"), cc: addresses("cc"), bcc: addresses("bcc"),
    subject: values("subject")[0] ?? "",
    ...(typeof message.messageText === "string" ? { body: message.messageText } : {}),
  };
}

/** Whether Gmail still holds `base`, the draft the person started editing from. An HTML body is not compared (the card
 *  doesn't edit one); a plain one is compared by its words, as Gmail may rewrap lines. */
export function draftUnchanged(base: EmailDraftEdit, gmail: NonNullable<ReturnType<typeof gmailDraftOf>>, html: boolean): boolean {
  return sameAddresses(base.to, gmail.to) && sameAddresses(base.cc, gmail.cc) && sameAddresses(base.bcc, gmail.bcc)
    && words(base.subject) === words(gmail.subject) && (html || words(base.body) === words(gmail.body ?? ""));
}

const where = { threadId: z.string().min(1).max(200), messageId: z.string().min(1).max(200) };
// `base`: the draft as the card showed it when the person started editing, so Save can tell whether Gmail changed since.
const press = z.object({ ...where, action: z.literal("save"), base: edit, draft: edit }).strict();

/** The Composio call Save makes with the edited `draft`. */
export function draftCall(card: EmailDraftCardData, draft: EmailDraftEdit): ConnectorCall {
  const account = card.account ? { account: card.account } : {};
  const [first, ...rest] = draft.to;
  return {
    slug: GMAIL_UPDATE_DRAFT,
    arguments: {
      user_id: "me", draft_id: card.draftId, recipient_email: first ?? "", extra_recipients: rest,
      cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, is_html: card.html === true,
      ...(card.threadId ? { thread_id: card.threadId } : {}),
    },
    ...account,
  };
}

const unreachable = (status: number) => userErrorThrown("serverError.emailDraft.unreachable", { status });

type RunCall = (call: ConnectorCall, dispatch: () => void) => Promise<unknown>;

/** Opens one MCP session for Save's calls, each with its own id and time limit. Each call's `dispatch` runs right before it goes out to
 *  Gmail, and may refuse it by throwing DraftRefused. */
async function openSession(connection: Extract<DraftConnection, { ok: true }>): Promise<RunCall> {
  const opening = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const init = await connection.relay({
    jsonrpc: "2.0", id: `${CALL_ID}-init`, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-email-draft", version: "1" } },
  }, undefined, opening);
  if (init.status !== 200) throw unreachable(init.status);
  await connection.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, init.transportSessionId, opening).catch(() => undefined);
  let calls = 0;
  return async (call, dispatch) => {
    const id = `${CALL_ID}-${++calls}`;
    const answer = await connection.relay({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: call.slug, arguments: call.arguments, ...(call.account ? { account: call.account } : {}) }] } },
    }, init.transportSessionId, AbortSignal.timeout(CALL_TIMEOUT_MS), dispatch);
    if (answer.status !== 200) throw unreachable(answer.status);
    return toolData(call.slug, parseMcpResponse(new TextDecoder().decode(answer.bytes), id));
  };
}

export function createEmailDraftRoutes(deps: EmailDraftRouteDeps): RouteHandler {
  // One press per card at a time, so a double tap saves once.
  const pressing = new Set<string>();
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== EMAIL_DRAFT_PATH) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    let raw: unknown;
    try { raw = await readBody(req, 256_000); } catch { return json(res, 400, { error: "Send threadId, messageId and action." }); }
    const parsed = press.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: "Send threadId, messageId and action." });
    const { threadId, messageId, base, draft } = parsed.data;
    const card = () => deps.store.messagesFor(threadId).find((message) => message.id === messageId)?.emailDraft;
    const shown = deps.sees(auth, threadId) && !deps.inRoom(threadId) ? card() : undefined;
    if (!shown || !deps.mayChat(auth, shown.botId)) return json(res, 404, userError("serverError.emailDraft.notHere"));
    const key = `${threadId}:${messageId}`;
    if (pressing.has(key)) return json(res, 409, userError("serverError.emailDraft.busy"));
    pressing.add(key);
    try {
      // Run while no bot call can change this draft, so Gmail and the card take the changes in the same order.
      return await deps.guard.run([shown.draftId], async () => {
        const now = card();
        if (!now) return json(res, 404, userError("serverError.emailDraft.notHere"));
        if (now.sentAt) return json(res, 409, userError("serverError.emailDraft.alreadySent"));
        const call = draftCall(now, draft);
        const read: ConnectorCall = { slug: GMAIL_GET_DRAFT, arguments: { user_id: "me", draft_id: now.draftId, format: "full" }, ...(now.account ? { account: now.account } : {}) };
        const connection = await deps.connection(auth, now.botId, [read, call]);
        if (!connection.ok) return json(res, 403, connection.refusal);
        // The person may have lost the conversation or the bot while the call waited for the draft or was set up.
        const stillHere = () => {
          if (!deps.sees(auth, threadId) || deps.inRoom(threadId) || !deps.mayChat(auth, now.botId)) {
            throw new DraftRefused(userError("serverError.emailDraft.notHere"), 404);
          }
        };
        const show = (next: EmailDraftCardData) =>
          deps.store.patchMessage(threadId, messageId, { text: draftCardText(next, deps.language?.(threadId)), emailDraft: next });
        let data: unknown;
        try {
          const run = await openSession(connection);
          // Gmail first: another card, the bot or Gmail itself may have changed the draft since the person started
          // editing, and saving every field would undo that change. Then the card shows what Gmail holds, and nothing is saved.
          const held = gmailDraftOf(await run(read, stillHere));
          if (!held || (held.body === undefined && !now.html)) return json(res, 502, userError("serverError.emailDraft.unreadable"));
          if (!draftUnchanged(base, held, now.html === true)) {
            const latest = card();
            if (latest) show({ ...latest, to: held.to, cc: held.cc, bcc: held.bcc, subject: held.subject, ...(held.body !== undefined && !latest.html ? { body: held.body } : {}) });
            return json(res, 409, userError("serverError.emailDraft.changed"));
          }
          data = await run(call, stillHere);
        } catch (error) {
          if (error instanceof DraftRefused) return json(res, error.status, error.refusal);
          const known = userErrorFields(error);
          const message = error instanceof Error ? error.message : String(error);
          return json(res, 502, known.errorKey ? { error: message, ...known } : userError("serverError.emailDraft.refused", { detail: message.slice(0, 300) }));
        }
        const current = card();
        if (!current) return json(res, 200, { ok: true });
        show({ ...current, ...draft, draftId: text(record(data)?.id) ?? current.draftId });
        return json(res, 200, { ok: true });
      });
    } finally {
      pressing.delete(key);
    }
  };
}
