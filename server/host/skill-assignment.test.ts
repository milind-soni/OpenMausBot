import { describe, expect, it, vi } from "vitest";
import { changeSkillAssignment, listSkillAssignments, type AssignmentBot, type AssignmentDeps, type AssignmentSkill } from "./skill-assignment.ts";

function fixture() {
  const chief: AssignmentBot = { id: "chief", assignedSkills: ["audit"] };
  const peer: AssignmentBot = { id: "peer", assignedSkills: ["unchanged"] };
  const other: AssignmentBot = { id: "other", assignedSkills: ["private-team-skill"] };
  const bots = new Map([chief, peer, other].map((bot) => [bot.id, bot]));
  const audit: AssignmentSkill = { name: "audit", everyBot: false, enabled: true, sha256: "body", filesSha256: "files" };
  const optOut = new Set<string>();
  const privateNames = new Set<string>();
  let mayManage = true;
  const save = vi.fn((id: string, assignedSkills: string[]) => {
    const bot = bots.get(id);
    if (!bot) return null;
    bot.assignedSkills = assignedSkills;
    return bot;
  });
  const deps: AssignmentDeps = {
    resolveTarget: (from, target) => mayManage && from === "chief" && target === "peer" ? peer : null,
    bot: (id) => bots.get(id) ?? null,
    listLibrary: () => [audit, { name: "private-team-skill", everyBot: false, enabled: true, sha256: "other" }],
    ownNames: (id) => id === "peer" ? privateNames : new Set<string>(),
    optedOut: (id) => id === "peer" ? optOut : new Set<string>(),
    save,
    validAssignments: (names) => names.length <= 200,
  };
  const list = (query?: string) => listSkillAssignments(deps, "chief", "peer", query)!.library;
  const row = () => list("audit")[0]!;
  const change = (action: "share" | "assign" | "unassign", revision = row().management_revision) =>
    changeSkillAssignment(deps, "chief", "peer", action, "audit", revision);
  return { deps, list, row, change, chief, peer, other, audit, optOut, privateNames, save, revoke: () => { mayManage = false; } };
}

describe("explicit shared skill assignments", () => {
  it("shares and unassigns only the named skill and agrees with the live listing", () => {
    const x = fixture();
    expect(x.list().map((skill) => skill.name)).toEqual(["audit", "unchanged"]);
    expect(x.change("share")).toMatchObject({ status: 200, result: { skill: { assigned: true, available: true } } });
    expect(x.peer.assignedSkills).toEqual(["unchanged", "audit"]);
    expect(x.change("assign")).toMatchObject({ status: 200, result: { skill: x.row() } });
    expect(x.save).toHaveBeenCalledTimes(1);
    expect(x.change("unassign")).toMatchObject({ status: 200, result: { skill: { assigned: false, available: false } } });
    expect(x.peer.assignedSkills).toEqual(["unchanged"]);
    expect(x.chief.assignedSkills).toEqual(["audit"]);
    expect(x.other.assignedSkills).toEqual(["private-team-skill"]);
  });

  it("does not change every-bot scope or the target's opt-out", () => {
    const x = fixture();
    x.audit.everyBot = true;
    expect(x.change("assign")).toMatchObject({ status: 200 });
    expect(x.change("unassign")).toMatchObject({ status: 200, result: { skill: { assigned: false, available: true } } });
    x.optOut.add("audit");
    expect(x.change("share")).toMatchObject({ status: 200, result: { skill: { assigned: true, available: true } } });
    expect(x.change("unassign")).toMatchObject({ status: 200, result: { skill: { assigned: false, available: false } } });
    expect(x.optOut.has("audit")).toBe(true);
    expect(x.audit.everyBot).toBe(true);
  });

  it("rejects stale package state and revoked management scope before writing", () => {
    const x = fixture();
    const revision = x.row().management_revision;
    x.audit.filesSha256 = "new-files";
    expect(x.change("assign", revision)).toMatchObject({ status: 409 });
    const fresh = x.row().management_revision;
    x.revoke();
    expect(listSkillAssignments(x.deps, "chief", "peer")).toBeNull();
    expect(x.change("assign", fresh)).toMatchObject({ status: 403 });
    expect(x.save).not.toHaveBeenCalled();
  });

  it("refuses adding a private shadow or invalid package but removes a stale explicit assignment", () => {
    const x = fixture();
    x.privateNames.add("audit");
    expect(x.change("assign")).toMatchObject({ status: 422 });
    expect(x.save).not.toHaveBeenCalled();
    x.peer.assignedSkills = ["unchanged", "audit"];
    x.audit.enabled = false;
    expect(x.change("unassign")).toMatchObject({ status: 200, result: { skill: { shadowed: true, assigned: false, enabled: false } } });
    expect(x.peer.assignedSkills).toEqual(["unchanged"]);
    expect(x.privateNames.has("audit")).toBe(true);
  });

  it("enforces the cap without blocking an idempotent assignment or changing the prior list", () => {
    const x = fixture();
    const prior = Array.from({ length: 199 }, (_, i) => `skill-${i}`);
    x.peer.assignedSkills = prior;
    expect(x.change("assign")).toMatchObject({ status: 200 });
    expect(x.change("assign")).toMatchObject({ status: 200 });
    expect(x.save).toHaveBeenCalledTimes(1);
    x.peer.assignedSkills = [...prior, "extra"];
    expect(x.change("assign")).toMatchObject({ status: 422 });
    expect(x.peer.assignedSkills).toEqual([...prior, "extra"]);
    expect(x.save).toHaveBeenCalledTimes(1);
  });

  it("does not report success when persisting the assignment fails", () => {
    const x = fixture();
    x.save.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(x.change("share")).toMatchObject({ status: 500 });
    expect(x.peer.assignedSkills).toEqual(["unchanged"]);
  });
});
