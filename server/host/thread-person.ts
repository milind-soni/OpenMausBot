// Which person a conversation's line or card came from, read from the server's own records.
import type { Message, Store } from "../store.ts";

export function linePersonKey(message: Message | undefined): string | undefined {
  return message?.role === "user" && !message.peerAsk ? message.sender?.id : undefined;
}

export function createCardRequester(store: () => Pick<Store, "messagesFor">) {
  return function cardRequesterKey(threadId: string, requestId: string): string | undefined {
    const thread = store().messagesFor(threadId);
    const index = thread.findIndex((message) => message.card?.requestId === requestId);
    if (index < 0) return undefined;
    const card = thread[index]!;
    return linePersonKey(card.requestMessageId
      ? thread.find((message) => message.id === card.requestMessageId)
      : thread.slice(0, index).findLast((message) => message.role === "user"));
  };
}
