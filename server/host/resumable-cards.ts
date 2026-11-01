import type { Store } from "../store.ts";

/** The cards since `since` that a parked turn waits on, and what each waits for. In a room (`memberId`) only this
 * member's cards: one member's park never swallows another's. */
export function resumableCards(store: Pick<Store, "activePath">, threadId: string, since: number, memberId?: string): Array<{ id: string; waits: string }> {
  const open: Array<{ id: string; waits: string }> = [];
  const path = store.activePath(threadId).filter((message) => message.at >= since && (memberId === undefined || message.from?.botId === memberId));
  for (const message of path) {
    const card = message.card;
    if (card?.teamSetupRequest && !card.teamSetupRequest.resumed && (card.teamSetupRequest.result || (!card.answered && !card.dismissed && !card.expired))) {
      open.push({ id: message.id, waits: `team setup decision: ${card.title}` });
      continue;
    }
    const connector = message.connector;
    if (connector && !connector.dismissed && !connector.resumed) {
      open.push({ id: message.id, waits: `connect ${connector.label}` });
      continue;
    }
    const secret = message.secret;
    if (secret && !secret.resumed && !secret.superseded) {
      open.push({ id: message.id, waits: `provide ${secret.label}` });
      continue;
    }
    const signIn = message.signIn;
    if (signIn && !signIn.resumed && !signIn.superseded && !signIn.answeredInChat) {
      open.push({ id: message.id, waits: `sign in to ${signIn.site}` });
    }
  }
  return open;
}
