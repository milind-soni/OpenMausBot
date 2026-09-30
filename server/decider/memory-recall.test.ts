import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { MEMORY_RECALL } from "./jobs.ts";
import { judgeRecallCandidates, memoryRecallRequest, reorderSearchResults } from "./memory-recall.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import type { DeciderResult, YesNoAnswer } from "./types.ts";

type Ask = Decider["ask"];

/** A decider whose ask answers each candidate with the given probability. */
function answering(ps: number[] | DeciderResult<never>) {
  const ask = vi.fn(async (_seam: string, _state: unknown, questions: Record<string, unknown>) => {
    if (!Array.isArray(ps)) return ps;
    const answers: Record<string, YesNoAnswer> = {};
    Object.keys(questions).forEach((id, index) => { answers[id] = { type: "yesno", p: ps[index]! }; });
    return { ok: true, provider: "jev", latencyMs: 300, answers };
  }) as unknown as Ask & ReturnType<typeof vi.fn>;
  return { ask };
}

describe("memory recall request", () => {
  it("sends only the contract's keys and questions, each candidate on one clipped line", () => {
    const { state, questions } = memoryRecallRequest("  when is the\n dentist? ", ["memory/health.md: Dr Rao,\n\nMondays", "x".repeat(2_000)]);
    expect(state).toEqual({ query: "when is the dentist?", candidates: ["memory/health.md: Dr Rao, Mondays", `${"x".repeat(599)}…`] });
    expect(questions).toEqual({
      c0: { type: "yesno", instructions: MEMORY_RECALL.instructionsFor(0) },
      c1: { type: "yesno", instructions: MEMORY_RECALL.instructionsFor(1) },
    });
    expect(relayAccepts("memoryRecall", state, questions)).toBe(true);
  });

  it("a realistic worst case (24 long passages, a long question) still fits Cloud Pro's relay", () => {
    const passages = Array.from({ length: 24 }, (_, i) => `memory/topic-${i}.md: ${"日本語のメモ \"quoted\" ".repeat(80)}`);
    const { state, questions } = memoryRecallRequest(`${"長い質問 ".repeat(400)}`, passages);
    expect(state.candidates).toHaveLength(24);
    expect(state.candidates.every((candidate) => candidate.startsWith(`memory/topic-`))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("memoryRecall", state, questions)).toBe(true);
    const ascii = memoryRecallRequest("q".repeat(5_000), Array.from({ length: 24 }, () => "p".repeat(5_000)));
    expect(relayAccepts("memoryRecall", ascii.state, ascii.questions)).toBe(true);
  });
});

describe("judgeRecallCandidates", () => {
  it("returns one probability per candidate, asked once with the contract's budget", async () => {
    const decider = answering([0.9, 0.05, 0.4]);
    await expect(judgeRecallCandidates(decider, "invoice?", ["a", "b", "c"])).resolves.toEqual([0.9, 0.05, 0.4]);
    expect(decider.ask).toHaveBeenCalledTimes(1);
    expect(decider.ask).toHaveBeenCalledWith("memoryRecall", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: MEMORY_RECALL.timeoutMs }));
  });

  it("any failure, a missing answer or nothing to ask is null, never a throw", async () => {
    await expect(judgeRecallCandidates(answering({ ok: false, reason: "timeout" }), "q", ["a"])).resolves.toBeNull();
    const partial = { ask: vi.fn(async () => ({ ok: true, provider: "jev", latencyMs: 1, answers: { c0: { type: "yesno", p: 0.5 } } })) } as unknown as { ask: Ask };
    await expect(judgeRecallCandidates(partial, "q", ["a", "b"])).resolves.toBeNull();
    const throwing = { ask: vi.fn(async () => { throw new Error("boom"); }) } as unknown as { ask: Ask };
    await expect(judgeRecallCandidates(throwing, "q", ["a"])).resolves.toBeNull();
    const idle = answering([0.5]);
    await expect(judgeRecallCandidates(idle, "q", [])).resolves.toBeNull();
    await expect(judgeRecallCandidates(idle, "  ", ["a"])).resolves.toBeNull();
    await expect(judgeRecallCandidates(idle, "q", Array.from({ length: 25 }, () => "a"))).resolves.toBeNull();
    expect(idle.ask).not.toHaveBeenCalled();
  });
});

describe("reorderSearchResults (session_search)", () => {
  const memory = (n: number) => ({ items: Array.from({ length: n }, (_, i) => `m${i}`), text: (item: string) => item });
  const chats = (n: number) => ({ items: Array.from({ length: n }, (_, i) => `t${i}`), text: (item: string) => item });

  it("reorders both lists by meaning and drops nothing", async () => {
    const decider = answering([0.1, 0.8, 0.01, 0.9, 0.3]);
    await expect(reorderSearchResults(decider, "q", memory(2), chats(3))).resolves.toEqual({ memory: ["m1", "m0"], conversations: ["t1", "t2", "t0"] });
  });

  it("asks about at most 24, shared between the lists; the rest keep their place after", async () => {
    const decider = answering(Array.from({ length: 24 }, (_, i) => i / 100));
    const result = await reorderSearchResults(decider, "q", memory(25), chats(25));
    const [, state] = decider.ask.mock.calls[0]!;
    expect((state as { candidates: string[] }).candidates).toEqual([...memory(12).items, ...chats(12).items]);
    expect(result.memory).toHaveLength(25);
    expect(result.memory.slice(0, 12)).toEqual(memory(12).items.reverse());
    expect(result.memory.slice(12)).toEqual(memory(25).items.slice(12));
    expect(result.conversations.slice(12)).toEqual(chats(25).items.slice(12));
    // a short list leaves its slots to the other
    const lopsided = answering(Array.from({ length: 24 }, () => 0.5));
    await reorderSearchResults(lopsided, "q", memory(2), chats(25));
    expect((lopsided.ask.mock.calls[0]![1] as { candidates: string[] }).candidates).toHaveLength(24);
  });

  it("with no answer keeps the keyword order", async () => {
    await expect(reorderSearchResults(answering({ ok: false, reason: "overloaded" }), "q", memory(2), chats(2)))
      .resolves.toEqual({ memory: ["m0", "m1"], conversations: ["t0", "t1"] });
  });
});
