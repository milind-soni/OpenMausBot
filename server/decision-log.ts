// The authorization DECISION log: one fleet-wide, append-only NDJSON file
// answering "which tool call was allowed, denied, or carded — by which
// rule, when, for which bot".
//
// The per-thread event log (harness/bus.ts) cannot answer that. It records
// that a request opened and later resolved, but the WHY — a grant waved it
// through, a guard held it, an unattended block overrode a grant that
// would otherwise have fired — exists only for a moment at the fold point
// and is gone by the time the event is on disk. So the fold writes the
// reason down here at the moment it is known, and the human-answer path
// writes a second row when a card comes back.
//
// Same discipline as the event tee: 0600 (rows name tools and command
// lines), through redactSecrets (summaries carry whatever the agent typed,
// credentials included), and fire-and-forget — an audit log must never
// take down the decision it is auditing.
//
// Layout and retention follow the usage ledger: one file per UTC month under
// <data>/decisions/YYYY-MM.ndjson, and a month file is deleted only once the
// whole month is older than the retention window (default 180 days, config
// `decisions.retentionDays` or OMB_DECISION_RETENTION_DAYS), so at least that
// much history is always kept. Older servers wrote one decisions.ndjson that
// rotated to .1 at 4 MB; both are still read, never written, and removed by
// the same window once their last row is older than it.
//
// Deliberately NOT covered: ask_bot peer-approval cards. They never cross
// the runtime bus (peer-approval.ts appends its cards straight to the
// store), so wiring them here would mean a second, parallel tap — a
// separate change if it earns its keep.
import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AutoVerdictSource } from "./auto-approve.ts";
import { redactSecrets } from "./redact.ts";
import { csvCell } from "./usage-ledger.ts";

export type DecisionKind =
  | "auto-approved"
  | "card-shown"
  | "user-approved"
  | "user-denied"
  | "review-would-approve"
  | "review-would-deny";

/** Who or what produced the decision. The AutoVerdictSource values carry
 * straight through from auto-approve.ts; `question` marks cards a rule may
 * never answer, `auto-fallback` a card shown after delivery failed, `routine`
 * a durable chat scheduling proposal, `skill` a staged learned-skill card,
 * `profile` a bot proposed a profile change, `user` the human's answer, and
 * auto-review sources the isolated model reviewer. connector-scope rows
 * come from the connected-app grants verdict: the person pre-decided them
 * by editing a bot's connectorTools, so the call itself needed no card. */
export type DecisionSource =
  | AutoVerdictSource
  | "question"
  | "auto-fallback"
  | "routine"
  | "skill"
  | "profile"
  | "user"
  | "connector-scope"
  | "auto-review"
  | "auto-review-shadow";

/** Who answered a card, for `source: "user"` rows: a signed-in session (its
 * id, device label, and account email or id when it has one; a portal
 * session's id is its membership grant and is never written), the owner on
 * this machine (`loopback`), or a session-less local caller on a shared
 * server (`worker`: the Slack worker, or anything else on that machine). */
export type DecisionActor =
  | { kind: "session"; sessionId: string; label: string; email?: string; userId?: string }
  | { kind: "loopback" }
  | { kind: "worker" };

export interface DecisionRow {
  at: string;
  threadId: string;
  requestId?: string;
  botId?: string;
  botName?: string;
  tool?: string;
  summary?: string;
  decision: DecisionKind;
  source: DecisionSource;
  /** which rule decided: a guard's regex source, or the granted key */
  rule?: string;
  /** the turn ran with nobody at the keyboard when this was decided */
  unattended?: boolean;
  /** who answered, on rows a person's answer produced */
  actor?: DecisionActor;
  /** how the ask reached the fold: a tool call (absent) or a block parsed
   * out of model-authored output ("output", the BoxAgent transport).
   * Question cards only. */
  origin?: "output";
}

const DIR = "decisions";
const LEGACY_FILE = "decisions.ndjson";
const MONTH_FILE = /^(\d{4})-(\d{2})\.ndjson$/;
const DAY_MS = 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
export const DEFAULT_DECISION_RETENTION_DAYS = 180;
export const MAX_DECISION_RETENTION_DAYS = 3650;
const writeQueues = new Map<string, Promise<void>>();
const lastPrune = new Map<string, number>();
let retentionDays: () => number = () => DEFAULT_DECISION_RETENTION_DAYS;

/** The server binds its configured window once; see decisionRetentionDays. */
export function bindDecisionRetention(provider: () => number): void {
  retentionDays = provider;
}

/** The window in force now. The admin activity log (admin-activity.ts)
 * keeps its months for the same time, so one setting covers both. */
export function boundRetentionDays(): number {
  return retentionDays();
}

/** The retention window in days: OMB_DECISION_RETENTION_DAYS when it is a
 * whole number in range, else the configured value, else 180. */
export function decisionRetentionDays(configured: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env.OMB_DECISION_RETENTION_DAYS?.trim();
  const parsed = fromEnv ? Number(fromEnv) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_DECISION_RETENTION_DAYS) return parsed;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= MAX_DECISION_RETENTION_DAYS) return configured;
  return DEFAULT_DECISION_RETENTION_DAYS;
}

const actorScope = new AsyncLocalStorage<DecisionActor>();

/** Run `work` as a person's card answer: every `source: "user"` row it
 * writes names `actor`, without each resolver having to thread it through. */
export function withDecisionActor<T>(actor: DecisionActor, work: () => T): T {
  return actorScope.run(actor, work);
}

function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function decisionFileFor(dataDir: string, at: Date): string {
  return join(dataDir, DIR, `${monthKey(at)}.ndjson`);
}

async function writeDecision(dataDir: string, record: DecisionRow): Promise<void> {
  const at = new Date(record.at);
  await mkdir(join(dataDir, DIR), { recursive: true, mode: 0o700 });
  await appendFile(decisionFileFor(dataDir, at), JSON.stringify(record) + "\n", { mode: 0o600 });
  if (at.getTime() - (lastPrune.get(dataDir) ?? 0) >= PRUNE_EVERY_MS) {
    lastPrune.set(dataDir, at.getTime());
    await pruneDecisions(dataDir, retentionDays(), at);
  }
}

/** Append one decision row. Fire-and-forget, mirroring the event bus tee:
 * the fold that calls this is delivering approvals and cards, and a full
 * disk must not turn into denied tools. */
export function appendDecision(dataDir: string, row: Omit<DecisionRow, "at">): void {
  const actor = row.actor ?? (row.source === "user" ? actorScope.getStore() : undefined);
  // Redact now, not when the queue drains: the row is what was true at the
  // moment of the decision.
  const record = redactSecrets({ at: new Date().toISOString(), ...row, ...(actor ? { actor } : {}) }) as DecisionRow;
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  // Serialize appends (and the occasional prune) per directory, so two
  // simultaneous approvals keep their decision order.
  const queued = previous
    .then(() => writeDecision(dataDir, record))
    .catch(() => {
      /* logging must never take down the fold */
    });
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

/** Test/shutdown seam: wait until every decision already queued for this
 * directory has reached disk. Normal request paths deliberately do not wait. */
export async function flushDecisionLog(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}

/** Delete what the window no longer covers: a month file once the first
 * instant after its month is at or before `now - days`, a legacy file once
 * its last write is. Returns the names removed. Never throws. */
export async function pruneDecisions(dataDir: string, days: number, now = new Date()): Promise<string[]> {
  const cutoff = now.getTime() - days * DAY_MS;
  const removed = await pruneMonthFiles(join(dataDir, DIR), days, now);
  for (const name of [`${LEGACY_FILE}.1`, LEGACY_FILE]) {
    try {
      if ((await stat(join(dataDir, name))).mtimeMs > cutoff) continue;
      await unlink(join(dataDir, name));
      removed.push(name);
    } catch {
      /* absent */
    }
  }
  return removed;
}

/** Delete the `YYYY-MM.ndjson` files in `dir` whose whole month is at or
 * before `now - days`. Returns the names removed. Never throws. Shared with
 * the admin activity log. */
export async function pruneMonthFiles(dir: string, days: number, now = new Date()): Promise<string[]> {
  const cutoff = now.getTime() - days * DAY_MS;
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    /* nothing written in the new layout yet */
  }
  for (const name of names) {
    const match = MONTH_FILE.exec(name);
    if (!match || Date.UTC(Number(match[1]), Number(match[2]), 1) > cutoff) continue;
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch {
      /* already gone, or not ours to remove */
    }
  }
  return removed;
}

const isDecisionRow = (value: unknown): value is DecisionRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DecisionRow).at === "string" &&
  typeof (value as DecisionRow).threadId === "string" &&
  typeof (value as DecisionRow).decision === "string" &&
  typeof (value as DecisionRow).source === "string";

function readRows(path: string): DecisionRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: DecisionRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isDecisionRow(value)) rows.push(value);
    } catch {
      /* a line torn mid-write — skip the fragment, keep the rest */
    }
  }
  return rows;
}

/** Every file that may hold rows, oldest first: the legacy pair (which only
 * ever holds rows older than any month file), then the months in order. */
function sources(dataDir: string): string[] {
  let months: string[] = [];
  try {
    months = readdirSync(join(dataDir, DIR)).filter((name) => MONTH_FILE.test(name)).sort();
  } catch {
    /* no month files yet */
  }
  return [join(dataDir, `${LEGACY_FILE}.1`), join(dataDir, LEGACY_FILE), ...months.map((name) => join(dataDir, DIR, name))];
}

/** The newest `limit` rows, oldest first — the same order the inspector
 * uses for thread events. Reads month files newest first and stops once it
 * has enough, so a long history costs no more than the page asked for. */
export function readDecisions(dataDir: string, limit: number): DecisionRow[] {
  const files = sources(dataDir);
  const chunks: DecisionRow[][] = [];
  let count = 0;
  for (let index = files.length - 1; index >= 0 && count < limit; index -= 1) {
    const rows = readRows(files[index]!);
    chunks.unshift(rows);
    count += rows.length;
  }
  return chunks.flat().slice(-limit);
}

/** Every row whose time falls inside the range, oldest first. */
export function readDecisionRange(dataDir: string, range: { from: Date; to: Date }): DecisionRow[] {
  const from = range.from.getTime();
  const to = range.to.getTime();
  const first = monthKey(range.from);
  const last = monthKey(range.to);
  const rows: DecisionRow[] = [];
  for (const file of sources(dataDir)) {
    // Month files outside the range are skipped unread; legacy files have no month.
    const month = MONTH_FILE.exec(basename(file));
    if (month && (`${month[1]}-${month[2]}` < first || `${month[1]}-${month[2]}` > last)) continue;
    for (const row of readRows(file)) {
      const at = Date.parse(row.at);
      if (at >= from && at <= to) rows.push(row);
    }
  }
  return rows;
}

export function actorLabel(actor: DecisionActor | undefined): string {
  if (!actor) return "";
  if (actor.kind === "loopback") return "This computer";
  if (actor.kind === "worker") return "Local service";
  return actor.email ?? actor.label;
}

/** One line per decision, spreadsheet-ready. Cells go through the usage
 * CSV's formula neutralising, and every row through redaction again, so an
 * export never carries more than the log itself may. */
export function decisionsCsv(rows: DecisionRow[]): string {
  const header = ["time", "decision", "source", "bot", "tool", "summary", "rule", "unattended", "answered_by", "thread", "request"];
  const lines = [header.join(",")];
  for (const raw of rows) {
    const row = redactSecrets(raw) as DecisionRow;
    lines.push([
      row.at,
      row.decision,
      row.source,
      row.botName || row.botId || "",
      row.tool ?? "",
      row.summary ?? "",
      row.rule ?? "",
      row.unattended ? "yes" : "",
      actorLabel(row.actor),
      row.threadId,
      row.requestId ?? "",
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
