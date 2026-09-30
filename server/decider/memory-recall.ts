// Memory recall: keyword search (SQLite FTS5) finds the candidate passages,
// and Jev says, for each one, whether it helps answer the message. One
// yes/no per candidate (MEMORY_RECALL in jobs.ts), so every passage gets its
// own probability.
//
// Two callers act on the answer differently:
// - automatic recall (server/recall.ts) puts the likeliest passages first
//   and leaves out any below 0.15: an unrelated note in front of a message
//   is noise the bot has to read past;
// - session_search, which the bot called itself, is only reordered: it
//   asked, so it sees everything the search found.
//
// Any failure at all, or an answer that does not cover every candidate,
// keeps the keyword order. Nothing here throws.
import type { Decider } from "./index.ts";
import { MEMORY_RECALL, perItemProbabilities, perItemQuestions, rankByProbability } from "./jobs.ts";
import { clipList, flatClip } from "./list-state.ts";

/** Automatic recall leaves out a candidate Jev puts below this. Low on
 * purpose: only a passage it is fairly sure is unrelated goes. */
export const MEMORY_RECALL_MIN_PROBABILITY = 0.15;
export const MEMORY_RECALL_QUERY_CHARS = 1_000;
export const MEMORY_RECALL_CANDIDATE_CHARS = 600;

export function memoryRecallRequest(query: string, candidates: readonly string[]) {
  const clippedQuery = flatClip(query, MEMORY_RECALL_QUERY_CHARS);
  const list = clipList(candidates.slice(0, MEMORY_RECALL.maxItems), MEMORY_RECALL_CANDIDATE_CHARS, { query: clippedQuery });
  return { state: { query: clippedQuery, candidates: list }, questions: perItemQuestions(MEMORY_RECALL, list.length) };
}

/** Jev's probability that each candidate helps, in candidate order, or null
 * when there is nothing to ask or no usable answer: keep the keyword order.
 * At most MEMORY_RECALL.maxItems candidates; the caller sends no more. */
export async function judgeRecallCandidates(
  decider: Pick<Decider, "ask">,
  query: string,
  candidates: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<number[] | null> {
  try {
    if (!query.trim() || !candidates.length || candidates.length > MEMORY_RECALL.maxItems) return null;
    const { state, questions } = memoryRecallRequest(query, candidates);
    const result = await decider.ask("memoryRecall", state, questions, { timeoutMs: MEMORY_RECALL.timeoutMs, signal: options.signal });
    if (!result.ok) return null;
    return perItemProbabilities(MEMORY_RECALL, candidates.length, result.answers);
  } catch {
    return null;
  }
}

/** session_search's two result lists, reordered by one question to Jev and
 * never shortened. Each list gets half of the candidate slots, or more when
 * the other is short; the entries past what was asked keep their place
 * after the judged ones, as the search had them lower anyway. */
export async function reorderSearchResults<M, C>(
  decider: Pick<Decider, "ask">,
  query: string,
  memory: { items: readonly M[]; text(item: M): string },
  conversations: { items: readonly C[]; text(item: C): string },
): Promise<{ memory: M[]; conversations: C[] }> {
  const max = MEMORY_RECALL.maxItems;
  const memoryAsked = Math.min(memory.items.length, Math.max(max / 2, max - conversations.items.length));
  const conversationsAsked = Math.min(conversations.items.length, max - memoryAsked);
  const unchanged = { memory: [...memory.items], conversations: [...conversations.items] };
  if (!memoryAsked && !conversationsAsked) return unchanged;
  try {
    const candidates = [
      ...memory.items.slice(0, memoryAsked).map((item) => memory.text(item)),
      ...conversations.items.slice(0, conversationsAsked).map((item) => conversations.text(item)),
    ];
    const probabilities = await judgeRecallCandidates(decider, query, candidates);
    if (!probabilities) return unchanged;
    return {
      memory: [...rankByProbability(memory.items.slice(0, memoryAsked), probabilities.slice(0, memoryAsked)), ...memory.items.slice(memoryAsked)],
      conversations: [
        ...rankByProbability(conversations.items.slice(0, conversationsAsked), probabilities.slice(memoryAsked)),
        ...conversations.items.slice(conversationsAsked),
      ],
    };
  } catch {
    return unchanged;
  }
}
