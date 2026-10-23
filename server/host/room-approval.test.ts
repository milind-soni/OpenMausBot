import { view } from "../runtime-coordinator.ts";
import type { Assignment } from "../runtime/types.ts";
import { describe, expect, it, vi } from "vitest";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { approvalModeForOrigin } from "../auto-approve.ts";
import type { BotRecord } from "../store.ts";
import type { HandoffView } from "../coordinator.ts";
import type { WorkOrigin } from "../peer-provenance.ts";
import { createDelegatedLevel } from "./delegated-level.ts";
import { createRoomApprovalModes } from "./room-approval.ts";

function fixture(origin?: WorkOrigin) {
  const chief = { id: "chief", chiefOfStaff: true, approvalMode: "full", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
  const member = { id: "member", approvalMode: "ask", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
  const root = { id: "root", rootId: "root", botId: chief.id, threadId: "source", origin } as HandoffView;
  const handoff = { id: "child", parentId: root.id, rootId: root.id, botId: member.id, threadId: "room", level: "full", mode: "work" } as HandoffView;
  const nodes = new Map([[root.id, root], [handoff.id, handoff]]);
  const delegatedLevel = vi.fn(createDelegatedLevel({ sourceApprovalMode: () => "full", driverKind: () => "claudeAgent" }));
  const modes = createRoomApprovalModes({ node: id => nodes.get(id), bot: id => id === chief.id ? chief : member,
    cloudGuestDriven: () => false,
    approvalModeForTurn: (bot, peerInitiated) => approvalModeForOrigin(approvalModeFor(bot), { peerInitiated }), delegatedLevel });
  return { chief, member, root, handoff, delegatedLevel, ...modes };
}

describe("room approval lineage", () => {
  it("forwards the root's person authority rather than the handoff's missing origin", () => {
    const f = fixture({ kind: "user", request: "Do this scoped work." });
    expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("full");
    expect(f.delegatedLevel).toHaveBeenCalledWith(f.chief, "source", f.member, "ask", "person");
  });
  it.each([undefined, { kind: "outside" } as const])("keeps missing or outside root authority from inheriting a grant (%j)", origin => {
    const f = fixture(origin);
    expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("ask");
    expect(f.delegatedLevel).toHaveBeenCalledWith(f.chief, "source", f.member, "ask", "outside");
  });
  it("defaults an unclassified room source to outside while preserving explicit person/routine origins", () => {
    const f = fixture();
    expect(f.roomTurnLevel(f.member, "room", f.root)).toBe("ask");
    expect(f.roomTurnLevel(f.member, "room", f.root, "person")).toBe("full");
    expect(f.roomTurnLevel(f.member, "room", f.root, "routine")).toBe("full");
  });
  it("inherits legitimate routine authority from the actual runtime projection without claiming a user request", () => {
    const f = fixture();
    const assignment: Assignment = {
      id: f.root.id, rootId: f.root.id, depth: 0,
      origin: { kind: "routine", source: "routine", ref: "routine-fixture" },
      requester: { kind: "routine_run", runId: "run-fixture" },
      assignee: { botId: f.chief.id, destination: { kind: "standing_thread", threadId: "source" } },
      mode: "work", reply: "resume", brief: "Run scoped routine work", status: "running", level: "full", levelSource: "own",
      executions: 1, restarts: 0, createdAt: 1, lastActivityAt: 1, result: "", rework: false, version: 1,
    };
    const projected = view(assignment);
    expect(projected.origin).toEqual({ kind: "outside" });
    expect(projected.originKind).toBe("routine");
    Object.assign(f.root, projected);
    expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("full");
    expect(f.delegatedLevel).toHaveBeenCalledWith(f.chief, "source", f.member, "ask", "routine");
    const custom = { ...f.member, approvalMode: "custom" as const };
    expect(f.roomTurnApprovalMode(custom, "room", { roomHandoffId: f.handoff.id })).toBe("auto");
  });

  it("preserves a Custom recipient's peer Auto projection instead of inheriting Full", () => {
    const f = fixture({ kind: "user", request: "Do this scoped work." });
    const custom = { ...f.member, approvalMode: "custom" as const };
    expect(f.roomTurnApprovalMode(custom, "room", { roomHandoffId: f.handoff.id })).toBe("auto");
    expect(f.delegatedLevel).toHaveBeenCalledWith(f.chief, "source", custom, "auto", "person");
  });
});

it("keeps execution within the recorded ceiling and consultations within the recipient grant", () => {
  const f = fixture({ kind: "user", request: "Do scoped work." });
  f.handoff.level = "auto";
  expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("auto");
  f.handoff.mode = "consult";
  expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("ask");
});
