import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const ATTACHMENT_TOOL_NAMES: ReadonlySet<string> = new Set(["list_chat_attachments", "get_chat_attachment", "attach_file"]);

export async function callAttachmentTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { apiResponse } = context.client;
  if (name === "list_chat_attachments" || name === "get_chat_attachment") {
    const { ok, body } = await apiResponse(`/api/internal/chat-attachments/${name === "list_chat_attachments" ? "list" : "get"}`, {
      method: "POST", body: JSON.stringify(name === "list_chat_attachments" ? {} : { attachment_ref: args.attachment_ref, destination_dir: args.destination_dir }),
    });
    return { text: JSON.stringify(body), ...(!ok ? { isError: true } : {}) };
  }
  const { ok, body } = await apiResponse("/api/internal/attach-file", {
    method: "POST",
    body: JSON.stringify({ path: args.path, ...(typeof args.name === "string" ? { name: args.name } : {}) }),
  });
  if (!ok) return { text: String(body.error ?? "Could not attach that file."), isError: true };
  return { text: `Attached ${String(body.name ?? "the file")} (${Number(body.bytes ?? 0)} bytes). It now appears in the chat with a preview.` };
}
