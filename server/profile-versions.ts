// Per-bot profile history: an append-only NDJSON file in the bot folder,
// one row per changed field. Same discipline as decision-log.ts — 0600,
// through redactSecrets, serialized per file, fire-and-forget — because a
// history write must never fail the change it records. Full before/after
// text is kept only for the soul; redacted versions cannot be restored
// exactly and are not rollback targets. Other fields keep short one-liners.
import { appendFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { PROFILE_REQUEST_FIELDS, type ProfileRequestChanges } from "../shared/profile-request.ts";
import { botFolder } from "./bot-folder.ts";
import { redactSecrets } from "./redact.ts";

export type HistoryActor = "user" | "bot" | "file" | "import" | "system";

export interface HistoryRow {
  id: string;
  at: number;
  actor: HistoryActor;
  /** "ui", "api", `card:<messageId>`, "migration", "rollback" */
  via: string;
  field: string;
  summary: string;
  before?: string;
  after?: string;
  /** False when the saved before-text cannot be restored exactly. */
  canRestore?: boolean;
  restoreUnavailableReason?: string;
}

const FILE_NAME = "history.ndjson";
const ONE_LINER = 200;
const MAX_HISTORY_READ_BYTES = 8 * 1024 * 1024;
const writeQueues = new Map<string, Promise<void>>();

export function historyFile(botId: string): string {
  return join(botFolder(botId), FILE_NAME);
}

function oneLiner(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, ONE_LINER);
}

function rowFor(field: string, at: number, actor: HistoryActor, via: string, before: string, after: string): HistoryRow {
  if (field === "soul") {
    const b = Buffer.byteLength(before, "utf8");
    const a = Buffer.byteLength(after, "utf8");
    return { id: randomUUID(), at, actor, via, field, summary: `soul: ${b} → ${a} bytes`, before, after };
  }
  const b = oneLiner(before);
  const a = oneLiner(after);
  return { id: randomUUID(), at, actor, via, field, summary: `${field}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`, before: b, after: a };
}

function withRestoreEligibility(row: HistoryRow): HistoryRow {
  const redacted = redactSecrets(row) as HistoryRow;
  const canRestore = row.field === "soul" && typeof row.before === "string" &&
    row.canRestore !== false && row.before === redacted.before &&
    !/«redacted \d+ chars»/.test(row.before);
  return {
    ...redacted,
    canRestore,
    restoreUnavailableReason: row.field === "soul" && !canRestore
      ? "This version is missing exact text or contains redacted sensitive text and cannot be restored."
      : undefined,
  };
}

async function writeRows(botId: string, rows: HistoryRow[]): Promise<void> {
  // A bot's folder is created when the bot is (writeSoulMirror on bot
  // creation), so a real change always finds it there. If it is gone, the
  // bot was deleted between the change firing and this write landing —
  // skip rather than recreate a folder for a bot that no longer exists.
  if (!existsSync(botFolder(botId))) return;
  const file = historyFile(botId);
  mkdirSync(botFolder(botId), { recursive: true, mode: 0o700 });
  const text = rows.map((row) => JSON.stringify(withRestoreEligibility(row))).join("\n") + "\n";
  await appendFile(file, text, { mode: 0o600 });
}

/** Record every field that differs between `before` and `after`. */
export function recordProfileChange(
  botId: string,
  actor: HistoryActor,
  via: string,
  before: ProfileRequestChanges,
  after: ProfileRequestChanges,
): void {
  const at = Date.now();
  const rows: HistoryRow[] = [];
  for (const field of PROFILE_REQUEST_FIELDS) {
    const b = before[field] ?? "";
    const a = after[field] ?? "";
    if (b !== a) rows.push(rowFor(field, at, actor, via, b, a));
  }
  if (!rows.length) return;
  const previous = writeQueues.get(botId) ?? Promise.resolve();
  const queued = previous.then(() => writeRows(botId, rows)).catch(() => {
    /* history must never take down the change it records */
  });
  writeQueues.set(botId, queued);
  void queued.finally(() => {
    if (writeQueues.get(botId) === queued) writeQueues.delete(botId);
  });
}

/** Test/shutdown seam. */
export async function flushProfileHistory(botId: string): Promise<void> {
  await writeQueues.get(botId);
}

/** Shutdown seam for every bot at once: awaits whatever is currently
 * queued, so a history write in flight when the process stops still lands
 * before it exits. Each queued promise already swallows its own error
 * (`writeRows` must never take down the change it records), so this never
 * rejects either. */
export async function flushAllProfileHistory(): Promise<void> {
  await Promise.allSettled(writeQueues.values());
}

const isRow = (value: unknown): value is HistoryRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as HistoryRow).at === "number" &&
  typeof (value as HistoryRow).field === "string" &&
  typeof (value as HistoryRow).actor === "string";

/** Newest first, bounded to 500 rows from the newest 8 MiB. The append-only
 * log keeps older changes without making every settings read load them. */
export function readHistory(botId: string, limit = 100): HistoryRow[] {
  let text: string;
  let offset: number;
  let end: number;
  try {
    const fd = openSync(historyFile(botId), "r");
    try {
      const size = fstatSync(fd).size;
      offset = Math.max(0, size - MAX_HISTORY_READ_BYTES);
      const buffer = Buffer.alloc(size - offset);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, offset + length);
        if (!count) break;
        length += count;
      }
      end = offset + length;
      text = buffer.subarray(0, length).toString("utf8");
    } finally { closeSync(fd); }
  } catch {
    return [];
  }
  const rows: HistoryRow[] = [];
  const lines = text.split("\n");
  const maxRows = Math.min(500, Math.max(1, limit));
  for (let index = lines.length - 1; index >= (offset > 0 ? 1 : 0) && rows.length < maxRows; index--) {
    const line = lines[index];
    end -= Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRow(value)) {
        // Old logs had only millisecond timestamps (not unique). Their
        // append-only byte position gives each legacy entry a stable id,
        // even as the bounded read window moves after later appends.
        const id = typeof value.id === "string" && value.id
          ? value.id
          : `legacy-${createHash("sha256").update(`${end}:${line}`).digest("hex")}`;
        // Recheck old logs too: they predate eligibility metadata and may
        // already contain irreversible redaction markers in the before-text.
        rows.push(withRestoreEligibility({ ...value, id }));
      }
    } catch {
      /* torn line — skip */
    }
  }
  return rows;
}
