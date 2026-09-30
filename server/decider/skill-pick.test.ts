import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { SKILL_PICK } from "./jobs.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import { SKILL_PICK_MAX_SKILLS, pickSkills, skillPickRequest } from "./skill-pick.ts";
import type { DeciderResult, YesNoAnswer } from "./types.ts";

type Ask = Decider["ask"];

function answering(ps: number[] | DeciderResult<never>) {
  const ask = vi.fn(async (_seam: string, _state: unknown, questions: Record<string, unknown>) => {
    if (!Array.isArray(ps)) return ps;
    const answers: Record<string, YesNoAnswer> = {};
    Object.keys(questions).forEach((id, index) => { answers[id] = { type: "yesno", p: ps[index]! }; });
    return { ok: true, provider: "jev", latencyMs: 300, answers };
  }) as unknown as Ask & ReturnType<typeof vi.fn>;
  return { ask };
}

const SKILLS = [
  { name: "file-expense", description: "File an expense report from a receipt." },
  { name: "code-review", description: "Review a pull request for bugs." },
  { name: "trip-planner", description: "Plan a trip:\n flights, hotels." },
];

describe("skill pick request", () => {
  it("sends only the contract's keys and questions, one line per skill", () => {
    const { state, questions } = skillPickRequest("Can you review PR #12?", SKILLS);
    expect(state).toEqual({
      message: "Can you review PR #12?",
      skills: ["file-expense: File an expense report from a receipt.", "code-review: Review a pull request for bugs.", "trip-planner: Plan a trip: flights, hotels."],
    });
    expect(Object.keys(questions)).toEqual(["s0", "s1", "s2"]);
    expect(questions.s1).toEqual({ type: "yesno", instructions: SKILL_PICK.instructionsFor(1) });
    expect(relayAccepts("skillPick", state, questions)).toBe(true);
  });

  it("a realistic worst case (60 skills with long descriptions, a long message) still fits Cloud Pro's relay", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `skill-${i}`, description: `Does thing ${i}. ${"説明 \"x\" ".repeat(200)}` }));
    const { state, questions } = skillPickRequest(`${"メッセージ ".repeat(1_000)}`, many);
    expect(state.skills).toHaveLength(SKILL_PICK.maxItems);
    expect(state.skills.every((skill, i) => skill.startsWith(`skill-${i}: `))).toBe(true);
    expect(state.message.length).toBeLessThanOrEqual(1_500);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("skillPick", state, questions)).toBe(true);
  });
});

describe("pickSkills", () => {
  it("keeps skills at 0.3 or above, likeliest first", async () => {
    const decider = answering([0.3, 0.95, 0.29]);
    await expect(pickSkills(decider, "review PR #12", SKILLS)).resolves.toEqual(["code-review", "file-expense"]);
    expect(decider.ask).toHaveBeenCalledWith("skillPick", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: SKILL_PICK.timeoutMs }));
  });

  it("picks at most eight", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, description: "d" }));
    const picked = await pickSkills(answering(many.map((_, i) => 0.5 + i / 100)), "m", many);
    expect(picked).toHaveLength(SKILL_PICK_MAX_SKILLS);
    expect(picked![0]).toBe("s11");
  });

  it("an answer that picks none is an empty list, not a failure", async () => {
    await expect(pickSkills(answering([0.1, 0.1, 0.1]), "hello", SKILLS)).resolves.toEqual([]);
  });

  it("any failure, a missing answer or nothing to ask is null, never a throw", async () => {
    await expect(pickSkills(answering({ ok: false, reason: "rate_limited" }), "m", SKILLS)).resolves.toBeNull();
    const partial = { ask: vi.fn(async () => ({ ok: true, provider: "jev", latencyMs: 1, answers: { s0: { type: "yesno", p: 0.9 } } })) } as unknown as { ask: Ask };
    await expect(pickSkills(partial, "m", SKILLS)).resolves.toBeNull();
    const throwing = { ask: vi.fn(async () => { throw new Error("boom"); }) } as unknown as { ask: Ask };
    await expect(pickSkills(throwing, "m", SKILLS)).resolves.toBeNull();
    const idle = answering([0.9]);
    await expect(pickSkills(idle, "", SKILLS)).resolves.toBeNull();
    await expect(pickSkills(idle, "m", [])).resolves.toBeNull();
    expect(idle.ask).not.toHaveBeenCalled();
  });
});
