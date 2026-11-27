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

/** A provider the Grok CLI serves (say an OpenAI-compatible router) can throttle for a moment on its own; these words say
 * so, where the Grok plan's quota would not. */
const TRANSIENT_RATE_LIMIT = /\brate_limit_error\b|\bsemaphore timeout\b|\btoo many requests\b/i;

/** A prompt Grok ended for a rate limit, after its own retries: the account's usage limit, unless its words name another
 * cause (a server error, an overload, no credit), which keeps its own words — or a provider's own transient throttle, which
 * stays a rate limit a retry can clear, not a quota to wait out. */
function grokLimitFailure(said: string): AcpReportedFailure | undefined {
  const kind = engineFailureKind(said);
  if (kind !== null && kind !== "usage_limit" && kind !== "rate_limit") return undefined;
  if (kind !== "usage_limit" && TRANSIENT_RATE_LIMIT.test(said)) return new AcpReportedFailure(engineFailure("Grok", said, { kind: "rate_limit", status: null })!, false);
  return new AcpReportedFailure(engineFailure("Grok", said, { kind: "usage_limit", status: null })!, true);
}

/** The prompt's answer, its own or the one its notification gave. */
export async function grokPromptOutcome(): Promise<(result: unknown) => Promise<Error | undefined>> {
  return async (result) => {
    const answer = result as { stopReason?: unknown; error?: unknown } | null;
    return answer?.stopReason === "rate_limit" ? grokLimitFailure(text(answer.error) ?? "") : undefined;
  };
}

/** grok 1.0.41's words when its sign-in check failed for a moment while it stays signed in: its own 401 line comes first,
 * so the raw text reads as a sign-out, and a routine run would stop for a sign-in nobody needs to do. */
const GROK_AUTH_BLIP = /\bAuthentication is temporarily unavailable\b[\s\S]*\bstill signed in\b/i;

export function grokReportedFailure(error: unknown): Error | undefined {
  if (error instanceof Error && GROK_AUTH_BLIP.test(error.message)) {
    return new AcpReportedFailure({ message: "Grok couldn't confirm its sign-in for a moment (often a network error right after waking). It is still signed in: try again in a few seconds." }, false);
  }
  if ((error as { code?: unknown } | null)?.code !== GROK_RATE_LIMITED) return undefined;
  return grokLimitFailure(error instanceof Error ? error.message : "");
}
