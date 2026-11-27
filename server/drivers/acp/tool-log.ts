// What an ACP tool update or permission request keeps in the native log: no image bytes, and
// bounded text (the tail of a long output), so a chatty tool cannot fill the log.
const TOOL_LOG_TEXT_LIMIT = 64_000;

function sanitizeToolLogValue(value: unknown, budget: { nodes: number; text: number }, depth = 0): unknown {
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

export function sanitizeAcpToolMessage(message: any): unknown {
  const isToolUpdate = message?.method === "session/update"
    && ["tool_call", "tool_call_update"].includes(message?.params?.update?.sessionUpdate);
  const isPermission = message?.method === "session/request_permission";
  if (!isToolUpdate && !isPermission) return message;
  return sanitizeToolLogValue(message, { nodes: 512, text: TOOL_LOG_TEXT_LIMIT });
}

/** What the native log keeps of any ACP message: inline images stay on the wire but never go in as base64. */
export function acpNativeLogMessage(msg: any, sanitizeToolPayload: boolean): unknown {
  let redacted = msg;
  const prompt = msg?.method === "session/prompt" ? msg?.params?.prompt : null;
  if (Array.isArray(prompt)) {
    redacted = {
      ...msg,
      params: {
        ...msg.params,
        prompt: prompt.map((content: any) =>
          content?.type === "image" && typeof content.data === "string"
            ? { ...content, data: `[image data: ${content.data.length} base64 chars]` }
            : content
        ),
      },
    };
  }
  const content = redacted?.params?.update?.content;
  if (
    redacted?.method === "session/update" &&
    redacted?.params?.update?.sessionUpdate === "agent_message_chunk" &&
    content?.type === "image" &&
    typeof content.data === "string"
  ) {
    redacted = {
      ...redacted,
      params: {
        ...redacted.params,
        update: { ...redacted.params.update, content: { ...content, data: `[image data: ${content.data.length} base64 chars]` } },
      },
    };
  }
  return sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
}
