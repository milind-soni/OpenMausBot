import type { PromptCapture } from "../../shared/prompt-inspector";
export function promptInput(record: PromptCapture): unknown {
  const body = record.body;
  if (!body || typeof body !== "object") return body;
  const keys = record.kind === "api-request" ? ["instructions", "system", "tools", "messages", "input"] :
    ["system", "systemStable", "systemVolatile", "transcript", "text", "images", "integrations"];
  return Object.fromEntries(Object.entries(body).filter(([key]) => keys.includes(key)));
}
export function promptDifference(before: string, after: string): string {
  if (before === after) return "No changes in this view.";
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [`First changed line: ${start + 1}`, ...a.slice(start, endA).slice(0, 1000).map(line => "- " + line),
    ...b.slice(start, endB).slice(0, 1000).map(line => "+ " + line),
    ...(endA - start > 1000 || endB - start > 1000 ? ["Diff preview limited to 1,000 lines per side; export records for the full comparison."] : [])].join("\n");
}
