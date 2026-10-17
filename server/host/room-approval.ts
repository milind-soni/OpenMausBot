import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { BotRecord } from "../store.ts";
import type { HandoffView } from "../coordinator.ts";

export function createRoomApprovalModes(deps: {
  node(id: string): HandoffView | undefined;
  bot(id: string): BotRecord | null | undefined;
  cloudGuestDriven(threadId: string): boolean;
  approvalModeForTurn(bot: BotRecord, peerInitiated: boolean, threadId: string): ApprovalMode;
  delegatedLevel(from: BotRecord, sourceThreadId: string, target: BotRecord, own: ApprovalMode): ApprovalMode | null;
}) {
  function roomTurnApprovalMode(bot: BotRecord, threadId: string, orchestration?: { roomHandoffId?: string }): ApprovalMode {
    const handoff = orchestration?.roomHandoffId ? deps.node(orchestration.roomHandoffId) : undefined;
    const source = handoff?.parentId ? deps.node(handoff.parentId) : undefined;
    return roomTurnLevel(bot, threadId, source);
  }

  function roomTurnLevel(bot: BotRecord, threadId: string, source: Pick<HandoffView, "botId" | "threadId"> | undefined): ApprovalMode {
    if (deps.cloudGuestDriven(threadId)) return "ask";
    const from = source ? deps.bot(source.botId) : undefined;
    const own = deps.approvalModeForTurn(bot, source !== undefined, threadId);
    return (from && source && deps.delegatedLevel(from, source.threadId, bot, own)) || own;
  }

  return { roomTurnApprovalMode, roomTurnLevel };
}
