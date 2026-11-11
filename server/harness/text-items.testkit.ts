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

/** What is wrong with a turn's published reply text for a scripted case: words without an id, a message's words
 * differing from its completion, a message's tokens doubled or lost, two messages under one id, or thinking shown as
 * reply text. Empty when the turn is right. `stopped`: the turn ended early, so later tokens may be missing. */
export function replyProblems(events: readonly RuntimeEvent[], tokens: readonly string[], options: { stopped?: boolean } = {}): string[] {
  const problems: string[] = [];
  let messages: ReturnType<typeof publishedMessages>;
  try {
    messages = publishedMessages(events);
  } catch (error) {
    return [String(error)];
  }
  const ids = messages.map((message) => message.itemId);
  if (new Set(ids).size !== ids.length) problems.push("two messages share an id");
  for (const message of messages) {
    if (message.completed !== undefined && message.streamed && message.streamed.trim() !== message.completed.trim()) {
      problems.push(`${message.itemId}: streamed ${JSON.stringify(message.streamed.slice(0, 60))} but completed ${JSON.stringify(message.completed.slice(0, 60))}`);
    }
    if (/THINK\d/.test(message.streamed + (message.completed ?? ""))) problems.push(`${message.itemId}: thinking shown as reply text`);
  }
  const shown = messages.map((message) => message.completed ?? message.streamed).join("\n");
  const occurrences = (text: string, token: string) => (text.match(new RegExp(`${token}(?!z)`, "g")) ?? []).length;
  for (const token of tokens) {
    const count = occurrences(shown, token);
    if (count > 1) problems.push(`${token} said ${count} times`);
    const owners = messages.filter((message) => occurrences(message.completed ?? message.streamed, token) > 0).length;
    if (count === 0 && !options.stopped) problems.push(`${token} lost`);
    if (owners > 1) problems.push(`${token} in ${owners} messages`);
  }
  return problems;
}
