import { describe, expect, it } from "vitest";

import { buildAgentGraphDraft, type AgentGraphRouteCandidate } from "./agent-graph-planner.ts";

const identity = `sha256:${"a".repeat(64)}`;
const authorityDigest = `sha256:${"d".repeat(64)}`;

const codex: AgentGraphRouteCandidate = {
  botId: "codex-bot", instanceId: "codex-instance", engine: "codexAgent", model: "gpt-test", workspaceRoot: "/tmp/codex", workspaceIdentity: identity, authorityDigest, name: "Builder", title: "Code Engineer", chiefOfStaff: false, hermes: false,
};
const chief: AgentGraphRouteCandidate = {
  botId: "chief-bot", instanceId: "chief-instance", engine: "claudeAgent", model: "sonnet-test", workspaceRoot: "/tmp/chief", workspaceIdentity: identity, authorityDigest, name: "Ada", title: "Operations", chiefOfStaff: true, hermes: false,
};
const hermes: AgentGraphRouteCandidate = {
  botId: "hermes-bot", instanceId: "hermes-instance", engine: "hermesAgent", model: "local-test", workspaceRoot: "/tmp/hermes", workspaceIdentity: identity, authorityDigest, name: "Hermes Research", title: "Memory Analyst", chiefOfStaff: false, hermes: true,
};

describe("agent graph deterministic planner", () => {
  it("creates a bounded two-wide DAG and treats Hermes as an ordered optional specialist", () => {
    const graph = buildAgentGraphDraft({ objective: "Improve the observer", proposalIds: ["proposal-1"], goalId: "goal-1" }, [codex, chief, hermes]);
    expect(graph.maxParallel).toBe(2);
    expect(graph.nodes.map((node) => [node.id, node.dependsOn])).toEqual([
      ["inspect", []],
      ["plan", []],
      ["implement", ["inspect", "plan"]],
      ["verify", ["implement"]],
    ]);
    const verify = graph.nodes.find((node) => node.id === "verify")!;
    expect(verify.permissionClass).toBe("read");
    expect(verify.successCriteria).toContain("Exact changed files and content hashes satisfy the approved acceptance criteria");
    expect(verify.proofRequirements).toEqual([
      "Exact read-only file and content-hash evidence plus the host-verified acceptance receipt",
    ]);
    expect(`${verify.successCriteria.join(" ")} ${verify.proofRequirements.join(" ")}`).not.toMatch(/\bcommands?\b|exit status/i);
    expect(graph.nodes[0]?.routes[0]?.botId).toBe("hermes-bot");
    expect(graph.nodes[1]?.routes[0]?.botId).toBe("chief-bot");
    expect(graph.nodes[2]?.routes[0]?.botId).toBe("codex-bot");
    expect(graph.nodes.every((node) => node.routes.some((route) => route.botId !== "hermes-bot"))).toBe(true);
  });

  it("works without Hermes and refuses to invent a route", () => {
    const graph = buildAgentGraphDraft({ objective: "Verify fallback" }, [codex, chief]);
    expect(graph.nodes.flatMap((node) => node.routes).some((route) => route.engine === "hermesAgent")).toBe(false);
    expect(() => buildAgentGraphDraft({ objective: "No route" }, [])).toThrow(/no admitted/);
  });
});
