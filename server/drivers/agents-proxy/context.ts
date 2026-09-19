// The contract between the agents-proxy entry (agents-proxy.ts) and its
// handler modules. Every tool is a plain (args, ctx) function; everything
// process-specific — identity, per-turn state, and the helpers that used to
// live beside the dispatch chain — arrives through ToolContext explicitly
// instead of module globals.

export type Json = Record<string, unknown>;

/** A handler's answer: model-facing text with the optional isError flag, or
 * (for the tools that stream a harness result through verbatim) a raw
 * JSON-RPC result object. */
export type ToolResult = { text: string; isError?: boolean };
export type ToolOutcome = ToolResult | { result: Json };

export type ToolHandler = (args: Json, ctx: ToolContext) => Promise<ToolOutcome>;

export interface ToolContext {
  /** The calling bot's id (env OMB_BOT_ID): the sender of every request. */
  readonly botId: string;
  /** The conversation this proxy serves (env OMB_THREAD_ID). */
  readonly threadId: string;
  /** This turn's comms depth; the harness refuses recursion. */
  readonly depth: number;
  /** True when this turn runs inside a room (env OMB_ROOM_TURN=1). */
  readonly coordinating: boolean;
  /** True when the opt-in shared-computers feature is on. */
  readonly computerSharingEnabled: boolean;
  /** Delegation task ids created this turn. Polling one's own fresh
   * delegation is refused, so ask_bot, delegate_bot and the thread handoffs
   * share this set. */
  readonly delegationTaskIdsThisTurn: Set<string>;
  api(path: string, init?: RequestInit): Promise<Json>;
  /** Like api, but a refusal comes back as its body instead of an Error. */
  apiResponse(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }>;
  jsonRecord(value: unknown): value is Json;
  ordinal(n: number): string;
  routineFields(args: Json): { fields: Json; error?: string };
  completedProposalResult(r: Json, subject: string): ToolResult | undefined;
  confirmationResult(r: Json, fallback: string, noun?: string): ToolResult;
  recallSpeaker(hit: Json): string;
}
