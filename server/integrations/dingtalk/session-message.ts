type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function text(value: unknown, fallback: string, maximum = 4_000): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  const selected = normalized || fallback;
  return selected
    .slice(0, maximum)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|-])/gu, "\\$1");
}

function stringList(value: unknown, maximum = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).map((entry) => text(entry, "unknown", 256));
}

/** Converts internal status-card data to the documented DingTalk session-webhook message shape. */
export function renderDingTalkSessionMessage(payload: unknown): Record<string, unknown> {
  const card = record(payload);
  const type = typeof card?.type === "string" ? card.type : "unknown";
  const headline = text(card?.headline, "协作状态更新", 120);
  const lines = [`### ${headline}`];

  if (type === "primary_status_card") {
    lines.push(
      "",
      text(card?.acknowledgement, "消息已安全写入协作账本。"),
      "",
      `- Work Item: \`${text(card?.workItemId, "unavailable", 128)}\``,
      `- 状态: ${text(card?.workItemStatus, "collecting", 80)}`,
    );
  } else if (type === "association_choice_card") {
    lines.push("", text(card?.acknowledgement, "请选择问题归属。"));
    for (const workItemId of stringList(card?.candidateWorkItemIds)) lines.push(`- \`${workItemId}\``);
  } else if (type === "invalid_reference_card") {
    lines.push("", "引用的问题不可用。", "", `- 引用: \`${text(card?.reference, "unknown", 128)}\``);
  } else if (type === "clarification_card") {
    lines.push("", `- Work Item: \`${text(card?.workItemId, "unavailable", 128)}\``);
    if (Array.isArray(card?.questions)) {
      for (const question of card.questions.slice(0, 8)) {
        const item = record(question);
        lines.push(`- ${text(item?.question, "需要补充信息")}`);
      }
    }
  } else if (type === "plan_status_card") {
    lines.push(
      "",
      `- Work Item: \`${text(card?.workItemId, "unavailable", 128)}\``,
      `- 状态: ${text(card?.status, "planning", 80)}`,
    );
  } else {
    lines.push("", "协作状态已更新，请查看受控审计记录。");
  }

  return {
    msgtype: "markdown",
    markdown: { title: headline, text: lines.join("\n") },
  };
}
