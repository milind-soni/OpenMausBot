// One session-idle policy for every pooled harness process. The Claude
// driver and the ACP core grew byte-identical copies of this computation
// with different env prefixes; the policy lives here so the default, the
// floor, and the env names cannot drift apart again.

export interface SessionIdlePolicy {
  /** How long a session may sit quiet before it is closed as "idle". */
  idleMs: number;
  /** The smallest idle delay a configuration may ask for. */
  minimumMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const MINIMUM_IDLE_MS = 10_000;
/** setTimeout treats anything above 2^31-1 ms as 1 ms, so a larger delay
 *  would close the session immediately instead of much later. */
const MAX_TIMER_MS = 2_147_483_647;

function usableMilliseconds(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}

/** The idle policy for one harness. The per-harness names that preceded the
 *  unified ones (OMB_CLAUDE_SESSION_IDLE_*, OMB_ACP_SESSION_IDLE_*) win when
 *  both are set, so a harness-specific override keeps working alongside a
 *  global OMB_SESSION_IDLE_MS / OMB_SESSION_IDLE_MIN_MS; the unified names
 *  are the default for harnesses that did not set their own. A delay that is
 *  not a positive finite number of at most 2^31-1 ms is validated away before
 *  the floor applies — the old arithmetic coerced Infinity and larger values
 *  into an immediately-firing 1 ms timer. The floor is the greater of the
 *  built-in ten seconds and any configured minimum, so a per-harness minimum
 *  can raise the floor but never lower it, and it applies to whatever delay
 *  wins. */
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
