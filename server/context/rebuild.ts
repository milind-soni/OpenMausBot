// Producing the model-facing rebuild for a target model, compacting first
// when it will not fit. Called at dispatch for every path that rebuilds:
// the inline replay for a fresh or rewound engine, a transcript-replay
// driver's history, a room member's turn. The display path is never touched
// — a compaction is one more record in the tree.
import type { Message, Store } from "../store.ts";
import { budgetFor, estimateTextTokens } from "./budget.ts";
import { KEEP_TAIL, buildCompactionPrompt, planFold } from "./compact.ts";
import { itemTokens, projectMessage } from "./project.ts";
import type { ModelContextItem } from "./types.ts";

export interface RebuildResult {
  /** the latest summary on the path, when one applies. */
  summary?: string;
  /** true when this call wrote a new compaction record. */
  compacted: boolean;
  /** the record it wrote, for broadcasting to open windows. */
  record?: Message;
}

export interface RebuildInput {
  store: Store;
  threadId: string;
  contextWindow: number | undefined;
  /** the summarizer; absent (or throwing) means bound-by-dropping instead. */
  generateText: ((prompt: string) => Promise<string>) | undefined;
  excludeMessageIds?: readonly string[];
  userName: string;
  createdByInstanceId: string;
}

/** Compact the thread if the rebuild will not fit, then report the summary
 * that now applies.
 *
 * Never fails the turn. With no summarizer, or one that errors or returns
 * nothing, the projector bounds the rebuild by dropping the oldest and this
 * writes no record — the next attempt may have a summarizer again. */
export async function rebuildForModel(input: RebuildInput): Promise<RebuildResult> {
  const { store, threadId, generateText } = input;
  const budget = budgetFor(input.contextWindow);
  const view = store.modelContext(threadId);
  const skip = new Set(input.excludeMessageIds ?? []);
  const byId = new Map(store.messagesFor(threadId).map((message) => [message.id, message]));

  const entries: Array<{ item: ModelContextItem; messageId: string }> = [];
  for (const message of view.messages) {
    if (skip.has(message.id)) continue;
    const item = projectMessage(message, byId, input.userName);
    if (item) entries.push({ item, messageId: message.id });
  }

  const summaryTokens = view.summary ? estimateTextTokens(view.summary) : 0;
  const fold = planFold(entries.map((e) => e.item), { budget, keepTail: KEEP_TAIL, summaryTokens });
  if (fold === 0) return { summary: view.summary, compacted: false };
  if (!generateText) return { summary: view.summary, compacted: false };

  const folded = entries.slice(0, fold);
  const firstKept = entries[fold];
  if (!firstKept) return { summary: view.summary, compacted: false };

  try {
    const summary = (
      await generateText(
        buildCompactionPrompt({
          fold: [
            ...(view.summary ? [{ kind: "summary" as const, messageId: "previous", text: view.summary }] : []),
            ...folded.map((e) => e.item),
          ],
          firstKeptId: firstKept.messageId,
          throughId: folded.at(-1)!.messageId,
          estimatedTokensBefore: entries.reduce((sum, e) => sum + itemTokens(e.item), 0) + summaryTokens,
        }),
      )
    ).trim();
    if (!summary) return { summary: view.summary, compacted: false };

    const record = store.appendCompaction(threadId, {
      schemaVersion: 1,
      summary,
      firstKeptId: firstKept.messageId,
      throughId: folded.at(-1)!.messageId,
      estimatedTokensBefore: entries.reduce((sum, e) => sum + itemTokens(e.item), 0) + summaryTokens,
      targetContextWindow: input.contextWindow ?? 0,
      createdByInstanceId: input.createdByInstanceId,
    });
    return { summary, compacted: true, record };
  } catch {
    // the summarizer is best-effort: never let it fail the turn
    return { summary: view.summary, compacted: false };
  }
}
