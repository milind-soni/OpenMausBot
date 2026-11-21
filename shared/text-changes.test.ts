import { describe, expect, it } from "vitest";

import { compareTexts, formatTextChanges, splitSentences, TEXT_CHANGES_MAX_CHARS, TEXT_CHANGES_MAX_SENTENCES, wordParts, type TextChanges } from "./text-changes";

function changes(before: string, after: string): TextChanges {
  const result = compareTexts(before, after);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

const CHAPTER = [
  "Mara walked into the bar at noon. The rain had not stopped for three days.",
  "\"You're late,\" said Tom. He did not look up from the glass he was drying.",
  "She sat down without a word. Tom poured her a drink, and she drank it slowly.",
  "Outside, a car alarm went off.",
].join("\n\n");

describe("compareTexts on prose", () => {
  it("reports nothing for the same text, whatever its line endings, byte order mark or Unicode composition", () => {
    const crlf = `﻿${CHAPTER.replace(/\n/g, "\r\n")}`;
    expect(changes(CHAPTER, crlf).counts).toEqual({ changed: 0, added: 0, removed: 0, moved: 0, unchanged: 7 });
    const composed = "Zoë said café.", decomposed = "Zoë said café.";
    expect(changes(composed, decomposed).counts.changed).toBe(0);
  });

  it("finds a changed event and an added detail, word by word", () => {
    const edited = CHAPTER
      .replace("walked into the bar at noon", "ran into the bar at midnight")
      .replace("drank it slowly.", "drank it slowly. A stranger watched from the corner.");
    const result = changes(CHAPTER, edited);
    expect(result.counts).toEqual({ changed: 1, added: 1, removed: 0, moved: 0, unchanged: 6 });
    const changed = result.segments.find((segment) => segment.kind === "changed");
    expect(changed).toMatchObject({ para: 1, beforePara: 1, minor: false });
    expect(changed?.kind === "changed" && changed.parts.filter((part) => part.op !== "same")).toEqual([
      { op: "del", text: "walked" }, { op: "add", text: "ran" }, { op: "del", text: "noon" }, { op: "add", text: "midnight" },
    ]);
    expect(result.segments.find((segment) => segment.kind === "added")).toMatchObject({ para: 3, text: "A stranger watched from the corner." });
  });

  it("counts a removed sentence once and keeps where it was", () => {
    const result = changes(CHAPTER, CHAPTER.replace(" He did not look up from the glass he was drying.", ""));
    expect(result.counts).toMatchObject({ removed: 1, changed: 0, added: 0 });
    expect(result.segments.find((segment) => segment.kind === "removed")).toMatchObject({ beforePara: 2, text: "He did not look up from the glass he was drying." });
  });

  it("calls a paragraph moved elsewhere moved, not removed and added", () => {
    const paragraphs = CHAPTER.split("\n\n");
    const moved = [paragraphs[0], paragraphs[2], paragraphs[3], paragraphs[1]].join("\n\n");
    const result = changes(CHAPTER, moved);
    expect(result.counts).toMatchObject({ added: 0, removed: 0, changed: 0, moved: 2 });
    expect(result.segments.filter((segment) => segment.kind === "moved").map((segment) => segment.kind === "moved" && [segment.beforePara, segment.para])).toEqual([[2, 4], [2, 4]]);
  });

  it("marks a change of punctuation or case only as minor, also when the sentence moved", () => {
    const result = changes("She sat down without a word. Then she left.", "She sat down without a word! Then she left.");
    expect(result.counts).toMatchObject({ changed: 1, unchanged: 1 });
    expect(result.segments[0]).toMatchObject({ kind: "changed", minor: true });
    const moved = changes("One here.\n\nShe sat down without a word.\n\nTwo here.", "One here.\n\nTwo here.\n\nshe sat down without a word!");
    expect(moved.counts).toMatchObject({ changed: 1, removed: 0, added: 0, moved: 0 });
    expect(moved.segments.find((segment) => segment.kind === "changed")).toMatchObject({ minor: true, beforePara: 2, para: 3 });
  });

  it("re-wrapping a paragraph changes nothing, while dialogue on its own line stays its own sentence", () => {
    const wrapped = "Mara walked into the bar at noon. The rain had\nnot stopped for three days.";
    expect(changes("Mara walked into the bar at noon. The rain had not stopped for three days.", wrapped).counts.changed).toBe(0);
    expect(splitSentences("\"Late again,\" he said\n\"Sorry\"").map((unit) => unit.key)).toEqual(["\"Late again,\" he said", "\"Sorry\""]);
  });

  it("handles scripts without spaces and characters outside the basic plane", () => {
    const result = changes("我走进了酒吧。外面在下雨。🙂 Done.", "我跑进了酒吧。外面在下雨。🙃 Done.");
    expect(result.counts.unchanged).toBeGreaterThanOrEqual(1);
    expect(result.counts.changed + result.counts.added + result.counts.removed).toBeGreaterThanOrEqual(1);
    const rejoined = result.segments.map((segment) => segment.kind === "changed" ? segment.after : segment.kind === "removed" ? "" : segment.text).join("");
    expect(rejoined).toBe("我跑进了酒吧。外面在下雨。🙃 Done.");
  });

  it("splits a very long line into bounded pieces, so one changed word costs little", () => {
    const line = Array.from({ length: 30_000 }, (_, i) => `word${i % 97}`).join(" ");
    const edited = line.replace("word50 word51", "word50 CHANGED");
    const result = changes(line, edited);
    expect(result.counts.changed).toBe(1);
    expect(result.counts.unchanged).toBeGreaterThan(200);
    for (const unit of splitSentences(line)) expect(unit.text.length).toBeLessThanOrEqual(800);
    expect(result.work).toBeLessThan(2_000_000);
  });

  it("keeps the edited text whole: unchanged, changed, added and moved pieces give it back", () => {
    const edited = CHAPTER.replace("noon", "dusk").replace("Outside, a car alarm went off.", "Outside, a car alarm went off. Nobody moved.");
    const result = changes(CHAPTER, edited);
    const byPara = new Map<number, string>();
    for (const segment of result.segments) {
      const text = segment.kind === "changed" ? segment.after : segment.kind === "removed" ? "" : segment.text;
      byPara.set(segment.para, (byPara.get(segment.para) ?? "") + text);
    }
    expect([...byPara.values()].map((text) => text.trim()).join("\n\n")).toBe(edited);
  });
});

describe("compareTexts bounds", () => {
  it("refuses more than the limit on either side", () => {
    expect(compareTexts("x".repeat(TEXT_CHANGES_MAX_CHARS + 1), "y")).toEqual({ ok: false, reason: "too_large" });
  });

  it("compares two wholly different long texts coarsely, within the work budget, and still lists every sentence", () => {
    const one = Array.from({ length: 6_000 }, (_, i) => `Alpha ${i} went home.`).join(" ");
    const two = Array.from({ length: 6_000 }, (_, i) => `Beta ${i} stayed out.`).join(" ");
    const result = changes(one, two);
    expect(result.coarse).toBe(true);
    expect(result.work).toBeLessThan(60_000_000);
    expect(result.counts.changed + result.counts.removed).toBe(6_000);
    expect(result.counts.changed + result.counts.added).toBe(6_000);
  });

  it("never calls a sentence moved in a stretch it could only align roughly", () => {
    const short = ["The cat sat.", "He left.", "She smiled.", "It rained."];
    const lines = Array.from({ length: 3_000 }, (_, i) => short[i % short.length]!);
    const edited = [...lines];
    edited[200] = "The dog sat.";
    edited[2_802] = "She frowned.";
    const result = changes(lines.join(" "), edited.join(" "));
    expect(result.coarse).toBe(true);
    expect(result.counts).toMatchObject({ moved: 0, changed: 2, added: 0, removed: 0, unchanged: 2_998 });
  });

  it("refuses more sentences than it can hold in bounded memory, before aligning anything", () => {
    expect(compareTexts("A. ".repeat(TEXT_CHANGES_MAX_SENTENCES + 1), "A.")).toEqual({ ok: false, reason: "too_many_sentences" });
  });

  it("keeps a near-identical long text exact through unique anchors", () => {
    const sentences = Array.from({ length: 19_000 }, (_, i) => `Sentence number ${i} is here.`);
    const edited = [...sentences];
    edited[10_000] = "Sentence number 10000 is not here.";
    const result = changes(sentences.join(" "), edited.join(" "));
    expect(result.coarse).toBe(false);
    expect(result.counts).toMatchObject({ changed: 1, unchanged: 18_999 });
    expect(result.work).toBeLessThan(500_000);
  });

  it("gives up word detail, never the change, when one sentence pair is too long to align", () => {
    const parts = wordParts("a ".repeat(400), "b ".repeat(400));
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.filter((part) => part.op === "add").map((part) => part.text).join("").replace(/\s/g, "")).toBe("b".repeat(400));
  });
});

describe("formatTextChanges", () => {
  it("starts with the counts as JSON and marks words the wdiff way", () => {
    const text = formatTextChanges(changes(CHAPTER, CHAPTER.replace("noon", "dusk").replace("drank it slowly.", "drank it slowly. Later.")));
    const [head, ...lines] = text.split("\n");
    expect(JSON.parse(head!)).toEqual({ changed: 1, added: 1, removed: 0, moved: 0, unchanged: 6 });
    expect(lines[0]).toBe("1. changed, paragraph 1: Mara walked into the bar at [-noon-]{+dusk+}.");
  });

  it("says so when nothing changed", () => {
    expect(formatTextChanges(changes("Same.", "Same."))).toBe(`${JSON.stringify({ changed: 0, added: 0, removed: 0, moved: 0, unchanged: 1 })}\nNo changes: the two texts say the same thing, sentence for sentence.`);
  });

  it("pages a long list and tells the caller where to start next", () => {
    const before = Array.from({ length: 40 }, (_, i) => `Line ${i} stays as written here.`).join("\n\n");
    const after = Array.from({ length: 40 }, (_, i) => `Line ${i} stays as rewritten here.`).join("\n\n");
    const result = changes(before, after);
    const first = formatTextChanges(result, { limit: 25 }).split("\n");
    expect(first).toHaveLength(27);
    expect(first.at(-1)).toBe("15 more not listed here; the counts above are complete. Call again with start: 26 for the rest.");
    const second = formatTextChanges(result, { start: 26, limit: 25 }).split("\n");
    expect(second[1]!.startsWith("26. changed, paragraph 26:")).toBe(true);
    expect(second).toHaveLength(16);
  });
});
