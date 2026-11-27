import type { WireMessage } from "../../shared/wire.ts";
import { escapeAttribute } from "./composer-attachments.ts";
import { peerLine } from "./peer-message.ts";

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

export function roomRetryRequest(transcript: readonly RetryMessage[], stoppedIndex: number): RoomRetryRequest | null {
  for (let index = stoppedIndex - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (!message || message.role !== "user") continue;
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
