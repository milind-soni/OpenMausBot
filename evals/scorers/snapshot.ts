import type { Assertion } from "../types.ts";
import type { AssertionResult } from "./assertions.ts";

/** The frozen evidence one scenario run leaves behind. Scorers see only
 * this object, never a live server, so assertions cannot be flattered by
 * re-reading mutable state. */

export interface EvidenceTurn {
  bot: string;
  index: number;
  threadId: string;
  system: string;
  prompt: string;
  toolCalls: Array<{ tool: string; arguments: Record<string, unknown>; errored: boolean }>;
}

export interface HandoffNodeView {
  bot: string;
  status: string;
  threadId: string;
  hasParent?: boolean;
}

export interface SendReceipt {
  bot: string;
  text: string;
  queued: boolean | undefined;
}

export interface WorldSnapshot {
  turns: EvidenceTurn[];
  handoffs: HandoffNodeView[];
  /** threadId of each bot's active chat thread, by bot key. */
  activeThreads: Record<string, string>;
  /** Messages collected at snapshot time, keyed by threadId. */
  threads: Record<string, Array<{ text?: string; kind?: string; tool?: { name?: string } }>>;
  sends: SendReceipt[];
  /** Named observations recorded by steps (gate answers, routine snapshots). */
  observations: Record<string, unknown>;
  /** Activities for a bot, as tool names. */
  activities: (bot: string) => string[];
  /** Resolves "@botKey" references inside assertion arguments. */
  resolve: (value: unknown) => unknown;
}

export interface StepResult {
  step: unknown;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface ScenarioResult {
  id: string;
  title: string;
  behavior: string;
  world: string;
  pass: boolean;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  assertions: AssertionResult[];
  assertionsInput: Assertion[];
  error?: string;
}
