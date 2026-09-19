// Measurement (docs/plans/2026-09-14-phase-0-foundation.md, item 0.6).
//
// The ledger already books what every turn cost. This module turns those
// rows — plus three optional fields the fold now records per turn (prompt
// shape, evidence coverage, duration) — into the numbers the plan asks to
// watch from day one: tokens per TASK (not per request), the share of input
// the provider served from cache, how often the stable half of the prompt
// changed between turns (each change is a cache miss and, on Claude, a
// respawn), how often a context had to be rebuilt by replay, and how good
// the tool evidence behind the digests is. Everything is per bot, per engine
// and per trigger, because the standing rule is that a regression on one
// engine must be visible. Pure functions; the route and the fold wire them.
import type { PromptSection } from "./system-prompt.ts";
import { VOLATILE_SECTIONS } from "./system-prompt.ts";
import type { UsageRow, UsageTrigger } from "./usage-ledger.ts";

export interface PromptShape {
  sections: Array<{ id: string; bytes: number }>;
  stableBytes: number;
  volatileBytes: number;
  totalBytes: number;
  /** True when the harness rebuilt the context from its own transcript
   * (rewind, engine switch, external update, resume rejection). */
  replayed: boolean;
  replayBytes: number;
  /** Stable sections whose size differs from the previous turn on this
   * thread: each one is a changed prefix, so a cache miss. */
  stableChanged?: string[];
}

export function promptShape(
  sections: readonly Pick<PromptSection, "id" | "bytes">[],
  opts: { replayed: boolean; replayBytes: number },
): PromptShape {
  let stableBytes = 0;
  let volatileBytes = 0;
  for (const section of sections) {
    if (VOLATILE_SECTIONS.has(section.id)) volatileBytes += section.bytes;
    else stableBytes += section.bytes;
  }
  return {
    sections: sections.map((section) => ({ id: section.id, bytes: section.bytes })),
    stableBytes,
    volatileBytes,
    totalBytes: stableBytes + volatileBytes,
    replayed: opts.replayed,
    replayBytes: opts.replayed ? opts.replayBytes : 0,
  };
}

export function stableSectionChanges(
  previous: readonly { id: string; bytes: number }[] | undefined,
  next: readonly { id: string; bytes: number }[],
): string[] {
  if (!previous) return [];
  const before = new Map(previous.map((s) => [s.id, s.bytes]));
  const after = new Map(next.map((s) => [s.id, s.bytes]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const id of ids) {
    if (VOLATILE_SECTIONS.has(id)) continue;
    if ((before.get(id) ?? 0) !== (after.get(id) ?? 0)) changed.push(id);
  }
  return changed;
}

export interface CacheHitShare {
  /** cachedInput / input over the rows that report cachedInput; null when none do. */
  share: number | null;
  reported: number;
  turns: number;
}

export function cacheHitShare(rows: readonly UsageRow[]): CacheHitShare {
  let input = 0;
  let cached = 0;
  let reported = 0;
  for (const row of rows) {
    if (typeof row.cachedInput !== "number") continue;
    reported += 1;
    input += row.input;
    cached += row.cachedInput;
  }
  return { share: reported && input > 0 ? round(cached / input) : null, reported, turns: rows.length };
}

export interface MetricsGroup {
  turns: number;
  /** Distinct threads: a task in the harness's own vocabulary. */
  tasks: number;
  input: number;
  output: number;
  tokensPerTurn: number;
  tokensPerTask: number;
  cacheHitShare: CacheHitShare;
  /** Turns whose stable prompt sections differed from the previous turn. */
  stablePrefixChanges: number;
  /** Turns whose context the harness rebuilt by replay. */
  replays: number;
  coverage: { full: number; preview: number; none: number };
  /** Average stable/volatile prompt bytes over turns that recorded a shape. */
  promptBytes: { stable: number; volatile: number; turns: number };
  durationMs: { average: number; turns: number };
  /** Shell commands the PreToolUse filter rewrote (item 0.2, step 9). */
  filteredCommands: number;
  /** Turns that followed a harness compaction of their thread (Phase 1). */
  compactions: number;
}

export interface MetricsSummary {
  bots: Array<MetricsGroup & { botId: string; botName: string }>;
  engines: Array<MetricsGroup & { driverKind: string }>;
  triggers: Array<MetricsGroup & { kind: UsageTrigger["kind"] }>;
  total: MetricsGroup;
}

function group(rows: readonly UsageRow[]): MetricsGroup {
  const threads = new Set<string>();
  let input = 0;
  let output = 0;
  let stablePrefixChanges = 0;
  let replays = 0;
  const coverage = { full: 0, preview: 0, none: 0 };
  let stableBytes = 0;
  let volatileBytes = 0;
  let shaped = 0;
  let duration = 0;
  let timed = 0;
  let filteredCommands = 0;
  let compactions = 0;
  for (const row of rows) {
    filteredCommands += row.filteredCommands ?? 0;
    if (row.compacted) compactions += 1;
    threads.add(row.threadId);
    input += row.input;
    output += row.output;
    if (row.promptShape) {
      shaped += 1;
      stableBytes += row.promptShape.stableBytes;
      volatileBytes += row.promptShape.volatileBytes;
      if (row.promptShape.replayed) replays += 1;
      if (row.promptShape.stableChanged?.length) stablePrefixChanges += 1;
    }
    if (row.hookCoverage && row.hookCoverage in coverage) coverage[row.hookCoverage] += 1;
    if (typeof row.durationMs === "number") {
      timed += 1;
      duration += row.durationMs;
    }
  }
  const tokens = input + output;
  return {
    turns: rows.length,
    tasks: threads.size,
    input,
    output,
    tokensPerTurn: rows.length ? Math.round(tokens / rows.length) : 0,
    tokensPerTask: threads.size ? Math.round(tokens / threads.size) : 0,
    cacheHitShare: cacheHitShare(rows),
    stablePrefixChanges,
    replays,
    coverage,
    promptBytes: { stable: shaped ? Math.round(stableBytes / shaped) : 0, volatile: shaped ? Math.round(volatileBytes / shaped) : 0, turns: shaped },
    durationMs: { average: timed ? Math.round(duration / timed) : 0, turns: timed },
    filteredCommands,
    compactions,
  };
}

export function summarizeMetrics(rows: readonly UsageRow[]): MetricsSummary {
  const byBot = new Map<string, UsageRow[]>();
  const byEngine = new Map<string, UsageRow[]>();
  const byTrigger = new Map<UsageTrigger["kind"], UsageRow[]>();
  for (const row of rows) {
    push(byBot, row.botId, row);
    push(byEngine, row.driverKind, row);
    push(byTrigger, row.trigger.kind, row);
  }
  return {
    bots: [...byBot].map(([botId, botRows]) => ({ botId, botName: botRows[0]!.botName, ...group(botRows) })),
    engines: [...byEngine].map(([driverKind, engineRows]) => ({ driverKind, ...group(engineRows) })),
    triggers: [...byTrigger].map(([kind, triggerRows]) => ({ kind, ...group(triggerRows) })),
    total: group(rows),
  };
}

function push<K>(map: Map<K, UsageRow[]>, key: K, row: UsageRow): void {
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
