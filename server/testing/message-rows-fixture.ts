import type { MessageRows } from "../attachment-references.ts";

/** In-memory conversations as message rows, one per message numbered in order: a reader for createAttachmentReferences. */
export const rowsOfConversations = (conversations: ReadonlyMap<string, readonly unknown[]>) => (): MessageRows => (after, limit) =>
  [...conversations.values()].flat().map((message, index) => ({ rowid: index + 1, json: JSON.stringify(message) })).filter((row) => row.rowid > after).slice(0, limit);
