import { DEFAULT_LIMITS, type Limits } from "./types.ts";

const whole = (raw: string | undefined): number | undefined => {
  const value = Number(raw?.trim() || NaN);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
};

/** OMB_QUEUE_TIMEOUT_MS: the queue window in milliseconds; anything else leaves the default. OMB_QUEUE_TIMEOUT_MINUTES
 * names the same window in minutes and wins when both are set. */
export function queueLimits(env: NodeJS.ProcessEnv = process.env): Pick<Limits, "queueMs"> {
  const minutes = whole(env.OMB_QUEUE_TIMEOUT_MINUTES);
  const ms = whole(env.OMB_QUEUE_TIMEOUT_MS);
  return { queueMs: minutes !== undefined ? minutes * 60_000 : ms ?? DEFAULT_LIMITS.queueMs };
}
