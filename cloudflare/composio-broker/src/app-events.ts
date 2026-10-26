import { z } from "zod";

import {
  actingUser,
  CLOUD_DAILY_EVENTS,
  DAY_MS,
  eventLimits,
  json,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_EVENTS,
  readBoundedBody,
  readJsonBody,
  sha256,
  utcDay,
  utf8,
  type EventInstallation,
} from "./common";
import { setRemoteEnabled, TRIGGER_ID } from "./triggers";

export const MAX_WEBHOOK_BODY = 1024 * 1024;
export const MAX_EVENT_DATA_BYTES = 64 * 1024;
/** Composio's Standard Webhooks signatures (@composio/core verifyWebhook) are valid for 300 s. */
export const SIGNATURE_TOLERANCE_S = 300;
export const RETENTION_MS = 7 * DAY_MS;
export const SWEEP_AFTER_MS = 14 * DAY_MS;
export const POLL_MAX_WAIT_S = 25;
export const POLL_RECHECK_MS = 2_000;
export const POLL_MAX_LIMIT = 50;
export const POLL_LEASE_MS = 90_000;
export const WAKE_EVERY_MS = 60_000;
const WAKE_TIMEOUT_MS = 20_000;
const POLL_LEASE_MARGIN_MS = 5_000;
const COUNT_RETENTION_DAYS = 90;
const SWEEP_CALL_BUDGET = 40;
const POLLER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CLOUD_GRANT = /^v1\.([A-Za-z0-9][A-Za-z0-9_-]{2,127})\.([A-Za-z0-9_-]{43})$/;

export type EventKind = "message" | "test" | "trigger_disabled" | "account_expired";
type DropReason = "daily_limit" | "queue_full";
type DayColumn = "queued" | "delivered" | "duplicate" | "dropped_daily_limit" | "dropped_queue_full" | "expired" | "unrouted";
type Owner = Pick<EventInstallation, "id" | "composio_user_id" | "cloud_machine_id">;
export type EnqueueResult = { status: "queued"; seq: number } | { status: "duplicate" } | { status: "dropped"; reason: DropReason };
/** Work that may finish after the answer: `ctx.waitUntil` in the Worker. */
export type Background = (work: Promise<unknown>) => void;

const envelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(200),
  timestamp: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;
const testEventSchema = z.object({
  triggerId: z.string().regex(TRIGGER_ID),
  data: z.record(z.string(), z.unknown()).default({}),
}).strict();
const cloudGrantSchema = z.object({ grant: z.string().max(256) }).strict();

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

function base64Bytes(value: string, url: boolean) {
  const pattern = url ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!pattern.test(value)) return null;
  const standard = url ? value.replaceAll("-", "+").replaceAll("_", "/") : value;
  try {
    return Uint8Array.from(atob(standard), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: "sign" | "verify" = "verify") {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function base64Url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Composio V3 deliveries (Standard Webhooks headers): the HMAC-SHA256 key is the secret's UTF-8 bytes as Composio
 *  shows it, the signed text is `${webhook-id}.${webhook-timestamp}.${body}`, and `webhook-signature` holds one or
 *  more space-separated `v1,<base64>` values. */
function signatureHeaders(headers: Headers, nowMs: number) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return { ok: false as const, error: "missing signature headers" };
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) {
    return { ok: false as const, error: "stale or invalid webhook-timestamp" };
  }
  return { ok: true as const, id, timestamp, signatures };
}

async function verifyComposioSignature(
  { id, timestamp, signatures }: { id: string; timestamp: string; signatures: string },
  raw: string,
  secret: string,
) {
  const key = await hmacKey(secret);
  const signed = utf8(`${id}.${timestamp}.${raw}`);
  for (const part of signatures.split(" ")) {
    if (!part.startsWith("v1,")) continue;
    const signature = base64Bytes(part.slice(3), false);
    if (signature && await crypto.subtle.verify("HMAC", key, signature, signed)) return { ok: true as const, webhookId: id };
  }
  return { ok: false as const, error: "invalid signature" };
}

function boundedData(data: Record<string, unknown>): Record<string, unknown> {
  const encoded = utf8(JSON.stringify(data));
  if (encoded.byteLength <= MAX_EVENT_DATA_BYTES) return data;
  return {
    omb_truncated: true,
    original_bytes: encoded.byteLength,
    preview: new TextDecoder().decode(encoded.slice(0, MAX_EVENT_DATA_BYTES)),
  };
}

function messageBody(envelope: Envelope) {
  const metadata = envelope.metadata ?? {};
  return JSON.stringify({
    id: envelope.id,
    type: envelope.type,
    timestamp: envelope.timestamp ?? null,
    metadata: Object.fromEntries(["trigger_slug", "trigger_id", "connected_account_id", "user_id", "log_id"]
      .flatMap((name) => text(metadata[name]) ? [[name, metadata[name]]] : [])),
    data: boundedData(envelope.data ?? {}),
  });
}

/** Status events carry ids only: an expired account's payload is Composio's full account record, credentials included. */
function statusBody(envelope: Envelope, kind: EventKind, ids: { triggerId?: string; accountId?: string; toolkit?: string }) {
  return JSON.stringify({
    id: envelope.id,
    type: envelope.type,
    timestamp: envelope.timestamp ?? null,
    data: kind === "trigger_disabled"
      ? { trigger_id: ids.triggerId }
      : { connected_account_id: ids.accountId, toolkit: ids.toolkit ?? null, status_reason: text(envelope.data?.status_reason) ?? null },
  });
}

function dayCount(env: Env, day: string, installationId: string, column: DayColumn, by = 1) {
  return env.DB.prepare(
    `INSERT INTO app_event_days (day, installation_id, ${column}) VALUES (?1, ?2, ?3)
     ON CONFLICT (day, installation_id) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
  ).bind(day, installationId, by);
}

/** The daily limit and the queue limits apply to trigger messages and test events; status events always queue. A
 *  burst of concurrent deliveries can pass the daily check together, so the limit can be passed by that burst. */
export async function enqueue(
  env: Env,
  owner: Owner,
  event: { eventId: string; kind: EventKind; triggerId: string | null; body: string },
  now: number,
  background?: Background,
): Promise<EnqueueResult> {
  const capped = event.kind === "message" || event.kind === "test";
  const bytes = utf8(event.body).byteLength;
  const day = utcDay(now);
  const { eventsPerDay } = eventLimits(owner);
  const inserted = await env.DB.prepare(
    `INSERT INTO events (installation_id, event_id, kind, composio_trigger_id, received_at, bytes, body)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE ?8 = 0 OR (
       COALESCE((SELECT queued FROM app_event_days WHERE day = ?9 AND installation_id = ?1), 0) < ?10
       AND (SELECT COUNT(*) FROM events WHERE installation_id = ?1 AND acked_at IS NULL) < ?11
       AND COALESCE((SELECT SUM(bytes) FROM events WHERE installation_id = ?1 AND acked_at IS NULL), 0) + ?6 <= ?12
     )
     ON CONFLICT (installation_id, event_id) DO NOTHING
     RETURNING seq`,
  ).bind(owner.id, event.eventId, event.kind, event.triggerId, now, bytes, event.body, capped ? 1 : 0, day, eventsPerDay, QUEUE_MAX_EVENTS, QUEUE_MAX_BYTES)
    .first<{ seq: number }>();
  if (inserted) {
    if (capped) await dayCount(env, day, owner.id, "queued").run();
    const waking = wakeCloud(env, owner, now);
    if (background) background(waking);
    else await waking;
    return { status: "queued", seq: inserted.seq };
  }
  const state = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM events WHERE installation_id = ?1 AND event_id = ?2) AS duplicate,
       COALESCE((SELECT queued FROM app_event_days WHERE day = ?3 AND installation_id = ?1), 0) AS today`,
  ).bind(owner.id, event.eventId, day).first<{ duplicate: number; today: number }>();
  if (state?.duplicate) {
    await dayCount(env, day, owner.id, "duplicate").run();
    return { status: "duplicate" };
  }
  const reason: DropReason = (state?.today ?? 0) >= eventsPerDay ? "daily_limit" : "queue_full";
  const counts = [dayCount(env, day, owner.id, reason === "daily_limit" ? "dropped_daily_limit" : "dropped_queue_full")];
  if (event.triggerId) {
    counts.push(env.DB.prepare(
      `INSERT INTO event_drops (installation_id, composio_trigger_id, reason, dropped, last_dropped_at) VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT (installation_id, composio_trigger_id, reason) DO UPDATE SET dropped = dropped + 1, last_dropped_at = excluded.last_dropped_at`,
    ).bind(owner.id, event.triggerId, reason, now));
  }
  await env.DB.batch(counts);
  console.warn(JSON.stringify({ message: "app event dropped", installationId: owner.id, triggerId: event.triggerId, reason }));
  return { status: "dropped", reason };
}

export function cloudWakeMessage(timestamp: number, machineId: string) {
  return `omb-cloud-wake:v1\n${timestamp}\n${machineId}`;
}

/** `v1=<base64url HMAC-SHA256(CLOUD_GRANT_SECRET, cloudWakeMessage(timestamp, machine id))>`, which the Cloud Admin
 *  checks on `POST /api/cloud/machines/wake`. */
export async function cloudWakeSignature(secret: string, timestamp: number, machineId: string) {
  return `v1=${base64Url(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), utf8(cloudWakeMessage(timestamp, machineId))))}`;
}

function adminWakeUrl(value: string | undefined) {
  try {
    const url = value ? new URL("/api/cloud/machines/wake", value) : null;
    return url?.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A Cloud on a plan that sleeps collects its events only while awake: when one is queued for a Cloud installation
 *  that isn't polling, the Admin starts it, asked at most once a minute. Off unless CLOUD_GRANT_SECRET and
 *  CLOUD_ADMIN_URL are both set. It never fails the event, a database without migration 0003 included. */
async function wakeCloud(env: Env, owner: Owner, now: number) {
  const secret = env.CLOUD_GRANT_SECRET, url = adminWakeUrl(env.CLOUD_ADMIN_URL), machineId = owner.cloud_machine_id;
  if (!secret || !url || !machineId) return;
  try {
    const asked = await env.DB.prepare(
      `UPDATE installations SET wake_requested_at = ?1
       WHERE id = ?2 AND cloud_machine_id = ?3 AND (poll_lease_until IS NULL OR poll_lease_until < ?1)
         AND (wake_requested_at IS NULL OR wake_requested_at <= ?4)`,
    ).bind(now, owner.id, machineId, now - WAKE_EVERY_MS).run();
    if (!asked.meta.changes) return;
    const timestamp = Math.floor(now / 1000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-omb-wake-timestamp": String(timestamp), "x-omb-wake-signature": await cloudWakeSignature(secret, timestamp, machineId) },
      body: JSON.stringify({ machineId }),
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) console.warn(JSON.stringify({ message: "cloud wake refused", installationId: owner.id, status: response.status }));
  } catch (error) {
    console.warn(JSON.stringify({ message: "cloud wake failed", installationId: owner.id, error: error instanceof Error ? error.message : String(error) }));
  }
}

interface OwnerRow {
  id: string;
  composio_user_id: string;
  shared_user_id?: string | null;
  cloud_machine_id: string | null;
  binding_disabled_at: number | null;
  installation_disabled_at: number | null;
}

async function triggerOwners(env: Env, triggerId: string) {
  const { results } = await env.DB.prepare(
    `SELECT i.*, b.disabled_at AS binding_disabled_at, i.disabled_at AS installation_disabled_at
     FROM trigger_bindings b JOIN installations i ON i.id = b.installation_id
     WHERE b.composio_trigger_id = ?`,
  ).bind(triggerId).all<OwnerRow>();
  return results;
}

async function accountOwners(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT i.*, NULL AS binding_disabled_at, i.disabled_at AS installation_disabled_at
     FROM trigger_bindings b JOIN installations i ON i.id = b.installation_id
     WHERE b.connected_account_id = ?`,
  ).bind(accountId).all<OwnerRow>();
  return results;
}

function unrouted(env: Env, now: number, why: string, triggerId?: string) {
  console.warn(JSON.stringify({ message: "app event not routed", why, triggerId: triggerId ?? null }));
  return dayCount(env, utcDay(now), "", "unrouted").run();
}

/** Bindings route by trigger or account id; the Composio user named in the event must also be the installation's,
 *  so a mixed-up binding can never hand one person's events to another installation. */
function refusal(owner: OwnerRow, userId: unknown) {
  if (userId !== undefined && userId !== null && userId !== actingUser(owner)) return "user mismatch";
  if (owner.installation_disabled_at !== null) return "installation disabled";
  return undefined;
}

/** Composio retries any non-2xx, so an event no installation can take is answered 200 and only counted. */
async function routeEnvelope(env: Env, envelope: Envelope, now: number, background?: Background) {
  const metadata = envelope.metadata ?? {};
  const data = envelope.data ?? {};
  if (envelope.type === "composio.trigger.message") {
    const triggerId = text(metadata.trigger_id);
    const owners = triggerId ? await triggerOwners(env, triggerId) : [];
    if (!triggerId || !owners.length) return unrouted(env, now, "unknown trigger", triggerId);
    const userId = metadata.user_id;
    for (const owner of owners) {
      const refused = refusal(owner, userId) ?? (owner.binding_disabled_at !== null ? "trigger paused" : undefined);
      if (refused) await unrouted(env, now, refused, triggerId);
      else await enqueue(env, owner, { eventId: envelope.id, kind: "message", triggerId, body: messageBody(envelope) }, now, background);
    }
    return;
  }
  if (envelope.type === "composio.trigger.disabled") {
    const triggerId = text(metadata.trigger_id) ?? text(data.trigger_id) ?? text(data.id);
    const owners = triggerId ? await triggerOwners(env, triggerId) : [];
    if (!triggerId || !owners.length) return unrouted(env, now, "unknown trigger", triggerId);
    const userId = metadata.user_id ?? data.user_id;
    for (const owner of owners) {
      const refused = refusal(owner, userId);
      if (refused) await unrouted(env, now, refused, triggerId);
      else await enqueue(env, owner, { eventId: envelope.id, kind: "trigger_disabled", triggerId, body: statusBody(envelope, "trigger_disabled", { triggerId }) }, now, background);
    }
    return;
  }
  if (envelope.type === "composio.connected_account.expired") {
    const accountId = text(data.id) ?? text(metadata.connected_account_id);
    const owners = accountId ? await accountOwners(env, accountId) : [];
    if (!accountId || !owners.length) return unrouted(env, now, "unknown account");
    const userId = data.user_id ?? metadata.user_id;
    const toolkit = text((data.toolkit as { slug?: unknown } | undefined)?.slug);
    for (const owner of owners) {
      const refused = refusal(owner, userId);
      if (refused) await unrouted(env, now, refused);
      else await enqueue(env, owner, { eventId: envelope.id, kind: "account_expired", triggerId: null, body: statusBody(envelope, "account_expired", { accountId, toolkit }) }, now, background);
    }
    return;
  }
  console.log(JSON.stringify({ message: "composio event type ignored", type: envelope.type }));
}

function rejectWebhook(error: string) {
  console.warn(JSON.stringify({ message: "composio webhook rejected", why: error }));
  return json({ error }, 401);
}

/** POST /v1/composio/webhook: the one subscription of the managed Composio project. */
export async function composioWebhook(request: Request, env: Env, ctx?: Pick<ExecutionContext, "waitUntil">) {
  const secret = env.COMPOSIO_WEBHOOK_SECRET;
  if (!secret) return json({ error: "app events are not configured" }, 503);
  const early = signatureHeaders(request.headers, Date.now());
  if (!early.ok) return rejectWebhook(early.error);
  const body = await readBoundedBody(request, MAX_WEBHOOK_BODY);
  if (!body) return json({ error: "event is too large" }, 413);
  const now = Date.now();
  const signed = signatureHeaders(request.headers, now);
  if (!signed.ok) return rejectWebhook(signed.error);
  const raw = new TextDecoder().decode(body);
  const verdict = await verifyComposioSignature(signed, raw, secret);
  if (!verdict.ok) return rejectWebhook(verdict.error);
  let envelope: Envelope;
  try {
    envelope = envelopeSchema.parse(JSON.parse(raw));
  } catch {
    return json({ error: "not a V3 event envelope" }, 400);
  }
  if (envelope.id !== verdict.webhookId) return json({ error: "envelope id does not match webhook-id" }, 400);
  await routeEnvelope(env, envelope, now, ctx ? (work) => ctx.waitUntil(work) : undefined);
  return json({ received: true });
}

function intParam(url: URL, name: string, fallback: number, max: number) {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const number = /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? Math.min(number, max) : null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One poller per installation: a lease keyed by the server's stable poller id. It is renewed only when it would
 *  run out during this poll, so most polls write nothing. */
async function holdPollLease(env: Env, installation: EventInstallation, poller: string, waitS: number, now: number) {
  const left = (installation.poll_lease_until ?? 0) - now;
  if (installation.poll_lease_id === poller && left >= waitS * 1000 + POLL_LEASE_MARGIN_MS) return { ok: true as const };
  const claimed = await env.DB.prepare(
    `UPDATE installations SET poll_lease_id = ?1, poll_lease_until = ?2, events_polled_at = ?3
     WHERE id = ?4 AND (poll_lease_id = ?1 OR poll_lease_until IS NULL OR poll_lease_until < ?3)`,
  ).bind(poller, now + POLL_LEASE_MS, now, installation.id).run();
  if (claimed.meta.changes) return { ok: true as const };
  const current = await env.DB.prepare("SELECT poll_lease_until FROM installations WHERE id = ?").bind(installation.id)
    .first<{ poll_lease_until: number | null }>();
  return { ok: false as const, retryAfterS: Math.max(1, Math.ceil(((current?.poll_lease_until ?? now) - now) / 1000)) };
}

interface QueuedRow {
  seq: number;
  event_id: string;
  kind: EventKind;
  composio_trigger_id: string | null;
  received_at: number;
  body: string;
}

function pendingEvents(env: Env, installationId: string, after: number, limit: number) {
  return env.DB.prepare(
    `SELECT seq, event_id, kind, composio_trigger_id, received_at, body FROM events
     WHERE installation_id = ? AND acked_at IS NULL AND seq > ? ORDER BY seq LIMIT ?`,
  ).bind(installationId, after, limit).all<QueuedRow>().then(({ results }) => results);
}

/** The poll's cursor is the ack: every event at or below it has been saved by the server. An acked row keeps its
 *  id so a later redelivery of the same event is still a duplicate. */
async function ackThrough(env: Env, installationId: string, after: number, now: number) {
  if (after <= 0) return;
  const acked = await env.DB.prepare(
    "UPDATE events SET body = '', bytes = 0, acked_at = ?1 WHERE installation_id = ?2 AND acked_at IS NULL AND seq <= ?3",
  ).bind(now, installationId, after).run();
  if (acked.meta.changes) await dayCount(env, utcDay(now), installationId, "delivered", acked.meta.changes).run();
}

/** Re-enables at Composio what the 14-day sweep disabled, on the installation's first polls back, up to one sweep
 *  run's worth per poll. A failure here is caught by the server's reconciliation, which sees `enabled` beside a
 *  disabled remote. */
async function resumeSweptTriggers(env: Env, installationId: string) {
  await env.DB.prepare("UPDATE installations SET triggers_swept_at = NULL WHERE id = ?").bind(installationId).run();
  const { results } = await env.DB.prepare(
    "SELECT composio_trigger_id, disabled_at FROM trigger_bindings WHERE installation_id = ? AND swept_at IS NOT NULL ORDER BY composio_trigger_id LIMIT ?",
  ).bind(installationId, SWEEP_CALL_BUDGET).all<{ composio_trigger_id: string; disabled_at: number | null }>();
  for (const row of results) {
    await env.DB.prepare("UPDATE trigger_bindings SET swept_at = NULL WHERE installation_id = ? AND composio_trigger_id = ?")
      .bind(installationId, row.composio_trigger_id).run();
    if (row.disabled_at !== null) continue;
    const result = await setRemoteEnabled(env, row.composio_trigger_id, true);
    if (result !== "done") console.warn(JSON.stringify({ message: "re-enabling a swept trigger failed", installationId, triggerId: row.composio_trigger_id }));
  }
  if (results.length === SWEEP_CALL_BUDGET) {
    await env.DB.prepare("UPDATE installations SET triggers_swept_at = ? WHERE id = ?").bind(Date.now(), installationId).run();
  }
}

/** GET /v1/events?after=<seq>&wait=<0-25>&limit=<1-50>, with header x-omb-poller. */
export async function pollEvents(request: Request, url: URL, installation: EventInstallation, env: Env, ctx: ExecutionContext) {
  if (!(await env.EVENTS_LIMITER.limit({ key: installation.id })).success) return json({ error: "too many event requests" }, 429);
  const poller = request.headers.get("x-omb-poller") ?? "";
  if (!POLLER_ID.test(poller)) return json({ error: "x-omb-poller must be the server's stable id: 8-64 letters, digits, - or _" }, 400);
  const after = intParam(url, "after", 0, Number.MAX_SAFE_INTEGER);
  const wait = intParam(url, "wait", 0, POLL_MAX_WAIT_S);
  const limit = intParam(url, "limit", POLL_MAX_LIMIT, POLL_MAX_LIMIT);
  if (after === null || wait === null || limit === null || limit < 1) return json({ error: "after, wait and limit must be whole numbers" }, 400);
  const started = Date.now();
  const lease = await holdPollLease(env, installation, poller, wait, started);
  if (!lease.ok) {
    return json({ error: "another server is reading this installation's events" }, 409, { "retry-after": String(lease.retryAfterS) });
  }
  await ackThrough(env, installation.id, after, started);
  if (installation.triggers_swept_at !== null) ctx.waitUntil(resumeSweptTriggers(env, installation.id));
  let rows = await pendingEvents(env, installation.id, after, limit);
  while (!rows.length) {
    const left = wait * 1000 - (Date.now() - started);
    if (left <= 0) break;
    await sleep(Math.min(POLL_RECHECK_MS, left));
    rows = await pendingEvents(env, installation.id, after, limit);
  }
  return json({
    events: rows.map((row) => ({
      seq: row.seq,
      id: row.event_id,
      kind: row.kind,
      triggerId: row.composio_trigger_id,
      receivedAt: row.received_at,
      event: JSON.parse(row.body) as unknown,
    })),
    cursor: rows.at(-1)?.seq ?? after,
  });
}

/** POST /v1/events/test {triggerId, data}: a synthetic event through the real queue, counted against the limits. */
export async function queueTestEvent(request: Request, installation: EventInstallation, env: Env) {
  if (!(await env.EVENTS_LIMITER.limit({ key: installation.id })).success) return json({ error: "too many event requests" }, 429);
  const parsed = testEventSchema.safeParse(await readJsonBody(request, 4 * MAX_EVENT_DATA_BYTES));
  if (!parsed.success) return json({ error: "triggerId and data (an object) are required" }, 400);
  const { triggerId, data } = parsed.data;
  const bound = await env.DB.prepare(
    "SELECT trigger_slug, connected_account_id FROM trigger_bindings WHERE installation_id = ? AND composio_trigger_id = ?",
  ).bind(installation.id, triggerId).first<{ trigger_slug: string; connected_account_id: string }>();
  if (!bound) return json({ error: "no such trigger" }, 404);
  const now = Date.now();
  const eventId = `test_${crypto.randomUUID()}`;
  const body = JSON.stringify({
    id: eventId,
    type: "omb.test",
    timestamp: new Date(now).toISOString(),
    metadata: { trigger_slug: bound.trigger_slug, trigger_id: triggerId, connected_account_id: bound.connected_account_id, user_id: actingUser(installation) },
    data: boundedData(data),
  });
  const result = await enqueue(env, installation, { eventId, kind: "test", triggerId, body }, now);
  if (result.status === "queued") return json({ queued: true, id: eventId, seq: result.seq }, 201);
  return json({ queued: false, dropped: result.status === "dropped" ? result.reason : result.status }, 429);
}

async function expireEvents(env: Env, now: number) {
  const cutoff = now - RETENTION_MS;
  const day = utcDay(now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO event_drops (installation_id, composio_trigger_id, reason, dropped, last_dropped_at)
       SELECT installation_id, composio_trigger_id, 'expired', COUNT(*), ?2 FROM events
       WHERE received_at < ?1 AND acked_at IS NULL AND composio_trigger_id IS NOT NULL AND kind IN ('message', 'test')
       GROUP BY installation_id, composio_trigger_id
       ON CONFLICT (installation_id, composio_trigger_id, reason) DO UPDATE SET
         dropped = dropped + excluded.dropped, last_dropped_at = excluded.last_dropped_at`,
    ).bind(cutoff, now),
    env.DB.prepare(
      `INSERT INTO app_event_days (day, installation_id, expired)
       SELECT ?2, installation_id, COUNT(*) FROM events
       WHERE received_at < ?1 AND acked_at IS NULL AND kind IN ('message', 'test')
       GROUP BY installation_id
       ON CONFLICT (day, installation_id) DO UPDATE SET expired = expired + excluded.expired`,
    ).bind(cutoff, day),
    env.DB.prepare("DELETE FROM events WHERE received_at < ?").bind(cutoff),
  ]);
}

/** Disables at Composio the triggers of installations that have not polled for 14 days, so deliveries nobody reads
 *  stop costing events. Bindings keep the server's wish; its next poll re-enables them. Each run handles the next
 *  bindings not yet swept, so an installation with more of them than one run may disable is finished over several. */
async function sweepIdleInstallations(env: Env, now: number) {
  const { results } = await env.DB.prepare(
    `SELECT b.installation_id, b.composio_trigger_id,
       (SELECT COUNT(*) FROM trigger_bindings o
        WHERE o.composio_trigger_id = b.composio_trigger_id AND o.installation_id != b.installation_id AND o.disabled_at IS NULL) AS shared
     FROM trigger_bindings b JOIN installations i ON i.id = b.installation_id
     WHERE b.disabled_at IS NULL AND b.swept_at IS NULL
       AND COALESCE(i.events_polled_at, (SELECT MAX(c.created_at) FROM trigger_bindings c WHERE c.installation_id = i.id)) < ?1
     ORDER BY b.installation_id, b.composio_trigger_id LIMIT ?2`,
  ).bind(now - SWEEP_AFTER_MS, SWEEP_CALL_BUDGET).all<{ installation_id: string; composio_trigger_id: string; shared: number }>();
  for (const { installation_id: installationId, composio_trigger_id: triggerId, shared } of results) {
    if (!shared && typeof await setRemoteEnabled(env, triggerId, false) === "object") {
      console.warn(JSON.stringify({ message: "disabling an idle installation's trigger failed", installationId, triggerId }));
      continue;
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE trigger_bindings SET swept_at = ?1 WHERE installation_id = ?2 AND composio_trigger_id = ?3")
        .bind(now, installationId, triggerId),
      env.DB.prepare("UPDATE installations SET triggers_swept_at = ?1 WHERE id = ?2").bind(now, installationId),
    ]);
  }
}

export async function runHourly(env: Env, now = Date.now()) {
  await expireEvents(env, now);
  await sweepIdleInstallations(env, now);
  await env.DB.prepare("DELETE FROM app_event_days WHERE day < ?").bind(utcDay(now - COUNT_RETENTION_DAYS * DAY_MS)).run();
}

function sameDigest(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** GET /v1/stats/app-events?days=<1-90>, Bearer STATS_TOKEN: fleet totals for Admin, counts only. */
export async function appEventStats(request: Request, url: URL, env: Env) {
  if (!env.STATS_TOKEN) return json({ error: "not found" }, 404);
  const presented = request.headers.get("authorization")?.match(/^Bearer (\S{1,512})$/)?.[1] ?? "";
  if (!sameDigest(await sha256(presented), await sha256(env.STATS_TOKEN))) return json({ error: "unauthorized" }, 401);
  const days = intParam(url, "days", 30, COUNT_RETENTION_DAYS);
  if (!days) return json({ error: "days must be 1-90" }, 400);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(queued) AS queued, SUM(delivered) AS delivered, SUM(duplicate) AS duplicate,
       SUM(dropped_daily_limit) AS dropped_daily_limit, SUM(dropped_queue_full) AS dropped_queue_full,
       SUM(expired) AS expired, SUM(unrouted) AS unrouted,
       COUNT(CASE WHEN installation_id != '' AND queued > 0 THEN 1 END) AS installations
     FROM app_event_days WHERE day >= ? GROUP BY day ORDER BY day`,
  ).bind(utcDay(now - (days - 1) * DAY_MS)).all<Record<string, number | string>>();
  const current = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM trigger_bindings) AS bindings,
       (SELECT COUNT(*) FROM trigger_bindings WHERE disabled_at IS NULL) AS enabled_bindings,
       (SELECT COUNT(DISTINCT installation_id) FROM trigger_bindings) AS installations_with_triggers,
       (SELECT COUNT(*) FROM installations WHERE cloud_machine_id IS NOT NULL) AS cloud_installations,
       (SELECT COUNT(*) FROM installations WHERE events_polled_at >= ?1) AS polled_last_hour,
       (SELECT COUNT(*) FROM events WHERE acked_at IS NULL) AS queued_events,
       (SELECT COALESCE(SUM(bytes), 0) FROM events WHERE acked_at IS NULL) AS queued_bytes`,
  ).bind(now - 60 * 60_000).first<Record<string, number>>();
  return json({
    days: results.map((row) => ({
      day: row.day,
      queued: row.queued,
      delivered: row.delivered,
      duplicate: row.duplicate,
      droppedDailyLimit: row.dropped_daily_limit,
      droppedQueueFull: row.dropped_queue_full,
      expired: row.expired,
      unrouted: row.unrouted,
      installations: row.installations,
    })),
    current: {
      bindings: current?.bindings ?? 0,
      enabledBindings: current?.enabled_bindings ?? 0,
      installationsWithTriggers: current?.installations_with_triggers ?? 0,
      cloudInstallations: current?.cloud_installations ?? 0,
      polledLastHour: current?.polled_last_hour ?? 0,
      queuedEvents: current?.queued_events ?? 0,
      queuedBytes: current?.queued_bytes ?? 0,
    },
  });
}

export function cloudGrantMessage(machineId: string) {
  return `omb-connected-apps-cloud:v1\n${machineId}`;
}

/** `v1.<machine id>.<base64url HMAC-SHA256(CLOUD_GRANT_SECRET, cloudGrantMessage(machine id))>`, minted by the Cloud
 *  Admin for each paid Cloud. Returns the machine id it names, or null. */
export async function verifyCloudGrant(grant: string, secret: string) {
  const match = CLOUD_GRANT.exec(grant);
  const signature = match ? base64Bytes(match[2], true) : null;
  if (!match || !signature) return null;
  return await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, utf8(cloudGrantMessage(match[1]))) ? match[1] : null;
}

/** PUT /v1/installation/cloud {grant}: marks this installation as a paid Cloud's. One machine holds the Cloud limit
 *  on one installation at a time, so a copied grant moves it rather than multiplying it. */
export async function presentCloudGrant(request: Request, installation: EventInstallation, env: Env) {
  if (!env.CLOUD_GRANT_SECRET) return json({ error: "Cloud grants are not configured" }, 503);
  const parsed = cloudGrantSchema.safeParse(await readJsonBody(request, 1024));
  const machineId = parsed.success ? await verifyCloudGrant(parsed.data.grant, env.CLOUD_GRANT_SECRET) : null;
  if (!machineId) return json({ error: "invalid Cloud grant" }, 403);
  await env.DB.batch([
    env.DB.prepare("UPDATE installations SET cloud_machine_id = NULL WHERE cloud_machine_id = ?1 AND id != ?2").bind(machineId, installation.id),
    env.DB.prepare("UPDATE installations SET cloud_machine_id = ?1 WHERE id = ?2").bind(machineId, installation.id),
  ]);
  return json({ plan: "cloud", eventsPerDay: CLOUD_DAILY_EVENTS });
}
