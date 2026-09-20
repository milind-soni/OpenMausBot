export interface McpImageContent {
  data: string;
  mimeType: string;
}

const asMcpImage = (c: unknown): McpImageContent | null =>
  !!c &&
  typeof c === "object" &&
  (c as { type?: unknown }).type === "image" &&
  typeof (c as McpImageContent).data === "string" &&
  typeof (c as McpImageContent).mimeType === "string"
    ? (c as McpImageContent)
    : null;

// Claude CLI reformats MCP image content into Anthropic Messages API shape
// before drivers ever see it — {type:"image", source:{type:"base64",
// media_type, data}} — rather than the MCP-native {type, data, mimeType}.
// Other drivers (codex/acp) pass the MCP-native shape through unchanged.
const asAnthropicImage = (c: unknown): McpImageContent | null => {
  const source = (c as { type?: unknown; source?: unknown } | null)?.type === "image"
    ? (c as { source?: unknown }).source
    : null;
  if (!source || typeof source !== "object") return null;
  const { type, media_type, data } = source as { type?: unknown; media_type?: unknown; data?: unknown };
  return type === "base64" && typeof media_type === "string" && typeof data === "string"
    ? { data, mimeType: media_type }
    : null;
};

const asImageBlock = (c: unknown): McpImageContent | null => asMcpImage(c) ?? asAnthropicImage(c);

/** MCP tool_result content mixes text/image blocks. toolDetailPreview redacts
 * the image bytes for the activity-log line (by design — that preview is
 * never meant to carry raw base64); this pulls the images out separately so
 * a caller can fold them into the message as attachments instead of losing
 * them. Accepts either a raw MCP content array or a `{ content: [...] }`
 * wrapper, since drivers hand this differently-shaped payloads. */
export function extractMcpImages(value: unknown): McpImageContent[] {
  const arr = Array.isArray(value)
    ? value
    : Array.isArray((value as { content?: unknown } | null)?.content)
      ? (value as { content: unknown[] }).content
      : null;
  return arr ? arr.map(asImageBlock).filter((v): v is McpImageContent => v !== null) : [];
}
