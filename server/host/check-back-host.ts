// The quiet line a check-back keeps in its conversation: one activity row, rewritten in place as it moves on. Clients draw
// it from `checkBack`; the row's English words are for clients that don't know the field.
import type { CheckBackLine } from "../../shared/check-back.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import type { Message, Store } from "../store.ts";
import { wallClockLabel } from "./check-back-time.ts";
import type { CheckBackRecord } from "./check-backs.ts";

const WORDS: Record<CheckBackLine["status"], ServerLineKey> = {
  pending: "server.checkBack.pending",
  started: "server.checkBack.started",
  cancelled: "server.checkBack.cancelled",
  dropped: "server.checkBack.cancelled",
  failed: "server.checkBack.failed",
};

export function checkBackRow(record: Pick<CheckBackRecord, "dueAt" | "zone">, line: CheckBackLine, language: string | undefined): Omit<Message, "id" | "at"> {
  const when = wallClockLabel(line.startedAt ?? record.dueAt, record.zone);
  return {
    role: "bot", kind: "activity",
    tool: { name: serverLine(language, WORDS[line.status], { when }), ok: line.status !== "failed" },
    checkBack: line,
  };
}

/** Writes the line, or rewrites it when it is still there; a line someone deleted is written again at the end. */
export function writeCheckBackLine(store: Pick<Store, "appendMessage" | "patchMessage" | "messagesFor">, record: CheckBackRecord, line: CheckBackLine,
  messageId: string | undefined, language: string | undefined): string | undefined {
  const row = checkBackRow(record, line, language);
  if (messageId && store.messagesFor(record.threadId).some((message) => message.id === messageId)) {
    store.patchMessage(record.threadId, messageId, { tool: row.tool, checkBack: line });
    return messageId;
  }
  if (line.status !== "pending") return messageId;
  return store.appendMessage(record.threadId, row).id;
}
