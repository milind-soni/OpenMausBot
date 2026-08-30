import type { IssueOwnerActionInput, IssuedOwnerAction } from "../../collaboration/actions.ts";
import type { PlanStatusCard } from "../../collaboration/message-renderer.ts";

export interface OwnerCardActionButton {
  label: string;
  /** Opaque server-issued value. It carries no action, role, work item, or SHA claims. */
  actionToken: string;
}

export interface DingTalkOwnerStatusCardInput {
  cardTemplateId: string;
  outTrackId: string;
  title: string;
  workItemId: string;
  status: string;
  summary: string;
  candidateSha?: string;
  candidatePreview?: string;
  actions: OwnerCardActionButton[];
}

export type DingTalkCandidateOwnerCard = PlanStatusCard & {
  status: "candidate_ready";
  workItemVersion: number;
  cardTemplateId: string;
  outTrackId: string;
  candidateSha: string;
  summary: string;
  actions: OwnerCardActionButton[];
};

export type DingTalkCandidateOwnerCardRequest = Omit<DingTalkCandidateOwnerCard, "actions"> & {
  actions?: never;
};

export type DingTalkCandidateTextDecisionRequest = PlanStatusCard & {
  status: "candidate_ready";
  workItemVersion: number;
  candidateSha: string;
  summary: string;
  cardTemplateId?: never;
  actions?: never;
};

export type DingTalkCandidateTextDecision = Omit<DingTalkCandidateTextDecisionRequest, "actions"> & {
  actions: OwnerCardActionButton[];
};

export interface OwnerActionIssuePort {
  issueOwnerAction(input: IssueOwnerActionInput): IssuedOwnerAction;
}

function candidatePreview(value: string): string {
  const sanitized = value
    .slice(0, 3_500)
    .replaceAll("\r", "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replaceAll("`", "ˋ");
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of sanitized.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  if (removed.length === 1 && added.length === 1) {
    return `**修改前**\n\n\`\`\`text\n${removed[0]}\n\`\`\`\n\n**修改后**\n\n\`\`\`text\n${added[0]}\n\`\`\``;
  }
  return `**详细变更（供研发核对）**\n\n\`\`\`diff\n${sanitized}\n\`\`\``;
}

export function isDingTalkCandidateOwnerCardRequest(value: unknown): value is DingTalkCandidateOwnerCardRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  return (
    card.type === "plan_status_card" &&
    card.status === "candidate_ready" &&
    typeof card.cardTemplateId === "string" &&
    typeof card.outTrackId === "string" &&
    typeof card.workItemId === "string" &&
    typeof card.workItemVersion === "number" &&
    typeof card.candidateSha === "string" &&
    typeof card.summary === "string"
  );
}

export function isDingTalkCandidateOwnerCard(value: unknown): value is DingTalkCandidateOwnerCard {
  if (!isDingTalkCandidateOwnerCardRequest(value) && !(
    value && typeof value === "object" && !Array.isArray(value)
  )) return false;
  const card = value as Record<string, unknown>;
  return isDingTalkCandidateOwnerCardRequest({ ...card, actions: undefined }) && Array.isArray(card.actions);
}

export function isDingTalkCandidateTextDecisionRequest(
  value: unknown,
): value is DingTalkCandidateTextDecisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  return (
    card.type === "plan_status_card" &&
    card.status === "candidate_ready" &&
    card.cardTemplateId === undefined &&
    card.actions === undefined &&
    typeof card.workItemId === "string" &&
    typeof card.workItemVersion === "number" &&
    typeof card.candidateSha === "string" &&
    typeof card.summary === "string"
  );
}

function issueCandidateActions(
  input: { workItemId: string; workItemVersion: number; candidateSha: string; now: number },
  issuer: OwnerActionIssuePort,
): OwnerCardActionButton[] {
  const issue = (action: "accept" | "reject") =>
    issuer.issueOwnerAction({
      action,
      workItemId: input.workItemId,
      expectedVersion: input.workItemVersion,
      candidateSha: input.candidateSha,
      ttlMs: 30 * 60_000,
      now: input.now,
    });
  const accept = issue("accept");
  const reject = issue("reject");
  return [
    { label: "接受候选", actionToken: accept.token },
    { label: "拒绝候选", actionToken: reject.token },
  ];
}

export function issueDingTalkCandidateOwnerCard(
  input: {
    cardTemplateId: string;
    outTrackId: string;
    workItemId: string;
    workItemVersion: number;
    candidateSha: string;
    summary: string;
    candidatePreview?: string;
    now: number;
  },
  issuer: OwnerActionIssuePort,
): DingTalkCandidateOwnerCard {
  return {
    type: "plan_status_card",
    headline: "候选已就绪",
    cardTemplateId: input.cardTemplateId,
    outTrackId: input.outTrackId,
    workItemId: input.workItemId,
    workItemVersion: input.workItemVersion,
    status: "candidate_ready",
    summary: input.summary,
    candidateSha: input.candidateSha,
    ...(input.candidatePreview ? { candidatePreview: input.candidatePreview } : {}),
    actions: issueCandidateActions(input, issuer),
  };
}

export function materializeDingTalkCandidateTextDecision(
  request: DingTalkCandidateTextDecisionRequest,
  issuer: OwnerActionIssuePort,
  now: number,
): DingTalkCandidateTextDecision {
  if (!isDingTalkCandidateTextDecisionRequest(request)) {
    throw new Error("dingtalk_candidate_text_decision_request_invalid");
  }
  return {
    ...request,
    actions: issueCandidateActions(
      {
        workItemId: request.workItemId,
        workItemVersion: request.workItemVersion,
        candidateSha: request.candidateSha,
        now,
      },
      issuer,
    ),
  };
}

export function materializeDingTalkCandidateOwnerCard(
  request: DingTalkCandidateOwnerCardRequest,
  issuer: OwnerActionIssuePort,
  now: number,
): DingTalkCandidateOwnerCard {
  if (!isDingTalkCandidateOwnerCardRequest(request)) throw new Error("dingtalk_candidate_card_request_invalid");
  return issueDingTalkCandidateOwnerCard(
    {
      cardTemplateId: request.cardTemplateId,
      outTrackId: request.outTrackId,
      workItemId: request.workItemId,
      workItemVersion: request.workItemVersion,
      candidateSha: request.candidateSha,
      summary: request.summary,
      ...(request.candidatePreview ? { candidatePreview: request.candidatePreview } : {}),
      now,
    },
    issuer,
  );
}

export function renderDingTalkOwnerStatusCard(
  input: DingTalkOwnerStatusCardInput | DingTalkCandidateOwnerCard,
): Record<string, unknown> {
  const candidateReady = input.status === "candidate_ready";
  const title = candidateReady ? "执行完成，请验收" : "title" in input ? input.title : input.headline;
  return {
    cardTemplateId: input.cardTemplateId,
    outTrackId: input.outTrackId,
    callbackType: "STREAM",
    cardData: {
      cardParamMap: {
        title: title.slice(0, 120),
        summary: input.summary.slice(0, 4_000),
        workItemId: input.workItemId,
        status: candidateReady ? "等待验收" : input.status,
        ...(input.candidatePreview
          ? { candidatePreview: candidatePreview(input.candidatePreview) }
          : {}),
        actions: JSON.stringify(input.actions.slice(0, 8).map((action, index) => ({ id: `action-${index + 1}`, label: action.label.slice(0, 40) }))),
      },
    },
    privateData: {
      // The configured DingTalk template copies only the selected opaque value
      // into callback actionData.actionToken. No privilege claim is embedded.
      actionTokens: Object.fromEntries(
        input.actions.slice(0, 8).map((action, index) => [`action-${index + 1}`, action.actionToken]),
      ),
    },
  };
}
