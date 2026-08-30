import { describe, expect, it } from "vitest";

import { validateSequentialPlan } from "../graph.ts";
import type { WorkItemSnapshot } from "../snapshot.ts";
import { ConfiguredSequentialPlanner, configuredPlanningPolicy } from "./configured-planner.ts";

describe("configured sequential planner", () => {
  it("turns a confirmed pilot definition into the fixed four-node plan", () => {
    const options = {
      repository: "/pilot/repository",
      writeScopes: ["pilot-output.txt"],
      targetCommandIds: ["pilot:target"],
    };
    const snapshot: WorkItemSnapshot = {
      workItemId: "WI-1",
      revision: 1,
      sourceWorkItemVersion: 1,
      goal: "output hello pilot",
      goalConfirmed: true,
      repository: options.repository,
      facts: ["requested in DingTalk"],
      assumptions: [],
      acceptanceConditions: [{ description: "output exists", observation: "pilot target passes" }],
      blockingAmbiguities: [],
      createdAt: 1,
    };
    const proposal = new ConfiguredSequentialPlanner(options).propose(snapshot);
    expect(validateSequentialPlan(proposal, configuredPlanningPolicy(options)).nodes.map((node) => node.type)).toEqual([
      "analyze", "modify", "validate", "report",
    ]);
    expect(proposal.nodes[1].writeScope).toEqual(["pilot-output.txt"]);
    expect(proposal.nodes[2].commands).toEqual(["pilot:target"]);
    expect(proposal.summary).toBe("output hello pilot");
    expect(proposal.summary).not.toContain(options.repository);
  });
});
