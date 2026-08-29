import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { JsonValue } from "./schema.ts";
import type { CaptureMemoryItemInput, CaptureMemorySensitivity } from "./capture-memory.ts";

/**
 * The browser extension submits receipts to one data-only loopback endpoint.
 * That endpoint accepts only extension origins plus an explicit custom header,
 * validates the payload here, and writes it to private app data. It cannot
 * invoke tools or commands and is not a general browser-control channel.
 */
export const BROWSER_CAPTURE_SCHEMA_VERSION = 1 as const;
export const BROWSER_CAPTURE_DIRECTORY = join(DATA_DIR, "browser-capture");
const RETAINED_BROWSER_EVENTS_PER_SOURCE = 12;

export const BROWSER_SOURCE_IDS = [
  "plaud",
  "monarch",
  "google-messages",
  "youtube",
  "mercury",
  "ai-chatgpt",
  "ai-claude",
  "ai-grok",
  "ai-gemini",
] as const;
export type BrowserSourceId = (typeof BROWSER_SOURCE_IDS)[number];

const sourceIdSchema = z.enum(BROWSER_SOURCE_IDS);
const browserItemSchema = z.object({
  kind: z.enum(["page", "message", "transcript", "video", "record"]),
  title: z.string().trim().min(1).max(240),
  text: z.string().max(4_000).optional(),
});
const cursorSchema = z.object({ capturedAt: z.string().datetime(), captureId: z.string().uuid() });
const receiptSchema = z.object({
  schemaVersion: z.literal(BROWSER_CAPTURE_SCHEMA_VERSION),
  captureId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  sourceId: sourceIdSchema,
  url: z.string().url().max(2_000),
  title: z.string().trim().min(1).max(240),
  items: z.array(browserItemSchema).max(50),
  cursor: cursorSchema,
});

export type BrowserCaptureItem = z.infer<typeof browserItemSchema>;
export type BrowserCaptureCursor = z.infer<typeof cursorSchema>;
export type BrowserCaptureReceipt = z.infer<typeof receiptSchema>;
export type BrowserCapturePayload = z.input<typeof receiptSchema>;

function isAiPortalSource(sourceId: BrowserSourceId): boolean {
  return sourceId.startsWith("ai-");
}

export interface BrowserCaptureReadResult {
  status: "ok" | "empty" | "failed" | "needs-auth";
  receipts: BrowserCaptureReceipt[];
  cursor: BrowserCaptureCursor | null;
  error?: string;
}

const BROWSER_SOURCE_LABELS: Record<BrowserSourceId, string> = {
  plaud: "Plaud",
  monarch: "Monarch",
  "google-messages": "Google Messages",
  youtube: "YouTube",
  mercury: "Mercury",
  "ai-chatgpt": "ChatGPT",
  "ai-claude": "Claude",
  "ai-grok": "Grok",
  "ai-gemini": "Gemini",
};

const BROWSER_SOURCE_SENSITIVITY: Record<BrowserSourceId, CaptureMemoryItemInput["sensitivity"]> = {
  plaud: "sensitive",
  monarch: "restricted",
  "google-messages": "sensitive",
  youtube: "internal",
  mercury: "restricted",
  "ai-chatgpt": "sensitive",
  "ai-claude": "sensitive",
  "ai-grok": "sensitive",
  "ai-gemini": "sensitive",
};

const SENSITIVITY_RANK: Record<CaptureMemorySensitivity, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  restricted: 3,
};

/** Browser sources have a server-enforced floor even when an agent submits a weaker label. */
export function enforceBrowserSourceSensitivity(
  sourceId: string,
  requested: CaptureMemorySensitivity,
): CaptureMemorySensitivity {
  if (!sourceIdSchema.safeParse(sourceId).success) return requested;
  const minimum = BROWSER_SOURCE_SENSITIVITY[sourceId as BrowserSourceId];
  return SENSITIVITY_RANK[requested] >= SENSITIVITY_RANK[minimum] ? requested : minimum;
}

function unseededBrowserSource(
  sourceId: BrowserSourceId | undefined,
  cursor: BrowserCaptureCursor | null,
): BrowserCaptureReadResult {
  const label = sourceId ? BROWSER_SOURCE_LABELS[sourceId] : "browser source";
  return {
    status: "needs-auth",
    receipts: [],
    cursor,
    error: `${label} has no captured receipt yet. Open its signed-in Chrome tab and seed a fresh receipt.`,
  };
}

export interface BrowserCaptureEvidence {
  sourceId: BrowserSourceId;
  title: string;
  text?: string;
  evidenceRef: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:otp|one[- ]?time password|verification code|security code)\s*[:=-]?\s*\d{4,10}\b/gi,
  /\b(?:password|passcode|api[ _-]?key|access token|bearer)\s*[:=-]\s*\S+/gi,
  /\b(?:sk|xai|ak|ghp|gho|eyJ)[A-Za-z0-9_-]{12,}\b/g,
];

function redact(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[redacted]");
  return result;
}

function cleanUrl(value: string): string {
  const url = new URL(value);
  // Query strings and fragments routinely carry session/search identifiers.
  // Keep the path for evidence while dropping those identifiers by default.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function inferSourceId(url: string): BrowserSourceId | null {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "messages.google.com" || host.endsWith(".messages.google.com")) return "google-messages";
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
  if (
    host === "monarchmoney.com"
    || host.endsWith(".monarchmoney.com")
    || host === "monarch.com"
    || host.endsWith(".monarch.com")
  ) return "monarch";
  if (host === "plaud.ai" || host.endsWith(".plaud.ai")) return "plaud";
  if (host === "mercury.com" || host.endsWith(".mercury.com")) return "mercury";
  if (host === "chatgpt.com" || host === "chat.openai.com") return "ai-chatgpt";
  if (host === "claude.ai" || host.endsWith(".claude.ai")) return "ai-claude";
  if (host === "grok.com" || host.endsWith(".grok.com")) return "ai-grok";
  if (host === "gemini.google.com") return "ai-gemini";
  return null;
}

function compareCursor(a: BrowserCaptureCursor, b: BrowserCaptureCursor): number {
  const time = a.capturedAt.localeCompare(b.capturedAt);
  return time || a.captureId.localeCompare(b.captureId);
}

/** Validate and normalize an extension payload before it reaches the ledger. */
export function normalizeBrowserCapture(input: unknown): BrowserCaptureReceipt | null {
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) return null;
  const data = parsed.data;
  let url: string;
  try {
    url = cleanUrl(data.url);
  } catch {
    return null;
  }
  const inferred = inferSourceId(url);
  if (!inferred || inferred !== data.sourceId) return null;
  const items = data.items.map((item): BrowserCaptureItem => {
    const normalized: BrowserCaptureItem = { kind: item.kind, title: redact(item.title).slice(0, 240) };
    // AI portal receipts are deliberately metadata-only. Enforce that again
    // at the server boundary so a modified or older extension cannot smuggle
    // prompts, responses, or drafts into durable memory.
    if (item.text && !isAiPortalSource(data.sourceId)) {
      normalized.text = redact(item.text).slice(0, 4_000);
    }
    return normalized;
  });
  return {
    schemaVersion: BROWSER_CAPTURE_SCHEMA_VERSION,
    captureId: data.captureId,
    capturedAt: data.capturedAt,
    sourceId: data.sourceId,
    url,
    title: redact(data.title).slice(0, 240),
    items,
    cursor: { capturedAt: data.capturedAt, captureId: data.captureId },
  };
}

/** Persist one validated extension receipt in OpenMaus private app data.
 * Heartbeats overwrite one source-local file; changed receipts retain a
 * bounded twelve-event history for delta readers. */
export function storeBrowserCaptureReceipt(
  input: unknown,
  directory = BROWSER_CAPTURE_DIRECTORY,
): BrowserCaptureReceipt | null {
  const receipt = normalizeBrowserCapture(input);
  if (!receipt) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const heartbeat = receipt.items.length === 0;
  const name = heartbeat
    ? `openmausbot-capture-heartbeat-${receipt.sourceId}.json`
    : `openmausbot-capture-event-${receipt.sourceId}-${receipt.captureId}.json`;
  writeFileAtomic(join(directory, name), JSON.stringify(receipt), { mode: 0o600 });
  if (!heartbeat) {
    const prefix = `openmausbot-capture-event-${receipt.sourceId}-`;
    const events = readdirSync(directory)
      .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(".json"))
      .map((candidate) => ({ candidate, modifiedAt: lstatSync(join(directory, candidate)).mtimeMs }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt || b.candidate.localeCompare(a.candidate));
    for (const stale of events.slice(RETAINED_BROWSER_EVENTS_PER_SOURCE)) {
      try { unlinkSync(join(directory, stale.candidate)); } catch {}
    }
  }
  return receipt;
}

function cursorFrom(value: JsonValue | null | undefined): BrowserCaptureCursor | null {
  const parsed = cursorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Read the extension's private receipt inbox. Files are bounded and
 * validated individually; malformed/oversized files do not advance a cursor.
 */
export function readBrowserCaptureDirectory(
  directory: string,
  previousCursor: JsonValue | null = null,
  sourceId?: BrowserSourceId,
  options: { now?: number; staleAfterMs?: number } = {},
): BrowserCaptureReadResult {
  const cursor = cursorFrom(previousCursor);
  if (!existsSync(directory)) return unseededBrowserSource(sourceId, cursor);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => /^openmausbot-capture-[A-Za-z0-9-]+\.json$/i.test(name));
  } catch (error) {
    return { status: "failed", receipts: [], cursor, error: error instanceof Error ? error.message : String(error) };
  }
  const receipts: BrowserCaptureReceipt[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const path = join(directory, name);
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (metadata.size > 1_000_000) continue;
      const receipt = normalizeBrowserCapture(JSON.parse(readFileSync(path, "utf8")));
      if (!receipt || seen.has(receipt.captureId)) continue;
      if (sourceId !== undefined && receipt.sourceId !== sourceId) continue;
      seen.add(receipt.captureId);
      if (!cursor || compareCursor(receipt.cursor, cursor) > 0) receipts.push(receipt);
    } catch {
      // A partially written download is ignored and retried on the next run.
    }
  }
  receipts.sort((a, b) => compareCursor(a.cursor, b.cursor));
  const nextCursor = receipts.at(-1)?.cursor ?? cursor;
  if (!nextCursor) return unseededBrowserSource(sourceId, cursor);
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  const observedAt = Date.parse(nextCursor.capturedAt);
  const label = sourceId ? BROWSER_SOURCE_LABELS[sourceId] : "Browser source";
  if (!Number.isFinite(observedAt) || observedAt - now > 5 * 60_000) {
    return {
      status: "failed",
      receipts: [],
      cursor,
      error: `${label} browser observation is timestamped in the future; its cursor was not advanced.`,
    };
  }
  if (now - observedAt > staleAfterMs) {
    return {
      status: "failed",
      receipts: [],
      cursor,
      error: `${label} browser observation is stale; no fresh receipt arrived in the last ${Math.round(staleAfterMs / 60_000)} minutes.`,
    };
  }
  const hasItems = receipts.some((receipt) => receipt.items.length > 0);
  return { status: hasItems ? "ok" : "empty", receipts, cursor: nextCursor };
}

export function browserReceiptsToLedgerItems(receipts: BrowserCaptureReceipt[]): BrowserCaptureEvidence[] {
  return receipts.flatMap((receipt) => receipt.items.map((item) => {
    const result: BrowserCaptureEvidence = {
      sourceId: receipt.sourceId,
      title: item.title,
      evidenceRef: `${receipt.url}#capture=${receipt.captureId}`,
    };
    if (item.text) result.text = item.text;
    return result;
  }));
}

/** Convert validated browser receipts into stable memory events for CaptureMemory. */
export function browserReceiptsToMemoryItems(
  receipts: BrowserCaptureReceipt[],
  botId: string,
  sectionId?: string,
  accountId?: string,
): CaptureMemoryItemInput[] {
  return receipts.flatMap((receipt) => {
    const occurredAt = Date.parse(receipt.capturedAt);
    return receipt.items.map((item, index): CaptureMemoryItemInput => ({
      botId,
      ...(sectionId ? { sectionId } : {}),
      sourceId: receipt.sourceId,
      ...(accountId ? { accountId } : {}),
      externalId: `browser:${receipt.sourceId}:${createHash("sha256")
        .update(`${receipt.url}\u001f${item.kind}\u001f${item.title}`, "utf8")
        .digest("hex")}`,
      kind: item.kind,
      title: `${receipt.title} — ${item.title}`.slice(0, 400),
      ...(item.text ? { body: item.text } : {}),
      occurredAt,
      capturedAt: occurredAt,
      sensitivity: BROWSER_SOURCE_SENSITIVITY[receipt.sourceId],
      evidenceRef: `${receipt.url}#capture=${receipt.captureId}`,
      metadata: {
        captureId: receipt.captureId,
        url: receipt.url,
        receiptTitle: receipt.title,
        itemIndex: index,
      },
    }));
  });
}
