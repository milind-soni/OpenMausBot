import { providerMcpTool } from "../../provider-tool-allow.ts";

// hermes-agent asks before a write-capable tool runs on an MCP server its own config.yaml marks `trust: untrusted`
// (tools/mcp_tool_handlers.py `_ask_for_call`). The ask reaches ACP as a shell call (acp_adapter/permissions.py): kind
// `execute`, title "<description>: <message>", rawInput {command: message, description}. As a shell call, "Always allow"
// saved the message, arguments and all, so the next call of the same tool asked again.

/** The description of an ask that may be remembered: it offers "once, for this session, or always". An ask past a spend
 * limit says "once" only, and a spend-limit ask on a trusted server reads otherwise: both stay one-time asks. */
const REMEMBERABLE_TRUST_ASK = /^Server '([\w-]+)' is configured 'trust: untrusted'\. Approve to run '([\w.-]+)' once, for this session, or always, or deny to block it\.$/;

/** The trust ask named as the MCP tool it is about (kind `other`, title mcp__<server>__<tool>), so a saved grant is the
 * tool's, never the message's; every other request, and a name that would not read back as one tool, is left as sent. */
export function hermesPermissionRequest(params: Record<string, any>): Record<string, any> {
  const toolCall = params.toolCall ?? {};
  const options: Array<{ kind?: unknown }> = Array.isArray(params.options) ? params.options : [];
  const description = toolCall.rawInput?.description;
  const asked = toolCall.kind === "execute" && typeof description === "string" ? REMEMBERABLE_TRUST_ASK.exec(description) : null;
  if (!asked || !options.some((option) => option.kind === "allow_always")) return params;
  const title = `mcp__${asked[1]}__${asked[2]}`;
  const readBack = providerMcpTool(title);
  if (readBack?.server !== asked[1] || readBack.tool !== asked[2]) return params;
  return { ...params, toolCall: { ...toolCall, kind: "other", title } };
}
