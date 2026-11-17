import { MODEL_NO_ROUTE } from "../retry.ts";

/** OpenCode 1.19.4 retries a model server that refuses the connection for about a minute, then answers session/prompt
 * `{code: -32603, message: "Internal error: Cannot connect to API: ECONNREFUSED: Unable to connect. Is the computer able
 * to access the url?", data: {service: "session", errorName: "APIError"}}`; 1.18.27 drops "ECONNREFUSED: " and other
 * builds say "ConnectionRefused". Only the refusal wording is proven; other connect failures such as "Connect Timeout
 * Error" stay ordinary errors. It answers the same after a tool already ran, so only the absence of prompt activity
 * proves nothing started. OpenCode 2.2.5 answers `errorName: "provider.no-route"` for a model it has no route to
 * ("Unsupported package for …"), before any request to a model. */
export function openCodePromptUnreachedModel(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (value.code !== -32603) return false;
  const data = value.data && typeof value.data === "object" && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : {};
  if (data.errorName === "provider.no-route") return true;
  const text = [value.message, data.message, data.details].filter((part) => typeof part === "string").join(" ");
  return /\bECONNREFUSED\b|\bConnectionRefused\b|\bCannot connect to API: Unable to connect\b/u.test(text) || MODEL_NO_ROUTE.test(text);
}
