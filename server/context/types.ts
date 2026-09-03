// Provider-neutral context contracts. Types only — the projection that
// produces them lands with the budget work; declaring the shape first lets
// drivers state what they own before anything depends on it.
//
// See docs/superpowers/specs/2026-09-03-hybrid-context-runtime-design.md.

/** Who owns the model-facing context for a turn on this engine.
 *
 * - `vendor-session`: an installed CLI/ACP harness keeps the live session.
 *   OpenMaus still prepares recovery context, but a valid session continues
 *   normally and history is never inlined into the prompt.
 * - `omb-replay`: OpenMaus sends bounded structured history every turn and
 *   the provider produces one response. History rides in the structured
 *   channel, never additionally inlined.
 * - `omb-loop`: OpenMaus rebuilds context before every model call and runs
 *   the model/tool iterations itself.
 *
 * This is a property of the engine, not of its driver-kind string: `grok`,
 * `minimax`, and `openai-compat` are distinct kinds sharing one runtime and
 * therefore one ownership mode. */
export type ContextOwnership = "vendor-session" | "omb-replay" | "omb-loop";

/** Where a model's declared limits came from. Without this a real 200k
 * window and a guessed one are indistinguishable downstream, and a silent
 * regression to the conservative default reads as a correct small model. */
export type ContextLimitsSource = "catalog" | "pattern" | "default";

/** A bounded, secret-redacted record of one tool call, safe to persist and
 * to replay to a different engine later. Never a fabricated provider-native
 * tool-call message: this is descriptive history, not protocol. */
export interface ToolContextSnapshot {
  callId?: string;
  name: string;
  inputSummary?: string;
  outputSummary?: string;
  ok?: boolean;
  filesRead?: string[];
  filesModified?: string[];
  /** any cap applied — diagnostics can say history was truncated without
   * exposing what was cut. */
  clipped?: boolean;
}

/** One semantic unit of history, in a form every driver can render into its
 * own protocol. */
export type ModelContextItem =
  | { kind: "user-text"; messageId: string; text: string }
  | { kind: "assistant-text"; messageId: string; text: string; speaker?: string }
  | { kind: "tool-observation"; messageId: string; observation: ToolContextSnapshot }
  | { kind: "summary"; messageId: string; text: string };

export interface ContextBudget {
  /** the target model's total window. */
  contextWindow: number;
  /** what the replay may occupy — a SHARE of the window, not the remainder
   * after subtracting measured parts. See budget.ts for why. */
  historyTokens: number;
  limitsSource: ContextLimitsSource;
}

/** Metadata only. Never carries prompt text, summaries, memory, tool
 * output, paths, or credentials. */
export interface ContextDiagnostics {
  /** semantic units available on the branch before budgeting. */
  sourceItems: number;
  /** units actually sent. */
  sentItems: number;
  estimatedInputTokens: number;
  /** a durable compaction record covered part of this history. */
  compacted: boolean;
  /** at least one item was cut at the context boundary. */
  clipped: boolean;
  /** bytes and tokens of the memory section, so clipping is observable
   * without exposing its content. */
  memoryBytes?: number;
  memoryTokens?: number;
}

export interface TurnContextPlan {
  ownership: ContextOwnership;
  mode: "resume-preferred" | "replay-required";
  /** the user's new message, alone. */
  currentPrompt: string;
  /** the full rebuild, used when a native session cannot be trusted. */
  replayPrompt: string;
  messages: ModelContextItem[];
  budget: ContextBudget;
  diagnostics: ContextDiagnostics;
}
