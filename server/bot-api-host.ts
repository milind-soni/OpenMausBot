// The Bot API's two sides. Outside: `POST /hooks/api/bots/<id>/messages` on the webhook receiver, a bearer key, a
// message in, the bot's reply out; the turn it starts is outside work (the "api" trigger), so it never acts for the
// person, is told the message came from outside, and anything that needs an approval waits for the person in the thread.
// Inside: the app's routes to switch it on, mint a key and switch it off, open only to whoever may edit the bot.
import { z } from "zod";

import { redactSecretsInText } from "../shared/redact.ts";
import { BOT_API_UPGRADE, botApiEndpoint, type BotApiReply } from "../shared/bot-api.ts";
import type { AdminActionRow } from "./admin-activity.ts";
import { BOT_API_MAX_MESSAGE_CHARS, BOT_API_MAX_PENDING, BotApiManager, botApiPrompt, withoutAttachedImages, type BotApiAttempt, type BotApiStatus } from "./bot-api.ts";
import { personKey } from "./person-key.ts";
import type { RequestAuth } from "./request-auth.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { parseJson, schemaIssue } from "./schema.ts";
import type { Message, Store } from "./store.ts";
import { bearerSecret, header, json, readRawBody, type IngressDoor } from "./webhook-ingress.ts";

/** How long a call waits by default before answering "working" with its thread id. Under the 60 s that Fly's proxy is reported
 * (community.fly.io, staff replies, 2022-2024) to allow a connection with no bytes: a dropped answer would lose the thread id. */
export const BOT_API_DEFAULT_WAIT_MS = 50_000;
const BOT_API_MAX_WAIT_MS = 5 * 60_000;
const POLL_MS = 250;
const PUBLIC_PATH = /^\/hooks\/api\/bots\/([\w-]{1,128})\/messages$/;
const APP_PATH = /^\/api\/bots\/([\w-]{1,128})\/bot-api(?:\/(new-key))?$/;

const callSchema = z.object({
  message: z.string().min(1).max(BOT_API_MAX_MESSAGE_CHARS),
  thread: z.string().regex(/^[\w-]{1,128}$/).optional(),
  /** Seconds to wait for the reply, for a caller that knows nothing in its path drops a quiet connection. */
  wait: z.number().min(0).max(BOT_API_MAX_WAIT_MS / 1000).optional(),
});
const switchSchema = z.object({ enabled: z.boolean() });

type TurnOutcome = { ok: boolean; text: string; cards?: unknown };

export interface BotApiTurnOptions {
  threadId: string;
  automationSource: "api";
  unattended: true;
  userMessage: Message;
  onSettled: (outcome: TurnOutcome) => void;
  onDispatchError: (message: string) => void;
}

export interface BotApiHostDeps {
  store: Pick<Store, "bot" | "taskByThread" | "createTask" | "patchTask" | "appendMessage" | "messagesFor" | "onChange">;
  startTurn(botId: string, text: string, opts: BotApiTurnOptions): Promise<unknown>;
  threadBusy(botId: string, threadId: string): boolean;
  /** Whether a new turn would start now, before anything is written. */
  canStart(botId: string, threadId: string): boolean;
  /** This bot's AI can run a turn with no shell and no tools; one that can't doesn't take a call. */
  canConfine(botId: string): boolean;
  /** A thread the API opened whose turn never started. */
  discard?(botId: string, threadId: string): void;
  /** False on a plan that doesn't include the Bot API; asked on every call, so an upgrade counts at once. Absent: included. */
  included?(): boolean;
  /** A thread the API just opened: whose it is on a Cloud. */
  opened?(threadId: string): void;
  /** The webhook receiver's public base, as the app advertises it for webhooks. */
  hooksBaseUrl(): string;
  /** Why this person may not change the bot's API; null when they may. */
  manageRefusal(auth: RequestAuth, botId: string): string | null;
  /** The same claim a webhook delivery makes on arrival (wakes, moves, maintenance). */
  claimRequest?(): () => void;
  /** Settings → Activity on a Team Cloud. */
  record?(auth: RequestAuth, row: Omit<AdminActionRow, "at" | "actor">): void;
  manager?: BotApiManager;
  waitMs?: number;
}

/** `detail` is kept with the call for the person; the caller only ever gets `message`, so no engine error, path or
 * internal wording leaves through the door. */
function fail(status: number, message: string, detail?: string): never {
  throw Object.assign(new Error(message), { status, detail, forCaller: true });
}

/** Words written for a caller, or the fixed ones: an unexpected error's own text could name anything. */
function callerWords(error: unknown): string {
  return z.object({ forCaller: z.literal(true), message: z.string() }).safeParse(error).data?.message ?? COULD_NOT_ANSWER;
}

const COULD_NOT_ANSWER = "The bot could not answer. Open this thread in the app to see why.";
const BUSY = "The bot is busy. Try again soon.";
const CANNOT_CONFINE = "This bot's AI can't take Bot API calls. Choose another AI for this bot.";

function detailOf(error: unknown): string {
  const parsed = z.object({ detail: z.string() }).safeParse(error);
  return redactSecretsInText(parsed.success ? parsed.data.detail : error instanceof Error ? error.message : String(error));
}

const minter = (auth: RequestAuth) => (auth.kind === "session" ? personKey(auth.session) : undefined);

function statusOf(error: unknown): number {
  const parsed = z.object({ status: z.number().int() }).safeParse(error);
  return parsed.success ? parsed.data.status : 500;
}

/** A card the bot put to the person and nobody has answered: the call stops there. */
function pendingCard(lines: readonly Message[]): boolean {
  return lines.some((line) => line.card?.requestId !== undefined && !line.card.answered && !line.card.dismissed);
}

function replyText(lines: readonly Message[]): string {
  return redactSecretsInText(lines.filter((line) => line.role === "bot" && line.kind === "text" && typeof line.text === "string" && line.text.trim())
    .map((line) => line.text!.trim()).join("\n\n"));
}

export function createBotApiHost(deps: BotApiHostDeps) {
  const manager = deps.manager ?? new BotApiManager();
  const waitMs = deps.waitMs ?? BOT_API_DEFAULT_WAIT_MS;
  /** Turns the API started that have not settled, per bot: the pending cap counts these. */
  const running = new Map<string, Set<string>>();
  deps.store.onChange((change) => { if (change.type === "bot.deleted") manager.removeForBot(change.botId); });

  const included = () => deps.included?.() !== false;
  const pendingFor = (botId: string) => {
    const set = running.get(botId);
    for (const threadId of set ?? []) if (!deps.threadBusy(botId, threadId)) set!.delete(threadId);
    return set?.size ?? 0;
  };
  const markRunning = (botId: string, threadId: string, on: boolean) => {
    const set = running.get(botId) ?? new Set<string>();
    if (on) set.add(threadId); else set.delete(threadId);
    if (set.size) running.set(botId, set); else running.delete(botId);
  };

  /** The thread as the caller sees it now: only what answers the caller's own last message, up to the next thing anyone
   * else typed there. A person's words and the bot's answers to them stay in the app. */
  function threadState(botId: string, threadId: string): BotApiReply {
    const lines = deps.store.messagesFor(threadId);
    const last = lines.findLastIndex((line) => line.role === "user" && line.via === "api");
    const rest = lines.slice(last + 1);
    const next = rest.findIndex((line) => line.role === "user");
    const after = next === -1 ? rest : rest.slice(0, next);
    if (pendingCard(after)) return { thread: threadId, status: "needs_approval" };
    if (deps.threadBusy(botId, threadId)) return { thread: threadId, status: "working" };
    return { reply: replyText(after), thread: threadId };
  }

  async function runCall(botId: string, call: z.output<typeof callSchema>, turnStarted: () => void): Promise<{ status: number; body: BotApiReply }> {
    const store = deps.store;
    let threadId = call.thread;
    if (threadId !== undefined) {
      const task = store.taskByThread(botId, threadId);
      // Only a thread this API opened: the caller never writes into the person's own conversations.
      if (!task || task.botApi !== true) fail(404, "no such thread");
      if (deps.threadBusy(botId, threadId)) return { status: 409, body: { thread: threadId, status: "working" } };
    }
    if (!deps.canStart(botId, threadId ?? "")) fail(409, BUSY, "The bot already had as many conversations going as it may");
    const message = withoutAttachedImages(call.message);
    let opened = false;
    if (threadId === undefined) {
      // Asks from the start, with none of the bot's saved allowances: nothing may answer an approval for an outside caller.
      const task = store.createTask(botId, message.slice(0, 80), false, undefined, undefined, "ask");
      if (!task) fail(404, "no such bot");
      threadId = task.threadId;
      opened = true;
      store.patchTask(botId, threadId, { botApi: true, outside: true });
      deps.opened?.(threadId);
    }
    const receivedAt = Date.now();
    const userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text: message, via: "api" });
    const after = () => { const all = store.messagesFor(threadId!); return all.slice(all.findIndex((line) => line.id === userMessage.id) + 1); };
    let settled: TurnOutcome | undefined;
    let dispatchError: string | undefined;
    markRunning(botId, threadId, true);
    try {
      await deps.startTurn(botId, botApiPrompt(message, receivedAt), {
        threadId, automationSource: "api", unattended: true, userMessage,
        onSettled: (outcome) => { settled = outcome; markRunning(botId, threadId!, false); },
        onDispatchError: (message) => { dispatchError = message; markRunning(botId, threadId!, false); },
      });
    } catch (error) {
      markRunning(botId, threadId, false);
      if (opened) deps.discard?.(botId, threadId);
      const busy = z.object({ code: z.enum(["thread_busy", "thread_limit"]) }).safeParse(error).success;
      fail(busy ? 409 : 502, busy ? BUSY : COULD_NOT_ANSWER, error instanceof Error ? error.message : String(error));
    }
    turnStarted();
    const deadline = Date.now() + (call.wait === undefined ? waitMs : call.wait * 1000);
    for (;;) {
      if (dispatchError !== undefined) fail(502, COULD_NOT_ANSWER, dispatchError);
      if (settled) break;
      if (pendingCard(after())) return { status: 202, body: { thread: threadId, status: "needs_approval" } };
      if (Date.now() >= deadline) return { status: 202, body: { thread: threadId, status: "working" } };
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (pendingCard(after())) return { status: 202, body: { thread: threadId, status: "needs_approval" } };
    if (!settled.ok) fail(502, COULD_NOT_ANSWER, settled.text);
    return { status: 200, body: { reply: replyText(after()), thread: threadId } };
  }

  const door: IngressDoor = async (req, res, url) => {
    const match = PUBLIC_PATH.exec(url.pathname);
    if (!match) return false;
    const botId = match[1]!;
    if (req.method !== "POST" && req.method !== "GET") { json(res, 405, { error: "The Bot API takes POST and GET" }); return true; }
    let claim: (() => void) | undefined;
    try {
      claim = deps.claimRequest?.();
    } catch (error) {
      json(res, statusOf(error), { error: error instanceof Error ? error.message : "Try again soon" });
      return true;
    }
    // A call can wait minutes for its reply: the claim that holds off maintenance ends once the turn has started.
    const release = () => { claim?.(); claim = undefined; };
    try {
      if (!manager.enabled(botId) || !deps.store.bot(botId)) {
        if (deps.store.bot(botId)) manager.recordRefused(botId, 403, "The Bot API is off for this bot");
        json(res, 403, { error: "The Bot API is off for this bot" });
        return true;
      }
      if (!manager.authorize(botId, bearerSecret(req))) {
        manager.recordRefused(botId, 401, "Invalid key");
        json(res, 401, { error: "Invalid key" });
        return true;
      }
      if (!included()) {
        manager.recordRefused(botId, 403, BOT_API_UPGRADE);
        json(res, 403, { error: BOT_API_UPGRADE });
        return true;
      }
      if (!deps.canConfine(botId)) {
        manager.recordRefused(botId, 403, CANNOT_CONFINE);
        json(res, 403, { error: CANNOT_CONFINE });
        return true;
      }
      if (req.method === "GET") {
        const threadId = url.searchParams.get("thread") ?? "";
        const task = /^[\w-]{1,128}$/.test(threadId) ? deps.store.taskByThread(botId, threadId) : undefined;
        if (!task || task.botApi !== true) { json(res, 404, { error: "no such thread" }); return true; }
        const state = threadState(botId, threadId);
        json(res, "reply" in state ? 200 : 202, state);
        return true;
      }
      let call: z.output<typeof callSchema>;
      try {
        const raw = await readRawBody(req);
        const contentType = header(req, "content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("json")) fail(415, "Send JSON: Content-Type: application/json");
        const parsed = callSchema.safeParse(parseJson(raw));
        if (!parsed.success) fail(400, schemaIssue(parsed.error, "Send {\"message\": \"…\"}"));
        call = parsed.data;
      } catch (error) {
        const status = statusOf(error) === 500 ? 400 : statusOf(error);
        const message = statusOf(error) === 500 ? "The body isn't valid JSON" : callerWords(error) === COULD_NOT_ANSWER && error instanceof Error ? error.message : callerWords(error);
        manager.record(botId, { outcome: "rejected", statusCode: status, reason: message });
        json(res, status, { error: message });
        return true;
      }
      if (!manager.admit(botId)) {
        manager.record(botId, { outcome: "rejected", statusCode: 429, reason: "Rate limit exceeded", preview: call.message });
        json(res, 429, { error: "Too many calls: this key takes 10 a minute" });
        return true;
      }
      if (pendingFor(botId) >= BOT_API_MAX_PENDING) {
        manager.record(botId, { outcome: "rejected", statusCode: 409, reason: "The bot is busy", preview: call.message });
        json(res, 409, { error: `The bot is busy: ${BOT_API_MAX_PENDING} calls are still being answered` });
        return true;
      }
      try {
        const answer = await runCall(botId, call, release);
        manager.record(botId, { outcome: "accepted", statusCode: answer.status, threadId: answer.body.thread, preview: call.message,
          reason: "reply" in answer.body ? "Replied" : answer.body.status === "needs_approval" ? "Stopped at an approval" : "Still working" });
        json(res, answer.status, answer.body);
      } catch (error) {
        manager.record(botId, { outcome: "rejected", statusCode: statusOf(error), reason: detailOf(error), preview: call.message });
        json(res, statusOf(error), { error: callerWords(error) });
      }
      return true;
    } finally {
      release();
    }
  };

  /** What callers sent is for the people who manage the key, not everyone who can see the bot. */
  const view = (botId: string, auth: RequestAuth): BotApiStatus & { included: boolean; canTakeCalls: boolean; url: string; canManage: boolean; calls: BotApiAttempt[] } => {
    const canManage = deps.manageRefusal(auth, botId) === null;
    return { included: included(), canTakeCalls: deps.canConfine(botId), ...manager.status(botId), url: botApiEndpoint(deps.hooksBaseUrl(), botId), canManage, calls: canManage ? manager.callsSinceOn(botId).slice(-10).reverse() : [] };
  };

  const routes: RouteHandler = async ({ req, res, path, method, auth, json: answer, readBody }) => {
    const match = APP_PATH.exec(path);
    if (!match) return PASS;
    const botId = match[1]!;
    const bot = deps.store.bot(botId);
    if (!bot) return answer(res, 404, { error: "no such bot" });
    if (method === "GET" && !match[2]) return answer(res, 200, view(botId, auth));
    if (method !== "POST") return PASS;
    const refusal = deps.manageRefusal(auth, botId);
    if (refusal) return answer(res, 403, { error: refusal });
    const target = { kind: "bot", id: bot.id, name: bot.name };
    try {
      if (match[2] === "new-key") {
        if (!included()) return answer(res, 403, { error: BOT_API_UPGRADE, upgrade: true });
        if (!manager.enabled(botId)) return answer(res, 409, { error: "The Bot API is off for this bot" });
        const minted = manager.enable(botId, minter(auth));
        deps.record?.(auth, { category: "bot-api", action: "bot-api.new-key", target });
        return answer(res, 200, { key: minted.key, ...view(botId, auth) });
      }
      const parsed = switchSchema.safeParse(await readBody(req));
      if (!parsed.success) return answer(res, 400, { error: schemaIssue(parsed.error, "Send {\"enabled\": true | false}") });
      if (parsed.data.enabled) {
        // Already on keeps its key: only New key replaces one an app may be using.
        if (!included()) return answer(res, 403, { error: BOT_API_UPGRADE, upgrade: true });
        if (manager.enabled(botId)) return answer(res, 200, view(botId, auth));
        const minted = manager.enable(botId, minter(auth));
        deps.record?.(auth, { category: "bot-api", action: "bot-api.on", target });
        return answer(res, 200, { key: minted.key, ...view(botId, auth) });
      }
      if (manager.disable(botId)) deps.record?.(auth, { category: "bot-api", action: "bot-api.off", target });
      return answer(res, 200, view(botId, auth));
    } catch (error) {
      return answer(res, statusOf(error), { error: error instanceof Error ? error.message : String(error) });
    }
  };

  return { manager, door, routes };
}
