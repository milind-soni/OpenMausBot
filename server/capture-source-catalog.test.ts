import { describe, expect, it } from "vitest";

import {
  CAPTURE_SOURCE_CATALOG,
  captureSourceDefinition,
  evaluateCaptureReadiness,
  hasReadOnlyLocalCaptureGrant,
} from "./capture-source-catalog.ts";

describe("capture source catalog", () => {
  it("keeps the package's requested sources stable and credential-free", () => {
    expect(CAPTURE_SOURCE_CATALOG.map((source) => source.id)).toEqual([
      "gmail-account-1",
      "gmail-account-2",
      "gmail-account-3",
      "calendar-account-1",
      "calendar-account-2",
      "calendar-account-3",
      "drive-account-1",
      "drive-account-2",
      "drive-account-3",
      "github",
      "plaud",
      "google-messages",
      "monarch",
      "mercury",
      "chrome-history",
      "youtube",
      "ai-chatgpt",
      "ai-claude",
      "ai-grok",
      "ai-gemini",
      "whoop",
      "anvil-bi",
      "telegram-relay",
      "hevy",
      "local-inbox",
      "grok-corpus",
      "grok-bot-os",
    ]);
    expect(JSON.stringify(CAPTURE_SOURCE_CATALOG)).not.toMatch(/token|secret|password|cookie/i);
  });

  it("reports connector, browser, and local blockers independently", () => {
    const result = evaluateCaptureReadiness({
      connectedConnectors: ["gmail", "googlecalendar"],
      browserOrigins: ["https://plaud.ai", "https://youtube.com"],
      localCapabilities: ["chrome-history", "local-inbox"],
    });
    expect(result.find((source) => source.sourceId === "gmail-account-1")?.readiness).toBe("ready");
    expect(result.find((source) => source.sourceId === "drive-account-1")?.readiness).toBe("needs-auth");
    expect(result.find((source) => source.sourceId === "plaud")?.readiness).toBe("ready");
    expect(result.find((source) => source.sourceId === "whoop")?.readiness).toBe("unavailable");
  });

  it("reports Plaud ready through its authenticated local CLI without a browser tab", () => {
    const [plaud] = evaluateCaptureReadiness({ localCapabilities: ["plaud-cli"] }, ["plaud"]);
    expect(plaud).toEqual({ sourceId: "plaud", label: "Plaud", readiness: "ready" });
  });

  it("reports Mercury ready through the local Anvil adapter without a browser tab", () => {
    const [mercury] = evaluateCaptureReadiness({ localCapabilities: ["anvil-bi"] }, ["mercury"]);
    expect(mercury).toEqual({ sourceId: "mercury", label: "Mercury", readiness: "ready" });
  });

  it("reports Google Messages ready through the paired-phone mirror without a browser tab", () => {
    const [messages] = evaluateCaptureReadiness({ localCapabilities: ["notification-mirror"] }, ["google-messages"]);
    expect(messages).toEqual({ sourceId: "google-messages", label: "Google Messages", readiness: "ready" });
  });

  it("uses browser only as a fallback when a local transport is not available", () => {
    const [plaud] = evaluateCaptureReadiness({ browserOrigins: ["https://app.plaud.ai"] }, ["plaud"]);
    const [mercury] = evaluateCaptureReadiness({ browserOrigins: ["https://app.mercury.com"] }, ["mercury"]);
    expect(plaud?.readiness).toBe("ready");
    expect(mercury?.readiness).toBe("ready");
  });

  it("does not treat an unknown id as ready", () => {
    expect(evaluateCaptureReadiness({}, ["future-source"])).toEqual([
      { sourceId: "future-source", label: "future-source", readiness: "unavailable", reason: "Unknown capture source id" },
    ]);
    expect(captureSourceDefinition("future-source")).toBeNull();
  });

  it("requires the exact browser host or one of its subdomains", () => {
    const [lookalike] = evaluateCaptureReadiness(
      { browserOrigins: ["https://youtube.com.attacker.example"] },
      ["youtube"],
    );
    const [subdomain] = evaluateCaptureReadiness(
      { browserOrigins: ["https://www.youtube.com/watch?v=1"] },
      ["youtube"],
    );
    expect(lookalike?.readiness).toBe("needs-auth");
    expect(subdomain?.readiness).toBe("ready");
  });

  it("grants read-only local capture to the reviewed package without granting CUA", () => {
    expect(hasReadOnlyLocalCaptureGrant({
      installedPackage: { id: "shane-grok-capture-replica" },
      playbooks: [{ key: "capture-protocol" }],
    })).toBe(true);
    expect(hasReadOnlyLocalCaptureGrant({
      installedPackage: { id: "shane-grok-capture-replica" },
      playbooks: [{ key: "chief-execution-contract" }],
    })).toBe(false);
    expect(hasReadOnlyLocalCaptureGrant({ installedPackage: { id: "other-package" } })).toBe(false);
    expect(hasReadOnlyLocalCaptureGrant({})).toBe(false);
  });
});
