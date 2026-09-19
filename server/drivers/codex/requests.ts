// Server→client request classification and response shaping for the codex
// app-server: which JSON-RPC methods count as permissions or questions, the
// tool/summary/choices each ask card carries, and the wire result for an
// allow/deny/answer. Pure/explicit like acp's log-sanitize.ts; the ask
// broker (asks map, timeout timer, request.opened/resolved events) stays in
// the driver.
import {
  additionalPermissionSummary,
  grantedPermissions,
  mcpAppApprovalForm,
  type McpApprovalForm,
} from "../codex-approvals.ts";

export const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
export const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

export interface CodexServerRequest {
  msg: any;
  method: string;
  params: any;
  legacy: boolean;
  isMcpElicitation: boolean;
  isLegacyMcpPermission: boolean;
  mcpAppApproval: McpApprovalForm | null;
  isMcpPermission: boolean;
  isQuestion: boolean;
  isAdditionalPermission: boolean;
  isPermission: boolean;
}

export function classifyServerRequest(msg: any): CodexServerRequest {
  const method = msg.method as string;
  const params = msg.params ?? {};
  const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
  const isMcpElicitation = method === "mcpServer/elicitation/request";
  const isLegacyMcpPermission =
    method === "mcpServer/elicitation/request" &&
    params?._meta?.codex_approval_kind === "mcp_tool_call";
  const mcpAppApproval = isMcpElicitation ? mcpAppApprovalForm(params) : null;
  const isMcpPermission = isLegacyMcpPermission || mcpAppApproval !== null;
  const isQuestion = method === "item/tool/requestUserInput";
  const isAdditionalPermission = method === "item/permissions/requestApproval";
  const isPermission = legacy || isMcpPermission || isAdditionalPermission ||
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval";
  return {
    msg,
    method,
    params,
    legacy,
    isMcpElicitation,
    isLegacyMcpPermission,
    mcpAppApproval,
    isMcpPermission,
    isQuestion,
    isAdditionalPermission,
    isPermission,
  };
}

/** The frame for a request this driver cannot or must not answer: a normal
 *  MCP elicitation is declined; anything unrecognized fails closed. */
export function unsupportedServerRequestResponse(r: CodexServerRequest): unknown {
  if (r.isMcpElicitation) {
    return { jsonrpc: "2.0", id: r.msg.id, result: { action: "decline" } };
  }
  return {
    jsonrpc: "2.0",
    id: r.msg.id,
    error: { code: -32601, message: `Unsupported server request: ${r.method}` },
  };
}

export function bundledQuestionResponse(r: CodexServerRequest): unknown {
  const bundled = Array.isArray(r.params.questions) && r.params.questions.length > 1;
  return {
    jsonrpc: "2.0",
    id: r.msg.id,
    error: {
      code: -32602,
      message: bundled
        ? `ask supports one question per call; this request bundled ${r.params.questions.length}. Split it into separate asks, one question each.`
        : Array.isArray(r.params.questions)
        ? "ask supports one question per call; this request sent none."
        : "ask supports one question per call; params.questions must be an array with exactly one question.",
    },
  };
}

export function serverRequestTool(r: CodexServerRequest): string {
  const mcpTool = r.isLegacyMcpPermission
    ? String(r.params.message ?? "").match(/tool "([^"]+)"/)?.[1]
    : undefined;
  return (
    r.mcpAppApproval
      ? r.mcpAppApproval.tool
      : r.isLegacyMcpPermission
      ? (mcpTool ?? "mcp")
      : r.isAdditionalPermission
        ? "permissions"
      : r.method === "item/fileChange/requestApproval" || r.method === "applyPatchApproval"
      ? "edit"
      : r.isQuestion
        ? "ask_user"
        : "shell"
  );
}

export function serverRequestResult(r: CodexServerRequest, allow: boolean): unknown {
  return (
    r.isMcpPermission
      ? allow
        ? (r.mcpAppApproval?.allowResult ?? { action: "accept", content: {} })
        : { action: "decline" }
      : r.isAdditionalPermission
        ? { permissions: allow ? grantedPermissions(r.params.permissions) : {}, scope: "turn" }
        : { decision: allow ? (r.legacy ? "approved" : "accept") : r.legacy ? "denied" : "decline" }
  );
}

export function serverRequestSummary(r: CodexServerRequest): string {
  return (
    r.isAdditionalPermission
      ? additionalPermissionSummary(r.params.permissions, r.params.reason)
      : r.isMcpPermission
      ? (r.mcpAppApproval?.summary ?? (typeof r.params.message === "string" ? r.params.message : "MCP access requested"))
      : typeof r.params.command === "string"
      ? r.params.command
      : Array.isArray(r.params.questions)
        ? r.params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
        : typeof r.params.reason === "string"
          ? r.params.reason
          : serverRequestTool(r)
  );
}

export function serverRequestChoices(r: CodexServerRequest): string[] | undefined {
  return r.isQuestion
    ? (r.params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
    : undefined;
}

export function questionAnswersResult(
  r: CodexServerRequest,
  message: string | undefined,
): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of Array.isArray(r.params.questions) ? r.params.questions : []) {
    answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
  }
  return { answers };
}
