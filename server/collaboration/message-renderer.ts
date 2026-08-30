export interface PrimaryStatusCard {
  type: "primary_status_card";
  headline: "已接收";
  acknowledgement: string;
  workItemId: string;
  workItemStatus: string;
  workItemVersion: number;
  association: "created" | "associated";
}

export interface AssociationChoiceCard {
  type: "association_choice_card";
  headline: "请选择问题归属";
  acknowledgement: string;
  candidateWorkItemIds: string[];
}

export interface InvalidReferenceCard {
  type: "invalid_reference_card";
  headline: "引用的问题不可用";
  acknowledgement: string;
  reference: string;
}

export interface ClarificationCard {
  type: "clarification_card";
  headline: "需要澄清";
  workItemId: string;
  snapshotRevision: number;
  questions: Array<{
    id: string;
    title: string;
    question: string;
    recommendedAnswer: string;
  }>;
}

export interface PlanStatusCard {
  type: "plan_status_card";
  headline:
    | "计划生成中"
    | "计划已发布"
    | "计划生成失败"
    | "候选已就绪"
    | "执行未完成"
    | "候选已接受"
    | "候选已拒绝"
    | "验收操作未执行";
  workItemId: string;
  planRevision?: number;
  snapshotRevision?: number;
  status:
    | "planning"
    | "ready_for_execution"
    | "planning_failed"
    | "candidate_ready"
    | "execution_failed"
    | "owner_accepted"
    | "owner_rejected"
    | "owner_action_denied";
  summary?: string;
  sequence?: Array<"analyze" | "modify" | "validate" | "report">;
  failures?: string[];
  candidateSha?: string;
  candidatePreview?: string;
  changedPaths?: string[];
  testStates?: string[];
  workItemVersion?: number;
  cardTemplateId?: string;
  outTrackId?: string;
  actions?: Array<{ label: string; actionToken: string }>;
}

export interface CommandStatusCard {
  type: "command_status_card";
  headline: "任务状态" | "控制操作已执行" | "控制操作未执行";
  command: "status" | "pause" | "resume" | "retry" | "cancel" | "refresh_approval";
  workItemId: string;
  outcome: "allowed" | "denied";
  summary: string;
  workItemStatus?: string;
  definitionStatus?: string;
  controlState?: string;
}

export type InboundAcknowledgementCard = PrimaryStatusCard | AssociationChoiceCard | InvalidReferenceCard;

export type InboundCard =
  | InboundAcknowledgementCard
  | ClarificationCard
  | PlanStatusCard
  | CommandStatusCard;

const RECEIVED_ONLY = "消息已接收并写入协作账本；这不表示系统已经理解、执行或完成任务。";

export function renderPrimaryStatusCard(input: {
  workItemId: string;
  status: string;
  version: number;
  association: "created" | "associated";
}): PrimaryStatusCard {
  return {
    type: "primary_status_card",
    headline: "已接收",
    acknowledgement: RECEIVED_ONLY,
    workItemId: input.workItemId,
    workItemStatus: input.status,
    workItemVersion: input.version,
    association: input.association,
  };
}

export function renderAssociationChoiceCard(candidateWorkItemIds: string[]): AssociationChoiceCard {
  return {
    type: "association_choice_card",
    headline: "请选择问题归属",
    acknowledgement: `${RECEIVED_ONLY} 当前引用可能属于多个问题，选择前不会修改任何 Work Item。`,
    candidateWorkItemIds: [...candidateWorkItemIds],
  };
}

export function renderInvalidReferenceCard(reference: string): InvalidReferenceCard {
  return {
    type: "invalid_reference_card",
    headline: "引用的问题不可用",
    acknowledgement: `${RECEIVED_ONLY} 未找到当前会话中的 ${reference}，因此没有创建或更新 Work Item。`,
    reference,
  };
}

export function renderClarificationCard(input: Omit<ClarificationCard, "type" | "headline">): ClarificationCard {
  return { type: "clarification_card", headline: "需要澄清", ...input };
}

export function renderCommandStatusCard(
  input: Omit<CommandStatusCard, "type" | "headline">,
): CommandStatusCard {
  return {
    type: "command_status_card",
    headline: input.command === "status"
      ? "任务状态"
      : input.outcome === "allowed"
        ? "控制操作已执行"
        : "控制操作未执行",
    ...input,
  };
}

export function renderPlanStatusCard(input: {
  workItemId: string;
  planRevision?: number;
  snapshotRevision?: number;
  status:
    | "planning"
    | "ready_for_execution"
    | "planning_failed"
    | "candidate_ready"
    | "execution_failed"
    | "owner_accepted"
    | "owner_rejected"
    | "owner_action_denied";
  summary?: string;
  failures?: string[];
  candidateSha?: string;
  candidatePreview?: string;
  changedPaths?: string[];
  testStates?: string[];
  workItemVersion?: number;
}): PlanStatusCard {
  if (["owner_accepted", "owner_rejected", "owner_action_denied"].includes(input.status)) {
    return {
      type: "plan_status_card",
      headline: input.status === "owner_accepted"
        ? "候选已接受"
        : input.status === "owner_rejected"
          ? "候选已拒绝"
          : "验收操作未执行",
      workItemId: input.workItemId,
      status: input.status,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.failures ? { failures: input.failures } : {}),
    };
  }
  if (input.status === "planning") {
    return {
      type: "plan_status_card",
      headline: "计划生成中",
      workItemId: input.workItemId,
      snapshotRevision: input.snapshotRevision,
      status: input.status,
    };
  }
  if (input.status === "planning_failed") {
    return {
      type: "plan_status_card",
      headline: "计划生成失败",
      workItemId: input.workItemId,
      planRevision: input.planRevision,
      status: input.status,
      failures: input.failures ?? ["未知计划错误"],
    };
  }
  if (input.status === "candidate_ready") {
    return {
      type: "plan_status_card",
      headline: "候选已就绪",
      workItemId: input.workItemId,
      planRevision: input.planRevision,
      status: input.status,
      summary: input.summary,
      candidateSha: input.candidateSha,
      candidatePreview: input.candidatePreview,
      changedPaths: input.changedPaths ?? [],
      testStates: input.testStates ?? [],
      workItemVersion: input.workItemVersion,
    };
  }
  if (input.status === "execution_failed") {
    return {
      type: "plan_status_card",
      headline: "执行未完成",
      workItemId: input.workItemId,
      planRevision: input.planRevision,
      status: input.status,
      failures: input.failures ?? ["执行未产生可验收候选"],
    };
  }
  return {
    type: "plan_status_card",
    headline: "计划已发布",
    workItemId: input.workItemId,
    planRevision: input.planRevision,
    status: input.status,
    summary: input.summary,
    sequence: ["analyze", "modify", "validate", "report"],
  };
}
