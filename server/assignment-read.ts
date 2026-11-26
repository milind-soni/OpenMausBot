// Which conversation may read a hand-off's status and result (assignment_status). The one it was sent from always may.
// Another of the same bot's own one-on-one chats may too, when both belong to the same people: a room, a guest's chat
// or another member's chat keeps its hand-offs to itself.

export type AssignmentReadPlace = {
  /** The bot asking: its main chat or one of its own threads, not a room and not another bot's. */
  ownChat(threadId: string): boolean;
  /** A guest or something from outside drove this conversation. */
  guest(threadId: string): boolean;
  /** Who the conversation belongs to (one team member, a room, the whole team). */
  audienceOf(threadId: string): string;
};

/** Why `fromThreadId` may not read a hand-off sent from `sentFromThreadId`, or null when it may. */
export function assignmentReadRefusal(fromThreadId: string, sentFromThreadId: string | undefined, place: AssignmentReadPlace): string | null {
  if (sentFromThreadId === fromThreadId) return null;
  if (!sentFromThreadId || !place.ownChat(sentFromThreadId) || !place.ownChat(fromThreadId)) {
    return "it was handed off from a room or by another bot; only the conversation that sent it can read it";
  }
  if (place.guest(sentFromThreadId) || place.guest(fromThreadId) || place.audienceOf(sentFromThreadId) !== place.audienceOf(fromThreadId)) {
    return "it was handed off from a chat that belongs to someone else; only that chat can read it";
  }
  return null;
}
