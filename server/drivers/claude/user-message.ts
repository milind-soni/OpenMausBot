// Stream-json user-message shaping for the Claude driver: text/image
// content blocks, the volatile-system-prompt note, and the diagnostic form
// that never persists base64 image bytes. Split out of drivers/claude.ts.
import { readFileSync } from "node:fs";

import type { SendTurnInput } from "../../contracts.ts";

type ClaudeImage = NonNullable<SendTurnInput["images"]>[number];
type ClaudeUserContent =
  | { type: "image"; source: { type: "base64"; media_type: ClaudeImage["mime"]; data: string } }
  | { type: "text"; text: string };
export type ClaudeUserMessage = {
  type: "user";
  message: { role: "user"; content: string | ClaudeUserContent[] };
};

/** Claude's stream-json input accepts the same image source blocks as the
 * Anthropic Messages API. Keep the old string form for text-only turns so a
 * CLI update cannot disturb the overwhelmingly common path. */
/** How a mid-session change to the volatile half of the system prompt
 * reaches a model whose process was launched with the old copy. The CLI's
 * own out-of-band convention inside a user turn, and it costs one short
 * append rather than a relaunch that re-uploads the whole prompt cache. */
export function withVolatileNote(text: string, volatile: string): string {
  const body = volatile.trim()
    ? `This part of your instructions changed since this session started. It replaces the earlier copy:\n\n${volatile.trim()}`
    : "The notes that were in your instructions when this session started have been cleared.";
  const note = `<system-reminder>\n${body}\n</system-reminder>`;
  return text ? `${note}\n\n${text}` : note;
}

export function claudeUserMessage(
  text: string,
  images: readonly ClaudeImage[] | undefined,
): ClaudeUserMessage {
  if (!images?.length) return { type: "user", message: { role: "user", content: text } };
  const content: ClaudeUserContent[] = images.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.mime,
      data: readFileSync(image.path).toString("base64"),
    },
  }));
  if (text) content.push({ type: "text", text });
  return { type: "user", message: { role: "user", content } };
}

/** Native traces are routinely attached to bug reports. Preserve the image
 * block's shape and size for debugging, but never persist its base64 bytes. */
export function diagnosticClaudeUserMessage(message: ClaudeUserMessage): ClaudeUserMessage {
  if (!Array.isArray(message.message.content)) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.map((block) =>
        block.type === "image"
          ? {
              ...block,
              source: {
                ...block.source,
                data: `[image data: ${block.source.data.length} base64 chars]`,
              },
            }
          : block,
      ),
    },
  };
}
