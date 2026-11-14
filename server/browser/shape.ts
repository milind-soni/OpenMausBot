// What a browser tool answers with. A snapshot is held near 20 KB and says what it left out.
//
// The snapshot bound follows pingdotgg/t3code@00cdceb1 apps/server/src/mcp/McpHttpServer.ts (boundSnapshotMetadata),
// MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: a text tree with
// refs instead of JSON, and parts shed in OpenMausBot's order.
import { DEFAULT_BROWSER_RESULT_BUDGET, sanitizeUrl } from "../browser-tool-shape.ts";
import { trimResultText } from "../mcp-trim.ts";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  isError?: true;
}

export const MAX_SNAPSHOT_BYTES = 20_000;

const NARROWING_HINT = " Read one part with agent_browser_read and a ref or selector, or pass offset to read on.";

export function textResult(...lines: Array<string | null | undefined | false>): ToolResult {
  return { content: lines.filter((line): line is string => typeof line === "string" && line.length > 0).map((text) => ({ type: "text" as const, text })) };
}

export function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function withParts(result: ToolResult, ...parts: Array<string | null | undefined | false>): ToolResult {
  const extra = parts.filter((part): part is string => typeof part === "string" && part.length > 0).map((text) => ({ type: "text" as const, text }));
  return extra.length ? { ...result, content: [...result.content, ...extra] } : result;
}

export function pageLabel(page: { url: string; title: string; tab: string }): string {
  const address = sanitizeUrl(page.url) || page.url.slice(0, 80);
  return `${page.tab}: ${page.title ? `${JSON.stringify(page.title.slice(0, 200))} at ` : ""}${address}`;
}

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

/** Whole lines, as many as fit in `bytes`. */
function cutLines(text: string, bytes: number): { text: string; cut: boolean } {
  if (utf8(text) <= bytes) return { text, cut: false };
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = utf8(line) + 1;
    if (used + size > bytes) break;
    kept.push(line);
    used += size;
  }
  return { text: kept.join("\n"), cut: true };
}

export interface SnapshotParts {
  tab: string;
  url: string;
  title: string;
  tree: string;
  /** The tree stopped at the driver's own line limit. */
  truncated: boolean;
  frames: number;
  health?: string | null;
}

/** The page's header and tree, then what the page reported, within MAX_SNAPSHOT_BYTES; what was cut is named. */
export function snapshotText(parts: SnapshotParts): string {
  const header = `Page ${pageLabel(parts)}${parts.frames > 1 ? `, ${parts.frames} frames` : ""}.`;
  const omitted: string[] = [];
  let health = parts.health ?? "";
  const room = MAX_SNAPSHOT_BYTES - utf8(header) - 200;
  if (health && utf8(health) + utf8(parts.tree) > room) {
    health = "";
    omitted.push("what the page reported");
  }
  const tree = cutLines(parts.tree, room - utf8(health));
  if (tree.cut || parts.truncated) omitted.push("the rest of the tree (scroll, or read one part with agent_browser_read)");
  return [header, tree.text, health, omitted.length ? `Left out: ${omitted.join("; ")}.` : ""].filter(Boolean).join("\n");
}

/** Every text part fits the result budget, with a hint to narrow the next read. */
export function shapeResult(result: ToolResult, toolName: string, budget = DEFAULT_BROWSER_RESULT_BUDGET): ToolResult {
  return {
    ...result,
    content: result.content.map((part) => {
      if (part.type !== "text") return part;
      const outcome = trimResultText({ text: part.text, budget, toolName });
      return { ...part, text: outcome.trimmed ? outcome.text + NARROWING_HINT : outcome.text };
    }),
  };
}
