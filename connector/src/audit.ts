// The audit log on the server: one JSON line for each job and for each request MausBot's Admin makes to the home, written
// by the connector to /var/log/mausbot/audit.jsonl on the host, root's, for the server's owner to read. It is only ever
// appended to. Each line carries the SHA-256 of the line before it, so a line taken out or changed breaks the chain
// (verifyAudit). It never holds a secret, an environment value or a pairing code.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { Job, JobError, JobErrorCode, JobType, ServerMode } from "./protocol.ts";

/** Who asked: the Admin over the connector's connection, or root on this server through `mausbot-connector job`. */
export type AuditSource = "admin" | "local";

export type AuditEvent =
  | { event: "connector"; what: "started" | "enrolled"; version: string; image: string | null; boxId?: string; mode?: ServerMode }
  /** The server's admin paused or resumed remote management (`mausbot-connector pause`, `resume`). */
  | { event: "management"; what: "paused" | "resumed"; by: "local" }
  | { event: "refused"; by: "admin"; code: JobErrorCode; why: string; id?: string; type?: string }
  | { event: "job"; by: AuditSource; id: string; type: JobType; args: Record<string, unknown> }
  | { event: "result"; by: AuditSource; id: string; type: JobType; ok: true; detail?: Record<string, unknown> }
  | { event: "result"; by: AuditSource; id: string; type: JobType; ok: false; error: JobError }
  | { event: "step"; id: string; type: JobType; step: string; detail?: Record<string, unknown> }
  | {
    event: "request"; by: "admin"; method: string; path: string; status: number; member?: { email: string; role: string; device: string | null };
    /** A customer-run server refused it: it is not on that mode's list, or remote management is paused. */
    refused?: "mode" | "paused";
  };

export type AuditLine = AuditEvent & { seq: number; at: string; prev: string };

const GENESIS = "0".repeat(64);
const TAIL_BYTES = 64 * 1024;

export const lineHash = (line: string) => createHash("sha256").update(line).digest("hex");

/** What a job's arguments say, without a value that could be a secret: an environment's names, a URL's origin. */
export function auditArgs(job: Job): Record<string, unknown> {
  const args = job.args as Record<string, unknown>;
  switch (job.type) {
    case "start":
      return { image: args.image, env: Object.keys((args.env ?? {}) as Record<string, string>).sort() };
    case "import-disk":
      return { from: new URL(String(args.url)).origin };
    default:
      return { ...args };
  }
}

/**
 * A request the Admin sent to the home through the connector. For a pairing it names who it opens a session for and on
 * which device, from the Admin's own claim in the request; never the code the home answers with.
 */
export function auditRequest(method: string, target: string, status: number, body: string | null): Extract<AuditEvent, { event: "request" }> {
  const path = target.split("?")[0]!.slice(0, 200);
  const event: Extract<AuditEvent, { event: "request" }> = { event: "request", by: "admin", method, path, status };
  if (method !== "POST" || path !== "/api/cloud/pairing" || !body) return event;
  try {
    const parsed = JSON.parse(body) as { label?: unknown; member?: { email?: unknown; role?: unknown } };
    const { email, role } = parsed.member ?? {};
    if (typeof email === "string" && typeof role === "string") {
      event.member = { email: email.slice(0, 320), role: role.slice(0, 40), device: typeof parsed.label === "string" ? parsed.label.slice(0, 80) : null };
    }
  } catch {
    // An unreadable body is the home's to refuse; the line still says the request came.
  }
  return event;
}

export class AuditLog {
  readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  /** Appends one line; throws when it cannot, so a job is never run unrecorded. */
  append(event: AuditEvent): AuditLine {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o750 });
    const last = this.lastLine();
    let seq = 1;
    if (last) {
      try { seq = (JSON.parse(last) as { seq?: number }).seq! + 1; } catch { seq = Number.NaN; }
      if (!Number.isInteger(seq)) seq = 1;
    }
    const line: AuditLine = { seq, at: new Date(this.now()).toISOString(), prev: last ? lineHash(last) : GENESIS, ...event };
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return line;
  }

  /** The newest `count` lines, oldest first. */
  tail(count: number): string[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-count);
  }

  /** Reads back only the end of the file: the log grows for as long as the server runs. */
  private lastLine(): string | null {
    if (!existsSync(this.file)) return null;
    const size = statSync(this.file).size;
    if (size === 0) return null;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(this.file, "r");
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    return lines.at(-1) ?? null;
  }
}

/** Checks the chain from the first line: each line's `prev` is the hash of the line before it, and `seq` counts up by one. */
export function verifyAudit(text: string): { ok: true; lines: number } | { ok: false; line: number; why: string } {
  const lines = text.split("\n").filter(Boolean);
  let prev = GENESIS;
  for (const [index, raw] of lines.entries()) {
    let line: Partial<AuditLine>;
    try { line = JSON.parse(raw) as Partial<AuditLine>; } catch { return { ok: false, line: index + 1, why: "not JSON" }; }
    if (line.prev !== prev) return { ok: false, line: index + 1, why: "the line before it was changed or removed" };
    if (line.seq !== index + 1) return { ok: false, line: index + 1, why: `numbered ${line.seq}, expected ${index + 1}` };
    prev = lineHash(raw);
  }
  return { ok: true, lines: lines.length };
}
