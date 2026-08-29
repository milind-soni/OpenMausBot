/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof,
 * anti-slop/no-conditional-empty-object-spread
 * -- phone notifications are untrusted transport input. Zod validation is
 * performed before any sensitive event is written to CaptureMemory. */
import { z } from "zod";

import {
  CaptureMemory,
  type CaptureMemorySensitivity,
  type CaptureMemorySearchResult,
  type CaptureMemoryUpserted,
} from "./capture-memory.ts";

/** Sources that may be represented by a phone notification. This is an
 * intentionally small allowlist: a notification mirror is not a general
 * purpose phone-to-desktop upload channel. */
export const NOTIFICATION_MIRROR_SOURCE_IDS = ["google-messages"] as const;

const deviceIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** The phone sends only bounded, visible notification text. Unknown fields
 * are rejected so a future client cannot quietly turn this route into a
 * broader data export. */
export const notificationMirrorEventSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,240}$/),
  packageName: z.literal("com.google.android.apps.messaging"),
  postedAt: z.number().finite().positive(),
  title: z.string().trim().max(240),
  text: z.string().trim().max(8_000),
  conversationTitle: z.string().trim().max(240).optional(),
  sender: z.string().trim().max(240).optional(),
}).strict().refine((event) => Boolean(event.title || event.text), {
  message: "a visible title or message is required",
});

export type NotificationMirrorEvent = z.infer<typeof notificationMirrorEventSchema>;

export interface NotificationMirrorResult {
  status: CaptureMemoryUpserted["status"];
}

const notificationMirrorCursorSchema = z.object({
  occurredAt: z.number().finite().nonnegative(),
  eventId: z.string().trim().max(240),
}).strict();

export type NotificationMirrorCursor = z.infer<typeof notificationMirrorCursorSchema>;

export interface NotificationMirrorReadResult {
  status: "ok" | "empty" | "needs-auth";
  provider: "notification-mirror";
  items: CaptureMemorySearchResult[];
  cursor: NotificationMirrorCursor;
  heartbeat: {
    status: "fresh" | "stale" | "missing";
    lastSeenAt: number | null;
    deviceCount: number;
  };
  error?: string;
}

export type NotificationMirrorOutcome =
  | { ok: true; result: NotificationMirrorResult }
  | { ok: false; error: string };

function deviceAccountId(deviceId: string): string {
  return `phone:${deviceId}`;
}

function parseReadCursor(raw: unknown): NotificationMirrorCursor {
  const parsed = notificationMirrorCursorSchema.safeParse(raw);
  return parsed.success ? parsed.data : { occurredAt: 0, eventId: "" };
}

/** Persist an opaque transport heartbeat without copying any notification
 * content. The synthetic row is deliberately a different kind so the read
 * path can never return it as a message. */
export function recordNotificationMirrorHeartbeat(
  memory: CaptureMemory,
  deviceId: unknown,
  options: { botId: string; sectionId: string; now?: number },
): NotificationMirrorOutcome {
  const parsedDevice = deviceIdSchema.safeParse(deviceId);
  if (!parsedDevice.success) return { ok: false, error: "invalid paired device" };
  if (typeof options.botId !== "string" || options.botId.trim().length === 0
    || typeof options.sectionId !== "string" || options.sectionId.trim().length === 0) {
    return { ok: false, error: "notification mirror destination unavailable" };
  }
  const timestamp = options.now ?? Date.now();
  const item = memory.upsert({
    botId: options.botId.trim(),
    sectionId: options.sectionId.trim(),
    sourceId: "google-messages",
    accountId: deviceAccountId(parsedDevice.data),
    externalId: `heartbeat:${parsedDevice.data}`,
    kind: "notification-mirror-heartbeat",
    title: "Google Messages mirror transport",
    occurredAt: timestamp,
    capturedAt: timestamp,
    sensitivity: "sensitive",
    metadata: { channel: "notification-mirror", heartbeat: true },
  });
  return { ok: true, result: { status: item.status } };
}

/** Read only mirrored Google Messages notifications for this destination.
 * Authorization happens at the HTTP/tool boundary; this function still
 * applies source, item-kind, account namespace, section, and cursor filters
 * so a caller cannot accidentally widen a sensitive read. */
export function readNotificationMirror(
  memory: CaptureMemory,
  options: {
    botId: string;
    sectionId: string;
    cursor?: unknown;
    limit?: number;
    now?: number;
    heartbeatMaxAgeMs?: number;
  },
): NotificationMirrorReadResult {
  const cursor = parseReadCursor(options.cursor);
  const limit = Math.min(100, Math.max(1, Math.round(options.limit ?? 50)));
  const now = options.now ?? Date.now();
  // Android schedules this with WorkManager's 15-minute minimum interval;
  // allow a small amount of OEM/network jitter before declaring it stale.
  const heartbeatMaxAgeMs = Math.max(60_000, options.heartbeatMaxAgeMs ?? 20 * 60_000);
  const heartbeatRows = memory.search({
    botId: options.botId,
    sectionId: options.sectionId,
    sourceId: "google-messages",
    kind: "notification-mirror-heartbeat",
    accountPrefix: "phone:",
    includeSensitive: true,
    limit: 100,
  });
  const lastSeenAt = heartbeatRows.reduce<number | null>(
    (latest, result) => latest === null || result.item.capturedAt > latest ? result.item.capturedAt : latest,
    null,
  );
  const deviceCount = new Set(heartbeatRows.map((result) => result.item.accountId).filter(Boolean)).size;
  const heartbeatStatus: NotificationMirrorReadResult["heartbeat"]["status"] = lastSeenAt === null
    ? "missing"
    : now - lastSeenAt <= heartbeatMaxAgeMs
      ? "fresh"
      : "stale";
  const heartbeat = { status: heartbeatStatus, lastSeenAt, deviceCount };
  if (heartbeatStatus !== "fresh") {
    return {
      status: "needs-auth",
      provider: "notification-mirror",
      items: [],
      cursor,
      heartbeat,
      error: heartbeatStatus === "missing"
        ? "Google Messages notification mirror has not reported a transport heartbeat"
        : "Google Messages notification mirror heartbeat is stale",
    };
  }

  const candidates = memory.search({
    botId: options.botId,
    sectionId: options.sectionId,
    sourceId: "google-messages",
    kind: "message-notification",
    accountPrefix: "phone:",
    includeSensitive: true,
    limit: 100,
  }).filter(({ item }) => item.occurredAt > cursor.occurredAt
    || (item.occurredAt === cursor.occurredAt && item.eventId > cursor.eventId));
  const ordered = candidates.sort((left, right) => left.item.occurredAt - right.item.occurredAt
    || left.item.eventId.localeCompare(right.item.eventId));
  const items = ordered.slice(0, limit);
  const nextCursor = items.at(-1)?.item;
  return {
    status: items.length ? "ok" : "empty",
    provider: "notification-mirror",
    items,
    cursor: nextCursor
      ? { occurredAt: nextCursor.occurredAt, eventId: nextCursor.eventId }
      : cursor,
    heartbeat,
  };
}

/** Validate and persist one mirrored notification. The caller chooses the
 * destination bot after the caller checks that it owns source-memory writes.
 * device id is part of the capture identity and account namespace, so two
 * paired phones can never overwrite one another's event ids. */
export function ingestNotificationMirror(
  memory: CaptureMemory,
  deviceId: unknown,
  rawEvent: unknown,
  options: { botId: string; sectionId: string; now?: number },
): NotificationMirrorOutcome {
  const parsedDevice = deviceIdSchema.safeParse(deviceId);
  if (!parsedDevice.success) return { ok: false, error: "invalid paired device" };
  const parsed = notificationMirrorEventSchema.safeParse(rawEvent);
  if (!parsed.success) return { ok: false, error: "invalid notification mirror event" };
  if (typeof options.botId !== "string" || options.botId.trim().length === 0) {
    return { ok: false, error: "notification mirror destination unavailable" };
  }
  if (typeof options.sectionId !== "string" || options.sectionId.trim().length === 0) {
    return { ok: false, error: "notification mirror destination unavailable" };
  }

  const event = parsed.data;
  // An event itself is also a transport heartbeat. This keeps the read path
  // honest even when the dedicated periodic heartbeat has not run yet.
  const heartbeat = recordNotificationMirrorHeartbeat(memory, parsedDevice.data, options);
  if (!heartbeat.ok) return heartbeat;
  const accountId = deviceAccountId(parsedDevice.data);
  const metadata = {
    channel: "notification-mirror",
    ...(event.conversationTitle ? { conversationTitle: event.conversationTitle } : {}),
    ...(event.sender ? { sender: event.sender } : {}),
    packageName: event.packageName,
  };
  const sensitivity: CaptureMemorySensitivity = "sensitive";
  const item = memory.upsert({
    botId: options.botId.trim(),
    sectionId: options.sectionId.trim(),
    sourceId: "google-messages",
    accountId,
    // Namespacing the provider id by paired device is what makes a replayed
    // event from another phone a distinct record rather than an update.
    externalId: `${parsedDevice.data}:${event.id}`,
    kind: "message-notification",
    title: event.title || event.conversationTitle || event.sender || "Google Messages",
    body: event.text,
    occurredAt: event.postedAt,
    capturedAt: options.now,
    sensitivity,
    metadata,
  });
  return { ok: true, result: { status: item.status } };
}
