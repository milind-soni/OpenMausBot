// The agents catalog's chat_folders tool: a bot lists and creates its own sidebar folders and moves its own threads
// into or out of them, as the person's "New folder" and "Move to folder" do. The internal routes
// (server/routes/internal-threads.ts) only take the bot's own folders and threads.
import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const CHAT_FOLDERS_TOOL = "chat_folders";

type Folder = { id: string; name: string; emoji?: string; threads?: Array<{ threadId: string; title: string }> };

const label = (folder: Folder) => `${folder.emoji ? `${folder.emoji} ` : ""}${folder.name}`;

export async function callChatFoldersTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const action = args.action;
  if (action !== "list" && action !== "create" && action !== "move") {
    return { text: "chat_folders needs action: list, create or move.", isError: true };
  }
  const from = { fromBotId: context.botId, fromThreadId: context.threadId };
  if (action === "list") {
    const r = await context.client.api(`/api/internal/folders?${new URLSearchParams(from).toString()}`);
    if (r.error) return { text: `Couldn't list your folders: ${String(r.error)}`, isError: true };
    const folders = (r.folders ?? []) as Folder[];
    if (!folders.length) return { text: "You have no folders yet. Create one with action create." };
    return { text: folders.map((folder) => `${label(folder)} (id ${folder.id}): ${folder.threads?.length
      ? folder.threads.map((one) => `#${one.title} (${one.threadId})`).join(", ") : "no threads"}`).join("\n") };
  }
  if (action === "create") {
    if (typeof args.name !== "string" || !args.name.trim()) return { text: "chat_folders create needs name: the folder's name, at most 80 characters.", isError: true };
    if (args.emoji != null && typeof args.emoji !== "string") return { text: "chat_folders create takes emoji as one emoji, or leave it out.", isError: true };
    const r = await context.client.api("/api/internal/folders", {
      method: "POST",
      body: JSON.stringify({ ...from, name: args.name, ...(args.emoji ? { emoji: args.emoji } : {}) }),
    });
    if (r.error) return { text: `Couldn't create the folder: ${String(r.error)}`, isError: true };
    const folder = r.folder as Folder;
    return { text: r.existed ? `You already have the folder ${label(folder)} (id ${folder.id}); nothing new was made.` : `Created the folder ${label(folder)} (id ${folder.id}).` };
  }
  if (args.thread_id != null && typeof args.thread_id !== "string") {
    return { text: "chat_folders move needs thread_id as a string from list_threads; leave it out for this thread.", isError: true };
  }
  if (typeof args.folder !== "string") {
    return { text: "chat_folders move needs folder: a folder name or id, or \"\" to take the thread out of its folder.", isError: true };
  }
  const r = await context.client.api("/api/internal/folders/move", {
    method: "POST",
    body: JSON.stringify({ ...from, folder: args.folder, ...(typeof args.thread_id === "string" && args.thread_id.trim() ? { moveThreadId: args.thread_id.trim() } : {}) }),
  });
  if (r.error) return { text: `Couldn't move the thread: ${String(r.error)}`, isError: true };
  const folder = r.folder as Folder | null;
  return { text: folder ? `Moved #${String(r.title)} into ${label(folder)}.` : `Took #${String(r.title)} out of its folder.` };
}

export const CHAT_FOLDERS_TOOL_DEFINITION = {
  name: CHAT_FOLDERS_TOOL,
  description: "Your own sidebar folders, only when the person asks: list them with their threads, create one, or move one of your threads into one.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "create", "move"] },
      name: { type: "string", description: "create: at most 80 characters." },
      emoji: { type: "string" },
      thread_id: { type: "string", description: "move: from list_threads; default: this thread." },
      folder: { type: "string", description: "move: name or id; \"\" takes it out of its folder." },
    },
    required: ["action"],
  },
};
