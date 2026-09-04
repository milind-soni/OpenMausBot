// The internal seam between OpenMausBot and whatever agent core runs the
// owned loop.
//
// Everything Pi-specific lives behind this file's types in pi-runtime.ts.
// Dispatch, the driver, and the tests speak only these shapes, so the core
// can be swapped, faked, or upgraded without the rest of the harness
// noticing. Nothing here names a Pi type.
import type { EffortLevel } from "../contracts.ts";
import type { ToolContextSnapshot, TurnContextPlan } from "../context/types.ts";

/** Where the model lives and how to reach it. The key is passed explicitly
 * per call and never read from the process environment or any credential
 * store the core might know about. */
export interface OwnedModelTarget {
  /** the model id as the endpoint knows it. */
  id: string;
  /** an OpenAI-compatible chat-completions base URL, no trailing slash. */
  baseUrl: string;
  /** absent for a loopback/local endpoint that needs none. */
  apiKey?: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** the endpoint can return reasoning content. */
  reasoning: boolean;
  /** OpenRouter provider routing (`provider.order`), when the URL is
   * OpenRouter and the user pinned one. */
  openRouterProvider?: string;
}

/** A JSON-Schema object for tool parameters. The model produces JSON against
 * it; the runtime validates before execute() sees anything. */
export interface OwnedToolSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface OwnedToolResult {
  /** what the model is told. Bounded by the runtime before it reaches the
   * context. */
  text: string;
  ok: boolean;
  /** the durable, portable record — already sanitized. */
  observation: ToolContextSnapshot;
}

export interface OwnedTool {
  name: string;
  description: string;
  parameters: OwnedToolSchema;
  execute(callId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<OwnedToolResult>;
}

export interface OwnedTurnInput {
  threadId: string;
  turnId: string;
  /** the canonical context. The runtime rebuilds the model's view from
   * this before EVERY model call; it never keeps a private history. */
  plan: TurnContextPlan;
  system?: string;
  model: OwnedModelTarget;
  effort?: EffortLevel;
  tools: OwnedTool[];
  /** abort ends the current model call and any running tool. */
  signal: AbortSignal;
  /** the hard bounds the loop must respect. */
  limits: OwnedLoopLimits;
}

export interface OwnedLoopLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  toolTimeoutMs: number;
}

/** Everything the loop reports, in the order it happens. Maps one-to-one
 * onto the canonical RuntimeEvent bus in the driver; this union exists so
 * the mapping is a table rather than something scattered through the
 * core adapter. */
export type OwnedRuntimeEvent =
  | { type: "model.call"; call: number }
  | { type: "delta"; kind: "text" | "reasoning"; text: string }
  /** a tool call is waiting on the harness. The driver turns this into
   * request.opened; the answer comes back through answer(). */
  | { type: "ask.opened"; requestId: string; kind: "permission" | "question"; tool: string; summary: string; choices?: string[] }
  | { type: "ask.resolved"; requestId: string; behavior: "allow" | "deny" | "answer"; source: "user" | "timeout" | "system" | "unavailable" }
  | { type: "tool.started"; callId: string; name: string; inputSummary: string }
  | { type: "tool.completed"; callId: string; name: string; ok: boolean; observation: ToolContextSnapshot }
  | { type: "assistant"; text: string }
  | { type: "usage"; input: number; output: number; cachedInput?: number; costUsd?: number }
  | { type: "completed"; ok: true; stopReason: "end_turn" | "max_model_calls" | "max_tool_calls" }
  | { type: "completed"; ok: false; stopReason: "interrupted" | "error" }
  | { type: "error"; message: string };

export type OwnedRuntimeEmit = (event: OwnedRuntimeEvent) => void;

export interface OwnedAgentRuntime {
  /** Run one turn to completion. Resolves after the terminal `completed`
   * event has been emitted; never rejects for a model or tool failure —
   * those become `error` + `completed{ok:false}`. */
  run(input: OwnedTurnInput, emit: OwnedRuntimeEmit): Promise<void>;
  /** Deliver a user message into the running turn, ahead of the next model
   * call. False when nothing is running on this thread. */
  steer(threadId: string, text: string): boolean;
  /** Abort the running turn on this thread, if any. */
  interrupt(threadId: string): void;
  /** The harness's answer to an open ask. `unavailable` when nothing by
   * that id is pending on that thread — never treated as an allow. */
  answer(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message?: string): "allowed-once" | "rejected" | "answered" | "unavailable";
  hasTurn(threadId: string): boolean;
  dispose(): Promise<void>;
}
