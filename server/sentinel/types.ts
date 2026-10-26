// Privacy invariant: records carry tool output only in memory, for signatures; an issue stores evidence ids, never text.

/** external: another MCP server, the engine's own tools or the provider account. */
export type Origin = "harness" | "external" | "shell";
export type Severity = "high" | "medium" | "low";

export interface EvidenceRef {
  source: "messages" | "events" | "runtime";
  id: string;
}

export type SentinelRecord =
  | {
    type: "tool"; id: string; threadId: string; turnId?: string; botId?: string; at: number;
    /** "harness_notice": a sentence the harness wrote into the transcript. */
    tool: string;
    ok: boolean;
    /** Signatures only; never stored. */
    text: string;
  }
  | { type: "turn"; id: string; threadId: string; turnId?: string; botId?: string; at: number; ok: boolean; stopReason: string | null; cost: number | null }
  /** `started: false`: still waiting at scan time. */
  | { type: "queue"; id: string; assignmentId: string; threadId: string; botId?: string; at: number; waitMs: number; started: boolean };

export interface Observation {
  kind: string;
  signature: string;
  title: string;
  origin: Origin;
  severity: Severity;
  tool?: string;
  botId?: string;
  threadId?: string;
  turnId?: string;
  at: number;
  /** Stable across scans, so an occurrence is counted once per kind. */
  occurrence: string;
  evidence: EvidenceRef;
}

export interface DetectorConfig {
  queueWaitMs: number;
  costUsd: number;
  retryLoopMin: number;
  now: number;
}

/** Pure: it may see the same record on several scans, and `occurrence` makes that harmless. */
export interface Detector {
  name: string;
  detect(records: readonly SentinelRecord[], config: DetectorConfig): Observation[];
}

export interface Issue {
  sig: string;
  kind: string;
  /** Local only, never shared: normalized text can still hold a name. */
  title: string;
  origin: Origin;
  severity: Severity;
  tool?: string;
  botId?: string;
  threadId?: string;
  turnId?: string;
  firstAt: number;
  lastAt: number;
  count: number;
  wastedTurns: number;
  evidenceRef: EvidenceRef;
}
