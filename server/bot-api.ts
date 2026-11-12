// A bot's API: one key per bot, off by default, that lets an outside caller send the bot a message through the webhook
// receiver and read its reply. The key is random, shown once and kept hashed only, like a webhook secret.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { defuse } from "./records-block.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { API_WHO, AUTHORITY, fromNote } from "./provenance-label.ts";
import { parseJson } from "./schema.ts";

export const BOT_API_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
/** Turns one bot's API may have running at once before a new call is refused. */
export const BOT_API_MAX_PENDING = 50;
export const BOT_API_MAX_MESSAGE_CHARS = 20_000;
/** Per bot: one bot's callers can't push another's calls out. */
const MAX_ATTEMPTS = 200;
const SAVE_AFTER_MS = 1_000;
const KEY_PREFIX = "bak_";
const REFUSED_BURST_MS = 15 * 60_000;

const recordSchema = z.object({
  botId: z.string().min(1),
  keyHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Whose key it is, on a Team Cloud: it goes when they leave. */
  mintedBy: z.string().optional(),
  createdAt: z.number().finite().nonnegative(),
  keyCreatedAt: z.number().finite().nonnegative(),
  callCount: z.number().int().nonnegative(),
  lastCalledAt: z.number().finite().nonnegative().optional(),
  trustedSource: z.literal("qm").optional(),
});
const attemptSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  receivedAt: z.number().finite().nonnegative(),
  outcome: z.enum(["accepted", "rejected"]),
  statusCode: z.number().int().min(100).max(599),
  threadId: z.string().optional(),
  preview: z.string().optional(),
  reason: z.string().optional(),
  repeats: z.number().int().positive().optional(),
  actorId: z.string().regex(/^[\x21-\x7e]{1,256}$/).optional(),
  scopeId: z.string().max(512).optional(),
  authority: z.literal("on_their_behalf_at_your_level").optional(),
  boundary: z.literal("exact_request_only").optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  bots: z.array(recordSchema),
  attempts: z.array(attemptSchema).optional(),
});

type StoredBotApi = z.output<typeof recordSchema>;
export type BotApiAttempt = z.output<typeof attemptSchema>;

/** What the app may see: never the hash. */
export interface BotApiStatus {
  enabled: boolean;
  keyCreatedAt?: number;
  callCount: number;
  lastCalledAt?: number;
  trustedSource?: "qm";
}

export interface BotApiDelegationContext {
  schema: "shifu.qm.bot-delegation.v1";
  actorId: string;
  scopeId: string;
  authority: "on_their_behalf_at_your_level";
  boundary: "exact_request_only";
  request: string;
}

const qmDelegationSchema = z.object({
  schema: z.literal("shifu.qm.bot-delegation.v1"),
  requester: z.object({
    actorId: z.string().regex(/^[\x21-\x7e]{1,256}$/),
    scopeId: z.string().min(1).max(512),
  }).strict(),
  authorization: z.object({
    kind: z.literal("explicit_single_turn_delegation"),
    authority: z.literal("on_their_behalf_at_your_level"),
    boundary: z.literal("exact_request_only"),
    doesNotExpandReceiverPermissions: z.literal(true),
  }).strict(),
  request: z.string().min(1).max(BOT_API_MAX_MESSAGE_CHARS),
}).strict();

export function qmDelegationContext(message: string, trustedActor: string | undefined): BotApiDelegationContext | null {
  if (!trustedActor) return null;
  let value: unknown;
  try { value = parseJson(message); } catch { return null; }
  const parsed = qmDelegationSchema.safeParse(value);
  if (!parsed.success) return null;
  const { requester, authorization } = parsed.data;
  if (requester.actorId !== trustedActor || requester.scopeId !== `personal:${trustedActor}`) return null;
  return {
    schema: parsed.data.schema,
    actorId: trustedActor,
    scopeId: requester.scopeId,
    authority: authorization.authority,
    boundary: authorization.boundary,
    request: parsed.data.request,
  };
}

export function claimsQmDelegation(message: string): boolean {
  try {
    const value = parseJson(message);
    return typeof value === "object" && value !== null && "schema" in value && (value as { schema?: unknown }).schema === "shifu.qm.bot-delegation.v1";
  } catch { return false; }
}

export interface BotApiManagerOptions {
  file?: string;
  now?: () => number;
}

export function hashBotApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function newKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export class BotApiManager {
  private readonly file: string;
  private readonly now: () => number;
  private bots: StoredBotApi[] = [];
  private attempts: BotApiAttempt[] = [];
  private rate = new Map<string, number[]>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Saves are refused while set, so an empty state never overwrites an unreadable file. */
  private unreadable = false;

  constructor(options: BotApiManagerOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "bot-api.json");
    this.now = options.now ?? Date.now;
    try {
      const parsed = fileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      this.bots = parsed.data.bots;
      this.attempts = parsed.data.attempts ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unreadable = true;
        console.error(`bot api: ignoring unreadable ${this.file}: ${error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "unable to read"}`);
      }
    }
  }

  status(botId: string): BotApiStatus {
    const record = this.bots.find((candidate) => candidate.botId === botId);
    if (!record) return { enabled: false, callCount: 0 };
    return { enabled: true, keyCreatedAt: record.keyCreatedAt, callCount: record.callCount, ...(record.lastCalledAt !== undefined ? { lastCalledAt: record.lastCalledAt } : {}), ...(record.trustedSource ? { trustedSource: record.trustedSource } : {}) };
  }

  trustedSource(botId: string): "qm" | undefined {
    return this.bots.find((candidate) => candidate.botId === botId)?.trustedSource;
  }

  setTrustedSource(botId: string, source: "qm" | null): BotApiStatus {
    this.assertWritable();
    const record = this.bots.find((candidate) => candidate.botId === botId);
    if (!record) throw Object.assign(new Error("The Bot API is off for this bot"), { status: 409 });
    if (source) record.trustedSource = source; else delete record.trustedSource;
    this.save();
    return this.status(botId);
  }

  /** Turns the API on with a fresh key, or replaces the key of one already on. The key is returned once and never kept. */
  enable(botId: string, mintedBy?: string): { key: string; status: BotApiStatus } {
    this.assertWritable();
    const key = newKey();
    const now = this.now();
    const record = this.bots.find((candidate) => candidate.botId === botId);
    if (record) {
      record.keyHash = hashBotApiKey(key);
      record.keyCreatedAt = now;
      if (mintedBy) record.mintedBy = mintedBy; else delete record.mintedBy;
    } else {
      this.bots.unshift({ botId, keyHash: hashBotApiKey(key), ...(mintedBy ? { mintedBy } : {}), createdAt: now, keyCreatedAt: now, callCount: 0 });
    }
    this.rate.delete(botId);
    this.save();
    return { key, status: this.status(botId) };
  }

  disable(botId: string): boolean {
    const at = this.bots.findIndex((candidate) => candidate.botId === botId);
    if (at === -1) return false;
    this.assertWritable();
    this.bots.splice(at, 1);
    this.rate.delete(botId);
    this.save();
    return true;
  }

  /** A teammate who left takes the keys they made: whoever still holds one was given it by them. */
  revokeMintedBy(person: string): string[] {
    const gone = this.bots.filter((record) => record.mintedBy === person).map((record) => record.botId);
    for (const botId of gone) this.disable(botId);
    return gone;
  }

  /** A deleted bot's API goes with it, its calls included. */
  removeForBot(botId: string): void {
    if (!this.bots.some((candidate) => candidate.botId === botId) && !this.attempts.some((attempt) => attempt.botId === botId)) return;
    this.assertWritable();
    this.bots = this.bots.filter((candidate) => candidate.botId !== botId);
    this.attempts = this.attempts.filter((attempt) => attempt.botId !== botId);
    this.rate.delete(botId);
    this.save();
  }

  enabled(botId: string): boolean {
    return this.bots.some((candidate) => candidate.botId === botId);
  }

  /** Constant-time: a wrong key costs the same as a right one, whatever it shares with it. */
  authorize(botId: string, key: string): boolean {
    const record = this.bots.find((candidate) => candidate.botId === botId);
    if (!record || !key) return false;
    const actual = Buffer.from(hashBotApiKey(key), "hex");
    const expected = Buffer.from(record.keyHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Counts a call against the key's minute; false once the minute's calls are used up. */
  admit(botId: string): boolean {
    const now = this.now();
    const recent = (this.rate.get(botId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= BOT_API_RATE_LIMIT) return false;
    recent.push(now);
    this.rate.set(botId, recent);
    return true;
  }

  /** The calls since it was last switched on, which is what its count counts. */
  callsSinceOn(botId: string): BotApiAttempt[] {
    const record = this.bots.find((candidate) => candidate.botId === botId);
    return record ? this.listAttempts(botId).filter((attempt) => attempt.receivedAt >= record.createdAt) : [];
  }

  listAttempts(botId: string): BotApiAttempt[] {
    return this.attempts.filter((attempt) => attempt.botId === botId).map((attempt) => ({ ...attempt }));
  }

  record(botId: string, details: Omit<BotApiAttempt, "id" | "botId" | "receivedAt">): BotApiAttempt {
    const attempt: BotApiAttempt = { id: randomUUID(), botId, receivedAt: this.now(), outcome: details.outcome, statusCode: details.statusCode };
    if (details.threadId) attempt.threadId = details.threadId;
    if (details.preview) attempt.preview = redactSecretsInText(details.preview).replace(/\s+/g, " ").trim().slice(0, 200);
    if (details.reason) attempt.reason = redactSecretsInText(details.reason).slice(0, 500);
    if (details.actorId) attempt.actorId = details.actorId;
    if (details.scopeId) attempt.scopeId = details.scopeId;
    if (details.authority) attempt.authority = details.authority;
    if (details.boundary) attempt.boundary = details.boundary;
    this.keep(attempt);
    const record = this.bots.find((candidate) => candidate.botId === botId);
    if (record && details.outcome === "accepted") {
      record.callCount += 1;
      record.lastCalledAt = attempt.receivedAt;
    }
    this.saveSoon();
    return attempt;
  }

  /** Anyone who can reach the receiver can send these: one rolling row per burst, in memory until the next real change. */
  recordRefused(botId: string, statusCode: 401 | 403, reason: string): BotApiAttempt {
    const at = this.attempts.findLastIndex((attempt) => attempt.botId === botId);
    const burst = at === -1 ? undefined : this.attempts[at]!;
    if (burst?.outcome === "rejected" && burst.statusCode === statusCode && this.now() - burst.receivedAt <= REFUSED_BURST_MS) {
      burst.receivedAt = this.now();
      burst.repeats = (burst.repeats ?? 1) + 1;
      return burst;
    }
    const attempt: BotApiAttempt = { id: randomUUID(), botId, receivedAt: this.now(), outcome: "rejected", statusCode, reason };
    this.keep(attempt);
    return attempt;
  }

  private keep(attempt: BotApiAttempt): void {
    this.attempts.push(attempt);
    const own = this.attempts.filter((candidate) => candidate.botId === attempt.botId);
    if (own.length > MAX_ATTEMPTS) this.attempts.splice(this.attempts.indexOf(own[0]!), 1);
  }

  /** A caller decides how often this runs, so it never writes per call: a synchronous save would block the server. */
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_AFTER_MS);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("The saved Bot API settings could not be read. Repair bot-api.json before changing them."), { status: 503 });
  }

  private save(): void {
    if (this.unreadable) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, bots: this.bots, attempts: this.attempts }, null, 2), { mode: 0o600 });
  }
}

export const BOT_API_MESSAGE_DATA = "[UNTRUSTED BOT API MESSAGE]";

/** Security: the tag names a stored file for the turn to load, so a caller's copy of it never reaches the turn. */
export function withoutAttachedImages(message: string): string {
  return defuse(message).replace(/<(\s*attached-image)/gi, "($1");
}

/** The caller's words go to the model as data from outside, never as the person's request, and can't pass for a note. */
export function botApiPrompt(message: string, receivedAt: number): string {
  return [
    fromNote(API_WHO, "message", AUTHORITY.info),
    BOT_API_MESSAGE_DATA,
    defuse(`Received: ${new Date(receivedAt).toISOString()}`),
    "",
    withoutAttachedImages(message),
    "[/UNTRUSTED BOT API MESSAGE]",
  ].join("\n");
}

export function botApiDelegationPrompt(context: BotApiDelegationContext, receivedAt: number): string {
  return [
    fromNote(`QM for ${context.actorId}`, "assignment", AUTHORITY.behalf),
    `[OPENMAUSBOT VERIFIED DELEGATION schema=${context.schema} actor=${JSON.stringify(context.actorId)} scope=${JSON.stringify(context.scopeId)} authority=${context.authority} boundary=${context.boundary}]`,
    defuse(`Received: ${new Date(receivedAt).toISOString()}`),
    "",
    withoutAttachedImages(context.request),
    "[/OPENMAUSBOT VERIFIED DELEGATION]",
  ].join("\n");
}
