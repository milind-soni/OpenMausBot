import { redactSecretsInText } from "../../redact.ts";

/** The vendor's own message and the method we called, before redaction or any attached detail. */
const resumeRefusal = new WeakMap<object, { message: string; method: string }>();

/** Words around the id are case-insensitive. The captured id keeps the vendor's case. */
const MISSING_SESSION_MESSAGE = /^\s*(?:invalid params:\s*)?session\s+"([^"]+)"\s+not found\b(?:\s*\(session\/(?:load|resume)\))?[\s.]*$/i;

/** ACP vendors put the actionable cause in error.data under a generic JSON-RPC message. Only known
 * text fields surface, redacted, never a response body or config dump. */
export function acpRpcError(value: any, method: string): Error {
  const message = typeof value?.message === "string" ? value.message : "ACP request failed";
  const data = value?.data;
  const detail = typeof data === "string" ? data
    : typeof data?.details === "string" ? data.details
    : typeof data?.message === "string" ? data.message
    : typeof data?.error?.message === "string" ? data.error.message
    : "";
  const context = [
    method,
    typeof data?.service === "string" ? `service: ${data.service}` : "",
    typeof data?.errorName === "string" ? data.errorName : "",
  ].filter(Boolean).join(", ");
  const diagnostic = `${detail && detail !== message ? `${message}: ${detail}` : message} (${context})`;
  const shown = redactSecretsInText(diagnostic);
  const error = new Error(shown.slice(0, 1500));
  resumeRefusal.set(error, { message, method });
  return Object.assign(error, { code: value?.code, data, acpDiagnostic: shown,
    // -32603 is JSON-RPC's internal error; invalid params, unsupported methods and auth refusals keep the session.
    acpSessionFailure: value?.code === -32603,
  });
}

/** The provider rejected this resume id. A bare invalidParams (a bad model or config) is not this. */
export function acpMissingSession(error: unknown, cursor: string): boolean {
  const record = error && typeof error === "object" ? error as { data?: unknown } : undefined;
  const data = record?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const fields = data as Record<string, unknown>;
    if (fields.sessionId === cursor && Object.keys(fields).length === 1) return true;
  }
  const refusal = record ? resumeRefusal.get(record) : undefined;
  if (!refusal || (refusal.method !== "session/load" && refusal.method !== "session/resume")) return false;
  const named = refusal.message.match(MISSING_SESSION_MESSAGE);
  return named?.[1] === cursor;
}
