import { describe, expect, it, vi } from "vitest";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { approvalModeForOrigin } from "../auto-approve.ts";
import type { BotRecord, Store } from "../store.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { createDelegatedApprovals } from "./delegated-approval.ts";

const fixture = (custom = false, outside = false) => {
  const chief = { id: "chief", name: "Chief", chiefOfStaff: true, approvalMode: "full", modelSelection: { instanceId: "codex" } } as BotRecord;
  const member = { id: "member", name: "Member", approvalMode: custom ? "custom" : "ask", modelSelection: { instanceId: "codex" } } as BotRecord;
  const bots = new Map([[chief.id, chief], [member.id, member]]);
  const patchTask = vi.fn();
  const store = { bot: (id: string) => bots.get(id), projectBotForTask: (id: string) => bots.get(id), taskByThread: () => ({ approvalMode: "ask" }), patchTask, appendMessage: vi.fn() } as unknown as Store;
  const nodes = new Map<string, Partial<HandoffView>>([
    ["root", { id: "root", rootId: "root", botId: chief.id, threadId: "source", origin: outside ? { kind: "outside" } : { kind: "user", request: "Perform this synthetic assignment." } }],
    ["handoff", { id: "handoff", rootId: "root", parentId: "root", botId: member.id, threadId: "destination", mode: "work", level: "full" }],
  ]);
  const coordinator = { node: (id: string) => nodes.get(id) } as unknown as Coordinator;
  const levels = createDelegatedApprovals({ store: () => store, coordinator: () => coordinator, driverKind: () => "codex", cloudGuestDriven: () => false,
    sourceApprovalMode: () => approvalModeFor(chief), approvalModeForTurn: (bot, peerInitiated) => approvalModeForOrigin(approvalModeFor(bot), { peerInitiated: Boolean(peerInitiated) }) });
  return { nodes, levels, chief, member, patchTask, source: { botId: chief.id, threadId: "source" } };
};

describe("delegated connector authority", () => {
  it.each(["person", "routine"] as const)("inherits a Chief grant for an authorized %s lineage", origin => {
    const f = fixture();
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source, origin)).toBe("full");
  });
  it("retains routine authority despite the legacy outside evidence view", () => {
    const f = fixture();
    Object.assign(f.nodes.get("root")!, { origin: { kind: "outside" }, originKind: "routine" });
    expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("full");
  });
  it("does not borrow a Chief grant for outside work or an unknown lineage", () => {
    const f = fixture(false, true);
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source, "outside")).toBe("ask");
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source)).toBe("ask");
    expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("ask");
    expect(f.patchTask).not.toHaveBeenCalled();
  });
  it("does not elevate a Custom recipient after peer normalization", () => {
    const f = fixture(true);
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source, "person")).toBe("auto");
    expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("auto");
    expect(f.patchTask).not.toHaveBeenCalled();
  });
});

it("keeps delegated authority transient and rechecks revocation and consultation", () => {
  const f = fixture();
  expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("full");
  f.chief.approvalMode = "ask";
  expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("ask");
  f.chief.approvalMode = "full";
  Object.assign(f.nodes.get("handoff")!, { mode: "consult" });
  expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("ask");
  expect(f.levels.roomTurnLevel(f.member, "destination", f.source, "person", "consult")).toBe("ask");
  expect(f.levels.roomTurnApprovalMode(f.member, "destination")).toBe("ask");
  expect(f.patchTask).not.toHaveBeenCalled();
});

it("does not exceed the queued assignment's grant ceiling", () => {
  const f = fixture();
  Object.assign(f.nodes.get("handoff")!, { level: "auto" });
  expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("auto");
});
