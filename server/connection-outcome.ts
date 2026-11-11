// What a call on a connection showed about it, as connection-health.ts reads outcomes. Only the class is kept: nothing a
// server, an app or a tool said leaves these functions.
import type { ConnectionFailure, ConnectionOutcome } from "./connection-health.ts";
import type { McpFailureKind } from "./mcp-failure.ts";
import type { McpProbeResult } from "./mcp-probe.ts";

export const MCP_FAILURE_CLASS: Readonly<Record<McpFailureKind, ConnectionFailure>> = {
  "sign-in": "sign-in", refused: "refused", "not-found": "not-found", timeout: "timeout", "cant-connect": "cant-connect",
};

/** A refused call names HTTP 403 (permission), not 401 (credentials): only a 401 means the sign-in itself was refused. */
export const forbidsRatherThanSignsOut = (output: string) => /\b(?:HTTP )?403\b/.test(output.split("\n", 1)[0] ?? "");

/** What Test or the background check found. */
export function probeOutcome(result: McpProbeResult): ConnectionOutcome {
  if (result.ok) return { ok: true };
  if (result.auth === "required") return { ok: false, error: "sign-in" };
  if (result.reason === "keys") return { ok: false, error: "refused" };
  if (result.reason === "timeout") return { ok: false, error: "timeout" };
  if (result.reason === "unreachable") return { ok: false, error: "cant-connect" };
  return { ok: false, error: "bad-answer" };
}

/** How the connected-apps service and the apps behind it word an account that needs connecting again, or one refused. */
const SIGNED_OUT = /\b401\b|unauthori[sz]ed|unauthenticated|invalid[_ ](?:grant|token|credentials)|(?:token|credentials?|connection|account)\s+(?:has\s+(?:been\s+)?|is\s+|was\s+)?(?:expired|revoked)|expired\s+(?:token|credentials?|connection|account)|(?:connected account|connection)\s+(?:is\s+)?(?:not active|inactive|not found)|re-?authori[sz]|reconnect|no (?:active )?connected account/i;
const REFUSED = /\b403\b|forbidden|insufficient[_ ](?:scope|permission)s?|permission denied|access denied/i;
const MAX_READ = 262_144;

function frameOf(text: string, contentType: string): unknown {
  if (!contentType.includes("text/event-stream")) {
    try { return JSON.parse(text); } catch { return null; }
  }
  for (const line of text.split("\n").reverse()) {
    if (!line.startsWith("data:")) continue;
    try {
      const frame = JSON.parse(line.slice(5)) as { id?: unknown };
      if (frame && typeof frame === "object" && frame.id !== undefined) return frame;
    } catch {}
  }
  return null;
}

/** Every `error` beside `successful: false` in a tool's answer (the connected-apps service's result shape), a few levels deep. */
function failedErrors(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || !value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const item of value.slice(0, 50)) failedErrors(item, depth + 1, out); return out; }
  const record = value as Record<string, unknown>;
  if (record.successful === false || record.success === false) out.push(typeof record.error === "string" ? record.error : JSON.stringify(record.error ?? ""));
  for (const child of Object.values(record)) if (child && typeof child === "object") failedErrors(child, depth + 1, out);
  return out;
}

const classify = (text: string): ConnectionOutcome | null =>
  SIGNED_OUT.test(text) ? { ok: false, error: "sign-in" } : REFUSED.test(text) ? { ok: false, error: "refused" } : null;

/** What a connected-apps tool call's answer through the relay showed: the account works, needs connecting again or was
 * refused, or the service could not be reached. Null: it says nothing about the account. A tool's own error (a message
 * not found) is the account working. Only a failed call's own error words are read, never what the tool returned. */
export function appCallOutcome(status: number, bytes: Uint8Array, contentType: string): ConnectionOutcome | null {
  if (status === 0 || status >= 500) return { ok: false, error: "cant-connect" };
  if (status < 200 || status >= 300) return null;
  const frame = frameOf(Buffer.from(bytes.subarray(0, MAX_READ)).toString("utf8"), contentType) as { result?: { isError?: unknown; content?: unknown }; error?: unknown } | null;
  if (!frame || typeof frame !== "object" || frame.error !== undefined || !frame.result) return null;
  const texts = Array.isArray(frame.result.content)
    ? frame.result.content.flatMap((item: { type?: unknown; text?: unknown }) => (item?.type === "text" && typeof item.text === "string" ? [item.text] : []))
    : [];
  const errors: string[] = [];
  let parsed = false;
  for (const text of texts) {
    try { failedErrors(JSON.parse(text), 0, errors); parsed = true; } catch {}
  }
  if (!parsed && frame.result.isError === true) errors.push(...texts);
  if (!errors.length) return { ok: true };
  return classify(errors.join("\n").slice(0, 4_000)) ?? { ok: true };
}
