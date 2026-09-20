export interface McpImageContent {
  data: string;
  mimeType: string;
}

const isImageBlock = (c: unknown): c is McpImageContent =>
  !!c &&
  typeof c === "object" &&
  (c as { type?: unknown }).type === "image" &&
  typeof (c as McpImageContent).data === "string" &&
  typeof (c as McpImageContent).mimeType === "string";

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
  return arr ? arr.filter(isImageBlock) : [];
}
