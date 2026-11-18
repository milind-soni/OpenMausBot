// Closing a bot's seat: the bot writes a hand-off note in its own conversation, the note becomes the summary its next turn
// starts from in a new engine session, and the engine kept for the conversation closes now instead of at its idle time.
import { openPersonWait } from "../shared/person-wait.ts";
import { closeIdleEngines } from "./drivers/session-idle.ts";
import { sinceFreshStart } from "./fresh-start.ts";
import type { Message, Store, TaskRecord } from "./store.ts";
import { userError, type UserError } from "./user-errors.ts";

export const HANDOFF_REQUEST =
  "Write a short hand-off note for when this conversation is picked up again in a new session: where you got to, " +
  "what you were about to do next, and anything that must not be forgotten. Reply with the note only, under 200 words.";

type SeatStore = Pick<Store, "activePath" | "appendMessage" | "patchTask" | "taskByThread">;

export type ConversationRefusal = UserError & { threadId: string; title: string };

/** The bot's answer to the newest hand-off request, while no one has written in the conversation since. */
export function handoffNote(path: readonly Message[]): Message | null {
  const asked = path.findLast((message) => message.role === "user");
  if (asked?.kind !== "text" || asked.text !== HANDOFF_REQUEST) return null;
  return path.slice(path.indexOf(asked) + 1).findLast((message) => message.role === "bot" && message.kind === "text" && Boolean(message.text?.trim())) ?? null;
}

/** Why the seat cannot close now, in the words the person is shown; null when it can. */
export function seatCloseRefusal(store: Pick<Store, "activePath">, threadId: string, busy: boolean): UserError | null {
  if (busy) return userError("serverError.seat.busy");
  const path = store.activePath(threadId);
  const wait = openPersonWait(path);
  if (wait) return userError("serverError.seat.waiting", { kind: wait.kind });
  if (!handoffNote(sinceFreshStart(path))) return userError("serverError.seat.noNote");
  return null;
}

/** Saves the note as the conversation's summary with its engine session dropped, so the next turn opens a new session
 * from the note and never resumes the old one; then closes the engine kept idle for it. A second close saves nothing new. */
export function closeSeat(store: SeatStore, botId: string, threadId: string): Message | null {
  const path = sinceFreshStart(store.activePath(threadId));
  const note = handoffNote(path);
  if (!note?.text || !store.taskByThread(botId, threadId)) return null;
  const newest = path.at(-1);
  let saved = newest?.kind === "compaction" && newest.compaction?.foldedThroughId === note.id ? newest : null;
  if (!saved) {
    store.patchTask(botId, threadId, { resumeCursors: {} });
    saved = store.appendMessage(threadId, {
      role: "bot", kind: "compaction",
      compaction: { summary: note.text.trim(), firstKeptId: "", foldedThroughId: note.id, tokensBefore: 0, by: "person" },
    });
  }
  closeIdleEngines(threadId);
  return saved;
}

/** The bot's conversations that still hold an engine session to resume: what closing its whole seat ends. */
export function openConversations(store: Pick<Store, "tasks">, botId: string): TaskRecord[] {
  return store.tasks(botId).filter((task) => Object.keys(task.resumeCursors ?? {}).length > 0);
}

/** Closes every open conversation of the bot, or none: while any one cannot close, each that cannot says why and nothing
 * changes. `mayClose` leaves out conversations the caller may not change; they stay as they are. */
export function closeWholeSeat(
  store: SeatStore & Pick<Store, "tasks">,
  botId: string,
  busy: (threadId: string) => boolean,
  mayClose: (threadId: string) => boolean = () => true,
): { closed: Message[]; refusals: ConversationRefusal[] } {
  const open = openConversations(store, botId).filter((task) => mayClose(task.threadId));
  const refusals = open.flatMap((task) => {
    const refusal = seatCloseRefusal(store, task.threadId, busy(task.threadId));
    return refusal ? [{ ...refusal, threadId: task.threadId, title: task.title }] : [];
  });
  if (refusals.length) return { closed: [], refusals };
  return { closed: open.flatMap((task) => closeSeat(store, botId, task.threadId) ?? []), refusals: [] };
}
