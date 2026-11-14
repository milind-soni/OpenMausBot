/** This month's included X calls, as the MausBot Cloud relay counts them (`GET <relay>/usage`). `usedUp`: no call is
 * left this month. `resetsAt`: the first of next month (UTC, ISO). `trialEndsAt`: during a free trial, when the full
 * allowance starts. */
export interface XIncludedUsage {
  calls: number;
  max: number;
  usedUp?: true;
  resetsAt: string;
  trialEndsAt?: string;
}

/** `GET /api/x/status`, the Apps page's X card. Never a key or a token.
 * `using`: the credential the X tools use now, the person's own treg key before the plan's included calls; null when
 * neither is held, and then no bot is shown the X tools.
 * `included`: this server holds a MausBot Cloud plan's included X calls. `unavailable`: the Admin said this desktop's
 * paid sign-in gets none. `usage`: the included calls this month, when the relay answered. */
export interface XConnectorStatus {
  using: "own" | "included" | null;
  ownKey: boolean;
  included: boolean;
  unavailable?: true;
  usage?: XIncludedUsage;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isoTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** The relay's answer as XIncludedUsage, or null for anything else. Every call used reads as used up. */
export function parseXIncludedUsage(value: unknown): XIncludedUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { calls, max, usedUp, resetsAt, trialEndsAt } = value as Record<string, unknown>;
  if (!count(calls) || !count(max) || !isoTime(resetsAt) || (trialEndsAt !== undefined && !isoTime(trialEndsAt))) return null;
  return { calls: Math.min(calls, max), max, ...(usedUp === true || calls >= max ? { usedUp: true as const } : {}), resetsAt, ...(trialEndsAt !== undefined ? { trialEndsAt } : {}) };
}

export function isXConnectorStatus(value: unknown): value is XConnectorStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (status.using === "own" || status.using === "included" || status.using === null)
    && typeof status.ownKey === "boolean" && typeof status.included === "boolean"
    && (status.usage === undefined || parseXIncludedUsage(status.usage) !== null);
}
