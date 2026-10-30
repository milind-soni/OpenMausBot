// The authorization decision log: one fleet-wide, append-only NDJSON file per UTC month (<data>/decisions/YYYY-MM.ndjson)
// recording why a tool call was allowed, denied or carded. 0600 and redacted (rows carry what the agent typed, credentials
// included), and fire-and-forget: an audit log must never take down the decision it audits. ask_bot peer-approval cards are not covered.
import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AutoVerdictSource } from "./auto-approve.ts";
import { redactSecrets } from "./redact.ts";
import { csvCell, monthKey } from "./usage-ledger.ts";

/** auto-* rows came from a policy with no card in front of a person; user-* rows record what a person answered. */
export type DecisionKind =
  | "auto-approved"
  | "auto-denied"
  | "card-shown"
  | "user-approved"
  | "user-denied"
  | "user-undone"
  | "review-would-approve"
  | "review-would-deny";

/** `level`: a bot's change applied below Full access with no card; `self`: a bot's own routine applied that way (older rows
 * use it for every own change); `question`: cards a rule may never answer; `auto-fallback`: a card shown after delivery
 * failed; connector-scope: the person pre-decided it by editing a bot's connectorTools. */
export type DecisionSource =
  | AutoVerdictSource
  | "level"
  | "self"
  | "question"
  | "auto-fallback"
  | "routine"
  | "skill"
  | "profile"
  | "model"
  | "user"
  | "connector-scope"
  | "outbound"
  | "team-memory"
  | "auto-review"
  | "auto-review-shadow";

/** Who answered a card: a signed-in session (a portal session's id is its membership grant and is never written), `loopback`, or `worker`. */
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
  actor?: DecisionActor;
  /** How that person answered when it was not a tap: by voice on a Live call, or a 👍 or 👎 on the card */
  via?: DecisionVia;
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

export function bindDecisionRetention(provider: () => number): void {
  retentionDays = provider;
}

export function boundRetentionDays(): number {
  return retentionDays();
}

export function decisionRetentionDays(configured: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env.OMB_DECISION_RETENTION_DAYS?.trim();
  const parsed = fromEnv ? Number(fromEnv) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_DECISION_RETENTION_DAYS) return parsed;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= MAX_DECISION_RETENTION_DAYS) return configured;
  return DEFAULT_DECISION_RETENTION_DAYS;
}

export type DecisionVia = "call" | "reaction";
const actorScope = new AsyncLocalStorage<{ actor: DecisionActor; via?: DecisionVia }>();

export function withDecisionActor<T>(actor: DecisionActor, work: () => T, via?: DecisionVia): T {
  return actorScope.run(via ? { actor, via } : { actor }, work);
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

/** A full disk must not turn into denied tools. */
export function appendDecision(dataDir: string, row: Omit<DecisionRow, "at">): void {
  const scope = row.source === "user" ? actorScope.getStore() : undefined;
  const actor = row.actor ?? scope?.actor;
  const via = row.via ?? scope?.via;
  // Redact now: the row records what was true at the moment of the decision.
  const record = redactSecrets({ at: new Date().toISOString(), ...row, ...(actor ? { actor } : {}), ...(via ? { via } : {}) }) as DecisionRow;
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  // Appends serialize per directory, so simultaneous approvals keep their order.
  const queued = previous
    .then(() => writeDecision(dataDir, record))
    .catch(() => {
    });
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

export async function flushDecisionLog(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}

/** Deletes month and legacy files the window no longer covers; never throws. */
export async function pruneDecisions(dataDir: string, days: number, now = new Date()): Promise<string[]> {
  const cutoff = now.getTime() - days * DAY_MS;
  const removed = await pruneMonthFiles(join(dataDir, DIR), days, now);
  for (const name of [`${LEGACY_FILE}.1`, LEGACY_FILE]) {
    try {
      if ((await stat(join(dataDir, name))).mtimeMs > cutoff) continue;
      await unlink(join(dataDir, name));
      removed.push(name);
    } catch {
    }
  }
  return removed;
}

export async function pruneMonthFiles(dir: string, days: number, now = new Date()): Promise<string[]> {
  const cutoff = now.getTime() - days * DAY_MS;
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
  }
  for (const name of names) {
    const match = MONTH_FILE.exec(name);
    if (!match || Date.UTC(Number(match[1]), Number(match[2]), 1) > cutoff) continue;
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch {
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
    }
  }
  return rows;
}

function sources(dataDir: string): string[] {
  let months: string[] = [];
  try {
    months = readdirSync(join(dataDir, DIR)).filter((name) => MONTH_FILE.test(name)).sort();
  } catch {
  }
  return [join(dataDir, `${LEGACY_FILE}.1`), join(dataDir, LEGACY_FILE), ...months.map((name) => join(dataDir, DIR, name))];
}

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

export function readDecisionRange(dataDir: string, range: { from: Date; to: Date }): DecisionRow[] {
  const from = range.from.getTime();
  const to = range.to.getTime();
  const first = monthKey(range.from);
  const last = monthKey(range.to);
  const rows: DecisionRow[] = [];
  for (const file of sources(dataDir)) {
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

/** Cells are formula-neutralised and every row redacted again, so an export never carries more than the log itself. */
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
      row.via ? `${actorLabel(row.actor)} (${row.via === "call" ? "by voice" : "by reaction"})` : actorLabel(row.actor),
      row.threadId,
      row.requestId ?? "",
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
