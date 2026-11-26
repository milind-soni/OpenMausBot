import { definitionBytes, type ListedTool } from "../tool-list-budget.ts";

/** What the native Antigravity CLI leaves out of a session's tools past `budget` bytes: the largest first, until the rest
 * fits (google-antigravity/antigravity-cli#1530). */
export function cliDrops(tools: readonly ListedTool[], budget: number): string[] {
  const sized = tools.map((tool) => ({ name: tool.name, bytes: definitionBytes(tool) })).sort((a, b) => b.bytes - a.bytes);
  let total = sized.reduce((sum, tool) => sum + tool.bytes, 0);
  const dropped: string[] = [];
  for (const tool of sized) {
    if (total <= budget) break;
    total -= tool.bytes;
    dropped.push(tool.name);
  }
  return dropped;
}
