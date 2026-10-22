import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { defuse } from "./records-block.ts";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RoutineRunOn } from "./routines.ts";
import { parseJson, schemaIssue, type JsonValue } from "./schema.ts";

export type WebhookTriggerInput = z.input<typeof triggerInputSchema>;
export type WebhookVerificationSample = z.output<typeof verificationSampleSchema>;
export type WebhookAttempt = z.output<typeof webhookAttemptSchema>;
export type WebhookAttemptOutcome = WebhookAttempt["outcome"];
type StoredWebhookTrigger = z.output<typeof storedWebhookSchema>;
export type WebhookTrigger = Omit<StoredWebhookTrigger, "secretHash" | "sealedSecret">;
type DeliveryReceipt = z.output<typeof deliveryReceiptSchema>;
type WebhookFile = z.output<typeof webhookFileSchema>;

type CleanWebhookInput = Omit<
  WebhookTrigger,
  | "id"
  | "endpointId"
  | "createdAt"
  | "updatedAt"
  | "lastReceivedAt"
  | "lastRunId"
  | "deliveryCount"
  | "verifiedAt"
  | "verificationSample"
>;

interface CreatedWebhook {
  webhook: WebhookTrigger;
  secret: string;
}

export interface WebhookEvent {
  payload: JsonValue;
  contentType?: string;
  eventName?: string;
  userAgent?: string;
  deliveryId?: string;
}

export interface WebhookReceiveResult {
  runId?: string;
  /** delivery:"post" room webhook: the room thread the message was appended to. */
  threadId?: string;
  deliveryId: string;
  duplicate: boolean;
  captured?: boolean;
  ignored?: boolean;
}

export interface WebhookManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (event: WebhookManagerEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  enqueue: (input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }) => { id: string };
  cancelQueued?: (webhookId: string, message: string) => void;
  pendingRuns?: (webhookId: string) => number;
  /** delivery:"post" sink: lands in the trigger's own stable thread, never a caller-supplied one. */
  post?: (botId: string, threadId: string, text: string) => void;
  /** Absent, every post delivery fails with 503 rather than falling back to an ambient thread
   *  (https://github.com/milind-soni/OpenMausBot/issues/2071). */
  resolvePostThread?: (trigger: WebhookTrigger, forceNew: boolean) => string | undefined;
  /** delivery:"post" with a groupId: the room sink. Absent, a room delivery fails with 503
   *  rather than downgrading to a thread post. */
  roomPost?: (trigger: WebhookTrigger, payload: JsonValue) => Promise<{ posted: true; attachments: number; threadId: string }>;
  findRun?: (webhookId: string, deliveryId: string) => { id: string } | null;
  /** membership + section rules for a (bot, room) pair; runs on create, on patch, and again per delivery. */
  roomMember?: (botId: string, groupId: string) => { ok: true } | { ok: false; status: number; error: string };
}

export type WebhookManagerEvent =
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.deleted"; webhookId: string }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt };

const MAX_DELIVERIES = 2_000;
const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_DELETED = 50;
const MAX_ATTEMPTS = 2_000;
const MAX_EVENT_CHARS = 48_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const UNAUTHORIZED_REASON = "Invalid webhook URL or secret";
const UNAUTHORIZED_BURST_MS = 15 * 60_000;
export const DEFAULT_MAX_PENDING_RUNS = 3;
export const MAX_PENDING_RUNS_LIMIT = 50;
const maxPendingRunsSchema = z.number().int().min(1).max(MAX_PENDING_RUNS_LIMIT);

const runOnSchema = z.enum(["maus", "cloud"]);
const deliverySchema = z.enum(["run", "post"]);
const eventTypesSchema = z.array(z.string()).max(20).optional();
const triggerInputSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  botId: z.string(),
  runOn: runOnSchema.optional(),
  delivery: deliverySchema.optional(),
  groupId: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  verificationPending: z.boolean().optional(),
  eventTypes: eventTypesSchema,
  maxPendingRuns: maxPendingRunsSchema.nullable().optional(),
});
const triggerPatchSchema = triggerInputSchema.partial();
const verificationSampleSchema = z.object({
  receivedAt: z.number().finite().nonnegative(),
  eventName: z.string().optional(),
  contentType: z.string().optional(),
  preview: z.string(),
});
const storedWebhookSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  botId: z.string().min(1),
  runOn: runOnSchema,
  delivery: deliverySchema.optional(),
  groupId: z.string().min(1).optional(),
  enabled: z.boolean(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastReceivedAt: z.number().finite().nonnegative().optional(),
  lastRunId: z.string().optional(),
  resultsThreadId: z.string().min(1).optional(),
  deliveryCount: z.number().int().nonnegative(),
  verificationPending: z.boolean().optional(),
  verifiedAt: z.number().finite().nonnegative().optional(),
  verificationSample: verificationSampleSchema.optional(),
  eventTypes: eventTypesSchema,
  // A hand-edited value out of range falls back to the default instead of making the file unreadable.
  maxPendingRuns: maxPendingRunsSchema.optional().catch(undefined),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** The current secret, sealed under WEBHOOK_KEY_FILE beside this file, so the person and the owning bot get the same
   * address back. Never in a public trigger or a workspace backup; absent for a webhook made before it was kept. */
  sealedSecret: z.string().min(1).optional(),
});
const deliveryReceiptSchema = z.object({
  key: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  at: z.number().finite().nonnegative(),
});
const webhookAttemptSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
  receivedAt: z.number().finite().nonnegative(),
  outcome: z.enum(["accepted", "captured", "duplicate", "ignored", "rejected"]),
  statusCode: z.number().int().min(100).max(599),
  eventName: z.string().optional(),
  preview: z.string().optional(),
  deliveryId: z.string().optional(),
  runId: z.string().optional(),
  threadId: z.string().optional(),
  reason: z.string().optional(),
});
const deletedWebhookSchema = z.object({ at: z.number().finite().nonnegative(), webhook: storedWebhookSchema });
const webhookFileSchema = z.object({
  version: z.literal(1),
  webhooks: z.array(storedWebhookSchema),
  deliveries: z.array(deliveryReceiptSchema),
  attempts: z.array(webhookAttemptSchema).optional(),
  /** Webhooks deleted in the last week, kept so a chat Undo can bring one back with its URL and secret. */
  deleted: z.array(deletedWebhookSchema).optional(),
});
const taskPayloadSchema = z.object({ task: z.string().optional(), message: z.string().optional() });
const statusErrorSchema = z.object({ status: z.number().int().optional() });

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function invalidInput(error: z.ZodError): never {
  fail(400, schemaIssue(error, "Invalid webhook settings"));
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHex: string): boolean {
  if (!secret) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The key that seals kept secrets: a 0600 file of its own that no backup carries, so webhooks.json alone never reveals one. */
export const WEBHOOK_KEY_FILE = "webhook-key";

function newEndpointId(): string {
  return `wh_${randomBytes(12).toString("base64url")}`;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function cleanInput(input: WebhookTriggerInput): CleanWebhookInput {
  const name = input.name.trim().slice(0, 80);
  const prompt = input.prompt.trim().slice(0, 20_000);
  const botId = input.botId.trim();
  const runOn = input.runOn ?? "maus";
  if (!name) fail(400, "Give the webhook a name");
  if (!botId) fail(400, "Choose a MAUS");
  if (runOn !== "maus" && runOn !== "cloud") fail(400, "Choose where this webhook runs");
  const eventTypes = Array.from(new Set(
    (input.eventTypes ?? [])
      .map((value) => value.trim().slice(0, 200))
      .filter(Boolean),
  )).slice(0, 20);
  const enabled = input.enabled !== false;
  const clean: CleanWebhookInput = {
    name,
    prompt,
    botId,
    runOn,
    enabled,
    verificationPending: enabled ? false : input.verificationPending === true,
  };
  if (eventTypes.length) clean.eventTypes = eventTypes;
  if (input.delivery) clean.delivery = input.delivery;
  const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
  if (groupId && clean.delivery !== "post") fail(400, "a webhook room is only for delivery \"post\" webhooks");
  if (groupId) clean.groupId = groupId;
  if (typeof input.maxPendingRuns === "number") clean.maxPendingRuns = input.maxPendingRuns;
  return clean;
}

function parseTriggerInput(value: JsonValue): WebhookTriggerInput {
  const parsed = triggerInputSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function parseTriggerPatch(value: JsonValue): Partial<WebhookTriggerInput> {
  const parsed = triggerPatchSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function publicTrigger(trigger: StoredWebhookTrigger): WebhookTrigger {
  const { secretHash: _secretHash, sealedSecret: _sealedSecret, ...safe } = trigger;
  return { ...safe };
}

function serializePayload(payload: JsonValue): string {
  let text: string;
  const plainText = z.string().safeParse(payload);
  if (plainText.success) text = plainText.data;
  else {
    try {
      text = JSON.stringify(payload, null, 2) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  if (text.length <= MAX_EVENT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by OpenMausBot]`;
}

function previewPayload(payload: JsonValue): string {
  return serializePayload(payload).replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function taskFromPayload(payload: JsonValue): string {
  const parsed = taskPayloadSchema.safeParse(payload);
  if (!parsed.success) return "";
  const task = parsed.data.task ?? parsed.data.message ?? "";
  return task.trim().slice(0, 20_000);
}

export const WEBHOOK_EVENT_DATA = "[UNTRUSTED WEBHOOK EVENT DATA]";

function eventPrompt(trigger: StoredWebhookTrigger, event: WebhookEvent, receivedAt: number, deliveryId: string): string {
  const metadata = [
    `Received: ${new Date(receivedAt).toISOString()}`,
    `Delivery ID: ${deliveryId}`,
    event.eventName && `Event: ${event.eventName.slice(0, 200)}`,
    event.contentType && `Content-Type: ${event.contentType.slice(0, 200)}`,
    event.userAgent && `Sender: ${event.userAgent.slice(0, 300)}`,
  ].filter(Boolean);
  const configured = trigger.prompt.trim();
  const requestedTask = configured ? "" : taskFromPayload(event.payload);
  const instructionBlock = configured
    ? ["[USER-CONFIGURED WEBHOOK INSTRUCTIONS]", configured, "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]"]
    : requestedTask
      ? ["[AUTHENTICATED WEBHOOK TASK]", defuse(requestedTask), "[/AUTHENTICATED WEBHOOK TASK]"]
      : [
          "[DEFAULT WEBHOOK INSTRUCTIONS]",
          "Review the incoming event and summarize what happened. Do not take external actions unless the event clearly requires them and existing permissions allow them.",
          "[/DEFAULT WEBHOOK INSTRUCTIONS]",
        ];
  // The payload and its headers are the sender's: they never close the data block or open an instructions block.
  return [
    ...instructionBlock,
    "",
    WEBHOOK_EVENT_DATA,
    ...metadata.map((line) => defuse(String(line))),
    "",
    defuse(serializePayload(event.payload)),
    "[/UNTRUSTED WEBHOOK EVENT DATA]",
  ].join("\n");
}

type AttemptDetails = Pick<WebhookAttempt, "outcome" | "statusCode"> & Partial<Pick<WebhookAttempt, "deliveryId" | "runId" | "threadId" | "reason">>;

export class WebhookManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: WebhookManagerOptions;
  private webhooks: StoredWebhookTrigger[] = [];
  private deliveries: DeliveryReceipt[] = [];
  /** Room deliveries between admit() and their receipt; a concurrent retry of the same id must not post again. */
  private roomInFlight = new Set<string>();
  private attempts: WebhookAttempt[] = [];
  private deleted: Array<z.output<typeof deletedWebhookSchema>> = [];
  private rate = new Map<string, number[]>();
  /** Saves are refused while set, so an empty state never overwrites an unreadable file. */
  private unreadable = false;

  constructor(options: WebhookManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "webhooks.json");
    this.now = options.now ?? Date.now;
    try {
      const parsed = webhookFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      this.webhooks = parsed.data.webhooks;
      this.deliveries = parsed.data.deliveries.slice(-MAX_DELIVERIES);
      this.attempts = (parsed.data.attempts ?? []).slice(-MAX_ATTEMPTS);
      this.deleted = (parsed.data.deleted ?? []).filter((entry) => entry.at >= this.now() - RESTORE_WINDOW_MS);
    } catch (error) {
      this.webhooks = [];
      this.deliveries = [];
      this.attempts = [];
      this.deleted = [];
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unreadable = true;
        // JSON.parse errors can echo a fragment of the input, so they never reach the log.
        const reason = error instanceof SyntaxError ? "invalid JSON"
          : error instanceof Error ? error.message : "unable to read webhooks";
        console.error(`webhooks: ignoring unreadable ${this.file}: ${reason}`);
      }
    }
  }

  list(): WebhookTrigger[] {
    return this.webhooks.map(publicTrigger);
  }

  private sealKey(create: boolean): Buffer | null {
    const path = join(dirname(this.file), WEBHOOK_KEY_FILE);
    try {
      const key = readFileSync(path, "utf8").trim();
      if (/^[a-f0-9]{64}$/u.test(key)) return Buffer.from(key, "hex");
    } catch {}
    if (!create) return null;
    const key = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${key.toString("hex")}\n`, { mode: 0o600 });
    return key;
  }

  private seal(secret: string): { sealedSecret: string } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey(true)!, nonce);
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { sealedSecret: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64") };
  }

  /** Null when nothing is kept, the key is gone, or the seal no longer matches the secret the address carries. */
  private unseal(trigger: StoredWebhookTrigger): string | null {
    const key = trigger.sealedSecret ? this.sealKey(false) : null;
    if (!key || !trigger.sealedSecret) return null;
    try {
      const data = Buffer.from(trigger.sealedSecret, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(data.length - 16));
      const secret = Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
      return secretMatches(secret, trigger.secretHash) ? secret : null;
    } catch {
      return null;
    }
  }

  listAttempts(): WebhookAttempt[] {
    return this.attempts.map((attempt) => ({ ...attempt }));
  }

  create(input: JsonValue): CreatedWebhook {
    this.assertWritable();
    const clean = cleanInput(parseTriggerInput(input));
    if (this.options.botState(clean.botId) === "missing") fail(400, "That MAUS no longer exists");
    if (clean.groupId) this.assertRoomMember(clean.botId, clean.groupId);
    const now = this.now();
    const secret = newSecret();
    const trigger: StoredWebhookTrigger = {
      id: randomUUID(),
      endpointId: newEndpointId(),
      ...clean,
      secretHash: hashSecret(secret),
      ...this.seal(secret),
      createdAt: now,
      updatedAt: now,
      deliveryCount: 0,
    };
    this.webhooks.unshift(trigger);
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  /** Another server's webhook under its own id: a new one gets an address and secret of its own here and starts
   * switched off; one already here keeps its address, secret and switch and takes the rest. */
  adopt(record: WebhookTrigger): WebhookTrigger {
    this.assertWritable();
    const held = this.webhooks.find((candidate) => candidate.id === record.id);
    const clean = cleanInput({ name: record.name, prompt: record.prompt, botId: record.botId, runOn: record.runOn, delivery: record.delivery,
      groupId: record.groupId ?? null, enabled: held?.enabled ?? false, eventTypes: record.eventTypes, maxPendingRuns: record.maxPendingRuns ?? null });
    if (this.options.botState(clean.botId) === "missing") fail(409, "Its bot is not on this server yet");
    if (clean.groupId) this.assertRoomMember(clean.botId, clean.groupId);
    const definition = { ...clean, ...(record.resultsThreadId ? { resultsThreadId: record.resultsThreadId } : {}) };
    let trigger: StoredWebhookTrigger;
    if (held) {
      for (const key of ["delivery", "groupId", "eventTypes", "maxPendingRuns", "resultsThreadId"] as const) delete held[key];
      trigger = Object.assign(held, definition, { verificationPending: held.verificationPending, updatedAt: this.now() });
    } else {
      const secret = newSecret();
      trigger = { id: record.id, endpointId: newEndpointId(), ...definition, secretHash: hashSecret(secret), ...this.seal(secret),
        createdAt: record.createdAt, updatedAt: this.now(), deliveryCount: 0 };
      this.webhooks.unshift(trigger);
    }
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  update(id: string, value: JsonValue): WebhookTrigger | null {
    this.assertWritable();
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const patch = parseTriggerPatch(value);
    const clean = cleanInput({
      name: patch.name ?? trigger.name,
      prompt: patch.prompt ?? trigger.prompt,
      botId: patch.botId ?? trigger.botId,
      runOn: patch.runOn ?? trigger.runOn,

      delivery: patch.delivery ?? trigger.delivery,
      groupId: patch.groupId === undefined ? trigger.groupId : patch.groupId,
      enabled: patch.enabled ?? trigger.enabled,
      verificationPending: patch.verificationPending ?? trigger.verificationPending,
      eventTypes: patch.eventTypes ?? trigger.eventTypes,
      maxPendingRuns: patch.maxPendingRuns === undefined ? trigger.maxPendingRuns : patch.maxPendingRuns,
    });
    if (this.options.botState(clean.botId) === "missing") fail(400, "That MAUS no longer exists");
    if (clean.groupId) this.assertRoomMember(clean.botId, clean.groupId);
    Object.assign(trigger, clean, { updatedAt: this.now() });
    if (!clean.eventTypes?.length) delete trigger.eventTypes;
    if (!clean.groupId) delete trigger.groupId;
    if (clean.maxPendingRuns === undefined) delete trigger.maxPendingRuns;
    if (patch.enabled === false) {
      this.options.cancelQueued?.(trigger.id, "The webhook was paused before this delivery started");
    }
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  remove(id: string): boolean {
    this.assertWritable();
    const at = this.webhooks.findIndex((candidate) => candidate.id === id);
    if (at === -1) return false;
    const [trigger] = this.webhooks.splice(at, 1);
    this.deleted = [...this.deleted.filter((entry) => entry.at >= this.now() - RESTORE_WINDOW_MS && entry.webhook.id !== trigger.id),
      { at: this.now(), webhook: trigger }].slice(-MAX_DELETED);
    this.deliveries = this.deliveries.filter((delivery) => !delivery.key.startsWith(`${trigger.endpointId}:`));
    this.attempts = this.attempts.filter((attempt) => attempt.webhookId !== trigger.id);
    this.rate.delete(trigger.endpointId);
    this.options.cancelQueued?.(trigger.id, "The webhook was deleted before this delivery started");
    this.save();
    this.options.emit?.({ kind: "webhook.deleted", webhookId: id });
    return true;
  }

  /** Brings back a webhook deleted in the last week, with the same URL and secret. Null when it is gone for good. */
  restore(id: string): WebhookTrigger | null {
    this.assertWritable();
    const entry = this.deleted.find((candidate) => candidate.webhook.id === id && candidate.at >= this.now() - RESTORE_WINDOW_MS);
    if (!entry || this.webhooks.some((candidate) => candidate.id === id || candidate.endpointId === entry.webhook.endpointId)) return null;
    if (this.options.botState(entry.webhook.botId) === "missing") fail(410, "The assigned bot no longer exists");
    const trigger: StoredWebhookTrigger = { ...entry.webhook, updatedAt: this.now() };
    this.deleted = this.deleted.filter((candidate) => candidate !== entry);
    this.webhooks.unshift(trigger);
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  rotateSecret(id: string): { webhook: WebhookTrigger; secret: string } | null {
    this.assertWritable();
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const secret = newSecret();
    trigger.secretHash = hashSecret(secret);
    Object.assign(trigger, this.seal(secret));
    trigger.updatedAt = this.now();
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  /** The secret its address carries now, without replacing it; null for a webhook from before secrets were kept. With
   * `mintIfUnreached`, such a webhook that nothing has ever reached gets a new one: no app can hold its old address. */
  currentSecret(id: string, mintIfUnreached: boolean): { webhook: WebhookTrigger; secret: string | null } | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const kept = this.unseal(trigger);
    if (kept) return { webhook: publicTrigger(trigger), secret: kept };
    const reached = trigger.deliveryCount > 0 || trigger.lastReceivedAt !== undefined || trigger.verifiedAt !== undefined
      || this.attempts.some((attempt) => attempt.webhookId === id);
    return mintIfUnreached && !reached ? this.rotateSecret(id) : { webhook: publicTrigger(trigger), secret: null };
  }

  /** A deleted bot's webhooks go with it, for good: the bot cannot come back, so no Undo keeps them. */
  removeForBot(botId: string): void {
    const gone = this.webhooks.filter((trigger) => trigger.botId === botId);
    if (!gone.length && !this.deleted.some((entry) => entry.webhook.botId === botId)) return;
    this.assertWritable();
    const ids = new Set(gone.map((trigger) => trigger.id));
    const endpoints = gone.map((trigger) => `${trigger.endpointId}:`);
    this.webhooks = this.webhooks.filter((trigger) => !ids.has(trigger.id));
    this.deleted = this.deleted.filter((entry) => entry.webhook.botId !== botId);
    this.attempts = this.attempts.filter((attempt) => !ids.has(attempt.webhookId));
    this.deliveries = this.deliveries.filter((delivery) => !endpoints.some((prefix) => delivery.key.startsWith(prefix)));
    for (const trigger of gone) {
      this.rate.delete(trigger.endpointId);
      this.options.cancelQueued?.(trigger.id, "The assigned MAUS was deleted");
    }
    this.save();
    for (const trigger of gone) this.options.emit?.({ kind: "webhook.deleted", webhookId: trigger.id });
  }

  authorize(endpointId: string, secret: string): boolean {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    return Boolean(trigger && secretMatches(secret, trigger.secretHash));
  }

  receive(endpointId: string, secret: string, event: WebhookEvent): WebhookReceiveResult | Promise<WebhookReceiveResult> {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger || !secretMatches(secret, trigger.secretHash)) fail(401, "Invalid webhook URL or secret");
    if (trigger.verificationPending && !trigger.enabled) return this.captureVerification(trigger, event);
    try {
      // A room post synthesizes audio, so only that branch is a Promise; every other delivery stays synchronous.
      const delivery = trigger.delivery === "post" && trigger.groupId
        ? this.deliverRoom(trigger, event, false)
        : this.dispatch(trigger, event);
      if (!(delivery instanceof Promise)) return delivery;
      return delivery.catch((asyncError: unknown) => {
        this.rejectAttempt(trigger, event, asyncError);
        throw asyncError;
      });
    } catch (error) {
      this.rejectAttempt(trigger, event, error);
      throw error;
    }
  }

  private rejectAttempt(trigger: StoredWebhookTrigger, event: WebhookEvent, error: unknown): void {
    const parsedError = statusErrorSchema.safeParse(error);
    const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
    this.recordRejectedForTrigger(trigger, status, error instanceof Error ? error.message : String(error), event);
  }

  test(id: string, payload: JsonValue = { event: "openmaus.test", message: "Test webhook delivery" }): WebhookReceiveResult | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    // A room delivery synthesizes voice and stores images asynchronously; the test route stays synchronous.
    if (trigger.delivery === "post" && trigger.groupId) fail(400, "a room webhook posts through its webhook URL, not the test button");
    const eventName = trigger.eventTypes?.[0] ?? "openmaus.test";
    // Run now is the person's own test: like a schedule's, it runs while paused.
    return this.dispatch(trigger, {
      payload,
      contentType: "application/json",
      eventName,
      userAgent: "OpenMausBot webhook tester",
      deliveryId: `test-${randomUUID()}`,
    }, true);
  }

  recordRejected(endpointId: string, statusCode: number, reason: string, event: Partial<WebhookEvent> = {}): WebhookAttempt | null {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return null;
    return this.recordRejectedForTrigger(trigger, statusCode, reason, event);
  }

  /** Everything a delivery must clear before it can touch anything: pause, bot, event type, duplicates, queue depth, rate.
   *  An ignored or duplicate event comes back as its finished receipt. */
  private admit(trigger: StoredWebhookTrigger, event: WebhookEvent, byPerson: boolean, now: number): { deliveryId: string } | { receipt: WebhookReceiveResult } {
    if (!trigger.enabled && !byPerson) fail(409, "This webhook is paused");
    if (this.options.botState(trigger.botId) === "missing") fail(410, "The assigned MAUS no longer exists");

    const allowed = trigger.eventTypes ?? [];
    if (allowed.length > 0 && (!event.eventName || !allowed.includes(event.eventName))) {
      const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
      this.appendAttempt(trigger, event, {
        outcome: "ignored",
        statusCode: 202,
        deliveryId,
        reason: event.eventName ? `Event type “${event.eventName}” is not enabled` : "Event type is missing",
      });
      this.save();
      return { receipt: { deliveryId, duplicate: false, ignored: true } };
    }

    const requestedDeliveryId = String(event.deliveryId ?? "").trim().slice(0, 200);
    if (requestedDeliveryId) {
      const key = `${trigger.endpointId}:${requestedDeliveryId}`;
      const committed = this.options.findRun?.(trigger.id, requestedDeliveryId);
      const duplicate = committed
        ? { runId: committed.id }
        : this.deliveries.find((delivery) => delivery.key === key)
          ?? (this.roomInFlight.has(key) ? { runId: "post" } : undefined);
      if (duplicate) {
        this.appendAttempt(trigger, event, {
          outcome: "duplicate",
          statusCode: 202,
          deliveryId: requestedDeliveryId,
          runId: duplicate.runId,
          reason: "Duplicate delivery ignored",
        });
        this.save();
        return { receipt: { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true } };
      }
    }

    // A retry of an accepted delivery stays idempotent even while the queue is full.
    const maxPendingRuns = trigger.maxPendingRuns ?? DEFAULT_MAX_PENDING_RUNS;
    const pendingRuns = this.options.pendingRuns?.(trigger.id) ?? 0;
    if (pendingRuns >= maxPendingRuns) {
      fail(429, `This webhook already has ${pendingRuns} unfinished ${pendingRuns === 1 ? "task" : "tasks"} (its limit is ${maxPendingRuns}). `
        + "Retry after one finishes, or raise \"Unfinished tasks at once\" in the webhook's settings.");
    }

    const recent = (this.rate.get(trigger.endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) fail(429, "Webhook rate limit exceeded");
    recent.push(now);
    this.rate.set(trigger.endpointId, recent);
    return { deliveryId: requestedDeliveryId || randomUUID() };
  }

  /** A room post never starts a turn: it stages the whole message — voice note and images included — and only then
   *  appends once. The receipt is written after the append, so a failed synthesis retries cleanly. */
  private async deliverRoom(trigger: StoredWebhookTrigger, event: WebhookEvent, byPerson: boolean): Promise<WebhookReceiveResult> {
    const now = this.now();
    const admitted = this.admit(trigger, event, byPerson, now);
    if ("receipt" in admitted) return admitted.receipt;
    const { deliveryId } = admitted;
    if (!this.options.roomPost) fail(503, "This server cannot post webhook messages to rooms");
    const key = `${trigger.endpointId}:${deliveryId}`;
    this.roomInFlight.add(key);
    let outcome: Awaited<ReturnType<NonNullable<WebhookManagerOptions["roomPost"]>>>;
    try {
      outcome = await this.options.roomPost(publicTrigger(trigger), event.payload);
    } finally {
      this.roomInFlight.delete(key);
    }
    this.deliveries.push({ key, runId: "post", threadId: outcome.threadId, at: now });
    if (this.deliveries.length > MAX_DELIVERIES) this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    trigger.lastReceivedAt = now;
    trigger.deliveryCount += 1;
    trigger.updatedAt = now;
    this.appendAttempt(trigger, event, {
      outcome: "accepted",
      statusCode: 202,
      deliveryId,
      threadId: outcome.threadId,
      reason: outcome.attachments ? `Posted to the room with ${outcome.attachments} ${outcome.attachments === 1 ? "attachment" : "attachments"} (no task run)` : "Posted to the room (no task run)",
    });
    this.save();
    this.emit(trigger);
    return { threadId: outcome.threadId, deliveryId, duplicate: false };
  }

  private assertRoomMember(botId: string, groupId: string): void {
    const check = this.options.roomMember;
    if (!check) fail(503, "This server cannot check webhook room membership");
    const verdict = check(botId, groupId);
    if (!verdict.ok) fail(verdict.status, verdict.error);
  }

  /** Anyone who reaches the receiver can send a wrong secret: one rolling record per burst, saved with the next real change. */
  recordUnauthorized(endpointId: string, event: Partial<WebhookEvent> = {}): WebhookAttempt | null {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return null;
    const details = (count: number) => ({ outcome: "rejected" as const, statusCode: 401, reason: count > 1 ? `${UNAUTHORIZED_REASON} (${count} requests)` : UNAUTHORIZED_REASON, deliveryId: event.deliveryId });
    const at = this.attempts.findLastIndex((attempt) => attempt.webhookId === trigger.id);
    const burst = at === -1 ? undefined : this.attempts[at]!;
    if (!burst || burst.outcome !== "rejected" || burst.statusCode !== 401 || this.now() - burst.receivedAt > UNAUTHORIZED_BURST_MS) {
      return this.appendAttempt(trigger, event, details(1));
    }
    const attempt = this.buildAttempt(trigger, event, details(Number(/\((\d+) requests\)$/.exec(burst.reason ?? "")?.[1] ?? 1) + 1), burst.id);
    this.attempts[at] = attempt;
    this.options.emit?.({ kind: "webhook.attempt", attempt: { ...attempt } });
    return attempt;
  }

  /** run and thread-post deliveries: synchronous, one receipt, no awaits. Room triggers go through deliverRoom. */
  private dispatch(trigger: StoredWebhookTrigger, event: WebhookEvent, byPerson = false): WebhookReceiveResult {
    const now = this.now();
    const admitted = this.admit(trigger, event, byPerson, now);
    if ("receipt" in admitted) return admitted.receipt;
    const { deliveryId } = admitted;
    if (trigger.delivery === "post") {
      // Never fall through to a task run.
      if (!this.options.post) fail(503, "This server cannot post webhook messages to chat");
      const threadId = this.options.resolvePostThread?.(trigger, false);
      if (!threadId) fail(503, "This server could not resolve a destination thread for this delivery");
      if (threadId !== trigger.resultsThreadId) {
        trigger.resultsThreadId = threadId;
        trigger.updatedAt = now;
      }
      const raw = event.payload as { text?: unknown } | null;
      const text =
        raw && typeof raw === "object" && typeof raw.text === "string" && raw.text.trim() ? raw.text : serializePayload(event.payload);
      this.options.post(trigger.botId, threadId, text.slice(0, 20000));
      this.deliveries.push({ key: `${trigger.endpointId}:${deliveryId}`, runId: "post", at: now });
      if (this.deliveries.length > MAX_DELIVERIES) this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
      trigger.lastReceivedAt = now;
      trigger.deliveryCount += 1;
      trigger.updatedAt = now;
      this.appendAttempt(trigger, event, { outcome: "accepted", statusCode: 202, deliveryId, reason: "Posted to chat (no task run)" });
      this.save();
      this.emit(trigger);
      return { deliveryId, duplicate: false };
    }
    const run = this.options.enqueue({
      webhookId: trigger.id,
      webhookName: trigger.name,
      prompt: eventPrompt(trigger, event, now, deliveryId),
      botId: trigger.botId,
      runOn: trigger.runOn,
      deliveryId,
      receivedAt: now,
    });
    this.deliveries.push({ key: `${trigger.endpointId}:${deliveryId}`, runId: run.id, at: now });
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }
    trigger.lastReceivedAt = now;
    trigger.lastRunId = run.id;
    trigger.deliveryCount += 1;
    trigger.updatedAt = now;
    this.appendAttempt(trigger, event, {
      outcome: "accepted",
      statusCode: 202,
      deliveryId,
      runId: run.id,
    });
    this.save();
    this.emit(trigger);
    return { runId: run.id, deliveryId, duplicate: false };
  }

  private captureVerification(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    const receivedAt = this.now();
    const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
    trigger.verificationPending = false;
    trigger.verifiedAt = receivedAt;
    trigger.lastReceivedAt = receivedAt;
    trigger.updatedAt = receivedAt;
    const sample: WebhookVerificationSample = {
      receivedAt,
      preview: previewPayload(event.payload),
    };
    if (event.eventName) sample.eventName = event.eventName.slice(0, 200);
    if (event.contentType) sample.contentType = event.contentType.slice(0, 200);
    trigger.verificationSample = sample;
    this.appendAttempt(trigger, event, {
      outcome: "captured",
      statusCode: 202,
      deliveryId,
      reason: "Test event captured; enable the webhook to start MAUS tasks",
    });
    this.save();
    this.emit(trigger);
    return { deliveryId, duplicate: false, captured: true };
  }

  private recordRejectedForTrigger(trigger: StoredWebhookTrigger, statusCode: number, reason: string, event: Partial<WebhookEvent>): WebhookAttempt {
    const attempt = this.appendAttempt(trigger, event, {
      outcome: "rejected",
      statusCode,
      reason: reason.slice(0, 500),
      deliveryId: event.deliveryId,
    });
    this.save();
    return attempt;
  }

  private appendAttempt(
    trigger: StoredWebhookTrigger,
    event: Partial<WebhookEvent>,
    details: AttemptDetails,
  ): WebhookAttempt {
    const attempt = this.buildAttempt(trigger, event, details);
    this.attempts.push(attempt);
    if (this.attempts.length > MAX_ATTEMPTS) this.attempts.splice(0, this.attempts.length - MAX_ATTEMPTS);
    this.options.emit?.({ kind: "webhook.attempt", attempt: { ...attempt } });
    return attempt;
  }

  private buildAttempt(
    trigger: StoredWebhookTrigger,
    event: Partial<WebhookEvent>,
    details: AttemptDetails,
    id: string = randomUUID(),
  ): WebhookAttempt {
    const attempt: WebhookAttempt = {
      id,
      webhookId: trigger.id,
      receivedAt: this.now(),
      outcome: details.outcome,
      statusCode: details.statusCode,
    };
    if (event.eventName) attempt.eventName = event.eventName.slice(0, 200);
    if (event.payload !== undefined) attempt.preview = previewPayload(event.payload);
    if (details.deliveryId) attempt.deliveryId = details.deliveryId.slice(0, 200);
    if (details.runId) attempt.runId = details.runId;
    if (details.threadId) attempt.threadId = details.threadId;
    if (details.reason) attempt.reason = details.reason;
    return attempt;
  }

  private emit(trigger: StoredWebhookTrigger): void {
    this.options.emit?.({ kind: "webhook", webhook: publicTrigger(trigger) });
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Saved webhooks could not be read. Repair webhooks.json before changing them."), { status: 503 });
  }

  private save(): void {
    if (this.unreadable) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, webhooks: this.webhooks, deliveries: this.deliveries, attempts: this.attempts, deleted: this.deleted } satisfies WebhookFile, null, 2),
      { mode: 0o600 },
    );
  }
}
