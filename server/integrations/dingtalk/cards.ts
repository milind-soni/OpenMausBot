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
  actions: OwnerCardActionButton[];
}

export function renderDingTalkOwnerStatusCard(input: DingTalkOwnerStatusCardInput): Record<string, unknown> {
  return {
    cardTemplateId: input.cardTemplateId,
    outTrackId: input.outTrackId,
    callbackType: "STREAM",
    cardData: {
      cardParamMap: {
        title: input.title.slice(0, 120),
        summary: input.summary.slice(0, 4_000),
        workItemId: input.workItemId,
        status: input.status,
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
