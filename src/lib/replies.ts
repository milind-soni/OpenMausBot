import type { Message } from "@/state/store";
import { t } from "./i18n";

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
  return message.role === "user" ? t("chat.you") : (message.from?.name ?? fallback ?? t("chat.assistant"));
}
