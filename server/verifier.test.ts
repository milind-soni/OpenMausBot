// Phase 3 part 3: the tool-less verifier. Strict JSON in, a verdict out;
// anything unreadable is "not complete", never a guess.
import { describe, expect, it } from "vitest";
import { parseVerdict, verdictLine, verifierPrompt } from "./verifier.ts";

describe("the verifier's prompt", () => {
  it("carries the acceptance text, the result, the gates and the bot's last words, and asks for JSON only", () => {
    const prompt = verifierPrompt({
      title: "Add a greeting",
      body: "Create greeting.txt containing hello",
      result: "[digest] · tools: Write ×1 · files: added greeting.txt",
      gates: { results: [{ name: "test", status: "fail", seconds: 1, tail: "1 failed" }], scope: "Gates: test fail (1 s)." },
      botSaid: ["Created greeting.txt containing hello."],
    });
    expect(prompt).toContain("VERIFIER");
    expect(prompt).toContain("Create greeting.txt containing hello");
    expect(prompt).toContain("Gates: test fail (1 s).");
    expect(prompt).toContain("1 failed");
    expect(prompt).toContain("Created greeting.txt containing hello.");
    expect(prompt).toMatch(/"is_complete"/);
    expect(prompt).toMatch(/never "ask the user"/);
  });
});

describe("parsing a verdict", () => {
  it("reads strict JSON, with or without a code fence", () => {
    const v = parseVerdict('```json\n{"is_complete": true, "confidence": 0.9, "evidence_for": ["file exists"], "evidence_against": [], "next_action": ""}\n```');
    expect(v).toEqual({ isComplete: true, confidence: 0.9, evidenceFor: ["file exists"], evidenceAgainst: [], nextAction: "", readable: true });
  });
  it("treats anything unreadable as not complete, and says why", () => {
    const v = parseVerdict("I think it is done.");
    expect(v.isComplete).toBe(false);
    expect(v.readable).toBe(false);
    expect(v.evidenceAgainst[0]).toMatch(/could not be read/);
  });
  it("clamps confidence and tolerates missing lists", () => {
    const v = parseVerdict('{"is_complete": false, "confidence": 7, "next_action": "run the tests"}');
    expect(v.confidence).toBe(1);
    expect(v.evidenceFor).toEqual([]);
    expect(v.nextAction).toBe("run the tests");
  });
  it("refuses a verdict that claims completion while a gate failed", () => {
    const v = parseVerdict('{"is_complete": true, "confidence": 0.8, "evidence_for": [], "evidence_against": [], "next_action": ""}', { gatesFailed: true });
    expect(v.isComplete).toBe(false);
    expect(v.evidenceAgainst.join(" ")).toMatch(/gate/);
  });
});

describe("the verdict line", () => {
  it("says complete or not, with confidence and the next step", () => {
    expect(verdictLine({ isComplete: true, confidence: 0.92, evidenceFor: ["a"], evidenceAgainst: [], nextAction: "", readable: true })).toBe("Verified: complete (confidence 0.92).");
    expect(verdictLine({ isComplete: false, confidence: 0.4, evidenceFor: [], evidenceAgainst: ["test failed"], nextAction: "fix the test", readable: true })).toBe("Verified: not complete (confidence 0.40) — test failed. Next: fix the test");
  });
});
