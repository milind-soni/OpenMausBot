/**
 * Small, persisted runtime-policy shape used only to identify an admission
 * snapshot. Enforcement remains owned by the runtime that admits a turn.
 * Raw policy values never cross the delegation receipt boundary.
 */

import { createHash } from "node:crypto";

export type CumulativeTokenPolicyMode = "disabled" | "soft" | "hard";

export interface CumulativeTokenPolicy {
  mode: CumulativeTokenPolicyMode;
  limit: number;
}

export interface BotRuntimePolicy {
  wallClockTimeoutMinutes: number;
  idleTimeoutMinutes: number;
  cancellationGraceSeconds: number;
  maxToolAgentSteps: number;
  delegationConcurrency: number;
  cumulativeTokenPolicy: CumulativeTokenPolicy;
}

export interface RuntimePolicyOverrides {
  wallClockTimeoutMinutes?: number;
  idleTimeoutMinutes?: number;
  cancellationGraceSeconds?: number;
  maxToolAgentSteps?: number;
  delegationConcurrency?: number;
  cumulativeTokenPolicy?: {
    mode?: CumulativeTokenPolicyMode;
    limit?: number;
  };
}

export type RuntimePolicyPatch = RuntimePolicyOverrides | null;

export const DEFAULT_CUMULATIVE_TOKEN_LIMIT = 1_000_000;

/** Read a legacy millisecond environment value, using the supplied fallback when it is absent or falsy. */
function legacyNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return value || fallback;
}

/** Clamp a finite duration to the supported positive integer range. */
function boundedCeil(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.ceil(value)));
}

/** Build effective defaults while preserving legacy environment timing values. */
export function defaultBotRuntimePolicy(): BotRuntimePolicy {
  return {
    wallClockTimeoutMinutes: 0,
    idleTimeoutMinutes: boundedCeil(legacyNumber("OMB_TURN_STALL_MS", 20 * 60_000) / 60_000, 1_440),
    cancellationGraceSeconds: boundedCeil(legacyNumber("OMB_TURN_STOP_GRACE_MS", 5_000) / 1_000, 120),
    maxToolAgentSteps: 0,
    delegationConcurrency: 4,
    cumulativeTokenPolicy: {
      mode: "disabled",
      limit: DEFAULT_CUMULATIVE_TOKEN_LIMIT,
    },
  };
}

/** Narrow an unknown value to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Test whether an object owns a field, including fields with undefined values. */
function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Validate a required integer policy field against an inclusive range. */
function integerInRange(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

/** Validate a policy field that permits zero as its disabled value. */
function zeroOrRange(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${field} must be 0 or an integer between 1 and ${max}`);
  }
  return value as number;
}

/** Validate and normalize the user-supplied runtime-policy override object. */
function validateOverrides(value: unknown): RuntimePolicyOverrides {
  if (!isRecord(value)) throw new Error("runtimePolicyOverride must be an object or null");
  const allowed = new Set([
    "wallClockTimeoutMinutes",
    "idleTimeoutMinutes",
    "cancellationGraceSeconds",
    "maxToolAgentSteps",
    "delegationConcurrency",
    "cumulativeTokenPolicy",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`runtimePolicyOverride contains unknown key "${unknown}"`);

  const patch: RuntimePolicyOverrides = {};
  if (has(value, "wallClockTimeoutMinutes")) {
    patch.wallClockTimeoutMinutes = zeroOrRange(value.wallClockTimeoutMinutes, "wallClockTimeoutMinutes", 1_440);
  }
  if (has(value, "idleTimeoutMinutes")) {
    patch.idleTimeoutMinutes = integerInRange(value.idleTimeoutMinutes, "idleTimeoutMinutes", 1, 1_440);
  }
  if (has(value, "cancellationGraceSeconds")) {
    patch.cancellationGraceSeconds = integerInRange(value.cancellationGraceSeconds, "cancellationGraceSeconds", 1, 120);
  }
  if (has(value, "maxToolAgentSteps")) patch.maxToolAgentSteps = zeroOrRange(value.maxToolAgentSteps, "maxToolAgentSteps", 1_000);
  if (has(value, "delegationConcurrency")) {
    patch.delegationConcurrency = integerInRange(value.delegationConcurrency, "delegationConcurrency", 1, 4);
  }
  if (has(value, "cumulativeTokenPolicy")) {
    const cumulativePolicy = value.cumulativeTokenPolicy;
    if (!isRecord(cumulativePolicy)) throw new Error("cumulativeTokenPolicy must be an object");
    const tokenUnknown = Object.keys(cumulativePolicy).find((key) => key !== "mode" && key !== "limit");
    if (tokenUnknown) throw new Error(`cumulativeTokenPolicy contains unknown key "${tokenUnknown}"`);
    const tokenPatch: NonNullable<RuntimePolicyOverrides["cumulativeTokenPolicy"]> = {};
    if (has(cumulativePolicy, "mode")) {
      if (cumulativePolicy.mode !== "disabled" && cumulativePolicy.mode !== "soft" && cumulativePolicy.mode !== "hard") {
        throw new Error("cumulativeTokenPolicy.mode must be disabled, soft, or hard");
      }
      tokenPatch.mode = cumulativePolicy.mode;
    }
    if (has(cumulativePolicy, "limit")) tokenPatch.limit = integerInRange(cumulativePolicy.limit, "cumulativeTokenPolicy.limit", 1_000, 10_000_000);
    patch.cumulativeTokenPolicy = tokenPatch;
  }
  return patch;
}

/** undefined means the field was absent; malformed values throw. */
export function validateRuntimePolicyPatch(value: unknown): RuntimePolicyPatch | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return validateOverrides(value);
}

/** Check whether an override number is an allowed integer, including optional zero. */
function validOverrideNumber(value: unknown, min: number, max: number, allowZero: boolean): value is number {
  return Number.isInteger(value)
    && (allowZero ? (value as number) === 0 || (value as number) >= min : (value as number) >= min)
    && (value as number) <= max;
}

/** Copy only well-formed override fields so persisted data cannot widen the policy shape. */
function copyOverrides(value: RuntimePolicyOverrides | undefined): RuntimePolicyOverrides {
  const out: RuntimePolicyOverrides = {};
  if (value && validOverrideNumber(value.wallClockTimeoutMinutes, 1, 1_440, true)) {
    out.wallClockTimeoutMinutes = value.wallClockTimeoutMinutes;
  }
  if (value && validOverrideNumber(value.idleTimeoutMinutes, 1, 1_440, false)) {
    out.idleTimeoutMinutes = value.idleTimeoutMinutes;
  }
  if (value && validOverrideNumber(value.cancellationGraceSeconds, 1, 120, false)) {
    out.cancellationGraceSeconds = value.cancellationGraceSeconds;
  }
  if (value && validOverrideNumber(value.maxToolAgentSteps, 1, 1_000, true)) {
    out.maxToolAgentSteps = value.maxToolAgentSteps;
  }
  if (value && validOverrideNumber(value.delegationConcurrency, 1, 4, false)) {
    out.delegationConcurrency = value.delegationConcurrency;
  }
  if (value?.cumulativeTokenPolicy) {
    const cumulativePolicy: NonNullable<RuntimePolicyOverrides["cumulativeTokenPolicy"]> = {};
    if (value.cumulativeTokenPolicy.mode === "disabled" || value.cumulativeTokenPolicy.mode === "soft" || value.cumulativeTokenPolicy.mode === "hard") {
      cumulativePolicy.mode = value.cumulativeTokenPolicy.mode;
    }
    if (validOverrideNumber(value.cumulativeTokenPolicy.limit, 1_000, 10_000_000, false)) {
      cumulativePolicy.limit = value.cumulativeTokenPolicy.limit;
    }
    if (cumulativePolicy.mode !== undefined || cumulativePolicy.limit !== undefined) out.cumulativeTokenPolicy = cumulativePolicy;
  }
  return out;
}

/** Merge a task patch over bot overrides while retaining nested token-policy fields. */
function mergeRuntimePolicy(previous: RuntimePolicyOverrides | undefined, patch: RuntimePolicyPatch | undefined): RuntimePolicyOverrides | undefined {
  if (patch === undefined) {
    const copied = copyOverrides(previous);
    return Object.keys(copied).length ? copied : undefined;
  }
  if (patch === null) return undefined;
  const prior = copyOverrides(previous);
  return {
    ...prior,
    ...patch,
    ...(prior.cumulativeTokenPolicy || patch.cumulativeTokenPolicy
      ? { cumulativeTokenPolicy: { ...prior.cumulativeTokenPolicy, ...patch.cumulativeTokenPolicy } }
      : {}),
  };
}

/** Resolve explicit overrides onto the current effective runtime defaults. */
export function effectiveBotRuntimePolicy(overrides?: RuntimePolicyOverrides): BotRuntimePolicy {
  const defaults = defaultBotRuntimePolicy();
  const explicit = copyOverrides(overrides);
  return {
    wallClockTimeoutMinutes: explicit.wallClockTimeoutMinutes ?? defaults.wallClockTimeoutMinutes,
    idleTimeoutMinutes: explicit.idleTimeoutMinutes ?? defaults.idleTimeoutMinutes,
    cancellationGraceSeconds: explicit.cancellationGraceSeconds ?? defaults.cancellationGraceSeconds,
    maxToolAgentSteps: explicit.maxToolAgentSteps ?? defaults.maxToolAgentSteps,
    delegationConcurrency: explicit.delegationConcurrency ?? defaults.delegationConcurrency,
    cumulativeTokenPolicy: {
      mode: explicit.cumulativeTokenPolicy?.mode ?? defaults.cumulativeTokenPolicy.mode,
      limit: explicit.cumulativeTokenPolicy?.limit ?? defaults.cumulativeTokenPolicy.limit,
    },
  };
}

/** Resolve bot and one-task overrides into the immutable policy admitted for a turn. */
export function effectiveTaskRuntimePolicy(
  botOverrides: RuntimePolicyOverrides | undefined,
  taskOverride: RuntimePolicyOverrides | undefined,
): BotRuntimePolicy {
  return effectiveBotRuntimePolicy(mergeRuntimePolicy(botOverrides, taskOverride));
}

/** Runtime admission snapshots cross async boundaries; keep them detached from
 * mutable bot/task records so queue-time evidence and dispatch-time limits
 * cannot silently diverge. */
export function cloneRuntimePolicy(policy: BotRuntimePolicy): BotRuntimePolicy {
  return { ...policy, cumulativeTokenPolicy: { ...policy.cumulativeTokenPolicy } };
}

/** Check that an unknown value is a complete effective runtime-policy snapshot. */
export function isBotRuntimePolicy(value: unknown): value is BotRuntimePolicy {
  if (!isRecord(value) || !isRecord(value.cumulativeTokenPolicy)) return false;
  return validOverrideNumber(value.wallClockTimeoutMinutes, 1, 1_440, true)
    && validOverrideNumber(value.idleTimeoutMinutes, 1, 1_440, false)
    && validOverrideNumber(value.cancellationGraceSeconds, 1, 120, false)
    && validOverrideNumber(value.maxToolAgentSteps, 1, 1_000, true)
    && validOverrideNumber(value.delegationConcurrency, 1, 4, false)
    && (value.cumulativeTokenPolicy.mode === "disabled"
      || value.cumulativeTokenPolicy.mode === "soft"
      || value.cumulativeTokenPolicy.mode === "hard")
    && validOverrideNumber(value.cumulativeTokenPolicy.limit, 1_000, 10_000_000, false);
}

/** Project a policy or override into the ordered, secret-free fingerprint input vector. */
function fingerprintVector(value: BotRuntimePolicy | RuntimePolicyOverrides): unknown[] {
  return [
    value.wallClockTimeoutMinutes,
    value.idleTimeoutMinutes,
    value.cancellationGraceSeconds,
    value.maxToolAgentSteps,
    value.delegationConcurrency,
    value.cumulativeTokenPolicy?.mode,
    value.cumulativeTokenPolicy?.limit,
  ];
}

/** Hash the canonical policy vector into its stable evidence string. */
function fingerprint(value: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Stable, secret-free evidence for the effective admission snapshot. */
export function runtimePolicyFingerprint(policy: BotRuntimePolicy): string {
  return fingerprint(fingerprintVector(policy));
}

/** Stable evidence for the explicit override, without retaining raw values. */
export function runtimePolicyOverrideFingerprint(overrides?: RuntimePolicyOverrides): string | undefined {
  return overrides ? fingerprint(fingerprintVector(overrides)) : undefined;
}
