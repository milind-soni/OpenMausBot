import type { RuntimeEvent } from "../contracts.ts";
import { TextItems } from "./text-items.ts";

/** A turn's reply messages as the bus publishes them: each message's id, the words streamed under it, and its
 * completed text; throws when a delta or a completion carries no id. */
export function publishedMessages(events: readonly RuntimeEvent[]): Array<{ itemId: string; streamed: string; completed?: string }> {
  const items = new TextItems();
  const messages = new Map<string, { itemId: string; streamed: string; completed?: string }>();
  for (const raw of events) {
    const event = items.stamp(raw);
    if (!event) continue;
    const text = event.type === "content.delta" && event.streamKind === "assistant_text" ? event.delta
      : event.type === "item.completed" && event.itemType === "assistant_text" ? event.text : undefined;
    if (text === undefined) continue;
    if (!event.itemId) throw new Error(`${event.type} carries no item id`);
    const message = messages.get(event.itemId) ?? { itemId: event.itemId, streamed: "" };
    if (event.type === "content.delta") message.streamed += text;
    else message.completed = text;
    messages.set(event.itemId, message);
  }
  return [...messages.values()];
}
