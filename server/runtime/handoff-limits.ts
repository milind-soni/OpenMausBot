import type { Limits } from "./types.ts";

export const HANDOFF_MAX_TURNS = 300;
export const HANDOFF_MAX_FAILURES = 5;

const whole = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw?.trim() || NaN);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
};

/** OMB_HANDOFF_MAX_TURNS and OMB_HANDOFF_MAX_FAILURES: whole numbers from 1; anything else leaves the default. */
export function handoffLimits(env: NodeJS.ProcessEnv = process.env): Pick<Limits, "totalExecutions" | "failedInARow"> {
  return { totalExecutions: whole(env.OMB_HANDOFF_MAX_TURNS, HANDOFF_MAX_TURNS), failedInARow: whole(env.OMB_HANDOFF_MAX_FAILURES, HANDOFF_MAX_FAILURES) };
}
