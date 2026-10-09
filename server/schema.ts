import type { z } from "zod";

import type { JsonValue } from "../shared/json.ts";

// The plain-JSON vocabulary lives in shared/json.ts now (part of the wire
// model); re-exported here so existing importers keep working.
export type { JsonObject, JsonPrimitive, JsonValue } from "../shared/json.ts";

/** JSON.parse without a reviver can only produce JSON-compatible values.
 * A leading byte order mark is dropped first: Windows PowerShell's
 * `Set-Content -Encoding UTF8` and Notepad's "UTF-8 with BOM" write one, and
 * JSON.parse rejects it, so a hand-edited config.json read as invalid. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function schemaIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const path = issue.path.map(String).join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}
