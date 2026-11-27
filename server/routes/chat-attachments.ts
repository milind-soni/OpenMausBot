import { FILE_MAX_BYTES } from "../attachments.ts";
import { collectChatAttachments, fetchChatAttachment, listChatAttachments, type ChatAttachment } from "../chat-attachment-fetch.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createChatAttachmentRoutes<Vm extends { workspaceDir: string }>(deps: {
  attachmentStore: string;
  guestRoot: string;
  botId: string;
  threadId: string;
  sourceExists: () => boolean;
  messages: () => Parameters<typeof collectChatAttachments>[0];
  parked: () => readonly ChatAttachment[];
  vmForTurn: () => Promise<Vm | undefined>;
  active: (vm: Vm) => boolean;
  readBody: () => Promise<Record<string, unknown>>;
}): RouteHandler {
  return async ({ method, path, res, json }) => {
    if (method !== "POST" || (path !== "/api/internal/chat-attachments/list" && path !== "/api/internal/chat-attachments/get")) return PASS;
    if (!deps.sourceExists()) return json(res, 403, { error: "source conversation does not belong to sender" });
    const body = await deps.readBody();
    const attachments = () => collectChatAttachments(deps.messages(), deps.parked());
    if (path.endsWith("/list")) return json(res, 200, { attachments: listChatAttachments(deps.attachmentStore, attachments()) });
    if (typeof body.attachment_ref !== "string" || (body.destination_dir !== undefined && typeof body.destination_dir !== "string")) return json(res, 400, { error: "attachment_ref is required; destination_dir is optional text" });
    try {
      const vm = await deps.vmForTurn();
      if (!vm) return json(res, 409, { error: "This turn has no Local VM. Select a Local VM before fetching an attachment." });
      if (!deps.active(vm) || !deps.sourceExists()) return json(res, 409, { error: "This turn no longer owns the conversation or Local VM." });
      const result = fetchChatAttachment({ attachmentStore: deps.attachmentStore, attachments: attachments(), workspace: vm.workspaceDir,
        guestRoot: deps.guestRoot, botId: deps.botId, threadId: deps.threadId, maxBytes: FILE_MAX_BYTES }, body.attachment_ref, body.destination_dir);
      return json(res, 200, result);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 409;
      return json(res, status, { error: (error as { status?: number }).status ? (error as Error).message : "Cannot export attachment: check directory permissions and avoid symlink destinations." });
    }
  };
}
