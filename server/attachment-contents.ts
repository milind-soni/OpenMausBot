import { ATTACHMENTS_DIR } from "./attachments.ts";

/** The turn text an engine receives for its attachments: today only the `<attached-file>` tag, whatever the engine can open. */
export function withAttachmentContents(text: string, _inline: boolean, _attachmentsDir = ATTACHMENTS_DIR): string {
  return text;
}
