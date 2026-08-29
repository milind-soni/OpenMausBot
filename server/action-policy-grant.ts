import type { ActionPolicy, ActionRule } from "./action-policy.ts";

const ACTION_POLICY_ALLOW_PREFIX = "action-policy:";

export const REMEMBER_EXACT_ACTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function actionPolicyAllowKey(proposalId: string): string {
  const normalized = proposalId.trim();
  if (!normalized) throw new Error("Action policy proposal id is required");
  return `${ACTION_POLICY_ALLOW_PREFIX}${normalized}`;
}

export function proposalIdFromActionPolicyAllowKey(allowKey: string): string | null {
  if (!allowKey.startsWith(ACTION_POLICY_ALLOW_PREFIX)) return null;
  const proposalId = allowKey.slice(ACTION_POLICY_ALLOW_PREFIX.length).trim();
  return proposalId || null;
}

export function rememberExactAction(
  policy: ActionPolicy,
  allowKey: string,
  input: {
    expectedOwnerId: string;
    approvedBy: string;
    approvalEvidence: string;
    approvedAt: number;
    now?: number;
  },
): ActionRule {
  const proposalId = proposalIdFromActionPolicyAllowKey(allowKey);
  if (proposalId === null) throw new Error("Action policy grant key is invalid");
  const proposal = policy.getProposal(proposalId);
  if (proposal === null) throw new Error("Action policy proposal was not found");
  if (proposal.ownerId !== input.expectedOwnerId) {
    throw new Error("Action policy proposal owner does not match this agent");
  }
  const approvedAt = input.approvedAt;
  const candidate = policy.prepareCandidate({
    proposal,
    effect: "allow",
    ownerId: input.expectedOwnerId,
    expiresAt: (input.now ?? approvedAt) + REMEMBER_EXACT_ACTION_MS,
    reason: "User chose to remember this exact prepared action for 30 days",
  });
  return policy.promote(candidate, {
    approvedBy: input.approvedBy,
    approvalEvidence: input.approvalEvidence,
    approvedAt,
  });
}
