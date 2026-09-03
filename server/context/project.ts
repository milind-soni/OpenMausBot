// Turning the active branch into what a model is shown.
//
// Two rules shape everything here. Projection removes COMPLETE semantic
// units, never half of one — an assistant action is never separated from the
// observation of what it did. And it walks backwards from the newest turn,
// because the turn being answered matters more than the one that opened the
// conversation.
import type { Message } from "../store.ts";
import { replyExcerpt, replySpeaker } from "../replies.ts";
import { FRAMING_TOKENS_PER_ITEM, estimateContextTokens } from "./budget.ts";
import type { ContextBudget, ModelContextItem } from "./types.ts";

/** Kinds that carry no model-facing content.
 *
 * These are UI receipts, not conversation: an options card is a control, a
 * screen frame is image bytes the projector must never inline, a connector
 * or secret card is a credential prompt, and routine/goal rows are status
 * chrome whose real work lives in its own task. */
const UI_ONLY_KINDS = new Set<Message["kind"]>([
  "options",
  "screen",
  "connector",
  "secret",
  "routine.run",
  "goal.run",
]);

export interface ProjectInput {
  /** the visible conversation, root → leaf. Abandoned forks are already
   * excluded: the caller passes Store.activePath(). */
  activeMessages: readonly Message[];
  /** every message in the thread, for resolving a reply that quotes across
   * a fork. The projection itself never leaves the active branch. */
  allMessages: readonly Message[];
  /** ids withheld from history: the current user message, and anything the
   * caller is sending by another route. */
  excludeMessageIds: readonly string[];
  userName: string;
  budget: ContextBudget;
}

export interface Projection {
  messages: ModelContextItem[];
  /** semantic units available before budgeting. */
  sourceItems: number;
  estimatedTokens: number;
  /** at least one unit was dropped or cut to fit. */
  clipped: boolean;
  /** a durable compaction summary is standing in for older history. */
  compacted: boolean;
}

/** One message as the model would see it, or null if it carries nothing. */
export function projectMessage(
  message: Message,
  messagesById: ReadonlyMap<string, Message>,
  userName: string,
): ModelContextItem | null {
  if (UI_ONLY_KINDS.has(message.kind)) return null;

  if (message.kind === "compaction") {
    const summary = message.compaction?.summary?.trim();
    return summary ? { kind: "summary", messageId: message.id, text: summary } : null;
  }

  if (message.kind === "activity") {
    const tool = message.tool;
    if (!tool) return null;
    // A failed TURN is rendered as an error chip rather than a tool run.
    // It tells the model nothing about the work and reads like an
    // instruction, so it stays out.
    if (tool.name.startsWith("error:")) return null;
    return {
      kind: "tool-observation",
      messageId: message.id,
      observation: tool.context ?? { name: tool.name, ...(tool.ok === undefined ? {} : { ok: tool.ok }) },
    };
  }

  const text = message.text?.trim();
  if (!text) return null;
  const withQuote = quoted(message, messagesById, userName, text);

  if (message.role === "user") return { kind: "user-text", messageId: message.id, text: withQuote };
  return {
    kind: "assistant-text",
    messageId: message.id,
    text: withQuote,
    // room threads are multi-speaker: several bots share one branch, so an
    // assistant turn keeps its attribution instead of collapsing into an
    // undifferentiated "assistant"
    ...(message.from?.name ? { speaker: message.from.name } : {}),
  };
}

/** Prefix a flat reply with the excerpt it points at, exactly as the current
 * transcript path does. The quote is conversation data, never instruction. */
function quoted(
  message: Message,
  messagesById: ReadonlyMap<string, Message>,
  userName: string,
  text: string,
): string {
  if (!message.replyToId) return text;
  const target = messagesById.get(message.replyToId);
  if (!target?.text) return text;
  return `[replying to ${replySpeaker(target, userName)}: “${replyExcerpt(target.text, 220)}”]\n${text}`;
}

/** What one item costs, including the framing a driver wraps it in. */
export function itemTokens(item: ModelContextItem): number {
  const text = item.kind === "tool-observation"
    ? [
        item.observation.name,
        item.observation.inputSummary,
        item.observation.outputSummary,
        ...(item.observation.filesRead ?? []),
        ...(item.observation.filesModified ?? []),
      ]
        .filter(Boolean)
        .join(" ")
    : item.text;
  return estimateContextTokens(text) + FRAMING_TOKENS_PER_ITEM;
}

/** Project the active branch down to what fits.
 *
 * Newest-first so the turn being answered survives, then reversed back into
 * conversation order. A durable compaction divider is a hard boundary:
 * nothing above it is replayed verbatim, because its summary already stands
 * in for that history. */
export function projectActiveBranch(input: ProjectInput): Projection {
  const skip = new Set(input.excludeMessageIds);
  const messagesById = new Map(input.allMessages.map((message) => [message.id, message]));

  const projected: ModelContextItem[] = [];
  for (const message of input.activeMessages) {
    if (skip.has(message.id)) continue;
    const item = projectMessage(message, messagesById, input.userName);
    if (item) projected.push(item);
  }

  // Everything before the newest divider is already represented by its
  // summary; replaying it too would say the same thing twice.
  const lastSummary = projected.findLastIndex((item) => item.kind === "summary");
  const compacted = lastSummary !== -1;
  const eligible = compacted ? projected.slice(lastSummary) : projected;

  const kept: ModelContextItem[] = [];
  let used = 0;
  let clipped = compacted && lastSummary > 0;
  for (let i = eligible.length - 1; i >= 0; i -= 1) {
    const item = eligible[i];
    const cost = itemTokens(item);
    if (used + cost > input.budget.historyTokens) {
      // A summary is never dropped for size: without it the model loses the
      // whole folded history rather than one turn of it.
      if (item.kind !== "summary") {
        clipped = true;
        break;
      }
    }
    kept.push(item);
    used += cost;
  }
  kept.reverse();

  return {
    messages: kept,
    sourceItems: projected.length,
    estimatedTokens: used,
    clipped: clipped || kept.length < eligible.length,
    compacted,
  };
}
