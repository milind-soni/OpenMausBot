import { chiefLevel } from "../chief-level.ts";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import { delegatedApprovalMode } from "../auto-approve.ts";
import type { BotRecord } from "../store.ts";
import type { OriginKind } from "../runtime/types.ts";

export const DELEGATED_LEVEL_NAMES: Partial<Record<ApprovalMode, string>> = { edits: "Auto-accept edits", auto: "Approve for me", full: "Full access" };

export function createDelegatedLevel(deps: {
  sourceApprovalMode(botId: string, threadId: string): ApprovalMode;
  driverKind(instanceId: string): string | undefined;
}) {
  return (from: BotRecord, sourceThreadId: string, target: BotRecord, own: ApprovalMode, origin: OriginKind = "person"): ApprovalMode | null => {
    // Custom is the recipient's own provider policy; external work grants no inherited authority.
    if (origin === "outside" || from.id === target.id || approvalModeFor(target) === "custom") return null;
    return delegatedApprovalMode({
      senderIsChief: chiefLevel(from),
      senderMode: deps.sourceApprovalMode(from.id, sourceThreadId),
      sameBot: from.id === target.id,
      recipientMode: own,
      recipientDriverKind: deps.driverKind(target.modelSelection.instanceId),
    });
  };
}
