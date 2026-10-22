// OMB's own timing of each agents tool call, sent to the harness after the call so the trace shows the server's measure on
// every engine. Fire and forget: a lost receipt costs only the timing, never the call.
import { errorLine, toolDetail } from "../usage-trace/detail.ts";
import type { Json } from "./agents-client.ts";
import type { ToolCallContext } from "./agents-call.ts";

const RECEIPT_TIMEOUT_MS = 2_000;

export function sendToolReceipt(context: Pick<ToolCallContext, "client">, name: string, args: Json, startedAt: number, outcome: { ok: boolean; error?: string }): void {
  const detail = toolDetail(name, args);
  const error = outcome.ok ? undefined : errorLine(outcome.error);
  const body = JSON.stringify({ name, startedAt, endedAt: Date.now(), ok: outcome.ok, ...(detail ? { detail } : {}), ...(error ? { error } : {}) });
  try {
    void context.client.apiResponse("/api/internal/tool-timing", { method: "POST", body, signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS) }).catch(() => {});
  } catch {
  }
}
