import { basename } from "node:path";

import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import type { Message } from "./store.ts";

export interface ConversationAttachment { path: string; name: string }

type Line = Pick<Message, "role" | "text" | "attachments" | "from" | "roomRequest" | "threadPost" | "via">;

/** The stored files of one conversation: what the person attached to their own messages, and the copies already shown
 * in it (a bot's attach_file, files passed with a hand-off). A bot may pass these on by their exact path; the rest of the
 * attachment store, which holds every conversation's files, stays out of reach. Security: a tag is text anyone typing in
 * the chat controls, so a path counts only inside the attachment store (server/bot-attachment.ts). */
export function conversationAttachments(messages: readonly Line[]): ConversationAttachment[] {
  const found = new Map<string, string>();
  for (const message of messages) {
    for (const file of message.attachments ?? []) if (file.kind !== "audio" && !found.has(file.path)) found.set(file.path, file.name ?? basename(file.path));
    if (message.role !== "user" || message.from || message.roomRequest || message.threadPost || message.via || !message.text) continue;
    const { images, files } = splitTranscriptAttachments(message.text, false, false);
    for (const file of [...images, ...files]) if (!found.has(file.path)) found.set(file.path, file.name);
  }
  return [...found].map(([path, name]) => ({ path, name }));
}
