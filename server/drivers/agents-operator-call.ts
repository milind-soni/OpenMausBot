import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export async function callOperatorTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/chief-operator", {
    method: "POST",
    body: JSON.stringify({ action: args.action, ...(args.setting !== undefined ? { setting: args.setting } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      ...(args.preview_id !== undefined ? { previewId: args.preview_id } : {}),
      ...(args.receipt_id !== undefined ? { receiptId: args.receipt_id } : {}),
      ...(args.expected_revision !== undefined ? { expectedRevision: args.expected_revision } : {}) }),
  });
  return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "Chief Operator request was refused."), isError: true };
}
