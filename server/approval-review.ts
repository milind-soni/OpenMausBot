import { approvalReviewEffortLevels, defaultApprovalReviewEffort, type ApprovalReviewSettings } from "../shared/approval-review.ts";
import type { CheckpointRequirement } from "../shared/checkpoint.ts";
import type { ModelSelection, WireMessage } from "../shared/wire.ts";
import type { ProviderInstance, TextGenerationUsage } from "./contracts.ts";
import { contextWindowFor } from "./context-budget.ts";
import { APPROVAL_REVIEW_RUBRIC } from "../shared/approval-review-policy.ts";

export interface ReviewAction {
  tool: string;
  arguments: Record<string, unknown>;
  description?: string;
}
export interface ReviewVerdict { decision: "allow" | "ask" | "deny"; reason: string }

export { APPROVAL_REVIEW_RUBRIC } from "../shared/approval-review-policy.ts";

function genuineUser(message: WireMessage): boolean {
  return message.role === "user" && message.kind === "text" && Boolean(message.text) &&
    message.via !== "api" && !message.peerAsk && !message.from && !message.aside && !message.relayed && !message.webhookPost;
}

/** Keep active user instructions, including folded early requirements. Never
 * clip an action or drop old restrictions just to make a review fit. */
export function approvalEvidence(messages: readonly WireMessage[], authorityMessages: readonly (readonly WireMessage[])[] = []): { userMessages: Array<{ id: string; text: string }>; checkpointRequirements: CheckpointRequirement[]; assistantContext: string[] } {
  const authority = authorityMessages.map(path => approvalEvidence(path));
  const checkpoint = messages.findLast(message => message.kind === "compaction" && message.compaction)?.compaction;
  const users = messages.filter(genuineUser);
  let activeUsers = users;
  if (checkpoint?.requirements) {
    const requiredIds = new Set(checkpoint.requirements.flatMap(item => [
      ...item.sourceIds, ...(item.corrections ?? []).map(correction => correction.sourceId),
    ]));
    const foldedIndex = messages.findIndex(message => message.id === checkpoint.foldedThroughId);
    const indexes = new Map(messages.map((message, index) => [message.id, index]));
    activeUsers = users.filter(message => requiredIds.has(message.id) || (indexes.get(message.id) ?? -1) > foldedIndex);
    // A missing source must not be laundered into authorization by a summary.
    if ([...requiredIds].some(id => !users.some(message => message.id === id))) throw new Error("Checkpoint user authority is unavailable");
  }
  return {
    userMessages: [...authority.flatMap(row => row.userMessages), ...activeUsers.map(message => ({ id: message.id, text: message.text! }))],
    checkpointRequirements: [...authority.flatMap(row => row.checkpointRequirements), ...(checkpoint?.requirements ?? [])],
    // Statements from the assistant help resolve references but grant nothing.
    assistantContext: messages.filter(message => message.role === "bot" && message.kind === "text" && !message.webhookPost)
      .slice(-3).map(message => message.text ?? ""),
  };
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const value: unknown = JSON.parse(text.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid review verdict");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !["allow", "ask", "deny"].includes(String(row.decision)) ||
    typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 1_200) throw new Error("Invalid review verdict");
  return { decision: row.decision as ReviewVerdict["decision"], reason: row.reason.trim() };
}

export async function reviewApproval(input: {
  action: ReviewAction;
  session: ModelSelection;
  settings: ApprovalReviewSettings;
  messages: readonly WireMessage[];
  authorityMessages?: readonly (readonly WireMessage[])[];
  standingInstructions?: string;
  getProvider(id: string): ProviderInstance | undefined;
  providerRefusal?(provider: ProviderInstance): string | null | undefined;
  signal?: AbortSignal;
  isCurrent(): boolean;
  onUsage?(provider: ProviderInstance, usage: TextGenerationUsage): void;
}): Promise<ReviewVerdict & { reviewer?: ModelSelection }> {
  const ask = (reason: string): ReviewVerdict => ({ decision: "ask", reason });
  if (input.signal?.aborted || !input.isCurrent()) return ask("The execution changed while review was pending.");
  const reviewer: ModelSelection = {
    ...(input.settings.model ?? input.session),
    effort: input.settings.model?.effort,
  };
  const provider = input.getProvider(reviewer.instanceId);
  if (!provider?.enabled || !reviewer.model?.trim() || !provider.reviewPermission) return ask("The selected model has no isolated approval reviewer available.");
  if (input.providerRefusal?.(provider)) return ask("The selected approval model is unavailable under the workspace policy.");
  const capabilities = provider.adapter.capabilities;
  if (reviewer.effort !== undefined && !approvalReviewEffortLevels(capabilities).includes(reviewer.effort)) return ask("The selected approval effort is not supported by this provider.");
  reviewer.effort ??= defaultApprovalReviewEffort(capabilities);
  let prompt: string;
  try {
    prompt = `Review input (JSON data):\n${JSON.stringify({
      standingInstructions: input.standingInstructions ?? "",
      additionalConstraints: input.settings.instructions ?? "",
      ...approvalEvidence(input.messages, input.authorityMessages),
      action: input.action,
    })}`;
  } catch { return ask("Complete action or user authority could not be prepared for review."); }
  // Byte count is a conservative token bound. Oversized input goes to the
  // person, rather than truncating code or dropping an early exception.
  const capacity = contextWindowFor(reviewer.model, provider.models);
  if (Buffer.byteLength(APPROVAL_REVIEW_RUBRIC) + Buffer.byteLength(prompt) + 2_048 > Math.min(capacity, 64_000)) return ask("The complete action and active instructions exceed the review context budget.");
  try {
    const text = await provider.reviewPermission(prompt, {
      model: reviewer.model, effort: reviewer.effort, variant: reviewer.variant,
      signal: input.signal, onUsage: usage => input.onUsage?.(provider, usage),
    });
    if (input.signal?.aborted || !input.isCurrent() || input.getProvider(reviewer.instanceId) !== provider || !provider.enabled || input.providerRefusal?.(provider)) return ask("The execution or approval settings changed while review was pending.");
    return { ...parseReviewVerdict(text), reviewer };
  } catch { return ask("Automatic review did not return a valid decision. The action still needs your approval."); }
}
