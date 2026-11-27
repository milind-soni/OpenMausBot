// The MCP app-access approval forms Codex asks for, moved out of codex.ts (file-size ratchet).

import type { ServerToolText } from "../../shared/server-text.ts";
import { noticeFailure, noticeSummary } from "../chat-notices.ts";

export type McpApprovalForm = ServerToolText & {
  tool: string;
  summary: string;
  allowResult: { action: "accept"; content: Record<string, string> };
};

export const plainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export function boundedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= 160 && !containsControlCharacter(label) ? label : null;
}

export function mcpElicitationDeclined(value: unknown) {
  const server = boundedLabel(value);
  return server ? noticeFailure("chat.notice.codexElicitationDeclined", { server }) : noticeFailure("chat.notice.codexElicitationDeclinedGeneric");
}

export function mcpAppApprovalText(form: McpApprovalForm | null): ServerToolText {
  return form?.summaryCode ? { summaryCode: form.summaryCode, ...(form.summaryParams ? { summaryParams: form.summaryParams } : {}) } : {};
}

function ordinaryApprovalValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (/session|always|permanent|forever|persistent/.test(normalized)) return false;
  return normalized === "once" || /^(?:accept|approve|allow)(?:ed|[-_]?once)?$/.test(normalized);
}

/** Only schema-backed app-access approvals; any other MCP form (credentials, free text, URLs) stays
 * user input and is declined, and Full access never fabricates one. */
export function mcpAppApprovalForm(params: unknown): McpApprovalForm | null {
  const request = plainRecord(params);
  if (!request || request.mode !== "form") return null;
  const metadata = plainRecord(request._meta);
  const target = plainRecord(metadata?.target);
  const toolParams = plainRecord(metadata?.tool_params);
  const message = boundedLabel(request.message);
  const summary = message ? { summary: message } : noticeSummary("chat.notice.appAccessRequested");
  const appName = [
    metadata?.app_name,
    metadata?.appName,
    metadata?.app,
    target?.app,
    target?.name,
    toolParams?.app_name,
    toolParams?.app,
    metadata?.connector_name,
    metadata?.connectorName,
  ].map(boundedLabel).find(Boolean) ?? message?.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1]?.trim();
  if (!appName) return null;

  const schema = plainRecord(request.requestedSchema);
  const properties = plainRecord(schema?.properties);
  const required = schema?.required;
  if (
    !properties ||
    !Array.isArray(required) ||
    required.length === 0 ||
    required.length > 8 ||
    !required.every((key) => typeof key === "string" && key.length > 0 && key.length <= 100)
  ) return null;

  const content: Record<string, string> = {};
  for (const key of required as string[]) {
    const field = plainRecord(properties[key]);
    if (!field) return null;
    const enumValues = Array.isArray(field.enum)
      ? field.enum.filter((value): value is string => typeof value === "string")
      : [];
    const oneOfValues = Array.isArray(field.oneOf)
      ? field.oneOf
          .map((option) => boundedLabel(plainRecord(option)?.const))
          .filter((value): value is string => Boolean(value))
      : [];
    const chosen = [...oneOfValues, ...enumValues].find(ordinaryApprovalValue);
    if (!chosen) return null;
    content[key] = chosen;
  }

  const tool = boundedLabel(appName) ?? boundedLabel(request.serverName) ?? "app_access";
  return { tool, ...summary, allowResult: { action: "accept", content } };
}
