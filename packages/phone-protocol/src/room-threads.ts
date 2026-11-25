/** Who said a line in a room: one of its bots, or a person (`id` and `name` from their `sender`; neither for the
 * server's own profile person). */
export type RoomThreadSpeaker = { botId: string } | { person: { id?: string; name?: string } };

/** One of a room's threads as its feed shows it. `first` is the thread's first conversation line, its text clamped to
 * ROOM_THREAD_FIRST_CHARS (`clipped` when cut); null while the thread has no line yet. `replies` counts the conversation
 * lines after it, on every branch of the thread; `repliers` are the latest distinct speakers of those, newest first, at
 * most ROOM_THREAD_REPLIERS. */
export interface RoomThreadSummary {
  threadId: string;
  first: { text: string; clipped?: true; speaker: RoomThreadSpeaker; at: number } | null;
  replies: number;
  lastReplyAt: number | null;
  repliers: RoomThreadSpeaker[];
}

/** GET /api/groups/:id/threads/summary: the room's threads that are not archived. */
export interface RoomThreadSummariesResponse {
  threads: RoomThreadSummary[];
}

export const ROOM_THREAD_FIRST_CHARS = 400;
export const ROOM_THREAD_REPLIERS = 5;
