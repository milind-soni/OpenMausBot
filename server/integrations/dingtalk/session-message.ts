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

function diffPreview(value: unknown, maximum = 3_500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .slice(0, maximum)
    .replaceAll("\r", "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replaceAll("`", "ˋ");
  return normalized || null;
}

function beforeAfter(preview: string): { before: string; after: string } | null {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of preview.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  if (removed.length !== 1 || added.length !== 1) return null;
  return { before: removed[0]!, after: added[0]! };
}

function testState(value: string): string {
  const separator = value.lastIndexOf(":");
  const name = separator >= 0 ? value.slice(0, separator).trim() : value.trim();
  const state = separator >= 0 ? value.slice(separator + 1).trim() : "";
  const label = state === "target_passed"
    ? "已通过"
    : state === "target_failed"
      ? "未通过"
      : state === "not_run"
        ? "未执行"
        : "已完成";
  return `${text(name, "验证", 120)} ${label}`;
}

function decisionToken(value: unknown, label: string): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const item = record(entry);
    if (item?.label !== label || typeof item.actionToken !== "string") continue;
    const token = item.actionToken.trim();
    if (/^[A-Za-z0-9_-]{32,128}$/u.test(token)) return token;
  }
  return null;
}

function readableStatus(value: unknown): string {
  const status = typeof value === "string" ? value : "unknown";
  return ({
    collecting: "正在整理需求",
    waiting_clarification: "等待补充信息",
    ready_for_execution: "等待执行",
    planning: "正在生成计划",
    active: "进行中",
    paused: "已暂停",
    cancelled: "已取消",
    accepted: "已验收完成",
  } as Record<string, string>)[status] ?? "状态待确认";
}

function userFacingSummary(value: unknown, fallback: string): string {
  const summary = typeof value === "string" ? value.trim() : "";
  if (!summary) return fallback;
  return /[\u3400-\u9fff]/u.test(summary) ? summary : fallback;
}

function failureGuidance(value: unknown): string[] {
  const failures = Array.isArray(value) ? value : [];
  const readable = failures
    .filter((item): item is string => typeof item === "string")
    .filter((item) => /[\u3400-\u9fff]/u.test(item))
    .slice(0, 3);
  return readable.length
    ? readable
    : ["执行环境暂不可用，本次没有产生可验收修改。请由任务负责人检查后使用“重试”命令。"];
}

/** Converts internal status-card data to the documented DingTalk session-webhook message shape. */
export function renderDingTalkSessionMessage(payload: unknown): Record<string, unknown> {
  const card = record(payload);
  const type = typeof card?.type === "string" ? card.type : "unknown";
  const status = typeof card?.status === "string" ? card.status : "";
  const headline = type === "primary_status_card"
    ? "需求已收到"
    : status === "ready_for_execution"
    ? "方案已确认，准备执行"
    : status === "candidate_ready"
      ? "执行完成，请验收"
    : status === "owner_accepted"
      ? "验收已确认"
    : status === "owner_rejected"
      ? "已退回修改"
    : status === "owner_action_denied"
      ? "验收操作未执行"
    : type === "command_status_card"
      ? text(card?.headline, "任务状态", 120)
    : text(card?.headline, "协作状态更新", 120);
  const lines = [`### ${headline}`];

  if (type === "primary_status_card") {
    lines.push(
      "",
      "已收到你的需求，正在整理。当前尚未开始执行。",
      "",
      "- 当前进度：正在整理需求",
      `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
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
  } else if (type === "command_status_card") {
    lines.push(
      "",
      text(card?.summary, "命令已处理。", 1_000),
      "",
      `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
    );
    if (card?.workItemStatus) lines.push(`- 业务状态：${readableStatus(card.workItemStatus)}`);
    if (card?.definitionStatus) lines.push(`- 计划状态：${readableStatus(card.definitionStatus)}`);
    if (card?.controlState) lines.push(`- 控制状态：${readableStatus(card.controlState)}`);
  } else if (type === "plan_status_card") {
    if (status === "ready_for_execution") {
      lines.push(
        "",
        "**任务内容**",
        "",
        text(userFacingSummary(card?.summary, "已确认任务范围，系统将按受控计划执行。"), "按已确认的需求执行。", 1_000),
        "",
        "- 当前进度：准备开始",
        "- 下一步：系统将自动执行，完成后通知你验收",
        `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
      );
    } else if (status === "candidate_ready") {
      lines.push(
        "",
        text(card?.summary, "修改已完成并通过验证，请确认结果是否符合需求。", 1_000),
      );
      for (const path of stringList(card?.changedPaths)) lines.push(`- 涉及内容：\`${path}\``);
      if (Array.isArray(card?.testStates)) {
        for (const state of card.testStates.slice(0, 8)) {
          if (typeof state === "string") lines.push(`- 验证结果：${testState(state)}`);
        }
      }
      const preview = diffPreview(card?.candidatePreview);
      if (preview) {
        const simple = beforeAfter(preview);
        if (simple) {
          lines.push(
            "",
            "**修改前**",
            "",
            "```text",
            simple.before,
            "```",
            "",
            "**修改后**",
            "",
            "```text",
            simple.after,
            "```",
          );
        } else lines.push("", "**详细变更（供研发核对）**", "", "```diff", preview, "```");
      }
      const acceptToken = decisionToken(card?.actions, "接受候选");
      const rejectToken = decisionToken(card?.actions, "拒绝候选");
      lines.push("", `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``);
      if (acceptToken && rejectToken) {
        lines.push(
          "",
          "**请由任务负责人在 30 分钟内回复以下一条**",
          "",
          "接受结果：",
          "```text",
          `@研发助手 接受 ${acceptToken}`,
          "```",
          "拒绝并说明原因：",
          "```text",
          `@研发助手 拒绝 ${rejectToken} 请填写需要调整的内容`,
          "```",
          "验收码仅对当前负责人和当前候选有效，使用一次后自动失效。",
          "验收码过期时可回复：",
          "```text",
          `@研发助手 刷新验收码 ${typeof card?.workItemId === "string" ? card.workItemId : "WI-..."}`,
          "```",
        );
      } else {
        lines.push("- 下一步：验收入口暂不可用，请联系维护人员检查消息发送配置");
      }
    } else if (status === "owner_accepted") {
      lines.push(
        "",
        "负责人已确认本次结果，任务已完成。",
        `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
      );
    } else if (status === "owner_rejected") {
      lines.push(
        "",
        "负责人已退回本次结果，系统将按反馈重新整理并执行。",
        `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
      );
    } else if (status === "owner_action_denied") {
      lines.push(
        "",
        text(card?.summary, "该验收操作未通过身份或候选状态校验，请使用最新消息中的验收指令。", 1_000),
      );
    } else lines.push(
      "",
      `- Work Item: \`${text(card?.workItemId, "unavailable", 128)}\``,
      `- 状态: ${text(card?.status, "planning", 80)}`,
    );
    if (status !== "ready_for_execution" && status !== "candidate_ready") {
      if (typeof card?.summary === "string" && card.summary.trim()) lines.push(`- 摘要: ${text(card.summary, "", 1_000)}`);
      if (typeof card?.candidateSha === "string" && card.candidateSha.trim()) {
        lines.push(`- Candidate: \`${text(card.candidateSha, "unavailable", 128)}\``);
      }
      for (const path of stringList(card?.changedPaths)) lines.push(`- 变更: \`${path}\``);
      for (const state of stringList(card?.testStates)) lines.push(`- 测试: ${state}`);
      const preview = diffPreview(card?.candidatePreview);
      if (preview) lines.push("", "**候选内容预览**", "", "```diff", preview, "```");
      for (const failure of failureGuidance(card?.failures)) lines.push(`- 处理建议：${text(failure, "请联系维护人员检查。", 1_000)}`);
    }
  } else {
    lines.push("", "协作状态已更新，请查看受控审计记录。");
  }

  return {
    msgtype: "markdown",
    markdown: { title: headline, text: lines.join("\n") },
  };
}
