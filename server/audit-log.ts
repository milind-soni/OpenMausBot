// The HUMAN-action audit log: one fleet-wide, append-only NDJSON file
// answering "who did what to the roster, and when" — a person created,
// disabled or removed; a role changed; a pairing code minted; a device
// revoked.
//
// decision-log.ts answers the other question ("which tool call was allowed
// and by which rule") and is deliberately not reused: its rows are keyed by
// thread and bot, these by actor and target, and an admin panel that can
// disable accounts with no record of who did it is a liability.
//
// Same discipline as that log: 0600, fire-and-forget through a per-directory
// queue so rotation and ordering hold, and never a reason to fail the action
// it records.
import { readFileSync } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export type AuditAction =
  | "user.create"
  | "user.update"
  | "user.disable"
  | "user.enable"
  | "user.remove"
  | "pairing.mint"
  | "pairing.cancel"
  | "session.revoke"
  | "role.create"
  | "role.update"
  | "role.remove";

/** Who did it: a person (through a bound device), the machine's owner over
 * loopback, or a device paired before accounts existed. */
export interface AuditActor {
  kind: "user" | "loopback" | "device";
  userId?: string;
  userName?: string;
  sessionId?: string;
  /** The forwarded source or peer address, for correlating with a proxy log. */
  source?: string;
}

export interface AuditRow {
  at: string;
  action: AuditAction;
  actor: AuditActor;
  /** The user, session, pairing or role acted on. */
  target?: { kind: "user" | "session" | "pairing" | "role"; id: string; name?: string };
  /** What changed, for update actions: field → new value. Never a secret. */
  changes?: Record<string, string | number | boolean | null>;
  /** Side effects worth a row of their own would be noise; count them here. */
  effects?: { revokedSessions?: number; cancelledPairings?: number };
}

const FILE_NAME = "audit.ndjson";
const MAX_BYTES = 4 * 1024 * 1024;
const writeQueues = new Map<string, Promise<void>>();

async function writeRow(dataDir: string, row: Omit<AuditRow, "at">, maxBytes: number): Promise<void> {
  const file = join(dataDir, FILE_NAME);
  try {
    if ((await stat(file)).size >= maxBytes) await rename(file, `${file}.1`);
  } catch {
    /* no live file yet — nothing to rotate */
  }
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 });
}

export function appendAudit(dataDir: string, row: Omit<AuditRow, "at">, opts?: { maxBytes?: number }): void {
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  const queued = previous
    .then(() => writeRow(dataDir, row, opts?.maxBytes ?? MAX_BYTES))
    .catch(() => {
      /* an audit log must never take down the action it audits */
    });
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

/** Test/shutdown seam. */
export async function flushAuditLog(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}

const isAuditRow = (value: unknown): value is AuditRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AuditRow).at === "string" &&
  typeof (value as AuditRow).action === "string" &&
  typeof (value as AuditRow).actor === "object";

/** The newest `limit` rows, oldest first. Reads `.1` before the live file
 * so a request right after a rotation still sees history. */
export function readAudit(dataDir: string, limit: number, filter?: { userId?: string }): AuditRow[] {
  const file = join(dataDir, FILE_NAME);
  const rows: AuditRow[] = [];
  for (const path of [`${file}.1`, file]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isAuditRow(parsed)) continue;
        if (filter?.userId && parsed.actor.userId !== filter.userId && parsed.target?.id !== filter.userId) continue;
        rows.push(parsed);
      } catch {
        /* a torn last line after a crash: skip it */
      }
    }
  }
  return rows.slice(-limit);
}
