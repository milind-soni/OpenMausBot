import { delegationOriginKind } from "./delegation-origin.ts";
import { delegatedApprovalMode } from "../auto-approve.ts";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import type { BotRecord, Store } from "../store.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import type { ModelSelection } from "../contracts.ts";

export function createDelegatedApprovals(deps: {
  store(): Store;
  coordinator(): Coordinator;
  driverKind(selection: ModelSelection): string | undefined;
  cloudGuestDriven(threadId: string): boolean;
  sourceApprovalMode(botId: string, threadId: string): ApprovalMode;
  approvalModeForTurn(bot: BotRecord, peerInitiated?: boolean, threadId?: string): ApprovalMode;
}) {
// Only authorized Chief work can inherit a grant; outside work and Custom recipients keep their own policy.
function delegatedLevel(from: BotRecord, fromThreadId: string, target: BotRecord, recipientMode: ApprovalMode, origin: "person" | "routine" | "outside" = "person"): ApprovalMode | null {
  if (origin === "outside" || approvalModeFor(target) === "custom") return null;
  return delegatedApprovalMode({
    senderIsChief: Boolean(from.chiefOfStaff),
    senderMode: deps.sourceApprovalMode(from.id, fromThreadId),
    sameBot: from.id === target.id,
    recipientMode,
    recipientDriverKind: deps.driverKind(target.modelSelection),
  });
}

 function roomTurnApprovalMode(bot: BotRecord, threadId: string, orchestration?: { roomHandoffId?: string }): ApprovalMode {
  const handoff = orchestration?.roomHandoffId ? deps.coordinator().node(orchestration.roomHandoffId) : undefined;
  const source = handoff?.parentId ? deps.coordinator().node(handoff.parentId) : undefined;
  const origin = delegationOriginKind(handoff ? deps.coordinator().node(handoff.rootId) : undefined);
  return roomTurnLevel(bot, threadId, source, origin, handoff?.mode, handoff?.parentId ? handoff.level : undefined);
}

 function roomTurnLevel(bot: BotRecord, threadId: string, source: Pick<HandoffView, "botId" | "threadId"> | undefined, origin: "person" | "routine" | "outside" = "outside", mode?: HandoffView["mode"], ceiling?: ApprovalMode): ApprovalMode {
  if (deps.cloudGuestDriven(threadId)) return "ask";
  const from = source ? deps.store().bot(source.botId) : undefined;
  const recipient = deps.store().projectBotForTask(bot.id, threadId) ?? bot;
  const own = deps.approvalModeForTurn(recipient, source !== undefined, threadId);
  const level = (mode !== "consult" && from && source && delegatedLevel(from, source.threadId, recipient, own, origin)) || own;
  const ranks: Partial<Record<ApprovalMode, number>> = { ask: 0, edits: 1, auto: 2, full: 3 };
  return ceiling && (ranks[level] ?? -1) > (ranks[ceiling] ?? -1) ? ceiling : level;
}


  return { delegatedLevel, roomTurnApprovalMode, roomTurnLevel };
}
