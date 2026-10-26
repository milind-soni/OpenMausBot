import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DETECTORS } from "./detectors/index.ts";
import { readQueueRecords, readThreadOwners, readToolRecords, readTurnRecords } from "./sources.ts";
import { markCounted, pruneSeen, readIssues, readState, upsertIssues, writeSentinelFiles } from "./store.ts";
import type { DetectorConfig, Issue, Observation, SentinelRecord } from "./types.ts";

export const DEFAULT_QUEUE_WAIT_MS = 300_000;
export const DEFAULT_COST_USD = 5;
/** Activity rows are rewritten when their tool finishes; reread this much. */
export const RESCAN_WINDOW_MS = 30 * 60_000;
export const FIRST_SCAN_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export interface ScanOptions {
  dataDir: string;
  out: string;
  now?: number;
  queueWaitMs?: number;
  costUsd?: number;
  retryLoopMin?: number;
}

export interface ScanSummary {
  scanned: boolean;
  at: number;
  records: { tool: number; turn: number; queue: number };
  added: number;
  touched: Issue[];
  totalIssues: number;
}

export function runScan(options: ScanOptions): ScanSummary {
  const now = options.now ?? Date.now();
  const config: DetectorConfig = {
    queueWaitMs: options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS,
    costUsd: options.costUsd ?? DEFAULT_COST_USD,
    retryLoopMin: options.retryLoopMin ?? 3,
    now,
  };
  const state = readState(options.out);
  const fingerprint = sourceFingerprint(options.dataDir, config);
  if (state.fingerprint === fingerprint && state.lastScanAt !== null && (state.queueDueAt === null || now <= state.queueDueAt)) {
    return { scanned: false, at: now, records: { tool: 0, turn: 0, queue: 0 }, added: 0, touched: [], totalIssues: readIssues(options.out).size };
  }
  const sinceAt = state.lastScanAt === null ? now - FIRST_SCAN_LOOKBACK_MS : state.lastScanAt - RESCAN_WINDOW_MS;
  const who = readThreadOwners(options.dataDir);
  const tools = readToolRecords(options.dataDir, sinceAt, who);
  const turns = readTurnRecords(options.dataDir, state.logs, who);
  const queue = readQueueRecords(options.dataDir, sinceAt, now, who);
  const records: SentinelRecord[] = [...tools, ...turns.records, ...queue];
  const issues = readIssues(options.out);
  // A fresh state beside existing issues restarts its cursors: only what follows the newest counted occurrence is new.
  const counted = state.lastScanAt === null && issues.size ? Math.max(...[...issues.values()].map((issue) => issue.lastAt)) : -Infinity;
  const detected: Observation[] = DETECTORS.flatMap((detector) => detector.detect(records, config));
  markCounted(state, detected.filter((o) => o.at <= counted));
  const { touched, added } = upsertIssues(issues, state, detected.filter((o) => o.at > counted));
  state.logs = turns.offsets;
  state.lastScanAt = now;
  state.fingerprint = fingerprint;
  state.queueDueAt = nextQueueDue(queue, config.queueWaitMs);
  pruneSeen(state, Math.min(sinceAt, now - RESCAN_WINDOW_MS));
  writeSentinelFiles(options.out, issues, state);
  return {
    scanned: true,
    at: now,
    records: { tool: tools.length, turn: turns.records.length, queue: queue.length },
    added,
    touched: [...touched].map((sig) => issues.get(sig)!).sort((a, b) => b.lastAt - a.lastAt),
    totalIssues: issues.size,
  };
}

function nextQueueDue(records: readonly SentinelRecord[], queueWaitMs: number): number | null {
  let due: number | null = null;
  for (const record of records) {
    if (record.type !== "queue" || record.started || record.waitMs > queueWaitMs) continue;
    const at = record.at - record.waitMs + queueWaitMs;
    due = due === null ? at : Math.min(due, at);
  }
  return due;
}

export function sourceFingerprint(dataDir: string, config: Omit<DetectorConfig, "now">): string {
  const parts: string[] = [JSON.stringify([config.queueWaitMs, config.costUsd, config.retryLoopMin])];
  const add = (path: string, label: string) => {
    try {
      const stat = statSync(path);
      parts.push(`${label}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${label}:-`);
    }
  };
  for (const name of ["messages.db", "messages.db-wal", "runtime.db", "runtime.db-wal", "bots.json"]) add(join(dataDir, name), name);
  let logs: string[] = [];
  try {
    logs = readdirSync(join(dataDir, "events")).filter((name) => name.endsWith(".ndjson")).sort();
  } catch {}
  for (const name of logs) add(join(dataDir, "events", name), `events/${name}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
