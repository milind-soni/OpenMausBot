import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import { delegatedApprovalMode } from "../auto-approve.ts";
import type { BotRecord } from "../store.ts";

export const DELEGATED_LEVEL_NAMES: Partial<Record<ApprovalMode, string>> = { edits: "Auto-accept edits", auto: "Approve for me", full: "Full access" };

export function createDelegatedLevel(deps: {
  sourceApprovalMode(botId: string, threadId: string): ApprovalMode;
  driverKind(instanceId: string): string | undefined;
}) {
  return (from: BotRecord, sourceThreadId: string, target: BotRecord, own: ApprovalMode): ApprovalMode | null => {
    // Custom holds the restrictions the person wrote; a peer turn reads it as Auto, which a Chief's level must not raise.
    if (approvalModeFor(target) === "custom") return null;
    return delegatedApprovalMode({
      senderIsChief: Boolean(from.chiefOfStaff),
      senderMode: deps.sourceApprovalMode(from.id, sourceThreadId),
      sameBot: from.id === target.id,
      recipientMode: own,
      recipientDriverKind: deps.driverKind(target.modelSelection.instanceId),
    });
  };
}
