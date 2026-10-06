import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { InkboxDeliveryPreview, InkboxDeliveryReference } from "../shared/inkbox-setup.ts";

export interface InkboxConfig {
  apiKey: string;
  signingSecret: string;
  identityId: string;
  ownerPhone: string;
  botId: string;
  phoneNumberId?: string;
  phoneNumber?: string;
  mailboxId?: string;
  emailAddress?: string;
}

interface Options {
  file: string;
  config?: InkboxConfig;
  now?: () => number;
  fetch?: typeof fetch;
  contactForPhone: (phone: string) => string | null;
  onContact: (contactId: string, eventId: string, text: string) => Promise<string>;
  onOwner: (eventId: string, text: string, channel: "imessage" | "text", metadata: { receivedAt: number; eventTimestamp?: number }) => Promise<string>;
  approvalMode?: () => "ask" | "auto";
  /** Synchronous, safety-only preference revocation. Must never dispatch work
   * or grant permission. Runs before durable acceptance so a crash cannot lose
   * an acknowledged revocation behind the serial command queue. */
  onOwnerReceived?: (text: string, metadata: { receivedAt: number; eventTimestamp?: number }) => void;
}

type RecordChannel = "text" | "email" | "slack" | "calls" | "a2a";
type DeliveryState = "recorded" | "pending" | "processing" | "sending" | "sent" | "failed" | "uncertain";
interface Delivery extends InkboxDeliveryPreview {
  id: string;
  digest: string;
  sender: string;
  channel: "imessage" | "text" | RecordChannel;
  status: DeliveryState;
  receivedAt: number;
  eventTimestamp?: number;
  unsupportedAttachment?: true;
  text: string;
  route: "owner" | "contact" | "notification" | "record";
  contactId?: string;
  conversationId?: string;
  reply?: string;
  error?: string;
}
type ObjectValue = Record<string, unknown>;
interface Binding { identityId: string; botId: string; ownerPhone: string; phoneNumberId: string | null }
const PHONE = /^\+[1-9]\d{6,14}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set<DeliveryState>(["recorded", "pending", "processing", "sending", "sent", "failed", "uncertain"]);
const MAX_BODY = 128 * 1024;
const MAX_RECORDS = 1000;
const MAX_OBSERVATIONS = 500;
const HOURLY_LIMIT = 30;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

/** Observations are a bounded preview cache. Action receipts are never evicted. */
function retainObservations(rows: Delivery[]): Delivery[] {
  const observations = rows.filter(row => row.route === "record");
  if (observations.length <= MAX_OBSERVATIONS) return rows;
  const retained = new Set(observations.sort((a, b) => a.receivedAt - b.receivedAt).slice(-MAX_OBSERVATIONS));
  return rows.filter(row => row.route !== "record" || retained.has(row));
}

const REFERENCE_FIELDS = ["messageId", "mailboxId", "emailAddress", "rfcMessageId", "threadId", "phoneNumberId", "conversationId", "connectionId", "workspaceId", "messageTs", "threadTs", "callId", "taskId", "contextId"] as const;
function referenceValue(field: typeof REFERENCE_FIELDS[number], value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value) || value.includes("\0")) return undefined;
  if (field === "emailAddress") return value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value) ? value : undefined;
  if (field === "rfcMessageId") return value.length <= 998 ? value : undefined;
  if (field === "messageTs" || field === "threadTs") return /^\d{1,30}\.\d{1,30}$/.test(value) ? value : undefined;
  return ID.test(value) ? value : undefined;
}
function reference(channel: RecordChannel, fields: Partial<Record<typeof REFERENCE_FIELDS[number], unknown>>): InkboxDeliveryReference {
  const result: InkboxDeliveryReference = { channel };
  for (const field of REFERENCE_FIELDS) {
    const value = referenceValue(field, fields[field]);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function validConfig(config: InkboxConfig): boolean {
  return typeof config.apiKey === "string" && !!config.apiKey && !/[\r\n]/.test(config.apiKey)
    && typeof config.signingSecret === "string" && !!config.signingSecret
    && ID.test(config.identityId) && ID.test(config.botId) && PHONE.test(config.ownerPhone)
    && (config.phoneNumberId === undefined || ID.test(config.phoneNumberId))
    && (config.phoneNumber === undefined || PHONE.test(config.phoneNumber))
    && (config.mailboxId === undefined || ID.test(config.mailboxId))
    && (config.emailAddress === undefined || /^[^\s@]+@[^\s@]+$/.test(config.emailAddress));
}

export function readInkboxConfig(env: NodeJS.ProcessEnv): InkboxConfig | undefined {
  const { OMB_INKBOX_API_KEY: apiKey, OMB_INKBOX_SIGNING_SECRET: signingSecret, OMB_INKBOX_IDENTITY_ID: identityId,
    OMB_INKBOX_OWNER_PHONE: ownerPhone, OMB_INKBOX_BOT_ID: botId, OMB_INKBOX_PHONE_NUMBER_ID: phoneNumberId } = env;
  if (!apiKey || !signingSecret || !identityId || !ownerPhone || !botId) return undefined;
  const config = { apiKey, signingSecret, identityId, ownerPhone, botId, ...(phoneNumberId ? { phoneNumberId } : {}) };
  return validConfig(config) ? config : undefined;
}

class Rejection extends Error {
  readonly statusCode: number;
  constructor(statusCode: number) { super("Inkbox request rejected"); this.statusCode = statusCode; }
}

/** Receives authenticated 1:1 events. This adapter grants no engine or tool
 * privileges: the host callbacks own Ask execution and contact permissions. */
export class InkboxChannel {
  private readonly options: Options;
  private readonly config?: InkboxConfig;
  private readonly now: () => number;
  private readonly request: typeof fetch;
  private deliveries: Delivery[] = [];
  private running: Promise<void> | null = null;
  private stopped = false;
  private storageFailed = false;
  private bindingValue: Binding | null = null;
  private keyVerification: Promise<boolean> | null = null;
  private notificationGuards = new Map<string, () => boolean>();

  constructor(options: Options) {
    this.options = options;
    this.config = options.config && validConfig(options.config) ? { ...options.config } : undefined;
    this.now = options.now ?? Date.now;
    this.request = options.fetch ?? fetch;
    this.bindingValue = this.binding();
    this.load();
  }

  private binding(): Binding | null {
    const config = this.config;
    return config ? { identityId: config.identityId, botId: config.botId, ownerPhone: config.ownerPhone, phoneNumberId: config.phoneNumberId ?? null } : null;
  }

  private load(): void {
    let raw: string;
    try { raw = readFileSync(this.options.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Inkbox inbox cannot be read"); }
    let migrated = false;
    try {
      const stored = object(JSON.parse(raw));
      if (!stored || stored.version !== 1 || !Array.isArray(stored.deliveries) || stored.deliveries.length > MAX_RECORDS + MAX_OBSERVATIONS) throw new Error();
      if (stored.deliveries.filter(value => object(value)?.route !== "record").length > MAX_RECORDS) throw new Error();
      const binding = object(stored.binding);
      if (!binding || typeof binding.identityId !== "string" || !ID.test(binding.identityId)
        || typeof binding.botId !== "string" || !ID.test(binding.botId) || typeof binding.ownerPhone !== "string" || !PHONE.test(binding.ownerPhone)
        || (binding.phoneNumberId !== null && (typeof binding.phoneNumberId !== "string" || !ID.test(binding.phoneNumberId)))) throw new Error();
      const validatedBinding = { identityId: binding.identityId, botId: binding.botId, ownerPhone: binding.ownerPhone, phoneNumberId: binding.phoneNumberId as string | null };
      const current = this.binding();
      if (this.config && JSON.stringify(validatedBinding) !== JSON.stringify(current)) {
        // Adding a phone to the same identity does not invalidate existing iMessage receipts.
        if (!current || validatedBinding.identityId !== current.identityId || validatedBinding.botId !== current.botId || validatedBinding.ownerPhone !== current.ownerPhone || validatedBinding.phoneNumberId !== null || stored.deliveries.some(row => object(row)?.channel === "text")) throw new Error();
        migrated = true;
      }
      this.bindingValue = migrated ? current : validatedBinding;
      const seen = new Set<string>();
      this.deliveries = stored.deliveries.map(value => {
        const row = object(value);
        if (!row || typeof row.id !== "string" || !ID.test(row.id) || seen.has(row.id) || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)
          || typeof row.sender !== "string" || row.sender.length > 320 || !row.sender
          || (row.route !== "record" && (!PHONE.test(row.sender) || (row.channel !== "imessage" && row.channel !== "text")))
          || (row.route === "record" && !["text", "email", "slack", "calls", "a2a"].includes(String(row.channel)))
          || !STATES.has(row.status as DeliveryState) || typeof row.receivedAt !== "number" || !Number.isFinite(row.receivedAt)
          || (row.eventTimestamp !== undefined && (typeof row.eventTimestamp !== "number" || !Number.isFinite(row.eventTimestamp)))
          || (row.unsupportedAttachment !== undefined && (row.unsupportedAttachment !== true || row.channel !== "imessage" || !["owner", "contact"].includes(String(row.route))))
          || typeof row.text !== "string" || (row.route !== "owner" && row.route !== "contact" && row.route !== "notification" && row.route !== "record")
          || (row.route === "contact" && (typeof row.contactId !== "string" || !row.contactId))
          || (row.conversationId !== undefined && (typeof row.conversationId !== "string" || !UUID.test(row.conversationId)))
          || (row.reply !== undefined && typeof row.reply !== "string") || (row.error !== undefined && typeof row.error !== "string")) throw new Error();
        const preview: InkboxDeliveryPreview = {};
        if (row.route === "record") {
          if (row.status !== "recorded") throw new Error();
          if (row.previewState !== undefined && !["complete", "truncated", "unavailable"].includes(String(row.previewState))) throw new Error();
          if (row.previewNotice !== undefined && (typeof row.previewNotice !== "string" || row.previewNotice.length > 300)) throw new Error();
          preview.previewState = row.previewState as InkboxDeliveryPreview["previewState"] ?? "truncated";
          if (typeof row.previewNotice === "string") preview.previewNotice = row.previewNotice;
          else if (row.previewState === undefined) preview.previewNotice = "Earlier preview; completeness and source references were not recorded. Read the original with Inkbox tools.";
          if (row.reference !== undefined) {
            const storedReference = object(row.reference);
            if (!storedReference || storedReference.channel !== row.channel) throw new Error();
            for (const field of REFERENCE_FIELDS) if (storedReference[field] !== undefined && referenceValue(field, storedReference[field]) === undefined) throw new Error();
            preview.reference = reference(row.channel as RecordChannel, storedReference);
          }
        }
        seen.add(row.id);
        return { id: row.id, digest: row.digest, sender: row.sender, channel: row.channel as Delivery["channel"], status: row.status as DeliveryState, receivedAt: row.receivedAt,
          text: row.text, route: row.route, ...preview, ...(typeof row.eventTimestamp === "number" ? { eventTimestamp: row.eventTimestamp } : {}),
          ...(row.unsupportedAttachment === true ? { unsupportedAttachment: true as const } : {}), ...(typeof row.conversationId === "string" ? {conversationId:row.conversationId} : {}), ...(typeof row.contactId === "string" ? { contactId: row.contactId } : {}),
          ...(typeof row.reply === "string" ? { reply: row.reply } : {}), ...(typeof row.error === "string" ? { error: row.error } : {}) };
      });
    } catch { throw new Error("Inkbox inbox is invalid or belongs to a different channel binding"); }
    const retained = retainObservations(this.deliveries);
    let changed = migrated || retained !== this.deliveries;
    this.deliveries = retained;
    for (const row of this.deliveries) {
      if (row.status === "pending" || row.status === "processing" || row.status === "sending") {
        row.status = "uncertain";
        row.error = "Interrupted by restart; inspect the local inbox before any manual recovery";
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(rows = this.deliveries): void {
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, JSON.stringify({ version: 1, binding: this.bindingValue, deliveries: rows }), { mode: 0o600 });
  }

  private signatureHeaders(req: IncomingMessage): { requestId: string; timestamp: string; signature: string } {
    const names = ["x-inkbox-request-id", "x-inkbox-timestamp", "x-inkbox-signature"];
    for (const name of names) {
      if (req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length !== 1) throw new Rejection(403);
    }
    const requestId = req.headers[names[0]];
    const timestamp = req.headers[names[1]];
    const signature = req.headers[names[2]];
    if (typeof requestId !== "string" || !ID.test(requestId) || typeof timestamp !== "string" || !/^\d{1,11}$/.test(timestamp)
      || Math.abs(this.now() / 1000 - Number(timestamp)) > 300 || typeof signature !== "string" || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) throw new Rejection(403);
    return { requestId, timestamp, signature };
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) { req.resume(); throw new Rejection(413); }
    if (req.headers["content-encoding"] !== undefined && req.headers["content-encoding"] !== "identity") { req.resume(); throw new Rejection(400); }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => fail(400), 10_000);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", error); };
      const fail = (code: number) => { cleanup(); req.resume(); reject(new Rejection(code)); };
      const data = (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) { fail(413); return; } chunks.push(chunk); };
      const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
      const error = () => fail(400);
      req.on("data", data); req.on("end", end); req.on("error", error); req.on("aborted", error);
    });
  }

  /** Records provider correspondence without converting its sender into the app owner. */
  private record(payload: ObjectValue, data: ObjectValue): Omit<Delivery, "digest" | "receivedAt" | "status"> | null {
    const config = this.config!;
    for (const scope of [payload, data, object(data.message), object(data.text_message), object(data.call)].filter((value): value is ObjectValue => value !== null)) for (const field of ["agent_identity_id", "identity_id"]) {
      if (scope[field] !== undefined && scope[field] !== config.identityId) throw new Rejection(403);
    }
    let channel: RecordChannel, sender: unknown, content: unknown;
    let sourceFields: Partial<Record<typeof REFERENCE_FIELDS[number], unknown>> = {};
    let previewState: NonNullable<InkboxDeliveryPreview["previewState"]> = "complete";
    let previewNotice: string | undefined;
    if (payload.event_type === "text.received" && object(data.text_message)?.type === "mms") {
      const message = object(data.text_message)!;
      if (!config.phoneNumber || !config.phoneNumberId) throw new Rejection(400);
      if (message.local_phone_number !== config.phoneNumber || (message.phone_number_id !== undefined && message.phone_number_id !== config.phoneNumberId)) throw new Rejection(403);
      if (message.direction !== "inbound" || typeof message.sender_phone_number !== "string" || !PHONE.test(message.sender_phone_number)) throw new Rejection(400);
      channel = "text"; sender = message.sender_phone_number;
      content = typeof message.text === "string" ? message.text : "";
      previewState = content ? "truncated" : "unavailable";
      previewNotice = "MMS text preview only. Inspect media and conversation participants with Inkbox tools.";
      sourceFields = { messageId: message.id, phoneNumberId: config.phoneNumberId, conversationId: message.conversation_id };
    } else if (payload.event_type === "message.received") {
      const message = object(data.message);
      if (!config.mailboxId || !config.emailAddress || message?.mailbox_id !== config.mailboxId || message.email_address !== config.emailAddress) throw new Rejection(403);
      if (message.direction !== "inbound") throw new Rejection(400);
      channel = "email"; sender = message.from_address;
      content = typeof message.body === "string" && message.body_state !== "unavailable" ? message.body : "";
      const countsTruncated = typeof message.body_total_chars === "number" && typeof message.body_included_chars === "number" && message.body_total_chars > message.body_included_chars;
      previewState = typeof message.body !== "string" || message.body_state === "unavailable" ? "unavailable"
        : message.body_state === "complete" && message.body_truncated !== true && !countsTruncated ? "complete" : "truncated";
      sourceFields = { messageId: message.id, mailboxId: config.mailboxId, emailAddress: config.emailAddress, threadId: message.thread_id, rfcMessageId: message.message_id };
    } else if (["slack.dm_received", "slack.group_dm_received", "slack.channel_message_received", "slack.mention_received", "slack.thread_reply_received"].includes(String(payload.event_type))) {
      if (data.identity_id !== config.identityId) throw new Rejection(403);
      if (typeof data.workspace_id !== "string" || !/^T[A-Z0-9]{1,63}$/.test(data.workspace_id) || typeof data.actor_id !== "string" || !/^[UW][A-Z0-9]{1,63}$/.test(data.actor_id)) throw new Rejection(400);
      channel = "slack"; sender = `${data.workspace_id}/${data.actor_id}`;
      const text = object(data.event)?.text;
      content = typeof text === "string" ? text : "";
      if (typeof text !== "string") previewState = "unavailable";
      sourceFields = { connectionId: data.connection_id, workspaceId: data.workspace_id, conversationId: data.conversation_id, messageTs: data.message_ts, threadTs: data.thread_ts };
    } else if (payload.event_type === "call.ended") {
      const call = object(data.call);
      if (typeof call?.id !== "string" || !ID.test(call.id) || typeof call.remote_phone_number !== "string" || !PHONE.test(call.remote_phone_number)) throw new Rejection(400);
      channel = "calls"; sender = call.remote_phone_number;
      const transcript = object(data.transcript);
      const entries = transcript?.entries;
      content = Array.isArray(entries) ? entries.map(entry => object(entry)?.text).filter(text => typeof text === "string").join("\n") : "";
      previewState = !Array.isArray(entries) || !content ? "unavailable" : transcript?.abridged === false && !entries.some(entry => object(entry)?.marker === "abridged") ? "complete" : "truncated";
      if (previewState === "truncated") previewNotice = "Call transcript is abridged or its completeness is unconfirmed. Read the full transcript with Inkbox tools.";
      sourceFields = { callId: call.id };
    } else if (["a2a.task.created", "a2a.task.message", "a2a.task.canceled", "a2a.sent_task.updated"].includes(String(payload.event_type))) {
      const caller = object(data.caller);
      if (typeof caller?.identity_id !== "string" || !ID.test(caller.identity_id) || typeof data.task_id !== "string" || !ID.test(data.task_id)) throw new Rejection(400);
      channel = "a2a"; sender = caller.identity_id;
      content = Array.isArray(data.parts) ? data.parts.map(part => object(part)?.text).filter(text => typeof text === "string").join("\n") : "";
      previewState = !Array.isArray(data.parts) || !content ? "unavailable" : data.parts.every(part => typeof object(part)?.text === "string" && object(part)?.data === undefined) ? "complete" : "truncated";
      sourceFields = { taskId: data.task_id, contextId: data.context_id, messageId: data.message_id };
    } else return null;
    if (typeof sender !== "string" || !sender || sender.length > 320 || typeof content !== "string") throw new Rejection(400);
    if (content.length > 4000) {
      previewState = "truncated";
      previewNotice = previewNotice ? `${previewNotice} The local preview is also shortened.` : "Preview shortened locally. Read the complete source with Inkbox tools.";
    }
    if (!previewNotice && previewState !== "complete") previewNotice = previewState === "unavailable"
      ? "Text is unavailable in this event. Read the original with Inkbox tools."
      : "The provider supplied an incomplete preview. Read the complete source with Inkbox tools.";
    const text = content.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "");
    return { id: payload.id as string, sender, channel, text, route: "record", reference: reference(channel, sourceFields), previewState, ...(previewNotice ? {previewNotice} : {}) };
  }

  private parse(raw: Buffer): Omit<Delivery, "digest" | "receivedAt" | "status"> {
    let payload: ObjectValue | null;
    try { payload = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); }
    catch { throw new Rejection(400); }
    const config = this.config!;
    const data = object(payload?.data);
    if (!payload || !data || typeof payload.id !== "string" || !ID.test(payload.id)
      || typeof payload.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(payload.timestamp) || !Number.isFinite(Date.parse(payload.timestamp))) throw new Rejection(400);
    const record = this.record(payload, data);
    const eventTimestamp = Date.parse(payload.timestamp);
    if (record) return { ...record, eventTimestamp };
    const channel = payload.event_type === "imessage.received" ? "imessage" : payload.event_type === "text.received" ? "text" : null;
    const message = object(channel === "imessage" ? data.message : data.text_message);
    if (!channel || !message || message.direction !== "inbound") throw new Rejection(400);
    for (const scope of [payload, data, message]) {
      if ("companion" in scope) throw new Rejection(400);
      for (const field of ["agent_identity_id", "identity_id"]) if (field in scope && scope[field] !== config.identityId) throw new Rejection(403);
      for (const field of ["group_id", "group_chat_id", "participants", "recipients", "recipient_phone_number", "to"]) if (scope[field] !== undefined && scope[field] !== null) throw new Rejection(400);
      if ("is_group" in scope && scope.is_group !== false) throw new Rejection(400);
    }
    if (message.sender_access !== undefined && message.sender_access !== "direct") throw new Rejection(400);
    if (channel === "imessage" && (message.is_group !== false || (message.message_type !== undefined && message.message_type !== "message"))) throw new Rejection(400);
    // The documented inbound MMS shape cannot distinguish a direct MMS from a
    // group MMS. SMS is intrinsically 1:1; ambiguous MMS is intentionally closed.
    if (channel === "text" && (message.type !== "sms" || !config.phoneNumberId || typeof message.local_phone_number !== "string" || !PHONE.test(message.local_phone_number))) throw new Rejection(400);
    if (channel === "text" && config.phoneNumber && message.local_phone_number !== config.phoneNumber) throw new Rejection(403);
    if (channel === "text" && "phone_number_id" in message && message.phone_number_id !== config.phoneNumberId) throw new Rejection(403);
    const sender = channel === "imessage" ? message.remote_number : message.remote_phone_number;
    const explicitSender = channel === "imessage" ? message.sender_number : message.sender_phone_number;
    if (typeof sender !== "string" || !PHONE.test(sender) || (explicitSender !== null && explicitSender !== undefined && explicitSender !== sender)
      || (channel === "text" && explicitSender !== sender)) throw new Rejection(400);
    // Any nonempty media payload is unparsed. Never let its caption become an
    // owner command (especially YES), and never fetch sender-supplied URLs.
    const unsupportedAttachment = channel === "imessage" && message.media != null &&
      (!Array.isArray(message.media) || message.media.length > 0);
    const content = channel === "imessage" ? message.content : message.text;
    const text = unsupportedAttachment && content == null ? "" : content;
    if (typeof text !== "string" || (!unsupportedAttachment && !text.trim()) || text.length > 32_000) throw new Rejection(400);
    // Carrier contact lists and context are deliberately never consulted.
    const route = sender === config.ownerPhone ? "owner" : "contact";
    const contactId = route === "contact" ? this.options.contactForPhone(sender) : null;
    if (route === "contact" && !contactId) throw new Rejection(403);
    return { id: payload.id, sender, channel, text, route, eventTimestamp, ...(unsupportedAttachment ? { unsupportedAttachment: true } : {}), ...(typeof message.conversation_id === "string" && UUID.test(message.conversation_id) ? {conversationId:message.conversation_id} : {}), ...(contactId ? { contactId } : {}) };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== "POST" || req.url !== "/inkbox") return false;
    const respond = (code: number) => { res.statusCode = code; res.setHeader("Cache-Control", "no-store"); res.end(); };
    if (!this.config || this.stopped || this.storageFailed) { req.resume(); respond(503); return true; }
    try {
      const headers = this.signatureHeaders(req);
      const raw = await this.body(req);
      if (this.stopped || this.storageFailed) throw new Rejection(503);
      if (Math.abs(this.now() / 1000 - Number(headers.timestamp)) > 300) throw new Rejection(403);
      const expected = createHmac("sha256", this.config.signingSecret).update(`${headers.requestId}.${headers.timestamp}.`).update(raw).digest();
      if (!timingSafeEqual(expected, Buffer.from(headers.signature.slice(7), "hex"))) throw new Rejection(403);
      const event = this.parse(raw);
      const digest = createHash("sha256").update(raw).digest("hex");
      const existing = this.deliveries.find(row => row.id === event.id);
      if (existing) { respond(existing.digest === digest ? 202 : 409); return true; }
      const receivedAt = this.now();
      if (event.route === "owner" && !event.unsupportedAttachment) {
        this.options.onOwnerReceived?.(event.text, {
          receivedAt, ...(event.eventTimestamp !== undefined ? { eventTimestamp: event.eventTimestamp } : {}),
        });
      }
      // Capacity limits must never prevent an authenticated safety revocation.
      if (event.route !== "record" && this.deliveries.filter(row => row.route !== "record").length >= MAX_RECORDS) throw new Rejection(503);
      if (this.deliveries.filter(row => row.route !== "notification" && (row.route === "record") === (event.route === "record") && row.sender === event.sender && row.receivedAt > receivedAt - 3_600_000).length >= HOURLY_LIMIT) throw new Rejection(429);
      const rows = retainObservations([...this.deliveries, { ...event, digest, receivedAt, status: event.route === "record" ? "recorded" as const : "pending" as const }]);
      this.persist(rows);
      this.deliveries = rows;
      respond(202);
      this.start();
    } catch (error) { req.resume(); respond(error instanceof Rejection ? error.statusCode : 503); }
    return true;
  }

  private start(): void {
    if (this.running || this.stopped) return;
    this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.drain()).finally(() => {
      this.running = null;
      if (!this.storageFailed && this.deliveries.some(row => row.status === "pending")) this.start();
    });
  }

  private checkpoint(row: Delivery): boolean {
    try { this.persist(); return true; }
    catch {
      this.storageFailed = true;
      row.status = "uncertain";
      row.error = "Inbox persistence failed; reply retained in memory, inspect before recovery";
      return false;
    }
  }

  private verifyKey(): Promise<boolean> {
    this.keyVerification ??= (async () => {
      try {
        const response = await this.request("https://inkbox.ai/api/v1/api-keys/self", { method: "GET", redirect: "error",
          signal: AbortSignal.timeout(15_000), headers: { "X-API-Key": this.config!.apiKey } });
        if (!response.ok) { await response.body?.cancel(); return false; }
        const metadata = object(await response.json());
        return metadata?.status === "active" && metadata.scoped_identity_id === this.config!.identityId;
      } catch { return false; }
    })();
    return this.keyVerification;
  }

  private async drain(): Promise<void> {
    while (!this.stopped && !this.storageFailed) {
      const row = this.deliveries.find(item => item.status === "pending");
      if (!row) return;
      row.status = "processing";
      if (!this.checkpoint(row)) return;
      if (!await this.verifyKey()) {
        row.status = "failed";
        row.error = "Inkbox API key scope verification failed; an active key for the configured identity is required";
        this.checkpoint(row);
        continue;
      }
      if (this.stopped) {
        row.status = "uncertain";
        row.error = "Channel stopped before host processing; no automatic replay";
        this.checkpoint(row);
        return;
      }
      if (row.channel === "imessage" && row.conversationId) {
        // Best effort only: typing does not hold up processing, mutate read state, or retry.
        void this.request("https://inkbox.ai/api/v1/imessage/typing", { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
          headers: { "Content-Type": "application/json", "X-API-Key": this.config!.apiKey }, body: JSON.stringify({conversation_id:row.conversationId}) })
          .then(response => response.body?.cancel()).catch(() => {});
      }
      try {
        if (row.route === "owner" && row.sender !== this.config!.ownerPhone) throw new Error();
        if (row.route === "contact" && this.options.contactForPhone(row.sender) !== row.contactId) throw new Error();
        if (row.unsupportedAttachment) {
          row.reply = "Mausbot cannot read attachments in incoming iMessages yet. This message, including any accompanying text, was not processed. Please resend your request as a separate text-only message.";
        } else if (row.route === "owner") {
          row.reply = await this.options.onOwner(row.id, row.text, row.channel as "imessage" | "text", {
            receivedAt: row.receivedAt, ...(row.eventTimestamp !== undefined ? { eventTimestamp: row.eventTimestamp } : {}),
          });
        } else if (row.route === "contact") {
          row.reply = await this.options.onContact(row.contactId!, row.id, row.text);
        }
        if (typeof row.reply !== "string" || !row.reply.trim()) throw new Error();
      } catch {
        row.status = "failed";
        row.error = "Host processing failed or contact permission was revoked; inspect locally";
        this.checkpoint(row);
        continue;
      }
      if (this.stopped) {
        row.status = "uncertain";
        row.error = "Channel stopped after processing; reply retained for manual recovery";
        this.checkpoint(row);
        return;
      }
      if (row.route === "contact" && this.options.contactForPhone(row.sender) !== row.contactId) {
        row.status = "failed";
        row.error = "Contact permission changed during processing; reply retained locally";
        this.checkpoint(row);
        continue;
      }
      if (row.route === "notification") {
        const isCurrent = this.notificationGuards.get(row.id);
        this.notificationGuards.delete(row.id);
        if (!isCurrent?.()) {
          row.status = "failed";
          row.error = "This follow-up was superseded before delivery";
          this.checkpoint(row);
          continue;
        }
      }
      row.status = "sending";
      if (!this.checkpoint(row)) return;
      const config = this.config!;
      const url = row.channel === "imessage" ? "https://inkbox.ai/api/v1/imessage/messages"
        : `https://inkbox.ai/api/v1/phone/numbers/${config.phoneNumberId}/texts`;
      const cap = row.channel === "imessage" ? 18_995 : 1600;
      const notice = "\n[Reply truncated. Full reply is saved in Mausbot's local inbox.]";
      const characters = [...row.reply];
      const text = characters.length <= cap ? row.reply : characters.slice(0, cap - notice.length).join("") + notice;
      try {
        const response = await this.request(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey, "Idempotency-Key": `omb_${createHash("sha256").update(`${config.identityId}:${row.id}`).digest("hex")}`, Prefer: "idempotency-replay" },
          body: JSON.stringify({ ...(row.conversationId ? {conversation_id:row.conversationId} : {to:row.sender}), text }) });
        // The API accepts the send here. This is not a carrier-delivery receipt.
        row.status = response.ok ? "sent" : response.status >= 500 || response.status === 408 ? "uncertain" : "failed";
        if (!response.ok) row.error = `Inkbox send returned HTTP ${response.status}; inspect before recovery`;
        await response.body?.cancel();
      } catch {
        row.status = "uncertain";
        row.error = "Inkbox send outcome is unknown; no automatic retry";
      }
      if (!this.checkpoint(row)) return;
    }
  }

  /** Private host follow-up, never exposed as an HTTP send endpoint. Goes
   * through the same scope verification, durable send fence and no-retry rule. */
  async notifyOwner(id: string, text: string, channel: "imessage" | "text", isCurrent: () => boolean = () => true): Promise<void> {
    const config = this.config;
    if (!config || this.stopped || this.storageFailed || !ID.test(id) || !text.trim() ||
        [...text].length > (channel === "text" ? 1600 : 18995) || (channel === "text" && !config.phoneNumberId)) throw new Error("Follow-up unavailable");
    const digest = createHash("sha256").update(JSON.stringify(["notification", channel, text])).digest("hex");
    const previous = this.deliveries.find(row => row.id === id);
    if (previous) {
      if (previous.route === "notification" && previous.digest === digest && previous.status === "sent") return;
      throw new Error("Follow-up already attempted; inspect its receipt");
    }
    if (this.deliveries.filter(row => row.route !== "record").length >= MAX_RECORDS) throw new Error("The message inbox is full");
    const row: Delivery = { id, digest, sender: config.ownerPhone, channel, status: "pending", receivedAt: this.now(), text: "", route: "notification", reply: text };
    const rows = [...this.deliveries, row]; this.persist(rows); this.deliveries = rows;
    this.notificationGuards.set(id, isCurrent);
    this.start(); await this.idle();
    if (row.status !== "sent") throw new Error("Follow-up delivery could not be confirmed");
  }

  status(): { configured: boolean; approvalMode?: "ask" | "auto"; ownerPhone?: string; botId?: string; deliveries: Array<InkboxDeliveryPreview & { id: string; sender: string; channel: string; status: string; text?: string; receivedAt?: number; reply?: string; error?: string }> } {
    const redact = (value: string) => {
      for (const secret of [this.config?.apiKey, this.config?.signingSecret]) if (secret) value = value.split(secret).join("[redacted]");
      return value;
    };
    const redactReference = (value: InkboxDeliveryReference): InkboxDeliveryReference => {
      const result = { ...value };
      for (const field of REFERENCE_FIELDS) {
        if (result[field] !== undefined) result[field] = redact(result[field]);
      }
      return result;
    };
    return { configured: !!this.config, approvalMode: this.options.approvalMode?.() ?? "ask", ...(this.config ? { ownerPhone: this.config.ownerPhone, botId: this.config.botId } : {}),
      deliveries: this.deliveries.map(row => ({ id: row.id, sender: redact(row.sender), channel: row.channel, status: row.status, receivedAt: row.receivedAt, ...(row.route === "record" ? {text: redact(row.text), previewState:row.previewState,
        ...(row.previewNotice ? {previewNotice:row.previewNotice} : {}), ...(row.reference ? {reference:redactReference(row.reference)} : {})} : {}),
        ...(row.reply !== undefined ? { reply: redact(row.reply) } : {}), ...(row.error ? { error: redact(row.error) } : {}) })) };
  }

  async idle(): Promise<void> { while (this.running) await this.running; }
  close(): void { this.stopped = true; }
}
