import type { Attachment } from "@/state/store";

/** Mirrors readBody's default limit in server/index.ts, which counts the
 * decoded JSON body's string length. Attachments travel as base64 data URLs
 * inside that body, so a ~750 KB image already fills it. */
export const MAX_MESSAGE_BODY_CHARS = 1_000_000;

export function messageBodySize(text: string, attachments?: Attachment[]): number {
  return JSON.stringify({ text, attachments }).length;
}

function formatSize(chars: number): string {
  return chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)} MB` : `${Math.ceil(chars / 1_000)} KB`;
}

/** Why a message can't be sent, or null when it fits. */
export function messageTooLargeReason(text: string, attachments?: Attachment[]): string | null {
  const size = messageBodySize(text, attachments);
  if (size <= MAX_MESSAGE_BODY_CHARS) return null;
  const hasFiles = Boolean(attachments?.length);
  const fix = hasFiles ? "Remove or shrink an attachment, or shorten the text." : "Shorten it, or save it to a file in the project and point the bot at it.";
  return `This message is too large to send (${formatSize(size)}; the limit is ${formatSize(MAX_MESSAGE_BODY_CHARS)}). ${fix}`;
}
