import type { OptionCardData } from "../../shared/wire.ts";
import type { Store } from "../store.ts";

function decision(card: OptionCardData | undefined): { kind: string; request: { result?: unknown; resumed?: boolean } } | null {
  if (card?.teamSetupRequest) return { kind: "team setup decision", request: card.teamSetupRequest };
  if (card?.mcpRequest) return { kind: "MCP server decision", request: card.mcpRequest };
  return null;
}

/** Stop ends the work that asked, so nothing can answer its decision card any more. Null when the card is no such card
 * or is already settled. */
export function closedByStop(card: OptionCardData | undefined): OptionCardData | null {
  if (!card || !decision(card) || card.answered || card.dismissed || card.expired) return null;
  return { ...card, answered: "unavailable", dismissed: true };
}

/** The cards since `since` that a parked turn waits on, and what each waits for. In a room (`memberId`) only this
 * member's cards: one member's park never swallows another's. */
export function resumableCards(store: Pick<Store, "activePath">, threadId: string, since: number, memberId?: string): Array<{ id: string; waits: string }> {
  const open: Array<{ id: string; waits: string }> = [];
  const path = store.activePath(threadId).filter((message) => message.at >= since && (memberId === undefined || message.from?.botId === memberId));
  for (const message of path) {
    const card = message.card;
    const waited = decision(card);
    if (card && waited && !waited.request.resumed && (waited.request.result || (!card.answered && !card.dismissed && !card.expired))) {
      open.push({ id: message.id, waits: `${waited.kind}: ${card.title}` });
      continue;
    }
    const connector = message.connector;
    // An MCP Sign in card set aside before the turn parked is still answered ("didn't sign in"); an app's card is not.
    if (connector && !connector.resumed && !connector.superseded && !connector.stopped && (!connector.dismissed || connector.source === "mcp")) {
      open.push({ id: message.id, waits: `connect ${connector.label}` });
      continue;
    }
    const secret = message.secret;
    if (secret && !secret.resumed && !secret.superseded && !secret.stopped) {
      open.push({ id: message.id, waits: `provide ${secret.label}` });
      continue;
    }
    const signIn = message.signIn;
    if (signIn && !signIn.resumed && !signIn.superseded && !signIn.answeredInChat && !signIn.stopped) {
      open.push({ id: message.id, waits: `sign in to ${signIn.site}` });
    }
  }
  return open;
}

/** Whether any of these parked-on cards, on any branch, can still be answered or still has an answer for the turn to hear. */
export function anyCardLive(store: Pick<Store, "messagesFor">, threadId: string, ids: readonly string[]): boolean {
  const open = new Set(resumableCards({ activePath: (id) => store.messagesFor(id) as ReturnType<Store["activePath"]> }, threadId, 0).map((card) => card.id));
  return ids.some((id) => open.has(id));
}
