// Gives every piece of a bot's reply text the id of the message it belongs to, so a client keys streamed words by
// message and never has to guess where one message ends and the next begins.
import { newId, type RuntimeEvent } from "../contracts.ts";

type Active = { turnId: string | undefined; itemId: string };

const MINTED = "text-";

/** The engine's own id for a message, for an event that should carry it. */
export function messageItem(item: { id?: unknown }): { itemId?: string } {
  return typeof item.id === "string" && item.id ? { itemId: item.id } : {};
}

const isTurnBoundary = (event: RuntimeEvent) =>
  event.type === "turn.started" || event.type === "turn.completed" || event.type === "cap.exhausted" ||
  event.type === "session.exited" || (event.type === "runtime.error" && event.terminal === true);

/**
 * One instance per event bus. An engine's own message id is kept, scoped to its turn (engines reuse ids such as "m1"
 * from turn to turn); an engine that names no message gets one minted at its first visible word, closed when a tool
 * starts, the message completes, or the turn ends.
 */
export class TextItems {
  private readonly active = new Map<string, Active>();

  /** The event as it should be published, or null for a delta that carries nothing yet (whitespace before any word). */
  stamp(event: RuntimeEvent): RuntimeEvent | null {
    const { threadId } = event;
    if (isTurnBoundary(event)) {
      this.active.delete(threadId);
      return event;
    }
    if (event.type === "item.started" && event.itemType === "tool") {
      this.active.delete(threadId);
      return event;
    }
    if (event.type === "content.delta" && event.streamKind === "assistant_text") {
      const itemId = this.open(event, event.delta.trim() === "");
      return itemId ? { ...event, itemId } : null;
    }
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      const itemId = this.open(event, false)!;
      this.active.delete(threadId);
      return { ...event, itemId };
    }
    return event;
  }

  forget(threadId: string): void {
    this.active.delete(threadId);
  }

  private open(event: RuntimeEvent, whitespace: boolean): string | undefined {
    const { threadId, turnId } = event;
    const current = this.active.get(threadId);
    const sameTurn = current && current.turnId === turnId;
    if (event.itemId) {
      const scope = `${turnId ?? "turn"}:`;
      const itemId = event.itemId.startsWith(scope) || event.itemId.startsWith(MINTED) ? event.itemId : `${scope}${event.itemId}`;
      this.active.set(threadId, { turnId, itemId });
      return itemId;
    }
    if (current && sameTurn) return current.itemId;
    // Whitespace before a message's first word opens nothing: a tool may follow, and then there was no message.
    if (whitespace) return undefined;
    const itemId = `${MINTED}${newId()}`;
    this.active.set(threadId, { turnId, itemId });
    return itemId;
  }
}
