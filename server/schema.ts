import type { z } from "zod";

import type { JsonValue } from "../shared/json.ts";

export type { JsonObject, JsonPrimitive, JsonValue } from "../shared/json.ts";

/** Drops a leading BOM first: PowerShell's Set-Content -Encoding UTF8 and Notepad write one, and JSON.parse rejects it. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function schemaIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const path = issue.path.map(String).join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}
