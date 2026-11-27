import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const jsonRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** How much of a long result the assignment notice shows before it says where to read on. */
const RESULT_HEAD = 2_000;

/** A long result is read on with tool_result_read, given the assignment's own id: it is kept with the assignment, not in
 * the hour-long saved results, so the tool list stays as it is. */
const readOn = (id: string, offset: number) => `[The result goes on: call tool_result_read with id "${id}" and offset ${offset} to read the next part.]`;

/** One part of a long result, and where the next starts; past the end of what was kept, whether it was all of it. */
export function resultPartLines(part: Json, id: string): string[] {
  const text = typeof part.text === "string" ? part.text : "";
  const offset = Number(part.offset) || 0;
  const end = Number(part.end) || offset;
  const total = Number(part.total) || end;
  const lines = [`Result, characters ${offset}-${end} of ${total}: ${text}`];
  if (text && end < total) lines.push(readOn(id, end));
  else if (part.truncated === true) {
    lines.push(`[truncated: only the first ${end} of ${total} characters of this result were kept; the rest is lost. Tell the person the end of the report is missing; do not present what you read as the whole report.]`);
  } else lines.push("[End of the result: that was all of it.]");
  return lines;
}

/** The result lines of an assignment notice: all of a short result, or its head and where to read on. */
export function assignmentResultLines(a: Json, id: string): string[] {
  const result = typeof a.result === "string" ? a.result : "";
  const total = typeof a.resultChars === "number" ? a.resultChars : result.length;
  if (!result.trim()) return [];
  if (total <= RESULT_HEAD) return [`Result: ${result.trim()}`];
  return [`Result, characters 0-${RESULT_HEAD} of ${total}: ${result.slice(0, RESULT_HEAD)}`, readOn(id, RESULT_HEAD)];
}

/** tool_result_read given an assignment id (any id that is not a saved result's `r-` id): the next part of its result. */
export function isAssignmentResultRead(args: Json): args is Json & { id: string } {
  const offsetOk = args.offset === undefined || (Number.isSafeInteger(args.offset) && Number(args.offset) >= 0);
  return typeof args.id === "string" && !args.id.startsWith("r-") && /^[\w-]{4,64}$/.test(args.id) && offsetOk;
}

export async function readAssignmentResult(args: Json & { id: string }, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, status, body: r } = await context.client.apiResponse(`/api/internal/assignment-status?id=${encodeURIComponent(args.id)}&offset=${Number(args.offset ?? 0)}`);
  const part = ok && jsonRecord(r.assignment) && jsonRecord(r.assignment.resultPart) ? r.assignment.resultPart : undefined;
  if (!part) return { text: status === 404 ? `No assignment ${args.id} is known here: use the id the last notice gave.` : String(r.error ?? `HTTP ${status}`), isError: true };
  return { text: resultPartLines(part, args.id).join("\n") };
}
