import { ZodError } from "zod";
import { BodyTooLarge } from "./http-body";
import { ExecutionError } from "./execution-common";

export const executionResponseHeaders = { "Cache-Control": "private, no-store", "Pragma": "no-cache" };
export function executionHttpFailure(error: unknown) {
  const status = error instanceof ExecutionError ? error.status : error instanceof BodyTooLarge ? 413 : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500;
  const message = error instanceof ExecutionError ? error.message : error instanceof BodyTooLarge ? "Request is too large" : error instanceof ZodError ? error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") : status === 400 ? "Invalid request" : "Execution request failed";
  return Response.json({ error: message }, { status, headers: executionResponseHeaders });
}
