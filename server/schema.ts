import type { z } from "zod";

import type { JsonValue } from "../shared/json.ts";

// The plain-JSON vocabulary lives in shared/json.ts now (part of the wire
// model); re-exported here so existing importers keep working.
export type { JsonObject, JsonPrimitive, JsonValue } from "../shared/json.ts";

/** JSON.parse without a reviver can only produce JSON-compatible values. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

export function schemaIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const path = issue.path.map(String).join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}
