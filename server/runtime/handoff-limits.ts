import type { Limits } from "./types.ts";

export const HANDOFF_MAX_TURNS = 300;
export const HANDOFF_MAX_FAILURES = 5;
/** Handed-off work whose turn shows nothing (no text, no step, no tool ending): its requester is told at 20 minutes, the
 * host watchdog's own silence, and it is stopped at an hour, even while a command that keeps using CPU keeps the watchdog
 * from stopping it. */
export const HANDOFF_QUIET_NOTICE_MINUTES = 20;
export const HANDOFF_QUIET_MAX_MINUTES = 60;

const whole = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw?.trim() || NaN);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
};

/** OMB_HANDOFF_MAX_TURNS, OMB_HANDOFF_MAX_FAILURES, OMB_HANDOFF_QUIET_NOTICE_MINUTES and OMB_HANDOFF_QUIET_MAX_MINUTES: whole
 * numbers from 1; anything else leaves the default. A notice set past the limit is never sent. */
export function handoffLimits(env: NodeJS.ProcessEnv = process.env): Pick<Limits, "totalExecutions" | "failedInARow" | "handoffQuietNoticeMs" | "handoffQuietMaxMs"> {
  return { totalExecutions: whole(env.OMB_HANDOFF_MAX_TURNS, HANDOFF_MAX_TURNS), failedInARow: whole(env.OMB_HANDOFF_MAX_FAILURES, HANDOFF_MAX_FAILURES),
    handoffQuietNoticeMs: whole(env.OMB_HANDOFF_QUIET_NOTICE_MINUTES, HANDOFF_QUIET_NOTICE_MINUTES) * 60_000,
    handoffQuietMaxMs: whole(env.OMB_HANDOFF_QUIET_MAX_MINUTES, HANDOFF_QUIET_MAX_MINUTES) * 60_000 };
}
