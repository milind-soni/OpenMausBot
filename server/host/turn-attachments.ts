// The files a turn parked while it ran (generated images, recorded voice notes), and what becomes of them when it settles.
import { isStoppedTurnName } from "../../shared/client-cancel.ts";
import { failedTurnCause } from "../../shared/failed-turn.ts";
import { isReceipt } from "../../src/lib/receipts.ts";
import type { Message, Store } from "../store.ts";

export type ParkedTurnAttachment = NonNullable<Message["attachments"]>[number];

/** Every turn keeps the files it parked, whether it finished, failed or was stopped. A goal coordinator's turn loses its
 * images: its artifacts never reach the public room. A note's words stay on it as its transcript, redacted. */
export function settleParkedFiles(
  parked: readonly ParkedTurnAttachment[],
  redact: (text: string) => string,
  coordinator = false,
): { land: ParkedTurnAttachment[]; discard: ParkedTurnAttachment[] } {
  const land: ParkedTurnAttachment[] = [];
  const discard: ParkedTurnAttachment[] = [];
  for (const file of parked) {
    if (file.kind === "image" && coordinator) discard.push(file);
    else if (file.kind !== "audio") land.push(file);
    else land.push({ kind: "audio", path: file.path, mime: file.mime, ...(file.text?.trim() ? { text: redact(file.text.trim()) } : {}) });
  }
  return { land, discard };
}

/** Where a thread's turn parks its files until it settles. */
export function parkedFilesKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId ?? "active"}`;
}

/** Takes what a settling turn parked, and with it anything parked on the thread under another turn: a thread runs one
 * turn at a time, so a file parked under any other key would otherwise never reach the person. */
export function takeParkedFiles(
  parked: Map<string, ParkedTurnAttachment[]>,
  threadId: string,
  turnId: string | undefined,
): { files: ParkedTurnAttachment[]; strays: string[] } {
  const own = parkedFilesKey(threadId, turnId);
  const files = [...parked.get(own) ?? []];
  parked.delete(own);
  const strays: string[] = [];
  for (const [key, more] of parked) {
    if (!key.startsWith(`${threadId}:`)) continue;
    parked.delete(key);
    files.push(...more);
    strays.push(key.slice(threadId.length + 1));
  }
  return { files, strays };
}

const endsTurn = (message: Message) => message.kind === "activity" && message.tool !== undefined
  && (failedTurnCause(message.tool.name) !== null || isStoppedTurnName(message.tool.name));

/** Puts files on the turn's last reply line. A turn that wrote none gets a line of its own, placed above the error or
 * stop lines the turn ended on (receipts such as its digest aside), so they stay last and Retry stays with them. */
export function landTurnFiles(
  store: Pick<Store, "activePath" | "patchMessage" | "insertMessageAfter">,
  turn: { threadId: string; turnId: string | undefined; from?: Message["from"] },
  files: readonly ParkedTurnAttachment[],
  /** How a new last line is written, so it carries what the thread's other lines carry. */
  append: (line: Omit<Message, "id" | "at">) => unknown,
): void {
  const { threadId, turnId, from } = turn;
  if (!files.length) return;
  const path = store.activePath(threadId);
  const reply = path.findLast((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId);
  if (reply) {
    store.patchMessage(threadId, reply.id, { attachments: [...(reply.attachments ?? []), ...files] });
    return;
  }
  const line = { role: "bot" as const, kind: "text" as const, text: "", attachments: [...files], turnId, ...(from ? { from } : {}) };
  let ending: number | undefined;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (isReceipt(path[i]!)) continue;
    if (!endsTurn(path[i]!)) break;
    ending = i;
  }
  if (ending === undefined) append(line);
  else store.insertMessageAfter(threadId, path[ending - 1]?.id, line);
}
