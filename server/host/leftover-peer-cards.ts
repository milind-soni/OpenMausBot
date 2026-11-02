// A card that asked whether a bot may contact another, left open on disk by an earlier version. Nothing can answer it any
// more, and an open card locks the composer.
import { optionCardsForTools } from "../message-db.ts";
import type { Store } from "../store.ts";

const PEER_CARD_TOOLS = ["ask_bot", "delegate_bot", "post_to_room"];

export function dismissLeftoverPeerCards(store: Pick<Store, "bots" | "groups" | "messagesFor" | "patchMessage">): number {
  const threads = new Set([...store.bots, ...store.groups].flatMap((owner) => [owner.threadId, ...(owner.tasks ?? []).map((task) => task.threadId)]));
  let dismissed = 0;
  for (const { threadId, messageId } of optionCardsForTools(PEER_CARD_TOOLS)) {
    if (!threads.has(threadId)) continue;
    const card = store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
    if (!card?.requestId || card.answered || card.dismissed) continue;
    if (store.patchMessage(threadId, messageId, { card: { ...card, answered: "deny", dismissed: true } })) dismissed += 1;
  }
  return dismissed;
}
