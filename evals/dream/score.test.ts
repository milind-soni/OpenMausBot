import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dreamPrompt } from "../../server/memory-dream.ts";
import { dreamConversationsOf, notebookOf, scoreDream, summarize, type DreamCase } from "./score.ts";

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as DreamCase[];
const byId = (id: string) => cases.find((item) => item.id === id)!;
const answer = (body: object) => "```json\n" + JSON.stringify({ learned: [], outdated: [], ideas: [], ...body }) + "\n```";

describe("dream scoring", () => {
  it("passes a pattern cited by two chats with the person's own words", () => {
    const score = scoreDream(byId("short-replies-across-chats"), answer({
      learned: [{ text: "The person wants replies short, under 100 words", from: [1, 2], evidence: ["It's way too long", "keep it under 100 words please"], confidence: 0.9 }],
    }));
    expect(score).toMatchObject({ json: true, found: 1, expected: 1, dropped: 0, violations: [], unexpected: [], pass: true });
  });

  it("drops a quote taken from inside a question, though the person asked for exactly that", () => {
    const score = scoreDream(byId("short-replies-across-chats"), answer({
      learned: [{ text: "The person wants replies short", from: [1, 2], evidence: ["make this email shorter", "keep it under 100 words please"], confidence: 0.9 }],
    }));
    expect(score).toMatchObject({ dropped: 1, pass: false });
  });

  it("drops an entry whose quote the person never said, the way runDream does", () => {
    const score = scoreDream(byId("short-replies-across-chats"), answer({
      learned: [{ text: "The person wants short replies", from: [1, 2], evidence: ["I always want short replies", "keep it under 100 words please"], confidence: 0.9 }],
    }));
    expect(score).toMatchObject({ learned: [], dropped: 1, found: 0, pass: false });
  });

  it("drops a number the quotes do not hold", () => {
    const score = scoreDream(byId("short-replies-across-chats"), answer({
      learned: [{ text: "The person wants replies under 50 words", from: [1, 2], evidence: ["It's way too long", "keep it under 100 words please"], confidence: 0.9 }],
    }));
    expect(score).toMatchObject({ dropped: 1, pass: false });
  });

  it("fails a case when a saved line says what it must never say", () => {
    const score = scoreDream(byId("a-task-is-not-a-fact"), answer({
      learned: [{ text: "The person is vegan", from: [1, 2], evidence: ["vegan bakery opening in March", "vegan bakery's Instagram bio"], confidence: 0.8 }],
    }));
    expect(score.violations).toEqual(["The person is vegan"]);
    expect(score.pass).toBe(false);
  });

  it("passes an empty answer when nothing shows across chats", () => {
    expect(scoreDream(byId("one-chat-is-not-a-pattern"), answer({}))).toMatchObject({ json: true, learned: [], pass: true });
  });

  it("counts an answer that is not JSON as a failure, even where nothing was expected", () => {
    expect(scoreDream(byId("one-chat-is-not-a-pattern"), "Nothing stood out across these chats.")).toMatchObject({ json: false, pass: false });
  });

  it("finds an outdated note on the line it names", () => {
    const testCase = byId("outdated-note-after-a-move");
    const right = scoreDream(testCase, answer({ outdated: [{ line: 0, now: "The person lives in Bangalore", from: [1], evidence: ["I moved to Bangalore last month"] }] }));
    expect(right).toMatchObject({ found: 1, pass: true });
    expect(scoreDream(testCase, answer({})).pass).toBe(false);
  });

  it("drops what the person asked to forget, as whole words, the way runDream does", () => {
    const testCase = byId("outdated-note-after-a-move");
    const moved = answer({ outdated: [{ line: 0, now: "The person lives in Bangalore", from: [1], evidence: ["I moved to Bangalore last month"] }] });
    expect(scoreDream({ ...testCase, forgotten: ["bangalore"] }, moved)).toMatchObject({ outdated: [], dropped: 1, pass: false });
    expect(scoreDream({ ...testCase, forgotten: ["galore"] }, moved)).toMatchObject({ dropped: 0, pass: true });
  });

  it("adds up a run", () => {
    const pass = scoreDream(byId("one-chat-is-not-a-pattern"), answer({}));
    const fail = scoreDream(byId("one-chat-is-not-a-pattern"), "no");
    expect(summarize([{ score: pass, costUsd: 0.01, ms: 900 }, { score: fail, costUsd: 0.02, ms: 1100 }]))
      .toMatchObject({ cases: 2, passed: 1, invalidJson: 1, costUsd: 0.03, ms: 2000 });
  });
});

describe("dream cases", () => {
  it("each case is well formed and builds the real dream prompt", () => {
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    for (const item of cases) {
      expect(item.why.length, item.id).toBeGreaterThan(0);
      expect(item.conversations.length, item.id).toBeGreaterThanOrEqual(2);
      for (const conversation of item.conversations) expect(conversation.lines.some((line) => line.by === "person"), item.id).toBe(true);
      const notebook = notebookOf(item);
      for (const outdated of item.expect.outdated) expect(outdated.line, item.id).toBeLessThan(notebook.length);
      const prompt = dreamPrompt({ botName: "Scout", today: item.today, conversations: dreamConversationsOf(item), notebook });
      expect(prompt, item.id).toContain(`Conversation ${item.conversations.length}`);
    }
  });
});
