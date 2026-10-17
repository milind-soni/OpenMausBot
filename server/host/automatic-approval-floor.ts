import { safetyFloorBlock, safetyFloorClears, shellCommandOfToolCall } from "../safety-floor-gate.ts";
import type { ReviewAction } from "../approval-review.ts";

export function automaticApprovalFloor(action: ReviewAction): {
  decision: "deny" | "ask";
  reason: string;
  rule: string;
} | null {
  const command = shellCommandOfToolCall(action.arguments);
  const block = safetyFloorBlock(command);
  if (block) return { decision: "deny", reason: block.reason, rule: block.rule };
  if (!safetyFloorClears(command)) return {
    decision: "ask",
    reason: "The safety floor could not read this command; your approval is required.",
    rule: "unreadable",
  };
  return null;
}
