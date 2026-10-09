// Retry on a stopped room turn resends the request that turn answered: the
// person's message right before the stop, never an earlier one, with its
// files. A room send carries files as <attached-…> tags in its text, so a
// file kept only in the message's attachments is written back as a tag.
import type { WireMessage } from "../../shared/wire.ts";
import { escapeAttribute } from "./composer-attachments.ts";
import { peerLine } from "./peer-message.ts";

/** The fields Retry reads. The client's Message and a stored wire message
 * both fit. */
type RetryMessage = Pick<WireMessage, "id" | "role" | "kind" | "text" | "attachments" | "channelMode" | "replyToId" | "peerAsk">;

export interface RoomRetryRequest {
  messageId: string;
  text: string;
  mode: "chat" | "goal";
  replyToId?: string;
}

function attachmentTags(message: RetryMessage, text: string): string[] {
  const tags: string[] = [];
  for (const attachment of message.attachments ?? []) {
    const path = escapeAttribute(attachment.path);
    if (text.includes(`path="${path}"`)) continue;
    const name = escapeAttribute(attachment.kind === "file" ? attachment.name : attachment.path.split(/[\\/]/).at(-1) ?? attachment.path);
    tags.push(`<${attachment.kind === "image" ? "attached-image" : "attached-file"} path="${path}" name="${name}" />`);
  }
  return tags;
}

/** The request a stopped row at `stoppedIndex` can resend, or null when the
 * turn's request is not a person's message that can be sent again (a bot's
 * line, an unsaved optimistic send, or nothing to send). */
export function roomRetryRequest(transcript: readonly RetryMessage[], stoppedIndex: number): RoomRetryRequest | null {
  for (let index = stoppedIndex - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (!message || message.role !== "user") continue;
    // The turn answered the nearest line someone sent. A bot's line in the
    // room started it, so there is no person's request to resend.
    if (peerLine(message) || message.kind !== "text" || message.id.startsWith("optimistic-")) return null;
    const base = message.text?.trim() ?? "";
    const text = [base, ...attachmentTags(message, base)].filter(Boolean).join("\n\n");
    if (!text) return null;
    return {
      messageId: message.id,
      text,
      mode: message.channelMode ?? "chat",
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
    };
  }
  return null;
}
