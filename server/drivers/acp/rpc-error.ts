import { redactSecretsInText } from "../../redact.ts";

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
  const error = new Error(redactSecretsInText(diagnostic).slice(0, 1500));
  return Object.assign(error, { code: value?.code, data,
    // -32603 is JSON-RPC's internal error; invalid params, unsupported methods and auth refusals keep the session.
    acpSessionFailure: value?.code === -32603,
  });
}

/** The provider rejected this resume id. A bare invalidParams (a bad model or config) is not this. */
export function acpMissingSession(error: unknown, cursor: string): boolean {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.sessionId === cursor && Object.keys(record).length === 1) return true;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(cursor) && /\bnot found\b/i.test(message) && /\bsession\/(?:load|resume)\b/.test(message);
}
