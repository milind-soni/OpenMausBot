import { describe, expect, it } from "vitest";
import {
  GROUP_GOAL_CONTROL_CLOSE,
  GROUP_GOAL_CONTROL_OPEN,
  GROUP_GOAL_DECISION_SCHEMA,
  GROUP_GOAL_MAX_TURNS,
  groupGoalAssignmentKey,
  groupGoalDecisionFromStructured,
  groupGoalCompletionTurnId,
  groupGoalCoordinatorInstructions,
  parseGroupGoalDecision,
  resolveGroupGoalMember,
  selectGroupGoalCoordinator,
} from "./group-goal-run.ts";

const members = [
  { id: "scout-id", name: "Scout" },
  { id: "chief-id", name: "Miso", chiefOfStaff: true },
  { id: "old-id", name: "Old", hidden: true },
];

describe("group goal runs", () => {
  it("keeps the bound provider identity when a completion event omits its turn id", () => {
    expect(groupGoalCompletionTurnId(undefined, "bound-turn")).toBe("bound-turn");
    expect(groupGoalCompletionTurnId("event-turn", "bound-turn")).toBe("event-turn");
  });

  it("strips and validates a coordinator decision", () => {
    const parsed = parseGroupGoalDecision(
      `I am asking Scout to verify it.\n${GROUP_GOAL_CONTROL_OPEN}`
      + `{"status":"continue","next":"@Scout","instruction":"Verify the release","detail":"Draft ready"}`
      + GROUP_GOAL_CONTROL_CLOSE,
    );
    expect(parsed.visibleText).toBe("I am asking Scout to verify it.");
    expect(parsed.decision).toEqual({
      status: "continue",
      next: "@Scout",
      instruction: "Verify the release",
      detail: "Draft ready",
    });
  });

  it("fails closed on incomplete or malformed decisions", () => {
    expect(parseGroupGoalDecision("ordinary reply")).toEqual({ visibleText: "ordinary reply", decision: null });
    expect(parseGroupGoalDecision(
      `${GROUP_GOAL_CONTROL_OPEN}{"status":"continue","next":"Scout"}${GROUP_GOAL_CONTROL_CLOSE}`,
    ).decision).toBeNull();
    expect(parseGroupGoalDecision(
      `${GROUP_GOAL_CONTROL_OPEN}{not json}${GROUP_GOAL_CONTROL_CLOSE}`,
    ).decision).toBeNull();
    expect(parseGroupGoalDecision(
      `Safe update\n${GROUP_GOAL_CONTROL_OPEN}{"status":"continue"}`,
    )).toEqual({ visibleText: "Safe update", decision: null });
  });

  it("removes every private envelope while the last complete one controls", () => {
    const parsed = parseGroupGoalDecision(
      `First\n${GROUP_GOAL_CONTROL_OPEN}{"status":"blocked","detail":"old"}${GROUP_GOAL_CONTROL_CLOSE}`
      + `\nFinal\n${GROUP_GOAL_CONTROL_OPEN}{"status":"completed","detail":"done"}${GROUP_GOAL_CONTROL_CLOSE}`,
    );
    expect(parsed.visibleText).toBe("First\n\nFinal");
    expect(parsed.decision).toEqual({ status: "completed", detail: "done" });
  });

  it("honors an explicit active lead, then an in-room Chief", () => {
    expect(selectGroupGoalCoordinator(members, { kind: "member", botId: "scout-id" })?.id).toBe("scout-id");
    expect(selectGroupGoalCoordinator(members, { kind: "everyone" })?.id).toBe("chief-id");
    expect(selectGroupGoalCoordinator(members, { kind: "member", botId: "old-id" })?.id).toBe("chief-id");
  });

  it("resolves only an exact active room member", () => {
    expect(resolveGroupGoalMember("@SCOUT", members)?.id).toBe("scout-id");
    expect(resolveGroupGoalMember("chief-id", members)?.name).toBe("Miso");
    expect(resolveGroupGoalMember("Old", members)).toBeNull();
    expect(resolveGroupGoalMember("Sco", members)).toBeNull();
    expect(resolveGroupGoalMember("Scout", [
      ...members,
      { id: "other-scout", name: "Scout" },
    ])).toBeNull();
    expect(resolveGroupGoalMember("other-scout", [
      ...members,
      { id: "other-scout", name: "Scout" },
    ])?.id).toBe("other-scout");
  });

  it("normalizes repeated assignments for no-progress detection", () => {
    expect(groupGoalAssignmentKey("scout-id", "  Verify   THE release "))
      .toBe(groupGoalAssignmentKey("scout-id", "verify the release"));
  });

  it("reserves the final bounded turn for coordinator evaluation", () => {
    expect(GROUP_GOAL_MAX_TURNS % 2).toBe(1);
  });
});

// Phase 0, item 0.3: the decision is schema-first. A validated object from
// the typed-turn path becomes the decision directly; the prose envelope
// stays as the fallback, and the visible text hides both.
describe("schema-first goal decisions", () => {
  it("builds a decision from a validated structured object, bounded like the envelope path", () => {
    expect(groupGoalDecisionFromStructured({ status: "continue", next: "@Scout", instruction: "Verify", detail: "Draft ready" }))
      .toEqual({ status: "continue", next: "@Scout", instruction: "Verify", detail: "Draft ready" });
    expect(groupGoalDecisionFromStructured({ status: "completed", detail: "done" })).toEqual({ status: "completed", detail: "done" });
    expect(groupGoalDecisionFromStructured({ status: "continue", next: "x".repeat(200), instruction: "go" })?.status).toBe("continue");
    expect((groupGoalDecisionFromStructured({ status: "continue", next: "x".repeat(200), instruction: "go" }) as { next: string }).next).toHaveLength(100);
  });

  it("fails closed on a continue without an assignment, a status without detail, or no object at all", () => {
    expect(groupGoalDecisionFromStructured({ status: "continue", next: "Scout" })).toBeNull();
    expect(groupGoalDecisionFromStructured({ status: "blocked" })).toBeNull();
    expect(groupGoalDecisionFromStructured(undefined)).toBeNull();
    expect(groupGoalDecisionFromStructured("completed")).toBeNull();
  });

  it("publishes the decision schema the harness appends to the coordinator turn", () => {
    expect(GROUP_GOAL_DECISION_SCHEMA).toMatchObject({ type: "object", required: ["status"], additionalProperties: false });
    expect((GROUP_GOAL_DECISION_SCHEMA.properties as any).status.enum).toEqual(["continue", "completed", "needs-input", "blocked"]);
  });

  it("keeps a fenced decision block out of the human-facing text", () => {
    const parsed = parseGroupGoalDecision('Ship it.\n```json\n{"status":"completed","detail":"Typed."}\n```');
    expect(parsed.visibleText).toBe("Ship it.");
    // the prose parser itself still only reads envelopes; the block is the typed path's job
    expect(parsed.decision).toBeNull();
  });

  it("tells the coordinator to answer with the decision block and keeps the envelope as the fallback", () => {
    const text = groupGoalCoordinatorInstructions({ goal: "g", members: [{ id: "lead", name: "Lead" }], turn: 1, maxTurns: 13, remainingTurns: 12 });
    expect(text).toContain("fenced json block");
    expect(text).toContain(GROUP_GOAL_CONTROL_OPEN);
  });
});

describe("groupGoalCoordinatorInstructions harness note", () => {
  const base = {
    goal: "Ship the release notes",
    members: [{ id: "lead", name: "Lead" }, { id: "scout", name: "Scout" }],
    turn: 3,
    maxTurns: 13,
    remainingTurns: 10,
  };

  it("renders a harness note on its own line, before the ledger guidance", () => {
    const lines = groupGoalCoordinatorInstructions({ ...base, note: "Scout stayed busy for 30 minutes" }).split("\n");
    const noteAt = lines.indexOf("Harness note: Scout stayed busy for 30 minutes");
    const ledgerAt = lines.findIndex((line) => line.startsWith("Use the conversation as the progress ledger"));
    expect(noteAt).toBeGreaterThan(-1);
    expect(ledgerAt).toBeGreaterThan(noteAt);
  });

  it("omits the note line entirely when there is nothing to report", () => {
    expect(groupGoalCoordinatorInstructions(base)).not.toContain("Harness note:");
  });
});
