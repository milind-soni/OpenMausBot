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
