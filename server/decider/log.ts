// A row never holds the message text, the options' text or the key. Files are 0600.
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { boundRetentionDays, pruneMonthFiles } from "../decision-log.ts";
import { monthKey } from "../usage-ledger.ts";
import type { DeciderFailure, DeciderProvider, DeciderSeam } from "./types.ts";

export const DECIDER_LOG_DIR = "decider-log";
const PRUNE_EVERY_MS = 60 * 60_000;

export interface DeciderLogRow {
  at: string;
  seam: DeciderSeam;
  provider: DeciderProvider;
  model?: string;
  ok: boolean;
  reason?: DeciderFailure;
  status?: number;
  choice?: string;
  pTop: number | null;
  margin: number | null;
  latencyMs: number;
  inputTokens?: number;
  stateHash: string;
}

const writeQueues = new Map<string, Promise<void>>();
const lastPrune = new Map<string, number>();

export function stateHash(state: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(state) ?? "";
  } catch {
    text = "";
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function deciderLogFileFor(dataDir: string, at: Date): string {
  return join(dataDir, DECIDER_LOG_DIR, `${monthKey(at)}.ndjson`);
}

async function write(dataDir: string, row: DeciderLogRow): Promise<void> {
  const at = new Date(row.at);
  await mkdir(join(dataDir, DECIDER_LOG_DIR), { recursive: true, mode: 0o700 });
  await appendFile(deciderLogFileFor(dataDir, at), JSON.stringify(row) + "\n", { mode: 0o600 });
  if (at.getTime() - (lastPrune.get(dataDir) ?? 0) >= PRUNE_EVERY_MS) {
    lastPrune.set(dataDir, at.getTime());
    await pruneMonthFiles(join(dataDir, DECIDER_LOG_DIR), boundRetentionDays(), at);
  }
}

/** Never throws and never waits: a full disk must not slow or fail a room turn. */
export function appendDeciderLog(dataDir: string, row: DeciderLogRow): void {
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  const queued = previous.then(() => write(dataDir, row)).catch(() => {
  });
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

export async function flushDeciderLog(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}
