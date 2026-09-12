export type PeerAction = "ask_bot" | "delegate_bot" | "post_to_room" | "send_room_message" | "discuss_room" | "assign_room_member";

/** Stable persisted grant for one peer action and one target — a bot for
 * the two peer actions, the room for post_to_room. */
export function peerAllowKey(action: PeerAction, targetId: string): string {
  return `${action}:${targetId}`;
}
