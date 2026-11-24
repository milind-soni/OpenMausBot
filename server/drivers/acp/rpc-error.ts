import { redactSecretsInText } from "../../redact.ts";
import { classifyError } from "../retry.ts";

/** The vendor's own message and the method we called, before redaction or any attached detail. */
const vendorFailures = new WeakMap<object, { message: string; method: string }>();

/** The vendor's own message, without the method and detail acpRpcError adds to what is shown. */
export function acpVendorMessage(error: unknown): string | undefined {
  return error && typeof error === "object" ? vendorFailures.get(error)?.message : undefined;
}

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
  vendorFailures.set(error, { message, method });
  return Object.assign(error, { code: value?.code, data, acpDiagnostic: shown,
    // -32603 is JSON-RPC's internal error; invalid params, unsupported methods and auth refusals keep the session.
    acpSessionFailure: value?.code === -32603,
  });
}

/** A transient transport blip (an SSL EOF behind a proxy, a reset) during a one-shot setup request
 * (authenticate, session/new) is retried once before the failure propagates: classifyError decides,
 * so an auth refusal, an invalid request or a timeout (which would double the wait) never retries. */
export async function retryTransient<T>(request: (method: string, params: unknown, timeoutMs?: number) => Promise<T>,
  method: string, params: unknown, timeoutMs?: number, attempts = 2): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request(method, params, timeoutMs);
    } catch (error) {
      if (attempt >= attempts) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if ((error as any)?.acpSignInRequired === true || /\btimed out\b/.test(message)) throw error;
      if (!classifyError({ text: message }).transient) throw error;
    }
  }
}

/** The provider rejected this resume id. A bare invalidParams (a bad model or config) is not this. */
export function acpMissingSession(error: unknown, cursor: string): boolean {
  const record = error && typeof error === "object" ? error as { data?: unknown } : undefined;
  const data = record?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const fields = data as Record<string, unknown>;
    if (fields.sessionId === cursor && Object.keys(fields).length === 1) return true;
  }
  const refusal = record ? vendorFailures.get(record) : undefined;
  if (!refusal || (refusal.method !== "session/load" && refusal.method !== "session/resume")) return false;
  const named = refusal.message.match(MISSING_SESSION_MESSAGE);
  return named?.[1] === cursor;
}
