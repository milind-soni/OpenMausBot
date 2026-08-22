import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FleetCapabilityIndex } from "./fleet-capabilities.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-fleet-caps-"));
  const skill = join(root, "ios-ui-debug", "SKILL.md");
  mkdirSync(join(root, "ios-ui-debug"), { recursive: true });
  writeFileSync(skill, "# safe fixture\n");
  const path = join(root, "capabilities.v1.json");
  writeFileSync(path, JSON.stringify({
    schema: "capabilities.v1",
    generated_at: "2026-08-22T00:00:00Z",
    record_count: 3,
    records: [
      {
        id: "mcp:cupertino",
        kind: "mcp",
        owner: "hermes",
        configured: true,
        compatible_surfaces: ["hermes"],
        enabled_surfaces: ["hermes"],
        output_verified: true,
        source_path: "/secret/config-with-values.json",
      },
      {
        id: "skill:shared:ios-ui-debug",
        kind: "skill",
        owner: "fleet",
        configured: true,
        compatible_surfaces: ["codex", "hermes"],
        enabled_surfaces: ["codex"],
        output_verified: true,
        source_path: skill,
      },
      {
        id: "script:secret",
        kind: "script",
        command_path: join(root, ".ssh", "private-key"),
      },
    ],
  }));
  return path;
}

describe("fleet capability metadata index", () => {
  it("returns one bounded error when the index is absent", () => {
    const missing = join(tmpdir(), "omb-fleet-caps-missing", "capabilities.v1.json");
    expect(() => new FleetCapabilityIndex(missing).summary()).toThrow("fleet capability index is unavailable or oversized");
    try {
      new FleetCapabilityIndex(missing).summary();
    } catch (error) {
      expect(String(error)).not.toContain(missing);
    }
  });

  it("loads only bounded metadata for search and summary", () => {
    const index = new FleetCapabilityIndex(fixture());
    expect(index.summary()).toMatchObject({ recordCount: 3, policy: "metadata-only-and-task-lazy" });
    const results = index.search({ query: "ios debug", kind: "skill" });
    expect(results.map((record) => record.id)).toEqual(["skill:shared:ios-ui-debug"]);
    expect(JSON.stringify(results)).not.toContain("source_path");
    expect(JSON.stringify(results)).not.toContain("/secret/");
  });

  it("selects exactly one skill path or already-mounted MCP lazily", () => {
    const index = new FleetCapabilityIndex(fixture());
    expect(index.select("mcp:cupertino", ["cupertino", "cupertino-codex"])).toMatchObject({
      status: "ready",
      route: { kind: "mcp", serverNames: ["cupertino", "cupertino-codex"] },
    });
    expect(index.select("skill:shared:ios-ui-debug", [])).toMatchObject({
      status: "ready",
      route: { kind: "skill" },
    });
    expect(index.select("script:secret", [])).toMatchObject({ status: "metadata-only" });
  });

  it("suggests relevant role overlays without loading skill bodies", () => {
    const index = new FleetCapabilityIndex(fixture());
    expect(index.suggest("Fix the iPhone SwiftUI layout").roleOverlays[0]?.id).toBe("ios-engineer");
  });
});
