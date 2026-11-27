// The draft card: after a bot's Gmail draft call succeeds, the server shows that draft in chat as a card the person can
// edit and save, send after a confirmation, or open in Gmail. Save and Send run from here through the bot's connected
// apps, under the same Rules and app permissions as the bot's own calls; no model sees or runs them.
//   POST /api/email-draft  {threadId, messageId, action: "save", draft}  →  {ok: true}
//   POST /api/email-draft  {threadId, messageId, action: "send", revision}  →  {ok: true}  (draftRevision of what the confirmation showed)
import { z } from "zod";

import { draftRevision, EMAIL_DRAFT_LIMITS, EMAIL_DRAFT_PATH, type EmailDraftCardData, type EmailDraftEdit } from "../shared/email-draft.ts";
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
  const body = record(data?.response_data) ?? data;
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
  return {
    app: "gmail", draftId, botId,
    // The card's first address is the draft's recipient_email, the rest its extra_recipients (as draftCall saves them).
    to: [...(first ? list(args.recipient_email) : before!.to.slice(0, 1)), ...(rest ? list(args.extra_recipients) : before!.to.slice(1))],
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

/** One Gmail call per draft at a time, shared by the card's Save and Send and the bot's own draft calls, so a bot's change
 *  can't land between Send's check of what the person confirmed and the send. `shownBy` holds, for each draft Gmail changed
 *  or may have changed, the one card that shows what Gmail now holds (cardKey), or undefined when none does: Send from
 *  any other card of that draft, in any conversation, would send something its card doesn't show. */
export interface DraftGuard {
  run<T>(draftIds: readonly string[], work: () => Promise<T>): Promise<T>;
  readonly shownBy: Map<string, string | undefined>;
}

export const cardKey = (threadId: string, messageId: string): string => `${threadId}:${messageId}`;

/** Whether the card `key` shows what Gmail holds for `draftId`, so Send from it sends what it shows. */
export const showsGmail = (guard: DraftGuard, draftId: string, key: string): boolean =>
  !guard.shownBy.has(draftId) || guard.shownBy.get(draftId) === key;

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
    shownBy: new Map(),
    // Several drafts are taken in sorted order, so two callers never each hold one the other waits for.
    run: <T>(draftIds: readonly string[], work: () => Promise<T>) =>
      [...new Set(draftIds)].sort().reduceRight((next: () => Promise<T>, draftId) => () => one(draftId, next), work)(),
  };
}

/** After the bot's relayed Gmail call succeeds (raw JSON or event-stream bytes): a saved draft shows or updates its card,
 *  a sent one turns its card into what was sent. Never throws: the card only shows the call, which already ran. A draft the
 *  call changed has no card showing it (`guard.shownBy`) until its card here is written. */
export function showDraftAnswer(store: DraftCardStore, threadId: string, botId: string, calls: readonly ConnectorCall[], bytes: Uint8Array, id: unknown, language?: string, guard?: DraftGuard): void {
  if (!calls.some((call) => isDraftTool(call.slug) || call.slug === GMAIL_SEND_DRAFT)) return;
  const changed = draftIdsIn(calls.filter((call) => call.slug === GMAIL_UPDATE_DRAFT));
  for (const draftId of changed) guard?.shownBy.set(draftId, undefined);
  let frame: Row | null;
  try {
    frame = parseMcpResponse(new TextDecoder().decode(bytes), id);
  } catch {
    return;
  }
  try {
    const card = draftCardFrom(calls, frame, botId, (draftId) => cardOf(store, threadId, draftId, botId)?.emailDraft);
    const message = card ? showDraftCard(store, threadId, card, language) : null;
    if (card && message) guard?.shownBy.set(card.draftId, cardKey(threadId, message.id));
    const sent = sentDraftFrom(calls, frame);
    if (sent) guard?.shownBy.delete(sent);
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

/** Thrown by a relay that checks the Rules and the bot's app permissions again right before it sends, and finds a refusal. */
export class DraftRefused extends Error {
  readonly refusal: Refusal;
  readonly status: number;
  constructor(refusal: Refusal, status = 403) {
    super(refusal.error);
    this.refusal = refusal;
    this.status = status;
  }
}

/** The relay to the connected-apps service a press runs through (it throws DraftRefused when a check fails right before
 *  it sends), or why it can't run. */
export type DraftConnection =
  | { ok: true; relay(payload: unknown, transportSessionId: string | undefined, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }> }
  | { ok: false; refusal: Refusal };

export interface EmailDraftRouteDeps {
  sees(auth: RequestAuth, threadId: string): boolean;
  /** A room's conversation: its draft cards are view-only. */
  inRoom(threadId: string): boolean;
  /** The person may write to this bot. */
  mayChat(auth: RequestAuth, botId: string): boolean;
  store: DraftCardStore;
  /** Shared with the bot's own draft calls (showDraftAnswer). */
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
const where = { threadId: z.string().min(1).max(200), messageId: z.string().min(1).max(200) };
const press = z.discriminatedUnion("action", [
  z.object({ ...where, action: z.literal("save"), draft: edit }).strict(),
  // Send names the draft as its confirmation showed it, so a draft changed since then is never sent unseen.
  z.object({ ...where, action: z.literal("send"), revision: z.string().min(1).max(40) }).strict(),
]);

/** The Composio call a press makes: Save with the edited `draft`, else Send. */
export function draftCall(card: EmailDraftCardData, draft?: EmailDraftEdit): ConnectorCall {
  const account = card.account ? { account: card.account } : {};
  if (!draft) return { slug: GMAIL_SEND_DRAFT, arguments: { user_id: "me", draft_id: card.draftId }, ...account };
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

/** Runs `call`; `dispatch` runs right before the tool call goes out to Gmail, and may refuse it by throwing DraftRefused. */
async function runCall(connection: Extract<DraftConnection, { ok: true }>, call: ConnectorCall, dispatch: () => void): Promise<unknown> {
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const init = await connection.relay({
    jsonrpc: "2.0", id: `${CALL_ID}-init`, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-email-draft", version: "1" } },
  }, undefined, signal);
  if (init.status !== 200) throw unreachable(init.status);
  await connection.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, init.transportSessionId, signal).catch(() => undefined);
  dispatch();
  const answer = await connection.relay({
    jsonrpc: "2.0", id: CALL_ID, method: "tools/call",
    params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: call.slug, arguments: call.arguments, ...(call.account ? { account: call.account } : {}) }] } },
  }, init.transportSessionId, signal);
  if (answer.status !== 200) throw unreachable(answer.status);
  return toolData(call.slug, parseMcpResponse(new TextDecoder().decode(answer.bytes), CALL_ID));
}

export function createEmailDraftRoutes(deps: EmailDraftRouteDeps): RouteHandler {
  // One press per card at a time, so a double tap can never send twice.
  const pressing = new Set<string>();
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== EMAIL_DRAFT_PATH) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    let raw: unknown;
    try { raw = await readBody(req, 256_000); } catch { return json(res, 400, { error: "Send threadId, messageId and action." }); }
    const parsed = press.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: "Send threadId, messageId and action." });
    const { threadId, messageId } = parsed.data;
    const card = () => deps.store.messagesFor(threadId).find((message) => message.id === messageId)?.emailDraft;
    const shown = deps.sees(auth, threadId) && !deps.inRoom(threadId) ? card() : undefined;
    if (!shown || !deps.mayChat(auth, shown.botId)) return json(res, 404, userError("serverError.emailDraft.notHere"));
    const key = cardKey(threadId, messageId);
    if (pressing.has(key)) return json(res, 409, userError("serverError.emailDraft.busy"));
    pressing.add(key);
    try {
      // Checked and run while no other call can change this draft, so Send sends exactly what the confirmation showed.
      return await deps.guard.run([shown.draftId], async () => {
        const now = card();
        if (!now) return json(res, 404, userError("serverError.emailDraft.notHere"));
        if (now.sentAt) return json(res, 409, userError("serverError.emailDraft.alreadySent"));
        if (parsed.data.action === "send" && (!showsGmail(deps.guard, now.draftId, key) || draftRevision(now) !== parsed.data.revision)) return json(res, 409, userError("serverError.emailDraft.changed"));
        const draft = parsed.data.action === "save" ? parsed.data.draft : undefined;
        const call = draftCall(now, draft);
        const connection = await deps.connection(auth, now.botId, [call]);
        if (!connection.ok) return json(res, 403, connection.refusal);
        const had = deps.guard.shownBy.has(now.draftId);
        const was = deps.guard.shownBy.get(now.draftId);
        let data: unknown;
        try {
          data = await runCall(connection, call, () => {
            // The person may have lost the conversation or the bot while the call waited for the draft or was set up.
            if (!deps.sees(auth, threadId) || deps.inRoom(threadId) || !deps.mayChat(auth, now.botId)) {
              throw new DraftRefused(userError("serverError.emailDraft.notHere"), 404);
            }
            // From here a Save may change the draft in Gmail even if its answer never comes back: no card shows it yet.
            if (draft) deps.guard.shownBy.set(now.draftId, undefined);
          });
        } catch (error) {
          if (error instanceof DraftRefused) {
            // Refused before it went out, so Gmail didn't change.
            if (had) deps.guard.shownBy.set(now.draftId, was);
            else deps.guard.shownBy.delete(now.draftId);
            return json(res, error.status, error.refusal);
          }
          const known = userErrorFields(error);
          const message = error instanceof Error ? error.message : String(error);
          return json(res, 502, known.errorKey ? { error: message, ...known } : userError("serverError.emailDraft.refused", { detail: message.slice(0, 300) }));
        }
        const current = card();
        if (!current) return json(res, 200, { ok: true });
        const next: EmailDraftCardData = draft
          ? { ...current, ...draft, draftId: text(record(data)?.id) ?? current.draftId }
          : { ...current, sentAt: Date.now() };
        const written = deps.store.patchMessage(threadId, messageId, { text: draftCardText(next, deps.language?.(threadId)), emailDraft: next });
        if (!draft) deps.guard.shownBy.delete(now.draftId);
        else if (written) deps.guard.shownBy.set(next.draftId, key);
        return json(res, 200, { ok: true });
      });
    } finally {
      pressing.delete(key);
    }
  };
}
