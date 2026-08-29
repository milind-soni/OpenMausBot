import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { createIndependentLocalFixtureAdapter } from "./independent-fixture-adapter.ts";
import { runScenario } from "./runner.ts";
import { SCENARIOS } from "./scenarios.ts";

describe("independent local fixture adapter", () => {
  it("proves fresh sandbox postconditions for every representative scenario", async () => {
    const results = await Promise.all(SCENARIOS.map((scenario) => runScenario(scenario, {
      adapterFactory: () => createIndependentLocalFixtureAdapter(),
      retainSandbox: true,
    })));

    try {
      expect(results).toHaveLength(7);
      for (const result of results) {
        expect(result.passed).toBe(true);
        expect(result.evidence.mode).toBe("independent");
        expect(result.evidence.e2eVerified).toBe(true);
        expect(result.evidence.outcomeScore).toBe(100);
        expect(result.metrics.safetyViolations).toBe(0);
        expect(result.events.every((event) => event.data.productionTouched !== true)).toBe(true);
      }
      const privacy = results.find((result) => result.scenario.id === "privacy-approval-boundary");
      expect(privacy?.events.find((event) => event.actionId === "send-external-message")?.status).toBe("blocked");
    } finally {
      await Promise.all(results.map((result) => rm(result.sandbox.root, { recursive: true, force: true })));
    }
  });
});
