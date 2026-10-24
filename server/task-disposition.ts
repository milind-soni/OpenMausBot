import type { TaskDisposition } from "./runtime/types.ts";

/** Terminal, unquoted protocol assertion. Prose may precede it after a blank line; examples are not assertions. */
export const TASK_RESULT_PROMPT = 'At the end of a final task report, state the requested-task outcome explicitly. Useful human prose may come first. Then leave a blank line and put exactly one unquoted, unindented terminal line OPENMAUS_TASK_RESULT: {"state":"completed"} only when the requested task is complete, or OPENMAUS_TASK_RESULT: {"state":"blocked","reason":"the concrete blocker"} when it cannot proceed. Use strict JSON with the keys in the shown order, no extra or duplicate fields, one terminal line at most 1200 characters, a nonempty reason at most 1000 characters, and nothing after the marker. Never put this marker in examples, quotes, code fences, hypothetical text or intermediate reports. An engine turn ending successfully does not establish task completion. If the person must answer, use the existing NEEDS INPUT: question convention instead; if handing work off, end the dispatch turn and await the results.';

export function taskDisposition(text: string): TaskDisposition | undefined {
  const legacy = /^BLOCKED: ([^\r\n]+)(?:\r?\n)?$/.exec(text);
  if (legacy?.[1]?.trim()) return { state: "blocked", reason: legacy[1].trim() };
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = normalized.split("\n");
  const last = lines.at(-1)!;
  const prefix = "OPENMAUS_TASK_RESULT: ";
  if (!last.startsWith(prefix) || last.length > 1200 || lines.length > 1 && lines.at(-2) !== "") return undefined;
  const preceding = lines.slice(0, -1);
  if (preceding.some(line => line.includes("OPENMAUS_TASK_RESULT:"))) return undefined;
  let fence: string | undefined;
  for (const line of preceding) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = match?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length && !match![2]!.trim()) fence = undefined;
  }
  if (fence) return undefined;
  try {
    const json = last.slice(prefix.length);
    if (!/^\{\s*"state"\s*:\s*"completed"\s*\}$/.test(json) &&
        !/^\{\s*"state"\s*:\s*"blocked"\s*,\s*"reason"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}$/.test(json)) return undefined;
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort().join(",");
    if (keys === "state" && row.state === "completed") return { state: "completed" };
    if (keys === "reason,state" && row.state === "blocked" && typeof row.reason === "string" && row.reason.trim() && row.reason.length <= 1000 && !/[\r\n]/.test(row.reason)) {
      return { state: "blocked", reason: row.reason.trim() };
    }
  } catch { return undefined; }
  return undefined;
}
