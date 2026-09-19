// Sanitizers for provider-native ACP diagnostic logs: bounded tool payloads
// and collapsed inline image data, so megabytes of base64 never reach the
// native log in either direction.
import type { AcpWireMessage } from "./protocol.ts";
import type { AcpLogMessageParams } from "./wire-types.ts";

const TOOL_LOG_TEXT_LIMIT = 64_000;

export function sanitizeToolLogValue(value: unknown, budget: { nodes: number; text: number }, depth = 0): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === "string") {
    if (/^data:image\//iu.test(value) || budget.text <= 0) return undefined;
    const limit = Math.min(TOOL_LOG_TEXT_LIMIT, budget.text);
    const text = value.length <= limit ? value : `[Earlier output truncated]\n\n${value.slice(-limit)}`;
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).flatMap(([key, entry]) => {
    if ((record.type === "image" && (key === "data" || key === "blob")) ||
      (key === "blob" && typeof record.mimeType === "string" && record.mimeType.startsWith("image/"))) return [];
    const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

export function sanitizeAcpToolMessage(message: AcpWireMessage): unknown {
  const params = message.params as AcpLogMessageParams | undefined;
  const isToolUpdate = message.method === "session/update"
    && ["tool_call", "tool_call_update"].includes(params?.update?.sessionUpdate ?? "");
  const isPermission = message.method === "session/request_permission";
  if (!isToolUpdate && !isPermission) return message;
  return sanitizeToolLogValue(message, { nodes: 512, text: TOOL_LOG_TEXT_LIMIT });
}

// ACP content blocks may carry a complete raster image inline. Keep the
// bytes on the wire, but never duplicate megabytes of base64 into the
// provider-native diagnostic log in either direction.
export const nativeLogMessage = (support: { sanitizeToolPayload?: boolean }, message: AcpWireMessage): unknown => {
  // the raw frame keeps params opaque; the redactor reads the two
  // shapes it may rewrite (prompt blocks, update content) through one view
  let params = message.params as AcpLogMessageParams | undefined;
  let redacted: AcpWireMessage = message;
  const prompt = message.method === "session/prompt" ? params?.prompt : null;
  if (Array.isArray(prompt)) {
    redacted = {
      ...message,
      params: {
        ...params,
        prompt: prompt.map((content) =>
          content?.type === "image" && typeof content.data === "string"
            ? { ...content, data: `[image data: ${content.data.length} base64 chars]` }
            : content
        ),
      },
    };
    params = redacted.params as AcpLogMessageParams;
  }
  const update = params?.update;
  const content = update?.content;
  if (
    redacted.method !== "session/update" ||
    update?.sessionUpdate !== "agent_message_chunk" ||
    content?.type !== "image" ||
    typeof content.data !== "string"
  ) return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
  redacted = {
    ...redacted,
    params: {
      ...params,
      update: {
        ...update,
        content: { ...content, data: `[image data: ${content.data.length} base64 chars]` },
      },
    },
  };
  return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
};
