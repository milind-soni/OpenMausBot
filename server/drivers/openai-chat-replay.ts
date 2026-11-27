import { createHash } from "node:crypto";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

type TranscriptEntry = { role: "user" | "assistant"; text: string };

export interface DeliveredUserMessage {
  text: string;
  sent: string;
  volatile?: string;
  after: string;
  /** What its turn sent after it, through the final reply, and the replies the app stored: the turn is replayed as sent
   * to the same model while the transcript still carries those replies right after this message. Another model gets the
   * replies' text, never this model's reasoning. */
  turn?: { model: string; messages: OpenAIChatMessage[]; replies: string[]; bytes: number };
}

const MAX_DELIVERED_THREADS = 256;
/** Past this, the turns of the conversations used longest ago go back to replaying as their replies' text. */
const MAX_KEPT_TURN_BYTES = 64 * 1024 * 1024;
const EARLIER_SCREENSHOT = "[A screenshot from an earlier turn, not kept.]";

export function keepRecent<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_DELIVERED_THREADS) map.delete(map.keys().next().value!);
}

const sameReplies = (stored: readonly string[], kept: readonly string[]) =>
  stored.length === kept.length && stored.every((text, index) => text.trim() === kept[index]!.trim());

const withoutImages = (message: OpenAIChatMessage): OpenAIChatMessage => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")
  ? { ...message, content: message.content.map((part) => part.type === "image_url" ? { type: "text" as const, text: EARLIER_SCREENSHOT } : part) }
  : message;

const fingerprint = (text: string) => createHash("sha256").update(text).digest("base64url");

function replayDelivered(
  transcript: readonly TranscriptEntry[],
  records: readonly DeliveredUserMessage[],
  model: string,
): { content: Map<number, string>; turns: Map<number, { messages: OpenAIChatMessage[]; through: number }>; matched: DeliveredUserMessage[]; volatile: string | undefined } {
  const found: Array<{ index: number; record: DeliveredUserMessage }> = [];
  let next = records.length - 1;
  for (let index = transcript.length - 1; index >= 0 && next >= 0; index--) {
    const message = transcript[index]!;
    if (message.role !== "user" || !message.text) continue;
    const after = index > 0 ? fingerprint(transcript[index - 1]!.text) : undefined;
    for (let at = next; at >= 0; at--) {
      const record = records[at]!;
      if (record.text !== message.text && !record.text.endsWith("\n\n" + message.text)) continue;
      if (after !== undefined && record.after !== after) continue;
      found.unshift({ index, record });
      next = at - 1;
      break;
    }
  }
  const content = new Map<number, string>();
  const turns = new Map<number, { messages: OpenAIChatMessage[]; through: number }>();
  let volatile: string | undefined;
  for (const { index, record } of found) {
    content.set(index, record.sent);
    if (record.volatile !== undefined) volatile = record.volatile;
    // The app may store more after a turn's replies (a summary of the work it did); that follows the replayed turn.
    const stored = record.turn ? transcript.slice(index + 1, index + 1 + record.turn.replies.length) : [];
    if (record.turn?.model === model && stored.every((entry) => entry.role === "assistant") && sameReplies(stored.map((entry) => entry.text), record.turn.replies)) {
      turns.set(index, { messages: record.turn.messages, through: index + stored.length });
    }
  }
  return { content, turns, matched: found.map(({ record }) => record), volatile };
}

/** What each conversation sent its model, so the next request starts with all of it and a prompt cache can reuse it. */
export function createChatReplay() {
  const delivered = new Map<string, DeliveredUserMessage[]>();
  const lastSent = new Map<string, { tools: string; messages: string[] }>();
  return {
    replay(threadId: string, transcript: readonly TranscriptEntry[], model: string) {
      const found = replayDelivered(transcript, delivered.get(threadId) ?? [], model);
      const history: OpenAIChatMessage[] = [];
      for (let index = 0; index < transcript.length; index++) {
        history.push({ role: transcript[index]!.role, content: found.content.get(index) ?? transcript[index]!.text });
        const sent = found.turns.get(index);
        if (sent) { history.push(...sent.messages); index = sent.through; }
      }
      const record = (request: Pick<DeliveredUserMessage, "text" | "sent" | "volatile">): DeliveredUserMessage => {
        const kept = { ...request, after: transcript.length ? fingerprint(transcript.at(-1)!.text) : "" };
        keepRecent(delivered, threadId, [...found.matched, kept]);
        return kept;
      };
      return { history, volatile: found.volatile, record };
    },
    keepTurn(record: DeliveredUserMessage, model: string, sent: OpenAIChatMessage[], replies: string[]) {
      const messages = sent.map(withoutImages);
      record.turn = { model, messages, replies, bytes: Buffer.byteLength(JSON.stringify(messages)) };
      let total = 0;
      for (const records of delivered.values()) for (const kept of records) total += kept.turn?.bytes ?? 0;
      for (const records of delivered.values()) {
        if (total <= MAX_KEPT_TURN_BYTES) break;
        for (const kept of records) { total -= kept.turn?.bytes ?? 0; delete kept.turn; }
      }
    },
    /** How much of the conversation's previous request this one starts with: all a provider's prompt cache can reuse. */
    repeated(threadId: string, messages: readonly OpenAIChatMessage[], tools: readonly ChatToolDefinition[]) {
      const sent = { tools: fingerprint(JSON.stringify(tools)), messages: messages.map((message) => fingerprint(JSON.stringify(message))) };
      const before = lastSent.get(threadId);
      keepRecent(lastSent, threadId, sent);
      if (!before) return {};
      const changed = before.messages.findIndex((hash, index) => sent.messages[index] !== hash);
      return { repeats: { messages: changed < 0 ? before.messages.length : changed, of: before.messages.length, tools: before.tools === sent.tools } };
    },
  };
}
