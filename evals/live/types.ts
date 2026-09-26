import { z } from "zod";
import { assertionSchema, stepSchema } from "../types.ts";

/** Tier 3: opt-in live-model smoke evals. A live scenario is pure data
 * like a tier-1 fixture, minus scripted turns (a real model drives the
 * turns) plus the invariants that stay meaningful against real model
 * output: argument-agnostic tool traces, dispatch targets, admission, and
 * reply presence. Open-ended quality is judged by a versioned prompt, not
 * pinned text. */

export const liveBotSchema = z.object({
  key: z.string(),
  name: z.string(),
  section: z.string().optional(),
  chiefOfStaff: z.boolean().optional(),
  managedSections: z.array(z.string()).optional(),
});

/** Invariants are tier-1 assertion kinds (checked against the frozen
 * snapshot) plus the live-only botReplied: the bot produced at least one
 * text reply in the named thread. */
export const liveInvariantSchema = z.union([
  assertionSchema,
  z.object({ kind: z.literal("botReplied"), bot: z.string(), thread: z.enum(["active", "node"]) }),
]);

export const liveScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  behavior: z.string(),
  bots: z.array(liveBotSchema),
  steps: z.array(stepSchema),
  invariants: z.array(liveInvariantSchema),
  /** When present, the scenario's last reply is also graded by the
   * versioned judge prompt named here. */
  judged: z.object({ prompt: z.string() }).optional(),
});

export type LiveBot = z.infer<typeof liveBotSchema>;
export type LiveInvariant = z.infer<typeof liveInvariantSchema>;
export type LiveScenario = z.infer<typeof liveScenarioSchema>;

/** Drift thresholds and timeouts. Committed so a live run's pass bar is
 * reviewable; scores themselves are per-run artifacts. */
export const liveConfigSchema = z.object({
  /** Suite pass bar: mean scenario score must be at least this. */
  minScore: z.number().min(0).max(1),
  /** Maximum allowed drop from the last recorded live baseline score. */
  maxDrift: z.number().min(0).max(1),
  turnTimeoutMs: z.number().int().min(10_000),
  judgeTimeoutMs: z.number().int().min(10_000),
  /** Parse retries for the judge's JSON verdict. */
  maxJudgeRetries: z.number().int().min(0).max(3),
});

export type LiveConfig = z.infer<typeof liveConfigSchema>;

/** One real engine instance for the live tier, in the product's own
 * instance-config shape. Supplied via OMB_EVAL_LIVE_INSTANCE (inline JSON)
 * or OMB_EVAL_LIVE_CONFIG (path to a JSON file). "environmentFrom" names
 * variables copied from the launching shell into the engine process so
 * keys never have to be inlined anywhere. */
export const liveInstanceSchema = z.object({
  instanceId: z.string().min(1),
  driver: z.string().min(1),
  displayName: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  environmentFrom: z.array(z.string()).optional(),
  model: z.string().min(1),
});

export type LiveInstance = z.infer<typeof liveInstanceSchema>;

export interface LiveCheckResult {
  kind: string;
  pass: boolean;
  detail: string;
}

export interface LiveScenarioOutcome {
  id: string;
  title: string;
  behavior: string;
  checks: LiveCheckResult[];
  score: number;
  error?: string;
}
