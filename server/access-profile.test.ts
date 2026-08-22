import { describe, expect, it } from "vitest";

import {
  createCapabilityProfileManifest,
  isAccessProfile,
  normalizeAccessProfile,
  renderFullTaskScopedSystemPrompt,
  supportsFullTaskScopedBotDriver,
  telemetryCaptureMode,
} from "./access-profile.ts";

describe("access profiles", () => {
  it("keeps unknown and legacy records on the standard profile", () => {
    expect(normalizeAccessProfile(undefined)).toBe("standard");
    expect(normalizeAccessProfile("anything-goes")).toBe("standard");
    expect(isAccessProfile("full-task-scoped")).toBe(true);
  });

  it("offers BotRecord full access only through adapters that mount the gateway", () => {
    expect(supportsFullTaskScopedBotDriver("claudeAgent")).toBe(true);
    expect(supportsFullTaskScopedBotDriver("codex")).toBe(true);
    expect(supportsFullTaskScopedBotDriver("piAgent")).toBe(false);
    expect(supportsFullTaskScopedBotDriver("boxAgent")).toBe(false);
  });

  it("creates a deterministic, value-free capability manifest", () => {
    const first = createCapabilityProfileManifest({
      toolInventory: ["sentry", "filesystem", "sentry", "langfuse", "vault:github_token"],
      telemetryMode: "sanitized-content",
    });
    const second = createCapabilityProfileManifest({
      toolInventory: ["vault:github_token", "langfuse", "sentry", "filesystem"],
      telemetryMode: "sanitized-content",
    });
    expect(first).toEqual(second);
    expect(first.toolInventory).toEqual(["filesystem", "langfuse", "sentry", "vault:github_token"]);
    expect(first.hardDenies).toEqual(["catastrophic-destruction", "credential-value-disclosure"]);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.toolInventory).toContain("vault:github_token");
    expect(JSON.stringify(first)).not.toContain("github_pat_actual-credential-value");
  });

  it("derives the advertised telemetry mode from the runtime switch", () => {
    expect(telemetryCaptureMode({ OMB_TELEMETRY_DISABLED: "1" })).toBe("off");
    expect(telemetryCaptureMode({})).toBe("sanitized-content");
  });

  it("preserves protected-input and webhook boundaries in the scoped prompt", () => {
    const prompt = renderFullTaskScopedSystemPrompt(createCapabilityProfileManifest({ telemetryMode: "off" }), {
      retrievalContext: "\n<untrusted-retrieval />",
      protectComputerInput: true,
      untrustedWebhook: true,
    });
    expect(prompt).toContain("protected-input step");
    expect(prompt).toContain("UNTRUSTED WEBHOOK EVENT DATA");
    expect(prompt).toContain("<untrusted-retrieval />");
  });
});
