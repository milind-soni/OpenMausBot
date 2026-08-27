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
  headline: "计划生成中" | "计划已发布" | "计划生成失败";
  workItemId: string;
  planRevision?: number;
  snapshotRevision?: number;
  status: "planning" | "ready_for_execution" | "planning_failed";
  summary?: string;
  sequence?: Array<"analyze" | "modify" | "validate" | "report">;
  failures?: string[];
}

export type InboundAcknowledgementCard = PrimaryStatusCard | AssociationChoiceCard | InvalidReferenceCard;

export type InboundCard =
  | InboundAcknowledgementCard
  | ClarificationCard
  | PlanStatusCard;

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

export function renderPlanStatusCard(input: {
  workItemId: string;
  planRevision?: number;
  snapshotRevision?: number;
  status: "planning" | "ready_for_execution" | "planning_failed";
  summary?: string;
  failures?: string[];
}): PlanStatusCard {
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
