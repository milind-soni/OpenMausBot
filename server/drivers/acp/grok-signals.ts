// What Grok reads and says beside ACP itself: who its client is, how a turn was stopped, and how a prompt ended.
import { engineFailure, engineFailureKind } from "../engine-errors.ts";
import type { AcpPromptCompletion } from "./driver-hooks.ts";
import { AcpReportedFailure } from "./failure-words.ts";

/** Grok reads `clientType` from initialize's `_meta` (grok 1.0.25 knows "generic", "extension" and its own clients). For a
 * "generic" client its Auto mode denies what its classifier refuses without asking; for "extension" it asks with a
 * permission request. */
export const GROK_INITIALIZE_META = { clientType: "extension" } as const;

/** Grok reads the stop gesture from session/cancel's `_meta.cancelTrigger` (grok 1.0.25: its own terminal sends "ctrl_c",
 * "mouse" or "dashboard_stop"). "ctrl_c" also keeps background work from waking a turn before the next prompt. */
export const GROK_CANCEL_META = { cancelTrigger: "ctrl_c" } as const;

/** Grok's JSON-RPC error code for a session/prompt it ended on a rate limit. */
const GROK_RATE_LIMITED = -32003;

const PROMPT_COMPLETE = new Set(["_x.ai/session/prompt_complete", "x.ai/session/prompt_complete"]);

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

/** grok 1.0.41 ends each prompt with `_x.ai/session/prompt_complete` {sessionId, promptId, stopReason, agentResult} just
 * before its session/prompt reply, and names the prompt by the `promptId` that prompt's `_meta` gave it. A background task's
 * finish ends a prompt of its own, under a `task-completed-…` id no session/prompt of ours has. */
export const GROK_PROMPT_COMPLETION: AcpPromptCompletion = {
  meta: (promptId) => ({ promptId, requestId: promptId }),
  read(msg) {
    if (typeof msg.method !== "string" || !PROMPT_COMPLETE.has(msg.method)) return null;
    const params = msg.params as { sessionId?: unknown; promptId?: unknown; stopReason?: unknown; agentResult?: unknown } | null;
    const sessionId = text(params?.sessionId);
    if (!sessionId) return null;
    const stopReason = text(params?.stopReason) ?? "end_turn", error = text(params?.agentResult);
    return { sessionId, promptId: text(params?.promptId), result: { stopReason, ...(error && stopReason !== "end_turn" ? { error } : {}) } };
  },
};

/** A prompt Grok ended for a rate limit, after its own retries: the account's usage limit, unless its words name another
 * cause (a server error, an overload, no credit), which then keeps its own words. */
function grokLimitFailure(said: string): AcpReportedFailure | undefined {
  const kind = engineFailureKind(said);
  if (kind !== null && kind !== "usage_limit" && kind !== "rate_limit") return undefined;
  return new AcpReportedFailure(engineFailure("Grok", said, { kind: "usage_limit", status: null })!, true);
}

/** The prompt's answer, its own or the one its notification gave. */
export async function grokPromptOutcome(): Promise<(result: unknown) => Promise<Error | undefined>> {
  return async (result) => {
    const answer = result as { stopReason?: unknown; error?: unknown } | null;
    return answer?.stopReason === "rate_limit" ? grokLimitFailure(text(answer.error) ?? "") : undefined;
  };
}

export function grokReportedFailure(error: unknown): Error | undefined {
  if ((error as { code?: unknown } | null)?.code !== GROK_RATE_LIMITED) return undefined;
  return grokLimitFailure(error instanceof Error ? error.message : "");
}
