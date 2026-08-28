// What a bot actually DID, per bot.
//
// decision-log.ts answers "was this allowed, by which rule" fleet-wide.
// That is the authorization record and it stays exactly as it is. This is
// the activity record: one append-only NDJSON file per bot, folded out of
// the event stream the bus already tees, so nothing new is captured — it is
// only projected somewhere a person can read it per BOT instead of per
// thread. A bot works across many threads; "what has this one been doing"
// is not a question the per-thread event logs can answer.
//
// Same discipline as the decision log: 0600 (rows name tools and command
// lines), through redactSecrets (a tool title carries whatever the agent
// typed, credentials included), and fire-and-forget — an activity log must
// never take down the turn it is recording.
import { readFileSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeEvent } from "./contracts.ts";
import { redactSecrets } from "./redact.ts";

/** One rotation, then the old file is overwritten by the next. A bot that
 * has done four megabytes of things has a long enough memory. */
export const MAX_AUDIT_BYTES = 4_000_000;

export interface ActionRow {
  ts: string;
  botId: string;
  threadId: string;
  turnId?: string;
  type: "tool_call";
  name: string;
}

export function auditPath(dataDir: string, botId: string): string {
  return join(dataDir, "audit", `${botId}.jsonl`);
}

/** The projection. Only what the bot DID: a started tool call is an action,
 * thinking is not, and a stream delta is not. `item.completed` is
 * deliberately not folded in — it carries no title, so a row built from it
 * would be nameless, and correlating the two by itemId would mean holding
 * per-turn state for a ledger that does not need it. */
export function actionFromEvent(event: RuntimeEvent, botId: string): Omit<ActionRow, "ts"> | null {
  if (event.type !== "item.started" || event.itemType !== "tool") return null;
  const name = event.title?.trim();
  if (!name) return null;
  const row: Omit<ActionRow, "ts"> = {
    botId,
    threadId: event.threadId,
    type: "tool_call",
    name,
  };
  if (event.turnId) row.turnId = event.turnId;
  return row;
}

async function writeAction(dataDir: string, row: Omit<ActionRow, "ts">): Promise<void> {
  const line = `${JSON.stringify(redactSecrets({ ts: new Date().toISOString(), ...row }))}\n`;
  const path = auditPath(dataDir, row.botId);
  await mkdir(join(dataDir, "audit"), { recursive: true, mode: 0o700 });
  const size = await stat(path).then((stats) => stats.size).catch(() => 0);
  if (size > MAX_AUDIT_BYTES) await rename(path, `${path}.1`).catch(() => {});
  await appendFile(path, line, { mode: 0o600 });
}

/** Per-bot write queues, the same discipline decision-log.ts uses: without
 * one, two tool calls landing in the same tick can both rotate, overwrite
 * .1, or append out of the order they happened in — and a ledger whose rows
 * are out of order is worse than no ledger. Keyed per bot, so a busy bot
 * never serializes behind a different one. */
const writeQueues = new Map<string, Promise<void>>();

export function appendAction(dataDir: string, row: Omit<ActionRow, "ts">): void {
  const key = `${dataDir}\u0000${row.botId}`;
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const queued = previous.then(() => writeAction(dataDir, row)).catch(() => {
    /* an activity log must never take down a turn */
  });
  writeQueues.set(key, queued);
  void queued.finally(() => {
    if (writeQueues.get(key) === queued) writeQueues.delete(key);
  });
}

/** Test/shutdown seam: wait until every action already queued for this bot
 * has reached disk. Normal turn paths deliberately do not wait. */
export async function flushActionAudit(dataDir: string, botId: string): Promise<void> {
  await writeQueues.get(`${dataDir}\u0000${botId}`);
}

export function readActions(dataDir: string, botId: string, limit: number): ActionRow[] {
  let raw: string;
  try {
    raw = readFileSync(auditPath(dataDir, botId), "utf8");
  } catch {
    return [];
  }
  const rows: ActionRow[] = [];
  for (const line of raw.split("\n").filter(Boolean).slice(-limit)) {
    try {
      // SAFETY: every line in this file was written by writeAction from an
      // ActionRow. A line that is not one (a torn write) throws in JSON.parse
      // or lands as a partial row the UI renders as blanks — neither is worth
      // re-validating a log we ourselves wrote.
      rows.push(JSON.parse(line) as ActionRow);
    } catch {
      // a torn final line is not a reason to lose the rest of the file
    }
  }
  return rows.reverse();
}
