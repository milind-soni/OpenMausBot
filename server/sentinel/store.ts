// The only files Sentinel writes, both owner-only; issues hold ids into the data dir, never tool output or message text.
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import type { LogOffset } from "./sources.ts";
import type { Issue, Observation } from "./types.ts";

export const ISSUES_FILE = "issues.jsonl";
export const STATE_FILE = "state.json";

/** Bump when state.json changes shape: another version's state is dropped and the next scan starts over. */
export const STATE_VERSION = 2;

export interface SentinelState {
  version: typeof STATE_VERSION;
  lastScanAt: number | null;
  /** What the sources looked like at the last scan; equal means nothing to do until queueDueAt. */
  fingerprint: string | null;
  /** When the earliest wait still pending at the last scan crosses the queue-wait threshold, with no file changing. */
  queueDueAt: number | null;
  logs: Record<string, LogOffset>;
  /** Kept only while a later scan could still see the same occurrence again. */
  seen: Record<string, number>;
}

export function emptyState(): SentinelState {
  return { version: STATE_VERSION, lastScanAt: null, fingerprint: null, queueDueAt: null, logs: {}, seen: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readState(out: string): SentinelState {
  try {
    const parsed = JSON.parse(readFileSync(join(out, STATE_FILE), "utf8")) as Partial<SentinelState>;
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return emptyState();
    // a damaged field starts the whole state over rather than failing every scan
    if (!isRecord(parsed.logs) || !isRecord(parsed.seen)) return emptyState();
    if (parsed.lastScanAt !== null && !(typeof parsed.lastScanAt === "number" && Number.isFinite(parsed.lastScanAt))) return emptyState();
    if (typeof parsed.fingerprint !== "string" && parsed.fingerprint !== null) return emptyState();
    if (parsed.queueDueAt !== undefined && parsed.queueDueAt !== null && !Number.isFinite(parsed.queueDueAt)) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export function readIssues(out: string): Map<string, Issue> {
  const issues = new Map<string, Issue>();
  let text: string;
  try {
    text = readFileSync(join(out, ISSUES_FILE), "utf8");
  } catch {
    return issues;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const issue = JSON.parse(line) as Issue;
      if (typeof issue?.sig === "string") issues.set(issue.sig, issue);
    } catch {
      // a damaged line costs that one issue, not the file
    }
  }
  return issues;
}

function recordSeen(state: SentinelState, observation: Observation): number | undefined {
  const key = `${observation.kind}:${observation.occurrence}`;
  const previous = state.seen[key];
  state.seen[key] = Math.max(previous ?? 0, observation.at);
  return previous;
}

export function markCounted(state: SentinelState, observations: readonly Observation[]): void {
  for (const observation of observations) recordSeen(state, observation);
}

/** Idempotent: running the same observations twice changes nothing the second time. */
export function upsertIssues(issues: Map<string, Issue>, state: SentinelState, observations: readonly Observation[]): { touched: Set<string>; added: number } {
  const touched = new Set<string>();
  let added = 0;
  for (const observation of observations) {
    if (recordSeen(state, observation) !== undefined) continue;
    added += 1;
    const issue = issues.get(observation.signature) ?? {
      sig: observation.signature,
      kind: observation.kind,
      title: observation.title,
      origin: observation.origin,
      severity: observation.severity,
      firstAt: observation.at,
      lastAt: observation.at,
      count: 0,
      wastedTurns: 0,
      evidenceRef: observation.evidence,
    };
    issue.count += 1;
    issue.firstAt = Math.min(issue.firstAt, observation.at);
    if (observation.at >= issue.lastAt || issue.count === 1) {
      issue.lastAt = observation.at;
      issue.title = observation.title;
      issue.evidenceRef = observation.evidence;
      for (const field of ["tool", "botId", "threadId", "turnId"] as const) {
        if (observation[field] !== undefined) issue[field] = observation[field];
        else delete issue[field];
      }
    }
    if (observation.turnId) {
      const turnKey = `turn:${observation.signature}:${observation.turnId}`;
      if (state.seen[turnKey] === undefined) issue.wastedTurns += 1;
      state.seen[turnKey] = Math.max(state.seen[turnKey] ?? 0, observation.at);
    }
    issues.set(issue.sig, issue);
    touched.add(issue.sig);
  }
  return { touched, added };
}

export function pruneSeen(state: SentinelState, before: number): void {
  for (const [key, at] of Object.entries(state.seen)) if (at < before) delete state.seen[key];
}

export function writeSentinelFiles(out: string, issues: Map<string, Issue>, state: SentinelState): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  try {
    chmodSync(out, 0o700);
  } catch {}
  const lines = [...issues.values()].sort((a, b) => b.lastAt - a.lastAt).map((issue) => JSON.stringify(issue));
  writeFileAtomic(join(out, ISSUES_FILE), lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  writeFileAtomic(join(out, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600, durable: false });
}
