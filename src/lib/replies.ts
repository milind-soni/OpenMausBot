import type { Message } from "@/state/store";
import { t } from "./i18n";
import { peerLine } from "./peer-message";

export function replySnippet(text: string, limit = 160): string {
  const clean = text
    .replace(
      /<attached-(image|file)\s+path="[^"]*"(?:\s+name="[^"]*")?\s*\/>/g,
      (_tag, kind: "image" | "file") => (kind === "image" ? t("chat.reply.image") : t("chat.reply.file")),
    )
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function replyAuthor(message: Message, fallback?: string): string {
  if (message.role === "user") return peerLine(message)?.name ?? t("chat.you");
  return message.from?.name ?? fallback ?? t("chat.assistant");
}
