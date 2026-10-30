import { engineMemory, type EngineMemory } from "../engine-memory.ts";
import { seenWithin } from "../thread-presence.ts";

export interface SessionIdlePolicy {
  idleMs: number;
  minimumMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const MINIMUM_IDLE_MS = 10_000;
/** setTimeout treats anything above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function usableMilliseconds(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}

/** Per-harness names (OMB_CLAUDE_SESSION_IDLE_*, OMB_ACP_SESSION_IDLE_*) win over OMB_SESSION_IDLE_MS /
 *  OMB_SESSION_IDLE_MIN_MS; the floor is the greater of ten seconds and any configured minimum. */
export function sessionIdlePolicy(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
): SessionIdlePolicy {
  const minimumMs = Math.max(
    MINIMUM_IDLE_MS,
    usableMilliseconds(
      env[`OMB_${driverPrefix}_SESSION_IDLE_MIN_MS`] ?? env.OMB_SESSION_IDLE_MIN_MS,
    ) ?? 0,
  );
  const configured =
    usableMilliseconds(
      env[`OMB_${driverPrefix}_SESSION_IDLE_MS`] ?? env.OMB_SESSION_IDLE_MS,
    ) ?? DEFAULT_IDLE_MS;
  return { idleMs: Math.max(minimumMs, configured), minimumMs };
}

/** A person wrote in, opened or read the thread this recently: it is the conversation in front of them. */
const WATCHED_MS = 30 * 60_000;
/** A thread nobody has in front of them (a teammate's delegated work, a routine) keeps its engine this long. */
export const UNWATCHED_IDLE_MS = 30_000;

/**
 * How long one thread's idle engine stays up after a turn. On a Cloud home: briefly for a thread no person has had in
 * front of them lately, and for the one they have, the configured time scaled by the memory left (down to a tenth).
 * Elsewhere the configured time.
 */
export function engineIdleMs(threadId: string, policy: SessionIdlePolicy, memory: Pick<EngineMemory, "enabled" | "headroom"> = engineMemory,
  now: number = Date.now()): number {
  if (!memory.enabled) return policy.idleMs;
  if (!seenWithin(threadId, WATCHED_MS, now)) return Math.max(policy.minimumMs, Math.min(policy.idleMs, UNWATCHED_IDLE_MS));
  return Math.max(policy.minimumMs, Math.round(policy.idleMs * memory.headroom()));
}
