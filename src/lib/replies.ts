import type { Message } from "@/state/store";
import { t } from "./i18n";
import { peerLine } from "./peer-message";
import { citationPreviewText } from "./citations";

export function replySnippet(text: string, limit = 160): string {
  const clean = citationPreviewText(text)
    .replace(
      /<attached-(image|file)\s+path="[^"]*"(?:\s+name="[^"]*")?\s*\/>/g,
      (_tag, kind: "image" | "file") => (kind === "image" ? t("chat.reply.image") : t("chat.reply.file")),
    )
    // read as text, not markup: the excerpt is one muted line
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function replyAuthor(message: Message, fallback?: string): string {
  if (message.role === "user") return peerLine(message)?.name ?? t("chat.you");
  return message.from?.name ?? fallback ?? t("chat.assistant");
}

/** Escape in the composer drops a reply target, the keyboard twin of the
 * reply strip's x. Not mid IME composition, and not while dictating, where
 * Escape stops the recording instead. */
export function escapeCancelsReply(
  event: { key: string; isComposing?: boolean },
  { replying, recording }: { replying: boolean; recording: boolean },
): boolean {
  return event.key === "Escape" && replying && !recording && !event.isComposing;
}
