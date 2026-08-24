import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_TARGETS,
  credentialConfigPatch,
  credentialIsConfigured,
  isCredentialTargetId,
} from "../shared/credential-request.ts";

describe("credential request allowlist", () => {
  it("accepts only declared own ids", () => {
    expect(isCredentialTargetId("xaiApiKey")).toBe(true);
    expect(isCredentialTargetId("composioApiKey")).toBe(false);
    expect(isCredentialTargetId("__proto__")).toBe(false);
    expect(isCredentialTargetId({ toString: () => "xaiApiKey" })).toBe(false);
  });

  it("maps each id to a fixed config location", () => {
    expect(credentialConfigPatch("boxToken", "secret")).toEqual({ box: { token: "secret" } });
    expect(credentialConfigPatch("openaiImageApiKey", "secret")).toEqual({ imageGen: { key: "secret" } });
  });

  it("checks configured state without exposing values", () => {
    expect(credentialIsConfigured({ tts: { key: "secret" } }, "ttsKey")).toBe(true);
    expect(credentialIsConfigured({ tts: { key: "" } }, "ttsKey")).toBe(false);
    expect(Object.keys(CREDENTIAL_TARGETS)).toHaveLength(5);
  });
});
