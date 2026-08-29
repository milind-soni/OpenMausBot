import { describe, expect, it } from "vitest";

import { parseWorkProjection, workSections } from "./work";

describe("work projection", () => {
  it("normalizes the envelope and keeps approval payloads opaque", () => {
    const projection = parseWorkProjection({
      work: {
        generatedAt: 123,
        obligations: [{
          id: "lock-1",
          title: "Prepare release",
          status: "in_progress",
          owner: { id: "agent-a", label: "Builder" },
          approvals: [{ id: "approval-1", prompt: "Approve the draft", status: "pending", payload: { secret: "never render" } }],
          deadlines: [],
          evidence: [{ id: "evidence-1", kind: "test", reference: "ci://run/1", summary: "Checks passed" }],
        }],
        pendingApprovals: [{ id: "approval-1", obligationId: "lock-1", prompt: "Approve the draft", status: "pending", payload: { secret: "never render" } }],
        deadlines: [],
      },
    });

    expect(projection.generatedAt).toBe(123);
    expect(projection.obligations[0]?.owner).toEqual({ id: "agent-a", label: "Builder" });
    expect(projection.pendingApprovals).toHaveLength(1);
    expect(projection.pendingApprovals[0]?.payload).toBeNull();
    expect(projection.obligations[0]?.evidence[0]?.summary).toBe("Checks passed");
  });

  it("groups open, active, and completed obligations without role assumptions", () => {
    const projection = parseWorkProjection({
      generatedAt: 1,
      obligations: [
        { id: "open", title: "Open", status: "open" },
        { id: "blocked", title: "Blocked", status: "blocked" },
        { id: "active", title: "Active", status: "in_progress" },
        { id: "done", title: "Done", status: "completed" },
      ],
    });

    expect(workSections(projection)).toMatchObject({
      openLocks: expect.arrayContaining([expect.objectContaining({ id: "open" }), expect.objectContaining({ id: "blocked" })]),
      activeWork: [expect.objectContaining({ id: "active" })],
      completed: [expect.objectContaining({ id: "done" })],
      approvals: [],
    });
  });

  it("fails closed to an empty view for malformed API data", () => {
    expect(parseWorkProjection(null)).toEqual({ generatedAt: 0, obligations: [], pendingApprovals: [], deadlines: [] });
    expect(parseWorkProjection({ work: { obligations: [{ title: "missing id" }] } }).obligations).toEqual([]);
  });
});
