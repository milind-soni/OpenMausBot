export type PeerAction = "ask_bot" | "delegate_bot" | "post_to_room";

/** Stable persisted grant for one peer action and one target — a bot for
 * the two peer actions, the room for post_to_room. */
export function peerAllowKey(action: PeerAction, targetId: string): string {
  return `${action}:${targetId}`;
}
