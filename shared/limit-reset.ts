/** Wire shapes for automations that run when an engine's usage limit resets, and for the engines' limit state
 * the Automations page, the chat and the calendar show. */

export type LimitResetRepeat = "once" | "every_reset";

/** A routine schedule that runs when an engine's usage limit resets. */
export interface LimitResetSchedule {
  type: "limit_reset";
  /** The engine instance id whose limit it waits for, e.g. "claude" or "codex". */
  engine: string;
  repeat: LimitResetRepeat;
  /** Derived by the server, never taken from input: the reset plus a short buffer, or null while the time is not known. */
  at: number | null;
}

/** As a request or an edit sends it: the server derives `at`. */
export type LimitResetScheduleInput = Omit<LimitResetSchedule, "at" | "repeat"> & { repeat?: LimitResetRepeat; at?: number | null };

/** How long after a reset the run starts, so the provider has rolled its window over. */
export const AFTER_RESET_MS = 60_000;

/** From this share of a window used, an engine is shown as near its limit. */
export const NEAR_LIMIT_PERCENT = 90;

export type LimitWindowName = "5-hour" | "weekly" | "other";

/** One engine's usage limit as OpenMausBot knows it now. */
export interface EngineLimit {
  /** Engine instance id. */
  engine: string;
  /** The engine's display name ("Claude", "Codex", or the instance's own name). */
  name: string;
  driver: "claude" | "codex" | "grok";
  /** The window that decides the reset: the fullest, or the one refusing work. */
  window: LimitWindowName | null;
  /** 0–100, or null when the engine reported no window. */
  usedPercent: number | null;
  /** Epoch ms when that window resets; null when not known. */
  resetsAt: number | null;
  /** The engine refuses work until resetsAt. */
  blocked: boolean;
}

export interface EngineLimitsReport {
  checkedAt: number;
  engines: EngineLimit[];
}

export function isLimitResetSchedule(schedule: { type: string } | null | undefined): schedule is LimitResetSchedule {
  return schedule?.type === "limit_reset";
}

/** A one-time automation: a fixed time, or the next reset only. */
export function runsOnce(schedule: { type: string; repeat?: unknown }): boolean {
  return schedule.type === "once" || (schedule.type === "limit_reset" && schedule.repeat !== "every_reset");
}

export function nearLimit(limit: Pick<EngineLimit, "usedPercent" | "blocked">): boolean {
  return limit.blocked || (limit.usedPercent ?? 0) >= NEAR_LIMIT_PERCENT;
}
