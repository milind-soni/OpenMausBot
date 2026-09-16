// Phase 4 part 1: fact capture. Prompts by speaker, strict parsing with the
// filters, dedupe against the notebook, and a buffer that flushes on a quiet
// spell or a count — all pure.
import { describe, expect, it, vi } from "vitest";
import { CaptureBuffer, capturePrompt, dedupeCandidates, normaliseFact, parseCandidates } from "./capture.ts";

describe("the capture prompts", () => {
  it("asks about the person's words with the person's rules, and shows the notebook so it does not repeat it", () => {
    const prompt = capturePrompt({ speaker: "person", lines: ["My dog is called Biscuit.", "Ship on Fridays from now on."], notebook: "- 2026-09-10 · from chat \"x\" · we use pnpm" });
    expect(prompt).toContain("You are the CAPTURE");
    expect(prompt).toContain("Biscuit");
    expect(prompt).toContain("we use pnpm");
    expect(prompt).toMatch(/preferences, facts, standing instructions/);
    expect(prompt).not.toMatch(/never speculation/);
  });
  it("asks about the bot's words with the stricter rules", () => {
    const prompt = capturePrompt({ speaker: "bot", lines: ["I created greeting.txt and the tests pass."], notebook: "" });
    expect(prompt).toMatch(/never speculation/);
    expect(prompt).toMatch(/unverified claims/);
  });
});

describe("parsing candidates", () => {
  it("reads a JSON list, drops low confidence, caps at eight, clamps importance", () => {
    const raw = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ text: `fact ${i}`, kind: "fact", confidence: i === 0 ? 0.2 : 0.9, importance: i === 1 ? 9 : 3 })));
    const out = parseCandidates(raw);
    expect(out.length).toBe(8);
    expect(out.some((c) => c.text === "fact 0")).toBe(false);
    expect(out.find((c) => c.text === "fact 1")?.importance).toBe(5);
  });
  it("tolerates a fence and a wrapping object, and treats prose as nothing", () => {
    expect(parseCandidates('```json\n{"candidates": [{"text": "x is y", "kind": "fact", "confidence": 0.8}]}\n```').length).toBe(1);
    expect(parseCandidates("Nothing worth keeping.")).toEqual([]);
    expect(parseCandidates("NONE")).toEqual([]);
  });
  it("keeps only known kinds and non-empty text", () => {
    expect(parseCandidates(JSON.stringify([{ text: "", kind: "fact", confidence: 1 }, { text: "ok", kind: "rumour", confidence: 1 }, { text: "ok", kind: "decision", confidence: 1 }])).map((c) => c.kind)).toEqual(["decision"]);
  });
});

describe("dedupe", () => {
  it("normalises punctuation, case and spacing", () => {
    expect(normaliseFact("  My dog's  name is BISCUIT!  ")).toBe("my dogs name is biscuit");
  });
  it("drops candidates already in the notebook or repeated in the batch", () => {
    const notebook = "- 2026-09-10 · from chat \"x\" · importance 3 · My dog is called Biscuit\n- hand-written line";
    const out = dedupeCandidates([
      { text: "my dog is called biscuit.", kind: "fact", confidence: 0.9, importance: 3 },
      { text: "We ship on Fridays", kind: "instruction", confidence: 0.9, importance: 4 },
      { text: "we ship on fridays!", kind: "instruction", confidence: 0.8, importance: 4 },
    ], notebook);
    expect(out.map((c) => c.text)).toEqual(["We ship on Fridays"]);
  });
});

describe("the buffer", () => {
  it("flushes after a quiet spell, and at once at ten turns", () => {
    vi.useFakeTimers();
    const flushed: Array<{ threadId: string; turns: number }> = [];
    const buffer = new CaptureBuffer({ quietMs: 1_000, maxTurns: 10, onFlush: (batch) => flushed.push({ threadId: batch.threadId, turns: batch.turns.length }) });
    buffer.add("b1", "t1", { person: "hello", bot: "hi" });
    vi.advanceTimersByTime(900);
    buffer.add("b1", "t1", { person: "my dog is Biscuit", bot: "noted" });
    vi.advanceTimersByTime(900);
    expect(flushed).toEqual([]); // still talking
    vi.advanceTimersByTime(200);
    expect(flushed).toEqual([{ threadId: "t1", turns: 2 }]);
    for (let i = 0; i < 10; i += 1) buffer.add("b1", "t2", { person: `turn ${i}`, bot: "ok" });
    expect(flushed.at(-1)).toEqual({ threadId: "t2", turns: 10 });
    vi.useRealTimers();
  });
});
