import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseBotPackage } from "./bot-package.ts";

describe("Agent Centipede package", () => {
  const document = parseBotPackage(JSON.parse(readFileSync(resolve("packages/grok-capture.openmaus.json"), "utf8")));

  it("uses product language instead of calling itself a Grok replica", () => {
    expect(document.package.name).toBe("Agent Centipede");
    expect(`${document.package.name} ${document.package.tagline} ${document.package.summary}`).not.toMatch(/grok capture replica/i);
  });

  it("defaults background Capture to actionable-only reporting", () => {
    expect(document.package.agents.find((agent) => agent.key === "capture")?.reportingMode).toBe("actionable");
  });

  it("does not recreate deleted Capture channels on import", () => {
    expect(document.package.rooms).toEqual([]);
  });

  it("keeps Capture handoffs durable without creating peer rooms", () => {
    const quietHandoff = document.package.playbooks?.find((playbook) => playbook.key === "capture-quiet-handoff");
    expect(quietHandoff?.instructions).toContain("Never call delegate_bot");
    expect(quietHandoff?.instructions).toContain("ledger");
    const captureRoutines = (document.package.routines ?? []).filter((routine) => routine.agent === "capture");
    expect(captureRoutines).not.toHaveLength(0);
    expect(captureRoutines.every((routine) => routine.capabilities?.peerBots === "off")).toBe(true);
  });
});
