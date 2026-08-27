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

export type InboundCard = PrimaryStatusCard | AssociationChoiceCard | InvalidReferenceCard;

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
