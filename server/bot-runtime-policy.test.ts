import { describe, expect, it } from "vitest";

import {
  defaultBotRuntimePolicy,
  effectiveTaskRuntimePolicy,
  runtimePolicyFingerprint,
  runtimePolicyOverrideFingerprint,
  validateRuntimePolicyPatch,
} from "./bot-runtime-policy.ts";

describe("runtime policy evidence", () => {
  it("is stable for equivalent effective policy snapshots", () => {
    const policy = defaultBotRuntimePolicy();
    expect(runtimePolicyFingerprint(policy)).toBe(runtimePolicyFingerprint(structuredClone(policy)));
  });

  it("changes when a validated override changes", () => {
    const override = validateRuntimePolicyPatch({ maxToolAgentSteps: 12 });
    expect(override).toEqual({ maxToolAgentSteps: 12 });
    expect(runtimePolicyOverrideFingerprint(override!)).not.toBe(
      runtimePolicyOverrideFingerprint({ maxToolAgentSteps: 24 }),
    );
    expect(runtimePolicyFingerprint(effectiveTaskRuntimePolicy(undefined, override!))).not.toBe(
      runtimePolicyFingerprint(defaultBotRuntimePolicy()),
    );
  });

  it("rejects malformed overrides instead of fingerprinting them", () => {
    expect(() => validateRuntimePolicyPatch({ unknown: true })).toThrow(/unknown key/);
    expect(() => validateRuntimePolicyPatch({ retryCap: 2 })).toThrow(/retryCap/);
    expect(validateRuntimePolicyPatch(null)).toBeNull();
  });
});
