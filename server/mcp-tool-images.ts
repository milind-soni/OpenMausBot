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

// Claude CLI hands MCP images over in Anthropic Messages shape ({type:"image", source:{type:"base64", media_type, data}});
// codex/acp pass the MCP-native {type, data, mimeType} through.
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

export function extractMcpImages(value: unknown): McpImageContent[] {
  const arr = Array.isArray(value)
    ? value
    : Array.isArray((value as { content?: unknown } | null)?.content)
      ? (value as { content: unknown[] }).content
      : null;
  return arr ? arr.map(asImageBlock).filter((v): v is McpImageContent => v !== null) : [];
}
