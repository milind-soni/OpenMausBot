import type { DatabaseSync } from "node:sqlite";

import type { DingTalkSender } from "../integrations/dingtalk/types.ts";
import { resolveDingTalkPrincipal } from "./identity.ts";

export type OwnerCapability =
  | "control.consume"
  | "work.pause"
  | "work.resume"
  | "work.retry"
  | "work.cancel"
  | "candidate.accept"
  | "candidate.reject"
  | "system.admin";

export type WorkItemControlAction = "pause" | "resume" | "retry" | "cancel" | "accept" | "reject";

const ACTION_CAPABILITIES: Readonly<Record<WorkItemControlAction, OwnerCapability>> = {
  pause: "work.pause",
  resume: "work.resume",
  retry: "work.retry",
  cancel: "work.cancel",
  accept: "candidate.accept",
  reject: "candidate.reject",
};

export interface OwnerPolicyDecision {
  decision: "allow" | "deny";
  ruleId: "single-active-owner-v1";
  reason: "owner_authorized" | "stable_identity_required" | "owner_not_configured" | "not_active_owner";
  capability: OwnerCapability;
  principalId: string;
  ownerGeneration: number | null;
}

interface ActiveOwnerRow {
  sender_corp_id: string;
  sender_staff_id: string;
  generation: number;
}

export function capabilityForAction(action: WorkItemControlAction): OwnerCapability {
  return ACTION_CAPABILITIES[action];
}

export function evaluateOwnerPolicy(
  database: DatabaseSync,
  input: { sender: DingTalkSender; capability: OwnerCapability; now: number },
): OwnerPolicyDecision {
  const principal = resolveDingTalkPrincipal(database, input.sender, input.now);
  const owner = database
    .prepare(
      "SELECT sender_corp_id, sender_staff_id, generation " +
        "FROM collaboration_owner_bindings WHERE active = 1",
    )
    .get() as ActiveOwnerRow | undefined;
  if (!owner) {
    return {
      decision: "deny",
      ruleId: "single-active-owner-v1",
      reason: "owner_not_configured",
      capability: input.capability,
      principalId: principal.id,
      ownerGeneration: null,
    };
  }
  const senderCorpId = input.sender.senderCorpId?.trim() ?? "";
  const senderStaffId = input.sender.senderStaffId?.trim() ?? "";
  if (!senderCorpId || !senderStaffId || principal.resolution !== "resolved") {
    return {
      decision: "deny",
      ruleId: "single-active-owner-v1",
      reason: "stable_identity_required",
      capability: input.capability,
      principalId: principal.id,
      ownerGeneration: owner.generation,
    };
  }
  const allowed = owner.sender_corp_id === senderCorpId && owner.sender_staff_id === senderStaffId;
  return {
    decision: allowed ? "allow" : "deny",
    ruleId: "single-active-owner-v1",
    reason: allowed ? "owner_authorized" : "not_active_owner",
    capability: input.capability,
    principalId: principal.id,
    ownerGeneration: owner.generation,
  };
}
