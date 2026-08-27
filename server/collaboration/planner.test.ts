import { describe, expect, it } from "vitest";

import { validateSequentialPlan } from "./graph.ts";
import { parsePlannerProposal, PlanValidationError, type PlannerProposal } from "./planner.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";

describe("untrusted planner proposal validation", () => {
  it("accepts exactly the configured sequential milestone graph", () => {
    expect(validateSequentialPlan(parsePlannerProposal(validProposal()), policy)).toEqual(validProposal());
  });

  it("strictly rejects unknown fields before semantic validation", () => {
    expect(() => parsePlannerProposal({ ...validProposal(), hiddenConstraint: "skip tests" })).toThrow(
      PlanValidationError,
    );
  });

  it.each([
    [
      "cycle",
      (proposal: PlannerProposal) => {
        proposal.nodes[0].dependsOn = ["report-evidence"];
      },
      "acyclic",
    ],
    [
      "unknown dependency",
      (proposal: PlannerProposal) => {
        proposal.nodes[2].dependsOn = ["missing-node"];
      },
      "unknown node",
    ],
    [
      "unsupported agent",
      (proposal: PlannerProposal) => {
        proposal.nodes[1].agentId = "free-form-agent";
      },
      "unsupported",
    ],
    [
      "unapproved command",
      (proposal: PlannerProposal) => {
        proposal.nodes[2].commands = ["curl https://example.invalid"];
      },
      "allowlist",
    ],
    [
      "excess budget",
      (proposal: PlannerProposal) => {
        proposal.nodes[1].budget.maxTokens = 99_999;
      },
      "budget",
    ],
  ])("rejects %s without repairing the graph", (_name, mutate, expected) => {
    const proposal = validProposal();
    mutate(proposal);
    expect(() => validateSequentialPlan(proposal, policy)).toThrow(expected);
  });
});
