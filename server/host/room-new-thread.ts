// A Chief opens a new thread in a room, as the person's "New thread" does: it becomes the room's current thread.
import { fitsOnOneLine } from "../bot-profile.ts";
import { redactSecretsInText } from "../redact.ts";
import type { Store } from "../store.ts";

const MAX_ROOM_THREADS_PER_TURN = 4;
const TITLE_MAX = 80;

export function openRoomThread({ store, turn, room, name, savingCredential }: {
  store: Pick<Store, "createGroupTask">;
  turn: { openedRoomThreads?: number };
  room: { id: string; name: string };
  name: string | undefined;
  savingCredential: boolean;
}): { status: number; body: Record<string, unknown> } {
  if ((turn.openedRoomThreads ?? 0) >= MAX_ROOM_THREADS_PER_TURN) return { status: 429, body: { error: "you can open at most 4 room threads in one turn" } };
  if (savingCredential) return { status: 409, body: { error: "this room is securely saving a credential — try again when it finishes" } };
  if (name !== undefined && (name.length > TITLE_MAX || !fitsOnOneLine(name))) return { status: 400, body: { error: "a new_thread title must fit on one line, at most 80 characters" } };
  const task = store.createGroupTask(room.id, name === undefined ? undefined : redactSecretsInText(name));
  if (!task) return { status: 500, body: { error: "couldn't open a thread in that room" } };
  turn.openedRoomThreads = (turn.openedRoomThreads ?? 0) + 1;
  return { status: 201, body: { ok: true, threadId: task.threadId, title: task.title,
    message: `Opened thread “${task.title}” [thread: ${task.threadId}] in room “${room.name}”. It is now the room's current thread, so post_to_room for this room and coordinate_bots sent from outside this room go there; coordinate_bots from inside this room stays in that conversation.` } };
}
